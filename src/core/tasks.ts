import { randomBytes } from "node:crypto";
import { cwdAllowed } from "./places.js";
import { slugify } from "./slug.js";
import type { RunStatus, Task, TaskStatus } from "./types.js";

export interface CreateTaskInput {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
  now?: Date;
}

export interface ExecuteContext {
  workspacePath: string;
  agentPlaces: readonly string[];
  hasAgent: boolean;
}

export type ExecuteBlocker = "missing-agent" | "missing-workspace" | "outside-places";

export type ExecuteDecision = { ok: true; task: Task } | { ok: false; reason: ExecuteBlocker };

export const TASK_STATUSES: TaskStatus[] = ["todo", "running", "review", "done"];

export function createTask(input: CreateTaskInput): Task {
  const title = input.title.trim();
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: input.id?.trim() || `${slugify(title).slice(0, 40)}-${randomBytes(3).toString("hex")}`,
    title,
    body: input.body ?? "",
    status: "todo",
    agentId: input.agentId ?? null,
    workspaceId: input.workspaceId ?? null,
    runIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function assignTask(task: Task, agentId: string, workspaceId: string): Task {
  return { ...task, agentId, workspaceId, runIds: task.runIds.slice() };
}

export function requestExecute(task: Task, context: ExecuteContext): ExecuteDecision {
  if (!context.hasAgent) return { ok: false, reason: "missing-agent" };
  if (!context.workspacePath) return { ok: false, reason: "missing-workspace" };
  if (!cwdAllowed(context.workspacePath, context.agentPlaces)) return { ok: false, reason: "outside-places" };
  return { ok: true, task: { ...task, status: "running", runIds: task.runIds.slice() } };
}

export function markStopped(task: Task): Task {
  if (task.status !== "running") return task;
  return { ...task, status: "review" };
}

export function syncTaskWithRun(task: Task, runStatus: RunStatus): TaskStatus {
  if (task.status === "running" && runStatus !== "running") return "review";
  return task.status;
}
