const fs = require("fs");
const path = require("path");
const { readRun, writeMeta } = require("../core/runfiles.js");
const { snapshotGit } = require("../core/git.js");

async function finalizeRun({ runDir, exitCode, signal }) {
  const meta = readRun(runDir);
  if (!meta) return null;
  const stopFile = fs.existsSync(path.join(runDir, "stop-requested"));
  if (!meta.endedAt) {
    meta.endedAt = new Date().toISOString();
    meta.exitCode = exitCode ?? null;
    meta.signal = signal ?? null;
    if (meta.status !== "failed") {
      meta.status = meta.stopRequested || stopFile ? "stopped" : "exited";
    }
    writeMeta(runDir, meta);
  }
  const gitPath = path.join(runDir, "git.txt");
  if (!fs.existsSync(gitPath)) {
    let gitText = "not a git repo\n";
    try {
      gitText = await snapshotGit(meta.cwd, 5000);
    } catch {
      gitText = "not a git repo\n";
    }
    if (!gitText.endsWith("\n")) gitText += "\n";
    fs.writeFileSync(gitPath, gitText);
  }
  return readRun(runDir);
}

function markFailed(runDir, error) {
  const meta = readRun(runDir);
  if (!meta) return null;
  meta.status = "failed";
  meta.endedAt = new Date().toISOString();
  meta.error = String(error && error.message ? error.message : error);
  writeMeta(runDir, meta);
  return meta;
}

module.exports = { finalizeRun, markFailed };
