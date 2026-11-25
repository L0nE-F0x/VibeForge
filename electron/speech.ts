import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { describeError, type LogFile } from "../src/core/log.js";
import { splitForSpeech } from "../src/core/replies.js";
import { findPiper, planPlayer, voiceRate, type Player } from "../src/core/voice.js";

export interface SpeechProgress {
  text: string;
  startedAt: number;
  durationMs: number;
}

interface Utterance {
  text: string;
  voice: string;
  resolve: () => void;
}

interface StandbyPiper {
  piper: ChildProcess;
  voice: string;
  stderr: string;
  dead: boolean;
}

interface PrefetchedUtterance {
  item: Utterance;
  rate: number;
  synth: ChildProcess;
  getStderr: () => string;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  onData: (() => void) | null;
  onEnd: (() => void) | null;
}

const WARM_IDLE_MS = 2 * 60 * 1000;

/**
 * Speaks with Piper: text in on stdin, raw audio out into pw-play (or paplay, or aplay). One thing
 * at a time, in order; `stop` silences the current one and drops the rest. Nothing is written to disk.
 *
 * During a call (`warm`), one standby Piper process with its voice model already loaded waits for
 * the next line (~45 ms to first audio instead of ~800 ms cold), and ends when the call does.
 */
export class Speaker {
  private queue: Utterance[] = [];
  private current: { piper: ChildProcess; player: ChildProcess; item: Utterance } | null = null;
  private standby: StandbyPiper | null = null;
  private prefetched: PrefetchedUtterance | null = null;
  private readonly rates = new Map<string, number>();
  private keepWarm = false;
  private warmTimer: NodeJS.Timeout | null = null;
  private progressListener: ((info: SpeechProgress | null) => void) | null = null;

  constructor(
    private readonly opts: {
      log: LogFile;
      resolveBin: (bin: string) => string | null;
      /** Speaking started (with what) or stopped (null). */
      speaking: (text: string | null) => void;
    },
  ) {}

  /** Subscribe to audio playback timing (first audio arrival + total synthesized duration). */
  progress(listener: ((info: SpeechProgress | null) => void) | null): void {
    this.progressListener = listener;
  }

  piper(): string | null {
    return findPiper(this.opts.resolveBin, process.env.VIBEFORGE_PIPER);
  }

