import fs from "node:fs";
import path from "node:path";
import { withAvailability } from "./engines.js";
import { isPathInside } from "./places.js";
import { buildPreamble, buildStandalonePreamble } from "./preamble.js";
import { decideRoutineTick, decideRunNow, isScheduleValid, nextFireTimes, type TickDecision } from "./routines.js";
import { createRunFiles, markStopRequested, readRun } from "./runs.js";
import { slugify } from "./slug.js";
import { Store } from "./store.js";
import { assignTask, createTask, markStopped, requestExecute, syncTaskWithRun } from "./tasks.js";
import type {
  Agent,
  ChatRecord,
  EngineRow,
  Routine,
  RunMeta,
  RunOrigin,
  Schedule,
  Skill,
  Task,
  TaskStatus,
  Workspace,
} from "./types.js";

export interface PtySpawnRequest {
  cwd: string;
  argv: string[];
  runDir: string;
  initialInput: string;
  runId: string;
}

export interface TeamHost {
  spawnPty(request: PtySpawnRequest): Promise<{ ptyId: string }>;
  writePty(ptyId: string, data: string): void;
  killPty(ptyId: string): void;
  isPtyAlive(ptyId: string): boolean;
  resolveBin(bin: string): string | null;
  notify(title: string, body: string): void;
  snapshotGit(cwd: string, timeoutMs?: number): Promise<string>;
}

export interface TeamServiceOptions {
  configRoot: string;
  dataRoot: string;
  appStartedAt: Date;
  now: () => Date;
  host: TeamHost;
}

export interface AgentInput {
  id?: string;
  name: string;
  engine: string;
  brief: string;
  places: string[];
  skills?: string[];
  allowRoutines?: boolean;
}

export interface RoutineInput {
  id?: string;
  name: string;
  agentId: string;
  enabled?: boolean;
  schedule: Schedule;
  prompt?: string;
  notify?: boolean;
}

export interface SkillInput {
  id?: string;
  name: string;
  description?: string;
  body?: string;
}

export interface TaskInput {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
}

export interface SendResult {
  ok: boolean;
  startedNew?: boolean;
  chatId?: string;
  runId?: string | null;
  ptyId?: string | null;
  reason?: string;
  message?: string;
}

export interface RoutineListItem extends Routine {
  issues: string[];
  stillRunning: boolean;
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function normalizePlaces(places: readonly string[]): string[] {
  const out: string[] = [];
  for (const place of places) {
    if (typeof place !== "string" || place.trim().length === 0) continue;
    const resolved = path.resolve(place.trim());
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export class TeamService {
  private readonly options: TeamServiceOptions;
  private readonly store: Store;
  private readonly ptyByRun = new Map<string, string>();
  private readonly runByPty = new Map<string, string>();

  constructor(options: TeamServiceOptions) {
    this.options = options;
    this.store = new Store(options.configRoot, options.dataRoot);
  }

  static create(options: TeamServiceOptions): TeamService {
    return new TeamService(options);
  }

  now(): Date {
    return this.options.now();
  }

  close(): void {
    this.store.close();
  }

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  async saveAgent(input: AgentInput): Promise<Agent> {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Name is required");
    if (!input.brief?.trim()) throw new Error("Brief is required");
    const engineId = input.engine?.trim() ?? "";
    if (!engineId) throw new Error("Engine is required");
    const row = this.store.readEngines().find((engine) => engine.id === engineId);
    if (!row) throw new Error("Engine is missing");
    const resolved = this.options.host.resolveBin(row.bin);
    if (typeof resolved !== "string" || resolved.length === 0) throw new Error("Engine is not on PATH");
    const places = normalizePlaces(input.places ?? []);
    if (places.length === 0) throw new Error("Add an existing directory");
    for (const place of places) {
      if (!this.existingDir(place)) throw new Error(`Directory is missing: ${place}`);
    }
    const now = this.now().toISOString();
    const existing = input.id ? this.store.getAgent(input.id) : null;
    const id =
      existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "agents"), name, "");
    const agent: Agent = {
      id,
      name,
      engine: engineId,
      brief: input.brief,
      memoryFile: "memory.md",
      places,
      skills: input.skills ? [...input.skills] : (existing?.skills ?? []),
      allowRoutines:
        typeof input.allowRoutines === "boolean" ? input.allowRoutines : (existing?.allowRoutines ?? true),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.store.writeAgent(agent);
    return agent;
  }

  async deleteAgent(id: string, confirmName: string): Promise<void> {
    const agent = this.store.getAgent(id);
    if (!agent) throw new Error("Agent is missing");
    if (confirmName !== agent.name) throw new Error("Type the agent name to delete it");
    this.store.deleteAgent(id);
  }

  async readMemory(agentId: string): Promise<string> {
    if (!this.store.getAgent(agentId)) throw new Error("Agent is missing");
    return this.store.readMemory(agentId);
  }

  async writeMemory(agentId: string, text: string): Promise<void> {
    if (!this.store.getAgent(agentId)) throw new Error("Agent is missing");
    this.store.writeMemory(agentId, text);
  }

  listSkills(): Skill[] {
    return this.store.listSkills();
  }

  async saveSkill(input: SkillInput): Promise<Skill> {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Name is required");
    const existing = input.id ? this.store.getSkill(input.id) : null;
    const id = existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "skills"), name, "");
    const skill: Skill = {
      id,
      name,
      description: input.description ?? existing?.description ?? "",
      body: input.body ?? existing?.body ?? "",
    };
    this.store.writeSkill(skill);
    return skill;
  }

