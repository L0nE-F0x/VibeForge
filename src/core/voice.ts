import fs from "node:fs";
import path from "node:path";
import { resolveSherpaModel } from "./sherpa.js";
import {
  isModelFile,
  modelRank,
  voiceName,
  whisperAudioCtx,
} from "../shared/voice-catalog.js";

export * from "../shared/voice-catalog.js";

// Dictation: what VibeForge records with, which whisper.cpp or sherpa-onnx it talks to, which model
// it loads, and what it does to the words that come back. Pure; electron/voice.ts runs the processes.
// Nothing here reaches the network except a model download someone asks for by name.

/** whisper.cpp wants 16 kHz mono; the recorder is asked for exactly that as signed 16-bit PCM. */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** A recording stops by itself after this long, in case a key-up never arrives. */
export const MAX_SECONDS = 180;
/** Shorter than this is a stray tap of the key, not speech. */
export const MIN_SECONDS = 0.4;
/** Loudest 50 ms stretch (RMS, 0–1) below which a recording is treated as silence. Whisper invents words for silence. */
export const SILENCE_RMS = 0.006;

export interface Recorder {
  /** What the person sees: "pw-record". */
  label: string;
  argv: string[];
}

/**
 * The first recorder on this machine that can write raw 16 kHz mono s16le to stdout. With
 * `target`, PipeWire's recorder takes that node instead of the default microphone.
 */
export function planRecorder(resolveBin: (bin: string) => string | null, override?: string, target?: string): Recorder | null {
  // For tests and odd setups: a shell command whose stdout is that same raw audio.
  if (override?.trim()) return { label: "custom", argv: ["/bin/sh", "-c", override.trim()] };
  const pw = resolveBin("pw-record");
  if (pw) return { label: "pw-record", argv: [pw, ...(target ? ["--target", target] : []), "--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16", "--raw", "-"] };
  const pa = resolveBin("parec");
  if (pa) return { label: "parec", argv: [pa, "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", "--raw"] };
  const alsa = resolveBin("arecord");
  if (alsa) return { label: "arecord", argv: [alsa, "-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"] };
  return null;
}

// ------------------------------------------------------------------ echo cancellation

/** The microphone a call records from while PipeWire takes the speakers' sound out of it. */
export const ECHO_SOURCE = "vibeforge.call.microphone";

/**
 * A PipeWire client's configuration that does nothing but cancel echo (libpipewire-module-echo-cancel,
 * WebRTC's canceller): it listens to the default microphone and to whatever the default speakers
 * are playing (`monitor.mode`), and offers the microphone without that sound as ECHO_SOURCE. It
 * lives in a process of its own (`pipewire -c <this file>`), so it is there for a call and gone
 * with it, and nothing in the person's own PipeWire setup is touched. Its priority is the lowest,
 * so it never becomes anyone's default microphone.
 */
export function echoCancelConf(): string {
  return `context.properties = { log.level = 0 }
context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.* = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-rt args = { } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-echo-cancel
    args = {
      monitor.mode = true
      capture.props = { node.name = "vibeforge.call.capture" }
      source.props = { node.name = "${ECHO_SOURCE}" node.description = "VibeForge call (echo cancelled)" priority.session = 1 priority.driver = 1 }
    }
  }
]
`;
}

// ------------------------------------------------------------------ whisper.cpp

export interface Whisper {
  /** whisper-server keeps the model loaded between recordings; whisper-cli loads it every time. */
  server: string | null;
  cli: string | null;
}

/** Arch's whisper-cpp and upstream builds name the programs whisper-server and whisper-cli. */
export function findWhisper(resolveBin: (bin: string) => string | null, env: { server?: string; cli?: string } = {}): Whisper {
  const pick = (override: string | undefined, names: string[]) => {
    if (override?.trim()) return resolveBin(override.trim());
    for (const name of names) {
      const found = resolveBin(name);
      if (found) return found;
    }
    return null;
  };
  return {
    server: pick(env.server, ["whisper-server", "whisper.cpp-server"]),
    cli: pick(env.cli, ["whisper-cli", "whisper.cpp", "whisper-cpp"]),
  };
}

export function whisperThreads(cpus: number): number {
  return Math.max(1, Math.min(8, cpus - 2));
}

export function serverArgs(opts: { model: string; language: string; port: number; threads: number }): string[] {
  return ["-m", opts.model, "-l", opts.language, "-t", String(opts.threads), "--host", "127.0.0.1", "--port", String(opts.port), "-nt", "-nf"];
}

export function cliArgs(opts: { model: string; file: string; language: string; prompt: string; threads: number; seconds?: number }): string[] {
  const args = ["-m", opts.model, "-f", opts.file, "-l", opts.language, "-t", String(opts.threads), "-nt", "-np", "-nf"];
  if (opts.seconds !== undefined && opts.seconds > 0) {
    const ctx = whisperAudioCtx(opts.seconds);
    if (ctx < 1500) args.push("-ac", String(ctx));
  }
  if (opts.prompt) args.push("--prompt", opts.prompt);
  return args;
}

