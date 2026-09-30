#!/usr/bin/env node
// The notes for one version: its section of CHANGELOG.md, word for word, which is what the GitHub
// Release shows and the in-app Update reads.
//
//   node scripts/release-notes.mjs 1.3.0 > notes.md      (a tag such as v1.3.0 works too)

import fs from "node:fs";
import path from "node:path";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const changelog = fs.readFileSync(path.resolve(import.meta.dirname, "..", "CHANGELOG.md"), "utf8").split("\n");
const start = changelog.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}. Move the Unreleased notes under "## [${version}] - <date>" first.`);
  process.exit(1);
}
const end = changelog.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = changelog
  .slice(start + 1, end < 0 ? undefined : end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`The ${version} section of CHANGELOG.md is empty.`);
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
