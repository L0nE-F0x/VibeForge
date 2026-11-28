import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDirectory } from "../fsx.js";
import { runFilePaths } from "../run-storage.js";
import { listRunDirs, normalizeRun, readRunMeta, RUN_FILES, runDir, writeRunMeta } from "../runs.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../../shared/text.js";
import type { RunMeta, RunOrigin, RunStatus } from "../types.js";

const SCHEMA_VERSION = 5;

const RUN_COLUMNS = [
  "id",
  "origin",
  "title",
  "agentId",
  "routineId",
  "taskId",
  "chatId",
  "workspaceId",
  "engine",
  "argv",
  "cwd",
  "prompt",
  "startedAt",
  "endedAt",
  "status",
  "exitCode",
  "signal",
  "stopRequested",
  "openedAt",
  "notifiedAt",
  "dir",
  "error",
  "changes",
  "gitStart",
  "continuedFrom",
  "localHarness",
  "localModel",
  "paneId",
  "resumeArgs",
  "cutOff",
] as const;

export interface RunQuery {
  origin?: RunOrigin | RunOrigin[];
  agentId?: string;
  routineId?: string;
  taskId?: string;
  chatId?: string;
  workspaceId?: string;
  status?: RunStatus | RunStatus[];
  unopened?: boolean;
  since?: string;
  search?: string;
  limit?: number;
}

/** How much of a transcript is indexed: its start (the ask) and its end (how it went). */
const INDEXED_CHARS = 100_000;

function searchableText(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ");
  return clean.length <= INDEXED_CHARS * 2 ? clean : `${clean.slice(0, INDEXED_CHARS)}\n…\n${clean.slice(-INDEXED_CHARS)}`;
}

/** A LIMIT from a caller: a whole number from 0 up, kept between 1 and `max`; anything else (NaN, -3, 2.5) is `fallback`. */
function rowLimit(value: number | undefined, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.max(1, Math.min(value, max)) : fallback;
}

/** Typed text inside a LIKE pattern as itself: its `%`, `_` and the escape character `\` escaped. */
function likeText(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/** Typed words as an FTS5 query: every word must appear, each matching the start of a word. */
export function matchExpression(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(" ");
}

function toRow(meta: RunMeta): Array<string | number | null> {
  return RUN_COLUMNS.map((column) => {
    const value = meta[column];
    if (column === "argv") return JSON.stringify(value);
    if (column === "resumeArgs") return Array.isArray(value) && value.length ? JSON.stringify(value) : null;
    if (column === "stopRequested") return value ? 1 : 0;
    if (value === undefined) return null;
    return value as string | number | null;
  });
}

/** SQLite's "database disk image is malformed" (11) and "file is not a database" (26). */
function isBrokenIndex(error: unknown): boolean {
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && [11, 26].includes(errcode & 0xff);
}

/** Moves a damaged index (and its journal) to `index.sqlite.broken`, as writeJson does with a JSON file. */
function setIndexAside(file: string): void {
  const aside = fs.existsSync(`${file}.broken`) ? `${file}.broken-${Date.now()}` : `${file}.broken`;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    if (fs.existsSync(`${file}${suffix}`)) {
      fs.renameSync(`${file}${suffix}`, `${aside}${suffix}`);
      fs.chmodSync(`${aside}${suffix}`, 0o600);
    }
  }
}

function tightenSqliteModes(index: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const target = `${index}${suffix}`;
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  }
}

/**
 * Every run's meta.json, mirrored in SQLite (`<data>/index.sqlite`) so runs can be listed, filtered
 * and searched without opening each folder. The folders stay the truth: the index is built again
 * from them when it is missing or damaged.
 */