// ------------------------------------------------------------------ models

/** Where models are looked for: VibeForge's own folder first, then other whisper.cpp and sherpa-onnx folders (Omarchy's Voxtype among them). */
export function modelDirs(home: string, dataRoot: string): string[] {
  return [
    path.join(dataRoot, "models"),
    path.join(home, ".local", "share", "voxtype", "models"),
    path.join(home, ".local", "share", "sherpa-onnx", "models"),
    path.join(home, ".local", "share", "whisper.cpp", "models"),
    path.join(home, ".local", "share", "whisper", "models"),
    "/usr/share/whisper.cpp/models",
    "/usr/share/whisper-cpp/models",
  ];
}

/** Discovers installed ggml `.bin` models and complete sherpa-onnx model directories, best first. */
export function scanVoiceModels(home: string, dataRoot: string): string[] {
  const found: string[] = [];
  for (const dir of modelDirs(home, dataRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (found.some((other) => path.basename(other) === entry.name)) continue;
      if (entry.isDirectory()) {
        try {
          const children = fs.readdirSync(full);
          const spec = resolveSherpaModel(full, children);
          if (!spec) continue;
          const primary = spec.kind === "sense_voice" ? spec.model : spec.encoder;
          if (fs.statSync(primary).size > 100_000) found.push(full);
        } catch {
          /* incomplete or removed */
        }
      } else if (isModelFile(entry.name)) {
        try {
          if (fs.statSync(full).size > 1_000_000) found.push(full);
        } catch {
          /* gone since the listing */
        }
      }
    }
  }
  return found.sort((a, b) => modelRank(b) - modelRank(a) || a.localeCompare(b));
}

// ------------------------------------------------------------------ audio

