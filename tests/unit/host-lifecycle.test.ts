import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrashCount, HostLifecycle, terminalEnv } from "../../electron/host-lifecycle.js";
import { MainContext } from "../../electron/main-context.js";
import { LogFile } from "../../src/core/log.js";

let scratch = "";
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vf-host-life-"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A stand-in for PtySupervisor: its event sets, and a start that can be told to fail. */
function fakeSupervisor() {
  return {
    onData: new Set<(event: unknown) => void>(),
    onExit: new Set<(event: { ptyId: string; exitCode: number | null; signal: number | null }) => void>(),
    onProgram: new Set<(event: unknown) => void>(),
    onActivity: new Set<(event: unknown) => void>(),
    onCrash: new Set<(message: string) => void>(),
    starts: [] as NodeJS.ProcessEnv[],
    fail: null as string | null,
    async start(_root: string, env: NodeJS.ProcessEnv) {
      this.starts.push(env);
      if (this.fail) throw new Error(this.fail);
    },
    crash(message: string) {
      for (const handler of this.onCrash) handler(message);
    },
  };
}

function setUp() {
  const supervisor = fakeSupervisor();
  const log = new LogFile(path.join(scratch, "data", "logs", "vibeforge.log"));
  const ctx = new MainContext({
    roots: { configRoot: path.join(scratch, "config"), dataRoot: path.join(scratch, "data") },
    log,
    supervisor: supervisor as never,
    words: {} as never,
    appRoot: path.join(scratch, "app"),
    install: "checkout",
    palette: {} as never,
  });
  const sent: unknown[][] = [];
  Object.assign(ctx, { send: (event: string, payload: unknown) => sent.push([event, payload]) });
  const ended: Array<[string, number | null, number | null]> = [];
  const live = [{ ptyId: "p1" }, { ptyId: "p2" }];
  ctx.service = {
    listLive: () => live,
    onPtyExit: async (ptyId: string, code: number | null, signal: number | null) => {
      ended.push([ptyId, code, signal]);
    },
  } as never;
  const exited: string[] = [];
  const life = new HostLifecycle(ctx, {
    voice: { controlSocket: "/run/vf.sock" },
    talk: { exited: async (ptyId: string) => void exited.push(ptyId) },
  });
  life.wire();
  const lines = () => log.tail(50).map((line) => line.replace(/^\S+ /, ""));
  return { supervisor, ctx, life, sent, ended, exited, lines };
}

describe("counting terminal host crashes", () => {
  it("counts the crashes within five minutes", () => {
    const count = new CrashCount();
    expect(count.add(0)).toBe(1);
    expect(count.add(60_000)).toBe(2);
    expect(count.add(120_000)).toBe(3);
    expect(count.add(299_999)).toBe(4);
    // The first two are more than five minutes old by now.
    expect(count.add(360_001)).toBe(3);
  });
});

