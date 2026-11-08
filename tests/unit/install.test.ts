import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedEngines } from "../../src/core/engines.js";

// scripts/install.sh, run in a scratch home against a stand-in VibeForge repo: its npm ci makes
// Electron and node-pty's files and its build writes dist, so each release can be made to fail
// the way a dropped network or a broken build would.

const repo = path.resolve(import.meta.dirname, "..", "..");
const script = fs.readFileSync(path.join(repo, "scripts", "install.sh"), "utf8");

let dir = "";
let fake = "";
let home = "";
let stubs = "";

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: path.join(os.tmpdir(), "vibeforge-no-home") };
const git = (...args: string[]) => execFileSync("git", ["-C", fake, ...args], { env: { ...process.env, ...gitEnv }, stdio: "pipe" });

/** A release of the stand-in repo. `fail` breaks its install part-way or its build. */
function release(version: string, fail?: "install" | "build") {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(fake, file)), { recursive: true });
    fs.writeFileSync(path.join(fake, file), text);
  };
  write("package.json", JSON.stringify({ name: "vibeforge", version, private: true, scripts: { postinstall: "node install.cjs", build: "node build.cjs" } }));
  write("package-lock.json", JSON.stringify({ name: "vibeforge", version, lockfileVersion: 3, requires: true, packages: { "": { name: "vibeforge", version } } }));
  write(
    "install.cjs",
    `const fs = require("fs");
fs.mkdirSync("node_modules/electron/dist", { recursive: true });
${fail === "install" ? 'process.exit(1); // the download stops here' : ""}
fs.writeFileSync("node_modules/electron/dist/electron", "#!/bin/sh\\n", { mode: 0o755 });
fs.mkdirSync("node_modules/node-pty/build/Release", { recursive: true });
fs.writeFileSync("node_modules/node-pty/build/Release/pty.node", "");
`,
  );
  write(
    "build.cjs",
    `const fs = require("fs");
${fail === "build" ? 'console.error("the build broke"); process.exit(1);' : ""}
fs.mkdirSync("dist", { recursive: true });
fs.mkdirSync("dist-electron", { recursive: true });
fs.writeFileSync("dist/index.html", "");
fs.writeFileSync("dist-electron/main.js", ${JSON.stringify(version)});
`,
  );
  write("scripts/vibeforge", "#!/bin/sh\n");
  write("resources/icon.png", "");
  write("resources/icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  git("add", "-A");
  git("commit", "-q", "-m", version);
  git("tag", `v${version}`);
}

function install(args: string[] = [], opts: { path?: string; stdin?: string } = {}) {
  const result = spawnSync("bash", opts.stdin === undefined ? [path.join(repo, "scripts", "install.sh"), ...args] : ["-s", "--", ...args], {
    encoding: "utf8",
    input: opts.stdin,
    env: {
      HOME: home,
      PATH: opts.path ?? `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      VIBEFORGE_REPO: fake,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const app = () => path.join(home, ".local", "share", "vibeforge-app");
const built = (folder: string) => fs.readFileSync(path.join(folder, "dist-electron", "main.js"), "utf8");

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-install-"));
  fake = path.join(dir, "repo");
  home = path.join(dir, "home");
  stubs = path.join(dir, "stubs");
  fs.mkdirSync(home);
  fs.mkdirSync(stubs);
  // The build tools it checks for are never run here; desktop helpers would touch nothing real but vary by machine.
  for (const tool of ["make", "g++", "python3", "rsvg-convert", "update-desktop-database"]) {
    fs.writeFileSync(path.join(stubs, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  execFileSync("git", ["init", "-q", fake], { env: { ...process.env, ...gitEnv } });
  release("1.0.0");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the installer", () => {
  it("installs fresh from a piped script, and says to add ~/.local/bin to PATH when it isn't there", () => {
    const result = install([], { stdin: script });
    expect(result.status, result.out).toBe(0);
    expect(built(app())).toBe("1.0.0");
    expect(fs.existsSync(path.join(app(), ".vibeforge-installer"))).toBe(true);
    expect(fs.readlinkSync(path.join(home, ".local", "bin", "vibeforge"))).toBe(path.join(app(), "scripts", "vibeforge"));
    expect(fs.readFileSync(path.join(home, ".local", "share", "applications", "vibeforge.desktop"), "utf8")).toContain(`Exec=${home}/.local/bin/vibeforge\n`);
    expect(fs.existsSync(`${app()}.next`)).toBe(false);
    expect(result.out).toContain("VibeForge 1.0.0 is installed.");
    expect(result.out).toContain("to your PATH");
  });

  it("leaves the installed copy working when an update's build or download fails", () => {
    release("1.1.0", "build");
    let result = install();
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("is unchanged");
    release("1.2.0", "install");
    result = install();
    expect(result.status).not.toBe(0);
    for (const file of ["node_modules/electron/dist/electron", "node_modules/node-pty/build/Release/pty.node", "dist/index.html"]) {
      expect(fs.existsSync(path.join(app(), file)), file).toBe(true);
    }
    expect(built(app())).toBe("1.0.0");
    expect(fs.existsSync(`${app()}.next`)).toBe(false);
  });

  it("swaps in a good update and keeps the copy it replaced", () => {
    release("1.3.0");
    const result = install([], { path: `${home}/.local/bin:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    expect(result.status, result.out).toBe(0);
    expect(built(app())).toBe("1.3.0");
    expect(built(`${app()}.previous`)).toBe("1.0.0");
    expect(fs.existsSync(`${app()}.next`)).toBe(false);
    expect(result.out).not.toContain("to your PATH");
  });

  it("removes the login entry with the command on --uninstall", () => {
    const autostart = path.join(home, ".config", "autostart");
    fs.mkdirSync(autostart, { recursive: true });
    fs.writeFileSync(path.join(autostart, "vibeforge.desktop"), `[Desktop Entry]\nExec=${home}/.local/bin/vibeforge --hidden\n`);
    fs.writeFileSync(path.join(autostart, "other.desktop"), "[Desktop Entry]\n");
    const result = install(["--uninstall"]);
    expect(result.status, result.out).toBe(0);
    expect(fs.existsSync(path.join(autostart, "vibeforge.desktop"))).toBe(false);
    expect(fs.existsSync(path.join(autostart, "other.desktop"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".local", "bin", "vibeforge"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".local", "share", "applications", "vibeforge.desktop"))).toBe(false);
    expect(fs.existsSync(app())).toBe(true);
  });

  it("runs nothing when the download is cut off part-way", () => {
    const empty = fs.mkdtempSync(path.join(dir, "cut-"));
    const lines = script.split("\n");
    const last = lines.findLastIndex((line) => line.startsWith("main "));
    for (const keep of [0.25, 0.5, 0.75, 0.95].map((share) => Math.floor(last * share)).concat(last)) {
      const result = spawnSync("bash", [], { input: lines.slice(0, keep).join("\n"), encoding: "utf8", env: { HOME: empty, PATH: "/usr/bin:/bin" } });
      expect(result.stdout, `cut at line ${keep}`).toBe("");
      expect(fs.readdirSync(empty), `cut at line ${keep}`).toEqual([]);
    }
  });

  it("looks for every CLI VibeForge knows", () => {
    const scan = /for cli in ([^;]+); do/.exec(script)?.[1].trim().split(/\s+/);
    expect(scan?.sort()).toEqual(seedEngines().map((engine) => engine.bin).sort());
  });
});
