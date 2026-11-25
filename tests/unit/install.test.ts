import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { treeHash } from "../../scripts/pack-release.mjs";
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
/** The version that starts, and the one Go back returns to. */
const cur = (inHome = home) => path.join(app(inHome), "current");
const prev = (inHome = home) => path.join(app(inHome), "previous");
const built = (folder: string) => fs.readFileSync(path.join(folder, "dist-electron", "main.js"), "utf8");
/** What a stopped run could leave: a stage beside the versions, or a download. */
const stages = (inHome = home) =>
  [
    ...["versions", "runtime"].flatMap((sub) => {
      try {
        return fs.readdirSync(path.join(app(inHome), sub)).filter((name) => name.startsWith(".stage-")).map((name) => `${sub}/${name}`);
      } catch {
        return [];
      }
    }),
    ...[".download"].filter((name) => fs.existsSync(path.join(app(inHome), name))),
  ];

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
  const hasNpm = [`${path.dirname(process.execPath)}`, "/usr/bin", "/bin"].some((dirPath) => {
    try {
      fs.accessSync(path.join(dirPath, "npm"), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!hasNpm) {
    fs.writeFileSync(
      path.join(stubs, "npm"),
      `#!/bin/sh\ncase "$1" in\n  ci) exec "${process.execPath}" install.cjs ;;\n  run) [ "$2" = "build" ] && exec "${process.execPath}" build.cjs ;;\nesac\nexit 1\n`,
      { mode: 0o755 },
    );
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
    expect(built(cur())).toBe("1.0.0");
    expect(fs.readlinkSync(cur())).toBe("versions/1.0.0");
    expect(fs.existsSync(path.join(app(), ".vibeforge-installer"))).toBe(true);
    expect(fs.existsSync(path.join(cur(), ".vibeforge-installer"))).toBe(true);
    // Through `current`, so the command always starts the installed version.
    expect(fs.readlinkSync(path.join(home, ".local", "bin", "vibeforge"))).toBe(path.join(cur(), "scripts", "vibeforge"));
    expect(fs.readFileSync(path.join(home, ".local", "share", "applications", "vibeforge.desktop"), "utf8")).toContain(`Exec=${home}/.local/bin/vibeforge\n`);
    expect(stages()).toEqual([]);
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
      expect(fs.existsSync(path.join(cur(), file)), file).toBe(true);
    }
    expect(built(cur())).toBe("1.0.0");
    expect(stages()).toEqual([]);
  });

  it("switches to a good update and keeps the copy it replaced to go back to", () => {
    release("1.3.0");
    const result = install([], { path: `${home}/.local/bin:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    expect(result.status, result.out).toBe(0);
    expect(built(cur())).toBe("1.3.0");
    expect(built(prev())).toBe("1.0.0");
    expect(result.out).toContain("VibeForge 1.0.0 is kept");
    expect(stages()).toEqual([]);
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
    // What it leaves, and says so: the browser profile, the cache, and nothing about keys it didn't add.
    expect(result.out).toContain("~/.config/VibeForge");
    expect(result.out).toContain("~/.cache/vibeforge");
    expect(result.out).toContain("quit it");
    expect(result.out).not.toContain("hold-to-talk");
  });

  it("points at the voice key lines on --uninstall when Settings → Voice added them", () => {
    const hypr = path.join(home, ".config", "hypr");
    fs.mkdirSync(hypr, { recursive: true });
    fs.writeFileSync(path.join(hypr, "bindings.conf"), "# VibeForge voice: hold to talk to one agent, from anywhere\nbind = SUPER ALT, V, exec, vibeforge --voice start\n");
    const result = install(["--uninstall"]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("hold-to-talk key");
    // Only pointed at: the person's own config is never edited.
    expect(fs.readFileSync(path.join(hypr, "bindings.conf"), "utf8")).toContain("VibeForge voice");
    fs.rmSync(hypr, { recursive: true });
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

/**
 * A stand-in for GitHub's releases: /latest redirects to the tag in `latest`, files are served as they
 * are, and a path with a "<path>.status" file beside it answers with that HTTP status instead.
 */
const SERVER = `
const fs = require("fs"), http = require("http"), path = require("path");
const root = process.argv[1];
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let forced = "";
  try { forced = fs.readFileSync(path.join(root, path.normalize(url.pathname) + ".status"), "utf8").trim(); } catch {}
  if (forced) {
    res.writeHead(Number(forced));
    return res.end("forced");
  }
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

/**
 * A stand-in Electron: as Node (ELECTRON_RUN_AS_NODE, how the installer loads node-pty and the
 * terminal host runs) it is this Node; otherwise it says which it is.
 */
const asNodeElectron = (version: string) =>
  `#!/bin/sh\nif [ -n "$ELECTRON_RUN_AS_NODE" ]; then echo "electron ${version} as node" >&2; exec "${process.execPath}" "$@"; fi\necho "electron ${version} $*"\n`;

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
 * `broken` breaks the archive itself: a terminal engine this system can't load, no icon, or an
 * archive that doesn't unpack (its checksum still matches).
 */
function publish(version: string, sums: "good" | "bad" | "no-archive" | "none" = "good", broken?: "pty" | "icon" | "unpack") {
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
  write("node_modules/electron/dist/electron", asNodeElectron("whole"), 0o755);
  write("node_modules/node-pty/build/Release/pty.node", "");
  // The installer loads node-pty to see that its addon works here; this one stands in for it.
  write("node_modules/node-pty/package.json", JSON.stringify({ name: "node-pty", main: "index.js" }));
  write("node_modules/node-pty/index.js", broken === "pty" ? 'throw new Error("GLIBC_2.39 not found");\n' : "module.exports = {};\n");
  write("scripts/vibeforge", "#!/bin/sh\n", 0o755);
  if (broken !== "icon") write("resources/icon.png", "");
  write("resources/icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  write(".vibeforge-installer", "");
  fs.mkdirSync(files, { recursive: true });
  const archive = path.join(files, `${name}.tar.zst`);
  if (broken === "unpack") fs.writeFileSync(archive, "this is not a zstd archive");
  else execFileSync("tar", ["--zstd", "-cf", archive, "-C", path.dirname(tree), name]);
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

describe("the installer with ready-made builds", () => {
  let home2 = "";

  beforeAll(async () => {
    srv = path.join(dir, "server");
    nobuild = path.join(dir, "nobuild");
    home2 = path.join(dir, "home2");
    for (const folder of [srv, nobuild, home2]) fs.mkdirSync(folder, { recursive: true });
    // node too: a ready-made build installs without Node (the terminal host runs on Electron's).
    for (const tool of ["git", "make", "g++", "python3", "npm", "node"]) {
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
    expect(built(cur(home2))).toBe("2.0.0");
    expect(fs.existsSync(path.join(app(home2), ".vibeforge-installer"))).toBe(true);
    expect(fs.existsSync(path.join(cur(home2), ".git"))).toBe(false);
    expect(fs.readlinkSync(path.join(home2, ".local", "bin", "vibeforge"))).toBe(path.join(cur(home2), "scripts", "vibeforge"));
    expect(stages(home2)).toEqual([]);
  });

  it("updates an install from before versions/ that is still a git checkout, keeping the checkout to go back to", () => {
    const home3 = path.join(dir, "home3");
    fs.mkdirSync(home3);
    // What the installer made before releases carried a build: a clone of the newest tag, built,
    // straight in the install folder, with the command linking into it.
    execFileSync("git", ["clone", "-q", fake, app(home3)], { env: { ...process.env, ...gitEnv } });
    execFileSync("git", ["-C", app(home3), "checkout", "-q", "v1.0.0"], { env: { ...process.env, ...gitEnv } });
    for (const step of ["install.cjs", "build.cjs"]) execFileSync(process.execPath, [step], { cwd: app(home3) });
    fs.mkdirSync(path.join(home3, ".local", "bin"), { recursive: true });
    fs.symlinkSync(path.join(app(home3), "scripts", "vibeforge"), path.join(home3, ".local", "bin", "vibeforge"));
    publish("2.1.0");
    const result = installReleased(home3, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Moving VibeForge 1.0.0 into");
    expect(built(cur(home3))).toBe("2.1.0");
    expect(fs.existsSync(path.join(cur(home3), ".git"))).toBe(false);
    expect(built(prev(home3))).toBe("1.0.0");
    expect(fs.readlinkSync(prev(home3))).toBe("versions/1.0.0");
    expect(fs.existsSync(path.join(prev(home3), ".git"))).toBe(true);
    // Nothing runs from the old files, so they are gone from the install folder itself.
    expect(fs.readdirSync(app(home3)).sort()).toEqual([".vibeforge-installer", "current", "previous", "versions"]);
    expect(fs.readlinkSync(path.join(home3, ".local", "bin", "vibeforge"))).toBe(path.join(cur(home3), "scripts", "vibeforge"));
    expect(stages(home3)).toEqual([]);
  });

  it("refuses a download that doesn't match SHA256SUMS and leaves the installed copy as it was", () => {
    publish("2.2.0", "bad");
    const result = installReleased(home2, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("does not match v2.2.0's SHA256SUMS");
    expect(result.out).toContain("is unchanged");
    expect(built(cur(home2))).toBe("2.0.0");
    expect(stages(home2)).toEqual([]);
  });

  it("stops with the installed copy as it was when the download fails part-way", () => {
    publish("2.2.1");
    fs.rmSync(path.join(srv, "releases", "download", "v2.2.1", `vibeforge-2.2.1-linux-${arch}.tar.zst`));
    const result = installReleased(home2, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("The download stopped part-way");
    expect(built(cur(home2))).toBe("2.0.0");
    expect(stages(home2)).toEqual([]);
  });

  it("installs the release VIBEFORGE_VERSION names instead of the latest", () => {
    publish("2.3.0");
    const result = installReleased(home2, { path: noBuildPath(), env: { VIBEFORGE_VERSION: "2.1.0" } });
    expect(result.status, result.out).toBe(0);
    expect(built(cur(home2))).toBe("2.1.0");
    expect(built(prev(home2))).toBe("2.0.0");
  });

  it("builds from source when the release has no ready-made build, and says so", () => {
    // A release from before these builds: a SHA256SUMS for install.sh only, or none at all.
    release("2.4.0");
    publish("2.4.0", "no-archive");
    let result = installReleased(home2);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain(`Building from source: the v2.4.0 release has no ready-made build for linux-${arch}`);
    expect(result.out).toContain("Built from source on this computer.");
    expect(built(cur(home2))).toBe("2.4.0");
    // The ready-made copy it replaced had no history, so this one is a fresh clone.
    expect(fs.existsSync(path.join(cur(home2), ".git"))).toBe(true);
    expect(built(prev(home2))).toBe("2.1.0");
    release("2.5.0");
    publish("2.5.0", "none");
    result = installReleased(home2);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: the v2.5.0 release has no ready-made build");
    expect(built(cur(home2))).toBe("2.5.0");
    expect(stages(home2)).toEqual([]);
  });

  it("builds from source when asked to, or on a CPU with no ready-made build", () => {
    release("2.6.0");
    publish("2.6.0");
    let result = installReleased(home2, { env: { VIBEFORGE_FROM_SOURCE: "1" } });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: VIBEFORGE_FROM_SOURCE=1");
    expect(built(cur(home2))).toBe("2.6.0");
    expect(fs.existsSync(path.join(cur(home2), ".git"))).toBe(true);
    const cpu = path.join(dir, "riscv");
    fs.mkdirSync(cpu, { recursive: true });
    fs.writeFileSync(path.join(cpu, "uname"), '#!/bin/sh\n[ "$1" = -m ] && echo riscv64 && exit 0\nexec /usr/bin/uname "$@"\n', { mode: 0o755 });
    // 2.6.0 is installed already: VIBEFORGE_FORCE=1 has it made again, which this CPU can only do from source.
    result = installReleased(home2, { path: `${cpu}:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`, env: { VIBEFORGE_FORCE: "1" } });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: there is no ready-made build for riscv64");
    expect(built(cur(home2))).toBe("2.6.0");
  });

  /** A fresh home with the ready-made `version` installed in it. */
  function homeWith(name: string, version: string): string {
    const fresh = path.join(dir, name);
    fs.mkdirSync(fresh);
    publish(version);
    const result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    return fresh;
  }

  const forced = (file: string, status: number | null) => {
    const marker = path.join(srv, `${file}.status`);
    if (status === null) fs.rmSync(marker, { force: true });
    else fs.writeFileSync(marker, String(status));
  };

  it("stops on a GitHub error instead of building from source, and only 404 means no ready-made build", () => {
    const fresh = homeWith("home-http", "3.0.0");
    publish("3.0.1");
    forced("releases/download/v3.0.1/SHA256SUMS", 503);
    let result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("GitHub answered 503 for v3.0.1's checksums");
    expect(result.out).not.toContain("Building from source");
    expect(result.out).not.toContain("the installer ran");
    expect(built(cur(fresh))).toBe("3.0.0");
    forced("releases/download/v3.0.1/SHA256SUMS", null);

    forced("releases/latest", 429);
    result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("GitHub answered 429 when asked for the latest release");
    expect(result.out).not.toContain("Building from source");
    forced("releases/latest", null);

    // The same release with its checksums answered 404 is one from before ready-made builds.
    release("3.0.1");
    forced("releases/download/v3.0.1/SHA256SUMS", 404);
    result = installReleased(fresh);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Building from source: the v3.0.1 release has no ready-made build");
    forced("releases/download/v3.0.1/SHA256SUMS", null);
    expect(stages(fresh)).toEqual([]);
  });

  it("downloads nothing when the latest release is installed already, unless VIBEFORGE_FORCE=1", () => {
    const fresh = homeWith("home-current", "3.1.0");
    publish("3.1.1");
    expect(installReleased(fresh, { path: noBuildPath() }).status).toBe(0);
    fs.rmSync(path.join(fresh, ".local", "bin", "vibeforge"));
    // The archive is gone from the server: a download would fail, so a pass means none was tried.
    fs.rmSync(path.join(srv, "releases", "download", "v3.1.1", `vibeforge-3.1.1-linux-${arch}.tar.zst`));
    let result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("VibeForge 3.1.1 is installed already");
    expect(result.out).not.toContain("Downloading");
    expect(built(cur(fresh))).toBe("3.1.1");
    // The way back is still the copy before this one, not a second copy of this one.
    expect(built(prev(fresh))).toBe("3.1.0");
    // What someone may have run it again for: the command comes back.
    expect(fs.readlinkSync(path.join(fresh, ".local", "bin", "vibeforge"))).toBe(path.join(cur(fresh), "scripts", "vibeforge"));
    publish("3.1.1");
    result = installReleased(fresh, { path: noBuildPath(), env: { VIBEFORGE_FORCE: "1" } });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Downloading VibeForge 3.1.1");
    // The running 3.1.1 keeps its folder; the new copy goes beside it.
    expect(fs.readlinkSync(cur(fresh))).toBe("versions/3.1.1+2");
    expect(fs.readlinkSync(prev(fresh))).toBe("versions/3.1.1");
    expect(built(prev(fresh))).toBe("3.1.1");
  });

  it("keeps the copy to go back to when an update fails before the swap", () => {
    const fresh = homeWith("home-keep", "3.2.0");
    publish("3.2.1");
    expect(installReleased(fresh, { path: noBuildPath() }).status).toBe(0);
    expect(built(prev(fresh))).toBe("3.2.0");
    publish("3.2.2", "good", "unpack");
    const result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Could not unpack");
    expect(built(cur(fresh))).toBe("3.2.1");
    expect(built(prev(fresh))).toBe("3.2.0");
    expect(stages(fresh)).toEqual([]);
  });

  it("leaves the installed copy in place when moving the new one beside it fails", () => {
    const fresh = homeWith("home-swap", "3.3.0");
    publish("3.3.1");
    // An mv that can't move the finished copy out of its stage.
    const stub = path.join(dir, "mv-fails");
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, "mv"), '#!/bin/sh\ncase "$*" in *"/versions/.stage-"[0-9]*) echo "mv: no room" >&2; exit 1 ;; esac\nexec /usr/bin/mv "$@"\n', { mode: 0o755 });
    const result = installReleased(fresh, { path: `${stub}:${noBuildPath()}` });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Could not move the new copy");
    expect(built(cur(fresh))).toBe("3.3.0");
    expect(stages(fresh)).toEqual([]);
  });

  it("builds the terminal engine from source when the ready-made one doesn't load here", () => {
    const fresh = homeWith("home-pty", "3.4.0");
    release("3.4.1");
    publish("3.4.1", "good", "pty");
    const result = installReleased(fresh);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("GLIBC_2.39 not found");
    expect(result.out).toContain("Building from source: the ready-made terminal engine doesn't load on this system");
    expect(built(cur(fresh))).toBe("3.4.1");
    expect(stages(fresh)).toEqual([]);
  });

  it("installs without an icon it can't copy, and says when the command can't be added", () => {
    const fresh = path.join(dir, "home-icon");
    fs.mkdirSync(fresh);
    publish("3.5.0", "good", "icon");
    let result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Could not copy the app icon");
    expect(built(cur(fresh))).toBe("3.5.0");
    // ~/.local/bin is a file, so the command can't go in: the new copy is in, and it says what failed.
    publish("3.5.1");
    fs.rmSync(path.join(fresh, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(fresh, ".local", "bin"), "");
    result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(built(cur(fresh))).toBe("3.5.1");
    expect(result.out).toContain("VibeForge 3.5.1 is in");
    expect(result.out).toContain("Run this again.");
  });

  it("lets one installer run at a time", async () => {
    const fresh = homeWith("home-lock", "3.6.0");
    publish("3.6.1");
    // The lock is held by the sleep itself, so killing it lets go.
    const holder = spawn("bash", ["-c", 'exec 9>"$0"; flock 9; exec sleep 30', `${app(fresh)}.lock`], { stdio: "ignore" });
    try {
      // flock has the lock once its sleep is running.
      for (let tries = 0; tries < 100; tries++) {
        if (spawnSync("flock", ["-n", `${app(fresh)}.lock`, "true"]).status !== 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result = installReleased(fresh, { path: noBuildPath() });
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("Another VibeForge install or update is running");
      expect(built(cur(fresh))).toBe("3.6.0");
    } finally {
      holder.kill();
      await new Promise((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve(null) : holder.once("exit", resolve)));
    }
    const result = installReleased(fresh, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(built(cur(fresh))).toBe("3.6.1");
  });

  it("quotes Exec in vibeforge.desktop when HOME contains spaces", () => {
    const spaced = path.join(dir, "home with spaces");
    fs.mkdirSync(spaced, { recursive: true });
    publish("3.7.0");
    const result = installReleased(spaced, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    const desktop = fs.readFileSync(path.join(spaced, ".local", "share", "applications", "vibeforge.desktop"), "utf8");
    expect(desktop).toContain(`Exec="${path.join(spaced, ".local", "bin", "vibeforge")}"\n`);
  });

  it("removes the app folder on --purge-app while keeping user data untouched and refusing unknown directories", () => {
    const fresh = homeWith("home-purge", "3.8.0");
    publish("3.8.1");
    expect(installReleased(fresh, { path: noBuildPath() }).status).toBe(0);
    const userCfg = path.join(fresh, ".config", "vibeforge", "settings.yaml");
    fs.mkdirSync(path.dirname(userCfg), { recursive: true });
    fs.writeFileSync(userCfg, "theme: omarchy\n");

    const result = install(["--purge-app"], { home: fresh });
    expect(result.status, result.out).toBe(0);
    expect(fs.existsSync(app(fresh))).toBe(false);
    expect(fs.existsSync(`${app(fresh)}.lock`)).toBe(false);
    expect(fs.readFileSync(userCfg, "utf8")).toBe("theme: omarchy\n");
    expect(result.out).toContain("Removed the app files");

    const foreign = path.join(dir, "not-vibeforge");
    fs.mkdirSync(path.join(foreign, "keep"), { recursive: true });
    const refused = install(["--purge-app"], { home: fresh, env: { VIBEFORGE_HOME: foreign } });
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("Refusing to remove it");
    expect(fs.existsSync(path.join(foreign, "keep"))).toBe(true);
  });

  it("tailors missing-package hints to apt-get on Debian/Ubuntu systems without pacman", () => {
    const aptHome = path.join(dir, "home-apt");
    const aptBin = path.join(dir, "apt-bin");
    fs.mkdirSync(aptHome, { recursive: true });
    fs.mkdirSync(aptBin, { recursive: true });
    for (const cmd of ["bash", "uname", "realpath", "dirname", "mkdir"]) {
      const target = [`/usr/bin/${cmd}`, `/bin/${cmd}`].find((p) => fs.existsSync(p));
      if (target) fs.symlinkSync(target, path.join(aptBin, cmd));
    }
    fs.symlinkSync(process.execPath, path.join(aptBin, "node"));
    fs.writeFileSync(path.join(aptBin, "apt-get"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = install([], { home: aptHome, path: aptBin, env: { VIBEFORGE_RELEASES: releases } });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("sudo apt-get install -y curl");
    expect(result.out).not.toContain("pacman");
  });

  it("restricts curl to HTTPS protocols and redirects when fetching from an https:// release URL", () => {
    const httpsHome = path.join(dir, "home-https");
    const stubBin = path.join(dir, "https-bin");
    const curlLog = path.join(dir, "curl-https.argv");
    fs.mkdirSync(httpsHome, { recursive: true });
    fs.mkdirSync(stubBin, { recursive: true });
    fs.writeFileSync(
      path.join(stubBin, "curl"),
      `#!/bin/sh\nprintf '%s\n' "$*" > "${curlLog}"\nexit 22\n`,
      { mode: 0o755 },
    );

    const result = install([], {
      home: httpsHome,
      path: `${stubBin}:${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      env: { VIBEFORGE_RELEASES: "https://github.com/L0nE-F0x/VibeForge/releases" },
    });
    expect(result.status).not.toBe(0);
    const argv = fs.readFileSync(curlLog, "utf8");
    expect(argv).toContain("--proto =https");
    expect(argv).toContain("--proto-redir =https");
  });

  // ---------------------------------------------------------------- split releases and versions

  /** What an Electron or a Syncthing of this version holds, for the release and for an old install. */
  const runtimeFiles = (kind: "electron" | "syncthing", version: string): Record<string, [string, number]> =>
    kind === "electron"
      ? { electron: [asNodeElectron(version), 0o755], version: [version, 0o644], "locales/en-US.pak": [`pak ${version}`, 0o644] }
      : { syncthing: [`#!/bin/sh\necho syncthing ${version}\n`, 0o755], PIN: [`v${version} ${arch}`, 0o644] };

  const writeFiles = (folder: string, files: Record<string, [string, number]>) => {
    for (const [file, [text, mode]] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), text, { mode });
    }
  };

  /** The app's own files, without Electron and Syncthing. Its launcher says which version it is. */
  const appFiles = (version: string): Record<string, [string, number]> => ({
    "package.json": [JSON.stringify({ name: "vibeforge", version }, null, 2), 0o644],
    "dist/index.html": ["", 0o644],
    "dist-electron/main.js": [version, 0o644],
    "electron/pty-host.cjs": ["", 0o644],
    "node_modules/electron/package.json": [JSON.stringify({ name: "electron" }), 0o644],
    "node_modules/node-pty/build/Release/pty.node": ["", 0o644],
    "node_modules/node-pty/package.json": [JSON.stringify({ name: "node-pty", main: "index.js" }), 0o644],
    "node_modules/node-pty/index.js": ["module.exports = {};\n", 0o644],
    "scripts/vibeforge": [`#!/bin/sh\necho "launcher ${version} $*"\n`, 0o755],
    "resources/icon.png": ["", 0o644],
    "resources/icon.svg": ["<svg xmlns='http://www.w3.org/2000/svg'/>", 0o644],
    ".vibeforge-installer": ["", 0o644],
  });

  /**
   * A release split like pack-release.mjs splits it: the app with a manifest.json, and Electron and
   * Syncthing archives. `wrongTree` gives the manifest a hash the Electron archive doesn't match.
   */
  function publishSplit(version: string, opts: { electron?: string; syncthing?: string; wrongTree?: boolean } = {}) {
    const tag = `v${version}`;
    const files = path.join(srv, "releases", "download", tag);
    const trees = fs.mkdtempSync(path.join(dir, "split-"));
    fs.mkdirSync(files, { recursive: true });
    const lines: string[] = [];
    const pack = (name: string) => {
      const archive = path.join(files, `${name}.tar.zst`);
      execFileSync("tar", ["--zstd", "-cf", archive, "-C", trees, name]);
      lines.push(`${sha256(archive)}  ${name}.tar.zst`);
    };
    const manifest: Record<string, string> = { version, arch };
    for (const kind of ["electron", "syncthing"] as const) {
      const runtimeVersion = (kind === "electron" ? opts.electron : opts.syncthing) ?? (kind === "electron" ? "40.1.0" : "2.1.7");
      const name = `${kind}-${runtimeVersion}-linux-${arch}`;
      writeFiles(path.join(trees, name), runtimeFiles(kind, runtimeVersion));
      manifest[kind] = name;
      manifest[`${kind}Tree`] = kind === "electron" && opts.wrongTree ? "f".repeat(64) : treeHash(path.join(trees, name));
      pack(name);
    }
    const name = `vibeforge-app-${version}-linux-${arch}`;
    writeFiles(path.join(trees, name), { ...appFiles(version), "manifest.json": [JSON.stringify(manifest, null, 2), 0o644] });
    pack(name);
    fs.writeFileSync(path.join(files, "install.sh"), script);
    lines.unshift(`${sha256(path.join(files, "install.sh"))}  install.sh`);
    fs.writeFileSync(path.join(files, "SHA256SUMS"), `${lines.join("\n")}\n`);
    fs.writeFileSync(path.join(srv, "latest"), tag);
  }

  /** A program started from `arg0`, as a running VibeForge is, until it is killed. */
  async function runningFrom(arg0: string): Promise<() => Promise<void>> {
    const child = spawn("bash", ["-c", 'exec -a "$0" sleep 120', arg0], { stdio: "ignore" });
    for (let tries = 0; tries < 100; tries++) {
      try {
        if (fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8").startsWith(arg0)) break;
      } catch {
        /* not started yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return async () => {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once("exit", resolve)));
    };
  }

  const runtimes = (inHome: string) => fs.readdirSync(path.join(app(inHome), "runtime")).sort();
  const versions = (inHome: string) => fs.readdirSync(path.join(app(inHome), "versions")).sort();
  let split = "";

  it("installs a split release fresh: the app, Electron and Syncthing, the version linked to the last two", () => {
    split = path.join(dir, "home-split");
    fs.mkdirSync(split);
    publishSplit("4.0.0");
    const result = installReleased(split, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    for (const what of ["VibeForge 4.0.0, ready-made", "Electron 40.1.0", "Syncthing 2.1.7"]) expect(result.out).toContain(`Downloading ${what}`);
    expect(result.out).toMatch(/Downloaded \d+\.\d MB\./);
    expect(fs.readlinkSync(cur(split))).toBe("versions/4.0.0");
    const electron = fs.readlinkSync(path.join(cur(split), "node_modules", "electron", "dist"));
    expect(electron).toMatch(new RegExp(`^\\.\\./\\.\\./\\.\\./\\.\\./runtime/electron-40\\.1\\.0-linux-${arch}-[0-9a-f]{12}$`));
    expect(fs.readFileSync(path.join(cur(split), "node_modules", "electron", "dist", "electron"), "utf8")).toContain("electron 40.1.0");
    expect(fs.readFileSync(path.join(cur(split), "vendor", "syncthing", "syncthing"), "utf8")).toContain("syncthing 2.1.7");
    expect(runtimes(split)).toHaveLength(2);
    expect(stages(split)).toEqual([]);
  });

  it("downloads only the app when Electron and Syncthing are unchanged", () => {
    publishSplit("4.0.1");
    // Gone from the server: a pass means they were not downloaded.
    for (const file of [`electron-40.1.0-linux-${arch}.tar.zst`, `syncthing-2.1.7-linux-${arch}.tar.zst`]) fs.rmSync(path.join(srv, "releases", "download", "v4.0.1", file));
    const result = installReleased(split, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Electron 40.1.0 is here already and unchanged");
    expect(result.out).toContain("Electron 40.1.0 and Syncthing 2.1.7 were here already");
    expect(result.out).not.toContain("Downloading Electron");
    expect(fs.readlinkSync(cur(split))).toBe("versions/4.0.1");
    expect(fs.readlinkSync(prev(split))).toBe("versions/4.0.0");
    expect(runtimes(split)).toHaveLength(2);
  });

  it("downloads a new Electron, and removes the old one once no kept version uses it", () => {
    publishSplit("4.1.0", { electron: "41.0.0" });
    let result = installReleased(split, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Downloading Electron 41.0.0");
    expect(result.out).not.toContain("Downloading Syncthing");
    // 4.0.1 is previous and still uses 40.1.0; 4.0.0 is neither, so it is gone.
    expect(versions(split)).toEqual(["4.0.1", "4.1.0"]);
    expect(runtimes(split).map((name) => name.replace(/-[0-9a-f]{12}$/, ""))).toEqual([`electron-40.1.0-linux-${arch}`, `electron-41.0.0-linux-${arch}`, `syncthing-2.1.7-linux-${arch}`]);
    publishSplit("4.2.0", { electron: "41.0.0" });
    result = installReleased(split, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(versions(split)).toEqual(["4.1.0", "4.2.0"]);
    expect(runtimes(split).map((name) => name.replace(/-[0-9a-f]{12}$/, ""))).toEqual([`electron-41.0.0-linux-${arch}`, `syncthing-2.1.7-linux-${arch}`]);
  });

  it("refuses an Electron whose files are not the ones the app was built with", () => {
    publishSplit("4.3.0", { electron: "42.0.0", wrongTree: true });
    const result = installReleased(split, { path: noBuildPath() });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("is not the one this version of VibeForge was built with");
    expect(result.out).toContain("is unchanged");
    expect(fs.readlinkSync(cur(split))).toBe("versions/4.2.0");
    expect(runtimes(split).some((name) => name.includes("42.0.0"))).toBe(false);
    expect(stages(split)).toEqual([]);
  });

  it("goes back with --rollback and forward again, and says when there is nothing to go back to", () => {
    let result = install(["--rollback"], { home: split });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("Going back from VibeForge 4.2.0 to 4.1.0");
    expect(fs.readlinkSync(cur(split))).toBe("versions/4.1.0");
    expect(fs.readlinkSync(prev(split))).toBe("versions/4.2.0");
    expect(fs.readlinkSync(path.join(split, ".local", "bin", "vibeforge"))).toBe(path.join(cur(split), "scripts", "vibeforge"));
    // Updating from the version gone back to downloads nothing: the newer one is still here. The
    // folder an app passes may be its own version's.
    result = installReleased(split, { path: noBuildPath(), env: { VIBEFORGE_HOME: path.join(app(split), "versions", "4.1.0"), VIBEFORGE_VERSION: "4.2.0" } });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("VibeForge 4.2.0 is here already");
    expect(result.out).not.toContain("Downloading");
    expect(fs.readlinkSync(cur(split))).toBe("versions/4.2.0");
    expect(fs.existsSync(path.join(app(split), "versions", "4.1.0", "versions"))).toBe(false);

    const once = path.join(dir, "home-once");
    fs.mkdirSync(once);
    publishSplit("4.3.1");
    expect(installReleased(once, { path: noBuildPath() }).status).toBe(0);
    result = install(["--rollback"], { home: once });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("There is no earlier version of VibeForge to go back to");
    expect(fs.readlinkSync(cur(once))).toBe("versions/4.3.1");
  });

  it("updates an install from before versions/ under the running copy, which keeps its files until it quits", async () => {
    const old = path.join(dir, "home-372");
    const dest = app(old);
    // A 3.7.2 as its installer left it: the app straight in the folder, Electron and Syncthing inside it.
    writeFiles(dest, { ...appFiles("3.7.2"), ...Object.fromEntries(Object.entries(runtimeFiles("electron", "40.1.0")).map(([file, value]) => [`node_modules/electron/dist/${file}`, value])) });
    writeFiles(path.join(dest, "vendor", "syncthing"), runtimeFiles("syncthing", "2.1.7"));
    fs.mkdirSync(`${dest}.previous`, { recursive: true });
    fs.mkdirSync(path.join(old, ".local", "bin"), { recursive: true });
    fs.symlinkSync(path.join(dest, "scripts", "vibeforge"), path.join(old, ".local", "bin", "vibeforge"));
    // Its terminals' `vibeforge`, which it links into the data folder.
    const data = path.join(old, ".local", "share", "vibeforge");
    fs.mkdirSync(path.join(data, "bin"), { recursive: true });
    fs.symlinkSync(path.join(dest, "scripts", "vibeforge"), path.join(data, "bin", "vibeforge"));
    fs.mkdirSync(path.join(old, ".config", "vibeforge"), { recursive: true });
    fs.writeFileSync(path.join(old, ".config", "vibeforge", "settings.yaml"), "theme: omarchy\n");
    const stop = await runningFrom(path.join(dest, "node_modules", "electron", "dist", "electron"));
    try {
      publishSplit("4.4.0");
      for (const file of [`electron-40.1.0-linux-${arch}.tar.zst`, `syncthing-2.1.7-linux-${arch}.tar.zst`]) fs.rmSync(path.join(srv, "releases", "download", "v4.4.0", file));
      // What 3.7.2's Update runs: its own folder as VIBEFORGE_HOME.
      const result = installReleased(old, { path: noBuildPath(), env: { VIBEFORGE_HOME: dest } });
      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain("Moving VibeForge 3.7.2 into");
      // The same Electron and Syncthing as the old copy's: taken from it, not downloaded.
      expect(result.out).toContain("Electron 40.1.0 and Syncthing 2.1.7 were here already");
      expect(fs.readlinkSync(cur(old))).toBe("versions/4.4.0");
      expect(fs.readlinkSync(prev(old))).toBe("versions/3.7.2");
      expect(built(prev(old))).toBe("3.7.2");
      expect(fs.readlinkSync(path.join(old, ".local", "bin", "vibeforge"))).toBe(path.join(cur(old), "scripts", "vibeforge"));
      expect(fs.existsSync(`${dest}.previous`)).toBe(false);
      expect(fs.readFileSync(path.join(old, ".config", "vibeforge", "settings.yaml"), "utf8")).toBe("theme: omarchy\n");
      // The open 3.7.2 keeps its files, and its terminals' command still runs.
      expect(built(dest)).toBe("3.7.2");
      expect(execFileSync(path.join(data, "bin", "vibeforge"), [], { encoding: "utf8" })).toContain("launcher 3.7.2");
      // Its Restart runs its own Electron again, which now starts the current version's launcher;
      // run as Node (for what it spawns) it is still its own Electron.
      const restart = execFileSync(path.join(dest, "node_modules", "electron", "dist", "electron"), [dest, "--class=vibeforge", "--enable-wayland-ime", "--hidden"], { encoding: "utf8" });
      expect(restart.trim()).toBe("launcher 4.4.0 --hidden");
      const asNode = spawnSync(path.join(dest, "node_modules", "electron", "dist", "electron"), ["-e", "1"], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      expect(asNode.stderr).toContain("electron 40.1.0 as node");
      for (const helper of ["--type=relauncher", "--type=utility"]) {
        const child = execFileSync(path.join(dest, "node_modules", "electron", "dist", "electron"), [helper, "---", dest], { encoding: "utf8" });
        expect(child.trim()).toBe(`electron 40.1.0 ${helper} --- ${dest}`);
      }
      // Going back to 3.7.2 puts its own Electron back in place for it.
      expect(fs.existsSync(path.join(prev(old), "node_modules", "electron", "dist", "electron.real"))).toBe(true);
      expect(install(["--rollback"], { home: old }).status).toBe(0);
      expect(fs.existsSync(path.join(cur(old), "node_modules", "electron", "dist", "electron.real"))).toBe(false);
      expect(execFileSync(path.join(cur(old), "node_modules", "electron", "dist", "electron"), [], { encoding: "utf8" })).toContain("electron 40.1.0");
      expect(install(["--rollback"], { home: old }).status).toBe(0);
    } finally {
      await stop();
    }
    // Once it has quit, the next update clears the old files; 3.7.2 is no longer previous, so it goes too.
    publishSplit("4.4.1");
    const result = installReleased(old, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(fs.readdirSync(dest).sort()).toEqual([".vibeforge-installer", "current", "previous", "runtime", "versions"]);
    expect(versions(old)).toEqual(["4.4.0", "4.4.1"]);
  });

  it("keeps a version something still runs from through later updates, and removes it after", async () => {
    const busy = path.join(dir, "home-busy");
    fs.mkdirSync(busy);
    publishSplit("4.5.0");
    expect(installReleased(busy, { path: noBuildPath() }).status).toBe(0);
    const stop = await runningFrom(path.join(app(busy), "versions", "4.5.0", "dist-electron", "main.js"));
    try {
      for (const version of ["4.5.1", "4.5.2"]) {
        publishSplit(version);
        const result = installReleased(busy, { path: noBuildPath() });
        expect(result.status, result.out).toBe(0);
      }
      expect(versions(busy)).toEqual(["4.5.0", "4.5.1", "4.5.2"]);
    } finally {
      await stop();
    }
    publishSplit("4.5.3");
    expect(installReleased(busy, { path: noBuildPath() }).status).toBe(0);
    expect(versions(busy)).toEqual(["4.5.2", "4.5.3"]);
  });

  it("leaves the installed version when a run is killed outright part-way, and the next run clears what it left", async () => {
    const cut = path.join(dir, "home-cut");
    fs.mkdirSync(cut);
    publishSplit("4.6.0");
    expect(installReleased(cut, { path: noBuildPath() }).status).toBe(0);
    publishSplit("4.6.1");
    // A tar that unpacks, then hangs: the run is killed with the new copy half in place.
    const hang = path.join(dir, "tar-hangs");
    fs.mkdirSync(hang, { recursive: true });
    const marker = path.join(dir, "tar-hung");
    fs.writeFileSync(path.join(hang, "tar"), `#!/bin/sh\n${execFileSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).trim()} "$@" || exit $?\ntouch "${marker}"\nexec sleep 60\n`, { mode: 0o755 });
    const child = spawn("bash", [path.join(repo, "scripts", "install.sh")], {
      detached: true,
      stdio: "ignore",
      env: { HOME: cut, PATH: `${hang}:${noBuildPath()}`, VIBEFORGE_REPO: fake, VIBEFORGE_RELEASES: releases },
    });
    for (let tries = 0; tries < 300 && !fs.existsSync(marker); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(marker)).toBe(true);
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once("exit", resolve)));
    expect(fs.readlinkSync(cur(cut))).toBe("versions/4.6.0");
    expect(built(cur(cut))).toBe("4.6.0");
    expect(stages(cut).length).toBeGreaterThan(0);
    const result = installReleased(cut, { path: noBuildPath() });
    expect(result.status, result.out).toBe(0);
    expect(fs.readlinkSync(cur(cut))).toBe("versions/4.6.1");
    expect(stages(cut)).toEqual([]);
  });

  it("names the libraries Electron is missing on this system, and what to install", () => {
    const bare = path.join(dir, "home-libs");
    fs.mkdirSync(bare);
    const ldd = path.join(dir, "ldd-missing");
    fs.mkdirSync(ldd, { recursive: true });
    fs.writeFileSync(path.join(ldd, "ldd"), '#!/bin/sh\necho "\tlibgtk-3.so.0 => not found"\necho "\tlibnss3.so => not found"\necho "\tlibc.so.6 => /usr/lib/libc.so.6"\n', { mode: 0o755 });
    publishSplit("4.7.0");
    const result = installReleased(bare, { path: `${ldd}:${noBuildPath()}` });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("VibeForge will not start until they are installed: libgtk-3.so.0 libnss3.so");
    expect(result.out).not.toContain("libc.so.6");
    // Nothing missing, nothing said.
    publishSplit("4.7.1");
    expect(installReleased(bare, { path: noBuildPath() }).out).not.toContain("missing");
  });

  it("says what it takes, and stops on an option it doesn't know", () => {
    let result = install(["--help"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("--rollback");
    expect(result.out).toContain("bash -s -- --uninstall");
    result = install(["--frobnicate"]);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Unknown option --frobnicate");
  });

  it("restarts cleanly via real Electron app.relaunch after migrating an open pre-versions install", async () => {
    const realElectron = path.join(repo, "node_modules", "electron", "dist", "electron");
    const realDist = path.dirname(realElectron);
    const realHome = path.join(dir, "home-real-relaunch");
    const dest = app(realHome);
    const cache = path.join(realHome, ".cache");
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-rt-"));
    const dataDir = path.join(realHome, ".local", "share", "vibeforge");
    const binDir = path.join(realHome, "bin");
    const saidFile = path.join(realHome, "notified.txt");
    const readyFile = path.join(realHome, "legacy-ready.txt");
    const triggerFile = path.join(realHome, "relaunch-now.txt");
    const startedFile = path.join(realHome, "started-new.json");
    const profileDir = path.join(realHome, "profile");
    for (const folder of [cache, runtimeDir, dataDir, binDir, profileDir]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(binDir, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(saidFile)}\n`, { mode: 0o755 });

    // Legacy 3.7.2 layout running the real Electron binary (replaced in place by install.sh while open).
    writeFiles(dest, {
      "package.json": [JSON.stringify({ name: "vibeforge", version: "3.7.2", main: "dist-electron/main.js" }), 0o644],
      "dist/index.html": ["<html></html>", 0o644],
      "scripts/vibeforge": ["#!/bin/sh\nexit 0\n", 0o755],
      "resources/icon.png": ["", 0o644],
      "resources/icon.svg": ["<svg xmlns='http://www.w3.org/2000/svg'/>", 0o644],
      ".vibeforge-installer": ["", 0o644],
      "node_modules/node-pty/build/Release/pty.node": ["", 0o644],
      "node_modules/node-pty/package.json": [JSON.stringify({ name: "node-pty", main: "index.js" }), 0o644],
      "node_modules/node-pty/index.js": ["module.exports = {};\n", 0o644],
      "dist-electron/main.js": [
        `const { app } = require("electron");
const fs = require("fs");
app.whenReady().then(() => {
  fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(triggerFile)})) return;
    clearInterval(timer);
    app.relaunch({ execPath: process.execPath, args: process.argv.slice(1).filter((arg) => arg !== "--hidden") });
    app.quit();
  }, 50);
});
`,
        0o644,
      ],
    });
    writeFiles(path.join(dest, "vendor", "syncthing"), runtimeFiles("syncthing", "2.1.7"));
    const legacyDist = path.join(dest, "node_modules", "electron", "dist");
    fs.mkdirSync(legacyDist, { recursive: true });
    for (const entry of fs.readdirSync(realDist)) {
      if (entry === "electron") fs.copyFileSync(realElectron, path.join(legacyDist, entry));
      else fs.symlinkSync(path.join(realDist, entry), path.join(legacyDist, entry));
    }
    fs.chmodSync(path.join(legacyDist, "electron"), 0o755);

    const env = {
      ...process.env,
      HOME: realHome,
      XDG_CACHE_HOME: cache,
      XDG_RUNTIME_DIR: runtimeDir,
      VIBEFORGE_DATA: dataDir,
      VIBEFORGE_LAUNCH_WAIT: "15",
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    };
    const legacyArgs = [
      dest,
      "--class=vibeforge",
      "--enable-wayland-ime",
      "--ozone-platform=headless",
      "--hidden",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      `--user-data-dir=${profileDir}`,
    ];
    let legacyOutput = "";
    const legacy = spawn(path.join(legacyDist, "electron"), legacyArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    legacy.stdout.on("data", (chunk: Buffer) => (legacyOutput += chunk.toString()));
    legacy.stderr.on("data", (chunk: Buffer) => (legacyOutput += chunk.toString()));

    let newPid = 0;
    try {
      for (let tries = 0; tries < 200 && !fs.existsSync(readyFile); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(readyFile), `legacy electron failed to start:\n${legacyOutput}`).toBe(true);

      publishSplit("4.8.0");
      const update = installReleased(realHome, { path: noBuildPath(), env: { VIBEFORGE_HOME: dest } });
      expect(update.status, update.out).toBe(0);

      // Give the newly installed version the real launcher, real Electron dist, and a test main.js.
      const nextDir = path.join(app(realHome), "versions", "4.8.0");
      fs.writeFileSync(path.join(nextDir, "package.json"), JSON.stringify({ name: "vibeforge", version: "4.8.0", main: "dist-electron/main.js" }, null, 2));
      fs.copyFileSync(path.join(repo, "scripts", "vibeforge"), path.join(nextDir, "scripts", "vibeforge"));
      fs.chmodSync(path.join(nextDir, "scripts", "vibeforge"), 0o755);
      fs.rmSync(path.join(nextDir, "node_modules", "electron", "dist"), { recursive: true, force: true });
      fs.symlinkSync(realDist, path.join(nextDir, "node_modules", "electron", "dist"));
      fs.writeFileSync(
        path.join(nextDir, "dist-electron", "main.js"),
        `const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const tag = crypto.createHash("sha1").update(process.env.VIBEFORGE_DATA).digest("hex").slice(0, 8);
const sock = path.join(process.env.XDG_RUNTIME_DIR, "vibeforge-" + tag + ".sock");
const srv = net.createServer((socket) => socket.end());
app.whenReady().then(() => {
  srv.listen(sock, () => {
    fs.writeFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ argv: process.argv, pid: process.pid }));
  });
});
setInterval(() => {}, 1000);
`,
      );

      fs.writeFileSync(triggerFile, "go");
      for (let tries = 0; tries < 200 && !fs.existsSync(startedFile); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(startedFile), `relaunch did not start 4.8.0:\n${legacyOutput}`).toBe(true);

      const started = JSON.parse(fs.readFileSync(startedFile, "utf8")) as { argv: string[]; pid: number };
      newPid = started.pid;
      expect(started.argv.some((arg) => arg.includes(path.join("versions", "4.8.0")))).toBe(true);
      expect(started.argv).not.toContain("--hidden");

      // Let scripts/vibeforge's watcher finish its wait window and verify no error notification fired.
      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(legacyOutput).not.toContain("relauncher.cc");
      expect(fs.existsSync(saidFile), fs.existsSync(saidFile) ? fs.readFileSync(saidFile, "utf8") : "").toBe(false);
      const launchLog = fs.readFileSync(path.join(cache, "vibeforge", "launch.log"), "utf8");
      expect(launchLog).not.toContain("relauncher.cc");
      expect(launchLog).not.toContain("It stopped as it started");
    } finally {
      if (newPid > 0) {
        try {
          process.kill(newPid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      if (legacy.exitCode === null && legacy.signalCode === null) legacy.kill("SIGKILL");
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  }, 25_000);
});
