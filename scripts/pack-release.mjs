#!/usr/bin/env node
// @ts-check
// Packs the ready-made VibeForge a release carries, with what the built app reads at runtime and
// nothing else, so installing and updating compile nothing. Four archives for this CPU:
//
//   vibeforge-app-<version>-linux-<arch>.tar.zst   the app without Electron and Syncthing, about 2 MB
//   electron-<electron>-linux-<arch>.tar.zst       Electron's own folder (node_modules/electron/dist)
//   syncthing-<syncthing>-linux-<arch>.tar.zst     the pinned Syncthing (vendor/syncthing)
//   vibeforge-<version>-linux-<arch>.tar.zst       all of it in one, for anyone who downloads by hand
//
// The app's manifest.json names the Electron and Syncthing it needs and the SHA-256 of their files
// (tree_hash in scripts/install.sh, which this runs), so an update downloads only the app when
// those are already on the computer, and uses a copy only when it is the same file for file. An
// Electron or Syncthing archive holds exactly the upstream files and is packed the same way every
// time (same names, order, owner and dates), so two releases on the same Electron publish the
// same bytes. scripts/build-release.sh runs this and then installs and smoke-tests the result (CI
// on every pull request, release.yml for each tag); scripts/install.sh downloads the archives,
// checks them against the release's SHA256SUMS and switches to the new version.
//
//   node scripts/pack-release.mjs [out-dir]        (out-dir defaults to release/)
//
// It packs the commit at HEAD, never uncommitted changes: git archive exports it into a scratch
// folder, npm ci installs it there (building node-pty for this CPU) and Vite builds it. So it needs
// what building from source needs (git, base-devel, python, Node 22.12+), and zstd.
// VIBEFORGE_PACK_REF=v2.14.1 packs another commit or tag.
//
// Entries are sorted, owned by root and dated to the commit (Electron's and Syncthing's to a fixed
// date), so packing a commit twice gives the same tree. Each archive holds one folder named like it.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

/**
 * What the running app reads from its folder: whole folders, so a file added to one ships without
 * a change here. Vite bundles everything else (React, YAML, the cron parser…) into dist and
 * dist-electron. From electron/ only the .cjs files run from disk: the terminal host, on the
 * person's own Node, and the screen capture the main process loads too; its .ts files are built
 * into dist-electron. scripts/ holds the launcher and `vibeforge tell` (talk.mjs). vendor/syncthing
 * is the Syncthing workspace sync runs: not in the repository, fetched here at its pinned version
 * (scripts/fetch-syncthing.mjs), unmodified, with its license and a note of where its source is.
 */
export const APP_FILES = ["package.json", "LICENSE", "dist", "dist-electron", "companion", "resources", "scripts", "electron/*.cjs", "vendor/syncthing"];

/**
 * Left out of those folders: the Android widget's build and publish scripts, which only the one building the
 * widget runs (from a checkout, with the Android SDK), and any Android package. The widget is
 * installed on its own, never from inside the app.
 */
export const LEFT_OUT = ["scripts/build-android-widget.sh", "scripts/publish-android-widget.sh"];

/** @param {string} file */
function leftOut(file) {
  return LEFT_OUT.includes(file) || file.endsWith(".apk");
}

/** True when the archive holds `file` (a path in the checkout), itself or inside a folder it ships. */
export function ships(file) {
  if (leftOut(file)) return false;
  return APP_FILES.some((item) => {
    if (item.includes("*")) {
      const [dir, ext] = item.split("/*");
      return path.posix.dirname(file) === dir && file.endsWith(ext);
    }
    return file === item || file.startsWith(`${item}/`);
  });
}

/**
 * The packages loaded from node_modules at runtime, and the part of each that is used: Electron's
 * binary, node-pty's addon built for this CPU (Node-API, so any Node runs it) and the headless
 * xterm the terminal host mirrors screens with.
 */
export const PACKAGES = {
  electron: ["package.json", "LICENSE", "dist"],
  "node-pty": ["package.json", "LICENSE", "lib", "build/Release/pty.node"],
  "@xterm/headless": ["package.json", "lib-headless"],
  "@xterm/addon-serialize": ["package.json", "lib"],
};

/** Files run from disk, besides dist-electron; every module they load has to be in the archive. */
export const ENTRIES = [
  ...fs
    .readdirSync(path.join(root, "electron"))
    .filter((file) => file.endsWith(".cjs"))
    .map((file) => `electron/${file}`),
  "scripts/talk.mjs",
];

/**
 * Extract a static string literal or untagged zero-expression template literal.
 * @param {Record<string, any>} node
 * @returns {string | null}
 */
