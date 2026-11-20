#!/usr/bin/env node
// @ts-check
// Puts the Syncthing that VibeForge's workspace sync runs into vendor/syncthing/: the one release
// pinned in scripts/syncthing.json, exactly as the Syncthing project published it, checked against
// the SHA-256 pinned beside its name. VibeForge never uses a Syncthing found elsewhere on the
// machine, so every copy runs the same version.
//
//   node scripts/fetch-syncthing.mjs                  fetch it for this CPU, unless it is there already
//   node scripts/fetch-syncthing.mjs --to <dir>       into another folder (scripts/pack-release.mjs)
//   node scripts/fetch-syncthing.mjs --bump v2.1.8    move the pin to another Syncthing release
//
// The ready-made build a release carries has it inside (pack-release.mjs runs this). A git checkout
// or a copy built from source gets it here: from the installer, or from Settings → Sync the first
// time sync is turned on.
//
// Bumping: `--bump <tag>` reads that release's signed list of checksums from GitHub, checks the
// signature against Syncthing's release key when gpg is installed, and rewrites syncthing.json.
// Then run this script with no arguments, run the tests, and commit syncthing.json.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const PIN_FILE = path.join(root, "scripts", "syncthing.json");
const RELEASES = "https://github.com/syncthing/syncthing/releases/download";
/** The Syncthing project's release signing key (https://syncthing.net/release-key.txt). */
export const RELEASE_KEY = "FBA2E162F2F44657B38F0309E5665F9BD5970C47";
const ARCH_NAMES = /** @type {const} */ ({ x64: "amd64", arm64: "arm64" });

/**
 * @typedef {{ file: string, sha256: string }} Build
 * @typedef {{ version: string, license: string, source: string, builds: Record<string, Build> }} Pin
 */

/** @returns {Pin} */
export function pinned() {
  return JSON.parse(fs.readFileSync(PIN_FILE, "utf8"));
}

/** The folder a copy of VibeForge keeps its Syncthing in. */
export const VENDOR_DIR = path.join(root, "vendor", "syncthing");

/** What a fetched copy is marked with, so a moved pin fetches again. @param {Pin} pin @param {string} arch */
export function mark(pin, arch) {
  return `${pin.version} ${pin.builds[arch]?.sha256 ?? ""}\n`;
}

/** True when `dir` holds the pinned release for `arch`. @param {string} dir @param {Pin} pin @param {string} arch */
export function present(dir, pin, arch) {
  try {
    return fs.readFileSync(path.join(dir, "PIN"), "utf8") === mark(pin, arch) && fs.statSync(path.join(dir, "syncthing")).size > 1_000_000;
  } catch {
    return false;
  }
}

/** The note shipped beside the binary: what it is, that it is unmodified, and where its source is. @param {Pin} pin */
export function sourceNote(pin) {
  return [
    `Syncthing ${pin.version}`,
    "",
    "This folder holds Syncthing exactly as the Syncthing project published it; VibeForge does not",
    "change it. VibeForge starts it as a private instance for workspace sync (Settings → Sync).",
    "",
    `Release:  https://github.com/syncthing/syncthing/releases/tag/${pin.version}`,
    `Source:   ${pin.source}`,
    "License:  Mozilla Public License 2.0, in LICENSE.txt beside this file.",
    "Authors:  AUTHORS.txt beside this file.",
    "",
  ].join("\n");
}

/**
 * The checksums of the two Linux builds in a release's sha256sum.txt.asc.
 * @param {string} text @param {string} version @returns {Record<string, Build>}
 */
export function parseSums(text, version) {
  /** @type {Record<string, Build>} */
  const builds = {};
  for (const [arch, name] of Object.entries(ARCH_NAMES)) {
    const file = `syncthing-linux-${name}-${version}.tar.gz`;
    const line = text.split("\n").find((row) => row.trim().endsWith(`  ${file}`));
    const sha256 = line?.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${version}'s checksum list has no line for ${file}.`);
    builds[arch] = { file, sha256 };
  }
  return builds;
}

/** @param {string} url @returns {Promise<Buffer>} */
async function download(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "VibeForge" }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetches the pinned release into `dir`. Returns "present" when it was there already.
 * @param {{ dir?: string, arch?: string, say?: (line: string) => void }} [options]
 */
