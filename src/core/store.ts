import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
import { normalizeEngineRows, seedEngines } from "./engines.js";
import { readJson, writeFileAtomic, writeJson } from "./fsx.js";
import { ensureLayout } from "./layout.js";
import { listRunDirs, normalizeRun, readRunMeta, RUN_FILES, writeRunMeta } from "./runs.js";
import { isSafeId, slugify } from "./slug.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../shared/text.js";
import { TASK_STATUSES } from "./tasks.js";
import type { WorkspaceFile } from "./workspaces.js";
import type { WorkingCopy } from "./worktrees.js";
import type {
  Agent,
  ChatRecord,
  EngineRow,
  LayoutNode,
  Routine,
  RunMeta,
  RunOrigin,
  RunStatus,
  Schedule,
  Settings,
  SoundSettings,
  VoiceSettings,
  Skill,
  Task,
  TaskStatus,
  Workspace,
} from "./types.js";

export const MEMORY_STARTER =
  "<!-- Preferences, decisions, constraints, and lessons that should still matter next week. Dated bullets. No secrets. VibeForge adds this file to every run of this agent. -->\n";

const SCHEMA_VERSION = 3;

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

/** Typed words as an FTS5 query: every word must appear, each matching the start of a word. */
export function matchExpression(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(" ");
}

export function defaultSettings(): Settings {
  return {
    defaultEngine: "claude",
    defaultShell: process.env.SHELL || "/bin/bash",
    notify: true,
    terminalFontSize: 13,
    terminalFontFamily: "JetBrainsMono Nerd Font",
    theme: "omarchy",
    tourDone: false,
    checkUpdates: true,
    language: "system",
    voice: { model: "", language: "auto", talkBack: true, speaker: "", agent: "" },
    sounds: { on: true, volume: 0.6, voice: true, attention: true, finished: true, routines: false, inFront: false },
    tray: true,
    closeToTray: true,
    usage: true,
    planLimits: false,
    quotaAlerts: false,
    activity: "git",
    rail: { order: [], hidden: [] },
    keepRuns: { days: 0, maxMb: 0 },
  };
}

/** A whole number from 0 to `max`; anything else is `fallback`. */
function count(value: unknown, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Older settings said "summary", "full", or "off". Reading aloud is now on or off; on is the first paragraph. */
function talkBackFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "off") return false;
  if (value === "summary" || value === "full") return true;
  return fallback;
}

function normalizeSoundSettings(value: unknown, defaults: SoundSettings): SoundSettings {
  const raw = value && typeof value === "object" ? (value as Partial<SoundSettings>) : {};
  const volume = typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : defaults.volume;
  return {
    on: bool(raw.on, defaults.on),
    volume,
    voice: bool(raw.voice, defaults.voice),
    attention: bool(raw.attention, defaults.attention),
    finished: bool(raw.finished, defaults.finished),
    routines: bool(raw.routines, defaults.routines),
    inFront: bool(raw.inFront, defaults.inFront),
  };
}

function normalizeVoiceSettings(value: unknown, defaults: VoiceSettings): VoiceSettings {
  const raw = value && typeof value === "object" ? (value as Partial<VoiceSettings> & { talkBack?: unknown }) : {};
  return {
    model: str(raw.model).trim(),
    language: /^(auto|[a-z]{2,3})$/.test(str(raw.language)) ? str(raw.language) : defaults.language,
    talkBack: talkBackFlag(raw.talkBack, defaults.talkBack),
    speaker: str(raw.speaker).trim(),
    agent: str(raw.agent).trim(),
  };
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function schedule(value: unknown): Schedule {
  if (value && typeof value === "object") {
    const record = value as { kind?: unknown; expr?: unknown; minutes?: unknown };
    if (record.kind === "cron") return { kind: "cron", expr: str(record.expr).trim() };
    if (record.kind === "every") return { kind: "every", minutes: Number(record.minutes) };
  }
  return { kind: "every", minutes: 0 };
}

function yamlText(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function readYaml(file: string): unknown {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeAgent(id: string, value: unknown): Agent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    id,
    name: str(record.name) || id,
    engine: str(record.engine),
    brief: str(record.brief),
    memoryFile: "memory.md",
    places: strList(record.places),
    skills: strList(record.skills),
    allowRoutines: bool(record.allowRoutines, true),
    voice: str(record.voice).trim(),
    createdAt: str(record.createdAt),
    updatedAt: str(record.updatedAt),
  };
}

export function parseSkill(id: string, text: string): Skill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { id, name: id, description: "", body: text.trim() };
  let front: { name?: unknown; description?: unknown } | null;
  try {
    front = parse(match[1]) as { name?: unknown; description?: unknown } | null;
  } catch {
    front = null;
  }
  return {
    id,
    name: str(front?.name, id) || id,
    description: str(front?.description),
    body: match[2].replace(/^\s*\n/, "").trimEnd(),
  };
}

