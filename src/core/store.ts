import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "yaml";
import { isSafeId, slugify } from "./slug.js";
import type {
  Agent,
  ChatRecord,
  EngineRow,
  Routine,
  RunMeta,
  RunOrigin,
  RunStatus,
  Skill,
  Task,
  TaskStatus,
  Workspace,
  Schedule,
} from "./types.js";

export const MEMORY_NOTE =
  "<!-- Preferences, decisions, constraints, and lessons. Dated bullets. -->\n";

const RUN_COLUMNS = [
  "id",
  "origin",
  "agentId",
  "routineId",
  "taskId",
  "chatId",
  "engine",
  "cwd",
  "prompt",
  "startedAt",
  "endedAt",
  "status",
  "openedAt",
  "dir",
  "notifiedAt",
] as const;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asSchedule(value: unknown): Schedule {
  if (value && typeof value === "object") {
    const record = value as { kind?: unknown; expr?: unknown; minutes?: unknown };
    if (record.kind === "cron") return { kind: "cron", expr: asString(record.expr) };
    if (record.kind === "every") {
      const minutes = typeof record.minutes === "number" ? record.minutes : Number(record.minutes);
      return { kind: "every", minutes };
    }
  }
  return { kind: "every", minutes: 0 };
}

function yamlText(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function readYaml(file: string): unknown {
  return parse(fs.readFileSync(file, "utf8"));
}

export function seedEngines(): EngineRow[] {
  return [
    { id: "grok", label: "Grok Build", bin: "grok", args: [] },
    { id: "claude", label: "Claude Code", bin: "claude", args: [] },
    { id: "codex", label: "Codex", bin: "codex", args: [] },
    { id: "cursor-agent", label: "Cursor Agent", bin: "cursor-agent", args: [] },
    { id: "gemini", label: "Gemini CLI", bin: "gemini", args: [] },
    { id: "copilot", label: "Copilot", bin: "copilot", args: [] },
    { id: "opencode", label: "OpenCode", bin: "opencode", args: [] },
  ];
}

function normalizeAgent(id: string, value: unknown): Agent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<Agent>;
  return {
    id,
    name: asString(record.name),
    engine: asString(record.engine),
    brief: asString(record.brief),
    memoryFile: asString(record.memoryFile, "memory.md") || "memory.md",
    places: asStringList(record.places),
    skills: asStringList(record.skills),
    allowRoutines: asBool(record.allowRoutines, true),
    createdAt: asString(record.createdAt),
    updatedAt: asString(record.updatedAt),
  };
}

function normalizeSkill(id: string, text: string): Skill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { id, name: id, description: "", body: text.replace(/^\n/, "") };
  const front = parse(match[1]) as { name?: unknown; description?: unknown } | null;
  const body = match[2].replace(/^\n/, "");
  return {
    id,
    name: asString(front?.name, id) || id,
    description: asString(front?.description),
    body,
  };
}

function skillDocument(skill: Skill): string {
  const front = yamlText({ name: skill.name, description: skill.description }).trimEnd();
  const body = skill.body.replace(/^\n+/, "").trimEnd();
  return `---\n${front}\n---\n\n${body}\n`;
}

function normalizeRoutine(id: string, value: unknown): Routine | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<Routine>;
  return {
    id,
    name: asString(record.name),
    agentId: asString(record.agentId),
    enabled: asBool(record.enabled, true),
    schedule: asSchedule(record.schedule),
    prompt: asString(record.prompt),
    notify: asBool(record.notify, true),
    lastFiredAt: asNullable(record.lastFiredAt),
    lastMissedAt: asNullable(record.lastMissedAt),
  };
}

function normalizeTask(id: string, value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<Task>;
  const status = asString(record.status, "todo");
  const allowed: TaskStatus[] = ["todo", "running", "review", "done"];
  return {
    id,
    title: asString(record.title),
    body: asString(record.body),
    status: allowed.includes(status as TaskStatus) ? (status as TaskStatus) : "todo",
    agentId: asNullable(record.agentId),
    workspaceId: asNullable(record.workspaceId),
    runIds: asStringList(record.runIds),
  };
}

