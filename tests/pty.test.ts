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
  private readonly lines: readline.Interface;
  private seq = 0;
  readonly events: Message[] = [];
  /** What each terminal printed, counted rather than kept: a flood would fill the test's memory. */
  readonly printed = new Map<string, number>();
  /** Terminals whose output is kept whole, with each batch's last number: see keep(). */
  readonly kept = new Map<string, Array<{ seq: number; data: string }>>();
  readonly ready: Promise<void>;

  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, "..", "electron", "pty-host.cjs")], {
      env: { ...process.env, PS1: "$ ", HISTFILE: "/dev/null" },
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    this.lines = lines;
    this.ready = new Promise((resolve) => {
      lines.on("line", (line) => {
        const msg = JSON.parse(line) as Message;
        if (msg.event === "ready") resolve();
        if (typeof msg.reqId === "string") this.waiting.get(msg.reqId)?.(msg);
        else if (msg.event === "data") {
          this.printed.set(String(msg.ptyId), (this.printed.get(String(msg.ptyId)) ?? 0) + String(msg.data).length);
          this.kept.get(String(msg.ptyId))?.push({ seq: Number(msg.seq), data: String(msg.data) });
        }
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

  /** Keep everything this terminal prints from now on. */
  keep(ptyId: string): void {
    this.kept.set(ptyId, []);
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

  /** Stop reading the host for a while, the way a busy Electron main process does. */
  async hold(ms: number): Promise<void> {
    this.lines.pause();
    this.child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.lines.resume();
    this.child.stdout.resume();
  }

  /** The host's peak memory so far, in MB (Linux). */
  peakMb(): number {
    const status = fs.readFileSync(`/proc/${this.child.pid}/status`, "utf8");
    return Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0) / 1024;
  }

  exitOf(ptyId: string): Message | undefined {
    return this.events.find((event) => event.event === "exit" && event.ptyId === ptyId);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      this.child.stdin.end();
    });
  }

  /** Sends the host a signal; how it ended. */
  signal(name: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
      this.child.kill(name);
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

  it("reads the foreground program at once, including the moment it leaves", async () => {
    const host = await startHost();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: BASH })).ptyId);
    const idle = await host.request({ op: "foreground", ptyId: pty });
    expect(idle).toMatchObject({ ok: true, known: true, argv: null });
    await host.request({ op: "write", ptyId: pty, data: "sleep 30\r" });
    await host.until(async () => {
      const now = await host.request({ op: "foreground", ptyId: pty });
      return Array.isArray(now.argv) && now.argv.some((arg) => String(arg).includes("sleep"));
    });
    await host.request({ op: "write", ptyId: pty, data: "\x03" });
    await host.until(async () => {
      const now = await host.request({ op: "foreground", ptyId: pty });
      return now.known === true && now.argv === null;
    });
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

  it("records part of a shell into a run folder, and writes a recording still open when it exits", async () => {
    const host = await startHost();
    const runDir = tempDir();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: BASH })).ptyId);
    await host.request({ op: "write", ptyId: pty, data: "echo BEFORE-$((1+1))\r" });
    await host.until(async () => (await host.screen(pty)).includes("BEFORE-2"));
    await host.request({ op: "record", ptyId: pty, runDir });
    await host.request({ op: "write", ptyId: pty, data: "echo DURING-$((2+2))\r" });
    await host.until(async () => (await host.screen(pty)).includes("DURING-4"));
    await host.request({ op: "record", ptyId: pty, runDir: null });
    await host.request({ op: "write", ptyId: pty, data: "echo AFTER-$((3+3))\r" });
    await host.until(async () => (await host.screen(pty)).includes("AFTER-6"));
    const scrollback = fs.readFileSync(path.join(runDir, "scrollback.txt"), "utf8");
    expect(scrollback).toContain("DURING-4");
    expect(scrollback).not.toContain("BEFORE-2");
    expect(scrollback).not.toContain("AFTER-6");
    // The transcript starts from what the screen showed when recording began.
    const transcript = fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8");
    expect(transcript).toContain("BEFORE-2");
    expect(transcript).toContain("DURING-4");
    expect(transcript).not.toContain("AFTER-6");

    const second = tempDir();
    await host.request({ op: "record", ptyId: pty, runDir: second });
    await host.request({ op: "write", ptyId: pty, data: "echo LAST-$((4+4)); exit\r" });
    await host.until(() => Boolean(host.exitOf(pty)));
    expect(fs.readFileSync(path.join(second, "transcript.txt"), "utf8")).toContain("LAST-8");
    expect(fs.existsSync(path.join(second, "terminal.ansi"))).toBe(true);
  });

  it("reports a terminal working while its screen changes and quiet once it holds still", async () => {
    const host = await startHost();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: BASH })).ptyId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // The same screen drawn again and again is not work.
    await host.request({ op: "write", ptyId: pty, data: "for i in 1 2 3 4; do printf '\\r.'; sleep 0.4; done; for i in $(seq 8); do echo LINE-$i; sleep 0.3; done\r" });
    const activity = () => host.events.filter((event) => event.event === "activity" && event.ptyId === pty).map((event) => event.working);
    await host.until(() => activity().includes(true), 8000);
    await host.until(() => activity().at(-1) === false, 10000);
    expect(activity()).toEqual([true, false]);
  }, 20000);

  it("keeps the screen when a full-screen program clears it on the way out", async () => {
    const host = await startHost();
    const runDir = tempDir();
    const script = "printf '\\033[?1049h\\033[HKEEP-SCREEN\\r\\n'; printf '\\033[?1049l\\033[2J'";
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/bash", "--norc", "--noprofile", "-c", script], runDir })).ptyId);
    await host.until(() => Boolean(host.exitOf(pty)));
    expect(fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8")).toContain("KEEP-SCREEN");
    expect(fs.readFileSync(path.join(runDir, "terminal.ansi"), "utf8")).toContain("KEEP-SCREEN");
  });

  it("keeps that frame for a program recorded inside a shell, after the shell prompt returns", async () => {
    const host = await startHost();
    const runDir = tempDir();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: BASH })).ptyId);
    await host.until(async () => (await host.screen(pty)).includes("$"));
    await host.request({ op: "record", ptyId: pty, runDir });
    await host.request({
      op: "write",
      ptyId: pty,
      data: "printf '\\033[?1049h\\033[HKEEP-SCREEN\\r\\n'; printf '\\033[?1049l\\033[2J'; echo BACK-OK\r",
    });
    await host.until(async () => (await host.screen(pty)).includes("BACK-OK"));
    await host.request({ op: "record", ptyId: pty, runDir: null });
    const transcript = fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8");
    expect(transcript).toContain("KEEP-SCREEN");
    expect(fs.readFileSync(path.join(runDir, "terminal.ansi"), "utf8")).toContain("KEEP-SCREEN");
  });

  it("holds back a terminal that floods output, and still reports its exit at once", async () => {
    const host = await startHost();
    const runDir = tempDir();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/bash", "--norc", "--noprofile", "-c", "yes FLOOD-0123456789"], runDir })).ptyId);
    await host.until(() => (host.printed.get(pty) ?? 0) > 0);
    const before = host.peakMb();
    // The app stops reading for a while, the pane printing as fast as it can, and the pane is
    // closed while it is held back. Before the host paused a pane it grew ~600 MB here, and the
    // exit waited minutes for the mirror to catch up.
    let killed = 0;
    const kill = new Promise<void>((resolve) =>
      setTimeout(() => {
        killed = Date.now();
        void host.request({ op: "kill", ptyId: pty });
        resolve();
      }, 1500),
    );
    await host.hold(2500);
    await kill;
    await host.until(() => Boolean(host.exitOf(pty)), 30000);
    const exitMs = Date.now() - killed;
    const grown = host.peakMb() - before;
    expect(grown).toBeLessThan(150);
    expect(exitMs).toBeLessThan(4500);
    expect(host.printed.get(pty)).toBeGreaterThan(1_000_000);
    expect(fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8")).toContain("FLOOD-0123456789");
  }, 60000);

  it("lets all of a held-back pane's output through to the end", async () => {
    const host = await startHost();
    const runDir = tempDir();
    const size = 40_000_000;
    const script = `head -c ${size} /dev/zero | tr '\\0' x; echo; echo FLOOD-END`;
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/bash", "--norc", "--noprofile", "-c", script], runDir })).ptyId);
    await host.hold(1500);
    await host.until(() => Boolean(host.exitOf(pty)), 30000);
    // Every byte, with the pty's \r\n for each \n.
    expect(host.printed.get(pty)).toBe(size + "\r\nFLOOD-END\r\n".length);
    expect(fs.readFileSync(path.join(runDir, "transcript.txt"), "utf8")).toContain("FLOOD-END");
  }, 60000);

  it("sends a snapshot whose screen holds exactly the output up to the number it reports", async () => {
    const host = await startHost();
    // Numbered lines as fast as bash prints them, so output keeps arriving while snapshots are taken.
    const argv = ["/bin/bash", "--norc", "--noprofile", "-c", "for i in $(seq 1 400000); do echo L$i; done; sleep 30"];
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv, cols: 40, rows: 10 })).ptyId);
    host.keep(pty);
    await host.until(() => (host.printed.get(pty) ?? 0) > 2000);
    let checked = 0;
    for (let round = 0; round < 25; round += 1) {
      const snap = await host.request({ op: "snapshot", ptyId: pty });
      if (snap.alive !== true) break;
      // What the pane would have before replaying anything newer than the snapshot's number.
      const upTo = (host.kept.get(pty) ?? []).filter((batch) => batch.seq <= Number(snap.seq)).map((batch) => batch.data).join("");
      const lastSent = upTo.replace(/\r?\n$/, "").split(/\r?\n/).at(-1) ?? "";
      const lastShown = String(snap.plain).trimEnd().split("\n").at(-1) ?? "";
      expect(lastShown).toBe(lastSent);
      checked += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(checked).toBeGreaterThan(10);
    // The output is let go again after each snapshot: all of it arrives.
    await host.until(() => (host.kept.get(pty) ?? []).some((batch) => batch.data.includes("L400000")), 30_000);
    await host.request({ op: "kill", ptyId: pty });
  });

  it("reads the last lines as text without the whole scrollback, and pastes no control bytes", async () => {
    const host = await startHost();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/cat"] })).ptyId);
    // A paste end-marker nested inside another, then a Ctrl+C: neither may arrive as keys.
    await host.request({ op: "send", ptyId: pty, text: "safe\x1b[20\x1b[201~1~\x03 still text\x7f", enter: true });
    await host.until(async () => String((await host.request({ op: "screen", ptyId: pty })).plain).includes("still text"));
    const screen = await host.request({ op: "screen", ptyId: pty });
    expect(screen.alive).toBe(true);
    expect(String(screen.plain)).toContain("safe[20[201~1~ still text");
    expect(screen).not.toHaveProperty("ansi");
    // cat is still there: the Ctrl+C was pasted as nothing, not typed.
    expect((await host.request({ op: "foreground", ptyId: pty })).known).toBe(true);
    expect(host.exitOf(pty)).toBeUndefined();
    await host.request({ op: "kill", ptyId: pty });
    expect((await host.request({ op: "screen", ptyId: "nope" })).alive).toBe(false);
  });

  it("ends its terminals properly on SIGHUP, as when the terminal VibeForge started from closes", async () => {
    const host = await startHost();
    const dir = tempDir();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: BASH, runDir: dir })).ptyId);
    await host.request({ op: "write", ptyId: pty, data: "echo HUP-$((40+2))\r" });
    await host.until(async () => (await host.screen(pty)).includes("HUP-42"));
    expect(await host.signal("SIGHUP")).toEqual({ code: 0, signal: null });
    expect(host.exitOf(pty)).toBeDefined();
    expect(fs.readFileSync(path.join(dir, "transcript.txt"), "utf8")).toContain("HUP-42");
  });

  it("reports a program's own exit code and rejects unknown requests", async () => {
    const host = await startHost();
    const pty = String((await host.request({ op: "spawn", cwd: tempDir(), argv: ["/bin/sh", "-c", "exit 3"] })).ptyId);
    await host.until(() => Boolean(host.exitOf(pty)));
    expect(host.exitOf(pty)).toMatchObject({ exitCode: 3 });
    await expect(host.request({ op: "teleport" })).resolves.toMatchObject({ ok: false, error: "Unknown op teleport" });
  });
});