export function skillDocument(skill: Skill): string {
  const front = yamlText({ name: skill.name, description: skill.description }).trimEnd();
  return `---\n${front}\n---\n\n${skill.body.trim()}\n`;
}

function normalizeRoutine(id: string, value: unknown): Routine | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    id,
    name: str(record.name) || id,
    agentId: str(record.agentId),
    enabled: bool(record.enabled, true),
    schedule: schedule(record.schedule),
    prompt: str(record.prompt),
    notify: bool(record.notify, true),
    lastFiredAt: strOrNull(record.lastFiredAt),
    lastMissedAt: strOrNull(record.lastMissedAt),
    shareCheckout: record.shareCheckout === true,
  };
}

function normalizeTask(id: string, value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = str(record.status, "todo") as TaskStatus;
  return {
    id,
    title: str(record.title) || id,
    body: str(record.body),
    status: TASK_STATUSES.includes(status) ? status : "todo",
    agentId: strOrNull(record.agentId),
    workspaceId: strOrNull(record.workspaceId),
    runIds: strList(record.runIds),
    isolated: record.isolated === true,
    copy: workingCopy(record.copy),
    shareCheckout: record.shareCheckout === true,
    sourceRunId: strOrNull(record.sourceRunId),
    createdAt: str(record.createdAt),
    updatedAt: str(record.updatedAt),
  };
}

function workingCopy(value: unknown): WorkingCopy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const [copyPath, branch, base, repo] = [record.path, record.branch, record.base, record.repo].map((item) => str(item));
  if (!path.isAbsolute(copyPath) || !path.isAbsolute(repo) || !/^vibeforge\/[A-Za-z0-9._-]+$/.test(branch) || !/^[0-9a-f]{7,64}$/.test(base)) return null;
  return { path: copyPath, branch, base, repo };
}

function normalizeChat(value: unknown): ChatRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  if (!isSafeId(id)) return null;
  const runIds = strList(record.runIds);
  const legacy = strOrNull(record.runId);
  if (legacy && !runIds.includes(legacy)) runIds.push(legacy);
  return {
    id,
    title: str(record.title) || "Chat",
    agentId: strOrNull(record.agentId),
    engine: str(record.engine),
    cwd: str(record.cwd),
    runIds,
    createdAt: str(record.createdAt),
    updatedAt: str(record.updatedAt),
  };
}

function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  const folder = str(record.path);
  if (!isSafeId(id) || !folder) return null;
  return { id, name: str(record.name) || path.basename(folder) || id, path: folder, dockUrl: str(record.dockUrl) };
}

function isLayoutNode(value: unknown, depth = 0): value is LayoutNode {
  if (!value || typeof value !== "object" || depth > 12) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane") {
    const launch = node.launch as Record<string, unknown> | undefined;
    return typeof node.id === "string" && !!launch && (launch.type === "shell" || (launch.type === "engine" && typeof launch.engineId === "string"));
  }
  if (node.kind === "split") {
    return (
      (node.dir === "row" || node.dir === "col") &&
      typeof node.ratio === "number" &&
      isLayoutNode(node.a, depth + 1) &&
      isLayoutNode(node.b, depth + 1)
    );
  }
  return false;
}

function toRow(meta: RunMeta): Array<string | number | null> {
  return RUN_COLUMNS.map((column) => {
    const value = meta[column];
    if (column === "argv") return JSON.stringify(value);
    if (column === "stopRequested") return value ? 1 : 0;
    if (value === undefined) return null;
    return value as string | number | null;
  });
}

export class Store {
  readonly configRoot: string;
  readonly dataRoot: string;
  private readonly db: DatabaseSync;

