import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hyprlandBindings } from "../src/core/control.js";
import { describeError, type LogFile } from "../src/core/log.js";
import type { VoiceSettings } from "../src/core/types.js";
import {
  BYTES_PER_SECOND,
  cleanTranscript,
  Endpointer,
  FRAME_BYTES,
  isVoiceFile,
  pickVoice,
  VOICE_CATALOG,
  voiceDirs,
  voiceName,
  voiceUrls,
  cliArgs,
  findWhisper,
  isModelFile,
  listenLanguage,
  MAX_SECONDS,
  meterLevel,
  MIN_SECONDS,
  MODEL_CATALOG,
  modelDirs,
  modelRank,
  modelUrl,
  peakLoudness,
  pickModel,
  planRecorder,
  rms,
  serverArgs,
  SILENCE_RMS,
  wavFile,
  whisperThreads,
  type Recorder,
} from "../src/core/voice.js";
import type { Dictation, DownloadKind, VoiceState, VoiceStatus } from "../src/shared/api.js";
import { downloadFiles } from "./download.js";
import { Speaker } from "./speech.js";

const LEVEL_EVERY_MS = 60;
/** whisper-server is stopped after this long without a recording, to give its memory back. */
const SERVER_IDLE_MS = 10 * 60 * 1000;
const SERVER_READY_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

interface Server {
  child: ChildProcess;
  port: number;
  model: string;
  language: string;
  ready: Promise<void>;
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
  /** Conversation mode: listens for the end of a sentence. */
  endpointer: Endpointer | null;
  /** Audio not yet measured as a whole frame. */
  pending: Buffer;
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
  private idleTimer: NodeJS.Timeout | null = null;
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

  private modelDir(): string {
    return path.join(this.opts.dataRoot, "models");
  }

