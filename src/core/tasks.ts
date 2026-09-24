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
}

export interface ExecuteContext {
  workspacePath: string;
  agentPlaces: readonly string[];
  hasAgent: boolean;
}

export type ExecuteDecision =
  | { ok: true; task: Task }
  | { ok: false; reason: "missing-agent" | "outside-places" };

export function createTask(input: CreateTaskInput): Task {
  const title = input.title ?? "";
  const id = input.id?.trim() || `${slugify(title)}-${randomBytes(3).toString("hex")}`;
  return {
    id,
    title,
    body: input.body ?? "",
    status: "todo",
    agentId: input.agentId ?? null,
    workspaceId: input.workspaceId ?? null,
    runIds: [],
  };
}

export function assignTask(task: Task, agentId: string, workspaceId: string): Task {
  return {
    ...task,
    agentId,
    workspaceId,
    status: task.status,
    runIds: task.runIds.slice(),
  };
}

export function requestExecute(task: Task, context: ExecuteContext): ExecuteDecision {
  if (!context.hasAgent) return { ok: false, reason: "missing-agent" };
  if (!cwdAllowed(context.workspacePath, context.agentPlaces)) {
    return { ok: false, reason: "outside-places" };
  }
  return { ok: true, task: { ...task, status: "running", runIds: task.runIds.slice() } };
}

export function markExited(task: Task): Task {
  if (task.status !== "running") return task;
  return { ...task, status: "review" };
}

export function markStopped(task: Task): Task {
  if (task.status !== "running") return task;
  return { ...task, status: "review" };
}

export function syncTaskWithRun(task: Task, runStatus: RunStatus): TaskStatus {
  if (
    task.status === "running" &&
    (runStatus === "exited" || runStatus === "stopped" || runStatus === "failed")
  ) {
    return "review";
  }
  return task.status;
}