  constructor(configRoot: string, dataRoot: string) {
    this.configRoot = configRoot;
    this.dataRoot = dataRoot;
    ensureLayout(configRoot, dataRoot);
    this.db = new DatabaseSync(path.join(dataRoot, "index.sqlite"));
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- run index

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS runs");
      this.db.exec(`CREATE TABLE runs (
        id TEXT PRIMARY KEY, origin TEXT, title TEXT, agentId TEXT, routineId TEXT, taskId TEXT, chatId TEXT,
        workspaceId TEXT, engine TEXT, argv TEXT, cwd TEXT, prompt TEXT, startedAt TEXT, endedAt TEXT, status TEXT,
        exitCode INTEGER, signal INTEGER, stopRequested INTEGER, openedAt TEXT, notifiedAt TEXT, dir TEXT,
        error TEXT, changes TEXT, gitStart TEXT, continuedFrom TEXT
      )`);
      this.db.exec("CREATE INDEX runs_started ON runs(startedAt DESC)");
      this.db.exec("CREATE INDEX runs_status ON runs(status)");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    // What a run said, for search. Filled as runs end, and for older runs by `indexMissingText`.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS run_text USING fts5(
      id UNINDEXED, title, prompt, transcript, tokenize = 'unicode61 remove_diacritics 2'
    )`);
    this.reindex();
  }

  /** Pick up run folders the index does not know about (a crash, or a copied data dir). */
  reindex(): number {
    const known = new Set((this.db.prepare("SELECT id FROM runs").all() as Array<{ id: string }>).map((row) => row.id));
    let added = 0;
    for (const dir of listRunDirs(this.dataRoot)) {
      if (known.has(path.basename(dir))) continue;
      const meta = readRunMeta(dir);
      if (!meta) continue;
      meta.dir = dir;
      this.indexRun(meta);
      added += 1;
    }
    return added;
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
    const normalized = normalizeRun(meta);
    if (!normalized) throw new Error("Run is not valid");
    writeRunMeta(normalized);
    this.indexRun(normalized);
    return normalized;
  }

  getRun(id: string): RunMeta | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? normalizeRun(row) : null;
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
      where.push("(title LIKE ? OR prompt LIKE ? OR cwd LIKE ?)");
      const like = `%${query.search.trim()}%`;
      params.push(like, like, like);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY startedAt DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as unknown[])
      .map((row) => normalizeRun(row))
      .filter((run): run is RunMeta => run !== null);
  }

  /** Make a finished run findable by its words. `transcript` is the text the terminal showed. */
  indexRunText(meta: RunMeta, transcript: string): void {
    this.db.prepare("DELETE FROM run_text WHERE id = ?").run(meta.id);
    this.db.prepare("INSERT INTO run_text (id, title, prompt, transcript) VALUES (?, ?, ?, ?)").run(meta.id, meta.title, meta.prompt, searchableText(transcript));
  }

  /** Finished runs not in the search index yet, newest first: older runs, and runs from before search. */
  runsMissingText(limit: number): RunMeta[] {
    return (
      this.db
        .prepare(`SELECT * FROM runs WHERE status != 'running' AND id NOT IN (SELECT id FROM run_text) ORDER BY startedAt DESC LIMIT ${Math.max(1, Math.floor(limit))}`)
        .all() as unknown[]
    )
      .map((row) => normalizeRun(row))
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
    const cap = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.db
      .prepare(
        `SELECT runs.*, snippet(run_text, -1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 14) AS snippet
         FROM run_text JOIN runs ON runs.id = run_text.id
         WHERE run_text MATCH ? ORDER BY rank LIMIT ${cap}`,
      )
      .all(match) as Array<Record<string, unknown>>;
    const found = rows.flatMap((row) => {
      const run = normalizeRun(row);
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
      .map((row) => normalizeRun(row))
      .filter((run): run is RunMeta => run !== null);
  }

  /** Forget a run entirely: its index row and its folder. */
  deleteRun(run: RunMeta): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
    this.db.prepare("DELETE FROM run_text WHERE id = ?").run(run.id);
    if (run.dir) fs.rmSync(run.dir, { recursive: true, force: true });
  }

  deleteRunFile(run: RunMeta, file: keyof typeof RUN_FILES): void {
    if (!run.dir) return;
    fs.rmSync(path.join(run.dir, RUN_FILES[file]), { force: true });
  }

  // ---------------------------------------------------------------- settings & engines

  readSettings(): Settings {
    const file = path.join(this.configRoot, "settings.json");
    const defaults = defaultSettings();
    const raw = readJson<Partial<Settings> | null>(file, null);
    if (!raw) {
      // Only a missing file is written. One that doesn't parse, say a hand edit half done, is left for its author.
      if (!fs.existsSync(file)) writeJson(file, defaults);
      return defaults;
    }
    return {
      defaultEngine: str(raw.defaultEngine) || defaults.defaultEngine,
      defaultShell: str(raw.defaultShell) || defaults.defaultShell,
      notify: bool(raw.notify, defaults.notify),
      terminalFontSize:
        typeof raw.terminalFontSize === "number" && raw.terminalFontSize >= 8 && raw.terminalFontSize <= 32
          ? raw.terminalFontSize
          : defaults.terminalFontSize,
      terminalFontFamily: str(raw.terminalFontFamily) || defaults.terminalFontFamily,
      theme: raw.theme === "builtin" ? "builtin" : "omarchy",
      tourDone: bool(raw.tourDone, defaults.tourDone),
      checkUpdates: bool(raw.checkUpdates, defaults.checkUpdates),
      language: /^(system|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(str(raw.language)) ? str(raw.language) : defaults.language,
      voice: normalizeVoiceSettings(raw.voice, defaults.voice),
      sounds: normalizeSoundSettings(raw.sounds, defaults.sounds),
      tray: bool(raw.tray, defaults.tray),
      closeToTray: bool(raw.closeToTray, defaults.closeToTray),
      usage: bool(raw.usage, defaults.usage),
      planLimits: bool(raw.planLimits, defaults.planLimits),
      quotaAlerts: bool(raw.quotaAlerts, defaults.quotaAlerts),
      activity: raw.activity === "off" || raw.activity === "github" ? raw.activity : defaults.activity,
      rail: {
        order: names(raw.rail?.order),
        hidden: names(raw.rail?.hidden),
      },
      keepRuns: {
        days: count(raw.keepRuns?.days, 36500, defaults.keepRuns.days),
        maxMb: count(raw.keepRuns?.maxMb, 1_000_000, defaults.keepRuns.maxMb),
      },
    };
  }

  writeSettings(settings: Settings): void {
    writeJson(path.join(this.configRoot, "settings.json"), settings);
  }

  readEngineRows(): EngineRow[] {
    const file = path.join(this.configRoot, "engines.json");
    if (!fs.existsSync(file)) {
      const seeded = seedEngines();
      writeJson(file, { engines: seeded });
      return seeded;
    }
    return normalizeEngineRows(readJson<unknown>(file, { engines: [] }));
  }

  writeEngineRows(rows: EngineRow[]): void {
    writeJson(path.join(this.configRoot, "engines.json"), { engines: normalizeEngineRows(rows) });
  }

  // ---------------------------------------------------------------- workspaces & layouts

  readWorkspaces(): WorkspaceFile {
    const raw = readJson<unknown>(path.join(this.configRoot, "workspaces.json"), null);
    const list = Array.isArray(raw) ? raw : (raw as { workspaces?: unknown } | null)?.workspaces;
    const workspaces = Array.isArray(list)
      ? list.map(normalizeWorkspace).filter((item): item is Workspace => item !== null)
      : [];
    const last = strOrNull((raw as { lastWorkspaceId?: unknown } | null)?.lastWorkspaceId);
    return { workspaces, lastWorkspaceId: last && workspaces.some((item) => item.id === last) ? last : (workspaces[0]?.id ?? null) };
  }

  writeWorkspaces(file: WorkspaceFile): void {
    writeJson(path.join(this.configRoot, "workspaces.json"), file);
  }

  readLayout(workspaceId: string): LayoutNode | null {
    if (!isSafeId(workspaceId)) return null;
    const raw = readJson<unknown>(path.join(this.configRoot, "layouts", `${workspaceId}.json`), null);
    return isLayoutNode(raw) ? raw : null;
  }

  writeLayout(workspaceId: string, layout: LayoutNode | null): void {
    if (!isSafeId(workspaceId)) return;
    const file = path.join(this.configRoot, "layouts", `${workspaceId}.json`);
    if (!layout) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (!isLayoutNode(layout)) throw new Error("Layout is not valid");
    writeJson(file, layout);
  }

  // ---------------------------------------------------------------- agents

  uniqueId(dir: string, base: string, extension: string): string {
    const root = slugify(base);
    const taken = (id: string) => fs.existsSync(path.join(dir, `${id}${extension}`));
    if (!taken(root)) return root;
    let count = 2;
    while (taken(`${root}-${count}`)) count += 1;
    return `${root}-${count}`;
  }

  listAgents(): Agent[] {
    const root = path.join(this.configRoot, "agents");
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.getAgent(entry.name))
      .filter((agent): agent is Agent => agent !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getAgent(id: string): Agent | null {
    if (!isSafeId(id)) return null;
    return normalizeAgent(id, readYaml(path.join(this.configRoot, "agents", id, "agent.yaml")));
  }

  writeAgent(agent: Agent): void {
    const dir = path.join(this.configRoot, "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const memoryPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_STARTER);
    writeFileAtomic(path.join(dir, "agent.yaml"), yamlText({ ...agent, memoryFile: "memory.md" }));
  }

  readMemory(agentId: string): string {
    if (!isSafeId(agentId)) return "";
    try {
      return fs.readFileSync(path.join(this.configRoot, "agents", agentId, "memory.md"), "utf8");
    } catch {
      return "";
    }
  }

  writeMemory(agentId: string, text: string): void {
    if (!isSafeId(agentId)) throw new Error("Agent is missing");
    writeFileAtomic(path.join(this.configRoot, "agents", agentId, "memory.md"), text);
  }

  deleteAgent(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "agents", id), { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- skills

  listSkills(): Skill[] {
    const root = path.join(this.configRoot, "skills");
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.getSkill(entry.name))
      .filter((skill): skill is Skill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(id: string): Skill | null {
    const raw = this.readSkillRaw(id);
    return raw === null ? null : parseSkill(id, raw);
  }

  readSkillRaw(id: string): string | null {
    if (!isSafeId(id)) return null;
    try {
      return fs.readFileSync(path.join(this.configRoot, "skills", id, "SKILL.md"), "utf8");
    } catch {
      return null;
    }
  }

  writeSkill(skill: Skill): void {
    writeFileAtomic(path.join(this.configRoot, "skills", skill.id, "SKILL.md"), skillDocument(skill));
  }

  /** Where a skill, routine or task lives on disk, for moving it aside (see Trash). Null for a bad id. */
  pathOf(kind: "skill" | "routine" | "task", id: string): string | null {
    if (!isSafeId(id)) return null;
    if (kind === "skill") return path.join(this.configRoot, "skills", id);
    return path.join(this.configRoot, kind === "routine" ? "routines" : "tasks", `${id}.yaml`);
  }

  deleteSkill(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "skills", id), { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- routines

  listRoutines(): Routine[] {
    return this.listYaml("routines", (id, value) => normalizeRoutine(id, value)).sort((a, b) => a.name.localeCompare(b.name));
  }

  getRoutine(id: string): Routine | null {
    if (!isSafeId(id)) return null;
    return normalizeRoutine(id, readYaml(path.join(this.configRoot, "routines", `${id}.yaml`)));
  }

  writeRoutine(routine: Routine): void {
    writeFileAtomic(path.join(this.configRoot, "routines", `${routine.id}.yaml`), yamlText(routine));
  }

  deleteRoutine(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "routines", `${id}.yaml`), { force: true });
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): Task[] {
    return this.listYaml("tasks", (id, value) => normalizeTask(id, value)).sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
  }

  getTask(id: string): Task | null {
    if (!isSafeId(id)) return null;
    return normalizeTask(id, readYaml(path.join(this.configRoot, "tasks", `${id}.yaml`)));
  }

  writeTask(task: Task): void {
    writeFileAtomic(path.join(this.configRoot, "tasks", `${task.id}.yaml`), yamlText(task));
  }

  deleteTask(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "tasks", `${id}.yaml`), { force: true });
  }

  private listYaml<T>(folder: string, normalize: (id: string, value: unknown) => T | null): T[] {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(path.join(this.configRoot, folder));
    } catch {
      return [];
    }
    const items: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const id = entry.slice(0, -5);
      if (!isSafeId(id)) continue;
      const item = normalize(id, readYaml(path.join(this.configRoot, folder, entry)));
      if (item) items.push(item);
    }
    return items;
  }

  // ---------------------------------------------------------------- chats

  private chatFile(): string {
    return path.join(this.dataRoot, "chats.json");
  }

  listChats(): ChatRecord[] {
    const raw = readJson<unknown>(this.chatFile(), null);
    const list = Array.isArray(raw) ? raw : (raw as { chats?: unknown } | null)?.chats;
    if (!Array.isArray(list)) return [];
    return list
      .map(normalizeChat)
      .filter((chat): chat is ChatRecord => chat !== null)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  getChat(id: string): ChatRecord | null {
    return this.listChats().find((chat) => chat.id === id) ?? null;
  }

  writeChat(chat: ChatRecord): void {
    const chats = this.listChats().filter((item) => item.id !== chat.id);
    chats.push(chat);
    writeJson(this.chatFile(), { chats });
  }

  deleteChat(id: string): void {
    writeJson(this.chatFile(), { chats: this.listChats().filter((chat) => chat.id !== id) });
  }
}
