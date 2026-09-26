import path from "node:path";

// Dictation: what VibeForge records with, which whisper.cpp it talks to, which model it loads,
// and what it does to the words that come back. Pure; electron/voice.ts runs the processes.
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

/** The first recorder on this machine that can write raw 16 kHz mono s16le to stdout. */
export function planRecorder(resolveBin: (bin: string) => string | null, override?: string): Recorder | null {
  // For tests and odd setups: a shell command whose stdout is that same raw audio.
  if (override?.trim()) return { label: "custom", argv: ["/bin/sh", "-c", override.trim()] };
  const pw = resolveBin("pw-record");
  if (pw) return { label: "pw-record", argv: [pw, "--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16", "--raw", "-"] };
  const pa = resolveBin("parec");
  if (pa) return { label: "parec", argv: [pa, "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", "--raw"] };
  const alsa = resolveBin("arecord");
  if (alsa) return { label: "arecord", argv: [alsa, "-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"] };
  return null;
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
  return ["-m", opts.model, "-l", opts.language, "-t", String(opts.threads), "--host", "127.0.0.1", "--port", String(opts.port), "-nt"];
}

export function cliArgs(opts: { model: string; file: string; language: string; prompt: string; threads: number }): string[] {
  const args = ["-m", opts.model, "-f", opts.file, "-l", opts.language, "-t", String(opts.threads), "-nt", "-np"];
  if (opts.prompt) args.push("--prompt", opts.prompt);
  return args;
}

// ------------------------------------------------------------------ models

export interface ModelChoice {
  id: string;
  file: string;
  /** Rough download size, for the button. */
  mb: number;
  englishOnly: boolean;
}

/** Models offered for download: ggml files from the whisper.cpp project on Hugging Face. */
export const MODEL_CATALOG: ModelChoice[] = [
  { id: "base.en", file: "ggml-base.en.bin", mb: 142, englishOnly: true },
  { id: "small.en", file: "ggml-small.en.bin", mb: 466, englishOnly: true },
  { id: "base", file: "ggml-base.bin", mb: 142, englishOnly: false },
  { id: "small", file: "ggml-small.bin", mb: 466, englishOnly: false },
  { id: "large-v3-turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", mb: 547, englishOnly: false },
];

export function modelUrl(choice: ModelChoice): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${choice.file}`;
}

/** Where models are looked for: VibeForge's own folder first, then other whisper.cpp users (Omarchy's Voxtype among them). */
export function modelDirs(home: string, dataRoot: string): string[] {
  return [
    path.join(dataRoot, "models"),
    path.join(home, ".local", "share", "voxtype", "models"),
    path.join(home, ".local", "share", "whisper.cpp", "models"),
    path.join(home, ".local", "share", "whisper", "models"),
    "/usr/share/whisper.cpp/models",
    "/usr/share/whisper-cpp/models",
  ];
}

/** A whisper.cpp model file: ggml-*.bin, but not the voice-activity models that share the prefix. */
export function isModelFile(name: string): boolean {
  return /^ggml-.+\.bin$/i.test(name) && !/silero|vad/i.test(name);
}

export function isEnglishOnly(model: string): boolean {
  return /\.en([.-]|$)/i.test(path.basename(model).replace(/\.bin$/i, ""));
}

/** Bigger models hear better; quantized ones are nearly as good. Unknown names sort last. */
export function modelRank(model: string): number {
  const name = path.basename(model).toLowerCase();
  const sizes = ["tiny", "base", "small", "medium", "large"];
  const index = sizes.findIndex((size) => name.includes(`-${size}`));
  return index < 0 ? -1 : index * 10 + (name.includes("turbo") ? 5 : 0) + (/q\d/.test(name) ? 0 : 1);
}

/**
 * The model to load: the one chosen in Settings when it still exists, else the best one found.
 * English-only models win a tie when the language is English, since they are sharper at it.
 */
export function pickModel(found: readonly string[], chosen: string, language: string): string | null {
  if (chosen && found.includes(chosen)) return chosen;
  const english = language === "en";
  const usable = found.filter((file) => english || language === "auto" || !isEnglishOnly(file));
  const pool = usable.length ? usable : [...found];
  pool.sort((a, b) => modelRank(b) - modelRank(a) || Number(isEnglishOnly(b) === english) - Number(isEnglishOnly(a) === english) || a.localeCompare(b));
  return pool[0] ?? null;
}

/** The language whisper is told to listen for. English-only models can only ever hear English. */
export function listenLanguage(model: string, setting: string): string {
  if (isEnglishOnly(model)) return "en";
  return /^[a-z]{2,3}$/.test(setting) ? setting : "auto";
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
 * Tells when someone has finished speaking, for conversation mode: speech is loudness well above
 * the room's own noise (tracked as it goes), and a turn ends after a pause of `silenceMs` that
 * follows at least `minSpeechMs` of speech. Nothing said for `noSpeechMs` is a timeout.
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

export interface VoiceChoice {
  /** Piper's name for it, which is also the file name: en_US-lessac-medium. */
  id: string;
  /** Its folder in the rhasspy/piper-voices repository. */
  dir: string;
  mb: number;
  /** Language code, as the app's language picker uses them. */
  language: string;
}

/** Voices offered for download: a few clear ones for each language VibeForge speaks. Japanese has none in Piper yet. */
export const VOICE_CATALOG: VoiceChoice[] = [
  { id: "en_US-lessac-medium", dir: "en/en_US/lessac/medium", mb: 63, language: "en" },
  { id: "en_US-ryan-high", dir: "en/en_US/ryan/high", mb: 121, language: "en" },
  { id: "en_GB-alan-medium", dir: "en/en_GB/alan/medium", mb: 63, language: "en" },
  { id: "en_GB-jenny_dioco-medium", dir: "en/en_GB/jenny_dioco/medium", mb: 63, language: "en" },
  { id: "de_DE-thorsten-medium", dir: "de/de_DE/thorsten/medium", mb: 63, language: "de" },
  { id: "es_ES-davefx-medium", dir: "es/es_ES/davefx/medium", mb: 63, language: "es" },
  { id: "fr_FR-siwis-medium", dir: "fr/fr_FR/siwis/medium", mb: 63, language: "fr" },
  { id: "pt_BR-faber-medium", dir: "pt/pt_BR/faber/medium", mb: 63, language: "pt" },
  { id: "zh_CN-huayan-medium", dir: "zh/zh_CN/huayan/medium", mb: 63, language: "zh" },
];

export function voiceUrls(choice: VoiceChoice): { model: string; config: string } {
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${choice.dir}/${choice.id}.onnx`;
  return { model: base, config: `${base}.json` };
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

/** "en_GB-alan-medium" from its file. */
export function voiceName(file: string): string {
  return path.basename(file).replace(/\.onnx$/i, "");
}

/** The voice to speak with: the one asked for when it exists, else one in the app's language, else the first found. */
export function pickVoice(found: readonly string[], chosen: string, language: string): string | null {
  if (chosen && found.includes(chosen)) return chosen;
  const same = found.find((file) => voiceName(file).toLowerCase().startsWith(`${language.toLowerCase()}_`));
  return same ?? found[0] ?? null;
}

/** Sample rate from a voice's .onnx.json; Piper's medium voices use 22050. */
export function voiceRate(configJson: unknown): number {
  const rate = (configJson as { audio?: { sample_rate?: unknown } } | null)?.audio?.sample_rate;
  return typeof rate === "number" && rate >= 8000 && rate <= 48_000 ? rate : 22_050;
}
