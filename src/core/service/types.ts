import path from "node:path";
import type { MemoryFlag } from "../../shared/memory.js";
import type { ComputerUseDriver } from "../computer-use.js";
import type { RunFiles } from "../runs.js";
import type { ExecuteBlocker } from "../tasks.js";
import type { AgentTier, Routine, RunMeta, RunOrigin, Schedule, Task, ChatRecord } from "../types.js";
import type { Writer } from "../checkout.js";
import type { ReplyLog } from "../replies.js";
import type { SessionLog } from "../session-ids.js";
import type { Waiting } from "./turns.js";

// ------------------------------------------------------------------ host contract

export interface SpawnRequest {
  cwd: string;
  argv: string[];
  /** Ephemeral per-spawn environment variables (e.g. pointing a local CLI session at a local server). */
  env?: Record<string, string>;
  /** Run directory the PTY host writes scrollback, the final screen, and a text transcript into. */
  runDir: string | null;
  /** Pasted once the CLI has drawn its UI and gone quiet. */
  pasteInput: string | null;
  cols?: number;
  rows?: number;
}

export interface DeskHost {
  spawn(request: SpawnRequest): Promise<{ ptyId: string; pid: number; ptyToken?: string }>;
  /** Paste text into a live session and press Enter, or (`enter` false) leave it there for a person to send. */
  send(ptyId: string, text: string, enter?: boolean): Promise<void>;
  /** Write raw keystrokes directly to a live PTY (e.g. answering an interactive TUI prompt). */
  write?(ptyId: string, data: string): Promise<void>;
  /** What a live terminal shows now, as plain text, with its scrollback. */
  screen?(ptyId: string): Promise<string>;
  /** The foreground process in a shell pane right now (not the 1s poll). */
  foreground?(ptyId: string): Promise<{ known: boolean; argv: string[] | null; cwd: string | null }>;
  /** The answer to a prompt sent at or after `since`, from the CLI's own session log; null on abort or timeout. */
  watchReply?(opts: { kind: ReplyLog; cwd: string; since: number; words: string; signal: AbortSignal }): Promise<string | null>;
  /** The CLI's latest finished answer in `cwd`, from its own session log, if it left one since `since`. */
  lastReply?(opts: { kind: ReplyLog; cwd: string; since: number; words?: string }): Promise<string | null>;
  /** The session logs a CLI has written in `cwd` since `since`, with when each last changed (core/session-ids.ts). */
  sessionLogs?(opts: { kind: ReplyLog; cwd: string; since: number }): Promise<SessionLog[]>;
  kill(ptyId: string): Promise<void>;
  /** Turns syncing a saved agent or skill with the paired machines on or off (Settings → Sync). */
  syncLibrary?(kind: "agent" | "skill", id: string, on: boolean): Promise<void>;
  /** Record a shell's terminal into a run folder from now on, or (null) stop and write its files. */
  record(ptyId: string, runDir: string | null): Promise<void>;
  resolveBin(bin: string): string | null;
  notify(note: { title: string; body: string; runId?: string; taskId?: string; routineId?: string }): void;
  /** Every run that ends, for the finished and failed sounds. */
  finished?(run: { runId: string; origin: RunOrigin; outcome: "ok" | "failed" | "stopped" }): void;
  snapshotGit(cwd: string, startHead: string | null): Promise<string>;
  gitHead(cwd: string): Promise<string | null>;
  /**
   * Take the window to a place in it (a view, a workspace, a terminal in Code, or a specific
   * agent/task/routine/skill/chat/run/settings section), as a notification's click does.
   * It is brought to the front too unless `raise` is false.
   */
  show?(
    route: {
      view: string;
      workspaceId?: string;
      ptyId?: string;
      copyId?: string;
      runId?: string;
      agentId?: string;
      tab?: string;
      chatId?: string;
      taskId?: string;
      routineId?: string;
      skillId?: string;
      section?: string;
      filter?: string;
    },
    raise?: boolean,
  ): void;
  /** Drive the browser dock (reload, back, forward, stop). */
  dockCommand?(command: "back" | "forward" | "reload" | "stop"): void;
  /** Drive Code's side panel, browser preview URL, or pane layout. */
  codeWorkbench?(
    event:
      | { kind: "browser-open"; workspaceId: string; url: string }
      | { kind: "side"; workspaceId?: string; tab: "files" | "browser" | "close" }
      | { kind: "pane"; workspaceId?: string; action: "split-right" | "split-down" | "zoom" | "close" | "focus-next" | "focus-prev" },
  ): void;
  /** Open a local folder in the desktop file manager. */
  openFolder?(folderPath: string): Promise<void>;
  /** Copy plain/markdown text to the system clipboard. */
  writeClipboard?(text: string): void;
  /** Trigger an app update check and return a short summary. */
  checkUpdates?(): Promise<string>;
  /** Formatted plan limits and token usage summary for Viby's `inspect` step. */
  quotas?(): Promise<string>;
  /** Live voice, STT and TTS status on this machine, for Viby's context and `inspect` step. */
  voiceStatus?(): {
    ready: boolean;
    recorder: string | null;
    server: string | null;
    cli: string | null;
    sherpa?: string | null;
    model: string | null;
    models: string[];
    modelDir: string;
    language: string;
    piper: string | null;
    voices: string[];
    speaker: string | null;
    voiceDir: string;
    download: { kind: "model" | "voice" | "sherpa"; id: string; received: number; total: number } | null;
    downloadError: string | null;
  };
  /** Start downloading a pinned STT model, Piper voice, or sherpa-onnx runtime from Viby's `settings` step. */
  voiceDownload?(kind: "model" | "voice" | "sherpa", id: string): void;
  /** Cancel an active voice model/runtime download from Viby's `settings` step. */
  voiceStopDownload?(): void;
  /** Login autostart state and setter, for Viby's `settings` step. */
  autostart?: { get(): boolean; set(on: boolean): boolean };
  /** Write a privacy-safe single-line Viby diagnostic event to the app log (never prompts or output). */
  logDiagnostics?(line: string): void;
  /** Desktop + app UI computer-use observation and control driver. */
  computer?: ComputerUseDriver;
  /** An agent added a dated line to its own memory (`vibeforge remember`); `undo` removes that exact line. */
  remembered?(item: { agentId: string; agentName: string; note: string; line: string; flagged: boolean; undo: string }): void;
}

