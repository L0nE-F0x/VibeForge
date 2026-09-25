#!/usr/bin/env node
"use strict";
// Electron's own postinstall unzips its binary with extract-zip, which on Node 26 stops
// part-way and exits with code 0, leaving node_modules/electron without an executable.
// This runs after it: if the binary is missing, extract the (cached) zip with bsdtar,
// unzip or Python instead.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "node_modules", "electron");
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || process.platform !== "linux" || !fs.existsSync(root)) process.exit(0);

const { version } = require(path.join(root, "package.json"));
const dist = path.join(root, "dist");
const binary = path.join(dist, "electron");

function installed() {
  try {
    const found = fs.readFileSync(path.join(dist, "version"), "utf8").trim().replace(/^v/, "");
    return found === version && fs.statSync(binary).size > 1_000_000;
  } catch {
    return false;
  }
}

const PYTHON_UNZIP = `
import os, sys, zipfile
archive, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as zf:
    for info in zf.infolist():
        extracted = zf.extract(info, target)
        mode = (info.external_attr >> 16) & 0o777
        if mode:
            os.chmod(extracted, mode)
`;

function extract(zip) {
  const attempts = [
    ["bsdtar", ["-xf", zip, "-C", dist]],
    ["unzip", ["-q", "-o", zip, "-d", dist]],
    ["python3", ["-c", PYTHON_UNZIP, zip, dist]],
  ];
  for (const [tool, args] of attempts) {
    try {
      execFileSync(tool, args, { stdio: ["ignore", "ignore", "pipe"] });
      return tool;
    } catch {
      /* try the next extractor */
    }
  }
  throw new Error("no working extractor (install bsdtar, unzip or python3)");
}

async function main() {
  if (installed()) {
    fs.writeFileSync(path.join(root, "path.txt"), "electron");
    return;
  }
  const { downloadArtifact } = require(require.resolve("@electron/get", { paths: [root] }));
  const zip = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    cacheRoot: process.env.electron_config_cache,
    checksums: require(path.join(root, "checksums.json")),
  });
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const tool = extract(zip);
  fs.writeFileSync(path.join(root, "path.txt"), "electron");
  if (!installed()) throw new Error(`the binary is still missing after extracting with ${tool}`);
  console.log(`electron ${version}: binary extracted with ${tool}`);
}

main().catch((error) => {
  console.error(`electron: could not install the binary: ${error.message}`);
  process.exit(1);
});
