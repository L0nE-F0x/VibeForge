// The contract between the renderer and the main process. The renderer calls
// `call("agents.list")`; the main process implements every key of DeskMethods.
import type { FileNode } from "../core/files.js";
import type { RunQuery } from "../core/store.js";
import type {
  AgentInput,
  ChatView,
  Launched,
  Queued,
  RoutineInput,
  RoutineView,
  RunBundle,
  RunHit,
  RunUpkeep,
  RunView,
  SchedulePreview,
  SendResult,
  SkillInput,
  StorageSummary,
  TaskInput,
  TaskView,
  TermSize,
} from "../core/team-service.js";
import type { Palette } from "../core/theme.js";
import type {
  Agent,
  Engine,
  EngineRow,
  LayoutNode,
  LiveSession,
  Routine,
  RunOrigin,
  Schedule,
  Settings,
  Skill,
  SoundSettings,
  TaskStatus,
  Topic,
  VoiceSettings,
} from "../core/types.js";
import type { InstallKind, Release } from "../core/updates.js";
import type { UsageSummary } from "../core/usage.js";
import type { PlanSummary } from "../core/plans.js";
import type { Activity } from "../core/activity.js";
import type { VoiceAction } from "../core/control.js";
import type { ModelChoice, SpeechPhase, VoiceChoice } from "../core/voice.js";
import type { BranchList } from "../core/branches.js";
import type { WorkspaceFile } from "../core/workspaces.js";
import type { ApplyResult, WorkingCopy } from "../core/worktrees.js";

export type { ApplyResult, WorkingCopy, BranchList };
import type { Deleted } from "../core/team-service.js";

export type { Deleted };

export type {
  Agent,
  AgentInput,
  ChatView,
  Engine,
  EngineRow,
  FileNode,
  LayoutNode,
  Launched,
  Queued,
  LiveSession,
  Palette,
  Routine,
  RoutineInput,
  RoutineView,
  RunBundle,
  RunHit,
  RunQuery,
  RunUpkeep,
  RunView,
  Schedule,
  SchedulePreview,
  StorageSummary,
  SendResult,
  Settings,
  Skill,
  SkillInput,
  TaskInput,
  TaskStatus,
  TaskView,
  TermSize,
  Topic,
  SoundSettings,
  VoiceSettings,
  WorkspaceFile,
  InstallKind,
  Release,
  UsageSummary,
  PlanSummary,
  Activity,
};
export type { UsageSource, UsageSpan, UsagePeriod, UsageLimit, Tokens } from "../core/usage.js";
export type { PlanProvider, PlanWindow, PlanPoint, PlanProblem, PlanId } from "../core/plans.js";
export type { Workspace, RunOrigin, RunStatus, PaneLaunch } from "../core/types.js";

export interface AppInfo {
  version: string;
  configRoot: string;
  dataRoot: string;
  home: string;
  hostRunning: boolean;
  /** Why the terminal host isn't running, when it failed to start or kept crashing. */
  hostError: string | null;
  electron: string;
  chrome: string;
  node: string;
  os: string;
  repo: string;
  /** Where the app itself lives, and how it was installed there. */
  appPath: string;
  install: InstallKind;
  /** VibeForge's own log (events and errors; never prompts or terminal output). */
  logFile: string;
}

export interface UpdateInfo {
  current: string;
  /** The newest published release, or null when none is known (not checked yet, or none published). */
  latest: Release | null;
  available: boolean;
  checking: boolean;
  checkedAt: string | null;
  error: string | null;
  install: InstallKind;
  /** What "Update now" runs in a terminal; null when this copy updates some other way. */
  command: string | null;
}

export type VoicePhase = "idle" | "recording" | "transcribing";

/** Sent many times a second while recording, for the level meter and the timer. */
export interface VoiceState {
  phase: VoicePhase;
  /** 0–1, for the meter. */
  level: number;
  seconds: number;
  /** In conversation mode: whether someone has started, or finished, speaking. */
  speech: SpeechPhase | null;
}

/** An answer being waited for, read aloud, or finished with. */
export interface TalkEvent {
  /** The terminal the answer comes from; null for a test phrase. */
  ptyId: string | null;
  stage: "waiting" | "speaking" | "done";
  /** Who is answering: the agent's name, or the session's title. */
  who: string;
  /** What is being said (for "speaking"). */
  text: string;
}

