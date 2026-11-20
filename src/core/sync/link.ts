import path from "node:path";
import { readJson, writeFileAtomic } from "../fsx.js";
import { deviceId, isSyncMode, mirrorMode, type SyncMode } from "./protocol.js";
import type { ShareRecord, SyncState } from "./state.js";

// Two paired machines keep one small private folder between them, synced like any other. Each
// writes a single file there, named for itself, saying which workspaces it shares with the other,
// which it has stopped, and what is running in them right now. Reading the other machine's file is
// how an offer arrives, how a mode change or a stop is followed, and how "in use over there" is
// known. No extra port or protocol: Syncthing carries it, signed in as the paired machine.

export interface LinkShare {
  /** The workspace's name on the machine that wrote this. */
  name: string;
  /** How it syncs, seen from the machine that wrote this. */
  mode: SyncMode;
  filesOnly: boolean;
  /** Where the folder is under that machine's home ("Projects/site"), as a suggestion; "" when it is elsewhere. */
  hint: string;
  rev: number;
}

export interface LinkFile {
  v: 1;
  id: string;
  name: string;
  shares: Record<string, LinkShare>;
  /** Shares this machine ended or declined. */
  stopped: string[];
  /** Folder id → what is running in that workspace on this machine now. */
  live: Record<string, string[]>;
  /** This machine unpaired: its last word before the folder between the two goes. */
  gone?: boolean;
}

const FOLDER_ID = /^vf-ws-[0-9a-f]{6,32}$/;
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Only allow relative folder hints under home that never enter dot-directories (e.g. `.ssh`, `.config`). */
export function safeHint(hint: string): string {
  if (!hint || path.isAbsolute(hint)) return "";
  return hint.split("/").some((part) => !part || part.startsWith(".")) ? "" : hint;
}

/** A path under home as a hint for the other machine: "Projects/site". "" when it isn't under home. */
export function homeHint(folder: string, home: string): string {
  const relative = path.relative(home, folder);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return safeHint(relative.split(path.sep).join("/"));
}

/** What this machine tells `machineId`. */
export function buildLink(me: { id: string; name: string }, state: SyncState, machineId: string, live: Record<string, string[]>, home: string): LinkFile {
  const shares: Record<string, LinkShare> = {};
  const running: Record<string, string[]> = {};
  for (const share of state.shares.filter((item) => item.machineId === machineId)) {
    shares[share.folderId] = { name: share.name, mode: share.mode, filesOnly: share.filesOnly, hint: homeHint(share.path, home), rev: share.rev };
    if (live[share.folderId]?.length) running[share.folderId] = live[share.folderId].slice(0, 12);
  }
  const stopped = Object.entries(state.stopped)
    .filter(([, told]) => told === machineId)
    .map(([folderId]) => folderId)
    .sort();
  return { v: 1, id: me.id, name: me.name, shares, stopped, live: running };
}

/** The other machine's file, checked field by field: it comes from another computer. Null when it isn't there or isn't one. */
export function readLink(file: string, expectedId: string): LinkFile | null {
  const raw = readJson<Partial<LinkFile> | null>(file, null);
  if (!raw || typeof raw !== "object" || raw.v !== 1 || deviceId(text(raw.id, 80)) !== expectedId) return null;
  const shares: Record<string, LinkShare> = {};
  for (const [folderId, value] of Object.entries(raw.shares && typeof raw.shares === "object" ? raw.shares : {}).slice(0, 500)) {
    const row = value as Partial<LinkShare> | null;
    if (!FOLDER_ID.test(folderId) || !row || !isSyncMode(row.mode)) continue;
    const hint = text(row.hint, 1000);
    shares[folderId] = {
      name: text(row.name, 120) || "Workspace",
      mode: row.mode,
      filesOnly: row.filesOnly === true,
      // Only ever a suggestion under home: nothing that climbs out of it or lands in a dot-directory.
      hint: safeHint(hint),
      rev: typeof row.rev === "number" && Number.isFinite(row.rev) && row.rev >= 1 ? Math.floor(row.rev) : 1,
    };
  }
  const live: Record<string, string[]> = {};
  for (const [folderId, value] of Object.entries(raw.live && typeof raw.live === "object" ? raw.live : {})) {
    if (!shares[folderId] || !Array.isArray(value)) continue;
    live[folderId] = value.map((item) => text(item, 60)).filter(Boolean).slice(0, 12);
  }
  const stopped = (Array.isArray(raw.stopped) ? raw.stopped : []).filter((item): item is string => typeof item === "string" && FOLDER_ID.test(item)).slice(0, 2000);
  return { v: 1, id: expectedId, name: text(raw.name, 80), shares, stopped, live, ...(raw.gone === true ? { gone: true } : {}) };
}

/** Writes this machine's file when it says something new. True when it was written. */
export function writeLink(file: string, link: LinkFile): boolean {
  const next = `${JSON.stringify(link, null, 2)}\n`;
  if (JSON.stringify(readJson<unknown>(file, null)) === JSON.stringify(link)) return false;
  writeFileAtomic(file, next, { mode: 0o600 });
  return true;
}

export interface LinkOffer {
  folderId: string;
  name: string;
  /** Seen from this machine. */
  mode: SyncMode;
  filesOnly: boolean;
  hint: string;
}

export interface Settled {
  state: SyncState;
  changed: boolean;
  /** Workspaces the other machine shares that this one hasn't answered. */
  offers: LinkOffer[];
  /** Shares the other machine ended (or declined), now ended here too. */
  ended: ShareRecord[];
}

/**
 * Brings this machine's shares with `machineId` in line with what that machine's file says: a
 * share it ended ends here, a newer mode is taken over (mirrored), and what it shares that this
 * machine hasn't answered becomes an offer. `myId` breaks a tie when both changed at once.
 */
export function settleWithLink(state: SyncState, myId: string, machineId: string, link: LinkFile): Settled {
  const next: SyncState = structuredClone(state);
  let changed = false;
  const ended: ShareRecord[] = [];
  next.shares = next.shares.filter((share) => {
    if (share.machineId !== machineId || !link.stopped.includes(share.folderId)) return true;
    ended.push(share);
    changed = true;
    return false;
  });
  for (const share of next.shares) {
    if (share.machineId !== machineId) continue;
    const theirs = link.shares[share.folderId];
    if (!theirs) continue;
    const wanted = { mode: mirrorMode(theirs.mode), filesOnly: theirs.filesOnly };
    const same = wanted.mode === share.mode && wanted.filesOnly === share.filesOnly;
    if (theirs.rev > share.rev || (theirs.rev === share.rev && !same && machineId < myId)) {
      share.mode = wanted.mode;
      share.filesOnly = wanted.filesOnly;
      share.rev = theirs.rev;
      changed = true;
    }
  }
  // A stop this machine told the other about is done with once the other no longer lists the share.
  for (const [folderId, told] of Object.entries(next.stopped)) {
    if (told === machineId && !link.shares[folderId]) {
      delete next.stopped[folderId];
      changed = true;
    }
  }
  const offers: LinkOffer[] = [];
  for (const [folderId, theirs] of Object.entries(link.shares)) {
    if (next.shares.some((share) => share.folderId === folderId) || next.stopped[folderId] === machineId) continue;
    offers.push({ folderId, name: theirs.name, mode: mirrorMode(theirs.mode), filesOnly: theirs.filesOnly, hint: theirs.hint });
  }
  return { state: next, changed, offers, ended };
}
