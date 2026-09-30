import path from "node:path";
import { isDirectory } from "../fsx.js";
import { taskPrompt } from "../preamble.js";
import { createTask, markStopped, requestExecute } from "../tasks.js";
import type { Task, TaskStatus, Workspace } from "../types.js";
import { applyToWorkspace, copyBranch, copyPatch, createCopy, folderInCopy, removeCopy, type ApplyResult } from "../worktrees.js";
import { BLOCKER_TEXT, type Deleted, type Launched, type TaskInput, type TaskView, type TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";

/** Tasks: a title and a body an agent executes in a workspace, then waits for review. */
export class TaskDesk {
  constructor(private readonly core: ServiceCore) {}

  listTasks(): TaskView[] {
    return this.core.store.listTasks().map((task) => this.taskView(task));
  }

  private taskView(task: Task): TaskView {
    const lastId = task.runIds[task.runIds.length - 1];
    const last = lastId ? this.core.store.getRun(lastId) : null;
    return { ...task, lastRun: last ? this.core.view(last) : null, blocker: this.taskBlocker(task) };
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
          updatedAt: now.toISOString(),
        }
      : createTask({ title, body: input.body, agentId: input.agentId || null, workspaceId: input.workspaceId || null, isolated: input.isolated === true, now });
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
    // Its copy goes with it, and comes back on Undo; the branch goes once Undo has passed.
    const copy = task.copy;
    const bin = this.core.trash.stash(copy ? [file, copy.path] : [file]);
    this.core.emit("tasks");
    return this.core.keepForUndo(
      bin,
      () => this.core.emit("tasks"),
      copy ? () => void removeCopy(copy).catch(() => undefined) : undefined,
    );
  }

  async executeTask(id: string, size: TermSize = {}, continueSession = false): Promise<Launched> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (task.status === "running" && this.taskLive(task)) throw new Error("This task is already running.");
    const blocker = this.taskBlocker(task);
    if (blocker) throw new Error(BLOCKER_TEXT[blocker]);
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
      promptText: canContinue ? null : this.core.preambleFor(agent, prompt, prior, task.isolated ? { path: cwd, of: workspace.path } : null),
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

  /** The folder an isolated task runs in: its copy of the workspace, made on first Execute. */
  private async copyFor(task: Task, workspace: Workspace): Promise<string> {
    if (task.copy && isDirectory(task.copy.path)) return folderInCopy(task.copy, workspace.path);
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
    const patch = await copyPatch(task.copy);
    const result = await applyToWorkspace(task.copy, patch);
    if (result.files.length && !result.conflicts.length) {
      await removeCopy(task.copy);
      const current = this.core.store.getTask(id) ?? task;
      this.core.store.writeTask({ ...current, copy: null, status: "done", updatedAt: this.core.now().toISOString() });
    }
    this.core.emit("tasks");
    return result;
  }

  /** Throw a task's copy away, changes and all. */
  async discardCopy(id: string): Promise<TaskView> {
    const task = this.core.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (this.taskLive(task)) throw new Error("Stop the task before discarding its copy.");
    if (task.copy) await removeCopy(task.copy);
    const next = { ...(this.core.store.getTask(id) ?? task), copy: null, updatedAt: this.core.now().toISOString() };
    this.core.store.writeTask(next);
    this.core.emit("tasks");
    return this.taskView(next);
  }

  private taskLive(task: Task): boolean {
    const runId = task.runIds[task.runIds.length - 1];
    return Boolean(runId && this.core.ptyByRun.has(runId));
  }
}
