import fs from "node:fs";
import path from "node:path";
import { branchExists } from "../branches.js";
import { readJson, writeJson } from "../fsx.js";
import { cleanBranch, type MaestroCopy } from "../orchestrator.js";
import { isPathInside } from "../places.js";
import { isSafeId } from "../slug.js";
import type { Workspace } from "../types.js";
import { removeWorkspaceRecord } from "../workspaces.js";
import { applyToWorkspace, copyBranch, copyPatch, createCopy, expectedCopyPath, folderInCopy, ownedCopyPath, removeCopy, repoRoot, type ApplyResult, type CopyOwner } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import type { Deleted } from "./types.js";
import type { WorkspaceDesk } from "./workspaces.js";

/** How long a CLI ended for Apply or Discard has to finish writing its run. */
const END_MS = 5000;
/** Names tried for a copy: the branch's own, then -2 up to this. */
const MAX_NAMES = 50;

export type CopyOutcome = "applied" | "discarded" | null;

/**
 * Maestro's copies. A start step in a git workspace works in a copy of its own made the way a
 * task's is (src/core/worktrees.ts: the same folder, branch and safety checks), opened as a
 * workspace in Code. The copy then waits for the person, like a task's: its diff, Apply into the
 * workspace it came from, or Discard. Nothing is applied or deleted without one of those clicks,
 * and Discard can be undone for a while. The list is its own file, so starting a new conversation
 * never loses a copy that is still waiting.
 */
