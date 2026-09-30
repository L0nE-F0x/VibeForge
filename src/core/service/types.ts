import path from "node:path";
import type { RunFiles } from "../runs.js";
import type { ExecuteBlocker } from "../tasks.js";
import type { Routine, RunMeta, RunOrigin, Schedule, Task, ChatRecord } from "../types.js";

// ------------------------------------------------------------------ host contract

export interface SpawnRequest {
  cwd: string;
  argv: string[];
  /** Run directory the PTY host writes scrollback, the final screen, and a text transcript into. */
  runDir: string | null;
  /** Pasted once the CLI has drawn its UI and gone quiet. */
  pasteInput: string | null;
  cols?: number;
  rows?: number;
}

export interface DeskHost {
  spawn(request: SpawnRequest): Promise<{ ptyId: string; pid: number }>;
  /** Paste text into a live session and press Enter. */
  send(ptyId: string, text: string): Promise<void>;
  kill(ptyId: string): Promise<void>;
  /** Record a shell's terminal into a run folder from now on, or (null) stop and write its files. */
  record(ptyId: string, runDir: string | null): Promise<void>;
  resolveBin(bin: string): string | null;
  notify(note: { title: string; body: string; runId: string }): void;
  /** Every run that ends, for the finished and failed sounds. */
  finished?(run: { runId: string; origin: RunOrigin; outcome: "ok" | "failed" | "stopped" }): void;
  snapshotGit(cwd: string, startHead: string | null): Promise<string>;
  gitHead(cwd: string): Promise<string | null>;
}

export interface DeskOptions {
  configRoot: string;
  dataRoot: string;
  appStartedAt: Date;
  now: () => Date;
  host: DeskHost;
}

// ------------------------------------------------------------------ inputs and views

export interface AgentInput {
  id?: string;
  name: string;
  engine: string;
  brief: string;
  places: string[];
  skills?: string[];
  allowRoutines?: boolean;
  /** A Piper voice file; empty uses the one in Settings. */
  voice?: string;
}

export interface SkillInput {
  id?: string;
  name: string;
  description?: string;
  body?: string;
}

export interface RoutineInput {
  id?: string;
  name: string;
  agentId: string;
  enabled?: boolean;
  schedule: Schedule;
  prompt?: string;
  notify?: boolean;
}

export interface TaskInput {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
  /** Work in a separate git worktree of the workspace. */
  isolated?: boolean;
}

export interface TermSize {
  cols?: number;
  rows?: number;
}

export interface RunView extends RunMeta {
  live: boolean;
  ptyId: string | null;
}

export interface RoutineView extends Routine {
  agentName: string | null;
  issues: string[];
  stillRunning: boolean;
  description: string;
  nextFires: string[];
  lastRun: RunView | null;
}

export interface TaskView extends Task {
  lastRun: RunView | null;
  blocker: ExecuteBlocker | "engine-missing" | null;
}

export interface ChatView extends ChatRecord {
  live: boolean;
  ptyId: string | null;
  lastRun: RunView | null;
}

export interface RunBundle {
  run: RunView;
  files: RunFiles;
}

export interface Launched {
  runId: string;
  ptyId: string;
}

export interface SendResult extends Launched {
  chatId: string;
  /** True when the send started a new process instead of typing into a live one. */
  started: boolean;
  note: string | null;
}

export interface SchedulePreview {
  valid: boolean;
  description: string;
  next: string[];
}

export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
export const REVIEW_ORIGINS: RunOrigin[] = ["routine", "task", "agent-chat", "code"];
/** A CLI typed into a shell that ends this quickly without changing anything (`claude --version`) isn't kept. */
export const BLIP_MS = 5000;
/**
 * How long a delete can be undone. The toast that offers Undo goes sooner; this is the margin.
 * After it, or when the app closes, the files are removed for good.
 */
export const UNDO_MS = 30_000;

/** What a delete hands back: the token that undoes it. */
export interface Deleted {
  undo: string;
}

/** Written on a patch that could not be taken at exit, because the app was already gone. */
export const LATE_PATCH_NOTE = "# Saved when VibeForge next opened, because it closed during this run.\n";

export const BLOCKER_TEXT: Record<ExecuteBlocker | "engine-missing", string> = {
  "missing-agent": "Assign an agent first.",
  "missing-workspace": "Pick a workspace first.",
  "outside-places": "That workspace is not one of the agent's allowed folders.",
  "engine-missing": "The agent's engine is not on PATH.",
};

export function normalizePlaces(places: readonly string[]): string[] {
  const out: string[] = [];
  for (const place of places) {
    if (typeof place !== "string" || !place.trim()) continue;
    const resolved = path.resolve(place.trim());
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

export function titleFromPrompt(text: string): string {
  const line = text.trim().split("\n").find((item) => item.trim()) ?? "Chat";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
}

export const DEFAULT_CHAT_TITLE = "New chat";

/** What a tidy-up of the run folders did. */
export interface RunUpkeep {
  compressed: number;
  removed: number;
  /** Bytes given back to the disk. */
  freed: number;
}

/** Where VibeForge's disk space goes, for Settings. Bytes. */
export interface StorageSummary {
  dataRoot: string;
  runs: number;
  runCount: number;
  /** Whisper models and Piper voices VibeForge downloaded. */
  voice: number;
  logs: number;
  /** Chats without an agent work in folders here. */
  scratch: number;
}

/** A run found by search, with the words around the match (see SNIPPET_OPEN in store.ts). */
export interface RunHit extends RunView {
  snippet: string;
}

