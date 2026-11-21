import path from "node:path";
import { isDirectory } from "../fsx.js";
import { safeHint } from "./link.js";

// An agent's allowed folders and its CLI, as one machine tells another, and how the other finds
// them again. Absolute paths never travel: a folder goes as the workspace it is in (the synced one's
// id, else its name), the folder inside it, and where it is under home; the CLI goes as its id, name
// and command, and only ever picks one of the CLIs already set up on the machine it arrives at.

export interface PortablePlace {
  /** Two machines' copies of the same place have the same key. */
  key: string;
  /** The workspace's name on the machine that first sent it; "" when the folder isn't in one. */
  workspace: string;
  /** The synced workspace it is in (`vf-ws-…`); "" when that workspace doesn't sync. */
  folderId: string;
  /** The folder inside that workspace ("" for the workspace itself), with "/". */
  sub: string;
  /** Where it is under home ("Projects/site"); "" when elsewhere. */
  hint: string;
}

export interface PlaceContext {
  home: string;
  workspaces: ReadonlyArray<{ name: string; path: string }>;
  /** This machine's synced workspaces. */
  shares: ReadonlyArray<{ folderId: string; path: string }>;
}

const FOLDER_ID = /^vf-ws-[0-9a-f]{6,32}$/;

const inside = (parent: string, child: string): string | null => {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
};

/** A relative folder inside a workspace: nothing that climbs out or goes through a dot-folder. */
export const safeSub = (sub: string): string => (sub === "" ? "" : safeHint(sub));

export function placeKey(place: Omit<PortablePlace, "key">): string {
  if (place.folderId) return `ws:${place.folderId}:${place.sub}`;
  if (place.workspace) return `name:${place.workspace.trim().toLowerCase()}:${place.sub}`;
  return `home:${place.hint}`;
}

/** How this machine tells another about a folder; null when it can't be told (outside every workspace and outside home). */
export function portablePlace(folder: string, context: PlaceContext): PortablePlace | null {
  const resolved = path.resolve(folder);
  const hintOf = (): string => {
    const relative = inside(context.home, resolved);
    return relative ? safeHint(relative) : "";
  };
  // The deepest workspace holding it: a folder in a workspace in another workspace belongs to the inner one.
  const deepest = <T extends { path: string }>(rows: readonly T[]): { row: T; sub: string } | null => {
    let best: { row: T; sub: string } | null = null;
    for (const row of rows) {
      const sub = inside(path.resolve(row.path), resolved);
      if (sub === null || safeSub(sub) !== sub) continue;
      if (!best || row.path.length > best.row.path.length) best = { row, sub };
    }
    return best;
  };
  const share = deepest(context.shares);
  const workspace = deepest(context.workspaces);
  const name = share ? (context.workspaces.find((item) => path.resolve(item.path) === path.resolve(share.row.path))?.name ?? workspace?.row.name ?? "") : (workspace?.row.name ?? "");
  const base = {
    workspace: name,
    folderId: share?.row.folderId ?? "",
    sub: share?.sub ?? workspace?.sub ?? "",
    hint: hintOf(),
  };
  if (!base.folderId && !base.workspace && !base.hint) return null;
  return { key: placeKey(base), ...base };
}

/** Where a place another machine sent is on this one; null when it isn't here (yet). */
export function resolvePlace(place: PortablePlace, context: PlaceContext): string | null {
  const join = (root: string): string | null => {
    const folder = place.sub ? path.join(root, ...place.sub.split("/")) : root;
    return isDirectory(folder) ? path.resolve(folder) : null;
  };
  if (place.folderId) {
    const share = context.shares.find((item) => item.folderId === place.folderId);
    if (share) {
      const found = join(share.path);
      if (found) return found;
    }
  }
  if (place.workspace) {
    const wanted = place.workspace.trim().toLowerCase();
    const named = context.workspaces.filter((item) => item.name.trim().toLowerCase() === wanted);
    // Two workspaces of that name: no telling which one was meant.
    if (named.length === 1) {
      const found = join(named[0].path);
      if (found) return found;
    }
  }
  if (place.hint) {
    const folder = path.join(context.home, ...place.hint.split("/"));
    if (isDirectory(folder)) return path.resolve(folder);
  }
  return null;
}

/** A place read from another machine's file, checked field by field; null when it isn't one. */
export function readPlace(value: unknown): PortablePlace | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  const folderId = text(row.folderId, 64);
  const place = {
    workspace: text(row.workspace, 120),
    folderId: FOLDER_ID.test(folderId) ? folderId : "",
    sub: safeSub(text(row.sub, 1000)),
    hint: safeHint(text(row.hint, 1000)),
  };
  if (!place.folderId && !place.workspace && !place.hint) return null;
  return { key: placeKey(place), ...place };
}

/** What a person reads for a place that isn't on this machine: "site", "site/docs" or "~/Projects/site". */
export function placeLabel(place: PortablePlace): string {
  if (place.workspace) return place.sub ? `${place.workspace}/${place.sub}` : place.workspace;
  return place.hint ? `~/${place.hint}` : place.sub;
}

// ------------------------------------------------------------------ the CLI

export interface PortableEngine {
  id: string;
  label: string;
  bin: string;
}

export interface LocalEngine extends PortableEngine {
  available: boolean;
}

export function readEngine(value: unknown): PortableEngine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => (typeof item === "string" ? item.trim().slice(0, max) : "");
  const id = text(row.id, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
  return { id, label: text(row.label, 80) || id, bin: path.basename(text(row.bin, 200)) };
}

/**
 * The CLI an agent uses on this machine: the one it asks for when it is installed here, else one
 * with the same command, else this machine's default, else the first installed one. When none is
 * installed it keeps the one it asks for, and its runs say that CLI is missing.
 */
export function pickEngine(wanted: PortableEngine, engines: readonly LocalEngine[], defaultEngine: string): string {
  const ready = engines.filter((engine) => engine.available);
  const byId = ready.find((engine) => engine.id === wanted.id);
  if (byId) return byId.id;
  const byBin = wanted.bin ? ready.find((engine) => path.basename(engine.bin) === wanted.bin) : undefined;
  if (byBin) return byBin.id;
  const fallback = ready.find((engine) => engine.id === defaultEngine) ?? ready[0];
  return fallback?.id ?? wanted.id;
}