export type DownloadKind = "model" | "voice";

/** What dictation found on this machine. */
export interface VoiceStatus {
  /** The recorder's name ("pw-record"), or null when none was found. */
  recorder: string | null;
  server: string | null;
  cli: string | null;
  /** The model that will be loaded, or null when none was found. */
  model: string | null;
  /** Every model file found, best first. */
  models: string[];
  /** Where downloaded models go. */
  modelDir: string;
  /** What whisper listens for with this model and setting: a code, or "auto". */
  language: string;
  ready: boolean;
  catalog: Array<ModelChoice & { path: string | null }>;
  download: { kind: DownloadKind; id: string; received: number; total: number } | null;
  downloadError: string | null;
  /** Piper, for reading answers aloud; null when it isn't installed. */
  piper: string | null;
  /** The audio player's name ("pw-play"), or null. */
  player: string | null;
  /** Every Piper voice found. */
  voices: string[];
  /** The voice answers are read in unless an agent has its own. */
  speaker: string | null;
  voiceDir: string;
  voiceCatalog: Array<VoiceChoice & { path: string | null }>;
  /** Something is being read aloud right now. */
  speaking: boolean;
  /** Where `vibeforge --voice …` reaches this window. */
  controlSocket: string;
  /** Lines for Hyprland that reach VibeForge's voice from anywhere, and the file they belong in. */
  hyprland: { file: string; text: string; installed: boolean };
}

export interface Dictation {
  text: string;
  seconds: number;
  /** Milliseconds from key-up to words. */
  tookMs: number;
  /** Why nothing came back: a stray tap, a silent mic, or whisper heard no words. */
  empty: "short" | "silent" | "nothing" | null;
}

export interface CompanionStatus {
  listening: boolean;
  /** http://127.0.0.1:port while the page is up. */
  url: string | null;
  error: string | null;
}

export interface PtySnapshot {
  ansi: string;
  /** The screen as text, for the phone. The window keeps using `ansi`. */
  plain: string;
  seq: number;
  cols: number;
  rows: number;
  alive: boolean;
}

