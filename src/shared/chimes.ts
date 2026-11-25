// The window's chimes: one warm family of short tones, each with its own shape, so you can tell
// them apart without looking. The window plays them with Web Audio only when the main process
// can't (no PipeWire); otherwise the main process renders each one here, once, to a small WAV file
// and plays it with pw-play, so Chromium's audio service never starts for a chime.

export type Cue = "voiceStart" | "voiceStop" | "voiceCancel" | "attention" | "finished" | "failed" | "routine";

export const CUES: Cue[] = ["voiceStart", "voiceStop", "voiceCancel", "attention", "finished", "failed", "routine"];

export function isCue(value: unknown): value is Cue {
  return typeof value === "string" && (CUES as string[]).includes(value);
}

export interface Note {
  /** Hz at the start, and optionally where it glides to. */
  freq: number;
  to?: number;
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds until it has faded out. */
  length: number;
  wave?: "sine" | "triangle";
  /** Relative loudness, 0 to 1. */
  level?: number;
}

export const SHAPES: Record<Cue, Note[]> = {
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

/** The loudest a chime gets at full volume. */
export const PEAK = 0.22;

/** Where each note's gain starts and ends, as in Web Audio (an exponential ramp can't reach 0). */
const FLOOR = 0.0001;
/** How long a note takes to reach its level. */
const ATTACK = 0.008;
/** How far into a note its glide ends, as a share of its length. */
const GLIDE = 0.6;
/** Silence kept after the last note, so the end is never clipped. */
const TAIL = 0.02;

/** How long a cue lasts, in seconds, tail included. */
export function cueLength(name: Cue): number {
  return Math.max(...SHAPES[name].map((note) => note.at + note.length)) + TAIL;
}

/** One cycle of a wave at `phase` (0 to 1): a sine, or a triangle rising from 0 like Web Audio's. */
function wave(kind: Note["wave"], phase: number): number {
  if (kind === "triangle") {
    const p = phase - Math.floor(phase);
    return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
  }
  return Math.sin(2 * Math.PI * phase);
}

/**
 * A cue as samples at `rate` Hz, between -1 and 1, at full volume (PEAK): the same shapes, glides
 * and fades the Web Audio path schedules, so a chime sounds the same either way.
 */
export function renderCue(name: Cue, rate = 48_000): Float32Array {
  const samples = new Float32Array(Math.ceil(cueLength(name) * rate));
  for (const note of SHAPES[name]) {
    const level = note.level ?? 1;
    const start = Math.round(note.at * rate);
    const count = Math.ceil(note.length * rate);
    let phase = 0;
    for (let i = 0; i < count && start + i < samples.length; i += 1) {
      const t = i / rate;
      const glide = note.to ? Math.min(1, t / (note.length * GLIDE)) : 0;
      const freq = note.to ? note.freq * (note.to / note.freq) ** glide : note.freq;
      const gain = t < ATTACK ? FLOOR * (level / FLOOR) ** (t / ATTACK) : level * (FLOOR / level) ** ((t - ATTACK) / (note.length - ATTACK));
      samples[start + i] += PEAK * gain * wave(note.wave, phase);
      phase += freq / rate;
    }
  }
  return samples;
}

/** Samples as a 16-bit mono WAV file. */
export function wavBytes(samples: Float32Array, rate = 48_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return bytes;
}
