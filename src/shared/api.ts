// The contract between the renderer and the main process. The renderer calls
// `call("agents.list")`; the main process implements every key of DeskMethods.
import type { FileNode } from "../core/files.js";
import type { RunQuery } from "../core/store.js";
import type {
  AgentInput,
  ChatView,
  Launched,
  RoutineInput,
  RoutineView,
  RunBundle,
  RunView,
  SchedulePreview,
  SendResult,
  SkillInput,
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
  Schedule,
  Settings,
  Skill,
  TaskStatus,
  Topic,
  VoiceSettings,
} from "../core/types.js";
import type { InstallKind, Release } from "../core/updates.js";
import type { VoiceAction } from "../core/control.js";
import type { ModelChoice, SpeechPhase, VoiceChoice } from "../core/voice.js";
import type { WorkspaceFile } from "../core/workspaces.js";

export type {
  Agent,
  AgentInput,
  ChatView,
  Engine,
  EngineRow,
  FileNode,
  LayoutNode,
  Launched,
  LiveSession,
  Palette,
  Routine,
  RoutineInput,
  RoutineView,
  RunBundle,
  RunQuery,
  RunView,
  Schedule,
  SchedulePreview,
  SendResult,
  Settings,
  Skill,
  SkillInput,
  TaskInput,
  TaskStatus,
  TaskView,
  TermSize,
  Topic,
  VoiceSettings,
  WorkspaceFile,
  InstallKind,
  Release,
};
export type { Workspace, RunOrigin, RunStatus, PaneLaunch } from "../core/types.js";

export interface AppInfo {
  version: string;
  configRoot: string;
  dataRoot: string;
  home: string;
  hostRunning: boolean;
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

export interface PtySnapshot {
  ansi: string;
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
  /** The last lines of VibeForge's own log, oldest first. */
  "app.logTail": (lines: number) => string[];

  "updates.get": () => UpdateInfo;
  "updates.check": () => UpdateInfo;
  /** Starts the update command in a terminal. */
  "updates.run": (size?: TermSize) => { ptyId: string };

  "settings.get": () => Settings;
  "settings.save": (patch: Partial<Settings>) => Settings;
  "engines.list": () => Engine[];
  "engines.recheck": () => Engine[];
  "engines.save": (rows: EngineRow[]) => Engine[];

  "workspaces.list": () => WorkspaceFile;
  "workspaces.add": (folder: string) => WorkspaceFile;
  "workspaces.remove": (id: string) => WorkspaceFile;
  "workspaces.select": (id: string) => void;
  "workspaces.update": (id: string, patch: { name?: string; dockUrl?: string }) => WorkspaceFile;
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
  "skills.delete": (id: string) => void;
  "skills.setAgents": (skillId: string, agentIds: string[]) => void;

  "routines.list": () => RoutineView[];
  "routines.save": (input: RoutineInput) => Routine;
  "routines.delete": (id: string) => void;
  "routines.setEnabled": (id: string, enabled: boolean) => Routine;
  "routines.runNow": (id: string, size?: TermSize) => Launched;
  "routines.preview": (schedule: Schedule) => SchedulePreview;

  "tasks.list": () => TaskView[];
  "tasks.save": (input: TaskInput) => TaskView;
  "tasks.delete": (id: string) => void;
  "tasks.execute": (id: string, size?: TermSize) => Launched;
  "tasks.continue": (id: string, size?: TermSize) => Launched;
  "tasks.stop": (id: string) => TaskView;
  "tasks.setStatus": (id: string, status: TaskStatus) => TaskView;

  "chats.list": (filter?: { agentId?: string | null }) => ChatView[];
  "chats.create": (input: { agentId?: string | null; engine?: string }) => ChatView;
  "chats.rename": (id: string, title: string) => ChatView;
  "chats.setEngine": (id: string, engine: string) => ChatView;
  "chats.delete": (id: string) => void;
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
  "runs.diff": (id: string) => string;

  "live.list": () => LiveSession[];

  "voice.status": () => VoiceStatus;
  /** `endpoint`: stop by itself when the speaker pauses (conversation mode). */
  "voice.start": (opts?: { endpoint?: boolean }) => void;
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

  "dock.show": (bounds: DockBounds, url: string) => void;
  "dock.hide": () => void;
  /** The dock's page as a JPEG data URL, or null when it has nothing on screen. */
  "dock.capture": () => string | null;
  "dock.command": (command: "back" | "forward" | "reload" | "stop" | "devtools") => void;
}

export interface DeskEvents {
  changed: Topic[];
  "pty-data": { ptyId: string; data: string; first: number; seq: number };
  "pty-exit": { ptyId: string; exitCode: number | null; signal: number | null };
  palette: Palette;
  dock: DockState;
  "open-run": { runId: string };
  "host-crash": string;
  voice: VoiceState;
  "voice-talk": TalkEvent;
  /** `vibeforge --voice …` from a keybinding. */
  "voice-command": { action: VoiceAction };
}

export type Method = keyof DeskMethods;
export type MethodArgs<K extends Method> = Parameters<DeskMethods[K]>;
export type MethodResult<K extends Method> = Awaited<ReturnType<DeskMethods[K]>>;

export interface VibeForgeBridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  pathForFile(file: File): string;
}