/** A run the last close of VibeForge cut off, as the window offers it back. */
export interface CutOffRun {
  runId: string;
  title: string;
  origin: RunOrigin;
  engine: string;
  workspaceId: string | null;
  /** The Code pane it ran in, when it ran in one. */
  paneId: string | null;
  chatId: string | null;
  taskId: string | null;
  /** Its exact session is known, so Continue reopens that one and not the folder's latest. */
  exact: boolean;
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
  goodAt?: string;
  tier?: AgentTier;
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
  /** Start even while another coding CLI is busy in the agent's folder. */
  shareCheckout?: boolean;
}

export interface TaskInput {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
  /** Work in a separate git worktree of the workspace. */
  isolated?: boolean;
  /** Start even while another coding CLI is busy in the workspace. */
  shareCheckout?: boolean;
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
  /** Its latest runs that failed in a row. */
  failStreak: number;
  /** Failed often enough in a row (ROUTINE_FAILING) to glow on Routines and Home. */
  failing: boolean;
  /** Other coding CLIs in the routine's folder right now. */
  writers: Writer[];
  /** A due slot or Run now waiting for the folder, and who it waits for. */
  waiting: Waiting | null;
}

export interface TaskView extends Task {
  lastRun: RunView | null;
  blocker: ExecuteBlocker | "engine-missing" | null;
  /** False when the task file points its copy somewhere other than its own worktree. */
  copyOwned: boolean;
  /** Other coding CLIs in the task's workspace right now (none for a task in its own copy). */
  writers: Writer[];
  /** Execute waiting for the workspace, and who it waits for. */
  waiting: Waiting | null;
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

/** Execute or Run now found another coding CLI busy in the folder: it starts once that one is quiet. */
export interface Queued {
  queued: true;
  /** Who it waits for. */
  behind: string[];
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
  /** A task's copy was left on disk because its path wasn't the task's own worktree. */
  copyLeft?: boolean;
}

/** Result of `vibeforge remember "<one line>"` from an agent's terminal. */
export type RememberResult =
  | {
      ok: true;
      agentId: string;
      agent: string;
      note: string;
      line: string;
      flagged: boolean;
      flags: MemoryFlag[];
      undo: string;
    }
  | { ok: false; error: string };

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

/** Git state and recent run timestamp for a workspace in Code's workspace list. */
export interface WorkspaceSummary {
  exists: boolean;
  git: boolean;
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  lastRunAt: string | null;
  lastCommitAt: string | null;
}

