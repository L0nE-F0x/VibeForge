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
  /** The bins still waiting for their Undo, so a new thing doesn't take a deleted one's place. */
  private readonly open = new Map<string, Bin>();

  constructor(private readonly root: string) {}

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
    fs.rmSync(this.root, { recursive: true, force: true });
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
        fs.mkdirSync(dir, { recursive: true });
        const to = path.join(dir, `${index}-${path.basename(from)}`);
        move(from, to);
        moved.push({ from, to });
      });
      if (settle !== undefined) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "settle.json"), `${JSON.stringify(settle)}\n`);
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
    fs.rmSync(path.join(this.root, bin.token), { recursive: true, force: true });
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
