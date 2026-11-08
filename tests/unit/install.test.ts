import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedEngines } from "../../src/core/engines.js";

// scripts/install.sh, run in a scratch home against a stand-in VibeForge repo: its npm ci makes
// Electron and node-pty's files and its build writes dist, so each release can be made to fail
// the way a dropped network or a broken build would. Its ready-made builds come from a stand-in
// release server on this computer, which answers like GitHub's releases.

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

function install(args: string[] = [], opts: { path?: string; stdin?: string; home?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync("bash", opts.stdin === undefined ? [path.join(repo, "scripts", "install.sh"), ...args] : ["-s", "--", ...args], {
    encoding: "utf8",
    input: opts.stdin,
    env: {
      HOME: opts.home ?? home,
      PATH: opts.path ?? `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      VIBEFORGE_REPO: fake,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      ...opts.env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const app = (inHome = home) => path.join(inHome, ".local", "share", "vibeforge-app");
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

// ------------------------------------------------------------------ ready-made builds

/** A stand-in for GitHub's releases: /latest redirects to the tag in `latest`, files are served as they are. */
const SERVER = `
const fs = require("fs"), http = require("http"), path = require("path");
const root = process.argv[1];
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/releases/latest") {
    let tag = "";
    try { tag = fs.readFileSync(path.join(root, "latest"), "utf8").trim(); } catch {}
    res.writeHead(302, { location: tag ? "/releases/tag/" + tag : "/releases" });
    return res.end();
  }
  fs.readFile(path.join(root, path.normalize(url.pathname)), (error, data) => {
    res.writeHead(error ? 404 : 200);
    res.end(error ? "Not Found" : data);
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

/** What the installer looks for on this CPU. */
const arch = process.arch === "arm64" ? "arm64" : "x64";
let srv = "";
let releases = "";
let server: ChildProcess | undefined;
/** Stand-ins for everything a build from source runs: an archive install that calls one fails. */
let nobuild = "";

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Publishes a release on the stand-in server and makes it the latest. `sums` breaks it: a wrong
 * checksum, a SHA256SUMS without the archive (a release from before ready-made builds), or none.
 */
function publish(version: string, sums: "good" | "bad" | "no-archive" | "none" = "good") {
  const tag = `v${version}`;
  const files = path.join(srv, "releases", "download", tag);
  const name = `vibeforge-${version}-linux-${arch}`;
  const tree = path.join(dir, "trees", name);
  const write = (file: string, text: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
    fs.writeFileSync(path.join(tree, file), text, { mode });
  };
  write("package.json", JSON.stringify({ name: "vibeforge", version }));
  write("dist/index.html", "");
  write("dist-electron/main.js", version);
  write("node_modules/electron/dist/electron", "#!/bin/sh\n", 0o755);
  write("node_modules/node-pty/build/Release/pty.node", "");
  write("scripts/vibeforge", "#!/bin/sh\n", 0o755);
  write("resources/icon.png", "");
  write("resources/icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  write(".vibeforge-installer", "");
  fs.mkdirSync(files, { recursive: true });
  const archive = path.join(files, `${name}.tar.zst`);
  execFileSync("tar", ["--zstd", "-cf", archive, "-C", path.dirname(tree), name]);
  fs.writeFileSync(path.join(files, "install.sh"), script);
  const lines = [`${sha256(path.join(files, "install.sh"))}  install.sh`];
  if (sums === "good") lines.push(`${sha256(archive)}  ${name}.tar.zst`);
  if (sums === "bad") lines.push(`${"0".repeat(64)}  ${name}.tar.zst`);
  if (sums !== "none") fs.writeFileSync(path.join(files, "SHA256SUMS"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(srv, "latest"), tag);
}

/** The installer against the stand-in releases, in its own home. */
function installReleased(inHome: string, opts: { path?: string; env?: Record<string, string> } = {}) {
  return install([], { home: inHome, path: opts.path, env: { VIBEFORGE_RELEASES: releases, ...opts.env } });
}

const noBuildPath = () => `${nobuild}:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
const leftovers = (inHome: string) => [".next", ".download"].filter((end) => fs.existsSync(`${app(inHome)}${end}`));

describe("the installer with ready-made builds", () => {
  let home2 = "";

  beforeAll(async () => {
    srv = path.join(dir, "server");
    nobuild = path.join(dir, "nobuild");
    home2 = path.join(dir, "home2");
    for (const folder of [srv, nobuild, home2]) fs.mkdirSync(folder, { recursive: true });
    for (const tool of ["git", "make", "g++", "python3", "npm"]) {
      fs.writeFileSync(path.join(nobuild, tool), `#!/bin/sh\necho "the installer ran ${tool}" >&2\nexit 99\n`, { mode: 0o755 });
    }
    const child = spawn(process.execPath, ["-e", SERVER, srv], { stdio: ["ignore", "pipe", "inherit"] });
    server = child;
    const port = await new Promise<string>((resolve) => child.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())));
    releases = `http://127.0.0.1:${port}/releases`;
  });

  afterAll(() => {
    server?.kill();
  });

  it("installs the latest release's ready-made build with no git, compiler or npm", () => {
    publish("2.0.0");
    const result = installReleased(home2, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).not.toContain("the installer ran");
    expect(result.out).toContain(`Downloading VibeForge 2.0.0, ready-made for linux-${arch}`);
    expect(result.out).toContain("From the release's ready-made build.");
    expect(result.out).toContain("VibeForge 2.0.0 is installed.");
    expect(built(app(home2))).toBe("2.0.0");
    expect(fs.existsSync(path.join(app(home2), ".vibeforge-installer"))).toBe(true);
    expect(fs.existsSync(path.join(app(home2), ".git"))).toBe(false);
    expect(fs.readlinkSync(path.join(home2, ".local", "bin", "vibeforge"))).toBe(path.join(app(home2), "scripts", "vibeforge"));
    expect(leftovers(home2)).toEqual([]);
  });

  it("updates an install that is still a git checkout, keeping the checkout as .previous", () => {
    const home3 = path.join(dir, "home3");
    fs.mkdirSync(home3);
    // What the installer made before releases carried a build: a clone of the newest tag.
    let result = install([], { home: home3 });
    expect(result.status, result.out).toBe(0);
    expect(fs.existsSync(path.join(app(home3), ".git"))).toBe(true);
    const before = built(app(home3));
    publish("2.1.0");
    result = installReleased(home3, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(built(app(home3))).toBe("2.1.0");
    expect(fs.existsSync(path.join(app(home3), ".git"))).toBe(false);
    expect(built(`${app(home3)}.previous`)).toBe(before);
    expect(fs.existsSync(path.join(`${app(home3)}.previous`, ".git"))).toBe(true);
    expect(leftovers(home3)).toEqual([]);
  });

  it("refuses a download that doesn't match SHA256SUMS and leaves the installed copy as it was", () => {
    publish("2.2.0", "bad");
    const result = installReleased(home2, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("does not match v2.2.0's SHA256SUMS");
    expect(result.out).toContain("is unchanged");
    expect(built(app(home2))).toBe("2.0.0");
    expect(leftovers(home2)).toEqual([]);
  });

  it("installs the release VIBEFORGE_VERSION names instead of the latest", () => {
    publish("2.3.0");
    const result = installReleased(home2, { path: noBuildPath(), env: { VIBEFORGE_VERSION: "2.1.0" } });
    expect(result.status, result.out).toBe(0);
    expect(built(app(home2))).toBe("2.1.0");
    expect(built(`${app(home2)}.previous`)).toBe("2.0.0");
  });

  it("builds from source when the release has no ready-made build, and says so", () => {
    // A release from before these builds: a SHA256SUMS for install.sh only, or none at all.
    release("2.4.0");
    publish("2.4.0", "no-archive");
    let result = installReleased(home2);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain(`Building from source: the v2.4.0 release has no ready-made build for linux-${arch}`);
    expect(result.out).toContain("Built from source on this computer.");
    expect(built(app(home2))).toBe("2.4.0");
    // The ready-made copy it replaced had no history, so this one is a fresh clone.
    expect(fs.existsSync(path.join(app(home2), ".git"))).toBe(true);
    expect(built(`${app(home2)}.previous`)).toBe("2.1.0");
    release("2.5.0");
    publish("2.5.0", "none");
    result = installReleased(home2);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: the v2.5.0 release has no ready-made build");
    expect(built(app(home2))).toBe("2.5.0");
    expect(leftovers(home2)).toEqual([]);
  });

  it("builds from source when asked to, or on a CPU with no ready-made build", () => {
    release("2.6.0");
    publish("2.6.0");
    let result = installReleased(home2, { env: { VIBEFORGE_FROM_SOURCE: "1" } });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: VIBEFORGE_FROM_SOURCE=1");
    expect(built(app(home2))).toBe("2.6.0");
    expect(fs.existsSync(path.join(app(home2), ".git"))).toBe(true);
    const cpu = path.join(dir, "riscv");
    fs.mkdirSync(cpu, { recursive: true });
    fs.writeFileSync(path.join(cpu, "uname"), '#!/bin/sh\n[ "$1" = -m ] && echo riscv64 && exit 0\nexec /usr/bin/uname "$@"\n', { mode: 0o755 });
    result = installReleased(home2, { path: `${cpu}:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: there is no ready-made build for riscv64");
    expect(built(app(home2))).toBe("2.6.0");
  });
});
