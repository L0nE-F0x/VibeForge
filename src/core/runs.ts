import fs from "node:fs";
import path from "node:path";
import { isSafeId } from "./slug.js";
import type { RunMeta } from "./types.js";

export function runFolderStamp(date: Date): string {
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const clock = iso.slice(11, 19).replaceAll(":", "");
  return `${day}T${clock}Z`;
}

function safeSlug(slug: string): string {
  const cleaned = slug.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "run";
}

export function createRunFiles(input: {
  dataRoot: string;
  slug: string;
  preamble: string;
  meta: Omit<RunMeta, "id" | "dir"> & { id?: string };
}): { id: string; dir: string; meta: RunMeta } {
  const runsRoot = path.join(input.dataRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const started = Date.parse(input.meta.startedAt);
  const stamp = runFolderStamp(Number.isNaN(started) ? new Date() : new Date(started));
  const slug = safeSlug(input.slug);
  let id = input.meta.id && isSafeId(input.meta.id) ? input.meta.id : `${stamp}_${slug}`;
  let dir = path.join(runsRoot, id);
  let suffix = 2;
  while (fs.existsSync(dir)) {
    id = `${stamp}_${slug}-${suffix}`;
    dir = path.join(runsRoot, id);
    suffix += 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  const meta: RunMeta = {
    ...input.meta,
    id,
    dir,
    agentId: input.meta.agentId ?? null,
    routineId: input.meta.routineId ?? null,
    taskId: input.meta.taskId ?? null,
    chatId: input.meta.chatId ?? null,
    endedAt: input.meta.endedAt ?? null,
    openedAt: input.meta.openedAt ?? null,
    notifiedAt: input.meta.notifiedAt ?? null,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "preamble.md"), input.preamble);
  fs.writeFileSync(path.join(dir, "scrollback.txt"), "");
  return { id, dir, meta };
}

export function markStopRequested(runDir: string, at: Date = new Date()): RunMeta | null {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "stop-requested"), `${at.toISOString()}\n`);
  const metaPath = path.join(runDir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as RunMeta;
  if (meta.status === "running") {
    meta.status = "stopped";
    meta.endedAt = at.toISOString();
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
  return meta;
}

export function readRun(runDir: string): {
  meta: RunMeta;
  preamble: string;
  scrollback: string;
  git: string;
} {
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8")) as RunMeta;
  const preamblePath = path.join(runDir, "preamble.md");
  const scrollPath = path.join(runDir, "scrollback.txt");
  const gitPath = path.join(runDir, "git.txt");
  return {
    meta,
    preamble: fs.existsSync(preamblePath) ? fs.readFileSync(preamblePath, "utf8") : "",
    scrollback: fs.existsSync(scrollPath) ? fs.readFileSync(scrollPath, "utf8") : "",
    git: fs.existsSync(gitPath) ? fs.readFileSync(gitPath, "utf8") : "",
  };
}

export function listRunDirs(dataRoot: string): string[] {
  const root = path.join(dataRoot, "runs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort()
    .reverse();
}