export class RunIndex {
  private readonly dataRoot: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    const index = path.join(dataRoot, "index.sqlite");
    let db: DatabaseSync | null = null;
    try {
      db = this.db = new DatabaseSync(index);
      this.configureDb();
      this.migrate();
    } catch (error) {
      if (!isBrokenIndex(error)) throw error;
      // The index only mirrors the run folders' meta.json, so a damaged one is set aside and built again from them.
      db?.close();
      setIndexAside(index);
      this.db = new DatabaseSync(index);
      this.configureDb();
      this.migrate();
    }
    tightenSqliteModes(index);
  }

  private configureDb(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  private withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore checkpoint error on close */
    }
    this.db.close();
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS runs");
      this.db.exec(`CREATE TABLE runs (
        id TEXT PRIMARY KEY, origin TEXT, title TEXT, agentId TEXT, routineId TEXT, taskId TEXT, chatId TEXT,
        workspaceId TEXT, engine TEXT, argv TEXT, cwd TEXT, prompt TEXT, startedAt TEXT, endedAt TEXT, status TEXT,
        exitCode INTEGER, signal INTEGER, stopRequested INTEGER, openedAt TEXT, notifiedAt TEXT, dir TEXT,
        error TEXT, changes TEXT, gitStart TEXT, continuedFrom TEXT, localHarness TEXT, localModel TEXT,
        paneId TEXT, resumeArgs TEXT, cutOff TEXT
      )`);
      this.db.exec("CREATE INDEX runs_started ON runs(startedAt DESC)");
      this.db.exec("CREATE INDEX runs_status ON runs(status)");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_workspace_started ON runs(workspaceId, startedAt DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_agent_started ON runs(agentId, startedAt DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_routine ON runs(routineId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_chat ON runs(chatId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_status_opened ON runs(status, openedAt)");
    // What a run said, for search. Filled as runs end, and for older runs by `indexMissingText`.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS run_text USING fts5(
      id UNINDEXED, title, prompt, transcript, tokenize = 'unicode61 remove_diacritics 2'
    )`);
    this.reindex();
  }

  /** Pick up run folders the index does not know about, and drop rows whose folders disappeared on disk. */
  reindex(): number {
    const known = new Set((this.db.prepare("SELECT id FROM runs").all() as Array<{ id: string }>).map((row) => row.id));
    const dirs = listRunDirs(this.dataRoot);
    const onDisk = new Set(dirs.map((dir) => path.basename(dir)));
    const stale: string[] = [];
    for (const id of known) {
      if (!onDisk.has(id)) stale.push(id);
    }
    const fresh: RunMeta[] = [];
    for (const dir of dirs) {
      if (known.has(path.basename(dir))) continue;
      const meta = readRunMeta(dir);
      // A run's folder is named for its id; one that isn't (copied by hand) would be found in the wrong place.
      if (!meta || meta.id !== path.basename(dir)) continue;
      meta.dir = dir;
      fresh.push(meta);
    }
    if (!stale.length && !fresh.length) return 0;
    return this.withTransaction(() => {
      if (stale.length) {
        const delRun = this.db.prepare("DELETE FROM runs WHERE id = ?");
        const delText = this.db.prepare("DELETE FROM run_text WHERE id = ?");
        for (const id of stale) {
          delRun.run(id);
          delText.run(id);
        }
      }
      for (const meta of fresh) this.indexRun(meta);
      return fresh.length;
    });
  }

  private indexRun(meta: RunMeta): void {
    this.db
      .prepare(
        `INSERT INTO runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
         ON CONFLICT(id) DO UPDATE SET ${RUN_COLUMNS.filter((column) => column !== "id")
           .map((column) => `${column} = excluded.${column}`)
           .join(", ")}`,
      )
      .run(...toRow(meta));
  }

  /** The only way run state changes: meta.json and the index move together. */
  saveRun(meta: RunMeta): RunMeta {
    const normalized = this.located(meta);
    if (!normalized) throw new Error("Run is not valid");
    if (!isDirectory(normalized.dir)) return normalized;
    writeRunMeta(normalized);
    this.indexRun(normalized);
    return normalized;
  }

  getRun(id: string): RunMeta | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? this.located(row) : null;
  }

  /**
   * A run as the index or its meta.json has it, its folder worked out from the data folder and its
   * id. The stored path is never used: a data folder restored under another $HOME still finds its
   * runs, and nothing outside the data folder is ever read or deleted as one.
   */
  private located(value: unknown): RunMeta | null {
    const run = normalizeRun(value);
    if (run) run.dir = runDir(this.dataRoot, run.id) ?? "";
    return run;
  }

  queryRuns(query: RunQuery = {}): RunMeta[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const oneOrMany = (column: string, value: string | string[] | undefined) => {
      if (value === undefined) return;
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) return;
      where.push(`${column} IN (${list.map(() => "?").join(", ")})`);
      params.push(...list);
    };
    oneOrMany("origin", query.origin);
    oneOrMany("status", query.status);
    for (const column of ["agentId", "routineId", "taskId", "chatId", "workspaceId"] as const) {
      const value = query[column];
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (query.unopened) where.push("openedAt IS NULL");
    if (query.since) {
      where.push("startedAt >= ?");
      params.push(query.since);
    }
    if (query.search?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')");
      const like = `%${likeText(query.search.trim())}%`;
      params.push(like, like, like);
    }
    const limit = rowLimit(query.limit, 200, 2000);
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY startedAt DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as unknown[])
      .map((row) => this.located(row))
      .filter((run): run is RunMeta => run !== null);
  }

  /** Make a finished run findable by its words. `transcript` is the text the terminal showed. */
  indexRunText(meta: RunMeta, transcript: string): void {
    const text = searchableText(transcript);
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM run_text WHERE id = ?").run(meta.id);
      this.db.prepare("INSERT INTO run_text (id, title, prompt, transcript) VALUES (?, ?, ?, ?)").run(meta.id, meta.title, meta.prompt, text);
    });
  }

  /** Finished runs not in the search index yet, newest first: older runs, and runs from before search. */
  runsMissingText(limit: number): RunMeta[] {
    return (
      this.db
        .prepare(`SELECT * FROM runs WHERE status != 'running' AND id NOT IN (SELECT id FROM run_text) ORDER BY startedAt DESC LIMIT ${Math.max(1, Math.floor(limit))}`)
        .all() as unknown[]
    )
      .map((row) => this.located(row))
      .filter((run): run is RunMeta => run !== null);
  }

  /**
   * Runs whose title, prompt, transcript or folder hold every word typed (each as a word start),
   * best match first, with a snippet of the text around the match. Matches are wrapped in
   * SNIPPET_OPEN and SNIPPET_CLOSE.
   */
  searchRuns(text: string, limit = 50): Array<{ run: RunMeta; snippet: string }> {
    const match = matchExpression(text);
    if (!match) return [];
    const cap = rowLimit(limit, 50, 500);
    const rows = this.db
      .prepare(
        `SELECT runs.*, snippet(run_text, -1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 14) AS snippet
         FROM run_text JOIN runs ON runs.id = run_text.id
         WHERE run_text MATCH ? ORDER BY rank LIMIT ${cap}`,
      )
      .all(match) as Array<Record<string, unknown>>;
    const found = rows.flatMap((row) => {
      const run = this.located(row);
      return run ? [{ run, snippet: typeof row.snippet === "string" ? row.snippet : "" }] : [];
    });
    if (found.length >= cap) return found;
    // A folder is a path, not words: those still match as typed.
    const seen = new Set(found.map((item) => item.run.id));
    const byFolder = this.queryRuns({ search: text, limit: cap - found.length }).filter((run) => !seen.has(run.id));
    return [...found, ...byFolder.map((run) => ({ run, snippet: "" }))];
  }

  /** Every run in the index, newest first, with no limit: for tidying up, not for showing. */
  allRuns(): RunMeta[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY startedAt DESC").all() as unknown[])
      .map((row) => this.located(row))
      .filter((run): run is RunMeta => run !== null);
  }

  /** Latest run timestamp (endedAt, else startedAt) recorded in each workspace, for sorting workspaces by activity. */
  latestWorkspaceRuns(): Record<string, string> {
    const rows = this.db
      .prepare("SELECT workspaceId, MAX(COALESCE(endedAt, startedAt)) AS lastAt FROM runs WHERE workspaceId IS NOT NULL GROUP BY workspaceId")
      .all() as Array<{ workspaceId: string | null; lastAt: string | null }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (row.workspaceId && row.lastAt) out[row.workspaceId] = row.lastAt;
    }
    return out;
  }

  /** Forget a run entirely: its index row and its folder, which is only ever `<data>/runs/<id>`. */
  deleteRun(run: RunMeta): void {
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
      this.db.prepare("DELETE FROM run_text WHERE id = ?").run(run.id);
    });
    const dir = runDir(this.dataRoot, run.id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  deleteRunFile(run: RunMeta, file: keyof typeof RUN_FILES): void {
    const dir = runDir(this.dataRoot, run.id);
    if (!dir) return;
    for (const target of runFilePaths(dir, RUN_FILES[file])) fs.rmSync(target, { force: true });
  }
}
