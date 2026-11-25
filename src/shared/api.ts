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
  WorkspaceSummary,
} from "../core/team-service.js";
import type { Palette, ThemeChoice, ThemeList } from "../core/theme.js";
import type {
  Agent,
  AgentTier,
  Engine,
  EngineRow,
  LayoutNode,
  LiveSession,
  Routine,
  RunOrigin,
  Schedule,
  Settings,
  Skill,
  AgentTalkSettings,
  OrchestratorSettings,
  SoundSettings,
  TalkState,
  TaskStatus,
  Topic,
  UnreadableFile,
  UnreadableItem,
  LibraryKind,
  VoiceSettings,
} from "../core/types.js";
import type { InstallKind, Release } from "../core/updates.js";
import type { UsageSummary } from "../core/usage.js";
import type { PlanSummary } from "../core/plans.js";
import type { Activity } from "../core/activity.js";
import type { VoiceAction } from "../core/control.js";
import type { ModelChoice, SpeechPhase, VoiceChoice } from "../core/voice.js";
import type { BranchList } from "../core/branches.js";
import type { Cue } from "./chimes.js";
import type { WorkspaceFile } from "../core/workspaces.js";
import type {
  Looking,
  MaestroCopy,
  MaestroNote,
  OrchestratorActivity,
  OrchestratorCheck,
  OrchestratorProblem,
  OrchestratorStep,
  OrchestratorThreadSummary,
  OrchestratorTurn,
  OrchestratorView,
  StepIssue,
  StepPatch,
} from "../core/orchestrator.js";

import type { MergeResult } from "../core/sync/git-rescue.js";
import type { SyncMode } from "../core/sync/protocol.js";
import type { SyncConflict, SyncMachine, SyncOffer, SyncRequest, SyncShare, SyncView } from "../core/sync/types.js";
import type { LibraryItemView, LibraryView } from "../core/sync/library.js";

export type { LibraryItemView, LibraryView, MergeResult, SyncConflict, SyncMachine, SyncMode, SyncOffer, SyncRequest, SyncShare, SyncView };
export type {
  MaestroCopy,
  MaestroNote,
  OrchestratorActivity,
  OrchestratorCheck,
  OrchestratorProblem,
  OrchestratorStep,
  OrchestratorThreadSummary,
  OrchestratorTurn,
  OrchestratorView,
  StepIssue,
  StepPatch,
};
import type { ApplyResult, WorkingCopy } from "../core/worktrees.js";

export type { ApplyResult, WorkingCopy, BranchList };
import type { Deleted } from "../core/team-service.js";

export type { Deleted };

