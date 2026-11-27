import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalServerPlan, LocalServerProblem, LocalServerState } from "../shared/local.js";

// The Local AI server VibeForge starts from Settings → Local AI (llama.cpp, Ollama, LM Studio or a
// command of your own): one at a time, in its own process group, ended when VibeForge quits.

/** How many of its last lines the card can show. */
const LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
/** A model that loads as the server starts (a launch script) can take a while off a slow disk. */
const READY_WITHIN_MS = 180_000;
const POLL_MS = 750;
/** How long it has to end after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 4000;

const IDLE: LocalServerState = { status: "stopped", url: null, shown: null, pid: null, since: null, problem: null, detail: null, log: [] };

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface LocalServerRunnerOptions {
  /** Where everything it prints is written too, fresh on each start. */
  logFile: string;
  /** Whether a Local AI server answers at this address. */
  probe: (url: string) => Promise<boolean>;
  onChange: () => void;
  /** Once it answers, with the address it answers at. */
  onReady?: (url: string) => void;
  spawn?: typeof nodeSpawn;
  now?: () => Date;
  readyWithinMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
}

export class LocalServerRunner {
  private state: LocalServerState = IDLE;
  private plan: LocalServerPlan | null = null;
  private child: ChildProcess | null = null;
  /** Resolves when the process VibeForge started has ended. */
  private ended: Promise<void> = Promise.resolve();
  /** Bumped by every start and stop, so what an older one was waiting for is let go. */
  private generation = 0;
  private stopping: Promise<LocalServerState> | null = null;
  private lines: string[] = [];
  private partial = "";
  private logStream: fs.WriteStream | null = null;

  constructor(private readonly options: LocalServerRunnerOptions) {}

  view(): LocalServerState {
    return { ...this.state, log: [...this.lines] };
  }

  /** It is starting or running. */
  isUp(): boolean {
    return this.state.status === "starting" || this.state.status === "running";
  }

  /** Settings that can't start a server: said on the card instead of the last start's outcome. */
  refuse(problem: LocalServerProblem): LocalServerState {
    if (this.isUp() || this.state.status === "stopping") return this.view();
    this.set({ ...IDLE, status: "failed", problem });
    return this.view();
  }

