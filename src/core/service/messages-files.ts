import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MESSAGE_INLINE_MAX } from "../agent-talk.js";
import { writeFileAtomic } from "../fsx.js";
import type { ServiceCore } from "./core.js";

/** Saved messages and patches stay this long: a CLI handed a path may read it a good while later. */
const KEEP_FILES_MS = 3 * 24 * 60 * 60 * 1000;

/** Messages, reviews and patches saved in the data folder, for a CLI to read by their path. */
export class SavedFiles {
  constructor(
    private readonly core: ServiceCore,
    /** The texts of messages still in line or still being answered: a file one names is kept. */
    private readonly inUse: () => string[],
  ) {}

  /** A long text goes in a file: a CLI reads a path more reliably than a paste of many screens. */
  saveIfLong(folder: string, text: string): string | null {
    return text.length > MESSAGE_INLINE_MAX ? this.saveFile(folder, "md", text) : null;
  }

  saveFile(folder: string, ext: string, text: string): string {
    const dir = path.join(this.core.options.dataRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = this.core.now().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
    writeFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
    this.tidy(dir);
    return file;
  }

  /** Old saved files go, but never one a message still in line, or one still being answered, points at. */
  private tidy(dir: string): void {
    try {
      const cutoff = this.core.now().getTime() - KEEP_FILES_MS;
      const named = this.inUse().join("\n");
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (savedAt(name, file) >= cutoff || named.includes(file)) continue;
        fs.rmSync(file, { force: true });
      }
    } catch {
      /* tidying is best effort */
    }
  }
}

/** When a saved file was written: the time its name starts with (see saveFile), else its own. */
function savedAt(name: string, file: string): number {
  const stamp = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z-/.exec(name);
  const at = stamp ? Date.parse(`${stamp[1]}:${stamp[2]}:${stamp[3]}.${stamp[4]}Z`) : Number.NaN;
  if (Number.isFinite(at)) return at;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
