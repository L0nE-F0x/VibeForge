import fs from "node:fs";
import path from "node:path";

export interface WriteOptions {
  /** File mode (defaults to `0o600` for VibeForge-owned files). Replaces an existing file's mode too. */
  mode?: number;
}

const ownWriteStamps = new Map<string, string>();
const ownDeletes = new Map<string, number>();

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 256) map.delete(map.keys().next().value as string);
}

/** Exact stat stamp for a regular file, or null when missing / not a file. */
export function fileStampKey(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
  } catch {
    return null;
  }
}

/** Record that VibeForge itself removed or stashed `file` so config watchers skip the matching delete event. */
export function noteOwnDelete(file: string): void {
  const full = path.resolve(file);
  ownWriteStamps.delete(full);
  rememberBounded(ownDeletes, full, Date.now());
}

/** Whether `file` on disk still holds the exact stat stamp of VibeForge's own atomic write (or a recent own delete). */
export function isUnchangedOwnWrite(file: string): boolean {
  const full = path.resolve(file);
  const stamp = fileStampKey(full);
  if (stamp !== null) return ownWriteStamps.get(full) === stamp;
  const now = Date.now();
  const direct = ownDeletes.get(full);
  if (direct !== undefined && now - direct < 1000) return true;
  const parent = ownDeletes.get(path.dirname(full));
  return parent !== undefined && now - parent < 1000;
}

/**
 * Write through a temp file and rename, so a crash never leaves half a file behind. The temp file
 * reaches the disk before it takes the name, and the folder after, so a power cut leaves the old
 * file or the new one, never an empty one (about 10 ms on this machine's btrfs). A write that fails
 * (a full disk) removes its temp file and leaves the old file as it was.
 */
export function writeFileAtomic(file: string, text: string, options: WriteOptions = {}): void {
  const mode = options.mode ?? 0o600;
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true });
  const temp = path.join(folder, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(temp, "w", mode);
    try {
      fs.writeFileSync(fd, text);
      // The umask, or a temp file left by a crash, would otherwise decide.
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  syncFolder(folder);
  const full = path.resolve(file);
  ownDeletes.delete(full);
  const stamp = fileStampKey(full);
  if (stamp) rememberBounded(ownWriteStamps, full, stamp);
}

/** A rename is on disk once its folder is. A folder that can't be opened for this (some file systems) is left to the system. */
function syncFolder(folder: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(folder, "r");
    fs.fsyncSync(fd);
  } catch {
    /* best effort: the file itself is on disk */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file. One that is there and doesn't parse (a hand edit half done) is moved aside to
 * `<name>.broken` first, so saving from the app never loses what its author wrote.
 */
export function writeJson(file: string, value: unknown, options: WriteOptions = {}): void {
  setAsideBroken(file, options);
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

function setAsideBroken(file: string, options: WriteOptions): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!text.trim()) return;
  try {
    JSON.parse(text);
  } catch {
    moveAside(file, options.mode);
  }
}

/**
 * Move `file` to `<name>.broken` (or `<name>.broken-<time>` when one is already there, so an
 * earlier one is kept), owner-only unless `mode` says otherwise. Returns where it went.
 */
export function moveAside(file: string, mode = 0o600): string {
  const aside = fs.existsSync(`${file}.broken`) ? `${file}.broken-${Date.now()}` : `${file}.broken`;
  noteOwnDelete(file);
  fs.renameSync(file, aside);
  fs.chmodSync(aside, mode);
  return aside;
}

export function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