export type {
  Agent,
  AgentTier,
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
  ThemeChoice,
  ThemeList,
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
  TalkState,
  TaskStatus,
  TaskView,
  TermSize,
  WorkspaceSummary,
  Topic,
  UnreadableItem,
  LibraryKind,
  AgentTalkSettings,
  OrchestratorSettings,
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
export type { Workspace, RunOrigin, RunStatus, PaneLaunch, UnreadableFile } from "../core/types.js";

export interface AppInfo {
  version: string;
  configRoot: string;
  dataRoot: string;
  home: string;
  hostRunning: boolean;
  /** Why the terminal host isn't running, when it failed to start or kept crashing. */
  hostError: string | null;
  /** The Node and libuv the terminal host runs on (Electron's own), once it has started. */
  hostRuntime: { node: string; uv: string } | null;
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
  /** Errors nothing was there to handle, in the main process and the terminal host, since VibeForge started. */
  unexpectedErrors: number;
}

/**
 * Something the main process tells the person, said once. The page words it (app.notice.*): a
 * window that crashed and was reloaded, terminals cut off by the terminal host stopping, a host
 * that stopped answering, and errors nothing handled.
 */
export type DeskNotice =
  | { id: "window-reloaded"; reason: string }
  | { id: "host-stopped"; terminals: number; runIds: string[] }
  | { id: "host-stalled" }
  | { id: "host-answering" }
  | { id: "errors"; count: number };

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

/** Where a call with Viby is: waiting for you, hearing you, working out the words, waiting for Viby, or Viby talking. */
export type CallPhase = "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

/** A call with Viby: the microphone stays open, what you say goes to Viby, and the answer is read aloud. */
export interface CallState {
  on: boolean;
  phase: CallPhase;
  /** 0–1, for the meter, while it is listening. */
  level: number;
  /** What was last heard. */
  heard: string;
  /** What Viby last answered. */
  said: string;
  /** A plan waits for a spoken "go" or "cancel" (or its card's buttons). */
  waiting: boolean;
  /** Viby's answers can be read aloud here: talk-back is on and Piper, a voice and a player are all found. */
  spoken: boolean;
  /** Why the call ended, when it ended by itself (the microphone closed). */
  error: string | null;
  /** Talking while Viby speaks stops it: the speech detector is listening, and Viby can't hear itself (echo cancellation, or headphones as Settings say). */
  talkOver: boolean;
  /** Viby heard its own voice in this call and took it for the person's; talking over it is off until the call ends. */
  heardItself: boolean;
  /** The microphone is muted by the person while keeping the call open. */
  muted?: boolean;
  /** Words heard so far while the person is still speaking in this utterance. */
  liveHeard?: string;
  /** Epoch ms when Piper audio playback started for the current `speaking` turn. */
  speechStartedAt?: number;
  /** Known audio duration in ms for the current `speaking` turn once Piper finishes synthesizing. */
  speechDurationMs?: number;
}

export type DownloadKind = "model" | "voice" | "sherpa";

/** What dictation found on this machine. */
export interface VoiceStatus {
  /** The recorder's name ("pw-record"), or null when none was found. */
  recorder: string | null;
  server: string | null;
  cli: string | null;
  /** sherpa-onnx-offline path for ONNX models (Parakeet, Canary, Moonshine), or null when not installed yet. */
  sherpa?: string | null;
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
  /** Piper, for Viby's spoken replies; null when it isn't installed. */
  piper: string | null;
  /** The audio player's name ("pw-play"), or null. */
  player: string | null;
  /** A call listens for speech itself: the detector's model that comes with VibeForge can be read. */
  detector: boolean;
  /** PipeWire can be asked to cancel echo for a call: its recorder, `pipewire` and `pw-cli` are all here. */
  echoCancel: boolean;
  /** Every Piper voice found. */
  voices: string[];
  /** Viby's Piper voice. */
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
  /**
   * Requests since the page started that came through a tailnet name without Tailscale's sign-in
   * header: Tailscale Funnel (the page open to the internet), or a tagged device.
   */
  unsigned?: number;
}

/** How a phone reaches the phone page, as this computer's Tailscale tells it. */
export interface PhoneReach {
  /** Tailscale on this computer: not installed, installed but not connected, or connected. */
  tailscale: "missing" | "off" | "on";
  /** What this computer is called on the tailnet ("desktop.tail1234.ts.net"), once connected. */
  name: string | null;
  /** The https address a phone opens: where Tailscale Serve shares the page. Null until it does. */
  url: string | null;
  /** That address is open to the internet too (Tailscale Funnel), not only to your own devices. */
  funnel: boolean;
  /** The command that shares the page, to run once in a terminal. */
  command?: string;
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
  /** What the main process had to say while no page was listening (a window that crashed and came back); taking them marks the page as listening. */
  "app.notices": () => DeskNotice[];
  "app.palette": () => Palette;
  /** Every theme Settings can pin, and the desktop's own. */
  "app.themes": () => ThemeList;
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
  /** First raster image on the clipboard as a data URL, or null (used when DOM paste hides images on Wayland). */
  "app.clipboardImage": () => string | null;
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
  /** `always`: shown even with notifications off in Settings (a test, or the answer to a key just pressed); `silent`: no desktop sound. */
  "app.notify": (note: { title: string; body: string; workspaceId?: string | null; chatId?: string | null; agentId?: string | null; route?: unknown; always?: boolean; silent?: boolean }) => void;
  /** Omarchy's Do Not Disturb is on. */
  "app.doNotDisturb": () => boolean;
  /** Plays a chime through pw-play at `volume` (0 to 1). False when this machine can't, and the window plays it itself. */
  "app.chime": (name: Cue, volume: number) => boolean;
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
  /** settings.json, engines.json, workspaces.json or chats.json, there but not readable right now. */
  "files.unreadable": () => UnreadableFile[];
  /** Moves an unreadable file (one listed above) to `<name>.broken` and puts back its last good copy. */
  "files.restoreSaved": (file: string) => void;
  /** Whether the phone page is listening, and why not when it failed to bind. */
  "companion.status": () => CompanionStatus;
  /** Where a phone can open the page, asked of this computer's Tailscale. Nothing is changed. */
  "companion.reach": () => PhoneReach;
  "engines.list": () => Engine[];
  "engines.recheck": () => Engine[];
  "engines.save": (rows: EngineRow[]) => Engine[];

  "workspaces.list": () => WorkspaceFile;
  /** Git state and recent run timestamp per workspace id, for filtering and sorting the workspace list. */
  "workspaces.status": () => Record<string, WorkspaceSummary>;
  "workspaces.add": (folder: string) => WorkspaceFile;
  /** Takes a workspace out of VibeForge (its folder stays on disk), with Undo. Its terminals in Code stop. */
  "workspaces.remove": (id: string) => Deleted;
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

  /** The agent, skill, routine and task files the lists left out because they couldn't be read. */
  "library.unreadable": () => UnreadableItem[];
  "agents.list": () => Agent[];
  "agents.save": (input: AgentInput) => Agent;
  "agents.delete": (id: string) => Deleted;
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
  "tasks.discardCopy": (id: string) => Deleted;

  "chats.list": (filter?: { agentId?: string | null }) => ChatView[];
  "chats.create": (input: { agentId?: string | null; engine?: string; prompt?: string }) => ChatView;
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

  /** The Orchestrator's conversation, and whether its planning CLI is answering. */
  "orchestrator.get": () => OrchestratorView;
  /** Say something to the Orchestrator. Resolves once it has answered (the answer comes as a turn). */
  "orchestrator.ask": (text: string, images?: string[]) => void;
  /** Read a saved image attachment from a Viby turn as a data URL, or null if missing. */
  "orchestrator.imageData": (name: string) => string | null;
  /** Where the person is in the window now, for Viby: said whenever it changes. */
  "app.looking": (looking: Looking | null) => void;
  "orchestrator.stopThinking": () => void;
  /** The models a planning CLI offers (Claude Code's aliases, or what Grok Build and Antigravity list). */
  "orchestrator.models": (engineId: string) => string[];
  /** Start a new conversation (archiving non-empty turns to threads). */
  "orchestrator.clear": () => void;
  /** Switch to a saved Viby conversation thread. */
  "orchestrator.selectThread": (threadId: string) => void;
  /** Rename a Viby conversation thread. */
  "orchestrator.renameThread": (threadId: string, title: string) => void;
  /** Delete a saved Viby conversation thread (with Undo). */
  "orchestrator.deleteThread": (threadId: string) => Deleted;
  /** Read Viby's durable plain-text memory (~/.config/vibeforge/viby.md). */
  "orchestrator.readMemory": () => string;
  /** Save Viby's durable plain-text memory (~/.config/vibeforge/viby.md). */
  "orchestrator.writeMemory": (text: string) => void;
  /** Go: carry out a waiting plan. */
  "orchestrator.run": (turnId: string) => void;
  "orchestrator.cancel": (turnId: string) => void;
  "orchestrator.editStep": (turnId: string, stepId: string, patch: StepPatch) => void;
  "orchestrator.removeStep": (turnId: string, stepId: string) => void;
  /** A step's copy: its changes, Apply into the workspace it came from, or Discard (undone with undo.delete). */
  "orchestrator.copyDiff": (copyId: string) => string;
  "orchestrator.applyCopy": (copyId: string) => ApplyResult;
  "orchestrator.discardCopy": (copyId: string) => Deleted;

  /** Sync between machines: this machine, the paired ones, what is shared, offered and waiting for a choice. */
  "sync.view": () => SyncView;
  /** Fetches the pinned Syncthing into a copy that doesn't carry it (a git checkout). */
  "sync.install": () => void;
  /** Pairs with the machine whose code was pasted. */
  "sync.addMachine": (code: string) => void;
  "sync.acceptMachine": (id: string) => void;
  "sync.ignoreMachine": (id: string) => void;
  /** Unpairs: everything synced with it stops, the files stay. */
  "sync.removeMachine": (id: string) => void;
  "sync.share": (workspaceId: string, machineId: string, options: { mode: SyncMode; filesOnly: boolean }) => void;
  "sync.updateShare": (folderId: string, options: { mode: SyncMode; filesOnly: boolean }) => void;
  "sync.stopShare": (folderId: string) => void;
  /** Takes up a workspace another machine offered, in `folder`. */
  "sync.acceptOffer": (folderId: string, folder: string) => void;
  "sync.declineOffer": (folderId: string) => void;
  /** What putting this machine's version of a file back would change, as a diff. */
  "sync.conflictDiff": (id: string) => string;
  "sync.resolveConflict": (id: string, keep: "mine" | "theirs") => void;
  /** Merges the branch this machine's commits were kept on. */
  "sync.mergeConflict": (id: string) => MergeResult;
  /** Which saved agents and skills sync with the paired machines, and what each waits for here. */
  "sync.library": () => LibraryView;
  /** Turns syncing an agent (with its skills and memory) on or off, on every paired machine. */
  "sync.setAgent": (agentId: string, on: boolean) => void;
  "sync.setSkill": (skillId: string, on: boolean) => void;
  /** Uses `folder` here for one of a synced agent's folders that wasn't found on this machine. */
  "sync.placeFolder": (agentId: string, key: string, folder: string) => void;

  "voice.status": () => VoiceStatus;
  "voice.start": () => void;
  /** Stops recording and returns the words. `prompt` names things whisper should expect. */
  "voice.stop": (prompt?: string) => Dictation;
  "voice.cancel": () => void;
  "voice.download": (kind: DownloadKind, id: string) => void;
  "voice.stopDownload": () => void;
  /** Reads a sample phrase aloud in Viby's voice. */
  "voice.speak": (text: string) => void;
  "voice.silence": () => void;
  /** Appends the keybinding lines to the Hyprland config (after a backup); returns the file. */
  "voice.installBindings": () => string;

  "call.get": () => CallState;
  /** Opens the microphone and starts a call with Viby; what is heard goes to Viby without waiting for Enter. */
  "call.start": () => CallState;
  "call.stop": () => void;
  /** Mutes or unmutes the call's microphone without hanging up (toggles when omitted). */
  "call.mute": (muted?: boolean) => CallState;

  "pty.write": (ptyId: string, data: string) => void;
  "pty.send": (ptyId: string, text: string) => void;

  /** Send to…: a pane's last answer, selection or changes, left as a draft in another pane. False when there was nothing to send. */
  "talk.sendDraft": (fromPty: string, toPty: string, what: "reply" | "selection" | "changes", selection?: string) => { sent: boolean };
  /**
   * Review with…: once the author's turn ends, the reviewer reads its changes and the review goes
   * back to it. `changes` is false when the author hasn't changed anything yet: it waits for its next turn.
   */
  "talk.review": (authorPty: string, reviewerPty: string) => { changes: boolean };
  /** Stop messages to and from this terminal until a person types in it. */
  "talk.stop": (ptyId: string) => void;
  /** Start tasks this terminal's CLI handed out that wait for a person (all of them, or the ones named). */
  "talk.startTasks": (ptyId: string, taskIds: string[] | null) => { started: number; failed: string[] };
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

/** A workbench UI action triggered by Viby in Code: browser preview, side panel, or pane splits/zoom. */
export type CodeWorkbenchEvent =
  | { kind: "browser-open"; workspaceId: string; url: string }
  | { kind: "side"; workspaceId?: string; tab: "files" | "browser" | "close" }
  | { kind: "pane"; workspaceId?: string; action: "split-right" | "split-down" | "zoom" | "close" };

export interface DeskEvents {
  changed: Topic[];
  "pty-data": { ptyId: string; data: string; first: number; seq: number };
  "pty-exit": { ptyId: string; exitCode: number | null; signal: number | null };
  palette: Palette;
  "code-workbench": CodeWorkbenchEvent;
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
  notice: DeskNotice;
  voice: VoiceState;
  /** A call with Viby began, moved on or ended; many times a second while it listens, for the meter. */
  call: CallState;
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
