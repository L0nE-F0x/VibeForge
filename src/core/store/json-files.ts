import fs from "node:fs";
import path from "node:path";
import { moveAside, writeFileAtomic } from "../fsx.js";
import type { UnreadableFile } from "../types.js";

// settings.json, engines.json, workspaces.json and chats.json are read again whenever they change
// on disk, and a CLI or an editor writing one in place leaves a moment when it is cut short. A read
// that fails then must not turn into defaults: that stopped Sync and closed the phone page until the
// next change, and the next save wrote defaults over the file. So each read that works is kept (in
// memory, and on disk as `<name>.saved`), a read that fails serves that instead and is listed for the
// window, and nothing is saved over a file that can't be read until the person chooses.

/** Said of a file that is there but empty: what a write in place leaves for a moment. */
export const EMPTY_FILE = "The file is empty.";
/** Said of a file that parses but holds no object or list (`null`, a number, a string). */
export const NOT_A_LIST = "It doesn't hold a JSON object or list.";

export type JsonRead =
  /** It parsed. */
  | { state: "ok"; value: unknown }
  /** It isn't there. `saved` is what it held when last read this session, if it was read. */
  | { state: "missing"; saved: unknown }
  /** It is there and can't be read. `saved` is what it held when it last read correctly, or null. */
  | { state: "unreadable"; error: string; saved: unknown };

const SAVED_SUFFIX = ".saved";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parse(text: string): unknown {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads and writes the JSON files that must never fall back to defaults; one per Store. */
export class JsonFiles {
  /** Per file: the text it held when it last read correctly. */
  private readonly good = new Map<string, string>();
  /** Per file: the text `<name>.saved` holds, as this process last wrote or read it. */
  private readonly savedOnDisk = new Map<string, string | null>();
  private readonly problems = new Map<string, UnreadableFile>();
  private readonly listeners = new Set<() => void>();

  read(file: string): JsonRead {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.clear(file);
        const kept = this.good.get(file);
        return { state: "missing", saved: kept === undefined ? undefined : parse(kept) };
      }
      return this.fail(file, errorText(error));
    }
    if (!text.trim()) return this.fail(file, EMPTY_FILE);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      return this.fail(file, errorText(error));
    }
    if (!value || typeof value !== "object") return this.fail(file, NOT_A_LIST);
    this.keep(file, text);
    this.clear(file);
    return { state: "ok", value };
  }

  /**
   * What is in `file` before VibeForge saves over it: its parsed value, or null when there is no
   * such file. Throws when it is there and can't be read, so a save never replaces what someone
   * wrote by hand, and never sets it aside without being asked.
   */
  beforeWrite(file: string): unknown {
    const read = this.read(file);
    if (read.state === "unreadable") throw new Error(`${path.basename(file)} can't be read (${read.error}), so nothing was saved over it.`);
    return read.state === "ok" ? read.value : null;
  }

  /** Save `value` to `file` (after `beforeWrite`), and keep it as the last copy that read correctly. */
  write(file: string, value: unknown, mode = 0o600): void {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileAtomic(file, text, { mode });
    this.keep(file, text);
    this.clear(file);
  }

  /** The files that can't be read right now. */
  list(): UnreadableFile[] {
    return [...this.problems.values()].map((problem) => ({ ...problem }));
  }

  private fail(file: string, error: string): JsonRead {
    const saved = this.lastGood(file);
    const problem: UnreadableFile = { file, name: path.basename(file), error, saved: saved !== undefined };
    const before = this.problems.get(file);
    this.problems.set(file, problem);
    if (!before || before.error !== problem.error || before.saved !== problem.saved) this.changed();
    return { state: "unreadable", error, saved };
  }

  /**
   * The person chose to put the saved copy back: the file that can't be read moves to
   * `<name>.broken`, and the copy from the last read that worked takes its place. With no such copy
   * the file is only moved aside, and VibeForge starts it again as it would a missing one. False
   * when the file reads correctly by now, so nothing was moved.
   */
  restoreSaved(file: string): boolean {
    if (!this.problems.has(file)) return false;
    if (this.read(file).state !== "unreadable") return false;
    const text = this.good.get(file);
    if (fs.existsSync(file)) moveAside(file);
    if (text !== undefined) {
      writeFileAtomic(file, text);
      this.keep(file, text);
    }
    this.clear(file);
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener failing must not break a read */
      }
    }
  }

  private clear(file: string): void {
    if (this.problems.delete(file)) this.changed();
  }

  /** The parsed value of the last copy that read correctly: this session's, else `<name>.saved`. */
  private lastGood(file: string): unknown {
    const kept = this.good.get(file);
    if (kept !== undefined) return parse(kept);
    const text = this.readSaved(file);
    const value = text === null ? undefined : parse(text);
    if (text !== null && value !== undefined) this.good.set(file, text);
    return value;
  }

  private readSaved(file: string): string | null {
    if (this.savedOnDisk.has(file)) return this.savedOnDisk.get(file) ?? null;
    let text: string | null;
    try {
      text = fs.readFileSync(`${file}${SAVED_SUFFIX}`, "utf8");
    } catch {
      text = null;
    }
    this.savedOnDisk.set(file, text);
    return text;
  }

  /** Remember `text` as the last that read correctly, and keep `<name>.saved` the same when it differs. */
  private keep(file: string, text: string): void {
    this.good.set(file, text);
    if (this.readSaved(file) === text) return;
    try {
      writeFileAtomic(`${file}${SAVED_SUFFIX}`, text);
      this.savedOnDisk.set(file, text);
    } catch {
      /* a full disk: the copy in memory still serves this session */
    }
  }
}
