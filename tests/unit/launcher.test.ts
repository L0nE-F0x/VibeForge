import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/vibeforge hands `vibeforge tell|who|task|apply …` to scripts/talk.mjs. A command it
// doesn't list falls through to starting Electron, which meets the open window's single-instance
// lock and quits with 0, so the command silently does nothing. Every command talk.mjs takes is run
// through the launcher here, against a stand-in control socket.

const repo = path.resolve(import.meta.dirname, "..", "..");
const talkSource = fs.readFileSync(path.join(repo, "scripts", "talk.mjs"), "utf8");

/** The commands talk.mjs compares its first argument against, plus those its usage names. */
function talkCommands(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/command\s*[!=]==?\s*"([^"]+)"/g)) found.add(match[1]);
  for (const match of source.matchAll(/case\s+"([^"]+)"\s*:/g)) found.add(match[1]);
  for (const match of source.matchAll(/^\s+vibeforge ([a-z][a-z-]*)\b/gm)) found.add(match[1]);
  return [...found].sort();
}

/** Plausible arguments for each command; a new command gets a name and a message. */
const ARGS: Record<string, string[]> = {
  who: [],
  tell: ["codex", "hello"],
  task: ["builder", "write the tests"],
  apply: ["task-1"],
};
const HELP = new Set(["help", "--help", "-h"]);

/** Answers the launcher's talk.mjs would accept, by request. */
function answerFor(op: string): unknown {
  if (op === "who") return { clis: [], agents: [], you: null };
  if (op === "tell") return { ok: true, delivered: "sent", to: "codex" };
  if (op === "task") return { ok: true, started: false, title: "t", taskId: "task-1" };
  if (op === "apply") return { ok: true, files: [], note: "Applied.", conflicts: [] };
  return { ok: true };
}

let dir = "";
let socket = "";
let server: net.Server;
const requests: Array<{ op?: string }> = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-launcher-"));
  // A copy of the launcher with no Electron next to it: a command that falls through can only fail.
  fs.mkdirSync(path.join(dir, "app", "scripts"), { recursive: true });
  for (const file of ["vibeforge", "talk.mjs"]) fs.copyFileSync(path.join(repo, "scripts", file), path.join(dir, "app", "scripts", file));
  fs.chmodSync(path.join(dir, "app", "scripts", "vibeforge"), 0o755);
  // The launcher's error path sends a desktop notification; this one goes nowhere.
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "notify-send"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  socket = path.join(dir, "c.sock");
  server = net.createServer((client) => {
    let text = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.split("\n")[0]) as { op?: string };
      requests.push(request);
      client.end(`${JSON.stringify(answerFor(request.op ?? ""))}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

function launch(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(dir, "app", "scripts", "vibeforge"), ...args], {
      env: {
        PATH: `${path.join(dir, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(dir, "home"),
        VIBEFORGE_SOCKET: socket,
        // Even a fall-through never builds or opens a window.
        VIBEFORGE_SKIP_BUILD: "1",
        VIBEFORGE_LAUNCH: "check",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the vibeforge launcher", () => {
  const commands = talkCommands(talkSource);

  it("finds talk.mjs's commands", () => {
    expect(commands).toEqual(expect.arrayContaining(["apply", "help", "task", "tell", "who"]));
  });

  it.each(commands)("hands `vibeforge %s` to talk.mjs", async (command) => {
    requests.length = 0;
    const result = await launch([command, ...(ARGS[command] ?? (HELP.has(command) ? [] : ["someone", "hello"]))]);
    // The launcher's own errors start "VibeForge:"; talk.mjs's start "vibeforge:".
    expect(result.stderr).not.toMatch(/^VibeForge:/m);
    if (HELP.has(command)) {
      expect(result.stdout).toContain("Talk to the other coding CLIs open in VibeForge.");
      expect(result.code).toBe(0);
    } else {
      expect(requests.map((request) => request.op)).toContain(command);
    }
  });

  it("still falls through to the window for anything else", async () => {
    const result = await launch(["--hidden"]);
    expect(result.stderr).toContain("VibeForge: Electron is missing");
    expect(result.code).toBe(1);
  });
});
