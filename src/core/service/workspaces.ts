import path from "node:path";
import { openBranchCheckout, readBranches, type BranchList } from "../branches.js";
import { isDirectory } from "../fsx.js";
import { LOCAL_ENGINE_ID } from "../local.js";
import { cwdAllowed } from "../places.js";
import { codePaneNote, leadNote } from "../preamble.js";
import type { LayoutNode, Workspace, WorkspaceCategory } from "../types.js";
import { summarizeFolderGit } from "../vcs.js";
import {
  addCategoryRecord,
  addWorkspaceRecord,
  moveCategoryRecord,
  moveWorkspaceRecord,
  removeCategoryRecord,
  removeWorkspaceRecord,
  renameCategoryRecord,
  selectWorkspaceRecord,
  setWorkspaceCategoryRecord,
  updateWorkspaceRecord,
  type WorkspaceFile,
} from "../workspaces.js";
import type { Deleted, Launched, TermSize, WorkspaceSummary } from "./types.js";
import type { ServiceCore } from "./core.js";

const GIT_STATUS_CONCURRENCY = 6;

/** Workspaces, their layouts, and the terminals Code mode opens in them. */
export class WorkspaceDesk {
  constructor(private readonly core: ServiceCore) {}

  listWorkspaces(): WorkspaceFile {
    return this.core.store.readWorkspaces();
  }

