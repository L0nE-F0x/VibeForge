import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRuntime, PtySupervisor } from "../../electron/supervisor.js";

// The window's side of the terminal host's JSON lines, against a stand-in host. tests/pty.test.ts
// drives the real one.

const STAND_IN = `
const readline = require("readline");
const out = (line) => process.stdout.write(line + "\\n");
// Lines that are JSON but not a message, which a library printing to stdout could leave.
out("null");
out("7");
out("not json");
out(JSON.stringify({ event: "ready", pid: process.pid }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  out("null");
  if (msg.op === "spawn") out(JSON.stringify({ reqId: msg.reqId, ok: true, ptyId: "p1", pid: 42 }));
  else if (msg.op === "snapshot") out(JSON.stringify({ reqId: msg.reqId, ok: true, ansi: "", seq: 0, cols: 0, rows: 0, alive: false }));
  else out(JSON.stringify({ reqId: msg.reqId, ok: false, error: "No " + msg.op + " here." }));
});
process.stdin.on("end", () => process.exit(0));
`;

let supervisor: PtySupervisor | null = null;
let dir = "";

afterEach(async () => {
  await supervisor?.shutdown(1000);
  supervisor = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("the terminal host's client", () => {
  it("skips lines that aren't messages, and reads each answer as its request promises", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-supervisor-"));
    fs.mkdirSync(path.join(dir, "electron"));
    fs.writeFileSync(path.join(dir, "electron", "pty-host.cjs"), STAND_IN);
    vi.stubEnv("VIBEFORGE_NODE", process.execPath);
    supervisor = new PtySupervisor();
    await supervisor.start(dir, { ...process.env });
    expect(await supervisor.spawn({ cwd: dir, argv: ["/bin/sh"], runDir: null, pasteInput: null })).toEqual({ ptyId: "p1", pid: 42 });
    // A terminal that has ended answers without its text; the client fills that in.
    expect(await supervisor.snapshot("p1")).toEqual({ ansi: "", plain: "", seq: 0, cols: 0, rows: 0, alive: false });
    await expect(supervisor.write("p1", "x")).rejects.toThrow("No write here.");
  });

  it("says why a host failed to start, from what it wrote to stderr", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-supervisor-"));
    fs.mkdirSync(path.join(dir, "electron"));
    fs.writeFileSync(path.join(dir, "electron", "pty-host.cjs"), `process.stderr.write("Error: Cannot find module 'node-pty'\\n"); process.exit(1);`);
    vi.stubEnv("VIBEFORGE_NODE", process.execPath);
    supervisor = new PtySupervisor();
    const heard: string[] = [];
    supervisor.onStderr.add((line) => heard.push(line));
    await expect(supervisor.start(dir, { ...process.env })).rejects.toThrow(/exited during start \(code 1\)\.\nError: Cannot find module 'node-pty'/);
    expect(heard).toEqual(["Error: Cannot find module 'node-pty'"]);
    expect(supervisor.running).toBe(false);
  });

  it("fails at once, and isn't left running, when the host can't be started at all", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-supervisor-"));
    vi.stubEnv("VIBEFORGE_NODE", path.join(dir, "no-such-node"));
    supervisor = new PtySupervisor();
    const started = Date.now();
    await expect(supervisor.start(dir, { ...process.env })).rejects.toThrow(/could not start: .*ENOENT/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(supervisor.running).toBe(false);
    await expect(supervisor.snapshot("p1")).rejects.toThrow("not running");
  });
});

describe("what the terminal host runs on", () => {
  it("is Electron's own binary started as Node, so no system Node is needed", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/x" };
    expect(hostRuntime(env, { execPath: "/opt/vf/electron", electron: "45.3.2" })).toEqual({
      command: "/opt/vf/electron",
      env: { PATH: "/usr/bin", HOME: "/home/x", ELECTRON_RUN_AS_NODE: "1" },
    });
    // The terminals' own environment is left as it was.
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
  });

  it("is the Node VIBEFORGE_NODE names, when it names one, and the running Node outside Electron", () => {
    expect(hostRuntime({ PATH: "/usr/bin" }, { execPath: "/opt/vf/electron", electron: "45.3.2", override: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", env: { PATH: "/usr/bin" } });
    expect(hostRuntime({ PATH: "/usr/bin" }, { execPath: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", env: { PATH: "/usr/bin" } });
  });

  it("knows which Node and libuv the host said it runs on", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-supervisor-"));
    fs.mkdirSync(path.join(dir, "electron"));
    fs.writeFileSync(
      path.join(dir, "electron", "pty-host.cjs"),
      `process.stdout.write(JSON.stringify({ event: "ready", pid: process.pid, node: process.versions.node, uv: process.versions.uv }) + "\\n"); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`,
    );
    vi.stubEnv("VIBEFORGE_NODE", process.execPath);
    supervisor = new PtySupervisor();
    await supervisor.start(dir, { ...process.env });
    expect(supervisor.runtime).toEqual({ node: process.versions.node, uv: process.versions.uv });
  });
});

/** A stand-in host that is stuck between SIGUSR1s (it answers what it was asked once unstuck), and never answers \`write\`. */
const SLOW = `
const readline = require("readline");
const out = (line) => process.stdout.write(line + "\\n");
let stuck = false;
let asked = [];
const answer = (msg) => out(JSON.stringify({ reqId: msg.reqId, ok: true, ptys: [] }));
process.on("SIGUSR1", () => {
  stuck = !stuck;
  if (!stuck) asked.splice(0).forEach(answer);
});
out(JSON.stringify({ event: "ready", pid: process.pid }));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.op === "list") stuck ? asked.push(msg) : answer(msg);
  if (msg.op === "snapshot") setTimeout(() => out(JSON.stringify({ reqId: msg.reqId, ok: true, ansi: "late", seq: 1, cols: 1, rows: 1, alive: true })), 300);
});
process.stdin.on("end", () => process.exit(0));
`;

describe("a terminal host that stops answering", () => {
  async function startSlow(options: ConstructorParameters<typeof PtySupervisor>[0]) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-supervisor-"));
    fs.mkdirSync(path.join(dir, "electron"));
    fs.writeFileSync(path.join(dir, "electron", "pty-host.cjs"), SLOW);
    vi.stubEnv("VIBEFORGE_NODE", process.execPath);
    supervisor = new PtySupervisor(options);
    await supervisor.start(dir, { ...process.env });
    return supervisor;
  }

  it("gives up on a request after its time, instead of waiting for ever", async () => {
    const host = await startSlow({ timeouts: { write: 200, snapshot: 1000 } });
    const started = Date.now();
    await expect(host.write("p1", "x")).rejects.toThrow("The terminal host did not answer in time.");
    expect(Date.now() - started).toBeLessThan(1000);
    // A snapshot has longer, and an answer within it arrives.
    expect((await host.snapshot("p1")).ansi).toBe("late");
  });

  it("says when the host stops answering, and when it answers again, without ending it", async () => {
    const host = await startSlow({ pingMs: 100 });
    const heard: boolean[] = [];
    host.onStall.add((stalled) => heard.push(stalled));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(heard).toEqual([]);
    const pid = (host as unknown as { child: { pid: number } }).child.pid;
    process.kill(pid, "SIGUSR1");
    await vi.waitFor(() => expect(heard).toEqual([true]), { timeout: 2000 });
    expect(host.running).toBe(true);
    process.kill(pid, "SIGUSR1");
    await vi.waitFor(() => expect(heard).toEqual([true, false]), { timeout: 2000 });
  });
});
