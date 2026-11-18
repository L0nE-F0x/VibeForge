import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hyprlandBindings } from "../src/core/control.js";
import { describeError, type LogFile } from "../src/core/log.js";
import { Segmenter } from "../src/core/call.js";
import {
  findSherpa,
  parseSherpaOutput,
  resolveSherpaModel,
  SHERPA_PIN,
  SHERPA_WORKER_SCRIPT,
  sherpaCliArgs,
  sherpaMark,
  sherpaSourceNote,
  type SherpaRuntime,
} from "../src/core/sherpa.js";
import type { VoiceSettings } from "../src/core/types.js";
import { readVadModel, SpeechDetector, VAD_MODEL, type VadModel } from "../src/core/vad.js";
import {
  BYTES_PER_SECOND,
  cleanTranscript,
  pickVoice,
  scanPiperVoices,
  scanVoiceModels,
  VOICE_CATALOG,
  voiceName,
  voiceUrls,
  cliArgs,
  findWhisper,
  listenLanguage,
  MAX_SECONDS,
  meterLevel,
  MIN_SECONDS,
  MODEL_CATALOG,
  modelBackend,
  modelFiles,
  peakLoudness,
  pickModel,
  planRecorder,
  rms,
  serverArgs,
  SILENCE_RMS,
  wavFile,
  whisperThreads,
  type Recorder,
  type VoiceBackend,
} from "../src/core/voice.js";
import type { Dictation, DownloadKind, VoiceState, VoiceStatus } from "../src/shared/api.js";
import { type Download, downloadFiles } from "./download.js";
import { type EchoCancel, startEchoCancel } from "./echo.js";
import { Speaker } from "./speech.js";

const LEVEL_EVERY_MS = 60;
/**
 * Warm recognizers (whisper-server or the sherpa-onnx stdio worker) are stopped after this long
 * unused, to give their memory back. The next recording loads the model again while the person is still speaking.
 */
const SERVER_IDLE_MS = 2 * 60 * 1000;
const SERVER_READY_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

interface Server {
  child: ChildProcess;
  port: number;
  model: string;
  language: string;
  ready: Promise<void>;
}

interface SherpaWorker {
  child: ChildProcess;
  model: string;
  language: string;
  ready: Promise<void>;
  queue: Promise<void>;
  send: (wav: Buffer) => Promise<string>;
}

export async function unpackSherpaArchive(archiveFile: string, destDir: string, arch: string): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sherpa-"));
  const out = path.join(work, "out");
  fs.mkdirSync(out, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xjf", archiveFile, "-C", out, "--strip-components=1", "--no-same-owner"], { timeout: 60_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Could not unpack sherpa-onnx: ${String(stderr || error.message).trim().split("\n")[0]}`));
        else resolve();
      });
    });
    const staged = `${destDir}.next`;
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(path.join(staged, "bin"), { recursive: true });
    fs.copyFileSync(path.join(out, "bin", "sherpa-onnx-offline"), path.join(staged, "bin", "sherpa-onnx-offline"));
    fs.chmodSync(path.join(staged, "bin", "sherpa-onnx-offline"), 0o755);
    if (fs.existsSync(path.join(out, "lib"))) {
      fs.cpSync(path.join(out, "lib"), path.join(staged, "lib"), { recursive: true, verbatimSymlinks: true });
    }
    if (fs.existsSync(path.join(out, "LICENSE"))) {
      fs.copyFileSync(path.join(out, "LICENSE"), path.join(staged, "LICENSE"));
    }
    fs.writeFileSync(path.join(staged, "SOURCE.txt"), sherpaSourceNote());
    fs.writeFileSync(path.join(staged, "PIN"), sherpaMark(arch));
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(staged, destDir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(archiveFile, { force: true });
  }
}

interface Recording {
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  startedAt: number;
  lastLevelAt: number;
  exited: Promise<void>;
  timer: NodeJS.Timeout;
  error: string | null;
}

/** The microphone held open for a call. */
export interface Ear {
  /** Stop passing on what is heard (Viby is thinking or speaking), or start again. */
  deaf(on: boolean): void;
  close(): void;
  /** It listens for speech itself (the Silero detector), not just for loudness. */
  readonly detects: boolean;
  /** PipeWire is taking the speakers' sound out of what it hears. */
  readonly cancelsEcho: boolean;
}

export interface EarEvents {
  /** One thing said, as 16 kHz mono s16le. */
  heard: (pcm: Buffer) => void;
  /**
   * The meter, and whether someone is speaking, many times a second. `speechMs` is how much speech
   * the detector has heard in what is being said (0 when it goes by loudness).
   */
  level: (level: number, hearing: boolean, speechMs: number) => void;
  /** The recorder stopped by itself; `error` is what it said. Not called after `close`. */
  closed: (error: string) => void;
}

