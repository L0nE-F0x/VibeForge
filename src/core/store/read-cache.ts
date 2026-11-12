import fs from "node:fs";

/**
 * How long after a change a file is still parsed on every read. A second change within the same
 * tick of the file system's clock, at the same size, could keep the first one's stamp.
 */
const SETTLE_MS = 2000;

/** What identifies a file's contents without reading them; null when there is no such file. */
function fileStamp(file: string): { key: string; settled: boolean } | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { key: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, settled: Date.now() - stat.mtimeMs > SETTLE_MS };
  } catch {
    return null;
  }
}

/**
 * Settings, engines, workspaces, agents, routines, tasks and chats as last parsed, kept while their
 * file is unchanged on disk. The
 * services read them hundreds of times a refresh, and a stat costs far less than parsing again.
 * These are files people edit by hand, so the stamp (inode, size, modify and change times) is
 * checked on every read, and the store's own writes drop the entry at once. Every read gets its
 * own copy, so a caller changing what it got can't change what the next one sees.
 */
export class ReadCache {
  private readonly entries = new Map<string, { key: string; value: unknown }>();

  read<T>(file: string, load: () => T): T {
    const stamp = fileStamp(file);
    const hit = this.entries.get(file);
    if (stamp && hit?.key === stamp.key) return structuredClone(hit.value) as T;
    const value = load();
    if (stamp?.settled) this.entries.set(file, { key: stamp.key, value: structuredClone(value) });
    else this.entries.delete(file);
    return value;
  }

  forget(file: string): void {
    this.entries.delete(file);
  }
}
