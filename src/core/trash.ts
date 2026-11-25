import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { noteOwnDelete } from "./fsx.js";

/** A deleted thing's files, moved aside so Undo can put them back. */
export interface Bin {
  token: string;
  moved: Array<{ from: string; to: string }>;
}

/**
 * Where deleted things wait while their Undo is on screen. Deleting moves files here instead of
 * removing them, Undo moves them back, and the bin is emptied when the chance to undo has passed.
 * Emptying everything at start means a delete just before a crash stays deleted, as it was meant.
 *
 * A bin can hold a task's whole copy, node_modules and all: tens of thousands of files. Emptying
 * renames it out of the way at once and removes it in the background, so neither the window's
 * start nor a quit waits for it. What a quit cut short is removed at the next start.
 */
export class Trash {
  /** The bins still waiting for their Undo, so a new thing doesn't take a deleted one's place. */
  private readonly open = new Map<string, Bin>();
  /** The removals under way, one after another. */
  private removing: Promise<void> = Promise.resolve();
  private asides = 0;

  constructor(private readonly root: string) {}

  /** Resolves once everything emptied so far is off the disk. */
  whenEmptied(): Promise<void> {
    return this.removing;
  }

  /** Rename `dir` beside the trash, where nothing looks, and remove it in the background. */
  private discard(dir: string): void {
    this.asides += 1;
    const aside = `${this.root}.emptying-${process.pid}-${Date.now()}-${this.asides}`;
    try {
      fs.renameSync(dir, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Not renamable (another disk would be odd here): removed where it is, still in the background.
      this.later(dir);
      return;
    }
    this.later(aside);
  }

  private later(dir: string): void {
    this.removing = this.removing.then(() => fs.promises.rm(dir, { recursive: true, force: true })).catch(() => undefined);
  }

  /** What an earlier session renamed aside and didn't get to remove. */
  private sweep(): void {
    const parent = path.dirname(this.root);
    const prefix = `${path.basename(this.root)}.emptying-`;
    let names: string[] = [];
    try {
      names = fs.readdirSync(parent).filter((name) => name.startsWith(prefix));
    } catch {
      return;
    }
    for (const name of names) this.later(path.join(parent, name));
  }

  /** Whether `file` was moved into a bin that can still be undone. */
  holds(file: string): boolean {
    const wanted = path.resolve(file);
    for (const bin of this.open.values()) if (bin.moved.some((item) => path.resolve(item.from) === wanted)) return true;
    return false;
  }

  /** Remove every bin and return any settle notes left behind by crashed deletes. */
  empty(): unknown[] {
    const settled: unknown[] = [];
    try {
      for (const name of fs.readdirSync(this.root)) {
        try {
          settled.push(JSON.parse(fs.readFileSync(path.join(this.root, name, "settle.json"), "utf8")) as unknown);
        } catch {
          /* no settle note for this bin */
        }
      }
    } catch {
      /* trash empty */
    }
    this.sweep();
    this.discard(this.root);
    this.open.clear();
    return settled;
  }

  /** Move each existing path into a new bin. Paths that don't exist are skipped. */
  stash(paths: string[], settle?: unknown): Bin {
    const token = randomUUID();
    const dir = path.join(this.root, token);
    const moved: Bin["moved"] = [];
    try {
      paths.forEach((from, index) => {
        if (!fs.existsSync(from)) return;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        const to = path.join(dir, `${index}-${path.basename(from)}`);
        noteOwnDelete(from);
        move(from, to);
        moved.push({ from, to });
      });
      if (settle !== undefined) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        fs.writeFileSync(path.join(dir, "settle.json"), `${JSON.stringify(settle)}\n`, { mode: 0o600 });
      }
    } catch (error) {
      // Half a delete is worse than none: put back what moved, then report it.
      restoreMoves(moved);
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const bin = { token, moved };
    this.open.set(token, bin);
    return bin;
  }

  /** Put a bin's files back where they were, and say which went back. A path taken again in the meantime is left alone. */
  restore(bin: Bin): string[] {
    const restored = restoreMoves(bin.moved);
    this.drop(bin);
    return restored;
  }

  /** Delete a bin for good. */
  drop(bin: Bin): void {
    this.open.delete(bin.token);
    this.discard(path.join(this.root, bin.token));
  }
}

function restoreMoves(moved: Bin["moved"]): string[] {
  const restored: string[] = [];
  for (const { from, to } of [...moved].reverse()) {
    if (!fs.existsSync(to) || fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(from), { recursive: true });
    move(to, from);
    restored.push(from);
  }
  return restored;
}

/** Rename, or copy and remove when the two paths are on different disks. */
function move(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
