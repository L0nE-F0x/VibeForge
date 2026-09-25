import fs from "node:fs";
import path from "node:path";
import { readJson, readText, writeJson } from "./fsx.js";
import { isSafeId } from "./slug.js";
import type { RunMeta, RunOrigin, RunStatus } from "./types.js";

/** What a run directory holds. The PTY host writes the terminal files, the service writes the rest. */
export const RUN_FILES = {
  meta: "meta.json",
  preamble: "preamble.md",
  scrollback: "scrollback.txt",
  screen: "terminal.ansi",
  transcript: "transcript.txt",
  git: "git.txt",
} as const;

export const RUN_ORIGINS: RunOrigin[] = ["agent-chat", "routine", "task", "code", "chat"];
export const RUN_STATUSES: RunStatus[] = ["running", "exited", "stopped", "failed"];

export function runFolderStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

function safeSlug(slug: string): string {
  const cleaned = slug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "run";
}

export function allocateRunDir(dataRoot: string, startedAt: Date, slug: string): { id: string; dir: string } {
  const root = path.join(dataRoot, "runs");
  fs.mkdirSync(root, { recursive: true });
  const base = `${runFolderStamp(startedAt)}_${safeSlug(slug)}`;
  let id = base;
  let suffix = 2;
  while (fs.existsSync(path.join(root, id))) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeRun(value: unknown): RunMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  if (!id || !isSafeId(id)) return null;
  const origin = RUN_ORIGINS.includes(record.origin as RunOrigin) ? (record.origin as RunOrigin) : "chat";
  const status = RUN_STATUSES.includes(record.status as RunStatus) ? (record.status as RunStatus) : "stopped";
  let argv: string[] = [];
  if (Array.isArray(record.argv)) argv = record.argv.filter((item): item is string => typeof item === "string");
  else if (typeof record.argv === "string") {
    try {
      const parsed = JSON.parse(record.argv) as unknown;
      if (Array.isArray(parsed)) argv = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      argv = [];
    }
  }
  return {
    id,
    origin,
    title: str(record.title) || id,
    agentId: strOrNull(record.agentId),
    routineId: strOrNull(record.routineId),
    taskId: strOrNull(record.taskId),
    chatId: strOrNull(record.chatId),
    workspaceId: strOrNull(record.workspaceId),
    engine: str(record.engine),
    argv,
    cwd: str(record.cwd),
    prompt: str(record.prompt),
    startedAt: str(record.startedAt),
    endedAt: strOrNull(record.endedAt),
    status,
    exitCode: numOrNull(record.exitCode),
    signal: numOrNull(record.signal),
    stopRequested: record.stopRequested === true || record.stopRequested === 1,
    openedAt: strOrNull(record.openedAt),
    notifiedAt: strOrNull(record.notifiedAt),
    dir: str(record.dir),
    error: strOrNull(record.error),
    changes: strOrNull(record.changes),
    gitStart: strOrNull(record.gitStart),
    continuedFrom: strOrNull(record.continuedFrom),
  };
}

export function writeRunMeta(meta: RunMeta): void {
  if (!meta.dir) return;
  writeJson(path.join(meta.dir, RUN_FILES.meta), meta);
}

export function readRunMeta(dir: string): RunMeta | null {
  const meta = normalizeRun(readJson<unknown>(path.join(dir, RUN_FILES.meta), null));
  if (meta && !meta.dir) meta.dir = dir;
  return meta;
}

export interface RunFiles {
  preamble: string;
  /** Serialized final terminal state, the best thing to replay. */
  screen: string;
  /** Raw PTY capture, used when the screen was never written (a crash). */
  scrollback: string;
  transcript: string;
  git: string;
}

export function readRunFiles(dir: string): RunFiles {
  const screen = readText(path.join(dir, RUN_FILES.screen));
  return {
    preamble: readText(path.join(dir, RUN_FILES.preamble)),
    screen,
    scrollback: screen ? "" : readText(path.join(dir, RUN_FILES.scrollback)),
    transcript: readText(path.join(dir, RUN_FILES.transcript)),
    git: readText(path.join(dir, RUN_FILES.git)),
  };
}

export function listRunDirs(dataRoot: string): string[] {
  const root = path.join(dataRoot, "runs");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