function normalizeChat(value: unknown): ChatRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ChatRecord>;
  const id = asString(record.id);
  if (!isSafeId(id)) return null;
  return {
    id,
    title: asString(record.title, "Chat") || "Chat",
    agentId: asNullable(record.agentId),
    engine: asString(record.engine),
    cwd: asString(record.cwd),
    runId: asNullable(record.runId),
    ptyId: asNullable(record.ptyId),
    createdAt: asString(record.createdAt),
    updatedAt: asString(record.updatedAt),
  };
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Workspace>;
  return typeof record.id === "string" && typeof record.path === "string" && record.path.length > 0;
}

const ORIGINS: RunOrigin[] = ["agent-chat", "routine", "task", "code", "chat"];
const STATUSES: RunStatus[] = ["running", "exited", "stopped", "failed"];

function normalizeRun(value: Partial<RunMeta> | null | undefined): RunMeta | null {
  if (!value || typeof value.id !== "string" || !value.id) return null;
  const origin = ORIGINS.includes(value.origin as RunOrigin) ? (value.origin as RunOrigin) : "chat";
  const status = STATUSES.includes(value.status as RunStatus) ? (value.status as RunStatus) : "running";
  return {
    id: value.id,
    origin,
    agentId: asNullable(value.agentId),
    routineId: asNullable(value.routineId),
    taskId: asNullable(value.taskId),
    chatId: asNullable(value.chatId),
    engine: asString(value.engine),
    cwd: asString(value.cwd),
    prompt: asString(value.prompt),
    startedAt: asString(value.startedAt),
    endedAt: asNullable(value.endedAt),
    status,
    openedAt: asNullable(value.openedAt),
    dir: asString(value.dir),
    notifiedAt: asNullable(value.notifiedAt),
  };
}

export class Store {
  readonly configRoot: string;
  readonly dataRoot: string;
  private readonly db: DatabaseSync;