export interface DockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockState {
  /** The workspace this page belongs to. A late event from another workspace is ignored. */
  workspaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface DeskMethods {
  "app.info": () => AppInfo;
  "app.palette": () => Palette;
  "app.openPath": (target: string) => void;
  "app.openExternal": (url: string) => void;
  "app.pickFolder": (title?: string) => string | null;
  "app.pathExists": (target: string) => boolean;
  "app.toggleDevTools": () => void;
  "app.restart": () => void;
  "app.copyText": (text: string) => void;
  /** Bring the window forward, so a transcript dictated from another desktop is on screen. */
  "app.focus": () => void;
  /** The clipboard's text, and whether it also holds an image. */
  "app.clipboard": () => { text: string; image: boolean };
  /** Token usage from the CLIs' own logs, or null when Settings turn it off. */
  "usage.summary": () => UsageSummary | null;
  /**
   * How much of each coding plan is used: Codex from its logs, and Claude, Grok and Kimi when
   * Settings allow asking them. Null when there's nothing to show. `fresh` asks again now.
   */
  "plans.summary": (fresh?: boolean) => PlanSummary | null;
  /** The contribution graph for Home, or null when Settings turn it off. `fresh` skips the cache. */
  "activity.get": (fresh?: boolean) => Activity | null;
  /** A desktop notification (when Settings allow them) that opens the chat or workspace when clicked. */
  /** `route` is where a click on it goes, handed back as it was in "open-route". */
  "app.notify": (note: { title: string; body: string; workspaceId?: string | null; chatId?: string | null; agentId?: string | null; route?: unknown }) => void;
  /** Omarchy's Do Not Disturb is on. */
  "app.doNotDisturb": () => boolean;
  /** "Start at login, in the tray": whether the autostart entry is there, and setting it. */
  "app.autostart": () => boolean;
  "app.setAutostart": (on: boolean) => boolean;
  /** How many CLIs and chats are waiting for you, for the tray icon's dot. */
  /** The CLIs and chats waiting for you, for the tray: how many, and each one's name and place. */
  "app.attention": (state: { count: number; waiters: TrayWaiter[] }) => void;
  /** The last lines of VibeForge's own log, oldest first. */
  "app.logTail": (lines: number) => string[];

  "updates.get": () => UpdateInfo;
  "updates.check": () => UpdateInfo;
  /** Starts the update command in a terminal. */
  "updates.run": (size?: TermSize) => { ptyId: string };

  "settings.get": () => Settings;
  "settings.save": (patch: Partial<Settings>) => Settings;
  /** Whether the phone page is listening, and why not when it failed to bind. */
  "companion.status": () => CompanionStatus;
  "engines.list": () => Engine[];
  "engines.recheck": () => Engine[];
  "engines.save": (rows: EngineRow[]) => Engine[];

  "workspaces.list": () => WorkspaceFile;
  "workspaces.add": (folder: string) => WorkspaceFile;
  "workspaces.remove": (id: string) => WorkspaceFile;
  "workspaces.select": (id: string) => void;
  "workspaces.move": (id: string, toIndex: number) => WorkspaceFile;
  "workspaces.update": (id: string, patch: { name?: string; dockUrl?: string }) => WorkspaceFile;
  /** Local branches of a workspace's repository. An empty repo means the folder is not one. */
  "workspaces.branches": (id: string) => BranchList;
  /** Check a branch out beside this workspace. The workspace folder stays on its current branch. */
  "workspaces.openBranch": (id: string, branch: string) => WorkspaceFile;
  "layouts.get": (workspaceId: string) => LayoutNode | null;
  "layouts.save": (workspaceId: string, layout: LayoutNode | null) => void;
  "files.list": (dir: string) => FileNode[];

  "agents.list": () => Agent[];
  "agents.save": (input: AgentInput) => Agent;
  "agents.delete": (id: string, confirmName: string) => void;
  "agents.readMemory": (id: string) => string;
  "agents.writeMemory": (id: string, text: string) => void;

  "skills.list": () => Skill[];
  "skills.save": (input: SkillInput) => Skill;
  "skills.delete": (id: string) => Deleted;
  "skills.setAgents": (skillId: string, agentIds: string[]) => void;

  "routines.list": () => RoutineView[];
  "routines.save": (input: RoutineInput) => Routine;
  "routines.delete": (id: string) => Deleted;
  "routines.setEnabled": (id: string, enabled: boolean) => Routine;
  /** Waits its turn (Queued) while another coding CLI is busy in the folder, unless `now`. */
  "routines.runNow": (id: string, size?: TermSize, now?: boolean) => Launched | Queued;
  "routines.cancelWait": (id: string) => void;
  "routines.preview": (schedule: Schedule) => SchedulePreview;

  "tasks.list": () => TaskView[];
  "tasks.save": (input: TaskInput) => TaskView;
  "tasks.delete": (id: string) => Deleted;
  /** Waits its turn (Queued) while another coding CLI is busy in the workspace, unless `now`. */
  "tasks.execute": (id: string, size?: TermSize, now?: boolean) => Launched | Queued;
  "tasks.cancelWait": (id: string) => TaskView;
  /** A finished run as a To do task for another agent. Nothing starts until Execute. */
  "tasks.handOff": (runId: string, agentId: string) => TaskView;
  "tasks.continue": (id: string, size?: TermSize) => Launched;
  "tasks.stop": (id: string) => TaskView;
  "tasks.setStatus": (id: string, status: TaskStatus) => TaskView;
  /** Bring an isolated task's changes into its workspace as uncommitted edits. */
  "tasks.applyCopy": (id: string) => ApplyResult;
  /** Throw an isolated task's copy away. */
  "tasks.discardCopy": (id: string) => TaskView;

  "chats.list": (filter?: { agentId?: string | null }) => ChatView[];
  "chats.create": (input: { agentId?: string | null; engine?: string }) => ChatView;
  "chats.rename": (id: string, title: string) => ChatView;
  "chats.setEngine": (id: string, engine: string) => ChatView;
  "chats.delete": (id: string) => Deleted;
  /** Put back what a delete removed, while its Undo is still offered. */
  "undo.delete": (token: string) => void;
  "chats.send": (id: string, text: string, size?: TermSize) => SendResult;
  "chats.continue": (id: string, size?: TermSize) => SendResult;
  "chats.stop": (id: string) => void;

  "code.shell": (opts: { workspaceId?: string; cwd?: string } & TermSize) => { ptyId: string };
  "code.engine": (opts: { workspaceId: string; engineId: string; prompt?: string; continueSession?: boolean } & TermSize) => Launched;

  "runs.list": (query?: RunQuery) => RunView[];
  "runs.inbox": () => RunView[];
  "runs.get": (id: string) => RunBundle;
  "runs.markOpened": (id: string, opened?: boolean) => void;
  "runs.markAllOpened": () => void;
  "runs.stop": (id: string) => void;
  "runs.continue": (id: string, size?: TermSize) => Launched & { chatId: string | null; taskId: string | null };
  /** Runs whose title, prompt, transcript or folder hold the words typed, best first, with a snippet. */
  "runs.search": (text: string, limit?: number) => RunHit[];
  /** `saved` is the patch frozen when the run ended. `now` reads the folder as it is. */
  "runs.diff": (id: string, source?: "saved" | "now") => string;
  /** A finished run as Markdown for an issue or a pull request (src/core/run-markdown.ts). */
  "runs.markdown": (id: string) => string;

  /** Where VibeForge's disk space goes. */
  "storage.summary": () => StorageSummary;
  /** Compress ended runs and remove the ones Settings → Storage doesn't keep, now. */
  "storage.tidy": () => RunUpkeep;

  "live.list": () => LiveSession[];

  "voice.status": () => VoiceStatus;
  "voice.start": () => void;
  /** Stops recording and returns the words. `prompt` names things whisper should expect. */
  "voice.stop": (prompt?: string) => Dictation;
  "voice.cancel": () => void;
  "voice.download": (kind: DownloadKind, id: string) => void;
  "voice.stopDownload": () => void;
  /** Reads a phrase aloud, in a voice file or the default one. */
  "voice.speak": (text: string, voice?: string) => void;
  "voice.silence": () => void;
  /**
   * Waits for the answer to `words` in this terminal and reads it aloud (as Settings says).
   * False when the terminal's program leaves no log to read and will not be heard from.
   */
  "voice.expect": (ptyId: string, words: string) => boolean;
  "voice.forget": (ptyId?: string) => void;
  /** Appends the keybinding lines to the Hyprland config (after a backup); returns the file. */
  "voice.installBindings": () => string;

  "pty.write": (ptyId: string, data: string) => void;
  "pty.send": (ptyId: string, text: string) => void;
  "pty.resize": (ptyId: string, cols: number, rows: number) => void;
  "pty.snapshot": (ptyId: string) => PtySnapshot;
  "pty.kill": (ptyId: string) => void;

  "dock.show": (bounds: DockBounds, url: string, workspaceId: string) => void;
  /** Hides the page. With a workspace id, that workspace stays the one back, forward and reload act on. */
  "dock.hide": (workspaceId?: string) => void;
  /** Drops a workspace's page. Called when the workspace is removed. */
  "dock.release": (workspaceId: string) => void;
  /** The dock's page as a JPEG data URL, or null when it has nothing on screen. */
  "dock.capture": () => string | null;
  "dock.command": (command: "back" | "forward" | "reload" | "stop" | "devtools") => void;
}

/** One waiting CLI or chat in the tray's menu; `route` comes back in "open-route" when it's picked. */
export interface TrayWaiter {
  label: string;
  route: unknown;
}

export interface DeskEvents {
  changed: Topic[];
  "pty-data": { ptyId: string; data: string; first: number; seq: number };
  "pty-exit": { ptyId: string; exitCode: number | null; signal: number | null };
  palette: Palette;
  dock: DockState;
  "open-run": { runId: string };
  "open-workspace": { workspaceId: string };
  "open-chat": { chatId: string; agentId: string | null };
  /** Somewhere the page asked to be taken back to: a waiter in the tray or a notification. */
  "open-route": { route: unknown };
  /** From the tray menu. */
  "open-view": { view: "settings" };
  "open-switcher": true;
  /** A run ended: for the finished and failed sounds. */
  "run-finished": RunEnded;
  "host-crash": string;
  voice: VoiceState;
  "voice-talk": TalkEvent;
  /** `vibeforge --voice …` from a keybinding. */
  "voice-command": { action: VoiceAction };
}

export interface RunEnded {
  runId: string;
  origin: RunOrigin;
  outcome: "ok" | "failed" | "stopped";
}

export type Method = keyof DeskMethods;
export type MethodArgs<K extends Method> = Parameters<DeskMethods[K]>;
export type MethodResult<K extends Method> = Awaited<ReturnType<DeskMethods[K]>>;

export interface VibeForgeBridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  pathForFile(file: File): string;
}
