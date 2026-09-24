const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function runFolderStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
}

function safeSlug(slug) {
  const s = String(slug || "run")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "run";
}

function createRunFiles({ dataRoot, slug, preamble, meta, now }) {
  const date = now instanceof Date ? now : new Date();
  let id = `${runFolderStamp(date)}_${safeSlug(slug)}`;
  let dir = path.join(dataRoot, "runs", id);
  if (fs.existsSync(dir)) {
    id = `${id}-${crypto.randomBytes(2).toString("hex")}`;
    dir = path.join(dataRoot, "runs", id);
  }
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    id,
    origin: meta.origin,
    agentId: meta.agentId ?? null,
    routineId: meta.routineId ?? null,
    taskId: meta.taskId ?? null,
    chatId: meta.chatId ?? null,
    engine: meta.engine ?? null,
    cwd: meta.cwd,
    prompt: meta.prompt ?? "",
    startedAt: meta.startedAt || date.toISOString(),
    endedAt: null,
    status: "running",
    openedAt: null,
    notifiedAt: null,
    ptyId: meta.ptyId ?? null,
    stopRequested: false,
    exitCode: null,
    dir,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(dir, "preamble.md"), preamble ?? "");
  fs.writeFileSync(path.join(dir, "scrollback.txt"), "");
  return { id, dir, meta: full };
}

function readRun(dir) {
  const file = path.join(dir, "meta.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

function markStopRequested(dir) {
  const meta = readRun(dir);
  if (!meta) return null;
  meta.stopRequested = true;
  writeMeta(dir, meta);
  return meta;
}

function listRunDirs(dataRoot) {
  const root = path.join(dataRoot, "runs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, "meta.json")));
}

module.exports = {
  runFolderStamp,
  createRunFiles,
  readRun,
  writeMeta,
  markStopRequested,
  listRunDirs,
};
