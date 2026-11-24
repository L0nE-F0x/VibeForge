import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../fsx.js";
import { deviceId, hostPort, isSyncMode, type SyncMode } from "./protocol.js";

// What this machine has agreed to sync and with whom: `<data>/sync/state.json`. It is the wish; the
// desk makes the private Syncthing match it. It lives with the data, not the settings, because it
// names this machine's own folders and pairings and means nothing on another one.

export interface MachineRecord {
  id: string;
  name: string;
  /** `host:port` entries it can be reached at, besides being found on the local network. */
  addresses: string[];
}

export interface ShareRecord {
  folderId: string;
  /** The other machine. */
  machineId: string;
  /** The workspace's folder here. */
  path: string;
  /** The workspace's name when the share was made, for the other machine's offer. */
  name: string;
  mode: SyncMode;
  /** Leave `.git` out: each machine keeps its own history. */
  filesOnly: boolean;
  /** Counts up with every change to mode or filesOnly; the higher one wins between the two machines. */
  rev: number;
}

export interface SyncState {
  machines: MachineRecord[];
  shares: ShareRecord[];
  /** Shares this machine ended or declined: folder id → the machine told. Kept until that machine has dropped it too. */
  stopped: Record<string, string>;
  /** Pair requests answered with "not now", so they aren't asked again. */
  ignored: string[];
}

export const emptyState = (): SyncState => ({ machines: [], shares: [], stopped: {}, ignored: [] });

const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function normalizeState(raw: unknown): SyncState {
  const value = raw && typeof raw === "object" ? (raw as Partial<Record<keyof SyncState, unknown>>) : {};
  const machines: MachineRecord[] = [];
  for (const item of Array.isArray(value.machines) ? value.machines : []) {
    const id = deviceId(text((item as MachineRecord)?.id));
    if (!id || machines.some((machine) => machine.id === id)) continue;
    const addresses = (Array.isArray((item as MachineRecord).addresses) ? (item as MachineRecord).addresses : []).map((address) => hostPort(text(address))).filter((address): address is string => Boolean(address));
    machines.push({ id, name: text((item as MachineRecord).name, 80) || id.slice(0, 7), addresses: [...new Set(addresses)].slice(0, 8) });
  }
  const shares: ShareRecord[] = [];
  for (const item of Array.isArray(value.shares) ? value.shares : []) {
    const row = item as Partial<ShareRecord> | null;
    const folderId = text(row?.folderId, 64);
    const machineId = deviceId(text(row?.machineId));
    const folder = text(row?.path, 4096);
    if (!/^vf-ws-[0-9a-f]{6,32}$/.test(folderId) || !machineId || !path.isAbsolute(folder)) continue;
    if (!machines.some((machine) => machine.id === machineId) || shares.some((share) => share.folderId === folderId)) continue;
    shares.push({
      folderId,
      machineId,
      path: path.resolve(folder),
      name: text(row?.name, 120) || path.basename(folder),
      mode: isSyncMode(row?.mode) ? row.mode : "two",
      filesOnly: row?.filesOnly === true,
      rev: typeof row?.rev === "number" && Number.isFinite(row.rev) && row.rev >= 1 ? Math.floor(row.rev) : 1,
    });
  }
  const stopped: Record<string, string> = {};
  if (value.stopped && typeof value.stopped === "object") {
    for (const [folderId, machine] of Object.entries(value.stopped as Record<string, unknown>)) {
      const id = deviceId(text(machine));
      if (/^vf-ws-[0-9a-f]{6,32}$/.test(folderId) && id) stopped[folderId] = id;
    }
  }
  const ignored = (Array.isArray(value.ignored) ? value.ignored : []).map((item) => deviceId(text(item))).filter((id): id is string => Boolean(id));
  return { machines, shares, stopped, ignored: [...new Set(ignored)] };
}

export class SyncStateFile {
  private cached: SyncState | null = null;

  constructor(private readonly file: string) {}

  read(): SyncState {
    this.cached ??= normalizeState(readJson<unknown>(this.file, null));
    return this.cached;
  }

  write(next: SyncState): SyncState {
    const clean = normalizeState(next);
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    writeJson(this.file, clean, { mode: 0o600 });
    this.cached = clean;
    return clean;
  }

  /** Reads, changes and saves in one step. */
  update(change: (state: SyncState) => SyncState): SyncState {
    return this.write(change(structuredClone(this.read())));
  }
}