/** Loudness of a stretch of s16le audio: root mean square, 0 (silence) to 1 (full scale). */
export function rms(pcm: Uint8Array, start = 0, end = pcm.length): number {
  const from = start - (start % 2);
  const to = Math.min(end, pcm.length) - ((Math.min(end, pcm.length) - from) % 2);
  const samples = (to - from) / 2;
  if (samples <= 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = from; i < to; i += 2) {
    const value = view.getInt16(i, true) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/** How full the level meter is: a loudness mapped onto -60…0 dBFS, 0 to 1. */
export function meterLevel(loudness: number): number {
  if (loudness <= 0) return 0;
  const db = 20 * Math.log10(loudness);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

/** The loudest 50 ms of a recording: speech has some, a muted or distant mic does not. */
export function peakLoudness(pcm: Uint8Array): number {
  const window = BYTES_PER_SECOND / 20;
  let peak = 0;
  for (let start = 0; start < pcm.length; start += window) peak = Math.max(peak, rms(pcm, start, start + window));
  return peak;
}

/**
 * Trim excess leading and trailing silence from 16 kHz mono s16le PCM while preserving `padMs`
 * of context at either end so STT recognizers don't waste compute on long dead air.
 */
export function trimSilence(pcm: Buffer, padMs = 160): Buffer {
  const alignedLen = pcm.length - (pcm.length % 2);
  if (alignedLen < BYTES_PER_SECOND * 0.8) return pcm.subarray(0, alignedLen);
  const frameBytes = (BYTES_PER_SECOND * 20) / 1000; // 20 ms = 640 bytes
  const levels: number[] = [];
  for (let at = 0; at < alignedLen; at += frameBytes) {
    levels.push(rms(pcm, at, Math.min(alignedLen, at + frameBytes)));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const threshold = Math.max(SILENCE_RMS, floor * 2.5);
  let first = -1;
  let last = -1;
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i] >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return pcm.subarray(0, alignedLen);
  const padFrames = Math.ceil(padMs / 20);
  const start = Math.max(0, first - padFrames) * frameBytes;
  const end = Math.min(alignedLen, (last + 1 + padFrames) * frameBytes);
  return pcm.subarray(start, end);
}

/** A WAV file around raw 16 kHz mono s16le, for whisper. */
export function wavFile(pcm: Uint8Array): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ------------------------------------------------------------------ words

/**
 * What whisper heard, tidied: its markers for non-speech ("[BLANK_AUDIO]", "(music)", "*coughs*")
 * are dropped and the lines joined. Empty when nothing but markers came back.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.,!?…\s-]+$/, "");
}

// ------------------------------------------------------------------ the end of a sentence

export type SpeechPhase = "waiting" | "speaking" | "ended" | "timeout";

/** 30 ms of audio: short enough to react quickly, long enough to measure. */
export const FRAME_BYTES = (BYTES_PER_SECOND * 30) / 1000;

/**
 * Tells when someone has finished speaking: speech is loudness well above the room's own noise
 * (tracked as it goes), and a turn ends after a pause of `silenceMs` that follows at least
 * `minSpeechMs` of speech. Nothing said for `noSpeechMs` is a timeout. Hold-to-talk does not use
 * this; it is here for a later option that listens again after a reply.
 */
export class Endpointer {
  private floor = -1;
  private voicedMs = 0;
  private runMs = 0;
  private quietMs = 0;
  private waitedMs = 0;
  phase: SpeechPhase = "waiting";

  constructor(private readonly opts: { silenceMs?: number; minSpeechMs?: number; noSpeechMs?: number; minLoudness?: number } = {}) {}

  /** One frame's loudness (RMS, 0–1) and length. Returns the phase after it. */
  push(loudness: number, ms: number): SpeechPhase {
    if (this.phase === "ended" || this.phase === "timeout") return this.phase;
    const { silenceMs = 800, minSpeechMs = 300, noSpeechMs = 20_000, minLoudness = 0.012 } = this.opts;
    if (this.floor < 0) this.floor = loudness;
    const voiced = loudness > Math.max(minLoudness, this.floor * 3.5);
    // The floor falls at once to a quieter frame and creeps up slowly, so speech doesn't raise it.
    this.floor = loudness < this.floor ? loudness : this.floor + (loudness - this.floor) * 0.002;
    if (voiced) {
      this.runMs += ms;
      this.quietMs = 0;
      if (this.runMs >= 120) {
        this.voicedMs += ms;
        this.phase = "speaking";
      }
    } else {
      this.runMs = 0;
      this.quietMs += ms;
      if (this.phase === "speaking" && this.quietMs >= silenceMs && this.voicedMs >= minSpeechMs) this.phase = "ended";
    }
    if (this.phase === "waiting") {
      this.waitedMs += ms;
      if (this.waitedMs >= noSpeechMs) this.phase = "timeout";
    }
    return this.phase;
  }
}

// ------------------------------------------------------------------ speaking: Piper

export interface Player {
  label: string;
  /** Plays raw mono s16le at `rate` from stdin. */
  argv: (rate: number) => string[];
}

/** Piper's own name, or the AUR package's. */
export function findPiper(resolveBin: (bin: string) => string | null, override?: string): string | null {
  if (override?.trim()) return resolveBin(override.trim());
  return resolveBin("piper") ?? resolveBin("piper-tts");
}

/** The first player that takes raw audio on stdin: PipeWire, then Pulse, then ALSA, or a command for tests. */
export function planPlayer(resolveBin: (bin: string) => string | null, override?: string): Player | null {
  // The command reads the audio on stdin; $RATE holds its sample rate.
  if (override?.trim()) return { label: "custom", argv: (rate) => ["/bin/sh", "-c", `RATE=${rate}; ${override.trim()}`] };
  const pw = resolveBin("pw-play");
  if (pw) return { label: "pw-play", argv: (rate) => [pw, "--rate", String(rate), "--channels", "1", "--format", "s16", "--raw", "--media-role", "Communication", "-"] };
  const pa = resolveBin("paplay");
  if (pa) return { label: "paplay", argv: (rate) => [pa, "--raw", `--rate=${rate}`, "--channels=1", "--format=s16le"] };
  const alsa = resolveBin("aplay");
  if (alsa) return { label: "aplay", argv: (rate) => [alsa, "-q", "-f", "S16_LE", "-r", String(rate), "-c", "1", "-t", "raw"] };
  return null;
}

/** Where voices are looked for: VibeForge's own folder, Piper's, and the AUR's piper-voices packages. */
export function voiceDirs(home: string, dataRoot: string): string[] {
  return [
    path.join(dataRoot, "voices"),
    path.join(home, ".local", "share", "piper", "voices"),
    path.join(home, ".local", "share", "piper-voices"),
    "/usr/share/piper-voices",
    "/usr/share/piper/voices",
  ];
}

/** A Piper voice is an .onnx file with its .onnx.json beside it. */
export function isVoiceFile(name: string, siblings: ReadonlySet<string>): boolean {
  return /\.onnx$/i.test(name) && siblings.has(`${name}.json`);
}

/** Piper voices: .onnx files with their .onnx.json, up to three folders deep (the AUR nests them by language). */
export function scanPiperVoices(home: string, dataRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (isVoiceFile(entry.name, names) && !found.some((other) => voiceName(other) === voiceName(file))) found.push(file);
    }
  };
  for (const dir of voiceDirs(home, dataRoot)) walk(dir, 0);
  return found.sort((a, b) => voiceName(a).localeCompare(voiceName(b)));
}

/** Sample rate from a voice's .onnx.json; Piper's medium voices use 22050. */
export function voiceRate(configJson: unknown): number {
  const rate = (configJson as { audio?: { sample_rate?: unknown } } | null)?.audio?.sample_rate;
  return typeof rate === "number" && rate >= 8000 && rate <= 48_000 ? rate : 22_050;
}