function staticString(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1 &&
    typeof node.quasis[0]?.value?.cooked === "string"
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/**
 * Walk an ESTree node subtree and collect module specifiers loaded at runtime.
 * @param {unknown} value
 * @param {Set<string>} found
 */
function collectSpecifiers(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSpecifiers(item, found);
    return;
  }
  /** @type {Record<string, any>} */
  const node = value;
  if (typeof node.type === "string") {
    if (
      (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      typeof node.source?.value === "string"
    ) {
      found.add(node.source.value);
    } else if (node.type === "ImportExpression" && node.source) {
      const spec = staticString(node.source);
      if (spec) found.add(spec);
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 1
    ) {
      const spec = staticString(node.arguments[0]);
      if (spec) found.add(spec);
    }
  }
  for (const child of Object.values(node)) {
    if (child && typeof child === "object") collectSpecifiers(child, found);
  }
}

/** @type {((source: string) => unknown) | null} */
let rootParseAst = null;

/**
 * Load Vite's `parseAst` from `dir/package.json` so importing `pack-release.mjs` on a bare
 * checkout (before `npm ci` runs in `build`) needs no external `node_modules`.
 * @param {string} [dir]
 * @returns {(source: string) => unknown}
 */
function loadParseAst(dir = root) {
  if (dir === root) {
    if (!rootParseAst) {
      const vite = /** @type {{ parseAst: (source: string) => unknown }} */ (createRequire(path.join(root, "package.json"))("vite"));
      rootParseAst = vite.parseAst;
    }
    return rootParseAst;
  }
  const vite = /** @type {{ parseAst: (source: string) => unknown }} */ (createRequire(path.join(dir, "package.json"))("vite"));
  return vite.parseAst;
}

/**
 * Bare and relative module names a script loads, as written, via AST parsing.
 * @param {string} text
 * @param {(source: string) => unknown} [parse]
 */
export function specifiers(text, parse = loadParseAst()) {
  const found = new Set();
  // Strip a leading shebang so parseAst can parse executable scripts directly.
  const source = text.startsWith("#!") ? text.replace(/^#![^\r\n]*/, "") : text;
  collectSpecifiers(parse(source), found);
  return [...found];
}

/** True for a module Node or Electron provides. */
export function provided(spec) {
  return spec.startsWith("node:") || builtinModules.includes(spec) || spec === "electron";
}

const step = (text) => console.log(`▸ ${text}`);
/** @returns {never} */
function fail(text) {
  console.error(`✗ ${text}`);
  process.exit(1);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, quiet?: boolean }} [opts]
 */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, encoding: "utf8", stdio: opts.quiet ? "pipe" : ["ignore", "inherit", "inherit"], maxBuffer: 64 << 20 }) ?? "";
}

