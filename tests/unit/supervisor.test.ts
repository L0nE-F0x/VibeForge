import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtySupervisor } from "../../electron/supervisor.js";

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
});
