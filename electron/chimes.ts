import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeError } from "../src/core/log.js";
import { CUES, PEAK, SHAPES, cueLength, isCue, renderCue, wavBytes, type Cue } from "../src/shared/chimes.js";

// The window's chimes, played from here with PipeWire's pw-play, the way calls and dictation
// already play and record. Chromium's audio service starts on a page's first sound and never quits
// (Electron 45 has no idle exit for it), so the window only plays a chime itself when this says it
// can't: no pw-play on this machine, or it failed.

const RATE = 48_000;
/** Chimes closer together than this are one moment: the first one plays, as the window's own GAP_MS does for events. */
export const BURST_MS = 250;
/** pw-play's buffer: its default of 100 ms makes a chime start late. */
const LATENCY = "20ms";
/** A pw-play still running this long after its chime should have ended is stopped. */
const OVERRUN_MS = 5000;

type Spawn = (bin: string, args: string[]) => ChildProcess;

export interface ChimesOptions {
  /** Where the rendered chimes are kept (made owner-only). */
  dir: string;
  resolveBin: (bin: string) => string | null;
  log: { info(message: string): void; warn(message: string): void };
  spawn?: Spawn;
  now?: () => number;
}

/** The files' version: a change to any shape, the loudness or the rate gives new files. */
export function chimeVersion(): string {
  return createHash("sha256").update(JSON.stringify({ SHAPES, PEAK, RATE, format: 1 })).digest("hex").slice(0, 12);
}

export class Chimes {
  private bin: string | null | undefined;
  /** pw-play failed in a way the next chime would too (no PipeWire running): the window plays them. */
  private broken = false;
  private files: Record<Cue, string> | null = null;
  /** pw-play runs still going, and whether we stopped each one. */
  private readonly playing = new Set<{ child: ChildProcess; stopped: boolean }>();
  private lastAt = Number.NEGATIVE_INFINITY;
  private said = false;
  private readonly spawn: Spawn;
  private readonly now: () => number;

  constructor(private readonly opts: ChimesOptions) {
    this.spawn = opts.spawn ?? ((bin, args) => nodeSpawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] }));
    this.now = opts.now ?? Date.now;
  }

  /** Whether pw-play is there to use. */
  get available(): boolean {
    if (this.bin === undefined) this.bin = this.opts.resolveBin("pw-play");
    return Boolean(this.bin) && !this.broken;
  }

  /**
   * Plays a chime at `volume` (0 to 1). True once pw-play has started it, or when it is part of a
   * burst whose first chime is playing; false when the window should play it itself. A chime that
   * comes while an earlier one rings out plays beside it, as Web Audio mixed them: cutting the
   * earlier one short would click.
   */
  async play(name: unknown, volume: unknown): Promise<boolean> {
    if (!isCue(name) || !this.available) return false;
    const level = typeof volume === "number" && Number.isFinite(volume) ? Math.min(1, volume) : 0;
    if (level <= 0) return true;
    const now = this.now();
    if (now - this.lastAt < BURST_MS) return true;
    const file = this.fileFor(name);
    if (!file) return false;
    this.lastAt = now;
    return this.start(name, file, level);
  }

  /** Stops the chimes still playing, at quit. */
  dispose(): void {
    for (const entry of this.playing) this.stop(entry);
    this.playing.clear();
  }

  private stop(entry: { child: ChildProcess; stopped: boolean }): void {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
    entry.stopped = true;
    entry.child.kill("SIGTERM");
  }

  private start(name: Cue, file: string, level: number): Promise<boolean> {
    let child: ChildProcess;
    try {
      child = this.spawn(this.bin as string, ["--volume", level.toFixed(3), "--latency", LATENCY, "--media-role", "Notification", "-P", '{ application.name = "VibeForge" }', file]);
    } catch (error) {
      this.fail(`pw-play failed to start: ${describeError(error).split("\n")[0]}`);
      return Promise.resolve(false);
    }
    const entry = { child, stopped: false };
    this.playing.add(entry);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    const overrun = setTimeout(() => this.stop(entry), cueLength(name) * 1000 + OVERRUN_MS);
    overrun.unref?.();
    child.on("exit", (code, signal) => {
      clearTimeout(overrun);
      this.playing.delete(entry);
      // Stopped by us (quit, overrun) is fine, and pw-play then exits 1; otherwise PipeWire isn't there.
      if (code && !signal && !entry.stopped) this.fail(`pw-play exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    });
    return new Promise((resolve) => {
      child.once("spawn", () => {
        if (!this.said) {
          this.said = true;
          this.opts.log.info("Sounds: chimes play through pw-play");
        }
        resolve(true);
      });
      child.once("error", (error) => {
        this.playing.delete(entry);
        clearTimeout(overrun);
        this.fail(`pw-play failed to start: ${describeError(error).split("\n")[0]}`);
        resolve(false);
      });
    });
  }

  private fail(why: string): void {
    if (!this.broken) this.opts.log.warn(`Sounds: ${why}; the window plays chimes itself from now on`);
    this.broken = true;
  }

  /** The cue's WAV file, rendered on first use of any chime, or null when it can't be written. */
  private fileFor(name: Cue): string | null {
    if (!this.files) {
      try {
        this.files = this.render();
      } catch (error) {
        this.fail(`could not write the chimes to ${this.opts.dir}: ${describeError(error).split("\n")[0]}`);
        return null;
      }
    }
    return this.files[name];
  }

  private render(): Record<Cue, string> {
    const { dir } = this.opts;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const version = chimeVersion();
    const files = {} as Record<Cue, string>;
    for (const name of CUES) {
      const file = path.join(dir, `${name}-${version}.wav`);
      files[name] = file;
      const kept = fs.lstatSync(file, { throwIfNoEntry: false });
      // A file cut short (a crash while writing) or opened up to others is written again.
      if (kept?.isFile() && kept.size === 44 + 2 * Math.ceil(cueLength(name) * RATE) && (kept.mode & 0o077) === 0) continue;
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, wavBytes(renderCue(name, RATE), RATE), { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    // Chimes from an older version are no use to anyone.
    const wanted = new Set(Object.values(files).map((file) => path.basename(file)));
    for (const entry of fs.readdirSync(dir)) {
      if (!wanted.has(entry) && /\.wav(\.\d+\.tmp)?$/.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
    }
    return files;
  }
}
