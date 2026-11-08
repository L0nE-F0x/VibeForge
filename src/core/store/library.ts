import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { writeFileAtomic } from "../fsx.js";
import { isSafeId, slugify } from "../slug.js";
import { TASK_STATUSES } from "../tasks.js";
import type { WorkingCopy } from "../worktrees.js";
import type { Agent, AgentTier, Routine, Schedule, Skill, Task, TaskStatus } from "../types.js";
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

function readYaml(file: string): unknown {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A "good at" line: one line, short enough for a roster. */
export function oneLine(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
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
    allowRoutines: bool(record.allowRoutines, true),
    voice: str(record.voice).trim(),
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
 */
export class Library {
  private readonly configRoot: string;
  private readonly cache: ReadCache;

  constructor(configRoot: string, cache: ReadCache) {
    this.configRoot = configRoot;
    this.cache = cache;
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
    const file = path.join(this.configRoot, "agents", id, "agent.yaml");
    return this.cache.read(file, () => normalizeAgent(id, readYaml(file)));
  }

  writeAgent(agent: Agent): void {
    const dir = path.join(this.configRoot, "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const memoryPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_STARTER);
    writeFileAtomic(path.join(dir, "agent.yaml"), yamlText({ ...agent, memoryFile: "memory.md" }));
    this.cache.forget(path.join(dir, "agent.yaml"));
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
}
