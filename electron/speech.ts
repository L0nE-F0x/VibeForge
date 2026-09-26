import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { describeError, type LogFile } from "../src/core/log.js";
import { findPiper, planPlayer, voiceRate, type Player } from "../src/core/voice.js";

interface Utterance {
  text: string;
  voice: string;
  resolve: () => void;
}

/**
 * Speaks with Piper: text in on stdin, raw audio out into pw-play (or paplay, or aplay). One thing
 * at a time, in order; `stop` silences the current one and drops the rest. Nothing is written to disk.
 */
export class Speaker {
  private queue: Utterance[] = [];
  private current: { piper: ChildProcess; player: ChildProcess; item: Utterance } | null = null;

  constructor(
    private readonly opts: {
      log: LogFile;
      resolveBin: (bin: string) => string | null;
      /** Speaking started (with what) or stopped (null). */
      speaking: (text: string | null) => void;
    },
  ) {}

  piper(): string | null {
    return findPiper(this.opts.resolveBin, process.env.VIBEFORGE_PIPER);
  }

  player(): Player | null {
    return planPlayer(this.opts.resolveBin, process.env.VIBEFORGE_VOICE_PLAYER);
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Resolves once this text has been spoken, or dropped by `stop`. */
  speak(text: string, voice: string): Promise<void> {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ text: line, voice, resolve });
      if (!this.current) this.next();
    });
  }

  stop(): void {
    const dropped = this.queue.splice(0);
    for (const item of dropped) item.resolve();
    const current = this.current;
    if (!current) return;
    current.piper.kill("SIGTERM");
    current.player.kill("SIGTERM");
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
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
    let rate = 22_050;
    try {
      rate = voiceRate(JSON.parse(fs.readFileSync(`${item.voice}.json`, "utf8")));
    } catch {
      /* Piper's usual rate */
    }
    const synth = spawn(piper, ["-m", item.voice, "--output-raw", "--sentence-silence", "0.25"], { stdio: ["pipe", "pipe", "pipe"] });
    const argv = player.argv(rate);
    const play = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    this.current = { piper: synth, player: play, item };
    let stderr = "";
    synth.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-2000)));
    synth.stdout?.pipe(play.stdin!);
    play.stdin?.on("error", () => undefined);
    synth.stdin?.on("error", () => undefined);
    synth.on("error", (error) => this.opts.log.warn(`Voice: Piper failed to start: ${describeError(error)}`));
    play.on("error", (error) => this.opts.log.warn(`Voice: ${player.label} failed to start: ${describeError(error)}`));
    synth.on("close", (code, signal) => {
      if (code && !signal) this.opts.log.warn(`Voice: Piper exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (synth.exitCode === null && synth.signalCode === null) synth.kill("SIGTERM");
      this.current = null;
      item.resolve();
      this.next();
    };
    play.on("close", end);
    play.on("error", end);
    this.opts.speaking(item.text);
    synth.stdin?.end(`${item.text}\n`);
  }

  dispose(): void {
    this.stop();
  }
}
