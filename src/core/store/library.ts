import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { tildify } from "../../shared/text.js";
import { noteOwnDelete, writeFileAtomic } from "../fsx.js";
import { isSafeId, slugify } from "../slug.js";
import { TASK_STATUSES } from "../tasks.js";
import type { WorkingCopy } from "../worktrees.js";
import type { Agent, AgentTier, LibraryKind, Routine, Schedule, Skill, Task, TaskStatus, UnreadableItem } from "../types.js";
import { carryUnknown, formatVersion, type Shape } from "./carry.js";
import { bool, str, strList, strOrNull } from "./fields.js";
import type { ReadCache } from "./read-cache.js";

export const MEMORY_STARTER =
  "<!-- Preferences, decisions, constraints, and lessons that should still matter next week. Dated bullets. No secrets. VibeForge adds this file to every run of this agent. -->\n";

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

/**
 * A file or folder in the config folder that is there but couldn't be read (permissions, a disk
 * error, YAML that doesn't parse): not one that is missing. Its message says which and why, in
 * English the window translates (core.read* in the i18n files).
 */
export class UnreadableError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    // Named plain "Error", as Electron passes "<name>: <message>" to the window, which keeps the message.
    super(message);
  }
}

/**
 * agent.yaml's format, written into it as `version`. Raise it with a migration when a field
 * changes meaning; a file a newer VibeForge wrote keeps its own number (see formatVersion).
 */
export const AGENT_VERSION = 1;

/** Every field agent.yaml has in this version; anything else in the file is carried through a save. */
const AGENT_SHAPE: Shape = {
  version: true,
  // Retired: an agent once had a voice of its own. Named here, so a save drops it rather than carrying it.
  voice: true,
  ...({ id: true, name: true, engine: true, brief: true, memoryFile: true, places: true, skills: true, allowRoutines: true, goodAt: true, tier: true, createdAt: true, updatedAt: true } satisfies Record<keyof Agent, true>),
};

/** What an agent.yaml about to be saved over holds now, for the fields a newer version added; null when none. */
function savedYaml(file: string): unknown {
  try {
    return parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** No such file or folder yet: the one failure that means "not there". */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function shown(file: string): string {
  return tildify(file, os.homedir());
}

/** Why reading `file` failed, as an UnreadableError. */
export function unreadable(file: string, error: unknown): UnreadableError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return new UnreadableError(file, `Couldn't read ${shown(file)}: VibeForge isn't allowed to. Check its permissions.`);
  // Node's message names the call and the path again ("EIO: i/o error, read '/…'"): the reason is enough.
  const detail = error instanceof Error ? error.message.replace(/, \w+(?: '[^']*')+$/, "") : String(error);
  return new UnreadableError(file, `Couldn't read ${shown(file)}: ${detail}`);
}

/** A text file's contents; null when there is no such file. One that is there but can't be read throws. */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw unreadable(file, error);
  }
}

