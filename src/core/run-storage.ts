import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
import type { RunMeta } from "./types.js";

/**
 * Keeping run folders small. The raw terminal capture and the saved diff are most of a run's
 * size and compress well (a Claude session's scrollback shrinks about fifteen times), so a
 * finished run keeps them gzipped. Readers go through `readRunText` and never notice.
 */

/**
 * The files that are compressed once a run has ended (RUN_FILES.scrollback and .patch, named here
 * because runs.ts reads through this module). The rest are small or read all the time.
 */
export const COMPRESSED_FILES = ["scrollback.txt", "diff.patch"] as const;
/** Below this a file stays as it is: the header would cost more than it saves. */
const MIN_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A run file's text, from `name` or from `name.gz` when it was compressed. Empty when neither is there. */
export function readRunText(dir: string, name: string): string {
  const file = path.join(dir, name);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    /* compressed, or missing */
  }
  try {
    return gunzipSync(fs.readFileSync(`${file}.gz`)).toString("utf8");
  } catch {
    return "";
  }
}

/** Whether a run file exists, compressed or not. */
export function hasRunFile(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, `${name}.gz`));
}

/** Both names a run file can have on disk, for moving or deleting it. */
export function runFilePaths(dir: string, name: string): string[] {
  const file = path.join(dir, name);
  return [file, `${file}.gz`];
}

/**
 * Compress a finished run's big files, off the main thread's back (zlib works in the pool).
 * Returns the bytes saved. Safe to call again, and on a folder that is gone.
 */
export async function compressRun(dir: string): Promise<number> {
  let saved = 0;
  for (const name of COMPRESSED_FILES) {
    const file = path.join(dir, name);
    let size = 0;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      continue;
    }
    if (size < MIN_BYTES) continue;
    const gz = `${file}.gz`;
    const temp = `${gz}.${process.pid}.tmp`;
    try {
      const packed = await gzipAsync(await fs.promises.readFile(file), { level: 6 });
      await fs.promises.writeFile(temp, packed);
      await fs.promises.rename(temp, gz);
      await fs.promises.rm(file, { force: true });
      saved += size - packed.length;
    } catch {
      // Keep the plain file; a half-written .gz must not shadow it.
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return saved;
}

/** Bytes under a folder, following nothing outside it. Zero when it isn't there. */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return total;
}

export interface KeepRuns {
  /** Runs that ended longer ago than this are removed. 0 keeps them however old. */
  days: number;
  /** When all runs together take more than this, the oldest go first. 0 sets no limit. */
  maxMb: number;
}

export interface CleanupCandidate {
  run: RunMeta;
  bytes: number;
}

/**
 * Which runs to remove, oldest first. Never a running run, or one listed in `keep`: the review
 * inbox, and the latest run of each chat and task, which Continue reads.
 */
export function planCleanup(candidates: CleanupCandidate[], rule: KeepRuns, now: Date, keep: ReadonlySet<string>): CleanupCandidate[] {
  if (!rule.days && !rule.maxMb) return [];
  const removable = (item: CleanupCandidate) =>
    item.run.status !== "running" && !keep.has(item.run.id);
  const oldestFirst = [...candidates].sort((a, b) => (a.run.endedAt ?? a.run.startedAt).localeCompare(b.run.endedAt ?? b.run.startedAt));
  const chosen = new Set<CleanupCandidate>();
  if (rule.days > 0) {
    const cutoff = now.getTime() - rule.days * DAY_MS;
    for (const item of oldestFirst) {
      const ended = Date.parse(item.run.endedAt ?? item.run.startedAt);
      if (Number.isFinite(ended) && ended < cutoff && removable(item)) chosen.add(item);
    }
  }
  if (rule.maxMb > 0) {
    const limit = rule.maxMb * 1024 * 1024;
    let total = candidates.reduce((sum, item) => sum + (chosen.has(item) ? 0 : item.bytes), 0);
    for (const item of oldestFirst) {
      if (total <= limit) break;
      if (chosen.has(item) || !removable(item)) continue;
      chosen.add(item);
      total -= item.bytes;
    }
  }
  return oldestFirst.filter((item) => chosen.has(item));
}
