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
  /** The Piper voice (.onnx) this agent's answers are read in; empty uses the one in Settings. */
  voice: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface RunMeta {
  id: string;
  origin: RunOrigin;
  title: string;
  agentId: string | null;
  routineId: string | null;
  taskId: string | null;
  chatId: string | null;
  workspaceId: string | null;
  engine: string;
  argv: string[];
  cwd: string;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  exitCode: number | null;
  signal: number | null;
  stopRequested: boolean;
  openedAt: string | null;
  notifiedAt: string | null;
  dir: string;
  error: string | null;
  /** One-line summary of git.txt, e.g. "2 commits · 3 files changed", or null outside a repo. */
  changes: string | null;
  /** HEAD when the run started, so review can show what changed since. */
  gitStart: string | null;
  /** The run this one continues, if any. */
  continuedFrom: string | null;
}

export interface EngineRow {
  id: string;
  label: string;
  bin: string;
  args: string[];
  /**
   * How the starting prompt reaches the CLI. `{prompt}` is replaced with the text.
   * Leave empty and VibeForge pastes the prompt into the session once it is ready.
   */
  promptArgs?: string[];
  /** Arguments that reopen the CLI's latest session in the same folder. */
  continueArgs?: string[];
}

export interface Engine extends EngineRow {
  available: boolean;
  path: string | null;
}

export interface Settings {
  defaultEngine: string;
  defaultShell: string;
  notify: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  theme: "omarchy" | "builtin";
  /** The welcome tour has been finished or skipped; it opens by itself until then. */
  tourDone: boolean;
  /** Ask GitHub for the newest release at start and every few hours. */
  checkUpdates: boolean;
  /** "system" follows the desktop's language; otherwise a code such as "de". */
  language: string;
  voice: VoiceSettings;
  /** The views in the left rail: their order, and which ones are hidden. Unknown names are ignored. */
  rail: { order: string[]; hidden: string[] };
}

/** Dictation: speech to text on this machine with whisper.cpp. */
export interface VoiceSettings {
  /** A whisper.cpp model file; empty picks the best one found in the usual folders. */
  model: string;
  /** "auto" lets whisper tell; otherwise a code such as "de". English-only models always hear English. */
  language: string;
  /** Press Enter after the words too. Off: they wait in the box or terminal for you to read first. */
  autoSend: boolean;
  /** Read an agent's answer to what you said aloud: its first paragraph, all of it, or not at all. */
  talkBack: "off" | "summary" | "full";
  /** The Piper voice (.onnx) answers are read in unless the agent has its own; empty picks one. */
  speaker: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  dockUrl: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  agentId: string | null;
  engine: string;
  cwd: string;
  runIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type PaneLaunch = { type: "shell" } | { type: "engine"; engineId: string };

export type LayoutNode =
  | { kind: "pane"; id: string; launch: PaneLaunch }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };

export interface LiveSession {
  ptyId: string;
  runId: string | null;
  kind: "shell" | "run";
  title: string;
  cwd: string;
  pid: number;
  startedAt: string;
  origin: RunOrigin | null;
  agentId: string | null;
  chatId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  /** What a shell is running in its foreground right now ("vim", or an engine's label), if anything. */
  program?: string | null;
  /** The engine behind `program`, when it is one of the coding CLIs. */
  programEngineId?: string | null;
  /** The folder `program` runs in. */
  programCwd?: string | null;
}

export type Topic =
  | "agents"
  | "skills"
  | "routines"
  | "tasks"
  | "runs"
  | "chats"
  | "workspaces"
  | "engines"
  | "settings"
  | "live"
  | "updates"
  | "voice";
