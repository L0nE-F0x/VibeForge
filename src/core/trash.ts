import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A deleted thing's files, moved aside so Undo can put them back. */
export interface Bin {
  token: string;
  moved: Array<{ from: string; to: string }>;
}

/**
 * Where deleted things wait while their Undo is on screen. Deleting moves files here instead of
 * removing them, Undo moves them back, and the bin is emptied when the chance to undo has passed.
 * Emptying everything at start means a delete just before a crash stays deleted, as it was meant.
 */
export class Trash {
  constructor(private readonly root: string) {}

  /** Remove every bin. Called at start and when the app closes. */
  empty(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Move each existing path into a new bin. Paths that don't exist are skipped. */
  stash(paths: string[]): Bin {
    const token = randomUUID();
    const dir = path.join(this.root, token);
    const moved: Bin["moved"] = [];
    try {
      paths.forEach((from, index) => {
        if (!fs.existsSync(from)) return;
        fs.mkdirSync(dir, { recursive: true });
        const to = path.join(dir, `${index}-${path.basename(from)}`);
        move(from, to);
        moved.push({ from, to });
      });
    } catch (error) {
      // Half a delete is worse than none: put back what moved, then report it.
      restoreMoves(moved);
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { token, moved };
  }

  /** Put a bin's files back where they were. A path taken again in the meantime is left alone. */
  restore(bin: Bin): void {
    restoreMoves(bin.moved);
    this.drop(bin);
  }

  /** Delete a bin for good. */
  drop(bin: Bin): void {
    fs.rmSync(path.join(this.root, bin.token), { recursive: true, force: true });
  }
}

function restoreMoves(moved: Bin["moved"]): void {
  for (const { from, to } of [...moved].reverse()) {
    if (!fs.existsSync(to) || fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(from), { recursive: true });
    move(to, from);
  }
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
