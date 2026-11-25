#!/usr/bin/env node
// @ts-check
// Packs the ready-made VibeForge a release carries: vibeforge-<version>-linux-<arch>.tar.zst, with
// what the built app reads at runtime and nothing else, so installing and updating compile nothing.
// scripts/build-release.sh runs it and then installs and smoke-tests the result (CI on every pull
// request, release.yml for each tag); scripts/install.sh downloads the archive, checks it against
// the release's SHA256SUMS and swaps it in.
//
//   node scripts/pack-release.mjs [out-dir]        (out-dir defaults to release/)
//
// It packs the commit at HEAD, never uncommitted changes: git archive exports it into a scratch
// folder, npm ci installs it there (building node-pty for this CPU) and Vite builds it. So it needs
// what building from source needs (git, base-devel, python, Node 22.12+), and zstd.
// VIBEFORGE_PACK_REF=v2.14.1 packs another commit or tag.
//
// Entries are sorted, owned by root and dated to the commit, so packing a commit twice gives the
// same tree. The archive holds one folder, vibeforge-<version>-linux-<arch>/.

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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-pack-"));
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

  // The terminal host starts from the archive on this Node and says it's ready.
  await new Promise((resolve) => {
    const host = spawn(process.execPath, [path.join(stage, "electron", "pty-host.cjs")], { cwd: stage, stdio: ["pipe", "pipe", "pipe"] });
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

  // ------------------------------------------------------------------ pack

  fs.mkdirSync(out, { recursive: true });
  const archive = path.join(out, `${name}.tar.zst`);
  step(`Packing ${archive}`);
  fs.rmSync(archive, { force: true });
  // zstd: every Arch install has it (pacman, curl and systemd need it) and it unpacks the ~290 MB in
  // well under a second; xz, also in base, is 6% smaller but slower to unpack. --long=27 stays
  // within the window zstd unpacks without being told.
  run("tar", [
    "--sort=name",
    "--format=posix",
    "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
    `--mtime=@${epoch}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "--use-compress-program=zstd -19 --long=27 -T0 -q",
    "-cf",
    archive,
    "-C",
    work,
    name,
  ]);

  const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const megabytes = (fs.statSync(archive).size / 1e6).toFixed(1);
  console.log(`\n✓ ${path.basename(archive)}: ${megabytes} MB, packed in ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`  ${hash}  ${path.basename(archive)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(path.resolve(process.argv[2] || path.join(root, "release")));
}
