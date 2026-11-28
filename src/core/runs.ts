import fs from "node:fs";
import path from "node:path";
import { readJson, readText, writeJson } from "./fsx.js";
import { hasRunFile, readRunText } from "./run-storage.js";
import { isSafeId } from "./slug.js";
import type { CutOff, RoutineRunResult, RunMeta, RunOrigin, RunStatus } from "./types.js";
import { isCommitId } from "./worktrees.js";

/** What a run directory holds. The PTY host writes the terminal files, the service writes the rest. */
export const RUN_FILES = {
  meta: "meta.json",
  preamble: "preamble.md",
  /** Raw PTY capture. Gzipped once the run has ended (run-storage.ts). */
  scrollback: "scrollback.txt",
  screen: "terminal.ansi",
  transcript: "transcript.txt",
  git: "git.txt",
  /** Full patch frozen when the run ended. Absent on runs saved before this existed. Gzipped later (run-storage.ts). */
  patch: "diff.patch",
  /** Before-and-after git snapshot refs and oversized skipped files for restoring what a run did. */
  snapshots: "snapshots.json",
} as const;

export const RUN_ORIGINS: RunOrigin[] = ["agent-chat", "routine", "task", "code", "chat"];
export const RUN_STATUSES: RunStatus[] = ["running", "exited", "stopped", "failed"];
export const RUN_RESULTS: RoutineRunResult[] = ["finished", "question", "timeout", "stuck", "cutoff", "failed"];

export function runFolderStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

function safeSlug(slug: string): string {
  const cleaned = slug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "run";
}

/** Where a run's folder is: always `<dataRoot>/runs/<id>`. Null for an id that could point elsewhere. */
export function runDir(dataRoot: string, id: string): string | null {
  return isSafeId(id) ? path.join(dataRoot, "runs", id) : null;
}

export function allocateRunDir(dataRoot: string, startedAt: Date, slug: string): { id: string; dir: string } {
  const root = path.join(dataRoot, "runs");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const base = `${runFolderStamp(startedAt)}_${safeSlug(slug)}`;
  let id = base;
  let suffix = 2;
  while (fs.existsSync(path.join(root, id))) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
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

const CUT_OFFS: CutOff[] = ["quit", "update", "crash"];

/** A list of strings, as meta.json keeps it or the index keeps it (JSON text). */
function stringArray(value: unknown): string[] | null {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : null;
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
    gitStart: (() => {
      const sha = strOrNull(record.gitStart);
      return sha && isCommitId(sha) ? sha : null;
    })(),
    continuedFrom: strOrNull(record.continuedFrom),
    ...(RUN_RESULTS.includes(record.result as RoutineRunResult) ? { result: record.result as RoutineRunResult } : {}),
    ...(strOrNull(record.localHarness) ? { localHarness: strOrNull(record.localHarness) } : {}),
    ...(strOrNull(record.localModel) ? { localModel: strOrNull(record.localModel) } : {}),
    ...(strOrNull(record.paneId) ? { paneId: strOrNull(record.paneId) } : {}),
    ...(() => {
      const args = stringArray(record.resumeArgs);
      return args?.length ? { resumeArgs: args } : {};
    })(),
    ...(CUT_OFFS.includes(record.cutOff as CutOff) ? { cutOff: record.cutOff as CutOff } : {}),
  };
}

export function writeRunMeta(meta: RunMeta): void {
  if (!meta.dir) return;
  writeJson(path.join(meta.dir, RUN_FILES.meta), meta);
}

/** A run's meta.json. Its folder is the one it was read from, whatever path the file has in it. */
export function readRunMeta(dir: string): RunMeta | null {
  const meta = normalizeRun(readJson<unknown>(path.join(dir, RUN_FILES.meta), null));
  if (meta) meta.dir = dir;
  return meta;
}

export interface RunFiles {
  preamble: string;
  /** What the person typed, when VibeForge itself didn't hand the run a prompt. */
  prompts: string;
  /** Serialized final terminal state, the best thing to replay. */
  screen: string;
  /** Raw PTY capture, used when the screen was never written (a crash). */
  scrollback: string;
  transcript: string;
  git: string;
  /** True when diff.patch was written. The body stays on disk until Changes asks for it. */
  patchSaved: boolean;
}

export function readRunFiles(dir: string): RunFiles {
  const screen = readText(path.join(dir, RUN_FILES.screen));
  return {
    preamble: readText(path.join(dir, RUN_FILES.preamble)),
    prompts: "",
    screen,
    scrollback: screen ? "" : readRunText(dir, RUN_FILES.scrollback),
    transcript: readText(path.join(dir, RUN_FILES.transcript)),
    git: readText(path.join(dir, RUN_FILES.git)),
    patchSaved: hasRunFile(dir, RUN_FILES.patch),
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