interface OpenEar {
  /** The recorder, once it has started: echo cancellation is set up first when it can be. */
  child: ChildProcess | null;
  echo: EchoCancel | null;
  segmenter: Segmenter;
  deaf: boolean;
  /** Heard nothing last time (deaf, or a dictation had the mic): what was half-heard before is stale. */
  skipped: boolean;
  lastLevelAt: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Dictation on this machine: records the microphone with PipeWire (or Pulse, or ALSA) and turns
 * speech into text with whisper.cpp. Audio stays in memory, apart from a temporary WAV for
 * whisper-cli that is deleted at once. The log records lengths and timings, never the words.
 */
export class Voice {
  private recording: Recording | null = null;
  private transcribing = false;
  private server: Server | null = null;
  private sherpaWorker: SherpaWorker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** whisper-cli / sherpa-onnx-offline runs under way, with the folder holding each one's audio, for a quit to clear. */
  private readonly cliRuns = new Map<ChildProcess, string>();
  /** Requests a warm recognizer is answering now; it isn't stopped under them. */
  private serverUses = 0;
  /** A call's open microphone. */
  private ear: OpenEar | null = null;
  private download: { kind: DownloadKind; id: string; received: number; total: number; abort: AbortController } | null = null;
  private downloadError: string | null = null;
  readonly speaker: Speaker;

  constructor(
    private readonly opts: {
      log: LogFile;
      home: string;
      dataRoot: string;
      settings: () => VoiceSettings;
      resolveBin: (bin: string) => string | null;
      /** The recording's phase and level, many times a second. */
      state: (state: VoiceState) => void;
      /** Something in the status changed (a download moved on, a model arrived). */
      changed: () => void;
      /** Speaking started (with what) or stopped (null). */
      speaking: (text: string | null) => void;
      /** The app's language code, for picking a voice. */
      language: () => string;
      controlSocket: string;
      /** The command that runs VibeForge, for keybindings. */
      launcher: () => string;
      /** Where VibeForge is installed: the speech detector's model is in its resources. Without it, a call listens by loudness. */
      appRoot?: string;
      /** For tests: how long whisper-server is kept unused. */
      serverIdleMs?: number;
    },
  ) {
    this.speaker = new Speaker({ log: opts.log, resolveBin: opts.resolveBin, speaking: opts.speaking });
  }

  // ---------------------------------------------------------------- what is here

  private recorder(): Recorder | null {
    return planRecorder(this.opts.resolveBin, process.env.VIBEFORGE_VOICE_RECORDER);
  }

  private whisper() {
    return findWhisper(this.opts.resolveBin, { server: process.env.VIBEFORGE_WHISPER_SERVER, cli: process.env.VIBEFORGE_WHISPER_CLI });
  }

  private sherpa(): SherpaRuntime {
    return findSherpa(this.opts.resolveBin, this.opts.dataRoot, { cli: process.env.VIBEFORGE_SHERPA_CLI });
  }

  private backends(whisper: { server: string | null; cli: string | null }, sherpa: SherpaRuntime): Set<VoiceBackend> {
    const out = new Set<VoiceBackend>();
    if (whisper.server || whisper.cli) out.add("whisper");
    if (sherpa.cli) out.add("sherpa");
    return out;
  }

  private modelDir(): string {
    return path.join(this.opts.dataRoot, "models");
  }

  private findModels(): string[] {
    return scanVoiceModels(this.opts.home, this.opts.dataRoot);
  }

  private voiceDir(): string {
    return path.join(this.opts.dataRoot, "voices");
  }

  /** Piper voices: .onnx files with their .onnx.json, up to three folders deep (the AUR nests them by language). */
  findVoices(): string[] {
    return scanPiperVoices(this.opts.home, this.opts.dataRoot);
  }

  /** The keybinding lines for this Hyprland (Omarchy's Lua config, or hyprland.conf), and whether they are in. */
  private hyprland(): VoiceStatus["hyprland"] {
    const dir = path.join(this.opts.home, ".config", "hypr");
    const lua = fs.existsSync(path.join(dir, "bindings.lua")) || fs.existsSync(path.join(dir, "hyprland.lua"));
    const file = path.join(dir, lua ? "bindings.lua" : fs.existsSync(path.join(dir, "bindings.conf")) ? "bindings.conf" : "hyprland.conf");
    let installed = false;
    try {
      installed = /--voice\s+start/.test(fs.readFileSync(file, "utf8"));
    } catch {
      /* no file yet */
    }
    return { file, text: hyprlandBindings(this.opts.launcher(), lua), installed };
  }

