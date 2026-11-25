import type { SoundSettings } from "../shared/api.js";
import { call } from "./api.js";

// Short tones, made here with Web Audio rather than shipped as files: one warm family, each
// with its own shape, so you can tell them apart without looking. Voice cues answer your own
// key and always play (when on). The rest are events: by default only while VibeForge is in the
// background, and never while Omarchy's Do Not Disturb is on.

export type Cue = "voiceStart" | "voiceStop" | "voiceCancel" | "attention" | "finished" | "failed" | "routine";

const GROUP: Record<Cue, "voice" | "attention" | "finished" | "routines"> = {
  voiceStart: "voice",
  voiceStop: "voice",
  voiceCancel: "voice",
  attention: "attention",
  finished: "finished",
  failed: "finished",
  routine: "routines",
};

interface Note {
  /** Hz at the start, and optionally where it glides to. */
  freq: number;
  to?: number;
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds until it has faded out. */
  length: number;
  wave?: OscillatorType;
  /** Relative loudness, 0 to 1. */
  level?: number;
}

const SHAPES: Record<Cue, Note[]> = {
  // Rising two notes: listening.
  voiceStart: [
    { freq: 659, at: 0, length: 0.09 },
    { freq: 988, at: 0.07, length: 0.14 },
  ],
  // Falling two notes: the words are in.
  voiceStop: [
    { freq: 988, at: 0, length: 0.09 },
    { freq: 659, at: 0.07, length: 0.16 },
  ],
  // One low, dull tick: nothing kept.
  voiceCancel: [{ freq: 294, to: 247, at: 0, length: 0.12, wave: "triangle", level: 0.8 }],
  // Two soft knocks: your turn. The one sound meant to be noticed.
  attention: [
    { freq: 784, to: 523, at: 0, length: 0.16, wave: "triangle" },
    { freq: 784, to: 523, at: 0.2, length: 0.22, wave: "triangle" },
  ],
  // A warm rising chord, the last note ringing: done.
  finished: [
    { freq: 523, at: 0, length: 0.22, level: 0.8 },
    { freq: 659, at: 0.08, length: 0.24, level: 0.8 },
    { freq: 784, at: 0.16, length: 0.5 },
  ],
  // Lower and falling, never harsh: it stopped or failed.
  failed: [
    { freq: 440, at: 0, length: 0.2, wave: "triangle" },
    { freq: 349, at: 0.16, length: 0.36, wave: "triangle" },
  ],
  // A faint single tick: a routine started.
  routine: [{ freq: 1319, at: 0, length: 0.07, level: 0.45 }],
};

const PEAK = 0.22;
/** Event sounds closer together than this are one moment; the first one plays. */
const GAP_MS = 700;

/** After the last sound ends the output is closed this long later. */
export const CLOSE_AFTER_MS = 30_000;

let settings: SoundSettings | null = null;
let lastEvent = 0;
let quiet: { value: boolean; at: number } | null = null;

/** The shell keeps this current from Settings. */
export function setSoundSettings(next: SoundSettings | undefined): void {
  settings = next ?? null;
}

/** How long a sound waits for the output to start before its time is counted anyway. */
const START_WAIT_MS = 3000;

type Timers = { set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (timer: ReturnType<typeof setTimeout>) => void };

/**
 * The audio output, open only while it is needed. A chime opens it (or resumes it); when the last
 * chime has ended it is suspended at once, and closed after CLOSE_AFTER_MS without another, so no
 * playback stream sits open playing silence between sounds. The next chime makes a new one.
 * (Chromium's audio service process stays once started either way: Electron 45 has no idle quit
 * for it.) Tests hand in their own context and timers.
 */
export class SoundOutput {
  private context: AudioContext | null = null;
  /** Until the output is running again: a sound's length is counted from then. */
  private ready: Promise<void> | null = null;
  /** A suspend was asked for; its state may still read "running" until it lands. */
  private suspending = false;
  private playing = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly make: () => AudioContext = () => new AudioContext(),
    private readonly timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) },
  ) {}

  /** The context to schedule a sound on, or null if there's no audio output at all. */
  open(): AudioContext | null {
    if (this.closeTimer) {
      this.timers.clear(this.closeTimer);
      this.closeTimer = null;
    }
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = this.make();
        this.suspending = false;
      }
      // Notes are timed on the context's own clock, which stands still while it is suspended, so a
      // sound scheduled now starts as soon as the output runs: nothing is cut off.
      if (this.suspending || this.context.state !== "running") {
        this.suspending = false;
        this.ready = this.context.resume().catch(() => undefined);
      } else this.ready = null;
      return this.context;
    } catch {
      this.context = null;
      return null;
    }
  }

  /** A sound was scheduled on the context `open` gave: `ms` after the output runs it has ended, and `done` runs. */
  started(ms: number, done: () => void = () => undefined): void {
    this.playing += 1;
    let counted = false;
    const count = () => {
      if (counted) return;
      counted = true;
      this.timers.set(() => {
        done();
        this.ended();
      }, ms);
    };
    if (!this.ready) {
      count();
      return;
    }
    void this.ready.then(count);
    this.timers.set(count, START_WAIT_MS);
  }

  /** Whether an output is open now (running or suspended). */
  get isOpen(): boolean {
    return this.context !== null;
  }

  private ended(): void {
    this.playing = Math.max(0, this.playing - 1);
    if (this.playing || !this.context) return;
    this.suspending = true;
    void this.context.suspend().catch(() => undefined);
    this.closeTimer = this.timers.set(() => this.close(), CLOSE_AFTER_MS);
  }

  private close(): void {
    this.closeTimer = null;
    if (this.playing || !this.context) return;
    const gone = this.context;
    this.context = null;
    this.ready = null;
    void gone.close().catch(() => undefined);
  }
}

const output = new SoundOutput();

function play(shape: Note[], volume: number): void {
  if (volume <= 0) return;
  const ctx = output.open();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.value = PEAK * volume;
  master.connect(ctx.destination);
  let end = start;
  for (const note of shape) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = start + note.at;
    const t1 = t0 + note.length;
    osc.type = note.wave ?? "sine";
    osc.frequency.setValueAtTime(note.freq, t0);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, t0 + note.length * 0.6);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(note.level ?? 1, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t1 + 0.02);
    end = Math.max(end, t1);
  }
  output.started((end - ctx.currentTime + 0.2) * 1000, () => master.disconnect());
}

/** Omarchy's Do Not Disturb, asked at most every few seconds. */
async function doNotDisturb(): Promise<boolean> {
  const now = Date.now();
  if (quiet && now - quiet.at < 3000) return quiet.value;
  const value = await call("app.doNotDisturb").catch(() => false);
  quiet = { value, at: now };
  return value;
}

/** Play a cue if Settings allow it now. */
export function cue(name: Cue): void {
  const current = settings;
  if (!current?.on || !current[GROUP[name]]) return;
  if (GROUP[name] === "voice") {
    play(SHAPES[name], current.volume);
    return;
  }
  if (!current.inFront && document.hasFocus()) return;
  const now = Date.now();
  if (now - lastEvent < GAP_MS) return;
  lastEvent = now;
  void doNotDisturb().then((dnd) => {
    if (!dnd) play(SHAPES[name], current.volume);
  });
}

/** Play a cue whatever the switches say, for Settings' preview buttons. */
export function previewCue(name: Cue, volume = settings?.volume ?? 0.6): void {
  play(SHAPES[name], volume);
}

export const CUES: Cue[] = ["voiceStart", "voiceStop", "voiceCancel", "attention", "finished", "failed", "routine"];
