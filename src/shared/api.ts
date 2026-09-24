import type { FileNode } from "../core/files.js";
import type { Schedule } from "../core/types.js";
import type { Agent, ChatRecord, EngineRow, Routine, Settings, Task, TaskStatus, Workspace } from "../core/types.js";

export type { Settings, Workspace };
import type { RunMetaFile } from "../core/runfiles.js";

export interface Engine extends EngineRow {
  available: boolean;
}

export interface AgentDraft {
  id?: string;
  name: string;
  brief: string;
  engine: string;
  places: string[];
  skills?: string[];
  allowRoutines?: boolean;
}

export interface RoutineDraft {
  id?: string;
  name: string;
  agentId: string;
  enabled?: boolean;
  schedule: Schedule;
  prompt: string;
  notify?: boolean;
}

export interface RoutineRow extends Routine {
  issues: string[];
  stillRunning: boolean;
}

export interface TaskDraft {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
}

export interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  body: string;
}

export interface RunBundle {
  meta: RunMetaFile;
  preamble: string;
  scrollback: string;
  git: string;
  ptyId?: string | null;
}

export interface ForgeApi {
  paths(): Promise<{ configRoot: string; dataRoot: string }>;
  listWorkspaces(): Promise<{ workspaces: Workspace[]; lastWorkspaceId: string | null }>;
  addWorkspace(folderPath: string): Promise<{ workspaces: Workspace[]; lastWorkspaceId: string | null }>;
  removeWorkspace(id: string): Promise<{ workspaces: Workspace[]; lastWorkspaceId: string | null }>;
  selectWorkspace(id: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pathExists(folderPath: string): Promise<boolean>;
  listEngines(): Promise<Engine[]>;
  recheckEngines(): Promise<Engine[]>;
  saveEngines(engines: EngineRow[]): Promise<Engine[]>;
  ptySnapshot(ptyId: string): Promise<{ text: string; seq: number; alive: boolean }>;
  createPty(opts: { cwd: string; argv?: string[]; cols?: number; rows?: number }): Promise<{ ptyId: string }>;
  writePty(ptyId: string, data: string): Promise<void>;
  resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
  killPty(ptyId: string): Promise<void>;
  listPtys(): Promise<{ ptyId: string; cwd: string; pid: number }[]>;
  onPtyData(cb: (event: { ptyId: string; data: string; seq: number }) => void): () => void;
  onPtyExit(cb: (event: { ptyId: string; exitCode: number | null; status: string }) => void): () => void;
  onDockFail(cb: (event: { description: string; url: string }) => void): () => void;
  startShell(opts: { workspaceId: string }): Promise<{ ptyId: string }>;
  startCodeSession(opts: { workspaceId: string; engineId: string; prompt?: string }): Promise<{ ptyId: string; runId?: string }>;
  listTree(root: string): Promise<FileNode[]>;
  openPath(folderPath: string): Promise<void>;
  getDockUrl(workspaceId: string): Promise<string>;
  setDockUrl(workspaceId: string, url: string): Promise<void>;
  setDockBounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean; url?: string }): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  liveCount(): Promise<number>;
  listAgents(): Promise<Agent[]>;
  saveAgent(draft: AgentDraft): Promise<Agent>;
  deleteAgent(id: string, confirmName: string): Promise<void>;
  readMemory(id: string): Promise<string>;
  writeMemory(id: string, text: string): Promise<void>;
  listSkills(): Promise<{ id: string; name: string; description: string; body: string }[]>;
  saveSkill(draft: SkillDraft): Promise<{ id: string; name: string; description: string; body: string }>;
  deleteSkill(id: string): Promise<void>;
  listRoutines(): Promise<RoutineRow[]>;
  saveRoutine(draft: RoutineDraft): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  runRoutineNow(id: string): Promise<{ ok: boolean; reason?: string; runId?: string; ptyId?: string; message?: string }>;
  setRoutineEnabled(id: string, enabled: boolean): Promise<Routine>;
  previewRoutine(schedule: Schedule): Promise<string[]>;
  listRuns(): Promise<RunMetaFile[]>;
  getRun(id: string): Promise<RunBundle | null>;
  markRunOpened(id: string): Promise<void>;
  listInbox(): Promise<RunMetaFile[]>;
  startAgentChat(agentId: string): Promise<ChatRecord>;
  sendAgentChat(agentId: string, chatId: string, text: string): Promise<{ ok: boolean; reason?: string; chatId?: string; runId?: string | null; ptyId?: string | null; startedNew?: boolean; message?: string }>;
  listTasks(): Promise<Task[]>;
  saveTask(draft: TaskDraft): Promise<Task>;
  executeTask(id: string): Promise<{ ok: boolean; reason?: string; runId?: string; ptyId?: string }>;
  stopTask(id: string): Promise<void>;
  setTaskStatus(id: string, status: TaskStatus): Promise<Task>;
  listChats(): Promise<ChatRecord[]>;
  startChat(engineId: string): Promise<ChatRecord>;
  renameChat(id: string, name: string): Promise<ChatRecord>;
  deleteChat(id: string): Promise<void>;
  sendChat(chatId: string, text: string): Promise<{ ok: boolean; reason?: string; chatId?: string; runId?: string | null; ptyId?: string | null; startedNew?: boolean; message?: string }>;
}
