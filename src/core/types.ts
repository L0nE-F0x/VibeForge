import type { WorkingCopy } from "./worktrees.js";

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
  /** Work in a separate git worktree of the workspace instead of the workspace itself. */
  isolated: boolean;
  /** That worktree, once Execute has made it; gone again after Apply or Discard. */
  copy: WorkingCopy | null;
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
  sounds: SoundSettings;
  /** An icon in the system tray (Omarchy's bar), with a small menu. */
  tray: boolean;
  /** With the tray icon, closing the window leaves VibeForge running there: terminals and routines go on. */
  closeToTray: boolean;
  /** Add up token usage from the logs the CLIs keep on this machine. Read locally, never sent. */
  usage: boolean;
  /**
   * Ask Anthropic, xAI and Moonshot how much of the Claude, Grok and Kimi plans is used, with the
   * sign-in each CLI saved. Contacts those services, so it starts off.
   */
  planLimits: boolean;
  /** A notification when a plan window passes 80, 95 and 100 percent. Off, since Omarchy's widget may already say so. */
  quotaAlerts: boolean;
  /** The contribution graph on Home: off, your commits in the workspaces, or GitHub through `gh`. */
  activity: "off" | "git" | "github";
  /** The views in the left rail: their order, and which ones are hidden. Unknown names are ignored. */
  rail: { order: string[]; hidden: string[] };
  /** How long finished runs are kept, and how much room they may take. Zeros keep everything. */
  keepRuns: { days: number; maxMb: number };
}

/** Short tones, made in the app, for moments worth hearing about. */
export interface SoundSettings {
  on: boolean;
  /** 0 to 1. */
  volume: number;
  /** Recording starts, stops, or is dropped. Your own action, so Do Not Disturb doesn't silence it. */
  voice: boolean;
  /** A coding CLI or agent went quiet and it's your turn. */
  attention: boolean;
  /** A task, routine or typed CLI finished, or failed. */
  finished: boolean;
  /** A routine started on its schedule. */
  routines: boolean;
  /** Also play the event sounds while you're looking at VibeForge. Off: only when it's in the background. */
  inFront: boolean;
}

/** Dictation: speech to text on this machine with whisper.cpp. */
export interface VoiceSettings {
  /** A whisper.cpp model file; empty picks the best one found in the usual folders. */
  model: string;
  /** "auto" lets whisper tell; otherwise a code such as "de". English-only models always hear English. */
  language: string;
  /** Read the first paragraph of an answer to a message that was sent by voice. */
  talkBack: boolean;
  /** The Piper voice (.onnx) answers are read in unless the agent has its own; empty picks one. */
  speaker: string;
  /** Who Super+Alt+V talks to. Empty: the agent you last dictated to. */
  agent: string;
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
  /** A coding CLI here is busy (its output keeps coming); false once it has gone quiet. */
  working?: boolean;
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