export async function fetchSyncthing(options = {}) {
  const dir = options.dir ?? VENDOR_DIR;
  const arch = options.arch ?? process.arch;
  const say = options.say ?? (() => undefined);
  const pin = pinned();
  const build = pin.builds[arch];
  if (!build) throw new Error(`Syncthing ${pin.version} is not pinned for ${arch}.`);
  if (present(dir, pin, arch)) return "present";

  say(`Downloading Syncthing ${pin.version} for linux-${arch}`);
  const archive = await download(`${RELEASES}/${pin.version}/${build.file}`);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  if (sha256 !== build.sha256) throw new Error(`${build.file} does not match its pinned SHA-256 (got ${sha256}). Nothing was installed.`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-syncthing-"));
  try {
    fs.writeFileSync(path.join(work, build.file), archive);
    fs.mkdirSync(path.join(work, "out"));
    execFileSync("tar", ["-xzf", path.join(work, build.file), "-C", path.join(work, "out"), "--strip-components=1", "--no-same-owner"], { stdio: "pipe" });
    const staged = `${dir}.next`;
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    for (const name of ["syncthing", "LICENSE.txt", "AUTHORS.txt"]) fs.copyFileSync(path.join(work, "out", name), path.join(staged, name));
    fs.chmodSync(path.join(staged, "syncthing"), 0o755);
    fs.writeFileSync(path.join(staged, "SOURCE.txt"), sourceNote(pin));
    fs.writeFileSync(path.join(staged, "PIN"), mark(pin, arch));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staged, dir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  say(`Syncthing ${pin.version} is in ${dir}`);
  return "fetched";
}

/**
 * Verifies a clearsigned checksum list against `expectedKey` with gpg and returns only the signed body.
 * @param {Buffer} sums @param {Buffer} keyText @param {string} [expectedKey] @returns {string}
 */
export function verifiedSums(sums, keyText, expectedKey = RELEASE_KEY) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-gpg-"));
  try {
    fs.chmodSync(home, 0o700);
    const keyFile = path.join(home, "key.txt");
    const sumsFile = path.join(home, "sums.asc");
    const verifiedFile = path.join(home, "verified.txt");
    fs.writeFileSync(keyFile, keyText);
    fs.writeFileSync(sumsFile, sums);
    execFileSync("gpg", ["--homedir", home, "--batch", "--quiet", "--import", keyFile], { stdio: "pipe" });
    const status = execFileSync("gpg", ["--homedir", home, "--batch", "--status-fd", "1", "--output", verifiedFile, "--decrypt", sumsFile], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    if (!status.includes(`VALIDSIG ${expectedKey}`) && !new RegExp(`VALIDSIG \\S+ .* ${expectedKey}\\b`).test(status)) {
      throw new Error("The checksum list is not signed by Syncthing's release key.");
    }
    return fs.readFileSync(verifiedFile, "utf8");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Moves the pin to another release, from its signed checksum list. @param {string} version */
async function bump(version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("Name a Syncthing release tag, such as v2.1.8.");
  const sums = await download(`${RELEASES}/${version}/sha256sum.txt.asc`);
  const verifiedBody = verifiedSums(sums, await download("https://syncthing.net/release-key.txt"));
  /** @type {Pin} */
  const pin = { version, license: "MPL-2.0", source: `https://github.com/syncthing/syncthing/tree/${version}`, builds: parseSums(verifiedBody, version) };
  fs.writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`✓ scripts/syncthing.json now pins Syncthing ${version} (signature checked).`);
  console.log("  Next: node scripts/fetch-syncthing.mjs && npm test, then commit scripts/syncthing.json.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (/** @type {string} */ flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    if (args.includes("--bump")) await bump(value("--bump") ?? "");
    else {
      const quiet = args.includes("--quiet");
      const dir = value("--to");
      const done = await fetchSyncthing({ dir: dir ? path.resolve(dir) : undefined, arch: value("--arch"), say: quiet ? undefined : (line) => console.log(`▸ ${line}`) });
      if (done === "present" && !quiet) console.log(`✓ Syncthing ${pinned().version} is there already.`);
    }
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
