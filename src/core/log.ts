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
