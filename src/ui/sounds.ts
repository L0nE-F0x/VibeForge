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

let settings: SoundSettings | null = null;
let context: AudioContext | null = null;
let lastEvent = 0;
let quiet: { value: boolean; at: number } | null = null;

/** The shell keeps this current from Settings. */
export function setSoundSettings(next: SoundSettings | undefined): void {
  settings = next ?? null;
}

function audio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

function play(shape: Note[], volume: number): void {
  const ctx = audio();
  if (!ctx || volume <= 0) return;
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
  setTimeout(() => master.disconnect(), (end - ctx.currentTime + 0.2) * 1000);
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
