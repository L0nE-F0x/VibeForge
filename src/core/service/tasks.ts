import fs from "node:fs";
import path from "node:path";
import { handoffBody, handoffTitle } from "../handoff.js";
import { readRunText } from "../run-storage.js";
import { RUN_FILES } from "../runs.js";
import { isDirectory } from "../fsx.js";
import { taskPrompt } from "../preamble.js";
import { createTask, markStopped, requestExecute } from "../tasks.js";
import type { Task, TaskStatus, Workspace, WorkspaceCopySetup } from "../types.js";
import { isSafeId } from "../slug.js";
import type { Bin } from "../trash.js";
import { applyToWorkspace, copyBranch, copyPatch, folderInCopy, leftInCopy, lockCopy, ownedCopyPath, patchFiles, prepareCopy, removeCopy, repoRoot, unlockCopy, type ApplyResult, type CopyOwner, type WorkingCopy } from "../worktrees.js";
import { BLOCKER_TEXT, type Deleted, type Launched, type Queued, type TaskInput, type TaskView, type TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";
import type { FolderTurns } from "./turns.js";

/** Tasks: a title and a body an agent executes in a workspace, then waits for review. */
export class TaskDesk {
  /**
   * Tasks whose CLI is being started: a copy made, a run allocated, not yet in the task's runs. A
   * second Execute or Continue then (a double click, the board and a lead's Start together) would
   * start a second CLI in the same copy.
   */
  private readonly launching = new Set<string>();

  constructor(
    private readonly core: ServiceCore,
    private readonly turns: FolderTurns,
  ) {}

  listTasks(): TaskView[] {
    return this.core.store.listTasks().map((task) => this.taskView(task));
  }

  private taskView(task: Task): TaskView {
    const lastId = task.runIds[task.runIds.length - 1];
    const last = lastId ? this.core.store.getRun(lastId) : null;
    const copyOwned = task.copy ? Boolean(ownedCopyPath(this.owner(task.id), task.copy.path)) : true;
    const workspace = task.isolated ? null : this.core.workspaceById(task.workspaceId);
    const own = new Set(this.livePty(task) ? [this.livePty(task)!] : []);
    return {
      ...task,
      lastRun: last ? this.core.view(last) : null,
      blocker: this.taskBlocker(task),
      copyOwned,
      writers: workspace ? this.turns.writersNow(workspace.path, own) : [],
      waiting: this.turns.waiting("task", task.id),
    };
  }

  private owner(taskId: string): CopyOwner {
    return { dataRoot: this.core.options.dataRoot, taskId };
  }

  /**
   * Whether the copy's `repo` is the repository of the task's workspace. The task file is plain
   * YAML anyone can edit, so the repository it names is checked before git applies or deletes there.
   */
  private async repoTrusted(task: Task, copy: WorkingCopy): Promise<boolean> {
    const workspace = this.core.workspaceById(task.workspaceId);
    const repo = workspace ? await repoRoot(workspace.path) : null;
    return repo !== null && repo === path.resolve(copy.repo);
  }

  private taskBlocker(task: Task): TaskView["blocker"] {
    const agent = task.agentId ? this.core.store.getAgent(task.agentId) : null;
    const workspace = this.core.workspaceById(task.workspaceId);
    const decision = requestExecute(task, {
      hasAgent: Boolean(agent),
      workspacePath: workspace?.path ?? "",
      agentPlaces: agent?.places ?? [],
    });
    if (!decision.ok) return decision.reason;
    if (agent && !this.core.resolveEngine(this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true }).engineId)) return "engine-missing";
    return null;
  }

  saveTask(input: TaskInput): TaskView {
    const title = input.title?.trim() ?? "";
    if (!title) throw new Error("Give the task a title.");
    const now = this.core.now();
    const existing = input.id ? this.core.store.getTask(input.id) : null;
    const task: Task = existing
      ? {
          ...existing,
          title,
          body: input.body ?? existing.body,
          agentId: input.agentId === undefined ? existing.agentId : input.agentId || null,
          workspaceId: input.workspaceId === undefined ? existing.workspaceId : input.workspaceId || null,
          isolated: typeof input.isolated === "boolean" ? input.isolated : existing.isolated,
          shareCheckout: typeof input.shareCheckout === "boolean" ? input.shareCheckout : existing.shareCheckout,
          updatedAt: now.toISOString(),
        }
      : createTask({ title, body: input.body, agentId: input.agentId || null, workspaceId: input.workspaceId || null, isolated: input.isolated === true, shareCheckout: input.shareCheckout === true, now });
    if (existing?.copy && existing.workspaceId !== task.workspaceId) throw new Error("Apply or discard the task's copy before moving it to another workspace.");
    this.core.store.writeTask(task);
    this.core.emit("tasks");
    return this.taskView(task);
  }

  async deleteTask(id: string): Promise<Deleted> {
    const task = this.core.store.getTask(id);
    const file = this.core.store.pathOf("task", id);
    if (!task || !file) throw new Error("That task no longer exists.");
    if (task.status === "running") await this.stopTask(id);
    this.turns.cancel("task", id);
    // Its copy goes with it, and comes back on Undo; the branch goes once Undo has passed. A copy
    // path that isn't this task's own worktree stays where it is: it could be someone's real work.
    const copy = task.copy;
    const owned = copy ? ownedCopyPath(this.owner(id), copy.path) : null;
    const trusted = copy && owned ? await this.repoTrusted(task, copy) : false;
    // Locked first: a `git worktree prune` while it waits (another task's Execute runs one) would forget it.
    const locked = copy && owned?.real && trusted ? await lockCopy(copy, this.owner(id)).catch(() => false) : false;
    let bin: Bin;
    try {
      bin = this.core.trash.stash(owned?.real ? [file, owned.real] : [file], copy && owned && trusted ? { kind: "copy", taskId: id, copy } : undefined);
    } catch (error) {
      if (copy && locked) await unlockCopy(copy, this.owner(id)).catch(() => undefined);
      throw error;
    }
    this.core.emit("tasks");
    const deleted = this.core.keepForUndo(
      bin,
      () => {
        if (copy && locked) void unlockCopy(copy, this.owner(id)).catch(() => undefined);
        this.core.emit("tasks");
      },
      copy && owned
        ? () =>
            // A new task given the same name since owns that folder and branch now.
            this.core.store.getTask(id) ? undefined : removeCopy(copy, this.owner(id), trusted).catch(() => undefined)
        : undefined,
    );
    return copy && !owned ? { ...deleted, copyLeft: true } : deleted;
  }

  /**
   * Execute a task. In the workspace itself it takes its turn: while another coding CLI is busy
   * there it waits, and starts on its own once that one is quiet, unless `now` or the task's
   * `shareCheckout` says to start anyway. A task in its own copy, or a Continue, starts at once.
   */
  async executeTask(id: string, size: TermSize = {}, continueSession = false, now = false): Promise<Launched | Queued> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const task = this.ready(id);
    const workspace = this.core.workspaceById(task.workspaceId)!;
    if (task.isolated || continueSession) {
      this.turns.cancel("task", id);
      return this.launchTask(task, size, continueSession);
    }
    return this.turns.withFolderLock(workspace.path, async () => {
      const current = this.ready(id);
      const busy = now || current.shareCheckout || current.isolated ? [] : await this.turns.busyIn(workspace.path);
      if (busy.length) {
        this.turns.enqueue({
          kind: "task",
          id,
          folder: workspace.path,
          start: () => this.executeTask(id, size),
          failed: (message) => this.core.options.host.notify({ title: current.title, body: message, taskId: id }),
        });
        this.core.emit("tasks");
        return { queued: true, behind: busy.map((writer) => writer.label) };
      }
      this.turns.cancel("task", id);
      return this.launchTask(current, size, false);
    });
  }

  /** Stop waiting for the workspace. */
  cancelWait(id: string): TaskView {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    this.turns.cancel("task", id);
    this.core.emit("tasks");
    return this.taskView(task);
  }

  /** Pick the task's last session back up. A person is there, so it never waits. `followUp` is typed in once it is ready. */
  async continueTask(id: string, size: TermSize = {}, followUp: string | null = null): Promise<Launched> {
    await this.core.settled;
    this.turns.cancel("task", id);
    return this.launchTask(this.ready(id), size, true, followUp);
  }

  /** The task, if it can start: it exists, isn't running, and has an agent, a workspace and an engine. */
  private ready(id: string): Task {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if ((task.status === "running" && this.taskLive(task)) || this.launching.has(id)) throw new Error("This task is already running.");
    const blocker = this.taskBlocker(task);
    if (blocker) throw new Error(BLOCKER_TEXT[blocker]);
    return task;
  }

  private async launchTask(task: Task, size: TermSize, continueSession: boolean, followUp: string | null = null): Promise<Launched> {
    // Taken in the same tick as ready()'s check, before anything here waits.
    this.launching.add(task.id);
    try {
      return await this.launchOnce(task, size, continueSession, followUp);
    } finally {
      this.launching.delete(task.id);
    }
  }

  private async launchOnce(task: Task, size: TermSize, continueSession: boolean, followUp: string | null): Promise<Launched> {
    const id = task.id;
    const agent = this.core.store.getAgent(task.agentId!)!;
    const workspace = this.core.workspaceById(task.workspaceId)!;
    const target = this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true });
    const engine = this.core.requireEngine(target.engineId, { model: target.model });
    const prompt = taskPrompt(task.title, task.body);
    const previous = task.runIds[task.runIds.length - 1] ? this.core.store.getRun(task.runIds[task.runIds.length - 1]) : null;
    const { cwd, setupCommand } = task.isolated ? await this.copyFor(task, workspace) : { cwd: workspace.path, setupCommand: null };
    const resume = continueSession ? this.core.resumePlan(engine, previous, cwd) : { native: false, resumeArgs: null };
    const canContinue = resume.native;
    const prior = continueSession && previous && !canContinue ? this.core.transcriptPath(previous) : null;
    const launched = await this.core.launch({
      origin: "task",
      title: task.title,
      engine,
      cwd,
      setupCommand,
      prompt,
      promptText: canContinue ? null : this.core.preambleFor(agent, followUp ? `${prompt}\n\n${followUp}` : prompt, prior, task.isolated ? { path: cwd, of: workspace.path } : null),
      pasteAfter: canContinue ? followUp : null,
      continueSession: canContinue,
      resumeArgs: resume.resumeArgs,
      agentId: agent.id,
      taskId: task.id,
      workspaceId: workspace.id,
      continuedFrom: continueSession && previous ? previous.id : null,
      ...size,
    });
    const current = this.core.store.getTask(id) ?? task;
    this.core.store.writeTask({
      ...current,
      status: "running",
      runIds: [...current.runIds, launched.runId],
      updatedAt: this.core.now().toISOString(),
    });
    this.core.emit("tasks");
    return launched;
  }

  async stopTask(id: string): Promise<TaskView> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    this.turns.cancel("task", id);
    const runId = task.runIds[task.runIds.length - 1];
    if (runId) await this.core.stopRun(runId);
    const next = { ...markStopped(this.core.store.getTask(id) ?? task), updatedAt: this.core.now().toISOString() };
    this.core.store.writeTask(next);
    this.core.emit("tasks");
    return this.taskView(next);
  }

  setTaskStatus(id: string, status: TaskStatus): TaskView {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (status === "running") throw new Error("Use Execute to run a task.");
    if (task.status === "running" && this.taskLive(task)) throw new Error("Stop the task before moving it.");
    const next = { ...task, status, updatedAt: this.core.now().toISOString() };
    this.core.store.writeTask(next);
    this.core.emit("tasks");
    return this.taskView(next);
  }

  /**
   * Hand a finished run to another agent: a To do task whose body says what the run did and where
   * its record is. Nothing starts until you Execute it.
   */
  handOff(runId: string, agentId: string): TaskView {
    const run = this.core.store.getRun(runId);
    if (!run) throw new Error("That run no longer exists.");
    if (!this.core.store.getAgent(agentId)) throw new Error("That agent no longer exists.");
    const from = run.agentId ? this.core.store.getAgent(run.agentId) : null;
    const workspace = this.core.workspaceById(run.workspaceId);
    const patchPath = run.dir && fs.existsSync(path.join(run.dir, RUN_FILES.patch)) ? path.join(run.dir, RUN_FILES.patch) : null;
    const patch = run.dir ? safeRead(() => readRunText(run.dir, RUN_FILES.patch)) : "";
    const body = handoffBody({
      runId: run.id,
      title: run.title,
      agentName: from?.name ?? null,
      engine: this.core.resolveEngine(run.engine)?.row.label ?? run.engine,
      workspacePath: workspace?.path ?? null,
      sourceCwd: run.cwd,
      changes: run.changes,
      files: patchFiles(patch),
      transcript: run.dir ? safeRead(() => readRunText(run.dir, RUN_FILES.transcript)) : "",
      transcriptPath: this.core.transcriptPath(run),
      patchPath: patchPath ?? (run.dir && fs.existsSync(`${path.join(run.dir, RUN_FILES.patch)}.gz`) ? `${path.join(run.dir, RUN_FILES.patch)}.gz` : null),
    });
    const task = createTask({ title: handoffTitle(run.title), body, agentId, workspaceId: workspace?.id ?? null, sourceRunId: run.id, now: this.core.now() });
    // Written as is: saving through saveTask would treat it as new input and drop `sourceRunId`.
    this.core.store.writeTask(task);
    this.core.emit("tasks");
    return this.taskView(task);
  }

  /**
   * The folder an isolated task or routine runs in: its own copy of `folder` under
   * `<dataRoot>/worktrees/<ownerId>`. Reused by both tasks and isolated routines so copy creation
   * goes through one shared path.
   */
  async ensureCopy(
    ownerId: string,
    folder: string,
    previous: WorkingCopy | null,
    untrustedError: string,
    otherRepoError: string,
    /** The workspace's "when a copy is made" setting: files brought along, folders cloned, a setup command. */
    copySetup?: WorkspaceCopySetup | null,
  ): Promise<{ copy: WorkingCopy; cwd: string; created: boolean; setupCommand: string | null }> {
    const owner = this.owner(ownerId);
    if (previous && isDirectory(previous.path)) {
      if (!ownedCopyPath(owner, previous.path)?.real) throw new Error(untrustedError);
      const repo = await repoRoot(folder);
      if (!repo || repo !== path.resolve(previous.repo)) throw new Error(otherRepoError);
      return { copy: previous, cwd: folderInCopy(previous, folder), created: false, setupCommand: null };
    }
    if (!isSafeId(ownerId)) throw new Error(untrustedError);
    // A copy whose folder went (deleted by hand, say) picks its branch's commits back up.
    const { copy, setupCommand } = await prepareCopy({
      folder,
      target: path.join(this.core.options.dataRoot, "worktrees", ownerId),
      branch: copyBranch(ownerId),
      previous,
      copySetup,
    });
    return { copy, cwd: folderInCopy(copy, folder), created: true, setupCommand };
  }

  /** The folder an isolated task runs in: its copy of the workspace, made on first Execute. */
  private async copyFor(task: Task, workspace: Workspace): Promise<{ cwd: string; setupCommand: string | null }> {
    const { copy, cwd, created, setupCommand } = await this.ensureCopy(
      task.id,
      workspace.path,
      task.copy,
      "This task's copy is not in VibeForge's worktrees folder, so it was left alone.",
      "This task's copy names another repository, so it was left alone.",
      workspace.copySetup,
    );
    if (created) {
      const current = this.core.store.getTask(task.id) ?? task;
      this.core.store.writeTask({ ...current, copy, updatedAt: this.core.now().toISOString() });
    }
    return { cwd, setupCommand };
  }

  /**
   * Bring a task copy's changes into the workspace as uncommitted edits. A clean apply removes the
   * copy and marks the task done, and so does a copy with nothing to apply; with conflicts the copy
   * stays until they're sorted out.
   */
  async applyCopy(id: string): Promise<ApplyResult> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (!task.copy) throw new Error("This task has no separate copy.");
    if (this.taskLive(task)) throw new Error("Stop the task before applying its changes.");
    if (!(await this.repoTrusted(task, task.copy))) throw new Error("This task's copy names another repository, so it was left alone.");
    const patch = await copyPatch(task.copy, this.owner(id));
    const result = await applyToWorkspace(task.copy, patch);
    // Files git ignores that only live in the copy keep it, as conflicts do, until it is discarded.
    const left = result.conflicts.length ? [] : await leftInCopy(task.copy);
    if (left.length) result.left = { folder: task.copy.path, files: left };
    if (!result.conflicts.length && !left.length) {
      await removeCopy(task.copy, this.owner(id));
      const current = this.core.store.getTask(id) ?? task;
      this.core.store.writeTask({ ...current, copy: null, status: "done", updatedAt: this.core.now().toISOString() });
    }
    this.core.emit("tasks");
    if (result.pulled) this.core.emit("workspaces");
    return result;
  }

  /**
   * Throw a task's copy away, changes and all, as deleting does: its folder waits in the trash
   * and Undo puts it back, with the task pointing at it again. The branch goes once the chance
   * to undo has passed. A copy that isn't the task's own is only forgotten, and Undo remembers it.
   */
  async discardCopy(id: string): Promise<Deleted> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (this.taskLive(task)) throw new Error("Stop the task before discarding its copy.");
    const copy = task.copy;
    const owned = copy ? ownedCopyPath(this.owner(id), copy.path) : null;
    const trusted = copy && owned ? await this.repoTrusted(task, copy) : false;
    // Locked first: a `git worktree prune` while Undo is up (another task's Execute runs one) would forget it.
    const locked = copy && owned?.real && trusted ? await lockCopy(copy, this.owner(id)).catch(() => false) : false;
    let bin: Bin;
    try {
      bin = this.core.trash.stash(owned?.real ? [owned.real] : [], copy && owned && trusted ? { kind: "copy", taskId: id, copy } : undefined);
    } catch (error) {
      if (copy && locked) await unlockCopy(copy, this.owner(id)).catch(() => undefined);
      throw error;
    }
    this.core.store.writeTask({ ...(this.core.store.getTask(id) ?? task), copy: null, updatedAt: this.core.now().toISOString() });
    this.core.emit("tasks");
    const deleted = this.core.keepForUndo(
      bin,
      (restored) => {
        if (copy && locked) void unlockCopy(copy, this.owner(id)).catch(() => undefined);
        const now = this.core.store.getTask(id);
        // Only into a task that hasn't made a new copy since, and only once its folder is back.
        const back = copy !== null && now !== null && !now.copy && (!owned?.real || restored.includes(owned.real));
        if (back) this.core.store.writeTask({ ...now, copy, updatedAt: this.core.now().toISOString() });
        // The task itself was deleted meanwhile: the folder that came back has no one to come back to.
        else if (copy && owned && !now && restored.length) void removeCopy(copy, this.owner(id), trusted).catch(() => undefined);
        this.core.emit("tasks");
      },
      copy && owned
        ? () =>
            // A copy made since (Execute again) owns that folder and branch now, and so does one
            // still waiting in the trash for its own Undo.
            this.core.store.getTask(id)?.copy || (owned.real && this.core.trash.holds(owned.real)) ? undefined : removeCopy(copy, this.owner(id), trusted).catch(() => undefined)
        : undefined,
    );
    return copy && !owned ? { ...deleted, copyLeft: true } : deleted;
  }

  private taskLive(task: Task): boolean {
    return Boolean(this.livePty(task));
  }

  private livePty(task: Task): string | null {
    const runId = task.runIds[task.runIds.length - 1];
    return (runId && this.core.ptyByRun.get(runId)) || null;
  }
}

function safeRead(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}