  /** Adds the keybindings to Hyprland's config, keeping a copy of the file as it was. Hyprland reloads it by itself. */
  installBindings(): string {
    const { file, text, installed } = this.hyprland();
    if (installed) return file;
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (before) fs.copyFileSync(file, `${file}.bak.${Math.floor(Date.now() / 1000)}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, before ? `${before}${before.endsWith("\n") ? "" : "\n"}\n${text}\n` : `${text}\n`);
    this.opts.log.info(`Voice: added keybindings to ${file}`);
    this.opts.changed();
    return file;
  }

  /** The voice file to read with: `wanted` (an agent's) when it exists, else the one in Settings, else a sensible one. */
  voiceFor(wanted = ""): string | null {
    const voices = this.findVoices();
    if (wanted && voices.includes(wanted)) return wanted;
    return pickVoice(voices, this.opts.settings().speaker, this.opts.language());
  }

  /** Where `vibeforge` reaches this app: fixed at start, so reading it scans nothing. */
  get controlSocket(): string {
    return this.opts.controlSocket;
  }

  status(): VoiceStatus {
    const settings = this.opts.settings();
    const whisper = this.whisper();
    const sherpa = this.sherpa();
    const backends = this.backends(whisper, sherpa);
    const models = this.findModels();
    const runnableModel = pickModel(models, settings.model, settings.language, backends);
    const model = runnableModel ?? pickModel(models, settings.model, settings.language);
    const recorder = this.recorder();
    const voices = this.findVoices();
    return {
      recorder: recorder?.label ?? null,
      server: whisper.server,
      cli: whisper.cli,
      sherpa: sherpa.cli,
      model,
      models,
      modelDir: this.modelDir(),
      language: model ? listenLanguage(model, settings.language) : settings.language,
      ready: Boolean(recorder && runnableModel),
      catalog: MODEL_CATALOG.map((choice) => ({ ...choice, path: models.find((file) => path.basename(file) === choice.file) ?? null })),
      download: this.download ? { kind: this.download.kind, id: this.download.id, received: this.download.received, total: this.download.total } : null,
      downloadError: this.downloadError,
      piper: this.speaker.piper(),
      player: this.speaker.player()?.label ?? null,
      detector: this.vadModel() !== null,
      echoCancel: this.canCancelEcho(recorder),
      voices,
      speaker: this.voiceFor(),
      voiceDir: this.voiceDir(),
      voiceCatalog: VOICE_CATALOG.map((choice) => ({ ...choice, path: voices.find((file) => voiceName(file) === choice.id) ?? null })),
      speaking: this.speaker.busy,
      controlSocket: this.opts.controlSocket,
      hyprland: this.hyprland(),
    };
  }

  private checkReady(status: VoiceStatus, needRecorder: boolean, gone = false): void {
    if (needRecorder && !status.recorder) {
      throw new Error("No recorder found. VibeForge records with pw-record (PipeWire), parec or arecord.");
    }
    if (!status.model) {
      if (!status.server && !status.cli && !status.sherpa) {
        throw new Error("whisper.cpp is not installed. Settings → Voice shows how to add it.");
      }
      throw new Error(gone ? "The whisper model is gone. Settings → Voice can download one." : "No whisper model found. Settings → Voice can download one.");
    }
    if (modelBackend(status.model) === "sherpa") {
      if (!status.sherpa) throw new Error("sherpa-onnx is not installed. Settings → Voice can download it.");
    } else if (!status.server && !status.cli) {
      throw new Error("whisper.cpp is not installed. Settings → Voice shows how to add it.");
    }
  }

  private warmRecognizer(status: VoiceStatus): void {
    if (!status.model) return;
    if (modelBackend(status.model) === "sherpa") {
      void this.ensureSherpaWorker(status.model, status.language).catch(() => undefined);
    } else if (status.server) {
      void this.ensureServer(status.server, status.model, status.language).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- recording

  start(): void {
    if (this.recording) return;
    // Talking over an answer silences it.
    this.speaker.stop();
    if (this.transcribing) throw new Error("Still turning the last recording into text.");
    const status = this.status();
    const recorder = this.recorder();
    this.checkReady(status, true);
    if (!recorder) throw new Error("No recorder found. VibeForge records with pw-record (PipeWire), parec or arecord.");

    const child = spawn(recorder.argv[0], recorder.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const recording: Recording = {
      child,
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      lastLevelAt: 0,
      exited: new Promise((resolve) => child.once("close", () => resolve())),
      // At the limit the microphone closes; what was said so far is still transcribed on stop.
      timer: setTimeout(() => child.kill("SIGTERM"), MAX_SECONDS * 1000),
      error: null,
    };
    this.recording = recording;
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.on("error", (error) => {
      recording.error = describeError(error);
    });
    child.on("close", (code, signal) => {
      // Stopping sends SIGTERM; anything else ending it early is a problem with the microphone.
      if (this.recording === recording && !signal && code !== 0) recording.error = stderr.trim().split("\n").pop() || `${recorder.label} exited with code ${code}`;
    });
    child.stdout?.on("data", (data: Buffer) => {
      recording.chunks.push(data);
      recording.bytes += data.length;
      const now = Date.now();
      if (now - recording.lastLevelAt < LEVEL_EVERY_MS) return;
      recording.lastLevelAt = now;
      this.opts.state({ phase: "recording", level: meterLevel(rms(data)), seconds: recording.bytes / BYTES_PER_SECOND, speech: null });
    });
    this.opts.state({ phase: "recording", level: 0, seconds: 0, speech: null });
    this.opts.log.info(`Voice: recording with ${recorder.label}`);
    // Loading a model takes a moment; do it while the person talks.
    this.warmRecognizer(status);
  }

  private async endRecording(recording: Recording): Promise<Buffer> {
    clearTimeout(recording.timer);
    if (recording.child.exitCode === null && recording.child.signalCode === null) recording.child.kill("SIGTERM");
    await Promise.race([recording.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    // pw-record can end mid-sample; whisper wants whole ones.
    const pcm = Buffer.concat(recording.chunks);
    return pcm.subarray(0, pcm.length - (pcm.length % 2));
  }

  async cancel(): Promise<void> {
    const recording = this.recording;
    if (!recording) return;
    this.recording = null;
    await this.endRecording(recording);
    this.opts.log.info(`Voice: recording cancelled after ${(recording.bytes / BYTES_PER_SECOND).toFixed(1)} s`);
    this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
  }

  async stop(prompt = ""): Promise<Dictation> {
    const recording = this.recording;
    if (!recording) throw new Error("Nothing is being recorded.");
    this.recording = null;
    const stoppedAt = Date.now();
    const pcm = await this.endRecording(recording);
    const seconds = pcm.length / BYTES_PER_SECOND;
    const result = (empty: Dictation["empty"], text = ""): Dictation => ({ text, seconds, tookMs: Date.now() - stoppedAt, empty });

    if (recording.error && pcm.length === 0) {
      this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
      this.opts.log.warn(`Voice: the recorder failed: ${recording.error}`);
      throw new Error(`The microphone could not be read: ${recording.error}`);
    }
    if (seconds < MIN_SECONDS) {
      this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
      return result("short");
    }
    if (peakLoudness(pcm) < SILENCE_RMS) {
      this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
      this.opts.log.info(`Voice: ${seconds.toFixed(1)} s of silence, not transcribed`);
      return result("silent");
    }

    this.transcribing = true;
    this.opts.state({ phase: "transcribing", level: 0, seconds, speech: null });
    try {
      const text = await this.words(pcm, prompt, seconds, stoppedAt, "");
      return result(text ? null : "nothing", text);
    } catch (error) {
      this.opts.log.warn(`Voice: transcription failed: ${describeError(error).split("\n")[0]}`);
      throw error;
    } finally {
      this.transcribing = false;
      this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
    }
  }

  /**
   * Words for speech recorded somewhere else: the phone page's mic, or one thing said in a call,
   * as 16 kHz mono s16le. The same checks and the same whisper as a recording here; the window's
   * own recording isn't touched.
   */
  async transcribe(pcm: Buffer, prompt = "", source: "phone" | "call" = "phone"): Promise<Dictation> {
    const from = source === "call" ? " in a call" : " from the phone";
    const startedAt = Date.now();
    const audio = pcm.subarray(0, pcm.length - (pcm.length % 2));
    const seconds = audio.length / BYTES_PER_SECOND;
    const result = (empty: Dictation["empty"], text = ""): Dictation => ({ text, seconds, tookMs: Date.now() - startedAt, empty });
    if (seconds < MIN_SECONDS) return result("short");
    if (peakLoudness(audio) < SILENCE_RMS) {
      this.opts.log.info(`Voice: ${seconds.toFixed(1)} s of silence${from}, not transcribed`);
      return result("silent");
    }
    try {
      const text = await this.words(audio, prompt, seconds, startedAt, from);
      return result(text ? null : "nothing", text);
    } catch (error) {
      this.opts.log.warn(`Voice: transcription${from} failed: ${describeError(error).split("\n")[0]}`);
      throw error;
    }
  }

  /** Whether speech can be turned into words here: whisper.cpp or sherpa-onnx and a matching model. */
  canTranscribe(): boolean {
    const settings = this.opts.settings();
    const backends = this.backends(this.whisper(), this.sherpa());
    return Boolean(pickModel(this.findModels(), settings.model, settings.language, backends));
  }

  /** What whisper or sherpa-onnx heard in `pcm`, tidied. */
  private async words(pcm: Buffer, prompt: string, seconds: number, since: number, from: string): Promise<string> {
    const status = this.status();
    this.checkReady(status, false, true);
    const model = status.model!;
    let via: string;
    let raw: string;
    if (modelBackend(model) === "sherpa") {
      const result = await this.viaSherpa(model, status.language, pcm);
      via = result.via;
      raw = result.raw;
    } else if (status.server) {
      via = "whisper-server";
      raw = await this.viaServer(status.server, model, status.language, pcm, prompt);
    } else {
      via = "whisper-cli";
      raw = await this.viaCli(status.cli as string, model, status.language, pcm, prompt, seconds);
    }
    const text = cleanTranscript(raw);
    this.opts.log.info(`Voice: ${seconds.toFixed(1)} s${from} transcribed in ${((Date.now() - since) / 1000).toFixed(1)} s by ${via} with ${path.basename(model)}`);
    return text;
  }

  // ---------------------------------------------------------------- a call's microphone

  /** Dictation has the microphone, or is turning what it recorded into words. */
  get dictating(): boolean {
    return this.recording !== null || this.transcribing;
  }

  private vad: VadModel | null | undefined;

  /**
   * A speech detector for one call, or null when its model can't be read (the call then listens
   * by loudness). VIBEFORGE_VAD_MODEL names another file, or "off".
   */
  private detector(): SpeechDetector | null {
    const model = this.vadModel();
    return model ? new SpeechDetector(model) : null;
  }

  /** Only PipeWire's own recorder can be pointed at the echo-cancelled microphone, and its client and `pw-cli` set that up. */
  private canCancelEcho(recorder: Recorder | null): boolean {
    return recorder?.label === "pw-record" && process.env.VIBEFORGE_ECHO_CANCEL !== "off" && Boolean(this.opts.resolveBin("pipewire") && this.opts.resolveBin("pw-cli"));
  }

  /** The detector's model, read once. */
  private vadModel(): VadModel | null {
    if (this.vad === undefined) {
      const named = process.env.VIBEFORGE_VAD_MODEL?.trim();
      const file = named && named !== "off" ? named : !named && this.opts.appRoot ? path.join(this.opts.appRoot, "resources", "vad", VAD_MODEL.file) : null;
      this.vad = null;
      if (file) {
        try {
          this.vad = readVadModel(fs.readFileSync(file));
        } catch (error) {
          this.opts.log.warn(`Voice: no speech detector, listening by loudness: ${describeError(error)}`);
        }
      }
    }
    return this.vad;
  }

  /**
   * Opens the microphone for a call and keeps it open: each thing said arrives by itself, cut out
   * where the speaker paused. Silence is dropped as it comes and nothing is written anywhere. While
   * a dictation is recording, the words are that dictation's and the call hears nothing.
   *
   * With `cancelEcho`, PipeWire is first asked to take the speakers' sound out of the microphone
   * (electron/echo.ts); the recorder starts once that is there, or without it when this machine can't.
   */
  openEar(on: EarEvents, cancelEcho = false): Ear {
    if (this.ear) throw new Error("A call is already listening.");
    const status = this.status();
    const recorder = this.recorder();
    this.checkReady(status, true);
    if (!recorder) throw new Error("No recorder found. VibeForge records with pw-record (PipeWire), parec or arecord.");

    const ear: OpenEar = { child: null, echo: null, segmenter: new Segmenter({ detector: this.detector() }), deaf: false, skipped: false, lastLevelAt: 0 };
    this.ear = ear;
    const wantsEcho = cancelEcho && this.canCancelEcho(recorder);
    void (wantsEcho ? startEchoCancel({ resolveBin: this.opts.resolveBin, dir: path.join(this.opts.dataRoot, "voice"), log: this.opts.log }) : Promise.resolve(null))
      .catch(() => null)
      .then((echo) => {
        if (this.ear !== ear) {
          echo?.stop();
          return;
        }
        ear.echo = echo;
        this.record(ear, (echo && planRecorder(this.opts.resolveBin, undefined, echo.target)) || recorder, on);
      });
    this.opts.log.info(`Voice: a call is listening with ${recorder.label}${ear.segmenter.detects ? " and the speech detector" : ", by loudness"}`);
    // The model loads while the first thing is being said, and stays loaded for the call.
    this.warmRecognizer(status);
    return {
      deaf: (deaf) => {
        ear.deaf = deaf;
      },
      close: () => {
        if (this.ear !== ear) return;
        this.ear = null;
        this.closeEar(ear);
        this.opts.log.info("Voice: the call's microphone closed");
      },
      get detects() {
        return ear.segmenter.detects;
      },
      get cancelsEcho() {
        return Boolean(ear.echo?.running);
      },
    };
  }

  private closeEar(ear: OpenEar): void {
    if (ear.child && ear.child.exitCode === null && ear.child.signalCode === null) ear.child.kill("SIGTERM");
    ear.echo?.stop();
  }

  /** Starts a call's recorder and passes on what it hears. */
  private record(ear: OpenEar, recorder: Recorder, on: EarEvents): void {
    const child = spawn(recorder.argv[0], recorder.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    ear.child = child;
    let stderr = "";
    let failed = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.on("error", (error) => {
      failed = describeError(error);
    });
    child.on("close", (code) => {
      if (this.ear !== ear) return;
      this.ear = null;
      ear.echo?.stop();
      const why = failed || stderr.trim().split("\n").pop() || `${recorder.label} exited with code ${code}`;
      this.opts.log.warn(`Voice: the call's microphone closed: ${why}`);
      on.closed(why);
    });
    child.stdout?.on("data", (data: Buffer) => {
      if (this.ear !== ear) return;
      if (ear.deaf || this.recording) {
        if (!ear.skipped) {
          ear.skipped = true;
          ear.segmenter.reset();
          on.level(0, false, 0);
        }
        return;
      }
      ear.skipped = false;
      const heard = ear.segmenter.push(data);
      const now = Date.now();
      // What was said first, then the level: whoever listens knows it has something to answer
      // before it hears that the room went quiet.
      for (const pcm of heard.utterances) on.heard(pcm);
      if (heard.utterances.length || now - ear.lastLevelAt >= LEVEL_EVERY_MS) {
        ear.lastLevelAt = now;
        on.level(heard.level, heard.hearing, heard.speechMs);
      }
    });
  }

