import fs from "node:fs";
import path from "node:path";
import { handoffBody, handoffTitle } from "../handoff.js";
import { readRunText } from "../run-storage.js";
import { RUN_FILES } from "../runs.js";
import { isDirectory } from "../fsx.js";
import { taskPrompt } from "../preamble.js";
import { createTask, markStopped, requestExecute } from "../tasks.js";
import type { Task, TaskStatus, Workspace } from "../types.js";
import { isSafeId } from "../slug.js";
import { applyToWorkspace, copyBranch, copyPatch, createCopy, folderInCopy, ownedCopyPath, patchFiles, removeCopy, type ApplyResult, type CopyOwner } from "../worktrees.js";
import { BLOCKER_TEXT, type Deleted, type Launched, type Queued, type TaskInput, type TaskView, type TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";
import type { FolderTurns } from "./turns.js";

/** Tasks: a title and a body an agent executes in a workspace, then waits for review. */
export class TaskDesk {
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

  private taskBlocker(task: Task): TaskView["blocker"] {
    const agent = task.agentId ? this.core.store.getAgent(task.agentId) : null;
    const workspace = this.core.workspaceById(task.workspaceId);
    const decision = requestExecute(task, {
      hasAgent: Boolean(agent),
      workspacePath: workspace?.path ?? "",
      agentPlaces: agent?.places ?? [],
    });
    if (!decision.ok) return decision.reason;
    if (agent && !this.core.resolveEngine(agent.engine)) return "engine-missing";
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
    const bin = this.core.trash.stash(owned?.real ? [file, owned.real] : [file]);
    this.core.emit("tasks");
    const deleted = this.core.keepForUndo(
      bin,
      () => this.core.emit("tasks"),
      copy && owned ? () => void removeCopy(copy, this.owner(id)).catch(() => undefined) : undefined,
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

  /** A Continue of the task's last run: a person is there, so it never waits. */
  /** Pick the task's last session back up. `followUp` is typed in once it is ready, when given. */
  async continueTask(id: string, size: TermSize = {}, followUp: string | null = null): Promise<Launched> {
    await this.core.settled;
    this.turns.cancel("task", id);
    return this.launchTask(this.ready(id), size, true, followUp);
  }

  /** The task, if it can start: it exists, isn't running, and has an agent, a workspace and an engine. */
  private ready(id: string): Task {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (task.status === "running" && this.taskLive(task)) throw new Error("This task is already running.");
    const blocker = this.taskBlocker(task);
    if (blocker) throw new Error(BLOCKER_TEXT[blocker]);
    return task;
  }

  private async launchTask(task: Task, size: TermSize, continueSession: boolean, followUp: string | null = null): Promise<Launched> {
    const id = task.id;
    const agent = this.core.store.getAgent(task.agentId!)!;
    const workspace = this.core.workspaceById(task.workspaceId)!;
    const engine = this.core.requireEngine(agent.engine);
    const prompt = taskPrompt(task.title, task.body);
    const previous = task.runIds[task.runIds.length - 1] ? this.core.store.getRun(task.runIds[task.runIds.length - 1]) : null;
    const resume = continueSession ? this.core.resumePlan(engine.row, previous) : { native: false, resumeArgs: null };
    const canContinue = resume.native;
    const prior = continueSession && previous && !canContinue ? this.core.transcriptPath(previous) : null;
    const cwd = task.isolated ? await this.copyFor(task, workspace) : workspace.path;
    const launched = await this.core.launch({
      origin: "task",
      title: task.title,
      engine,
      cwd,
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

  /** The folder an isolated task runs in: its copy of the workspace, made on first Execute. */
  private async copyFor(task: Task, workspace: Workspace): Promise<string> {
    if (task.copy && isDirectory(task.copy.path)) {
      if (!ownedCopyPath(this.owner(task.id), task.copy.path)?.real) throw new Error("This task's copy is not in VibeForge's worktrees folder, so it was left alone.");
      return folderInCopy(task.copy, workspace.path);
    }
    if (!isSafeId(task.id)) throw new Error("This task's copy is not in VibeForge's worktrees folder, so it was left alone.");
    const copy = await createCopy(workspace.path, path.join(this.core.options.dataRoot, "worktrees", task.id), copyBranch(task.id));
    const current = this.core.store.getTask(task.id) ?? task;
    this.core.store.writeTask({ ...current, copy, updatedAt: this.core.now().toISOString() });
    return folderInCopy(copy, workspace.path);
  }

  /**
   * Bring a task copy's changes into the workspace as uncommitted edits. A clean apply removes the
   * copy and marks the task done; with conflicts the copy stays until they're sorted out.
   */
  async applyCopy(id: string): Promise<ApplyResult> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (!task.copy) throw new Error("This task has no separate copy.");
    if (this.taskLive(task)) throw new Error("Stop the task before applying its changes.");
    const patch = await copyPatch(task.copy, this.owner(id));
    const result = await applyToWorkspace(task.copy, patch);
    if (result.files.length && !result.conflicts.length) {
      await removeCopy(task.copy, this.owner(id));
      const current = this.core.store.getTask(id) ?? task;
      this.core.store.writeTask({ ...current, copy: null, status: "done", updatedAt: this.core.now().toISOString() });
    }
    this.core.emit("tasks");
    return result;
  }

  /** Throw a task's copy away, changes and all. A copy that isn't the task's own is only forgotten. */
  async discardCopy(id: string): Promise<TaskView> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (this.taskLive(task)) throw new Error("Stop the task before discarding its copy.");
    if (task.copy && ownedCopyPath(this.owner(id), task.copy.path)) await removeCopy(task.copy, this.owner(id));
    const next = { ...(this.core.store.getTask(id) ?? task), copy: null, updatedAt: this.core.now().toISOString() };
    this.core.store.writeTask(next);
    this.core.emit("tasks");
    return this.taskView(next);
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
