import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { whichBin } from "../src/core/engines.js";

export interface PtyData {
  ptyId: string;
  data: string;
  first: number;
  seq: number;
}

export interface PtyExit {
  ptyId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface PtySnapshot {
  ansi: string;
  seq: number;
  cols: number;
  rows: number;
  alive: boolean;
}

type Waiter = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

/**
 * Client for electron/pty-host.cjs. The host runs on the system Node, the one node-pty is
 * built for, and owns every terminal.
 */
export class PtySupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly waiting = new Map<string, Waiter>();
  private seq = 0;
  private stopping = false;
  readonly onData = new Set<(event: PtyData) => void>();
  readonly onExit = new Set<(event: PtyExit) => void>();
  readonly onCrash = new Set<(message: string) => void>();

  async start(appRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
    const node = process.env.VIBEFORGE_NODE || whichBin("node", env.PATH ?? "");
    if (!node) throw new Error("VibeForge needs Node on PATH to run terminals (node was not found).");
    const script = path.join(appRoot, "electron", "pty-host.cjs");
    const child = spawn(node, [script], { cwd: appRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The terminal host did not start within 10 seconds.")), 10_000);
      lines.on("line", (line) => {
        if (line.startsWith('{"event":"ready"')) {
          clearTimeout(timer);
          resolve();
          return;
        }
        this.onLine(line);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The terminal host exited during start (code ${code}).`));
      });
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[pty-host] ${chunk.toString()}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      for (const [id, waiter] of this.waiting) {
        waiter.reject(new Error("The terminal host stopped."));
        this.waiting.delete(id);
      }
      if (!this.stopping) for (const handler of this.onCrash) handler(`The terminal host stopped (${signal ?? code}).`);
    });
    await ready;
  }

  get running(): boolean {
    return this.child !== null;
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.reqId === "string") {
      const waiter = this.waiting.get(msg.reqId);
      if (!waiter) return;
      this.waiting.delete(msg.reqId);
      if (msg.ok === false) waiter.reject(new Error(String(msg.error || "Terminal request failed.")));
      else waiter.resolve(msg);
      return;
    }
    if (msg.event === "data") {
      const event: PtyData = {
        ptyId: String(msg.ptyId),
        data: String(msg.data ?? ""),
        first: Number(msg.first ?? 0),
        seq: Number(msg.seq ?? 0),
      };
      for (const handler of this.onData) handler(event);
    } else if (msg.event === "exit") {
      const event: PtyExit = {
        ptyId: String(msg.ptyId),
        exitCode: typeof msg.exitCode === "number" ? msg.exitCode : null,
        signal: typeof msg.signal === "number" && msg.signal > 0 ? msg.signal : null,
      };
      for (const handler of this.onExit) handler(event);
    }
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("The terminal host is not running. Restart VibeForge."));
    this.seq += 1;
    const reqId = `r${this.seq}`;
    return new Promise((resolve, reject) => {
      this.waiting.set(reqId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ ...body, reqId })}\n`);
    });
  }

  async spawn(opts: { cwd: string; argv: string[]; runDir: string | null; pasteInput: string | null; cols?: number; rows?: number }) {
    const result = await this.request({ op: "spawn", ...opts });
    return { ptyId: String(result.ptyId), pid: Number(result.pid) };
  }

  async write(ptyId: string, data: string): Promise<void> {
    await this.request({ op: "write", ptyId, data });
  }

  async send(ptyId: string, text: string): Promise<void> {
    await this.request({ op: "send", ptyId, text });
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.request({ op: "resize", ptyId, cols, rows });
  }

  async kill(ptyId: string): Promise<void> {
    await this.request({ op: "kill", ptyId });
  }

  async snapshot(ptyId: string): Promise<PtySnapshot> {
    const result = await this.request({ op: "snapshot", ptyId });
    return {
      ansi: String(result.ansi ?? ""),
      seq: Number(result.seq ?? 0),
      cols: Number(result.cols ?? 0),
      rows: Number(result.rows ?? 0),
      alive: Boolean(result.alive),
    };
  }

  /** Stop every session, let the host write their files, then end it. */
  async shutdown(timeoutMs = 7000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await Promise.race([this.request({ op: "shutdown" }), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    } catch {
      /* the host may already be gone */
    }
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(timer);
  }
}
