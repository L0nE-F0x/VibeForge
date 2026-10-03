import path from "node:path";
import { openBranchCheckout, readBranches, type BranchList } from "../branches.js";
import { isDirectory } from "../fsx.js";
import type { LayoutNode } from "../types.js";
import { addWorkspaceRecord, moveWorkspaceRecord, removeWorkspaceRecord, selectWorkspaceRecord, updateWorkspaceRecord, type WorkspaceFile } from "../workspaces.js";
import type { Launched, TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";

/** Workspaces, their layouts, and the terminals Code mode opens in them. */
export class WorkspaceDesk {
  constructor(private readonly core: ServiceCore) {}

  listWorkspaces(): WorkspaceFile {
    return this.core.store.readWorkspaces();
  }

  addWorkspace(folder: string): WorkspaceFile {
    if (!isDirectory(folder)) throw new Error("Choose a folder that exists.");
    const next = addWorkspaceRecord(this.core.store.readWorkspaces(), folder);
    this.core.store.writeWorkspaces(next);
    this.core.emit("workspaces");
    return next;
  }

  async removeWorkspace(id: string): Promise<WorkspaceFile> {
    for (const session of [...this.core.live.values()]) {
      if (session.workspaceId === id && session.origin === "code") await this.core.killPty(session.ptyId);
      else if (session.kind === "shell" && session.workspaceId === id) await this.core.killPty(session.ptyId);
    }
    const next = removeWorkspaceRecord(this.core.store.readWorkspaces(), id);
    this.core.store.writeWorkspaces(next);
    this.core.store.writeLayout(id, null);
    this.core.emit("workspaces", "tasks");
    return next;
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

  private workspace(id: string) {
    const workspace = this.core.workspaceById(id);
    if (!workspace) throw new Error("That workspace is gone.");
    if (!isDirectory(workspace.path)) throw new Error("That folder does not exist any more.");
    return workspace;
  }

  updateWorkspace(id: string, patch: { name?: string; dockUrl?: string }): WorkspaceFile {
    const clean: { name?: string; dockUrl?: string } = {};
    if (typeof patch.name === "string" && patch.name.trim()) clean.name = patch.name.trim();
    if (typeof patch.dockUrl === "string") {
      const url = patch.dockUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error("Enter a full URL, starting with http:// or https://");
      clean.dockUrl = url;
    }
    const next = updateWorkspaceRecord(this.core.store.readWorkspaces(), id, clean);
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

  async startShell(opts: { workspaceId?: string; cwd?: string } & TermSize): Promise<{ ptyId: string }> {
    const workspace = this.core.workspaceById(opts.workspaceId);
    const cwd = workspace?.path ?? opts.cwd ?? "";
    if (!isDirectory(cwd)) throw new Error("That folder does not exist any more.");
    const shell = this.core.store.readSettings().defaultShell || process.env.SHELL || "/bin/bash";
    const spawned = await this.core.options.host.spawn({ cwd, argv: [shell], runDir: null, pasteInput: null, cols: opts.cols, rows: opts.rows });
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
    });
    this.core.emit("live");
    return { ptyId: spawned.ptyId };
  }

  /** A one-off command in a terminal (the self-update), listed with the live sessions. */
  async startCommand(opts: { command: string; title: string; cwd: string } & TermSize): Promise<{ ptyId: string }> {
    if (!isDirectory(opts.cwd)) throw new Error("That folder does not exist any more.");
    const spawned = await this.core.options.host.spawn({ cwd: opts.cwd, argv: ["/bin/bash", "-c", opts.command], runDir: null, pasteInput: null, cols: opts.cols, rows: opts.rows });
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

  async startEngine(opts: { workspaceId: string; engineId: string; prompt?: string; continueSession?: boolean } & TermSize): Promise<Launched> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const workspace = this.core.workspaceById(opts.workspaceId);
    if (!workspace) throw new Error("Open a workspace first.");
    if (!isDirectory(workspace.path)) throw new Error(`The workspace folder is gone: ${workspace.path}`);
    const engine = this.core.requireEngine(opts.engineId);
    const prompt = opts.prompt?.trim() ?? "";
    const previous = opts.continueSession
      ? (this.core.store.queryRuns({ origin: "code", workspaceId: workspace.id, limit: 50 }).find((run) => run.engine === engine.row.id && run.status !== "running") ?? null)
      : null;
    const resume = opts.continueSession ? this.core.resumePlan(engine.row, previous) : { native: false, resumeArgs: null };
    return this.core.launch({
      origin: "code",
      title: `${engine.row.label} · ${workspace.name}`,
      engine,
      cwd: workspace.path,
      prompt,
      promptText: prompt || null,
      continueSession: Boolean(opts.continueSession && (resume.resumeArgs || engine.row.continueArgs?.length)),
      resumeArgs: resume.resumeArgs,
      workspaceId: workspace.id,
      continuedFrom: previous?.id ?? null,
      cols: opts.cols,
      rows: opts.rows,
    });
  }
}
