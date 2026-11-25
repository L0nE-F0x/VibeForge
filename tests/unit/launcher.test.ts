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

function launch(args: string[], app = "app"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(dir, app, "scripts", "vibeforge"), ...args], {
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

  it("takes --wait, --title and --timeout after the message too: flags go anywhere", async () => {
    requests.length = 0;
    await launch(["tell", "codex", "Is this regex safe?", "--wait"]);
    await launch(["task", "Helper", "fix the tests", "--title", "Tests", "--timeout", "2"]);
    expect(requests[0]).toMatchObject({ op: "tell", to: "codex", text: "Is this regex safe?", wait: true });
    expect(requests[1]).toMatchObject({ op: "task", agent: "Helper", text: "fix the tests", title: "Tests", timeoutMs: 120_000 });
  });

  it("still falls through to the window for anything else", async () => {
    const result = await launch(["--hidden"]);
    expect(result.stderr).toContain("VibeForge: Electron is missing");
    expect(result.stderr).toContain("npm install");
    expect(result.code).toBe(1);
  });

  it("tells an installer copy, which has no source to build, to install again", async () => {
    const copy = path.join(dir, "installed copy");
    fs.mkdirSync(path.join(copy, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(dir, "app", "scripts", "vibeforge"), path.join(copy, "scripts", "vibeforge"));
    fs.writeFileSync(path.join(copy, ".vibeforge-installer"), "");
    const result = await launch(["--hidden"], "installed copy");
    expect(result.stderr).toContain("VibeForge: Electron is missing. Install VibeForge again: curl -fsSL https://vibe-forge.net/install | VIBEFORGE_HOME=");
    expect(result.stderr).toContain("installed\\ copy bash");
    expect(result.stderr).not.toContain("npm install");
    expect(result.code).toBe(1);
  });

  /** An installer copy in `<root>/versions/1.0.0`, with `electron` as given; runs it as the app launcher would (no terminal). */
  function versionedCopy(name: string, electron: string) {
    const root = path.join(dir, name);
    const copy = path.join(root, "versions", "1.0.0");
    for (const sub of ["scripts", "dist", "dist-electron", "node_modules/electron/dist"]) fs.mkdirSync(path.join(copy, sub), { recursive: true });
    fs.copyFileSync(path.join(dir, "app", "scripts", "vibeforge"), path.join(copy, "scripts", "vibeforge"));
    fs.writeFileSync(path.join(copy, "scripts", "install.sh"), 'echo "installer $* HOME=$VIBEFORGE_HOME"\n');
    fs.writeFileSync(path.join(copy, "dist", "index.html"), "");
    fs.writeFileSync(path.join(copy, "dist-electron", "main.js"), "");
    fs.writeFileSync(path.join(copy, "node_modules", "electron", "dist", "electron"), electron, { mode: 0o755 });
    for (const marked of [root, copy]) fs.writeFileSync(path.join(marked, ".vibeforge-installer"), "");
    fs.symlinkSync("versions/1.0.0", path.join(root, "current"));
    return root;
  }

  function start(launcher: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("bash", [launcher, ...args], {
        env: { PATH: `${path.join(dir, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(dir, "home"), XDG_CACHE_HOME: path.join(dir, "cache"), XDG_RUNTIME_DIR: dir, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("hands --rollback, --uninstall and --purge-app to the copy's installer, for the install folder", async () => {
    const root = versionedCopy("versioned", "#!/bin/sh\nexit 0\n");
    for (const flag of ["--rollback", "--uninstall", "--purge-app"]) {
      const result = await start(path.join(root, "current", "scripts", "vibeforge"), [flag]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`installer ${flag} HOME=${root}`);
    }
  });

  it("starts the copy's own folder with its real path, and says why when Electron stops as it starts", async () => {
    const said = path.join(dir, "notified");
    fs.writeFileSync(path.join(dir, "bin", "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${said}"\nexit 0\n`, { mode: 0o755 });
    const notified = async () => {
      for (let tries = 0; tries < 100 && !fs.existsSync(said); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      return fs.existsSync(said) ? fs.readFileSync(said, "utf8") : "";
    };
    try {
      const broken = versionedCopy("broken", '#!/bin/sh\necho "started with $1"\necho "error while loading shared libraries: libgtk-3.so.0" >&2\nexit 127\n');
      // Electron replaces the launcher, so its exit code is the launcher's.
      const result = await start(path.join(broken, "current", "scripts", "vibeforge"), [], { VIBEFORGE_LAUNCH_WAIT: "20" });
      expect(result.code).toBe(127);
      const message = await notified();
      expect(message).toContain("VibeForge can't start");
      expect(message).toContain("It stopped as it started");
      expect(message).toContain("libgtk-3.so.0");
      const log = fs.readFileSync(path.join(dir, "cache", "vibeforge", "launch.log"), "utf8");
      // The version's real folder, not the link that leads to it.
      expect(log).toContain(`started with ${path.join(broken, "versions", "1.0.0")}`);
      expect(log).toContain("VibeForge: It stopped as it started");
      // One that keeps running is left to it.
      fs.rmSync(said, { force: true });
      const fine = versionedCopy("fine", "#!/bin/sh\nsleep 2\n");
      const ok = await start(path.join(fine, "current", "scripts", "vibeforge"), [], { VIBEFORGE_LAUNCH_WAIT: "5" });
      expect(ok.code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fs.existsSync(said)).toBe(false);
    } finally {
      fs.writeFileSync(path.join(dir, "bin", "notify-send"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
  });
});