  async deleteSkill(id: string): Promise<void> {
    this.store.deleteSkill(id);
    const now = this.now().toISOString();
    for (const agent of this.store.listAgents()) {
      if (!agent.skills.includes(id)) continue;
      this.store.writeAgent({
        ...agent,
        skills: agent.skills.filter((skillId) => skillId !== id),
        updatedAt: now,
      });
    }
  }

  listRoutines(): RoutineListItem[] {
    return this.store.listRoutines().map((routine) => ({
      ...routine,
      issues: this.routineIssues(routine),
      stillRunning: this.routineStillRunning(routine.id),
    }));
  }

  async saveRoutine(input: RoutineInput): Promise<Routine> {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Name is required");
    if (!input.agentId?.trim()) throw new Error("Agent is required");
    if (!isScheduleValid(input.schedule)) throw new Error("Schedule is not valid");
    const existing = input.id ? this.store.getRoutine(input.id) : null;
    const id =
      existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "routines"), name, ".yaml");
    const routine: Routine = {
      id,
      name,
      agentId: input.agentId,
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      schedule: input.schedule,
      prompt: input.prompt ?? "",
      notify: typeof input.notify === "boolean" ? input.notify : (existing?.notify ?? true),
      lastFiredAt: existing?.lastFiredAt ?? null,
      lastMissedAt: existing?.lastMissedAt ?? null,
    };
    this.store.writeRoutine(routine);
    return routine;
  }

  async deleteRoutine(id: string): Promise<void> {
    this.store.deleteRoutine(id);
  }

  async setRoutineEnabled(id: string, enabled: boolean): Promise<Routine> {
    const routine = this.store.getRoutine(id);
    if (!routine) throw new Error("Routine is missing");
    const next = { ...routine, enabled };
    this.store.writeRoutine(next);
    return next;
  }

  previewRoutine(schedule: Schedule, count = 3): string[] {
    return nextFireTimes(schedule, this.now(), count).map((date) => date.toISOString());
  }

  async runRoutineNow(id: string): Promise<SendResult> {
    const routine = this.store.getRoutine(id);
    if (!routine) return { ok: false, reason: "missing-routine" };
    const agent = this.store.getAgent(routine.agentId);
    if (!agent) return { ok: false, reason: "missing-agent" };
    const engine = this.resolveEngine(agent.engine);
    const decision = decideRunNow({
      allowRoutines: agent.allowRoutines,
      engineAvailable: Boolean(engine),
      previousStillRunning: this.routineStillRunning(routine.id),
    });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    if (!engine) return { ok: false, reason: "engine-missing" };
    const cwd = this.firstPlace(agent.places);
    if (!cwd) return { ok: false, reason: "missing-place" };
    const lastFiredAt = routine.lastFiredAt;
    const chat = this.createChat({ title: routine.name, agentId: agent.id, engine: agent.engine, cwd });
    const launched = await this.launch({
      origin: "routine",
      engineId: agent.engine,
      binPath: engine.binPath,
      args: engine.row.args,
      cwd,
      prompt: routine.prompt,
      preamble: this.preambleFor(agent, routine.prompt),
      slug: routine.id,
      agentId: agent.id,
      routineId: routine.id,
      taskId: null,
      chatId: chat.id,
    });
    const current = this.store.getRoutine(routine.id);
    if (current && current.lastFiredAt !== lastFiredAt) {
      this.store.writeRoutine({ ...current, lastFiredAt });
    }
    return { ok: true, startedNew: false, chatId: chat.id, runId: launched.meta.id, ptyId: launched.ptyId };
  }

  async tick(now: Date = this.now()): Promise<Array<{ routineId: string; decision: TickDecision }>> {
    const results: Array<{ routineId: string; decision: TickDecision }> = [];
    for (const routine of this.store.listRoutines()) {
      const agent = routine.agentId ? this.store.getAgent(routine.agentId) : null;
      const engine = agent ? this.resolveEngine(agent.engine) : null;
      const decision = decideRoutineTick({
        now,
        appStartedAt: this.options.appStartedAt,
        enabled: routine.enabled,
        allowRoutines: agent ? agent.allowRoutines : false,
        engineAvailable: Boolean(engine),
        schedule: routine.schedule,
        lastFiredAt: routine.lastFiredAt,
        previousStillRunning: this.routineStillRunning(routine.id),
      });
      results.push({ routineId: routine.id, decision });
      if (decision.action === "miss") {
        const current = this.store.getRoutine(routine.id) ?? routine;
        this.store.writeRoutine({ ...current, lastMissedAt: decision.scheduledAt });
      } else if (decision.action === "fire") {
        await this.fireRoutine(routine, decision.scheduledAt);
      }
    }
    this.sweep();
    return results;
  }

  listTasks(): Task[] {
    return this.store.listTasks();
  }

  async saveTask(input: TaskInput): Promise<Task> {
    const title = input.title?.trim() ?? "";
    if (!title) throw new Error("Title is required");
    if (input.id) {
      const existing = this.store.getTask(input.id);
      if (existing) {
        const next: Task = {
          ...existing,
          title: input.title,
          body: input.body === undefined ? existing.body : input.body,
          agentId: input.agentId === undefined ? existing.agentId : input.agentId,
          workspaceId: input.workspaceId === undefined ? existing.workspaceId : input.workspaceId,
        };
        this.store.writeTask(next);
        return next;
      }
    }
    const task = createTask({
      title: input.title,
      body: input.body,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    this.store.writeTask(task);
    return task;
  }

  async assignTask(taskId: string, agentId: string, workspaceId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task is missing");
    const next = assignTask(task, agentId, workspaceId);
    this.store.writeTask(next);
    return next;
  }

  assign(taskId: string, agentId: string, workspaceId: string): Promise<Task> {
    return this.assignTask(taskId, agentId, workspaceId);
  }

  async executeTask(taskId: string): Promise<SendResult & { task?: Task }> {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, reason: "missing-task" };
    if (task.status === "running") return { ok: false, reason: "still-running" };
    const agent = task.agentId ? this.store.getAgent(task.agentId) : null;
    const workspace = task.workspaceId
      ? (this.store.listWorkspaces().find((item) => item.id === task.workspaceId) ?? null)
      : null;
    if (!workspace) return { ok: false, reason: "missing-workspace" };
    const decision = requestExecute(task, {
      workspacePath: workspace.path,
      agentPlaces: agent?.places ?? [],
      hasAgent: Boolean(agent),
    });
    if (!decision.ok) return { ok: false, reason: decision.reason };
    const engine = agent ? this.resolveEngine(agent.engine) : null;
    if (!agent || !engine) return { ok: false, reason: "engine-missing" };
    const launched = await this.launch({
      origin: "task",
      engineId: agent.engine,
      binPath: engine.binPath,
      args: engine.row.args,
      cwd: workspace.path,
      prompt: task.body,
      preamble: this.preambleFor(agent, task.body),
      slug: task.id,
      agentId: agent.id,
      routineId: null,
      taskId: task.id,
      chatId: null,
    });
    const next: Task = { ...decision.task, runIds: [...task.runIds, launched.meta.id] };
    this.store.writeTask(next);
    return { ok: true, task: next, runId: launched.meta.id, ptyId: launched.ptyId, chatId: undefined };
  }

  async stopTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task is missing");
    const runId = task.runIds[task.runIds.length - 1];
    if (runId) {
      const run = this.store.getRun(runId);
      if (run?.dir) {
        const stopped = markStopRequested(run.dir, this.now());
        if (stopped) this.store.upsertRun(stopped);
      }
      const ptyId = this.ptyByRun.get(runId);
      if (ptyId) this.options.host.killPty(ptyId);
    }
    const next = markStopped(task);
    this.store.writeTask(next);
    return next;
  }

  async setTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task is missing");
    const next = { ...task, status };
    this.store.writeTask(next);
    return next;
  }

  listChats(): ChatRecord[] {
    return this.store.listChats();
  }

  async startAgentChat(agentId: string): Promise<ChatRecord> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error("Agent is missing");
    const cwd = this.firstPlace(agent.places);
    if (!cwd) throw new Error("Directory is missing");
    return this.createChat({ title: "New chat", agentId: agent.id, engine: agent.engine, cwd });
  }

  async sendAgentChat(agentId: string, chatId: string, text: string): Promise<SendResult> {
    if (!text.trim()) return { ok: false, reason: "empty" };
    const agent = this.store.getAgent(agentId);
    if (!agent) return { ok: false, reason: "missing-agent" };
    const chat = this.store.getChat(chatId);
    if (!chat || chat.agentId !== agentId) return { ok: false, reason: "missing-chat" };
    if (chat.ptyId && this.options.host.isPtyAlive(chat.ptyId)) {
      this.options.host.writePty(chat.ptyId, withNewline(text));
      return { ok: true, startedNew: false, chatId: chat.id, runId: chat.runId, ptyId: chat.ptyId };
    }
    if (chat.runId || chat.ptyId) {
      const fresh = await this.startAgentChat(agentId);
      const started = await this.beginAgentRun(agent, fresh, text);
      if (!started.ok) return started;
      return { ...started, startedNew: true, message: "That session ended. This is a new chat." };
    }
    return this.beginAgentRun(agent, chat, text);
  }

  async startChat(engineId: string): Promise<ChatRecord> {
    const engine = this.resolveEngine(engineId);
    if (!engine) throw new Error("Engine is not on PATH");
    const id = this.uniqueChatId("chat");
    const cwd = path.join(this.options.dataRoot, "scratch", id);
    fs.mkdirSync(cwd, { recursive: true });
    const now = this.now().toISOString();
    const chat: ChatRecord = {
      id,
      title: "New chat",
      agentId: null,
      engine: engineId,
      cwd,
      runId: null,
      ptyId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.writeChat(chat);
    return chat;
  }

  async renameChat(chatId: string, title: string): Promise<ChatRecord> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is missing");
    const next = { ...chat, title: title.trim() || chat.title, updatedAt: this.now().toISOString() };
    this.store.writeChat(next);
    return next;
  }

  async deleteChat(chatId: string): Promise<void> {
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    const scratchRoot = path.join(this.options.dataRoot, "scratch");
    if (chat.cwd && isPathInside(scratchRoot, chat.cwd)) {
      fs.rmSync(chat.cwd, { recursive: true, force: true });
    }
    for (const run of this.store.listRuns()) {
      if (run.chatId !== chatId || !run.dir) continue;
      fs.rmSync(path.join(run.dir, "scrollback.txt"), { force: true });
    }
    if (chat.ptyId) this.options.host.killPty(chat.ptyId);
    this.store.deleteChat(chatId);
  }

  async sendChat(chatId: string, text: string): Promise<SendResult> {
    if (!text.trim()) return { ok: false, reason: "empty" };
    const chat = this.store.getChat(chatId);
    if (!chat || chat.agentId) return { ok: false, reason: "missing-chat" };
    if (chat.ptyId && this.options.host.isPtyAlive(chat.ptyId)) {
      this.options.host.writePty(chat.ptyId, withNewline(text));
      return { ok: true, startedNew: false, chatId: chat.id, runId: chat.runId, ptyId: chat.ptyId };
    }
    if (chat.runId || chat.ptyId) {
      const fresh = await this.startChat(chat.engine);
      fresh.title = chat.title;
      this.store.writeChat(fresh);
      const started = await this.beginStandaloneRun(fresh, text);
      if (!started.ok) return started;
      return { ...started, startedNew: true, message: "That session ended. This is a new chat." };
    }
    return this.beginStandaloneRun(chat, text);
  }

  listEngines(): Array<EngineRow & { available: boolean }> {
    return withAvailability(this.store.readEngines(), (bin) => this.options.host.resolveBin(bin));
  }

  listWorkspaces(): Workspace[] {
    return this.store.listWorkspaces();
  }

  listRuns(): Array<RunMeta & { ptyId: string | null }> {
    return this.store.listRuns().map((run) => ({ ...run, ptyId: this.ptyByRun.get(run.id) ?? null }));
  }

  listInboxRuns(now: Date = this.now()): RunMeta[] {
    const cutoff = now.getTime() - TWO_DAYS_MS;
    return this.store.listRuns().filter((run) => {
      if (run.status !== "exited" && run.status !== "stopped") return false;
      if (run.openedAt) return false;
      const started = Date.parse(run.startedAt);
      return !Number.isNaN(started) && started >= cutoff;
    });
  }

  async getRun(runId: string): Promise<{
    meta: RunMeta;
    preamble: string;
    scrollback: string;
    git: string;
    ptyId: string | null;
  }> {
    const meta = this.store.getRun(runId);
    if (!meta) throw new Error("Run is missing");
    const files =
      meta.dir && fs.existsSync(path.join(meta.dir, "meta.json"))
        ? readRun(meta.dir)
        : { meta, preamble: "", scrollback: "", git: "" };
    return { ...files, git: files.git ?? "", ptyId: this.ptyByRun.get(runId) ?? null };
  }

  async markRunOpened(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("Run is missing");
    this.store.upsertRun({ ...run, openedAt: this.now().toISOString() });
  }

  liveCount(): number {
    let count = 0;
    for (const ptyId of this.ptyByRun.values()) {
      if (this.options.host.isPtyAlive(ptyId)) count += 1;
    }
    return count;
  }

  async notePtyExit(ptyId: string, _exitCode?: number | null): Promise<void> {
    const runId = this.runByPty.get(ptyId);
    if (!runId) return;
    const run = this.store.getRun(runId);
    if (!run) return;
    if (run.status === "running") {
      const ended: RunMeta = { ...run, status: "exited", endedAt: this.now().toISOString() };
      this.store.upsertRun(ended);
    }
    if (run.dir && !fs.existsSync(path.join(run.dir, "git.txt"))) {
      let git = "not a git repo\n";
      try {
        git = await this.options.host.snapshotGit(run.cwd);
      } catch {
        git = "not a git repo\n";
      }
      if (!git.endsWith("\n")) git += "\n";
      fs.writeFileSync(path.join(run.dir, "git.txt"), git);
    }
    this.sweep();
  }

  sweep(): void {
    for (const task of this.store.listTasks()) {
      if (task.status !== "running") continue;
      const runId = task.runIds[task.runIds.length - 1];
      if (!runId) continue;
      const run = this.store.getRun(runId);
      if (!run) continue;
      const status = syncTaskWithRun(task, run.status);
      if (status !== task.status) this.store.writeTask({ ...task, status });
    }
    const routines = new Map(this.store.listRoutines().map((routine) => [routine.id, routine]));
    const agents = new Map(this.store.listAgents().map((agent) => [agent.id, agent]));
    for (const run of this.store.listRuns()) {
      if (run.origin !== "routine") continue;
      if (run.status !== "exited" && run.status !== "stopped") continue;
      if (run.notifiedAt || !run.routineId) continue;
      const routine = routines.get(run.routineId);
      if (!routine?.notify) continue;
      const agentName = (run.agentId && agents.get(run.agentId)?.name) || "Agent";
      try {
        this.options.host.notify(`${agentName}: ${routine.name}`, `${agentName} · ${routine.name} ${run.status}`);
      } catch {
        continue;
      }
      this.store.upsertRun({ ...run, notifiedAt: this.now().toISOString() });
    }
  }

  private async fireRoutine(routine: Routine, scheduledAt: string): Promise<void> {
    const agent = this.store.getAgent(routine.agentId);
    const engine = agent ? this.resolveEngine(agent.engine) : null;
    const cwd = agent ? this.firstPlace(agent.places) : null;
    if (!agent || !engine || !cwd) return;
    const chat = this.createChat({ title: routine.name, agentId: agent.id, engine: agent.engine, cwd });
    try {
      await this.launch({
        origin: "routine",
        engineId: agent.engine,
        binPath: engine.binPath,
        args: engine.row.args,
        cwd,
        prompt: routine.prompt,
        preamble: this.preambleFor(agent, routine.prompt),
        slug: routine.id,
        agentId: agent.id,
        routineId: routine.id,
        taskId: null,
        chatId: chat.id,
      });
    } catch {
      // The slot was attempted. Consume it so a failed start does not hot-loop.
    }
    const current = this.store.getRoutine(routine.id) ?? routine;
    this.store.writeRoutine({ ...current, lastFiredAt: scheduledAt });
  }

  private async beginAgentRun(agent: Agent, chat: ChatRecord, text: string): Promise<SendResult> {
    const engine = this.resolveEngine(agent.engine);
    if (!engine) return { ok: false, reason: "engine-missing" };
    const cwd = this.existingDir(chat.cwd) ?? this.firstPlace(agent.places);
    if (!cwd) return { ok: false, reason: "missing-place" };
    const launched = await this.launch({
      origin: "agent-chat",
      engineId: agent.engine,
      binPath: engine.binPath,
      args: engine.row.args,
      cwd,
      prompt: text,
      preamble: this.preambleFor(agent, text),
      slug: chat.id,
      agentId: agent.id,
      routineId: null,
      taskId: null,
      chatId: chat.id,
    });
    return {
      ok: true,
      startedNew: false,
      chatId: chat.id,
      runId: launched.meta.id,
      ptyId: launched.ptyId,
    };
  }

  private async beginStandaloneRun(chat: ChatRecord, text: string): Promise<SendResult> {
    const engine = this.resolveEngine(chat.engine);
    if (!engine) return { ok: false, reason: "engine-missing" };
    fs.mkdirSync(chat.cwd, { recursive: true });
    const launched = await this.launch({
      origin: "chat",
      engineId: chat.engine,
      binPath: engine.binPath,
      args: engine.row.args,
      cwd: chat.cwd,
      prompt: text,
      preamble: buildStandalonePreamble(text),
      slug: chat.id,
      agentId: null,
      routineId: null,
      taskId: null,
      chatId: chat.id,
    });
    return { ok: true, startedNew: false, chatId: chat.id, runId: launched.meta.id, ptyId: launched.ptyId };
  }

  private async launch(input: {
    origin: RunOrigin;
    engineId: string;
    binPath: string;
    args: string[];
    cwd: string;
    prompt: string;
    preamble: string;
    slug: string;
    agentId: string | null;
    routineId: string | null;
    taskId: string | null;
    chatId: string | null;
  }): Promise<{ meta: RunMeta; ptyId: string }> {
    const startedAt = this.now().toISOString();
    const preamble = withNewline(input.preamble);
    const created = createRunFiles({
      dataRoot: this.options.dataRoot,
      slug: input.slug,
      preamble,
      meta: {
        origin: input.origin,
        agentId: input.agentId,
        routineId: input.routineId,
        taskId: input.taskId,
        chatId: input.chatId,
        engine: input.engineId,
        cwd: input.cwd,
        prompt: input.prompt,
        startedAt,
        endedAt: null,
        status: "running",
        openedAt: null,
        notifiedAt: null,
      },
    });
    this.store.upsertRun(created.meta);
    try {
      const spawned = await this.options.host.spawnPty({
        cwd: input.cwd,
        argv: [input.binPath, ...input.args],
        runDir: created.dir,
        initialInput: preamble,
        runId: created.id,
      });
      this.ptyByRun.set(created.id, spawned.ptyId);
      this.runByPty.set(spawned.ptyId, created.id);
      if (input.chatId) {
        const chat = this.store.getChat(input.chatId);
        if (chat) {
          this.store.writeChat({
            ...chat,
            runId: created.id,
            ptyId: spawned.ptyId,
            cwd: input.cwd,
            updatedAt: startedAt,
          });
        }
      }
      return { meta: created.meta, ptyId: spawned.ptyId };
    } catch (error) {
      this.store.upsertRun({ ...created.meta, status: "failed", endedAt: this.now().toISOString() });
      throw error;
    }
  }

  private preambleFor(agent: Agent, prompt: string): string {
    const skills = agent.skills.flatMap((id) => {
      const raw = this.store.readSkillRaw(id);
      if (raw === null) return [];
      const skill = this.store.getSkill(id);
      return [{ name: skill?.name ?? id, body: raw }];
    });
    return buildPreamble({
      agentName: agent.name,
      places: agent.places,
      brief: agent.brief,
      memory: this.store.readMemory(agent.id),
      skills,
      prompt,
    });
  }

  private createChat(input: { title: string; agentId: string | null; engine: string; cwd: string }): ChatRecord {
    const now = this.now().toISOString();
    const chat: ChatRecord = {
      id: this.uniqueChatId(input.title),
      title: input.title,
      agentId: input.agentId,
      engine: input.engine,
      cwd: input.cwd,
      runId: null,
      ptyId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.writeChat(chat);
    return chat;
  }

  private uniqueChatId(base: string): string {
    const taken = new Set(this.store.listChats().map((chat) => chat.id));
    const root = slugify(base);
    if (!taken.has(root)) return root;
    let count = 2;
    while (taken.has(`${root}-${count}`)) count += 1;
    return `${root}-${count}`;
  }

  private resolveEngine(engineId: string): { row: EngineRow; binPath: string } | null {
    const row = this.store.readEngines().find((engine) => engine.id === engineId);
    if (!row) return null;
    const binPath = this.options.host.resolveBin(row.bin);
    if (typeof binPath !== "string" || binPath.length === 0) return null;
    return { row, binPath };
  }

  private existingDir(place: string): string | null {
    try {
      const resolved = path.resolve(place);
      return fs.statSync(resolved).isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private firstPlace(places: readonly string[]): string | null {
    for (const place of places) {
      const dir = this.existingDir(place);
      if (dir) return dir;
    }
    return null;
  }

  private routineStillRunning(routineId: string): boolean {
    for (const run of this.store.listRuns()) {
      if (run.routineId !== routineId || run.status !== "running") continue;
      const ptyId = this.ptyByRun.get(run.id);
      if (!ptyId || this.options.host.isPtyAlive(ptyId)) return true;
    }
    return false;
  }

  private routineIssues(routine: Routine): string[] {
    const agent = routine.agentId ? this.store.getAgent(routine.agentId) : null;
    if (!agent) return ["Missing agent"];
    const issues: string[] = [];
    if (agent.allowRoutines === false) issues.push("Agent disallows routines");
    const engine = this.resolveEngine(agent.engine);
    if (!engine) issues.push("Engine is not on PATH");
    if (agent.places.length === 0 || agent.places.some((place) => !this.existingDir(place))) {
      issues.push("Allowed folder is missing");
    }
    return issues;
  }
}

export function createTeamService(options: TeamServiceOptions): TeamService {
  return new TeamService(options);
}