/** A YAML file's fields; null when there is no such file. One that can't be read, doesn't parse or holds no fields throws. */
function readYaml(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (text === null) return null;
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim().replace(/:$/, "");
    throw new UnreadableError(file, `Couldn't read ${shown(file)}: it isn't valid YAML (${detail}).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnreadableError(file, `Couldn't read ${shown(file)}: it doesn't hold any fields.`);
  return value as Record<string, unknown>;
}

/** What `read` gives, or null for an item that is there but couldn't be read: for the many callers that only look something up. */
function orNull<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof UnreadableError) return null;
    throw error;
  }
}

/** The items of one kind that could be read, and the files that couldn't. */
interface Scan<T> {
  items: T[];
  unreadable: UnreadableItem[];
}

/** A "good at" line: one line, short enough for a roster. */
export function oneLine(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * An on/off field of a YAML file written by hand. The parser follows YAML 1.2, which reads `no`,
 * `off`, `yes` and `on` as text, while YAML 1.1, which many tools still follow, reads them as
 * false and true. As text they fell back to the default, so `enabled: no` turned a routine on.
 */
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "string") {
    if (/^(?:yes|on)$/i.test(value)) return true;
    if (/^(?:no|off)$/i.test(value)) return false;
  }
  return bool(value, fallback);
}

export function agentTier(value: unknown): AgentTier {
  return value === "fast" || value === "everyday" || value === "strong" ? value : "";
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
    allowRoutines: flag(record.allowRoutines, true),
    goodAt: oneLine(str(record.goodAt)),
    tier: agentTier(record.tier),
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
    enabled: flag(record.enabled, true),
    schedule: schedule(record.schedule),
    prompt: str(record.prompt),
    notify: flag(record.notify, true),
    lastFiredAt: strOrNull(record.lastFiredAt),
    lastMissedAt: strOrNull(record.lastMissedAt),
    shareCheckout: flag(record.shareCheckout, false),
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
    isolated: flag(record.isolated, false),
    copy: workingCopy(record.copy),
    shareCheckout: flag(record.shareCheckout, false),
    sourceRunId: strOrNull(record.sourceRunId),
    askedBy: strOrNull(record.askedBy),
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

/**
 * What people write by hand in the config folder: agents/<id>/agent.yaml and memory.md,
 * skills/<id>/SKILL.md, routines/<id>.yaml and tasks/<id>.yaml. Agents go through the read cache.
 *
 * Reading tells "not there" from "there but unreadable". A list throws UnreadableError when its
 * folder can't be read (one that doesn't exist yet is just empty), and leaves out a file it can't
 * read, which `unreadableFiles` names. `read*` throws for an unreadable item; `get*` gives null
 * for it, as for a missing one, for the callers that only look something up.
 */
export class Library {
  private readonly configRoot: string;
  private readonly cache: ReadCache;

  constructor(configRoot: string, cache: ReadCache) {
    this.configRoot = configRoot;
    this.cache = cache;
  }

  // ---------------------------------------------------------------- agents

  /** A free id for `base` in `dir`: not a file there, and not one `inUse` still answers for. */
  uniqueId(dir: string, base: string, extension: string, inUse: (id: string) => boolean = () => false): string {
    const root = slugify(base);
    const taken = (id: string) => fs.existsSync(path.join(dir, `${id}${extension}`)) || inUse(id);
    if (!taken(root)) return root;
    let count = 2;
    while (taken(`${root}-${count}`)) count += 1;
    return `${root}-${count}`;
  }

  listAgents(): Agent[] {
    return this.scanAgents().items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agent, or null when it isn't there. Throws UnreadableError when it is there but can't be read. */
  readAgent(id: string): Agent | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "agents", id, "agent.yaml");
    return this.cache.read(file, () => normalizeAgent(id, readYaml(file)));
  }

  /** As readAgent, with null for one that can't be read too. */
  getAgent(id: string): Agent | null {
    return orNull(() => this.readAgent(id));
  }

  /** Save `agent`, keeping any field a newer VibeForge wrote into its agent.yaml that this one doesn't know. */
  writeAgent(agent: Agent): void {
    const dir = path.join(this.configRoot, "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const memoryPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_STARTER, { mode: 0o600 });
    const file = path.join(dir, "agent.yaml");
    const raw = savedYaml(file);
    const known = { version: formatVersion(raw, AGENT_VERSION), ...agent, memoryFile: "memory.md" };
    writeFileAtomic(file, yamlText(carryUnknown(known, raw, AGENT_SHAPE)));
    this.cache.forget(file);
  }

  /** An agent's memory; empty when it has none yet. Throws UnreadableError when memory.md is there but can't be read. */
  readMemory(agentId: string): string {
    if (!isSafeId(agentId)) return "";
    return readText(path.join(this.configRoot, "agents", agentId, "memory.md")) ?? "";
  }

  writeMemory(agentId: string, text: string): void {
    if (!isSafeId(agentId)) throw new Error("Agent is missing");
    writeFileAtomic(path.join(this.configRoot, "agents", agentId, "memory.md"), text);
  }

  // ---------------------------------------------------------------- skills

  listSkills(): Skill[] {
    return this.scanSkills().items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The skill, or null when it isn't there. Throws UnreadableError when it is there but can't be read. */
  readSkill(id: string): Skill | null {
    const raw = this.readSkillRaw(id);
    return raw === null ? null : parseSkill(id, raw);
  }

  /** As readSkill, with null for one that can't be read too. */
  getSkill(id: string): Skill | null {
    return orNull(() => this.readSkill(id));
  }

  /** SKILL.md as written; null when it isn't there. Throws UnreadableError when it is there but can't be read. */
  readSkillRaw(id: string): string | null {
    if (!isSafeId(id)) return null;
    return readText(path.join(this.configRoot, "skills", id, "SKILL.md"));
  }

  writeSkill(skill: Skill): void {
    const dir = path.join(this.configRoot, "skills", skill.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    writeFileAtomic(path.join(dir, "SKILL.md"), skillDocument(skill));
  }

  /** Where a skill, routine or task lives on disk, for moving it aside (see Trash). Null for a bad id. */
  pathOf(kind: "skill" | "routine" | "task", id: string): string | null {
    if (!isSafeId(id)) return null;
    if (kind === "skill") return path.join(this.configRoot, "skills", id);
    return path.join(this.configRoot, kind === "routine" ? "routines" : "tasks", `${id}.yaml`);
  }

  deleteSkill(id: string): void {
    if (!isSafeId(id)) return;
    const dir = path.join(this.configRoot, "skills", id);
    noteOwnDelete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- routines

  listRoutines(): Routine[] {
    return this.scanRoutines().items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The routine, or null when it isn't there. Throws UnreadableError when it is there but can't be read. */
  readRoutine(id: string): Routine | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "routines", `${id}.yaml`);
    return this.cache.read(file, () => normalizeRoutine(id, readYaml(file)));
  }

  /** As readRoutine, with null for one that can't be read too. */
  getRoutine(id: string): Routine | null {
    return orNull(() => this.readRoutine(id));
  }

  writeRoutine(routine: Routine): void {
    const file = path.join(this.configRoot, "routines", `${routine.id}.yaml`);
    writeFileAtomic(file, yamlText(routine));
    this.cache.forget(file);
  }

  deleteRoutine(id: string): void {
    if (!isSafeId(id)) return;
    const file = path.join(this.configRoot, "routines", `${id}.yaml`);
    noteOwnDelete(file);
    fs.rmSync(file, { force: true });
    this.cache.forget(file);
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): Task[] {
    return this.scanTasks().items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  /** The task, or null when it isn't there. Throws UnreadableError when it is there but can't be read. */
  readTask(id: string): Task | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "tasks", `${id}.yaml`);
    // Parsed once while the file holds still: the task board asks for every task on each refresh.
    return this.cache.read(file, () => normalizeTask(id, readYaml(file)));
  }

  /** As readTask, with null for one that can't be read too. */
  getTask(id: string): Task | null {
    return orNull(() => this.readTask(id));
  }

  writeTask(task: Task): void {
    const file = path.join(this.configRoot, "tasks", `${task.id}.yaml`);
    writeFileAtomic(file, yamlText(task));
    this.cache.forget(file);
  }

  deleteTask(id: string): void {
    if (!isSafeId(id)) return;
    const file = path.join(this.configRoot, "tasks", `${id}.yaml`);
    noteOwnDelete(file);
    fs.rmSync(file, { force: true });
    this.cache.forget(file);
  }

  // ---------------------------------------------------------------- reading a whole folder

  /**
   * The files a list left out because they are there but couldn't be read, of every kind, so the
   * window can name them. A folder that can't be read at all isn't here: its list throws instead.
   */
  unreadableItems(): UnreadableItem[] {
    const scans = [() => this.scanAgents(), () => this.scanSkills(), () => this.scanRoutines(), () => this.scanTasks()];
    return scans.flatMap((scan) => orNull(() => scan().unreadable) ?? []);
  }

  private scanAgents(): Scan<Agent> {
    return this.collect("agent", this.folderIds("agents", "/"), (id) => this.readAgent(id));
  }

  private scanSkills(): Scan<Skill> {
    return this.collect("skill", this.folderIds("skills", "/"), (id) => this.readSkill(id));
  }

  private scanRoutines(): Scan<Routine> {
    return this.collect("routine", this.folderIds("routines", ".yaml"), (id) => this.readRoutine(id));
  }

  private scanTasks(): Scan<Task> {
    return this.collect("task", this.folderIds("tasks", ".yaml"), (id) => this.readTask(id));
  }

  /**
   * The ids in a library folder: its folders ("/") or its files ending in `extension`. None when the
   * folder doesn't exist yet; UnreadableError when it is there but can't be read, so a list that
   * couldn't be read never passes for an empty one.
   */
  private folderIds(folder: string, extension: "/" | ".yaml"): string[] {
    const root = path.join(this.configRoot, folder);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw unreadable(root, error);
    }
    const ids =
      extension === "/"
        ? entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : entries.filter((entry) => entry.name.endsWith(extension)).map((entry) => entry.name.slice(0, -extension.length));
    return ids.filter((id) => isSafeId(id));
  }

  /** Every item `read` finds, and each one that is there but couldn't be read. */
  private collect<T>(kind: LibraryKind, ids: readonly string[], read: (id: string) => T | null): Scan<T> {
    const scan: Scan<T> = { items: [], unreadable: [] };
    for (const id of ids) {
      try {
        const item = read(id);
        if (item) scan.items.push(item);
      } catch (error) {
        if (!(error instanceof UnreadableError)) throw error;
        scan.unreadable.push({ kind, id, file: error.file, error: error.message });
      }
    }
    return scan;
  }
}