describe("the terminal host's lifecycle", () => {
  it("starts the host with the control socket and vibeforge on PATH", async () => {
    const { supervisor, life } = setUp();
    await life.start();
    expect(supervisor.starts[0]?.VIBEFORGE_SOCKET).toBe("/run/vf.sock");
    expect(life.error).toBeNull();
  });

  it("keeps why the host didn't start, for a page that loads later", async () => {
    const { supervisor, life, sent, lines } = setUp();
    supervisor.fail = "VibeForge needs Node on PATH to run terminals (node was not found).";
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await life.start();
    quiet.mockRestore();
    expect(life.error).toBe(supervisor.fail);
    expect(sent).toEqual([["host-crash", supervisor.fail]]);
    expect(lines()).toContain(`ERROR The terminal host did not start: ${supervisor.fail}`);
    supervisor.fail = null;
    await life.start();
    expect(life.error).toBeNull();
  });

  it("logs a terminal's end and tells the page, the core and the spoken-answer wait", async () => {
    const { supervisor, sent, ended, exited, lines } = setUp();
    for (const handler of supervisor.onExit) handler({ ptyId: "p1", exitCode: 0, signal: null });
    for (const handler of supervisor.onExit) handler({ ptyId: "p2", exitCode: null, signal: 9 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines()).toEqual(["INFO  Terminal p1 ended (exit code 0)", "INFO  Terminal p2 ended (signal 9)"]);
    expect(sent.map(([event]) => event)).toEqual(["pty-exit", "pty-exit"]);
    expect(ended).toEqual([
      ["p1", 0, null],
      ["p2", null, 9],
    ]);
    expect(exited).toEqual(["p1", "p2"]);
  });

  it("records every terminal as ended when the host crashes, then brings it back a second later", async () => {
    vi.useFakeTimers();
    const { supervisor, sent, ended, lines } = setUp();
    supervisor.crash("The terminal host stopped (SIGKILL).");
    expect(ended).toEqual([
      ["p1", null, null],
      ["p2", null, null],
    ]);
    expect(lines()).toContain("INFO  Terminal p1 ended (the terminal host stopped)");
    expect(lines()).toContain("INFO  Terminal p2 ended (the terminal host stopped)");
    // The page hears each terminal end, so no pane goes on looking live, then the crash.
    expect(sent).toEqual([
      ["pty-exit", { ptyId: "p1", exitCode: null, signal: null }],
      ["pty-exit", { ptyId: "p2", exitCode: null, signal: null }],
      ["host-crash", "The terminal host stopped (SIGKILL)."],
    ]);
    expect(lines()).toContain("ERROR The terminal host stopped (SIGKILL).");
    expect(lines().join("\n")).not.toContain("stopped: The terminal host stopped");
    expect(supervisor.starts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(supervisor.starts).toHaveLength(1);
  });

  it("ends a spoken-answer wait on a terminal that died with the host, as on any exit", async () => {
    vi.useFakeTimers();
    const { supervisor, exited } = setUp();
    supervisor.crash("The terminal host stopped (SIGKILL).");
    await vi.advanceTimersByTimeAsync(0);
    expect(exited).toEqual(["p1", "p2"]);
  });

  it("leaves the host down once a quit has begun, even one that starts within that second", async () => {
    vi.useFakeTimers();
    const { supervisor, ctx, sent } = setUp();
    supervisor.crash("gone");
    ctx.quitting = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(supervisor.starts).toHaveLength(0);
    supervisor.crash("gone again");
    await vi.advanceTimersByTimeAsync(2000);
    expect(supervisor.starts).toHaveLength(0);
    // The page hears about the first crash only: the second came during the quit.
    expect(sent.filter(([event]) => event === "host-crash")).toEqual([["host-crash", "gone"]]);
  });

  it("stops bringing back a host that crashed more than three times in five minutes", async () => {
    vi.useFakeTimers();
    const { supervisor, life, sent, lines } = setUp();
    for (let crash = 0; crash < 3; crash += 1) {
      supervisor.crash("gone");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(supervisor.starts).toHaveLength(3);
    supervisor.crash("gone");
    await vi.advanceTimersByTimeAsync(5000);
    expect(supervisor.starts).toHaveLength(3);
    expect(life.error).toBe("gone It stopped 4 times in five minutes, so it stays off: restart VibeForge.");
    expect(sent.at(-1)).toEqual(["host-crash", life.error]);
    expect(lines()).toContain("ERROR The terminal host keeps stopping; it stays off until VibeForge restarts");
  });
});

describe("what every terminal starts with", () => {
  it("links scripts/vibeforge into the data folder and puts that first on PATH", () => {
    const { ctx } = setUp();
    const script = path.join(ctx.appRoot, "scripts", "vibeforge");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "#!/bin/sh\n");
    const env = terminalEnv(ctx, "/run/vf.sock");
    const bin = path.join(ctx.roots.dataRoot, "bin");
    expect(env.VIBEFORGE_SOCKET).toBe("/run/vf.sock");
    expect(env.PATH?.split(path.delimiter)[0]).toBe(bin);
    expect(fs.readlinkSync(path.join(bin, "vibeforge"))).toBe(script);
    // A link left by a copy elsewhere is pointed back here.
    fs.rmSync(path.join(bin, "vibeforge"));
    fs.symlinkSync("/elsewhere/vibeforge", path.join(bin, "vibeforge"));
    terminalEnv(ctx, "/run/vf.sock");
    expect(fs.readlinkSync(path.join(bin, "vibeforge"))).toBe(script);
  });
});