  // ---------------------------------------------------------------- whisper & sherpa-onnx

  private ensureServer(bin: string, model: string, language: string): Promise<void> {
    this.touchServer();
    const current = this.server;
    if (current && current.model === model && current.language === language && current.child.exitCode === null) return current.ready;
    this.stopServer();
    const server = { child: null as unknown as ChildProcess, port: 0, model, language, ready: Promise.resolve() };
    server.ready = (async () => {
      server.port = await freePort();
      const child = spawn(bin, serverArgs({ model, language, port: server.port, threads: whisperThreads(os.cpus().length) }), { stdio: ["ignore", "ignore", "pipe"] });
      server.child = child;
      let stderr = "";
      child.stderr?.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4000);
      });
      child.on("close", (code) => {
        if (this.server === server) this.server = null;
        if (code) this.opts.log.warn(`Voice: whisper-server exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
      });
      const started = Date.now();
      this.opts.log.info(`Voice: starting whisper-server with ${path.basename(model)}`);
      while (Date.now() - started < SERVER_READY_MS) {
        if (child.exitCode !== null) throw new Error(`whisper-server stopped: ${stderr.trim().split("\n").pop() ?? `exit code ${child.exitCode}`}`);
        try {
          const response = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            this.opts.log.info(`Voice: whisper-server ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
            return;
          }
        } catch {
          /* not listening yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("whisper-server did not start in time.");
    })();
    this.server = server;
    server.ready.catch(() => {
      if (this.server === server) this.stopServer();
    });
    return server.ready;
  }

  private ensureSherpaWorker(model: string, language: string): Promise<SherpaWorker> {
    this.touchServer();
    const current = this.sherpaWorker;
    if (current && current.model === model && current.language === language && current.child.exitCode === null) {
      return current.ready.then(() => current);
    }
    if (process.env.VIBEFORGE_SHERPA_NO_SERVER === "1") return Promise.reject(new Error("sherpa-onnx worker disabled"));
    const sherpa = this.sherpa();
    const python = this.opts.resolveBin("python3");
    if (!sherpa.cApiLib || !python) return Promise.reject(new Error("sherpa-onnx worker unavailable"));
    let names: string[];
    try {
      names = fs.readdirSync(model);
    } catch (error) {
      return Promise.reject(error);
    }
    const spec = resolveSherpaModel(model, names);
    if (!spec) return Promise.reject(new Error(`sherpa-onnx model incomplete at ${model}`));

    this.stopServer();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(sherpa.libDir ? { LD_LIBRARY_PATH: [sherpa.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    };
    const payload = JSON.stringify({ ...spec, cApiLib: sherpa.cApiLib, language, threads: whisperThreads(os.cpus().length) });
    const child = spawn(python, ["-u", "-c", SHERPA_WORKER_SCRIPT, payload], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuf = "";
    let closedError: Error | null = null;
    const queuedLines: string[] = [];
    const waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
    const failAll = (err: Error) => {
      closedError = err;
      while (waiters.length) waiters.shift()!.reject(err);
    };
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          const waiter = waiters.shift();
          if (waiter) waiter.resolve(line);
          else queuedLines.push(line);
        }
        nl = stdoutBuf.indexOf("\n");
      }
    });
    child.on("error", (err) => failAll(new Error(describeError(err))));
    child.on("close", (code) => {
      if (this.sherpaWorker === worker) this.sherpaWorker = null;
      failAll(new Error(`sherpa-onnx worker exited (${code ?? "?"}): ${stderr.trim().split("\n").pop() ?? ""}`));
    });
    const nextLine = (timeoutMs: number): Promise<string> => {
      if (queuedLines.length) return Promise.resolve(queuedLines.shift()!);
      if (closedError) return Promise.reject(closedError);
      return new Promise<string>((resolve, reject) => {
        const entry = {
          resolve: (line: string) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("sherpa-onnx worker timed out."));
        }, timeoutMs);
        waiters.push(entry);
      });
    };

    const started = Date.now();
    this.opts.log.info(`Voice: starting sherpa-onnx worker with ${path.basename(model)}`);
    const worker: SherpaWorker = {
      child,
      model,
      language,
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      send: async (wav: Buffer) => {
        const frame = Buffer.allocUnsafe(4 + wav.length);
        frame.writeUInt32LE(wav.length, 0);
        wav.copy(frame, 4);
        await new Promise<void>((resolve, reject) => child.stdin!.write(frame, (err) => (err ? reject(err) : resolve())));
        const line = await nextLine(TRANSCRIBE_TIMEOUT_MS);
        const parsed = JSON.parse(line) as { ok?: boolean; text?: unknown; error?: unknown };
        if (!parsed.ok) throw new Error(`sherpa-onnx: ${String(parsed.error ?? "failed")}`);
        return typeof parsed.text === "string" ? parsed.text : "";
      },
    };
    worker.ready = (async () => {
      const first = await nextLine(SERVER_READY_MS);
      const parsed = JSON.parse(first) as { ready?: boolean };
      if (!parsed.ready) throw new Error("sherpa-onnx worker did not report ready");
      this.opts.log.info(`Voice: sherpa-onnx ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    })();
    this.sherpaWorker = worker;
    worker.ready.catch(() => {
      if (this.sherpaWorker === worker) this.stopServer();
    });
    return worker.ready.then(() => worker);
  }

  private touchServer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // A recording (up to three minutes), an answer on its way or a call still needs it.
      if (this.recording || this.serverUses > 0 || this.ear) this.touchServer();
      else this.stopServer();
    }, this.opts.serverIdleMs ?? SERVER_IDLE_MS);
    this.idleTimer.unref();
  }

  private stopServer(): void {
    const server = this.server;
    this.server = null;
    if (server?.child && server.child.exitCode === null) server.child.kill("SIGTERM");
    const worker = this.sherpaWorker;
    this.sherpaWorker = null;
    if (worker?.child && worker.child.exitCode === null) worker.child.kill("SIGTERM");
  }

  private async viaServer(bin: string, model: string, language: string, pcm: Buffer, prompt: string): Promise<string> {
    await this.ensureServer(bin, model, language);
    const server = this.server!;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wavFile(pcm))], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    this.serverUses += 1;
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`whisper-server answered ${response.status}`);
      const json = (await response.json()) as { text?: unknown; error?: unknown };
      if (typeof json.error === "string") throw new Error(`whisper-server: ${json.error}`);
      return typeof json.text === "string" ? json.text : "";
    } finally {
      this.serverUses -= 1;
      this.touchServer();
    }
  }

  private async viaCli(bin: string, model: string, language: string, pcm: Buffer, prompt: string, seconds?: number): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const file = path.join(dir, "speech.wav");
    try {
      fs.writeFileSync(file, wavFile(pcm), { mode: 0o600 });
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, cliArgs({ model, file, language, prompt, threads: whisperThreads(os.cpus().length), seconds }), { stdio: ["ignore", "pipe", "pipe"] });
        this.cliRuns.set(child, dir);
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), TRANSCRIBE_TIMEOUT_MS);
        child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
        child.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-4000)));
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          this.cliRuns.delete(child);
          if (code === 0) resolve(stdout);
          else reject(new Error(`whisper-cli ${signal ? `was stopped (${signal})` : `exited with code ${code}`}: ${stderr.trim().split("\n").pop() ?? ""}`));
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async viaSherpa(model: string, language: string, pcm: Buffer): Promise<{ via: string; raw: string }> {
    const sherpa = this.sherpa();
    if (!sherpa.cli) throw new Error("sherpa-onnx is not installed. Settings → Voice can download it.");
    const wav = wavFile(pcm);
    let worker: SherpaWorker | null = null;
    try {
      worker = await this.ensureSherpaWorker(model, language);
    } catch {
      worker = null;
    }
    if (worker) {
      this.serverUses += 1;
      try {
        const job = worker.queue.then(() => worker!.send(wav));
        worker.queue = job.then(
          () => undefined,
          () => undefined,
        );
        return { via: "sherpa-onnx", raw: await job };
      } finally {
        this.serverUses -= 1;
        this.touchServer();
      }
    }
    return { via: "sherpa-onnx-offline", raw: await this.viaSherpaCli(sherpa, model, language, wav) };
  }

  private async viaSherpaCli(sherpa: SherpaRuntime, model: string, language: string, wav: Buffer): Promise<string> {
    const spec = resolveSherpaModel(model, fs.readdirSync(model));
    if (!spec) throw new Error(`The ONNX model at ${path.basename(model)} is incomplete.`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const file = path.join(dir, "speech.wav");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(sherpa.libDir ? { LD_LIBRARY_PATH: [sherpa.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    };
    try {
      fs.writeFileSync(file, wav, { mode: 0o600 });
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(sherpa.cli!, sherpaCliArgs(spec, { wavFile: file, language, threads: whisperThreads(os.cpus().length) }), {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.cliRuns.set(child, dir);
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), TRANSCRIBE_TIMEOUT_MS);
        child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
        child.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-8000)));
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          this.cliRuns.delete(child);
          if (code === 0) resolve(parseSherpaOutput(`${stdout}\n${stderr}`));
          else reject(new Error(`sherpa-onnx-offline ${signal ? `was stopped (${signal})` : `exited with code ${code}`}: ${stderr.trim().split("\n").pop() ?? ""}`));
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- models

  /** Downloads a speech-to-text model (and sherpa-onnx when an ONNX model needs it) or a Piper voice; progress arrives as status changes. */
  startDownload(kind: DownloadKind, id: string): void {
    let sherpaArchive: string | null = null;
    const files: Download[] | null =
      kind === "model"
        ? (() => {
            const choice = MODEL_CATALOG.find((item) => item.id === id);
            if (!choice) return null;
            const list: Download[] = modelFiles(choice).map((part) => ({
              url: part.url,
              target: path.join(this.modelDir(), part.relPath),
              bytes: part.bytes,
              sha256: part.sha256,
            }));
            if (choice.backend === "sherpa" && !this.sherpa().cli) {
              const build = SHERPA_PIN.builds[process.arch];
              if (!build) throw new Error(`sherpa-onnx ${SHERPA_PIN.version} is not available for ${process.arch}.`);
              sherpaArchive = path.join(this.opts.dataRoot, build.file);
              list.push({ url: build.url, target: sherpaArchive, bytes: build.bytes, sha256: build.sha256 });
            }
            return list;
          })()
        : kind === "sherpa"
          ? (() => {
              const build = SHERPA_PIN.builds[process.arch];
              if (!build) return null;
              sherpaArchive = path.join(this.opts.dataRoot, build.file);
              return [{ url: build.url, target: sherpaArchive, bytes: build.bytes, sha256: build.sha256 }];
            })()
          : (() => {
              const choice = VOICE_CATALOG.find((item) => item.id === id);
              if (!choice) return null;
              const urls = voiceUrls(choice);
              const base = path.join(this.voiceDir(), `${choice.id}.onnx`);
              return [
                { url: urls.model, target: base, ...choice.model },
                { url: urls.config, target: `${base}.json`, ...choice.config },
              ];
            })();
    if (!files) throw new Error(`Unknown ${kind} ${id}`);
    if (this.download) throw new Error("Something is already downloading.");
    const abort = new AbortController();
    const download = { kind, id, received: 0, total: files.reduce((sum, file) => sum + file.bytes, 0), abort };
    this.download = download;
    this.downloadError = null;
    this.opts.changed();
    let lastChanged = 0;
    this.opts.log.info(`Voice: downloading ${kind} ${id}`);
    void downloadFiles(files, {
      signal: abort.signal,
      progress: (received, total) => {
        download.received = received;
        download.total = total;
        if (Date.now() - lastChanged > 400) {
          lastChanged = Date.now();
          this.opts.changed();
        }
      },
    })
      .then(async (bytes) => {
        if (sherpaArchive) {
          try {
            await unpackSherpaArchive(sherpaArchive, path.join(this.opts.dataRoot, "sherpa-onnx"), process.arch);
          } catch (error) {
            for (const file of files) fs.rmSync(file.target, { force: true });
            throw error;
          }
        }
        this.opts.log.info(`Voice: downloaded ${kind} ${id} (${Math.round(bytes / 1_000_000)} MB)`);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.downloadError = describeError(error).split("\n")[0];
        this.opts.log.warn(`Voice: downloading ${kind} ${id} failed: ${this.downloadError}`);
      })
      .finally(() => {
        if (sherpaArchive) fs.rmSync(sherpaArchive, { force: true });
        this.download = null;
        this.opts.changed();
      });
  }

  stopDownload(): void {
    this.download?.abort.abort();
  }

  dispose(): void {
    if (this.recording) {
      clearTimeout(this.recording.timer);
      this.recording.child.kill("SIGTERM");
      this.recording = null;
    }
    if (this.ear) {
      this.closeEar(this.ear);
      this.ear = null;
    }
    this.download?.abort.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopServer();
    this.speaker.dispose();
    // A quit mid-transcription: the recording is someone's voice, so it doesn't stay in /tmp.
    for (const [child, dir] of this.cliRuns) {
      child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.cliRuns.clear();
  }
}
