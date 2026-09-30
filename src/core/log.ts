import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

/**
 * VibeForge's own log: one line per event (continuation lines indented), kept under a size cap
 * by rotating to `<file>.1`. It records what the app did and what went wrong; never prompts,
 * command lines or terminal output.
 */
export class LogFile {
  constructor(
    readonly file: string,
    private readonly maxBytes = 1_000_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(level: LogLevel, message: string): void {
    const text = message.trim().replace(/\r?\n/g, "\n    ");
    const line = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, line);
    } catch {
      /* the log must never break the app */
    }
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  /** The last `count` lines, oldest first, reaching into the rotated file when needed. */
  tail(count: number): string[] {
    const read = (file: string) => {
      try {
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const lines = read(this.file);
    if (lines.length < count) lines.unshift(...read(`${this.file}.1`).slice(-(count - lines.length)));
    return lines.slice(-count);
  }
}

/** An error as one readable line, with a few stack frames when there are any. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1, 5)
    .map((frame) => frame.trim())
    .filter(Boolean);
  return frames.length ? `${error.message}\n${frames.join("\n")}` : error.message;
}

/**
 * Chromium reports this when a resize observer changes layout and the rest of its notifications
 * wait for the next frame. Nothing is lost, and xterm's own pixel-size observer triggers it
 * whenever a terminal is resized, so it is not worth a line in the log.
 */
const BENIGN_PAGE_ERRORS = [/^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/];

/**
 * Page errors for the log, with bursts folded: the same message again within `windowMs` is
 * counted instead of written, and the count lands on the next different message or when
 * `flush` runs. Known-benign browser notices are dropped.
 */
export class PageErrors {
  private last: { message: string; at: number; repeats: number } | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly windowMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  report(message: string): void {
    if (BENIGN_PAGE_ERRORS.some((pattern) => pattern.test(message))) return;
    const at = this.now();
    if (this.last && this.last.message === message && at - this.last.at < this.windowMs) {
      this.last.repeats += 1;
      this.last.at = at;
      return;
    }
    this.flush();
    this.last = { message, at, repeats: 0 };
    this.write(message);
  }

  /** Writes how many times the last message repeated, if it did. */
  flush(): void {
    if (this.last?.repeats) this.write(`${this.last.message} (repeated ${this.last.repeats} more time${this.last.repeats === 1 ? "" : "s"})`);
    if (this.last) this.last.repeats = 0;
  }
}
