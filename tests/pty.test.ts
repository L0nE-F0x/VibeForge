import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

// Drives the shipped PTY host (electron/pty-host.cjs) over its JSON-lines protocol with
// plain bash. No model CLI is started.

type Message = Record<string, unknown>;

class Host {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<string, (msg: Message) => void>();
  private seq = 0;
  readonly events: Message[] = [];
  readonly ready: Promise<void>;

  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, "..", "electron", "pty-host.cjs")], {
      env: { ...process.env, PS1: "$ ", HISTFILE: "/dev/null" },
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    this.ready = new Promise((resolve) => {
      lines.on("line", (line) => {
        const msg = JSON.parse(line) as Message;
        if (msg.event === "ready") resolve();
        if (typeof msg.reqId === "string") this.waiting.get(msg.reqId)?.(msg);
        else this.events.push(msg);
      });
    });
  }

  request(body: Message): Promise<Message> {
    this.seq += 1;
    const reqId = `t${this.seq}`;
    return new Promise((resolve) => {
      this.waiting.set(reqId, resolve);
      this.child.stdin.write(`${JSON.stringify({ ...body, reqId })}\n`);
    });
  }

  async screen(ptyId: string): Promise<string> {
    const snap = await this.request({ op: "snapshot", ptyId });
    return String(snap.ansi).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }

  async until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  exitOf(ptyId: string): Message | undefined {
    return this.events.find((event) => event.event === "exit" && event.ptyId === ptyId);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.stdin.end();
    });
  }
}

const hosts: Host[] = [];
async function startHost(): Promise<Host> {
  const host = new Host();
  hosts.push(host);
  await host.ready;
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-pty-"));
}

const BASH = ["/bin/bash", "--norc", "--noprofile", "-i"];

describe("pty host", () => {
  it("keeps two terminals in their own folders and their input apart", async () => {
    const host = await startHost();
    const [a, b] = [tempDir(), tempDir()];
    const one = String((await host.request({ op: "spawn", cwd: a, argv: BASH })).ptyId);
    const two = String((await host.request({ op: "spawn", cwd: b, argv: BASH })).ptyId);
    await host.request({ op: "write", ptyId: one, data: "pwd; echo ONE-$((20+1))\r" });
    await host.request({ op: "write", ptyId: two, data: "pwd; echo TWO-$((20+2))\r" });
    await host.until(async () => (await host.screen(one)).includes("ONE-21") && (await host.screen(two)).includes("TWO-22"));
    const first = await host.screen(one);
    const second = await host.screen(two);
    expect(first).toContain(fs.realpathSync(a));
    expect(first).not.toContain("TWO-22");
    expect(second).toContain(fs.realpathSync(b));
    expect(second).not.toContain("ONE-21");
  });

  it("pastes a multi-line prompt once the program is quiet, then sends follow-ups", async () => {
    const host = await startHost();
    const dir = tempDir();
    const started = Date.now();
    const pty = String((await host.request({ op: "spawn", cwd: dir, argv: BASH, pasteInput: "echo FIRST-$((1+1))\necho SECOND-$((2+2))" })).ptyId);
    await host.until(async () => (await host.screen(pty)).includes("SECOND-4"));
    expect(Date.now() - started).toBeGreaterThan(500);
    const screen = await host.screen(pty);
    expect(screen).toContain("FIRST-2");
    await host.request({ op: "send", ptyId: pty, text: "echo FOLLOW-$((3+3))" });
    await host.until(async () => (await host.screen(pty)).includes("FOLLOW-6"));
  });

  it("hangs up the whole process group and leaves the run's terminal files behind", async () => {
    const host = await startHost();
    const dir = tempDir();
    const runDir = tempDir();
    const pty = String((await host.request({ op: "spawn", cwd: dir, argv: BASH, runDir })).ptyId);
    await host.request({ op: "write", ptyId: pty, data: "echo KEEP-ME; sleep 300 & echo SLEEPER=$!\r" });
    await host.until(async () => /SLEEPER=\d+/.test(await host.screen(pty)));
    const sleeper = Number((await host.screen(pty)).match(/SLEEPER=(\d+)/)![1]);
    const started = Date.now();
    await host.request({ op: "kill", ptyId: pty });
    await host.until(() => Boolean(host.exitOf(pty)));
    expect(Date.now() - started).toBeLessThan(4500);
    await host.until(() => {
      try {
        process.kill(sleeper, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(fs.readFileSync(path.join(runDir, "scrollback.txt"), "utf8")).toContain("KEEP-ME");
    expect(fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8")).toContain("KEEP-ME");
    expect(fs.readFileSync(path.join(runDir, "terminal.ansi"), "utf8")).toContain("KEEP-ME");
    expect((await host.request({ op: "snapshot", ptyId: pty })).alive).toBe(false);
    await expect(host.request({ op: "write", ptyId: pty, data: "x" })).resolves.toMatchObject({ ok: false, error: "That session has ended." });
  });

  it("reports a program's own exit code and rejects unknown requests", async () => {
    const host = await startHost();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/sh", "-c", "exit 3"] })).ptyId);
    await host.until(() => Boolean(host.exitOf(pty)));
    expect(host.exitOf(pty)).toMatchObject({ exitCode: 3 });
    await expect(host.request({ op: "teleport" })).resolves.toMatchObject({ ok: false, error: "Unknown op teleport" });
  });
});