  constructor(configRoot: string, dataRoot: string) {
    this.configRoot = configRoot;
    this.dataRoot = dataRoot;
    fs.mkdirSync(path.join(configRoot, "agents"), { recursive: true });
    fs.mkdirSync(path.join(configRoot, "skills"), { recursive: true });
    fs.mkdirSync(path.join(configRoot, "routines"), { recursive: true });
    fs.mkdirSync(path.join(configRoot, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "runs"), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "scratch"), { recursive: true });
    this.db = new DatabaseSync(path.join(dataRoot, "index.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      origin TEXT,
      agentId TEXT,
      routineId TEXT,
      taskId TEXT,
      chatId TEXT,
      engine TEXT,
      cwd TEXT,
      prompt TEXT,
      startedAt TEXT,
      endedAt TEXT,
      status TEXT,
      openedAt TEXT,
      dir TEXT,
      notifiedAt TEXT
    )`);
  }

  close(): void {
    this.db.close();
  }

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
    if (!fs.existsSync(root)) return [];
    const agents: Agent[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agent = this.getAgent(entry.name);
      if (agent) agents.push(agent);
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAgent(id: string): Agent | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "agents", id, "agent.yaml");
    if (!fs.existsSync(file)) return null;
    return normalizeAgent(id, readYaml(file));
  }

  writeAgent(agent: Agent): void {
    const dir = path.join(this.configRoot, "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const memoryPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_NOTE);
    const stored: Agent = { ...agent, memoryFile: "memory.md" };
    fs.writeFileSync(path.join(dir, "agent.yaml"), yamlText(stored));
  }

  readMemory(agentId: string): string {
    if (!isSafeId(agentId)) return "";
    const file = path.join(this.configRoot, "agents", agentId, "memory.md");
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  }

  writeMemory(agentId: string, text: string): void {
    if (!isSafeId(agentId)) throw new Error("Agent is missing");
    const dir = path.join(this.configRoot, "agents", agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.md"), text);
  }

  deleteAgent(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "agents", id), { recursive: true, force: true });
  }

  listSkills(): Skill[] {
    const root = path.join(this.configRoot, "skills");
    if (!fs.existsSync(root)) return [];
    const skills: Skill[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = this.getSkill(entry.name);
      if (skill) skills.push(skill);
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(id: string): Skill | null {
    const raw = this.readSkillRaw(id);
    if (raw === null) return null;
    return normalizeSkill(id, raw);
  }

  readSkillRaw(id: string): string | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "skills", id, "SKILL.md");
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  writeSkill(skill: Skill): void {
    const dir = path.join(this.configRoot, "skills", skill.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillDocument(skill));
  }

  deleteSkill(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "skills", id), { recursive: true, force: true });
  }

  listRoutines(): Routine[] {
    const root = path.join(this.configRoot, "routines");
    if (!fs.existsSync(root)) return [];
    const routines: Routine[] = [];
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith(".yaml")) continue;
      const routine = this.getRoutine(entry.slice(0, -5));
      if (routine) routines.push(routine);
    }
    return routines.sort((a, b) => a.name.localeCompare(b.name));
  }

  getRoutine(id: string): Routine | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "routines", `${id}.yaml`);
    if (!fs.existsSync(file)) return null;
    return normalizeRoutine(id, readYaml(file));
  }

  writeRoutine(routine: Routine): void {
    const file = path.join(this.configRoot, "routines", `${routine.id}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yamlText(routine));
  }

  deleteRoutine(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "routines", `${id}.yaml`), { force: true });
  }

  listTasks(): Task[] {
    const root = path.join(this.configRoot, "tasks");
    if (!fs.existsSync(root)) return [];
    const tasks: Task[] = [];
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith(".yaml")) continue;
      const task = this.getTask(entry.slice(0, -5));
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => a.title.localeCompare(b.title));
  }

  getTask(id: string): Task | null {
    if (!isSafeId(id)) return null;
    const file = path.join(this.configRoot, "tasks", `${id}.yaml`);
    if (!fs.existsSync(file)) return null;
    return normalizeTask(id, readYaml(file));
  }

  writeTask(task: Task): void {
    const file = path.join(this.configRoot, "tasks", `${task.id}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yamlText(task));
  }

  deleteTask(id: string): void {
    if (!isSafeId(id)) return;
    fs.rmSync(path.join(this.configRoot, "tasks", `${id}.yaml`), { force: true });
  }

  private chatFile(): string {
    return path.join(this.dataRoot, "chats.json");
  }

  listChats(): ChatRecord[] {
    const file = this.chatFile();
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { chats?: unknown } | unknown[];
      const list = Array.isArray(parsed) ? parsed : parsed.chats;
      if (!Array.isArray(list)) return [];
      return list.map((item) => normalizeChat(item)).filter((item): item is ChatRecord => item !== null);
    } catch {
      return [];
    }
  }

  getChat(id: string): ChatRecord | null {
    return this.listChats().find((chat) => chat.id === id) ?? null;
  }

  writeChat(chat: ChatRecord): void {
    const chats = this.listChats().filter((item) => item.id !== chat.id);
    chats.push(chat);
    chats.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    fs.writeFileSync(this.chatFile(), `${JSON.stringify({ chats }, null, 2)}\n`);
  }

  deleteChat(id: string): void {
    const chats = this.listChats().filter((chat) => chat.id !== id);
    fs.writeFileSync(this.chatFile(), `${JSON.stringify({ chats }, null, 2)}\n`);
  }

  listWorkspaces(): Workspace[] {
    const file = path.join(this.configRoot, "workspaces.json");
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { workspaces?: unknown } | unknown[];
      const list = Array.isArray(parsed) ? parsed : parsed.workspaces;
      if (!Array.isArray(list)) return [];
      return list.filter(isWorkspace).map((workspace) => ({
        id: workspace.id,
        name: typeof workspace.name === "string" && workspace.name ? workspace.name : workspace.id,
        path: workspace.path,
      }));
    } catch {
      return [];
    }
  }

  readEngines(): EngineRow[] {
    const file = path.join(this.configRoot, "engines.json");
    if (!fs.existsSync(file)) return seedEngines();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { engines?: unknown };
      if (!Array.isArray(parsed.engines)) return [];
      return parsed.engines
        .filter((item): item is { id: string; label?: string; bin?: string; args?: unknown } => {
          return Boolean(item) && typeof item === "object" && typeof (item as { id?: string }).id === "string";
        })
        .map((item) => ({
          id: item.id,
          label: typeof item.label === "string" && item.label ? item.label : item.id,
          bin: typeof item.bin === "string" && item.bin ? item.bin : item.id,
          args: Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === "string") : [],
        }));
    } catch {
      return [];
    }
  }

  upsertRun(meta: RunMeta): void {
    const normalized = normalizeRun(meta);
    if (!normalized) return;
    if (normalized.dir) {
      fs.mkdirSync(normalized.dir, { recursive: true });
      fs.writeFileSync(path.join(normalized.dir, "meta.json"), `${JSON.stringify(normalized, null, 2)}\n`);
    }
    const statement = this.db.prepare(
      `INSERT INTO runs (${RUN_COLUMNS.join(", ")})
       VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT(id) DO UPDATE SET
         origin = excluded.origin,
         agentId = excluded.agentId,
         routineId = excluded.routineId,
         taskId = excluded.taskId,
         chatId = excluded.chatId,
         engine = excluded.engine,
         cwd = excluded.cwd,
         prompt = excluded.prompt,
         startedAt = excluded.startedAt,
         endedAt = excluded.endedAt,
         status = excluded.status,
         openedAt = excluded.openedAt,
         dir = excluded.dir,
         notifiedAt = excluded.notifiedAt`,
    );
    statement.run(
      normalized.id,
      normalized.origin,
      normalized.agentId,
      normalized.routineId,
      normalized.taskId,
      normalized.chatId,
      normalized.engine,
      normalized.cwd,
      normalized.prompt,
      normalized.startedAt,
      normalized.endedAt,
      normalized.status,
      normalized.openedAt,
      normalized.dir,
      normalized.notifiedAt,
    );
  }

  getRun(id: string): RunMeta | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunMeta | undefined;
    if (!row) return this.readRunDir(id);
    return this.overlayRun(row) ?? normalizeRun(row);
  }

  listRuns(): RunMeta[] {
    const byId = new Map<string, RunMeta>();
    for (const run of this.scanRunFiles()) byId.set(run.id, run);
    const rows = this.db.prepare("SELECT * FROM runs").all() as unknown as RunMeta[];
    for (const row of rows) {
      const run = this.overlayRun(row) ?? normalizeRun(row);
      if (run) byId.set(run.id, run);
    }
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private readRunDir(id: string): RunMeta | null {
    if (!isSafeId(id)) return null;
    const metaPath = path.join(this.dataRoot, "runs", id, "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      return normalizeRun(JSON.parse(fs.readFileSync(metaPath, "utf8")) as RunMeta);
    } catch {
      return null;
    }
  }

  private overlayRun(row: RunMeta): RunMeta | null {
    const base = normalizeRun(row);
    if (!base?.dir) return base;
    const metaPath = path.join(base.dir, "meta.json");
    if (!fs.existsSync(metaPath)) return base;
    try {
      return normalizeRun(JSON.parse(fs.readFileSync(metaPath, "utf8")) as RunMeta) ?? base;
    } catch {
      return base;
    }
  }

  private scanRunFiles(): RunMeta[] {
    const root = path.join(this.dataRoot, "runs");
    if (!fs.existsSync(root)) return [];
    const runs: RunMeta[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(root, entry.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const run = normalizeRun(JSON.parse(fs.readFileSync(metaPath, "utf8")) as RunMeta);
        if (run) runs.push(run);
      } catch {
        continue;
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
