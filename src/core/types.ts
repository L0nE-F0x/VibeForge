export type Schedule =
  | { kind: "cron"; expr: string }
  | { kind: "every"; minutes: number };

export type RunOrigin = "agent-chat" | "routine" | "task" | "code" | "chat";

export type RunStatus = "running" | "exited" | "stopped" | "failed";

export type TaskStatus = "todo" | "running" | "review" | "done";

export interface Agent {
  id: string;
  name: string;
  engine: string;
  brief: string;
  memoryFile: string;
  places: string[];
  skills: string[];
  allowRoutines: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

export interface Routine {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  notify: boolean;
  lastFiredAt: string | null;
  lastMissedAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  agentId: string | null;
  workspaceId: string | null;
  runIds: string[];
}

export interface RunMeta {
  id: string;
  origin: RunOrigin;
  agentId: string | null;
  routineId: string | null;
  taskId: string | null;
  chatId: string | null;
  engine: string;
  cwd: string;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  openedAt: string | null;
  dir: string;
  notifiedAt: string | null;
}

export interface EngineRow {
  id: string;
  label: string;
  bin: string;
  args: string[];
  available?: boolean;
}

export interface Settings {
  defaultEngine: string;
  defaultShell: string;
  notify: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  dockUrl?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  agentId: string | null;
  engine: string;
  cwd: string;
  runId: string | null;
  ptyId: string | null;
  createdAt: string;
  updatedAt: string;
}
