import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";

export interface PtyEventData {
  ptyId: string;
  data: string;
  seq: number;
}

export interface PtyEventExit {
  ptyId: string;
  exitCode: number | null;
  runDir: string | null;
  status: string;
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class PtySupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  readonly onDataHandlers: ((event: PtyEventData) => void)[] = [];
  readonly onExitHandlers: ((event: PtyEventExit) => void)[] = [];

  async start(root: string): Promise<void> {
    const node = process.env.FORGEDESK_NODE || execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    const script = path.join(root, "src", "pty", "server.js");
    this.child = spawn(node, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = readline.createInterface({ input: this.child.stdout });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The terminal server did not start.")), 8000);
      rl.on("line", (line) => {
        this.onLine(line);
        if (line.includes('"event":"ready"')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    this.child.on("exit", () => {
      for (const [id, waiter] of this.pending) {
        waiter.reject(new Error("The terminal server stopped."));
        this.pending.delete(id);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[pty] ${chunk.toString()}`);
    });
    await ready;
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.reqId === "string") {
      const waiter = this.pending.get(msg.reqId);
      if (!waiter) return;
      this.pending.delete(msg.reqId);
      if (msg.ok === false) waiter.reject(new Error(String(msg.error || "Terminal request failed.")));
      else waiter.resolve(msg);
      return;
    }
    if (msg.event === "data") {
      const event: PtyEventData = {
        ptyId: String(msg.ptyId),
        data: String(msg.data ?? ""),
        seq: Number(msg.seq ?? 0),
      };
      for (const handler of this.onDataHandlers) handler(event);
    }
    if (msg.event === "exit") {
      const event: PtyEventExit = {
        ptyId: String(msg.ptyId),
        exitCode: msg.exitCode == null ? null : Number(msg.exitCode),
        runDir: msg.runDir ? String(msg.runDir) : null,
        status: String(msg.status ?? "exited"),
      };
      for (const handler of this.onExitHandlers) handler(event);
    }
  }

  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.child) return Promise.reject(new Error("The terminal server is not running."));
    this.seq += 1;
    const reqId = `r${this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.child?.stdin.write(JSON.stringify({ ...body, reqId }) + "\n");
    });
  }

  spawn(opts: { cwd: string; argv?: string[]; cols?: number; rows?: number; runDir?: string | null }) {
    return this.request({ op: "spawn", ...opts });
  }

  startPrompted(opts: {
    dataRoot: string;
    cwd: string;
    argv: string[];
    preamble: string;
    origin: string;
    slug: string;
    meta: Record<string, unknown>;
    cols?: number;
    rows?: number;
  }) {
    return this.request({ op: "startPrompted", ...opts });
  }

  write(ptyId: string, data: string) {
    return this.request({ op: "write", ptyId, data });
  }

  resize(ptyId: string, cols: number, rows: number) {
    return this.request({ op: "resize", ptyId, cols, rows });
  }

  kill(ptyId: string, runDir?: string | null) {
    return this.request({ op: "kill", ptyId, runDir: runDir ?? null });
  }

  snapshot(ptyId: string) {
    return this.request({ op: "snapshot", ptyId });
  }

  list() {
    return this.request({ op: "list" });
  }

  shutdown(): void {
    this.child?.stdin.end();
    const child = this.child;
    setTimeout(() => {
      if (child && !child.killed) child.kill("SIGKILL");
    }, 1500).unref?.();
  }
}