  private findModels(): string[] {
    const found: string[] = [];
    for (const dir of modelDirs(this.opts.home, this.opts.dataRoot)) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        if (!isModelFile(name) || found.some((other) => path.basename(other) === name)) continue;
        try {
          if (fs.statSync(file).size > 1_000_000) found.push(file);
        } catch {
          /* gone since the listing */
        }
      }
    }
    return found.sort((a, b) => modelRank(b) - modelRank(a) || a.localeCompare(b));
  }

  private voiceDir(): string {
    return path.join(this.opts.dataRoot, "voices");
  }

  /** Piper voices: .onnx files with their .onnx.json, up to three folders deep (the AUR nests them by language). */
  findVoices(): string[] {
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
    for (const dir of voiceDirs(this.opts.home, this.opts.dataRoot)) walk(dir, 0);
    return found.sort((a, b) => voiceName(a).localeCompare(voiceName(b)));
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

  status(): VoiceStatus {
    const settings = this.opts.settings();
    const whisper = this.whisper();
    const models = this.findModels();
    const model = pickModel(models, settings.model, settings.language);
    const recorder = this.recorder();
    const voices = this.findVoices();
    return {
      recorder: recorder?.label ?? null,
      server: whisper.server,
      cli: whisper.cli,
      model,
      models,
      modelDir: this.modelDir(),
      language: model ? listenLanguage(model, settings.language) : settings.language,
      ready: Boolean(recorder && (whisper.server || whisper.cli) && model),
      catalog: MODEL_CATALOG.map((choice) => ({ ...choice, path: models.find((file) => path.basename(file) === choice.file) ?? null })),
      download: this.download ? { kind: this.download.kind, id: this.download.id, received: this.download.received, total: this.download.total } : null,
      downloadError: this.downloadError,
      piper: this.speaker.piper(),
      player: this.speaker.player()?.label ?? null,
      voices,
      speaker: this.voiceFor(),
      voiceDir: this.voiceDir(),
      voiceCatalog: VOICE_CATALOG.map((choice) => ({ ...choice, path: voices.find((file) => voiceName(file) === choice.id) ?? null })),
      speaking: this.speaker.busy,
      controlSocket: this.opts.controlSocket,
      hyprland: this.hyprland(),
    };
  }

  // ---------------------------------------------------------------- recording

  start(opts: { endpoint?: boolean } = {}): void {
    if (this.recording) return;
    // Talking over an answer silences it.
    this.speaker.stop();
    if (this.transcribing) throw new Error("Still turning the last recording into text.");
    const status = this.status();
    const recorder = this.recorder();
    if (!recorder) throw new Error("No recorder found. VibeForge records with pw-record (PipeWire), parec or arecord.");
    if (!status.server && !status.cli) throw new Error("whisper.cpp is not installed. Settings → Voice shows how to add it.");
    if (!status.model) throw new Error("No whisper model found. Settings → Voice can download one.");

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
      endpointer: opts.endpoint ? new Endpointer() : null,
      pending: Buffer.alloc(0),
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
      let changed = false;
      if (recording.endpointer) {
        const before = recording.endpointer.phase;
        let audio = recording.pending.length ? Buffer.concat([recording.pending, data]) : data;
        while (audio.length >= FRAME_BYTES) {
          recording.endpointer.push(rms(audio, 0, FRAME_BYTES), 30);
          audio = audio.subarray(FRAME_BYTES);
        }
        recording.pending = Buffer.from(audio);
        changed = recording.endpointer.phase !== before;
      }
      const now = Date.now();
      if (!changed && now - recording.lastLevelAt < LEVEL_EVERY_MS) return;
      recording.lastLevelAt = now;
      this.opts.state({ phase: "recording", level: meterLevel(rms(data)), seconds: recording.bytes / BYTES_PER_SECOND, speech: recording.endpointer?.phase ?? null });
    });
    this.opts.state({ phase: "recording", level: 0, seconds: 0, speech: recording.endpointer ? "waiting" : null });
    this.opts.log.info(`Voice: recording with ${recorder.label}`);
    // Loading a model takes a moment; do it while the person talks.
    if (status.server) void this.ensureServer(status.server, status.model, status.language).catch(() => undefined);
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
      const status = this.status();
      if (!status.model) throw new Error("The whisper model is gone. Settings → Voice can download one.");
      const via = status.server ? "whisper-server" : "whisper-cli";
      const raw = status.server
        ? await this.viaServer(status.server, status.model, status.language, pcm, prompt)
        : await this.viaCli(status.cli!, status.model, status.language, pcm, prompt);
      const text = cleanTranscript(raw);
      const done = result(text ? null : "nothing", text);
      this.opts.log.info(`Voice: ${seconds.toFixed(1)} s transcribed in ${(done.tookMs / 1000).toFixed(1)} s by ${via} with ${path.basename(status.model)}`);
      return done;
    } catch (error) {
      this.opts.log.warn(`Voice: transcription failed: ${describeError(error).split("\n")[0]}`);
      throw error;
    } finally {
      this.transcribing = false;
      this.opts.state({ phase: "idle", level: 0, seconds: 0, speech: null });
    }
  }

  // ---------------------------------------------------------------- whisper

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

  private touchServer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopServer(), SERVER_IDLE_MS);
    this.idleTimer.unref();
  }

  private stopServer(): void {
    const server = this.server;
    this.server = null;
    if (server?.child && server.child.exitCode === null) server.child.kill("SIGTERM");
  }

  private async viaServer(bin: string, model: string, language: string, pcm: Buffer, prompt: string): Promise<string> {
    await this.ensureServer(bin, model, language);
    const server = this.server!;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wavFile(pcm))], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    const response = await fetch(`http://127.0.0.1:${server.port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`whisper-server answered ${response.status}`);
    const json = (await response.json()) as { text?: unknown; error?: unknown };
    if (typeof json.error === "string") throw new Error(`whisper-server: ${json.error}`);
    this.touchServer();
    return typeof json.text === "string" ? json.text : "";
  }

  private async viaCli(bin: string, model: string, language: string, pcm: Buffer, prompt: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const file = path.join(dir, "speech.wav");
    try {
      fs.writeFileSync(file, wavFile(pcm), { mode: 0o600 });
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, cliArgs({ model, file, language, prompt, threads: whisperThreads(os.cpus().length) }), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), TRANSCRIBE_TIMEOUT_MS);
        child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
        child.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-4000)));
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(new Error(`whisper-cli ${signal ? `was stopped (${signal})` : `exited with code ${code}`}: ${stderr.trim().split("\n").pop() ?? ""}`));
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- models

  /** Downloads a whisper model or a Piper voice from Hugging Face; progress arrives as status changes. */
  startDownload(kind: DownloadKind, id: string): void {
    const files =
      kind === "model"
        ? (() => {
            const choice = MODEL_CATALOG.find((item) => item.id === id);
            return choice ? { mb: choice.mb, list: [{ url: modelUrl(choice), target: path.join(this.modelDir(), choice.file) }] } : null;
          })()
        : (() => {
            const choice = VOICE_CATALOG.find((item) => item.id === id);
            if (!choice) return null;
            const urls = voiceUrls(choice);
            const base = path.join(this.voiceDir(), `${choice.id}.onnx`);
            return { mb: choice.mb, list: [{ url: urls.model, target: base }, { url: urls.config, target: `${base}.json` }] };
          })();
    if (!files) throw new Error(`Unknown ${kind} ${id}`);
    if (this.download) throw new Error("Something is already downloading.");
    const abort = new AbortController();
    const download = { kind, id, received: 0, total: files.mb * 1_000_000, abort };
    this.download = download;
    this.downloadError = null;
    this.opts.changed();
    let lastChanged = 0;
    this.opts.log.info(`Voice: downloading ${kind} ${id}`);
    void downloadFiles(files.list, {
      signal: abort.signal,
      expected: download.total,
      progress: (received, total) => {
        download.received = received;
        download.total = total;
        if (Date.now() - lastChanged > 400) {
          lastChanged = Date.now();
          this.opts.changed();
        }
      },
    })
      .then((bytes) => this.opts.log.info(`Voice: downloaded ${kind} ${id} (${Math.round(bytes / 1_000_000)} MB)`))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.downloadError = describeError(error).split("\n")[0];
        this.opts.log.warn(`Voice: downloading ${kind} ${id} failed: ${this.downloadError}`);
      })
      .finally(() => {
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
    this.download?.abort.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopServer();
    this.speaker.dispose();
  }
}