  /** Read-only git state and latest run timestamp for every workspace, bounded in concurrency. */
  async summarizeWorkspaces(): Promise<Record<string, WorkspaceSummary>> {
    const { workspaces } = this.core.store.readWorkspaces();
    const lastRuns = this.core.store.latestWorkspaceRuns();
    const out: Record<string, WorkspaceSummary> = {};
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < workspaces.length) {
        const workspace = workspaces[nextIndex];
        nextIndex += 1;
        const lastRunAt = lastRuns[workspace.id] ?? null;
        if (!isDirectory(workspace.path)) {
          out[workspace.id] = { exists: false, git: false, branch: null, dirty: 0, ahead: 0, behind: 0, lastRunAt, lastCommitAt: null };
          continue;
        }
        const git = await summarizeFolderGit(workspace.path).catch(() => ({ git: false, branch: null, dirty: 0, ahead: 0, behind: 0, lastCommitAt: null }));
        out[workspace.id] = { exists: true, ...git, lastRunAt };
      }
    };
    await Promise.all(Array.from({ length: Math.min(GIT_STATUS_CONCURRENCY, workspaces.length) }, () => worker()));
    return out;
  }

  addWorkspace(folder: string, categoryId?: string | null): WorkspaceFile {
    if (!isDirectory(folder)) throw new Error("Choose a folder that exists.");
    const next = addWorkspaceRecord(this.core.store.readWorkspaces(), folder, categoryId);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  /**
   * Takes a workspace out of VibeForge, Undo-able. Its folder stays on disk. Its terminals in Code
   * stop (that part can't be undone); runs of agents, tasks and routines there go on. Undo puts it
   * back as it was: the same place in the list, name, browser address and pane layout. A Sync
   * share follows the folder, not the workspace, so it is untouched either way.
   */
  async removeWorkspace(id: string): Promise<Deleted> {
    const before = this.core.store.readWorkspaces();
    const index = before.workspaces.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("That workspace is gone.");
    const workspace = before.workspaces[index];
    const layout = this.core.store.readLayout(id);
    const wasCurrent = before.lastWorkspaceId === id;
    await this.forgetWorkspace(id);
    // Nothing moves to the trash: the folder stays, and the record and layout come back from here.
    return this.core.keepForUndo(this.core.trash.stash([]), () => this.putBack(workspace, index, layout, wasCurrent));
  }

  /** Takes a workspace out for good, with no Undo: a copy's workspace once the copy is applied. */
  async forgetWorkspace(id: string): Promise<WorkspaceFile> {
    for (const session of this.codeTerminals(id)) await this.core.killPty(session.ptyId);
    const next = removeWorkspaceRecord(this.core.store.readWorkspaces(), id);
    this.core.store.writeWorkspaces(next);
    this.core.store.writeLayout(id, null);
    this.core.emit("workspaces", "tasks");
    return next;
  }

  /** What removing the workspace stops: Code's terminals and shells there. */
  private codeTerminals(id: string) {
    return [...this.core.live.values()].filter((session) => session.workspaceId === id && (session.origin === "code" || session.kind === "shell"));
  }

  /** A removed workspace back where it was, unless its folder or its id is a workspace again meanwhile. */
  private putBack(workspace: Workspace, index: number, layout: LayoutNode | null, wasCurrent: boolean): void {
    const now = this.core.store.readWorkspaces();
    // Added again by hand meanwhile: it is back already.
    if (now.workspaces.some((item) => path.resolve(item.path) === path.resolve(workspace.path))) return;
    if (now.workspaces.some((item) => item.id === workspace.id)) throw new Error("Another workspace took this one's place meanwhile, so it can't come back.");
    const valid = new Set((now.categories ?? []).map((cat) => cat.id));
    const keptCats = (workspace.categories ?? []).filter((catId) => valid.has(catId));
    const { categories: _dropped, ...base } = workspace;
    const restored: Workspace = keptCats.length ? { ...base, categories: keptCats } : base;
    const workspaces = [...now.workspaces];
    workspaces.splice(Math.min(index, workspaces.length), 0, restored);
    this.core.store.writeWorkspaces({
      workspaces,
      lastWorkspaceId: wasCurrent || !now.lastWorkspaceId ? restored.id : now.lastWorkspaceId,
      ...(now.categories?.length ? { categories: now.categories } : {}),
    });
    if (layout && !this.core.store.readLayout(restored.id)) this.core.store.writeLayout(restored.id, layout);
    this.core.emit("workspaces", "tasks");
  }

  selectWorkspace(id: string): void {
    this.core.store.writeWorkspaces(selectWorkspaceRecord(this.core.store.readWorkspaces(), id));
  }

  moveWorkspace(id: string, toIndex: number): WorkspaceFile {
    const next = moveWorkspaceRecord(this.core.store.readWorkspaces(), id, Number(toIndex) || 0);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  /** Local branches of this workspace's repository. The folder's own branch is marked current. */
  listBranches(id: string): Promise<BranchList> {
    const workspace = this.workspace(id);
    return readBranches(workspace.path);
  }

  /**
   * Open `branch` as its own workspace folder. This workspace's checkout is not moved. A folder
   * that already has the branch is added, or selected when it is already a workspace.
   */
  async openBranch(id: string, branch: string): Promise<WorkspaceFile> {
    const workspace = this.workspace(id);
    const opened = await openBranchCheckout(workspace.path, branch);
    const known = this.core.store.readWorkspaces().workspaces.some((item) => path.resolve(item.path) === path.resolve(opened.path));
    let next = this.addWorkspace(opened.path);
    if (!known && next.lastWorkspaceId) next = this.updateWorkspace(next.lastWorkspaceId, { name: `${opened.repoName} · ${opened.branch}` });
    return next;
  }

  /**
   * A folder as a workspace of its own, named `name`, without making it the one Code shows: the
   * person stays where they are (a Maestro step's copy). A folder that is a workspace already
   * keeps its record. Returns its id.
   */
  addQuietly(folder: string, name: string): string {
    const before = this.core.store.readWorkspaces();
    const known = before.workspaces.find((item) => path.resolve(item.path) === path.resolve(folder));
    if (known) return known.id;
    const next = addWorkspaceRecord(before, folder);
    const added = next.workspaces.find((item) => path.resolve(item.path) === path.resolve(folder));
    if (!added) throw new Error("Choose a folder that exists.");
    this.core.store.writeWorkspaces(updateWorkspaceRecord({ ...next, lastWorkspaceId: before.lastWorkspaceId }, added.id, { name }));
    this.core.emit("workspaces");
    return added.id;
  }

  private workspace(id: string) {
    const workspace = this.core.workspaceById(id);
    if (!workspace) throw new Error("That workspace is gone.");
    if (!isDirectory(workspace.path)) throw new Error("That folder does not exist any more.");
    return workspace;
  }

  updateWorkspace(id: string, patch: { name?: string; dockUrl?: string; categories?: string[] }): WorkspaceFile {
    const clean: { name?: string; dockUrl?: string; categories?: string[] } = {};
    if (typeof patch.name === "string" && patch.name.trim()) clean.name = patch.name.trim();
    if (typeof patch.dockUrl === "string") {
      const url = patch.dockUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error("Enter a full URL, starting with http:// or https://");
      clean.dockUrl = url;
    }
    if (Array.isArray(patch.categories)) {
      clean.categories = patch.categories.filter((item): item is string => typeof item === "string");
    }
    const next = updateWorkspaceRecord(this.core.store.readWorkspaces(), id, clean);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  addCategory(name: string): { file: WorkspaceFile; category: WorkspaceCategory } {
    const res = addCategoryRecord(this.core.store.readWorkspaces(), String(name ?? ""));
    this.core.store.writeWorkspaces(res.file);
    this.core.emit("workspaces");
    return res;
  }

  renameCategory(id: string, name: string): WorkspaceFile {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new Error("Enter a category name.");
    const next = renameCategoryRecord(this.core.store.readWorkspaces(), id, trimmed);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  moveCategory(id: string, toIndex: number): WorkspaceFile {
    const next = moveCategoryRecord(this.core.store.readWorkspaces(), id, Number(toIndex) || 0);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  deleteCategory(id: string): Deleted {
    const before = this.core.store.readWorkspaces();
    const index = (before.categories ?? []).findIndex((cat) => cat.id === id);
    if (index < 0) throw new Error("That category is gone.");
    const category = before.categories![index];
    const memberIds = before.workspaces.filter((ws) => ws.categories?.includes(id)).map((ws) => ws.id);
    this.core.store.writeWorkspaces(removeCategoryRecord(before, id));
    this.core.emit("workspaces");
    return this.core.keepForUndo(this.core.trash.stash([]), () => this.putBackCategory(category, index, memberIds));
  }

  private putBackCategory(category: WorkspaceCategory, index: number, memberIds: readonly string[]): void {
    const now = this.core.store.readWorkspaces();
    if (now.categories?.some((cat) => cat.id === category.id)) return;
    const categories = [...(now.categories ?? [])];
    categories.splice(Math.min(index, categories.length), 0, category);
    const restored = setWorkspaceCategoryRecord({ ...now, categories }, memberIds, category.id, true);
    this.core.store.writeWorkspaces(restored);
    this.core.emit("workspaces");
  }

  setWorkspaceCategory(workspaceIds: string[], categoryId: string, on: boolean): WorkspaceFile {
    const next = setWorkspaceCategoryRecord(this.core.store.readWorkspaces(), workspaceIds, categoryId, Boolean(on));
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  getLayout(workspaceId: string): LayoutNode | null {
    return this.core.store.readLayout(workspaceId);
  }

  saveLayout(workspaceId: string, layout: LayoutNode | null): void {
    this.core.store.writeLayout(workspaceId, layout);
  }


  // ---------------------------------------------------------------- code mode

  async startShell(opts: { workspaceId?: string; cwd?: string; orchestrated?: boolean; command?: string } & TermSize): Promise<{ ptyId: string }> {
    const workspace = this.core.workspaceById(opts.workspaceId);
    const cwd = workspace?.path ?? opts.cwd ?? "";
    if (!isDirectory(cwd)) throw new Error("That folder does not exist any more.");
    const shell = this.core.store.readSettings().defaultShell || process.env.SHELL || "/bin/bash";
    const command = opts.command?.trim() ?? "";
    const spawned = await this.core.options.host.spawn({ cwd, argv: [shell], runDir: null, pasteInput: command || null, cols: opts.cols, rows: opts.rows });
    if (spawned.ptyToken) this.core.ptyTokens.set(spawned.ptyId, spawned.ptyToken);
    this.core.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: null,
      kind: "shell",
      // Named for where it runs; what it is running shows up as `program`.
      title: workspace?.name ?? (path.basename(cwd) || cwd),
      cwd,
      pid: spawned.pid,
      startedAt: this.core.now().toISOString(),
      origin: null,
      agentId: null,
      chatId: null,
      taskId: null,
      workspaceId: workspace?.id ?? null,
      ...(opts.orchestrated ? { orchestrated: true } : {}),
    });
    this.core.emit("live");
    return { ptyId: spawned.ptyId };
  }

  /** A one-off command in a terminal (the self-update), listed with the live sessions. */
  async startCommand(opts: { command: string; title: string; cwd: string } & TermSize): Promise<{ ptyId: string }> {
    if (!isDirectory(opts.cwd)) throw new Error("That folder does not exist any more.");
    const spawned = await this.core.options.host.spawn({ cwd: opts.cwd, argv: ["/bin/bash", "-c", opts.command], runDir: null, pasteInput: null, cols: opts.cols, rows: opts.rows });
    if (spawned.ptyToken) this.core.ptyTokens.set(spawned.ptyId, spawned.ptyToken);
    this.core.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: null,
      kind: "shell",
      title: opts.title,
      cwd: opts.cwd,
      pid: spawned.pid,
      startedAt: this.core.now().toISOString(),
      origin: null,
      agentId: null,
      chatId: null,
      taskId: null,
      workspaceId: null,
    });
    this.core.emit("live");
    return { ptyId: spawned.ptyId };
  }

  /**
   * What a CLI started here is told: the lead (Settings → Agents together) gets its team in this
   * workspace and the rules; any other CLI, that the others exist. Agent runs learn it from their preamble.
   */
  private paneInstructions(engineId: string, folder: string): { instructions: string | null; allowVibeforge: boolean } {
    const talk = this.core.store.readSettings().agentTalk;
    if (!talk.on) return { instructions: null, allowVibeforge: false };
    if (!talk.lead || talk.lead !== engineId) return { instructions: codePaneNote(), allowVibeforge: false };
    const rows = this.core.store.readEngineRows();
    const team = this.core.store
      .listAgents()
      .filter((agent) => cwdAllowed(folder, agent.places))
      .map((agent) => ({ id: agent.id, name: agent.name, engine: rows.find((row) => row.id === agent.engine)?.label ?? agent.engine, goodAt: agent.goodAt, tier: agent.tier }));
    return { instructions: leadNote({ team, ...talk }), allowVibeforge: true };
  }

  /** `model` and `effort` start the CLI with them where it takes them (launchOptionArgs); empty keeps its own. */
  async startEngine(
    opts: {
      workspaceId: string;
      engineId: string;
      agentId?: string;
      /** An agent started in a copy: the copy's folder, and the workspace it is a copy of, for its brief. */
      copyOf?: { path: string; of: string } | null;
      prompt?: string;
      continueSession?: boolean;
      orchestrated?: boolean;
      model?: string;
      effort?: string;
    } & TermSize,
  ): Promise<Launched> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const workspace = this.core.workspaceById(opts.workspaceId);
    if (!workspace) throw new Error("Open a workspace first.");
    if (!isDirectory(workspace.path)) throw new Error(`The workspace folder is gone: ${workspace.path}`);
    const agent = opts.agentId ? this.core.store.getAgent(opts.agentId) : null;
    const target = this.core.resolveLaunchTarget({
      engineId: agent ? agent.engine : opts.engineId,
      fromAgent: Boolean(agent),
      model: opts.model,
    });
    const engine = this.core.requireEngine(target.engineId, { model: target.model });
    const prompt = opts.prompt?.trim() ?? "";
    const previous = opts.continueSession
      ? (this.core.store.queryRuns({ origin: "code", workspaceId: workspace.id, limit: 50 }).find((run) => run.engine === engine.row.id && run.status !== "running") ?? null)
      : null;
    const resume = opts.continueSession
      ? this.core.resumePlan(engine, previous, workspace.path, { allowBareWithoutPrevious: true })
      : { native: false, resumeArgs: null };
    return this.core.launch({
      origin: "code",
      title: `${agent ? (target.engineId === LOCAL_ENGINE_ID ? `${agent.name} · Local` : agent.name) : engine.row.label} · ${workspace.name}`,
      engine,
      cwd: workspace.path,
      prompt,
      promptText: agent ? this.core.preambleFor(agent, prompt, null, opts.copyOf ?? null) : prompt || null,
      continueSession: Boolean(opts.continueSession && resume.native),
      resumeArgs: resume.resumeArgs,
      workspaceId: workspace.id,
      agentId: agent?.id ?? null,
      continuedFrom: previous?.id ?? null,
      ...(agent ? { instructions: null, allowVibeforge: Boolean(this.core.store.readSettings().agentTalk.on) } : this.paneInstructions(engine.row.id, workspace.path)),
      orchestrated: opts.orchestrated,
      model: target.model,
      effort: opts.effort,
      cols: opts.cols,
      rows: opts.rows,
    });
  }
}