/** @param {string} out */
async function main(out) {
  const t0 = Date.now();
  if (process.platform !== "linux") fail("VibeForge's ready-made build is for Linux; pack it there.");
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] ?? fail(`No ready-made build for ${process.arch}.`);

  const ref = process.env.VIBEFORGE_PACK_REF || "HEAD";
  const commit = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { quiet: true }).trim();
  const epoch = run("git", ["log", "-1", "--format=%ct", commit], { quiet: true }).trim();
  if (ref === "HEAD" && run("git", ["status", "--porcelain", "--untracked-files=no"], { quiet: true }).trim()) {
    console.log("  Uncommitted changes are not packed: this packs the last commit.");
  }

  // Its real path: a script run from under a linked TMPDIR doesn't know it is the one started
  // (import.meta.url is the real path, process.argv[1] the linked one) and would do nothing.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-pack-")));
  process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(signal, () => process.exit(130));

  // ------------------------------------------------------------------ build the commit

  const build = path.join(work, "build");
  fs.mkdirSync(build);
  step(`Exporting ${commit.slice(0, 12)}`);
  run("git", ["archive", "--format=tar", "-o", path.join(work, "source.tar"), commit]);
  run("tar", ["-xf", path.join(work, "source.tar"), "-C", build]);

  const { version } = JSON.parse(fs.readFileSync(path.join(build, "package.json"), "utf8"));
  const name = `vibeforge-${version}-linux-${arch}`;

  // Electron's binary is wanted here, even where the environment skips it for tests.
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  step("Installing dependencies (npm ci)");
  run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: build, env });
  step("Building (vite build)");
  run("npm", ["run", "build", "--silent"], { cwd: build, env });
  // The pinned Syncthing for this CPU, checked against the SHA-256 in scripts/syncthing.json.
  step("Fetching the pinned Syncthing");
  run(process.execPath, [path.join(build, "scripts", "fetch-syncthing.mjs"), "--to", path.join(build, "vendor", "syncthing"), "--quiet"], { cwd: build, env });

  // ------------------------------------------------------------------ copy what runs

  const stage = path.join(work, name);
  /** @param {string} from @param {string} to */
  function ship(from, to) {
    if (!fs.existsSync(from)) fail(`${path.relative(build, from)} is missing from the build.`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
  step(`Assembling ${name}`);
  for (const item of APP_FILES) {
    if (!item.includes("*")) {
      ship(path.join(build, item), path.join(stage, item));
      continue;
    }
    const [dir, ext] = item.split("/*");
    for (const file of fs.readdirSync(path.join(build, dir)).filter((name) => name.endsWith(ext))) {
      ship(path.join(build, dir, file), path.join(stage, dir, file));
    }
  }
  for (const [pkg, parts] of Object.entries(PACKAGES)) {
    for (const part of parts) ship(path.join(build, "node_modules", pkg, part), path.join(stage, "node_modules", pkg, part));
  }
  // Source maps and node-pty's own tests are not run. Electron's folder is left exactly as it comes.
  for (const file of fs.readdirSync(path.join(stage, "node_modules"), { recursive: true, encoding: "utf8" })) {
    if (file.startsWith(`electron${path.sep}`)) continue;
    if (file.endsWith(".map") || file.endsWith(".test.js")) fs.rmSync(path.join(stage, "node_modules", file));
  }
  for (const file of fs.readdirSync(stage, { recursive: true, encoding: "utf8" })) {
    if (leftOut(file.split(path.sep).join("/"))) fs.rmSync(path.join(stage, file));
  }
  // The app's Update runs the installer for a copy with this mark (src/core/updates.ts).
  fs.writeFileSync(path.join(stage, ".vibeforge-installer"), "");

  // ------------------------------------------------------------------ check it runs

  step("Checking that everything it loads is in it");
  const parse = loadParseAst(build);
  const entries = [...ENTRIES, ...fs.readdirSync(path.join(stage, "dist-electron")).filter((file) => file.endsWith(".js")).map((file) => `dist-electron/${file}`)];
  const missing = [];
  for (const entry of entries) {
    for (const spec of specifiers(fs.readFileSync(path.join(stage, entry), "utf8"), parse)) {
      if (provided(spec)) continue;
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(path.join(stage, entry)), spec);
        if (!["", ".js", ".cjs", ".mjs", ".json"].some((ext) => fs.existsSync(target + ext))) missing.push(`${entry} → ${spec}`);
        continue;
      }
      const pkg = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
      if (!fs.existsSync(path.join(stage, "node_modules", pkg, "package.json"))) missing.push(`${entry} → ${spec}`);
    }
  }
  if (missing.length) fail(`Not in the archive, but loaded at runtime:\n  ${missing.join("\n  ")}`);

  // node-pty's addon, loaded from the archive's own folder, opens a real terminal.
  const staged = createRequire(path.join(stage, "package.json"));
  const pty = staged("node-pty");
  staged("@xterm/headless");
  staged("@xterm/addon-serialize");
  const said = await new Promise((resolve) => {
    let text = "";
    const term = pty.spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 80, rows: 24, cwd: stage, env: { PATH: "/usr/bin:/bin" } });
    term.onData((data) => (text += data));
    term.onExit(() => resolve(text));
  });
  if (!String(said).includes("pty-ok")) fail(`node-pty started, but its terminal said: ${JSON.stringify(said)}`);

  // The terminal host starts from the archive on the archive's own Electron, run as Node (as an
  // installed copy runs it, with no Node on the computer), and says it's ready.
  await new Promise((resolve) => {
    const host = spawn(path.join(stage, "node_modules", "electron", "dist", "electron"), [path.join(stage, "electron", "pty-host.cjs")], {
      cwd: stage,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let text = "";
    const timer = setTimeout(() => fail(`The terminal host did not start within 10 seconds: ${text}`), 10_000);
    host.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes('"event":"ready"')) host.stdin.end();
    });
    host.stderr.on("data", (chunk) => (text += chunk));
    host.on("exit", (code) => {
      clearTimeout(timer);
      if (!text.includes('"event":"ready"')) fail(`The terminal host exited (code ${code}) before it was ready: ${text}`);
      resolve(undefined);
    });
  });

  const addon = fs.readFileSync(path.join(stage, "node_modules", "node-pty", "build", "Release", "pty.node"), "latin1");
  const glibc = [...new Set([...addon.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((match) => match[1]))].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  console.log(`  node-pty's addon needs glibc ${glibc ?? "?"} or newer`);

  // ------------------------------------------------------------------ the manifest

  const electronVersion = JSON.parse(fs.readFileSync(path.join(stage, "node_modules", "electron", "package.json"), "utf8")).version;
  const syncthingVersion = String(JSON.parse(fs.readFileSync(path.join(build, "scripts", "syncthing.json"), "utf8")).version).replace(/^v/, "");
  const parts = runtimeParts(stage, { arch, electron: electronVersion, syncthing: syncthingVersion });
  const manifest = manifestFor({ version, arch, parts, treeHash: (dir) => treeHash(dir, path.join(build, "scripts", "install.sh")) });
  fs.writeFileSync(path.join(stage, "manifest.json"), manifest);

  // ------------------------------------------------------------------ pack

  fs.mkdirSync(out, { recursive: true });
  const made = [];
  /** @param {string} file @param {string} from @param {string} folder @param {string} rename @param {{ epoch?: string, exclude?: string[] }} [opts] */
  const pack = (file, from, folder, rename, opts = {}) => {
    const archive = path.join(out, file);
    step(`Packing ${archive}`);
    fs.rmSync(archive, { force: true });
    // zstd: every Arch install has it (pacman, curl and systemd need it) and it unpacks the ~290 MB in
    // well under a second; xz, also in base, is 6% smaller but slower to unpack. --long=27 stays
    // within the window zstd unpacks without being told.
    run("tar", [
      "--sort=name",
      "--format=posix",
      "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
      `--mtime=@${opts.epoch ?? epoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mode=u+rwX,go+rX,go-w",
      ...(opts.exclude ?? []).map((item) => `--exclude=${folder}/${item}`),
      `--transform=s,^${folder.replace(/[.]/g, "\\.")},${rename},`,
      "--use-compress-program=zstd -19 --long=27 -T0 -q",
      "-cf",
      archive,
      "-C",
      from,
      folder,
    ]);
    made.push(archive);
  };
  const runtimes = parts.map((part) => part.relative);
  pack(`vibeforge-app-${version}-linux-${arch}.tar.zst`, work, name, `vibeforge-app-${version}-linux-${arch}`, { exclude: runtimes });
  for (const part of parts) pack(`${part.name}.tar.zst`, path.dirname(path.join(stage, part.relative)), path.basename(part.relative), part.name, { epoch: RUNTIME_EPOCH });
  pack(`${name}.tar.zst`, work, name, name);

  console.log("");
  for (const archive of made) {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    console.log(`✓ ${path.basename(archive)}: ${(fs.statSync(archive).size / 1e6).toFixed(1)} MB  ${hash}`);
  }
  console.log(`  packed in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** The date Electron's and Syncthing's archives carry, whatever the commit: the same files pack to the same bytes. */
export const RUNTIME_EPOCH = "946684800";

/**
 * The parts packed on their own, besides the app: where each is in the app's folder and the name
 * of its archive (and of its folder in the install's runtime/).
 * @param {string} stage @param {{ arch: string, electron: string, syncthing: string }} versions
 */
export function runtimeParts(stage, versions) {
  return [
    { kind: "electron", relative: "node_modules/electron/dist", name: `electron-${versions.electron}-linux-${versions.arch}`, dir: path.join(stage, "node_modules", "electron", "dist") },
    { kind: "syncthing", relative: "vendor/syncthing", name: `syncthing-${versions.syncthing}-linux-${versions.arch}`, dir: path.join(stage, "vendor", "syncthing") },
  ];
}

/**
 * The manifest.json the app archive carries, one key per line, which scripts/install.sh reads with sed.
 * @param {{ version: string, arch: string, parts: Array<{ kind: string, name: string, dir: string }>, treeHash: (dir: string) => string }} opts
 */
export function manifestFor({ version, arch, parts, treeHash: hash }) {
  /** @type {Record<string, string>} */
  const fields = { version, arch };
  for (const part of parts) {
    fields[part.kind] = part.name;
    fields[`${part.kind}Tree`] = hash(part.dir);
  }
  return `${JSON.stringify(fields, null, 2)}\n`;
}

/**
 * The SHA-256 of a folder's files, by scripts/install.sh's own tree_hash, so the two can never differ.
 * @param {string} dir @param {string} [installer]
 */
export function treeHash(dir, installer = path.join(root, "scripts", "install.sh")) {
  const text = fs.readFileSync(installer, "utf8");
  const fn = /^tree_hash\(\) \{\n[\s\S]*?\n\}\n/m.exec(text)?.[0];
  if (!fn) fail(`${installer} has no tree_hash function.`);
  const hash = execFileSync("bash", ["-c", `set -euo pipefail\n${fn}\ntree_hash "$1"`, "tree-hash", dir], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) fail(`tree_hash of ${dir} gave ${JSON.stringify(hash)}.`);
  return hash;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(path.resolve(process.argv[2] || path.join(root, "release")));
}