export class MaestroCopies {
  private copies: MaestroCopy[];
  /** Apply, Discard and making a copy, one at a time, so two clicks can't apply one copy twice. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly core: ServiceCore,
    private readonly workspaces: WorkspaceDesk,
    /** What became of a copy (null: its Discard was undone), for the step that made it. */
    private readonly settled: (copy: MaestroCopy, outcome: CopyOutcome) => void,
  ) {
    this.copies = this.load();
  }

  private get file(): string {
    return path.join(this.core.options.dataRoot, "orchestrator", "copies.json");
  }

  private load(): MaestroCopy[] {
    const saved = readJson<{ copies?: unknown } | null>(this.file, null);
    return Array.isArray(saved?.copies) ? saved.copies.flatMap((item) => readCopy(item) ?? []) : [];
  }

  private save(): void {
    writeJson(this.file, { copies: this.copies });
    this.core.emit("orchestrator");
  }

  list(): MaestroCopy[] {
    return this.copies.map((copy) => ({ ...copy }));
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The copy is checked by name against VibeForge's own worktrees folder before git touches it. */
  private owner(id: string): CopyOwner {
    return { dataRoot: this.core.options.dataRoot, taskId: id };
  }

  private find(id: string): MaestroCopy {
    const copy = this.copies.find((item) => item.id === id);
    if (!copy) throw new Error("That copy is gone.");
    return copy;
  }

  /**
   * A copy for a start step: a new `vibeforge/<name>` branch from the commit the workspace is on,
   * named for the branch the plan asked for, and its own workspace (not the one Code shows).
   */
  make(input: { turnId: string; stepId: string; engineId: string; prompt: string; branch: string; workspace: Workspace }): Promise<MaestroCopy & { openedWorkspaceId: string }> {
    return this.serial(async () => {
      const name = cleanBranch(input.branch) || "maestro";
      const id = await this.freeId(input.workspace.path, name);
      const made = await createCopy(input.workspace.path, path.join(this.core.options.dataRoot, "worktrees", id), copyBranch(id));
      const copy: MaestroCopy = {
        id,
        turnId: input.turnId,
        stepId: input.stepId,
        engineId: input.engineId,
        prompt: input.prompt,
        name,
        workspaceId: input.workspace.id,
        openedWorkspaceId: null,
        at: this.core.now().toISOString(),
        ...made,
      };
      // Kept before anything else can fail, so a copy that never got its workspace can still be discarded.
      this.copies.push(copy);
      this.save();
      const openedWorkspaceId = this.workspaces.addQuietly(folderInCopy(made, input.workspace.path), `${input.workspace.name} · ${name}`);
      copy.openedWorkspaceId = openedWorkspaceId;
      this.save();
      return { ...copy, openedWorkspaceId };
    });
  }

  /**
   * A name nothing has yet, for the copy's folder and branch: the branch's own, else with -2, -3…
   * A `vibeforge/` branch already there is never reused: making the copy would reset it.
   */
  private async freeId(folder: string, name: string): Promise<string> {
    const base = name.replace(/\//g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 60) || "maestro";
    for (let n = 1; n <= MAX_NAMES; n += 1) {
      const id = n === 1 ? base : `${base}-${n}`;
      const target = isSafeId(id) ? expectedCopyPath(this.core.options.dataRoot, id) : null;
      if (!target || fs.existsSync(target) || this.copies.some((item) => item.id === id) || this.core.store.getTask(id)) continue;
      if (await branchExists(folder, copyBranch(id))) continue;
      return id;
    }
    throw new Error(`Every copy name from ${base} to ${base}-${MAX_NAMES} is taken.`);
  }

  /** Everything the copy changed since it was made, as Apply would bring it in. */
  diff(id: string): Promise<string> {
    const copy = this.find(id);
    return copyPatch(copy, this.owner(copy.id));
  }

  /**
   * Bring the copy's changes into the workspace it came from as uncommitted edits. Its CLI ends
   * first, as its folder is about to go. A clean apply (or nothing to apply) removes the copy, its
   * branch and its workspace; with conflicts the copy stays until they're sorted out.
   */
  apply(id: string): Promise<ApplyResult> {
    return this.serial(async () => {
      const copy = this.find(id);
      if (!this.core.workspaceById(copy.workspaceId)) throw new Error("That workspace is gone.");
      if (!ownedCopyPath(this.owner(copy.id), copy.path)?.real) throw new Error("This copy is not in VibeForge's worktrees folder, so it was left alone.");
      if (!(await this.trusted(copy))) throw new Error("This copy names another repository, so it was left alone.");
      await this.endIn(copy);
      const result = await applyToWorkspace(copy, await copyPatch(copy, this.owner(copy.id)));
      if (result.conflicts.length) return result;
      await removeCopy(copy, this.owner(copy.id));
      this.forget(copy);
      if (copy.openedWorkspaceId && this.core.workspaceById(copy.openedWorkspaceId)) await this.workspaces.removeWorkspace(copy.openedWorkspaceId);
      this.settled(copy, "applied");
      return result;
    });
  }

  /**
   * Throw the copy away, changes and all, with its workspace. Its CLI ends first. Undo brings the
   * folder and the workspace back; the branch goes once the chance to undo has passed. A folder
   * that isn't VibeForge's own copy is only forgotten, never deleted.
   */
  discard(id: string): Promise<Deleted> {
    return this.serial(async () => {
      const copy = this.find(id);
      await this.endIn(copy);
      const owned = ownedCopyPath(this.owner(copy.id), copy.path);
      const trusted = owned ? await this.trusted(copy) : false;
      const bin = this.core.trash.stash(owned?.real ? [owned.real] : []);
      const workspaces = this.core.store.readWorkspaces();
      const index = workspaces.workspaces.findIndex((item) => item.id === copy.openedWorkspaceId);
      const workspace = index >= 0 ? workspaces.workspaces[index] : null;
      const layout = workspace ? this.core.store.readLayout(workspace.id) : null;
      if (workspace) {
        this.core.store.writeWorkspaces(removeWorkspaceRecord(workspaces, workspace.id));
        this.core.store.writeLayout(workspace.id, null);
        this.core.emit("workspaces");
      }
      this.forget(copy);
      this.settled(copy, "discarded");
      const deleted = this.core.keepForUndo(
        bin,
        () => {
          if (workspace) this.restoreWorkspace(workspace, index, layout);
          this.copies.push(copy);
          this.save();
          this.settled(copy, null);
        },
        // Returned, so a quit inside the Undo window waits for the branch to go too.
        owned ? () => removeCopy(copy, this.owner(copy.id), trusted).catch(() => undefined) : undefined,
      );
      return owned ? deleted : { ...deleted, copyLeft: true };
    });
  }

  private restoreWorkspace(workspace: Workspace, index: number, layout: ReturnType<ServiceCore["store"]["readLayout"]>): void {
    const now = this.core.store.readWorkspaces();
    if (now.workspaces.some((item) => item.id === workspace.id || path.resolve(item.path) === path.resolve(workspace.path))) return;
    const list = now.workspaces.slice();
    list.splice(Math.min(index, list.length), 0, workspace);
    this.core.store.writeWorkspaces({ ...now, workspaces: list });
    if (layout) this.core.store.writeLayout(workspace.id, layout);
    this.core.emit("workspaces");
  }

  private forget(copy: MaestroCopy): void {
    this.copies = this.copies.filter((item) => item.id !== copy.id);
    this.save();
  }

  /**
   * The copy's repository is the one its workspace is in. The list is a plain file anyone can
   * edit, so the repository it names is checked before git applies or deletes there.
   */
  private async trusted(copy: MaestroCopy): Promise<boolean> {
    const workspace = this.core.workspaceById(copy.workspaceId);
    const repo = workspace ? await repoRoot(workspace.path).catch(() => null) : null;
    return repo !== null && repo === path.resolve(copy.repo);
  }

  /** End every terminal working in the copy (its CLI, a shell opened there), and let each finish its run. */
  private async endIn(copy: MaestroCopy): Promise<void> {
    const inside = [...this.core.live.values()].filter(
      (session) => (copy.openedWorkspaceId !== null && session.workspaceId === copy.openedWorkspaceId) || isPathInside(copy.path, session.programCwd || session.cwd),
    );
    for (const session of inside) await this.core.killPty(session.ptyId);
    await Promise.all(inside.map((session) => this.core.waitForExit(session.ptyId, END_MS)));
  }
}

/** A saved copy, or null for an entry that isn't one. */
function readCopy(value: unknown): MaestroCopy | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const text = (key: string) => (typeof item[key] === "string" ? (item[key] as string) : "");
  const copy: MaestroCopy = {
    id: text("id"),
    turnId: text("turnId"),
    stepId: text("stepId"),
    engineId: text("engineId"),
    prompt: text("prompt"),
    name: text("name") || text("id"),
    workspaceId: text("workspaceId"),
    openedWorkspaceId: text("openedWorkspaceId") || null,
    at: text("at"),
    path: text("path"),
    branch: text("branch"),
    base: text("base"),
    repo: text("repo"),
  };
  return copy.id && copy.workspaceId && copy.path && copy.branch && copy.base && copy.repo ? copy : null;
}