  async start(plan: LocalServerPlan): Promise<LocalServerState> {
    if (this.stopping) await this.stopping;
    if (this.isUp()) return this.view();
    if (await this.options.probe(plan.url)) {
      // Something already answers there: one VibeForge didn't start, or one started outside it.
      this.set({ ...IDLE, status: "failed", url: plan.url, shown: plan.shown, problem: "busy", detail: plan.url });
      return this.view();
    }
    const generation = ++this.generation;
    this.plan = plan;
    this.lines = [];
    this.partial = "";
    this.openLog(plan);
    const now = (this.options.now ?? (() => new Date()))();
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? nodeSpawn)(plan.bin, plan.args, {
        cwd: os.homedir(),
        env: { ...process.env, ...plan.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      this.closeLog();
      this.set({ ...IDLE, status: "failed", url: plan.url, shown: plan.shown, problem: "spawn", detail: error instanceof Error ? error.message : String(error) });
      return this.view();
    }
    this.child = child;
    this.ended = new Promise((resolve) => child.once("close", () => resolve()));
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.take(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => this.take(chunk));
    child.once("error", (error) => {
      if (this.child === child) this.child = null;
      if (generation !== this.generation) return;
      this.closeLog();
      this.set({ ...this.state, status: "failed", pid: null, problem: "spawn", detail: error.message });
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (generation !== this.generation) return;
      // `lms server start` ends once LM Studio's server runs on its own: that's not a failure.
      if (plan.oneShot && code === 0) {
        this.set({ ...this.state, pid: null });
        return;
      }
      this.flushPartial();
      this.closeLog();
      this.set({ ...this.state, status: "failed", pid: null, problem: "exited", detail: signal ?? String(code ?? "") });
    });
    this.set({ status: "starting", url: plan.url, shown: plan.shown, pid: child.pid ?? null, since: now.toISOString(), problem: null, detail: null, log: [] });
    void this.waitReady(generation, plan);
    return this.view();
  }

  /** Ends the server VibeForge started; a server it didn't start is left alone. */
  stop(): Promise<LocalServerState> {
    if (this.stopping) return this.stopping;
    if (!this.isUp() && !this.child) return Promise.resolve(this.view());
    this.generation += 1;
    this.set({ ...this.state, status: "stopping" });
    this.stopping = this.endIt().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** VibeForge is going: end it without waiting. */
  dispose(): void {
    this.generation += 1;
    const plan = this.plan;
    if (this.child) this.signal(this.child, "SIGTERM");
    if (plan?.stop && this.isUp()) {
      try {
        (this.options.spawn ?? nodeSpawn)(plan.stop.bin, plan.stop.args, { stdio: "ignore", detached: true }).unref();
      } catch {
        /* going anyway */
      }
    }
    this.closeLog();
  }

  private async endIt(): Promise<LocalServerState> {
    const plan = this.plan;
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    if (plan?.stop) await this.runQuietly(plan.stop.bin, plan.stop.args, grace);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.signal(child, "SIGTERM");
      const ended = await Promise.race([this.ended.then(() => true), delay(grace).then(() => false)]);
      if (!ended) {
        this.signal(child, "SIGKILL");
        await Promise.race([this.ended, delay(1000)]);
      }
    }
    this.child = null;
    this.flushPartial();
    this.closeLog();
    this.set({ ...this.state, status: "stopped", pid: null, problem: null, detail: null });
    return this.view();
  }

  private async waitReady(generation: number, plan: LocalServerPlan): Promise<void> {
    const deadline = Date.now() + (this.options.readyWithinMs ?? READY_WITHIN_MS);
    const poll = this.options.pollMs ?? POLL_MS;
    while (generation === this.generation && this.state.status === "starting") {
      if (await this.options.probe(plan.url)) {
        if (generation !== this.generation || this.state.status !== "starting") return;
        this.set({ ...this.state, status: "running" });
        this.options.onReady?.(plan.url);
        return;
      }
      if (Date.now() >= deadline) {
        await this.stop();
        this.set({ ...this.state, status: "failed", problem: "timeout", detail: plan.url });
        return;
      }
      await delay(poll);
    }
  }

  private runQuietly(bin: string, args: string[], withinMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        const child = (this.options.spawn ?? nodeSpawn)(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.take(chunk));
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => this.take(chunk));
        child.once("error", finish);
        child.once("close", finish);
      } catch {
        finish();
      }
      setTimeout(finish, withinMs).unref?.();
    });
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      // Its whole group: a launch script's llama-server goes with it.
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }

  private take(chunk: string): void {
    this.logStream?.write(chunk);
    const text = this.partial + chunk.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
    const parts = text.split(/\r?\n/);
    this.partial = (parts.pop() ?? "").slice(0, LOG_LINE_CHARS);
    if (!parts.length) return;
    for (const line of parts) if (line.trim()) this.lines.push(line.slice(0, LOG_LINE_CHARS));
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    this.options.onChange();
  }

  private flushPartial(): void {
    if (!this.partial.trim()) return;
    this.lines.push(this.partial);
    this.partial = "";
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
  }

  private openLog(plan: LocalServerPlan): void {
    this.closeLog();
    try {
      fs.mkdirSync(path.dirname(this.options.logFile), { recursive: true });
      const stream = fs.createWriteStream(this.options.logFile, { flags: "w" });
      stream.on("error", () => {
        if (this.logStream === stream) this.logStream = null;
      });
      stream.write(`$ ${plan.shown}\n`);
      this.logStream = stream;
    } catch {
      this.logStream = null;
    }
  }

  private closeLog(): void {
    const stream = this.logStream;
    this.logStream = null;
    stream?.end();
  }

  private set(next: LocalServerState): void {
    this.state = { ...next, log: [] };
    this.options.onChange();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
