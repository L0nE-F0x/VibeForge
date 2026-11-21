import type { SyncMode } from "./protocol.js";

// What the window is shown about sync, and what the desk asks of the engine underneath. The engine
// is VibeForge's private Syncthing (electron/sync-engine.ts); tests stand one in.

export type { SyncMode };

// ------------------------------------------------------------------ the engine

export interface EngineDevice {
  id: string;
  name: string;
  /** `dynamic` (found on the local network) and `tcp://host:port` entries. */
  addresses: string[];
}

export interface EngineFolder {
  id: string;
  label: string;
  path: string;
  type: "sendreceive" | "sendonly" | "receiveonly";
  /** The other machines it is shared with (never this one). */
  devices: string[];
  /** Seconds a change waits before it is sent, so a burst of writes goes as one. */
  watchDelay: number;
}

export interface EngineFolderStatus {
  /** Syncthing's word: idle, scanning, syncing, sync-preparing, error… */
  state: string;
  /** Files and folders still to come from the other machine. */
  need: number;
  /** Files Syncthing could not write. */
  errors: number;
  /** Changes made on a receive-only side that the other machine doesn't have. */
  localChanges: number;
}

/** One thing the engine says happened. Only the kinds the desk acts on. */
export type EngineEvent =
  | { type: "connected" | "disconnected"; device: string }
  | { type: "pending-devices" }
  | { type: "folder-state"; folder: string; state: string }
  | { type: "item-finished"; folder: string; item: string; action: string; error: string | null }
  | { type: "folder-summary"; folder: string }
  | { type: "config" };

export interface SyncEngine {
  /** This machine's device id. */
  readonly id: string;
  setName(name: string): Promise<void>;
  devices(): Promise<EngineDevice[]>;
  putDevice(device: EngineDevice): Promise<void>;
  removeDevice(id: string): Promise<void>;
  /** Machines that tried to connect and aren't known here. */
  pendingDevices(): Promise<Array<{ id: string; name: string; address: string }>>;
  dismissPendingDevice(id: string): Promise<void>;
  folders(): Promise<EngineFolder[]>;
  putFolder(folder: EngineFolder): Promise<void>;
  removeFolder(id: string): Promise<void>;
  /** Device id → connected now, and when it was last seen (ISO; "" for never). */
  connections(): Promise<Record<string, { connected: boolean; address: string; lastSeen: string }>>;
  folderStatus(id: string): Promise<EngineFolderStatus | null>;
  /** Look at a folder again now (a path inside it, or all of it). */
  scan(folder: string, sub?: string): Promise<void>;
  /** Drop a receive-only side's own changes. */
  revert(folder: string): Promise<void>;
}

// ------------------------------------------------------------------ what the window is shown

export interface SyncMachine {
  id: string;
  name: string;
  connected: boolean;
  /** ISO; "" when it has never connected. */
  lastSeen: string;
}

/** Another machine that asked to pair and waits for a yes here. */
export interface SyncRequest {
  id: string;
  name: string;
  address: string;
}

/** A workspace another machine wants to sync here; it waits for a folder and a yes. */
export interface SyncOffer {
  folderId: string;
  machineId: string;
  machineName: string;
  /** The workspace's name over there. */
  name: string;
  /** How it would sync, seen from here. */
  mode: SyncMode;
  filesOnly: boolean;
  /** Where it would go here unless another folder is picked. */
  suggestedPath: string;
  /** That folder is there already and has files in it. */
  suggestedHasFiles: boolean;
}

export type ShareState =
  /** The other machine hasn't said yes yet. */
  | "offered"
  /** The other machine is off or out of reach. */
  | "away"
  | "syncing"
  | "synced"
  /** The folder is gone, or Syncthing can't write to it. */
  | "error";

export interface SyncShare {
  folderId: string;
  /** The workspace whose folder this is; null when the folder is no longer a workspace. */
  workspaceId: string | null;
  path: string;
  machineId: string;
  machineName: string;
  mode: SyncMode;
  filesOnly: boolean;
  state: ShareState;
  /** Files still to arrive here. */
  need: number;
  /** What is running in this workspace on the other machine now ("Claude Code", "Shell"). */
  peerLive: string[];
  /** Files that changed on both machines and wait for a choice here. */
  conflicts: number;
}

export interface SyncConflict {
  id: string;
  folderId: string;
  workspaceId: string | null;
  /** "file": a file both machines changed. "commits": both machines committed on one branch. "agent" / "skill": a synced agent's or skill's text changed on both. */
  kind: "file" | "commits" | "agent" | "skill";
  /** The file, relative to the workspace; for commits, the branch; for an agent or skill, its name. */
  path: string;
  /** For an agent or skill: which text changed on both ("memory", "brief" or "body"), and its id here. */
  section: "memory" | "brief" | "body" | null;
  itemId: string | null;
  /** For commits: the branch this machine's commits were kept on. */
  savedBranch: string | null;
  /** The machine whose version is in the workspace now. */
  machineName: string;
  at: string;
}

export interface SyncView {
  /** The Syncthing binary is in this copy of VibeForge. */
  available: boolean;
  enabled: boolean;
  running: boolean;
  /** Why it isn't running although it is on. */
  error: string | null;
  /** This machine: its name, id and the pairing code to paste on the other one. */
  me: { id: string; name: string; code: string } | null;
  machines: SyncMachine[];
  requests: SyncRequest[];
  offers: SyncOffer[];
  shares: SyncShare[];
  conflicts: SyncConflict[];
  /** The Syncthing release this copy carries, for Settings. */
  engineVersion: string;
  /** A command to run once so the firewall here lets paired machines in; null when none is needed. */
  firewall: string | null;
}

export const EMPTY_SYNC_VIEW: SyncView = {
  available: false,
  enabled: false,
  running: false,
  error: null,
  me: null,
  machines: [],
  requests: [],
  offers: [],
  shares: [],
  conflicts: [],
  engineVersion: "",
  firewall: null,
};