  player(): Player | null {
    return planPlayer(this.opts.resolveBin, process.env.VIBEFORGE_VOICE_PLAYER);
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Resolves once all sentence chunks have been spoken, or dropped by `stop`. */
  speak(text: string, voice: string): Promise<void> {
    const chunks = splitForSpeech(text);
    if (!chunks.length) return Promise.resolve();
    const promises = chunks.map(
      (chunk) =>
        new Promise<void>((resolve) => {
          this.queue.push({ text: chunk, voice, resolve });
        }),
    );
    if (!this.current) this.next();
    return Promise.all(promises).then(() => undefined);
  }

  stop(): void {
    const dropped = this.queue.splice(0);
    for (const item of dropped) item.resolve();
    this.dropPrefetched();
    const current = this.current;
    if (!current) return;
    current.piper.kill("SIGTERM");
    current.player.kill("SIGTERM");
  }

  /** Pre-load `voice` in a standby Piper process so the next utterance starts speaking immediately. */
  warm(voice: string): void {
    const piper = this.piper();
    if (!piper || !voice) return;
    this.keepWarm = true;
    this.touchWarm();
    if (this.standby && this.standby.voice === voice && !this.standby.dead && this.standby.piper.exitCode === null && this.standby.piper.signalCode === null) return;
    this.dropStandby();
    this.spawnStandby(piper, voice);
  }

  /** Let the standby Piper process go (when a call ends, or after going unused). */
  unwarm(): void {
    this.keepWarm = false;
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
    this.dropStandby();
  }

  private touchWarm(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      if (this.current) this.touchWarm();
      else this.unwarm();
    }, WARM_IDLE_MS);
    this.warmTimer.unref();
  }

  private spawnStandby(piper: string, voice: string): void {
    const child = spawn(piper, ["-m", voice, "--output-raw", "--sentence-silence", "0.25"], { stdio: ["pipe", "pipe", "pipe"] });
    const entry: StandbyPiper = { piper: child, voice, stderr: "", dead: false };
    child.stderr?.on("data", (data: Buffer) => (entry.stderr = (entry.stderr + data.toString()).slice(-2000)));
    child.stdin?.on("error", () => undefined);
    child.on("error", () => {
      entry.dead = true;
    });
    child.on("close", () => {
      entry.dead = true;
      if (this.standby === entry) this.standby = null;
    });
    this.standby = entry;
  }

  private dropStandby(): void {
    const entry = this.standby;
    this.standby = null;
    if (entry && !entry.dead && entry.piper.exitCode === null && entry.piper.signalCode === null) entry.piper.kill("SIGTERM");
  }

  private dropPrefetched(): void {
    const entry = this.prefetched;
    this.prefetched = null;
    if (!entry) return;
    entry.onData = null;
    entry.onEnd = null;
    if (entry.synth.exitCode === null && entry.synth.signalCode === null) entry.synth.kill("SIGTERM");
  }

  private readVoiceRate(voice: string): number {
    const cached = this.rates.get(voice);
    if (cached !== undefined) return cached;
    let rate = 22_050;
    try {
      rate = voiceRate(JSON.parse(fs.readFileSync(`${voice}.json`, "utf8")));
    } catch {
      /* Piper's usual rate */
    }
    this.rates.set(voice, rate);
    return rate;
  }

  private startPrefetch(piper: string, upcoming: Utterance): void {
    if (this.prefetched?.item === upcoming) return;
    this.dropPrefetched();
    const rate = this.readVoiceRate(upcoming.voice);
    const { child: synth, getStderr } = this.takeStandby(piper, upcoming.voice);
    const entry: PrefetchedUtterance = {
      item: upcoming,
      rate,
      synth,
      getStderr,
      chunks: [],
      bytes: 0,
      done: false,
      onData: null,
      onEnd: null,
    };
    this.prefetched = entry;
    synth.stdout?.on("data", (chunk: Buffer) => {
      if (this.prefetched !== entry && !entry.onData) return;
      entry.chunks.push(chunk);
      entry.bytes += chunk.length;
      entry.onData?.();
    });
    synth.stdout?.on("end", () => {
      entry.done = true;
      entry.onEnd?.();
    });
    synth.on("error", (error) => this.opts.log.warn(`Voice: Piper failed to start: ${describeError(error)}`));
    synth.on("close", (code, signal) => {
      entry.done = true;
      if (code && !signal) this.opts.log.warn(`Voice: Piper exited with code ${code}: ${getStderr().trim().split("\n").pop() ?? ""}`);
      entry.onEnd?.();
    });
    synth.stdin?.end(`${upcoming.text}\n`);
  }

  private takeStandby(piper: string, voice: string): { child: ChildProcess; getStderr: () => string } {
    const ready = this.standby;
    if (ready && ready.voice === voice && !ready.dead && ready.piper.exitCode === null && ready.piper.signalCode === null) {
      this.standby = null;
      if (this.keepWarm) {
        this.touchWarm();
        this.spawnStandby(piper, voice);
      }
      return { child: ready.piper, getStderr: () => ready.stderr };
    }
    this.dropStandby();
    const synth = spawn(piper, ["-m", voice, "--output-raw", "--sentence-silence", "0.25"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    synth.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-2000)));
    synth.stdin?.on("error", () => undefined);
    if (this.keepWarm) {
      this.touchWarm();
      this.spawnStandby(piper, voice);
    }
    return { child: synth, getStderr: () => stderr };
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.dropPrefetched();
      this.opts.speaking(null);
      return;
    }
    const piper = this.piper();
    const player = this.player();
    if (!piper || !player) {
      this.opts.log.warn(`Voice: cannot speak, ${piper ? "no audio player" : "Piper is not installed"}`);
      item.resolve();
      this.next();
      return;
    }
    const prefetched = this.prefetched?.item === item ? this.prefetched : null;
    if (prefetched) this.prefetched = null;
    else this.dropPrefetched();

    const rate = prefetched ? prefetched.rate : this.readVoiceRate(item.voice);
    const argv = player.argv(rate);
    const play = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    play.stdin?.on("error", () => undefined);
    play.on("error", (error) => this.opts.log.warn(`Voice: ${player.label} failed to start: ${describeError(error)}`));

    let synth: ChildProcess;
    let ended = false;
    let startedAt = 0;

    if (prefetched) {
      synth = prefetched.synth;
      this.current = { piper: synth, player: play, item };
      let flushed = 0;
      const flush = () => {
        if (ended) return;
        while (flushed < prefetched.chunks.length) {
          const chunk = prefetched.chunks[flushed++];
          if (!startedAt) {
            startedAt = Date.now();
            this.progressListener?.({ text: item.text, startedAt, durationMs: 0 });
          }
          play.stdin?.write(chunk);
        }
        if (prefetched.done) {
          if (startedAt) {
            const durationMs = Math.max(180, Math.round((prefetched.bytes / (rate * 2)) * 1000));
            this.progressListener?.({ text: item.text, startedAt, durationMs });
          }
          play.stdin?.end();
        }
      };
      prefetched.onData = flush;
      prefetched.onEnd = flush;
      flush();
    } else {
      const taken = this.takeStandby(piper, item.voice);
      synth = taken.child;
      const getStderr = taken.getStderr;
      this.current = { piper: synth, player: play, item };
      let bytes = 0;
      synth.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (!startedAt && !ended) {
          startedAt = Date.now();
          this.progressListener?.({ text: item.text, startedAt, durationMs: 0 });
        }
      });
      synth.stdout?.on("end", () => {
        if (startedAt && !ended) {
          const durationMs = Math.max(180, Math.round((bytes / (rate * 2)) * 1000));
          this.progressListener?.({ text: item.text, startedAt, durationMs });
        }
      });
      synth.stdout?.pipe(play.stdin!);
      synth.on("error", (error) => this.opts.log.warn(`Voice: Piper failed to start: ${describeError(error)}`));
      synth.on("close", (code, signal) => {
        if (code && !signal) this.opts.log.warn(`Voice: Piper exited with code ${code}: ${getStderr().trim().split("\n").pop() ?? ""}`);
      });
      synth.stdin?.end(`${item.text}\n`);
    }

    // Look ahead: synthesize sentence chunk N+1 in parallel while chunk N plays.
    if (this.queue.length > 0) this.startPrefetch(piper, this.queue[0]);

    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(safety);
      this.progressListener?.(null);
      if (synth.exitCode === null && synth.signalCode === null) synth.kill("SIGTERM");
      this.current = null;
      item.resolve();
      this.next();
    };
    const maxPlayMs = Math.max(20_000, item.text.length * 300);
    const safety = setTimeout(() => {
      this.opts.log.warn(`Voice: ${player.label} playback timed out after ${Math.round(maxPlayMs / 1000)} s`);
      if (play.exitCode === null && play.signalCode === null) play.kill("SIGTERM");
      end();
    }, maxPlayMs);
    safety.unref?.();
    play.on("close", end);
    play.on("error", end);
    this.opts.speaking(item.text);
  }

  dispose(): void {
    this.unwarm();
    this.stop();
  }
}
