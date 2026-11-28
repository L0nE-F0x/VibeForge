import path from "node:path";
import { readJson, writeJson } from "./fsx.js";
import type { CutOff } from "./types.js";

// The runs VibeForge's last close cut off, kept in the data folder until each is picked back up
// or let go, so the next start can offer Continue for them (and after an update, do it).

export interface CutOffNote {
  reason: CutOff;
  /** When VibeForge closed (or, after a crash, when the next start found out). */
  at: string;
  runIds: string[];
  /** A start has offered these already. */
  offered?: boolean;
}

const FILE = "cut-off.json";

const REASONS: CutOff[] = ["quit", "update", "crash"];

export function readCutOff(dataRoot: string): CutOffNote | null {
  const note = readJson<Partial<CutOffNote> | null>(path.join(dataRoot, FILE), null);
  if (!note || !REASONS.includes(note.reason as CutOff) || !Array.isArray(note.runIds)) return null;
  const runIds = note.runIds.filter((id): id is string => typeof id === "string");
  return { reason: note.reason as CutOff, at: typeof note.at === "string" ? note.at : "", runIds, ...(note.offered === true ? { offered: true } : {}) };
}

export function writeCutOff(dataRoot: string, note: CutOffNote | null): void {
  writeJson(path.join(dataRoot, FILE), note ?? { reason: "quit", at: "", runIds: [] });
}

/** The note without `runIds` (picked back up, or let go). */
export function settleCutOff(note: CutOffNote | null, runIds: readonly string[]): CutOffNote | null {
  if (!note) return null;
  const drop = new Set(runIds);
  return { ...note, runIds: note.runIds.filter((id) => !drop.has(id)) };
}
