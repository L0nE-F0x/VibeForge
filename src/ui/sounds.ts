import type { SoundSettings } from "../shared/api.js";
import { PEAK, SHAPES, type Cue, type Note } from "../shared/chimes.js";
import { call } from "./api.js";

// Short tones (src/shared/chimes.ts). The main process plays them through PipeWire's pw-play when
// it can, so Chromium's audio service never starts for a chime; otherwise they're made here with
// Web Audio. Voice cues answer your own key and always play (when on). The rest are events: by
// default only while VibeForge is in the background, and never while Omarchy's Do Not Disturb is on.

export type { Cue } from "../shared/chimes.js";

const GROUP: Record<Cue, "voice" | "attention" | "finished" | "routines"> = {
  voiceStart: "voice",
  voiceStop: "voice",
  voiceCancel: "voice",
  attention: "attention",
  finished: "finished",
  failed: "finished",
  routine: "routines",
};

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

/** Whether the main process plays chimes: unknown until the first one asks, false once it said it can't. */
let mainPlays: boolean | null = null;

/** Play a chime: through the main process when it can, here otherwise. */
function play(name: Cue, volume: number): void {
  if (volume <= 0) return;
  if (mainPlays === false) {
    playHere(SHAPES[name], volume);
    return;
  }
  void call("app.chime", name, volume)
    .catch(() => false)
    .then((played) => {
      mainPlays = played;
      if (!played) playHere(SHAPES[name], volume);
    });
}

/** Play a chime with Web Audio, which starts Chromium's audio service. */
function playHere(shape: Note[], volume: number): void {
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
    play(name, current.volume);
    return;
  }
  if (!current.inFront && document.hasFocus()) return;
  const now = Date.now();
  if (now - lastEvent < GAP_MS) return;
  lastEvent = now;
  void doNotDisturb().then((dnd) => {
    if (!dnd) play(name, current.volume);
  });
}

/** Play a cue whatever the switches say, for Settings' preview buttons. */
export function previewCue(name: Cue, volume = settings?.volume ?? 0.6): void {
  play(name, volume);
}
