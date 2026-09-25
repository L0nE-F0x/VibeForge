import fs from "node:fs";
import path from "node:path";
import { planLaunch, resumeArgsFromTranscript, withAvailability } from "./engines.js";
import { isDirectory, readText, writeFileAtomic } from "./fsx.js";
import { diffSince, summarizeSnapshot } from "./vcs.js";
import { isPathInside } from "./places.js";
import { buildPreamble, plainPrompt, taskPrompt } from "./preamble.js";
import { decideRoutineTick, decideRunNow, describeSchedule, isScheduleValid, nextFireTimes, type TickDecision } from "./routines.js";
import { allocateRunDir, readRunFiles, RUN_FILES, type RunFiles } from "./runs.js";
import { slugify } from "./slug.js";
import { Store, type RunQuery } from "./store.js";
import { createTask, markStopped, requestExecute, syncTaskWithRun, type ExecuteBlocker } from "./tasks.js";
import type {
  Agent,
  ChatRecord,
  Engine,
  EngineRow,
  LayoutNode,
  LiveSession,
  Routine,
  RunMeta,
  RunOrigin,
  Schedule,
  Settings,
  Skill,
  Task,
  TaskStatus,
  Topic,
  Workspace,
} from "./types.js";
import {
  addWorkspaceRecord,
  removeWorkspaceRecord,
  selectWorkspaceRecord,
  updateWorkspaceRecord,
  type WorkspaceFile,
} from "./workspaces.js";

// ------------------------------------------------------------------ host contract

export interface SpawnRequest {
  cwd: string;
  argv: string[];
  /** Run directory the PTY host writes scrollback, the final screen, and a text transcript into. */
  runDir: string | null;
  /** Pasted once the CLI has drawn its UI and gone quiet. */
  pasteInput: string | null;
  cols?: number;
  rows?: number;
}

export interface DeskHost {
  spawn(request: SpawnRequest): Promise<{ ptyId: string; pid: number }>;
  /** Paste text into a live session and press Enter. */
  send(ptyId: string, text: string): Promise<void>;
  kill(ptyId: string): Promise<void>;
  resolveBin(bin: string): string | null;
  notify(note: { title: string; body: string; runId: string }): void;
  snapshotGit(cwd: string, startHead: string | null): Promise<string>;
  gitHead(cwd: string): Promise<string | null>;
}

export interface DeskOptions {
  configRoot: string;
  dataRoot: string;
  appStartedAt: Date;
  now: () => Date;
  host: DeskHost;
}

// ------------------------------------------------------------------ inputs and views

export interface AgentInput {
  id?: string;
  name: string;
  engine: string;
  brief: string;
  places: string[];
  skills?: string[];
  allowRoutines?: boolean;
}

export interface SkillInput {
  id?: string;
  name: string;
  description?: string;
  body?: string;
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

export interface TaskInput {
  id?: string;
  title: string;
  body?: string;
  agentId?: string | null;
  workspaceId?: string | null;
}

export interface TermSize {
  cols?: number;
  rows?: number;
}

export interface RunView extends RunMeta {
  live: boolean;
  ptyId: string | null;
}

export interface RoutineView extends Routine {
  agentName: string | null;
  issues: string[];
  stillRunning: boolean;
  description: string;
  nextFires: string[];
  lastRun: RunView | null;
}

export interface TaskView extends Task {
  lastRun: RunView | null;
  blocker: ExecuteBlocker | "engine-missing" | null;
}

export interface ChatView extends ChatRecord {
  live: boolean;
  ptyId: string | null;
  lastRun: RunView | null;
}

export interface RunBundle {
  run: RunView;
  files: RunFiles;
}

export interface Launched {
  runId: string;
  ptyId: string;
}

export interface SendResult extends Launched {
  chatId: string;
  /** True when the send started a new process instead of typing into a live one. */
  started: boolean;
  note: string | null;
}

export interface SchedulePreview {
  valid: boolean;
  description: string;
  next: string[];
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const REVIEW_ORIGINS: RunOrigin[] = ["routine", "task", "agent-chat"];

export const BLOCKER_TEXT: Record<ExecuteBlocker | "engine-missing", string> = {
  "missing-agent": "Assign an agent first.",
  "missing-workspace": "Pick a workspace first.",
  "outside-places": "That workspace is not one of the agent's allowed folders.",
  "engine-missing": "The agent's engine is not on PATH.",
};

function normalizePlaces(places: readonly string[]): string[] {
  const out: string[] = [];
  for (const place of places) {
    if (typeof place !== "string" || !place.trim()) continue;
    const resolved = path.resolve(place.trim());
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function titleFromPrompt(text: string): string {
  const line = text.trim().split("\n").find((item) => item.trim()) ?? "Chat";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
}

const DEFAULT_CHAT_TITLE = "New chat";

// ------------------------------------------------------------------ service

export class TeamService {
  private readonly options: DeskOptions;
  readonly store: Store;
  private readonly live = new Map<string, LiveSession>();
  private readonly ptyByRun = new Map<string, string>();
  private readonly listeners = new Set<(topics: Topic[]) => void>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly finishing = new Set<Promise<void>>();
  private pending = new Set<Topic>();
  private flushQueued = false;
  private readonly settled: Promise<void>;

  constructor(options: DeskOptions) {
    this.options = options;
    this.store = new Store(options.configRoot, options.dataRoot);
    // Anything still "running" in the index belongs to a process that died with the last app session.
    const orphans = this.store.queryRuns({ status: "running", limit: 2000 });
    this.settled = this.settleOrphans(orphans);
  }

  whenSettled(): Promise<void> {
    return this.settled;
  }

  now(): Date {
    return this.options.now();
  }

  close(): void {
    this.store.close();
  }

  // ---------------------------------------------------------------- events

  onChange(listener: (topics: Topic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...topics: Topic[]): void {
    for (const topic of topics) this.pending.add(topic);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const batch = [...this.pending];
      this.pending = new Set();
      if (batch.length === 0) return;
      for (const listener of this.listeners) {
        try {
          listener(batch);
        } catch {
          /* a listener failing must not break the service */
        }
      }
    });
  }

  // ---------------------------------------------------------------- settings & engines

  getSettings(): Settings {
    return this.store.readSettings();
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.store.readSettings(), ...patch };
    this.store.writeSettings(next);
    this.emit("settings");
    return this.store.readSettings();
  }

  listEngines(): Engine[] {
    return withAvailability(this.store.readEngineRows(), (bin) => this.options.host.resolveBin(bin));
  }

  saveEngines(rows: EngineRow[]): Engine[] {
    this.store.writeEngineRows(rows);
    this.emit("engines", "agents", "routines", "tasks");
    return this.listEngines();
  }

  private resolveEngine(engineId: string): { row: EngineRow; binPath: string } | null {
    const row = this.store.readEngineRows().find((engine) => engine.id === engineId);
    if (!row) return null;
    const binPath = this.options.host.resolveBin(row.bin);
    return binPath ? { row, binPath } : null;
  }

  private requireEngine(engineId: string): { row: EngineRow; binPath: string } {
    const engine = this.resolveEngine(engineId);
    if (engine) return engine;
    const row = this.store.readEngineRows().find((item) => item.id === engineId);
    throw new Error(row ? `${row.label} (${row.bin}) is not on PATH.` : `There is no engine called "${engineId}".`);
  }

  // ---------------------------------------------------------------- workspaces & layouts

  listWorkspaces(): WorkspaceFile {
    return this.store.readWorkspaces();
  }

  addWorkspace(folder: string): WorkspaceFile {
    if (!isDirectory(folder)) throw new Error("Choose a folder that exists.");
    const next = addWorkspaceRecord(this.store.readWorkspaces(), folder);
    this.store.writeWorkspaces(next);
    this.emit("workspaces");
    return next;
  }

  async removeWorkspace(id: string): Promise<WorkspaceFile> {
    for (const session of [...this.live.values()]) {
      if (session.workspaceId === id && session.origin === "code") await this.killPty(session.ptyId);
      else if (session.kind === "shell" && session.workspaceId === id) await this.killPty(session.ptyId);
    }
    const next = removeWorkspaceRecord(this.store.readWorkspaces(), id);
    this.store.writeWorkspaces(next);
    this.store.writeLayout(id, null);
    this.emit("workspaces", "tasks");
    return next;
  }

  selectWorkspace(id: string): void {
    this.store.writeWorkspaces(selectWorkspaceRecord(this.store.readWorkspaces(), id));
  }

  updateWorkspace(id: string, patch: { name?: string; dockUrl?: string }): WorkspaceFile {
    const clean: { name?: string; dockUrl?: string } = {};
    if (typeof patch.name === "string" && patch.name.trim()) clean.name = patch.name.trim();
    if (typeof patch.dockUrl === "string") {
      const url = patch.dockUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error("Enter a full URL, starting with http:// or https://");
      clean.dockUrl = url;
    }
    const next = updateWorkspaceRecord(this.store.readWorkspaces(), id, clean);
    this.store.writeWorkspaces(next);
    this.emit("workspaces");
    return next;
  }

  getLayout(workspaceId: string): LayoutNode | null {
    return this.store.readLayout(workspaceId);
  }

  saveLayout(workspaceId: string, layout: LayoutNode | null): void {
    this.store.writeLayout(workspaceId, layout);
  }

  private workspaceById(id: string | null | undefined): Workspace | null {
    if (!id) return null;
    return this.store.readWorkspaces().workspaces.find((item) => item.id === id) ?? null;
  }

  // ---------------------------------------------------------------- agents

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  getAgent(id: string): Agent | null {
    return this.store.getAgent(id);
  }

  saveAgent(input: AgentInput): Agent {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the agent a name.");
    if (!input.brief?.trim()) throw new Error("Write a brief for the agent.");
    const engineId = input.engine?.trim() ?? "";
    if (!engineId) throw new Error("Pick an engine.");
    const existing = input.id ? this.store.getAgent(input.id) : null;
    if (input.id && !existing) throw new Error("That agent no longer exists.");
    if (!existing || existing.engine !== engineId) this.requireEngine(engineId);
    const places = normalizePlaces(input.places ?? []);
    if (places.length === 0) throw new Error("Add at least one allowed folder.");
    for (const place of places) {
      if (existing?.places.includes(place)) continue;
      if (!isDirectory(place)) throw new Error(`This folder does not exist: ${place}`);
    }
    const now = this.now().toISOString();
    const agent: Agent = {
      id: existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "agents"), name, ""),
      name,
      engine: engineId,
      brief: input.brief.trimEnd(),
      memoryFile: "memory.md",
      places,
      skills: input.skills ? input.skills.filter((id) => this.store.getSkill(id)) : (existing?.skills ?? []),
      allowRoutines: typeof input.allowRoutines === "boolean" ? input.allowRoutines : (existing?.allowRoutines ?? true),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.store.writeAgent(agent);
    this.emit("agents", "routines", "tasks");
    return agent;
  }

  deleteAgent(id: string, confirmName: string): void {
    const agent = this.store.getAgent(id);
    if (!agent) throw new Error("That agent no longer exists.");
    if (confirmName.trim() !== agent.name) throw new Error("Type the agent's name exactly to delete it.");
    this.store.deleteAgent(id);
    this.emit("agents", "routines", "tasks", "chats");
  }

  readMemory(agentId: string): string {
    if (!this.store.getAgent(agentId)) throw new Error("That agent no longer exists.");
    return this.store.readMemory(agentId);
  }

  writeMemory(agentId: string, text: string): void {
    if (!this.store.getAgent(agentId)) throw new Error("That agent no longer exists.");
    this.store.writeMemory(agentId, text);
    this.emit("agents");
  }

  // ---------------------------------------------------------------- skills

  listSkills(): Skill[] {
    return this.store.listSkills();
  }

  saveSkill(input: SkillInput): Skill {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the skill a name.");
    const existing = input.id ? this.store.getSkill(input.id) : null;
    const skill: Skill = {
      id: existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "skills"), name, ""),
      name,
      description: (input.description ?? existing?.description ?? "").trim(),
      body: input.body ?? existing?.body ?? "",
    };
    this.store.writeSkill(skill);
    this.emit("skills");
    return skill;
  }

  deleteSkill(id: string): void {
    this.store.deleteSkill(id);
    this.setSkillAgents(id, []);
    this.emit("skills", "agents");
  }

  setSkillAgents(skillId: string, agentIds: string[]): void {
    const now = this.now().toISOString();
    for (const agent of this.store.listAgents()) {
      const has = agent.skills.includes(skillId);
      const want = agentIds.includes(agent.id);
      if (has === want) continue;
      const skills = want ? [...agent.skills, skillId] : agent.skills.filter((id) => id !== skillId);
      this.store.writeAgent({ ...agent, skills, updatedAt: now });
    }
    this.emit("agents", "skills");
  }

  // ---------------------------------------------------------------- routines

  listRoutines(): RoutineView[] {
    const now = this.now();
    return this.store.listRoutines().map((routine) => {
      const agent = routine.agentId ? this.store.getAgent(routine.agentId) : null;
      const last = this.store.queryRuns({ routineId: routine.id, limit: 1 })[0] ?? null;
      return {
        ...routine,
        agentName: agent?.name ?? null,
        issues: this.routineIssues(routine, agent),
        stillRunning: this.routineStillRunning(routine.id),
        description: describeSchedule(routine.schedule),
        nextFires: routine.enabled ? nextFireTimes(routine.schedule, now, 3).map((date) => date.toISOString()) : [],
        lastRun: last ? this.view(last) : null,
      };
    });
  }

  previewSchedule(schedule: Schedule): SchedulePreview {
    const valid = isScheduleValid(schedule);
    return {
      valid,
      description: describeSchedule(schedule),
      next: valid ? nextFireTimes(schedule, this.now(), 3).map((date) => date.toISOString()) : [],
    };
  }

  saveRoutine(input: RoutineInput): Routine {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the routine a name.");
    if (!input.agentId?.trim() || !this.store.getAgent(input.agentId)) throw new Error("Pick an agent for the routine.");
    const schedule: Schedule =
      input.schedule?.kind === "cron"
        ? { kind: "cron", expr: input.schedule.expr.trim().replace(/\s+/g, " ") }
        : { kind: "every", minutes: Math.round(Number(input.schedule?.minutes)) };
    if (!isScheduleValid(schedule)) {
      throw new Error(schedule.kind === "cron" ? "That cron expression is not valid (five fields, local time)." : "Intervals must be at least 5 minutes.");
    }
    if (!input.prompt?.trim()) throw new Error("Write the routine's prompt.");
    const existing = input.id ? this.store.getRoutine(input.id) : null;
    const routine: Routine = {
      id: existing?.id ?? this.store.uniqueId(path.join(this.options.configRoot, "routines"), name, ".yaml"),
      name,
      agentId: input.agentId,
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      schedule,
      prompt: input.prompt.trimEnd(),
      notify: typeof input.notify === "boolean" ? input.notify : (existing?.notify ?? true),
      lastFiredAt: existing?.lastFiredAt ?? null,
      lastMissedAt: existing?.lastMissedAt ?? null,
    };
    // A new or rescheduled routine starts counting from now, not from a slot in the past.
    const scheduleChanged = !existing || JSON.stringify(existing.schedule) !== JSON.stringify(schedule);
    if (scheduleChanged) {
      routine.lastFiredAt = this.now().toISOString();
      routine.lastMissedAt = null;
    }
    this.store.writeRoutine(routine);
    this.emit("routines");
    return routine;
  }

  deleteRoutine(id: string): void {
    this.store.deleteRoutine(id);
    this.emit("routines");
  }

  setRoutineEnabled(id: string, enabled: boolean): Routine {
    const routine = this.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    // Resuming does not replay the slots that passed while it was paused.
    const next = { ...routine, enabled, ...(enabled && !routine.enabled ? { lastFiredAt: this.now().toISOString() } : {}) };
    this.store.writeRoutine(next);
    this.emit("routines");
    return next;
  }

  async runRoutineNow(id: string, size: TermSize = {}): Promise<Launched> {
    await this.settled;
    const routine = this.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    const agent = this.store.getAgent(routine.agentId);
    if (!agent) throw new Error("The routine's agent no longer exists.");
    const engine = this.resolveEngine(agent.engine);
    const decision = decideRunNow({
      allowRoutines: agent.allowRoutines,
      engineAvailable: Boolean(engine),
      previousStillRunning: this.routineStillRunning(routine.id),
    });
    if (!decision.ok) {
      throw new Error(
        decision.reason === "disallowed"
          ? `${agent.name} does not allow routines. Turn it on in the agent's settings.`
          : decision.reason === "engine-missing"
            ? this.engineMissingText(agent.engine)
            : "The previous run of this routine is still going.",
      );
    }
    return this.launchRoutine(routine, agent, size);
  }

  async tick(now: Date = this.now()): Promise<Array<{ routineId: string; decision: TickDecision }>> {
    await this.settled;
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
        if (routine.lastMissedAt !== decision.scheduledAt) {
          this.store.writeRoutine({ ...routine, lastMissedAt: decision.scheduledAt, lastFiredAt: decision.scheduledAt });
          this.emit("routines");
        }
      } else if (decision.action === "fire" && agent) {
        // Consume the slot first so a failed start never hot-loops on every tick.
        this.store.writeRoutine({ ...routine, lastFiredAt: decision.scheduledAt });
        try {
          await this.launchRoutine(routine, agent, {});
        } catch {
          /* the failed run is recorded in the run index */
        }
        this.emit("routines");
      }
    }
    return results;
  }

  private async launchRoutine(routine: Routine, agent: Agent, size: TermSize): Promise<Launched> {
    const cwd = this.firstPlace(agent.places);
    if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
    const engine = this.requireEngine(agent.engine);
    return this.launch({
      origin: "routine",
      title: `${agent.name} · ${routine.name}`,
      engine,
      cwd,
      prompt: routine.prompt,
      promptText: this.preambleFor(agent, routine.prompt),
      agentId: agent.id,
      routineId: routine.id,
      ...size,
    });
  }

  private routineStillRunning(routineId: string): boolean {
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (run?.routineId === routineId) return true;
    }
    return false;
  }

  private routineIssues(routine: Routine, agent: Agent | null): string[] {
    if (!agent) return ["The agent for this routine is gone."];
    const issues: string[] = [];
    if (!agent.allowRoutines) issues.push(`${agent.name} does not allow routines.`);
    if (!this.resolveEngine(agent.engine)) issues.push(this.engineMissingText(agent.engine));
    if (!this.firstPlace(agent.places)) issues.push("None of the agent's allowed folders exist.");
    if (!isScheduleValid(routine.schedule)) issues.push("The schedule is not valid.");
    return issues;
  }

  private engineMissingText(engineId: string): string {
    const row = this.store.readEngineRows().find((item) => item.id === engineId);
    return row ? `${row.label} (${row.bin}) is not on PATH.` : `The engine "${engineId}" is not configured.`;
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): TaskView[] {
    return this.store.listTasks().map((task) => this.taskView(task));
  }

  private taskView(task: Task): TaskView {
    const lastId = task.runIds[task.runIds.length - 1];
    const last = lastId ? this.store.getRun(lastId) : null;
    return { ...task, lastRun: last ? this.view(last) : null, blocker: this.taskBlocker(task) };
  }

  private taskBlocker(task: Task): TaskView["blocker"] {
    const agent = task.agentId ? this.store.getAgent(task.agentId) : null;
    const workspace = this.workspaceById(task.workspaceId);
    const decision = requestExecute(task, {
      hasAgent: Boolean(agent),
      workspacePath: workspace?.path ?? "",
      agentPlaces: agent?.places ?? [],
    });
    if (!decision.ok) return decision.reason;
    if (agent && !this.resolveEngine(agent.engine)) return "engine-missing";
    return null;
  }

  saveTask(input: TaskInput): TaskView {
    const title = input.title?.trim() ?? "";
    if (!title) throw new Error("Give the task a title.");
    const now = this.now();
    const existing = input.id ? this.store.getTask(input.id) : null;
    const task: Task = existing
      ? {
          ...existing,
          title,
          body: input.body ?? existing.body,
          agentId: input.agentId === undefined ? existing.agentId : input.agentId || null,
          workspaceId: input.workspaceId === undefined ? existing.workspaceId : input.workspaceId || null,
          updatedAt: now.toISOString(),
        }
      : createTask({ title, body: input.body, agentId: input.agentId || null, workspaceId: input.workspaceId || null, now });
    this.store.writeTask(task);
    this.emit("tasks");
    return this.taskView(task);
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.getTask(id);
    if (!task) return;
    if (task.status === "running") await this.stopTask(id);
    this.store.deleteTask(id);
    this.emit("tasks");
  }

  async executeTask(id: string, size: TermSize = {}, continueSession = false): Promise<Launched> {
    const task = this.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (task.status === "running" && this.taskLive(task)) throw new Error("This task is already running.");
    const blocker = this.taskBlocker(task);
    if (blocker) throw new Error(BLOCKER_TEXT[blocker]);
    const agent = this.store.getAgent(task.agentId!)!;
    const workspace = this.workspaceById(task.workspaceId)!;
    const engine = this.requireEngine(agent.engine);
    const prompt = taskPrompt(task.title, task.body);
    const previous = task.runIds[task.runIds.length - 1] ? this.store.getRun(task.runIds[task.runIds.length - 1]) : null;
    const resume = continueSession ? this.resumePlan(engine.row, previous) : { native: false, resumeArgs: null };
    const canContinue = resume.native;
    const prior = continueSession && previous && !canContinue ? this.transcriptPath(previous) : null;
    const launched = await this.launch({
      origin: "task",
      title: task.title,
      engine,
      cwd: workspace.path,
      prompt,
      promptText: canContinue ? null : this.preambleFor(agent, prompt, prior),
      continueSession: canContinue,
      resumeArgs: resume.resumeArgs,
      agentId: agent.id,
      taskId: task.id,
      workspaceId: workspace.id,
      continuedFrom: continueSession && previous ? previous.id : null,
      ...size,
    });
    const current = this.store.getTask(id) ?? task;
    this.store.writeTask({
      ...current,
      status: "running",
      runIds: [...current.runIds, launched.runId],
      updatedAt: this.now().toISOString(),
    });
    this.emit("tasks");
    return launched;
  }

  async stopTask(id: string): Promise<TaskView> {
    const task = this.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    const runId = task.runIds[task.runIds.length - 1];
    if (runId) await this.stopRun(runId);
    const next = { ...markStopped(this.store.getTask(id) ?? task), updatedAt: this.now().toISOString() };
    this.store.writeTask(next);
    this.emit("tasks");
    return this.taskView(next);
  }

  setTaskStatus(id: string, status: TaskStatus): TaskView {
    const task = this.store.getTask(id);
    if (!task) throw new Error("That task no longer exists.");
    if (status === "running") throw new Error("Use Execute to run a task.");
    if (task.status === "running" && this.taskLive(task)) throw new Error("Stop the task before moving it.");
    const next = { ...task, status, updatedAt: this.now().toISOString() };
    this.store.writeTask(next);
    this.emit("tasks");
    return this.taskView(next);
  }

  private taskLive(task: Task): boolean {
    const runId = task.runIds[task.runIds.length - 1];
    return Boolean(runId && this.ptyByRun.has(runId));
  }

  // ---------------------------------------------------------------- chats

  listChats(filter: { agentId?: string | null } = {}): ChatView[] {
    return this.store
      .listChats()
      .filter((chat) => (filter.agentId === undefined ? true : chat.agentId === filter.agentId))
      .map((chat) => this.chatView(chat));
  }

  private chatView(chat: ChatRecord): ChatView {
    const lastId = chat.runIds[chat.runIds.length - 1];
    const last = lastId ? this.store.getRun(lastId) : null;
    const ptyId = lastId ? (this.ptyByRun.get(lastId) ?? null) : null;
    return { ...chat, live: Boolean(ptyId), ptyId, lastRun: last ? this.view(last) : null };
  }

  createChat(input: { agentId?: string | null; engine?: string }): ChatView {
    const now = this.now().toISOString();
    if (input.agentId) {
      const agent = this.store.getAgent(input.agentId);
      if (!agent) throw new Error("That agent no longer exists.");
      const cwd = this.firstPlace(agent.places);
      if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
      const chat: ChatRecord = {
        id: this.uniqueChatId(`${agent.id}-chat`),
        title: DEFAULT_CHAT_TITLE,
        agentId: agent.id,
        engine: agent.engine,
        cwd,
        runIds: [],
        createdAt: now,
        updatedAt: now,
      };
      this.store.writeChat(chat);
      this.emit("chats");
      return this.chatView(chat);
    }
    const engineId = input.engine?.trim() || this.store.readSettings().defaultEngine;
    this.requireEngine(engineId);
    const id = this.uniqueChatId("chat");
    const chat: ChatRecord = {
      id,
      title: DEFAULT_CHAT_TITLE,
      agentId: null,
      engine: engineId,
      cwd: path.join(this.options.dataRoot, "scratch", id),
      runIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.writeChat(chat);
    this.emit("chats");
    return this.chatView(chat);
  }

  renameChat(id: string, title: string): ChatView {
    const chat = this.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    const next = { ...chat, title: title.trim() || chat.title, updatedAt: this.now().toISOString() };
    this.store.writeChat(next);
    this.emit("chats");
    return this.chatView(next);
  }

  setChatEngine(id: string, engineId: string): ChatView {
    const chat = this.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.agentId) throw new Error("An agent chat uses the agent's engine.");
    this.requireEngine(engineId);
    const next = { ...chat, engine: engineId, updatedAt: this.now().toISOString() };
    this.store.writeChat(next);
    this.emit("chats");
    return this.chatView(next);
  }

  async deleteChat(id: string): Promise<void> {
    const chat = this.store.getChat(id);
    if (!chat) return;
    for (const runId of chat.runIds) {
      const ptyId = this.ptyByRun.get(runId);
      if (!ptyId) continue;
      const exited = this.waitForExit(ptyId, 6000);
      await this.stopRun(runId);
      await exited;
    }
    const scratchRoot = path.join(this.options.dataRoot, "scratch");
    if (!chat.agentId && chat.cwd && isPathInside(scratchRoot, chat.cwd) && path.resolve(chat.cwd) !== path.resolve(scratchRoot)) {
      fs.rmSync(chat.cwd, { recursive: true, force: true });
    }
    for (const runId of chat.runIds) {
      const run = this.store.getRun(runId);
      if (!run) continue;
      this.store.deleteRunFile(run, "scrollback");
      this.store.deleteRunFile(run, "screen");
      this.store.deleteRunFile(run, "transcript");
    }
    this.store.deleteChat(id);
    this.emit("chats", "runs");
  }

  /**
   * Send text to a chat. A live session gets it pasted in; an empty chat starts the engine with it;
   * an ended chat continues the engine's session and pastes the text once it is ready.
   */
  async sendChat(id: string, text: string, size: TermSize = {}): Promise<SendResult> {
    if (!text.trim()) throw new Error("Type something to send.");
    await this.settled;
    let chat = this.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.title === DEFAULT_CHAT_TITLE) {
      chat = { ...chat, title: titleFromPrompt(text) };
      this.store.writeChat(chat);
    }
    const lastId = chat.runIds[chat.runIds.length - 1];
    const livePty = lastId ? this.ptyByRun.get(lastId) : undefined;
    if (lastId && livePty) {
      await this.options.host.send(livePty, text);
      this.store.writeChat({ ...chat, updatedAt: this.now().toISOString() });
      this.emit("chats");
      return { chatId: chat.id, runId: lastId, ptyId: livePty, started: false, note: null };
    }
    if (!lastId) {
      const launched = await this.startChatRun(chat, { prompt: text, continueSession: false, size });
      return { ...launched, chatId: chat.id, started: true, note: null };
    }
    const launched = await this.startChatRun(chat, { prompt: text, continueSession: true, size });
    return { ...launched, chatId: chat.id, started: true, note: "The last session had ended, so VibeForge picked it up again." };
  }

  /** Reopen the engine's latest session for this chat, with no new prompt. */
  async continueChat(id: string, size: TermSize = {}): Promise<SendResult> {
    const chat = this.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    const lastId = chat.runIds[chat.runIds.length - 1];
    const livePty = lastId ? this.ptyByRun.get(lastId) : undefined;
    if (lastId && livePty) return { chatId: chat.id, runId: lastId, ptyId: livePty, started: false, note: null };
    const launched = await this.startChatRun(chat, { prompt: null, continueSession: Boolean(lastId), size });
    return { ...launched, chatId: chat.id, started: true, note: null };
  }

  async stopChat(id: string): Promise<void> {
    const chat = this.store.getChat(id);
    const lastId = chat?.runIds[chat.runIds.length - 1];
    if (lastId) await this.stopRun(lastId);
  }

  private async startChatRun(
    chat: ChatRecord,
    opts: { prompt: string | null; continueSession: boolean; size: TermSize },
  ): Promise<Launched> {
    const agent = chat.agentId ? this.store.getAgent(chat.agentId) : null;
    if (chat.agentId && !agent) throw new Error("This chat's agent no longer exists.");
    const engine = this.requireEngine(agent ? agent.engine : chat.engine);
    const previous = opts.continueSession ? this.store.getRun(chat.runIds[chat.runIds.length - 1] ?? "") : null;
    const resume = this.resumePlan(engine.row, previous);
    const nativeContinue = resume.native;
    const prior = previous && !nativeContinue ? this.transcriptPath(previous) : null;
    let cwd = chat.cwd;
    if (agent) cwd = isDirectory(chat.cwd) && agent.places.some((place) => isPathInside(place, chat.cwd)) ? chat.cwd : (this.firstPlace(agent.places) ?? "");
    if (!cwd) throw new Error("The chat's folder is gone.");
    if (!agent) fs.mkdirSync(cwd, { recursive: true });
    let promptText: string | null = null;
    let pasteAfterContinue: string | null = null;
    if (nativeContinue) {
      pasteAfterContinue = opts.prompt;
    } else if (agent) {
      const fallback = previous ? "Continue where the previous attempt stopped." : "Read this, then wait for my first instruction.";
      promptText = this.preambleFor(agent, opts.prompt ?? fallback, prior);
    } else if (opts.prompt || prior) {
      promptText = plainPrompt(opts.prompt ?? "Continue where we left off.", prior);
    }
    return this.launch({
      origin: agent ? "agent-chat" : "chat",
      title: agent ? `${agent.name} · ${chat.title}` : chat.title,
      engine,
      cwd,
      prompt: opts.prompt ?? "",
      promptText,
      pasteAfter: pasteAfterContinue,
      continueSession: nativeContinue,
      resumeArgs: resume.resumeArgs,
      agentId: agent?.id ?? null,
      chatId: chat.id,
      continuedFrom: previous?.id ?? null,
      ...opts.size,
    });
  }

  private uniqueChatId(base: string): string {
    const taken = new Set(this.store.listChats().map((chat) => chat.id));
    const root = slugify(base, 40);
    if (!taken.has(root)) return root;
    let count = 2;
    while (taken.has(`${root}-${count}`)) count += 1;
    return `${root}-${count}`;
  }

  // ---------------------------------------------------------------- code mode

  async startShell(opts: { workspaceId?: string; cwd?: string } & TermSize): Promise<{ ptyId: string }> {
    const workspace = this.workspaceById(opts.workspaceId);
    const cwd = workspace?.path ?? opts.cwd ?? "";
    if (!isDirectory(cwd)) throw new Error("That folder does not exist any more.");
    const shell = this.store.readSettings().defaultShell || process.env.SHELL || "/bin/bash";
    const spawned = await this.options.host.spawn({ cwd, argv: [shell], runDir: null, pasteInput: null, cols: opts.cols, rows: opts.rows });
    this.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: null,
      kind: "shell",
      title: path.basename(shell),
      cwd,
      pid: spawned.pid,
      startedAt: this.now().toISOString(),
      origin: null,
      agentId: null,
      chatId: null,
      taskId: null,
      workspaceId: workspace?.id ?? null,
    });
    this.emit("live");
    return { ptyId: spawned.ptyId };
  }

  /** A one-off command in a terminal (the self-update), listed with the live sessions. */
  async startCommand(opts: { command: string; title: string; cwd: string } & TermSize): Promise<{ ptyId: string }> {
    if (!isDirectory(opts.cwd)) throw new Error("That folder does not exist any more.");
    const spawned = await this.options.host.spawn({ cwd: opts.cwd, argv: ["/bin/bash", "-c", opts.command], runDir: null, pasteInput: null, cols: opts.cols, rows: opts.rows });
    this.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: null,
      kind: "shell",
      title: opts.title,
      cwd: opts.cwd,
      pid: spawned.pid,
      startedAt: this.now().toISOString(),
      origin: null,
      agentId: null,
      chatId: null,
      taskId: null,
      workspaceId: null,
    });
    this.emit("live");
    return { ptyId: spawned.ptyId };
  }

  async startEngine(opts: { workspaceId: string; engineId: string; prompt?: string; continueSession?: boolean } & TermSize): Promise<Launched> {
    const workspace = this.workspaceById(opts.workspaceId);
    if (!workspace) throw new Error("Open a workspace first.");
    if (!isDirectory(workspace.path)) throw new Error(`The workspace folder is gone: ${workspace.path}`);
    const engine = this.requireEngine(opts.engineId);
    const prompt = opts.prompt?.trim() ?? "";
    const previous = opts.continueSession
      ? (this.store.queryRuns({ origin: "code", workspaceId: workspace.id, limit: 50 }).find((run) => run.engine === engine.row.id && run.status !== "running") ?? null)
      : null;
    const resume = opts.continueSession ? this.resumePlan(engine.row, previous) : { native: false, resumeArgs: null };
    return this.launch({
      origin: "code",
      title: `${engine.row.label} · ${workspace.name}`,
      engine,
      cwd: workspace.path,
      prompt,
      promptText: prompt || null,
      continueSession: Boolean(opts.continueSession && (resume.resumeArgs || engine.row.continueArgs?.length)),
      resumeArgs: resume.resumeArgs,
      workspaceId: workspace.id,
      continuedFrom: previous?.id ?? null,
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  // ---------------------------------------------------------------- runs

  private view(run: RunMeta): RunView {
    const ptyId = this.ptyByRun.get(run.id) ?? null;
    return { ...run, live: Boolean(ptyId), ptyId };
  }

  listRuns(query: RunQuery = {}): RunView[] {
    return this.store.queryRuns(query).map((run) => this.view(run));
  }

  inbox(now: Date = this.now()): RunView[] {
    return this.listRuns({
      status: ["exited", "stopped", "failed"],
      unopened: true,
      origin: REVIEW_ORIGINS,
      since: new Date(now.getTime() - TWO_DAYS_MS).toISOString(),
    });
  }

  getRun(id: string): RunBundle {
    const run = this.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    const files: RunFiles = run.dir && isDirectory(run.dir)
      ? readRunFiles(run.dir)
      : { preamble: "", screen: "", scrollback: "", transcript: "", git: "" };
    return { run: this.view(run), files };
  }

  markRunOpened(id: string, opened = true): void {
    const run = this.store.getRun(id);
    if (!run) return;
    if (opened && (run.openedAt || run.status === "running")) return;
    this.store.saveRun({ ...run, openedAt: opened ? this.now().toISOString() : null });
    this.emit("runs");
  }

  markAllOpened(): void {
    const now = this.now().toISOString();
    for (const run of this.inbox()) this.store.saveRun({ ...run, openedAt: now });
    this.emit("runs");
  }

  async stopRun(id: string): Promise<void> {
    const run = this.store.getRun(id);
    if (!run || run.status !== "running") return;
    const ptyId = this.ptyByRun.get(id);
    this.store.saveRun({ ...run, stopRequested: true });
    if (ptyId) {
      await this.options.host.kill(ptyId);
      return;
    }
    await this.finishRun(run.id, { exitCode: null, signal: null, status: "stopped" });
  }

  /** Start the next attempt of a finished run, in the same place it belongs to. */
  async continueRun(id: string, size: TermSize = {}): Promise<Launched & { chatId: string | null; taskId: string | null }> {
    const run = this.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    const livePty = this.ptyByRun.get(id);
    if (livePty) return { runId: id, ptyId: livePty, chatId: run.chatId, taskId: run.taskId };
    if (run.chatId && this.store.getChat(run.chatId)) {
      const result = await this.continueChat(run.chatId, size);
      return { runId: result.runId, ptyId: result.ptyId, chatId: run.chatId, taskId: null };
    }
    if (run.taskId && this.store.getTask(run.taskId)) {
      const launched = await this.executeTask(run.taskId, size, true);
      return { ...launched, chatId: null, taskId: run.taskId };
    }
    const engine = this.requireEngine(run.engine);
    const resume = this.resumePlan(engine.row, run);
    const nativeContinue = resume.native;
    const agent = run.agentId ? this.store.getAgent(run.agentId) : null;
    const prior = nativeContinue ? null : this.transcriptPath(run);
    const followUp = "Continue where the previous attempt stopped.";
    const launched = await this.launch({
      origin: run.origin,
      title: run.title,
      engine,
      cwd: run.cwd,
      prompt: run.prompt,
      promptText: nativeContinue ? null : agent ? this.preambleFor(agent, run.prompt || followUp, prior) : plainPrompt(run.prompt || followUp, prior),
      continueSession: nativeContinue,
      resumeArgs: resume.resumeArgs,
      agentId: run.agentId,
      routineId: run.routineId,
      workspaceId: run.workspaceId,
      continuedFrom: run.id,
      ...size,
    });
    return { ...launched, chatId: null, taskId: null };
  }

  async runDiff(id: string): Promise<string> {
    const run = this.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    return diffSince(run.cwd, run.gitStart);
  }

  /**
   * How to pick a finished session back up with the same engine: its exact session id when the
   * CLI printed one, the engine's continue flag otherwise, or not at all.
   */
  private resumePlan(row: EngineRow, previous: RunMeta | null): { native: boolean; resumeArgs: string[] | null } {
    // A different CLI cannot pick up another CLI's session; start fresh with the transcript instead.
    if (!previous || previous.engine !== row.id) return { native: false, resumeArgs: null };
    if (previous.dir) {
      const resumeArgs = resumeArgsFromTranscript(row, readText(path.join(previous.dir, RUN_FILES.transcript)));
      if (resumeArgs) return { native: true, resumeArgs };
    }
    return { native: Boolean(row.continueArgs?.length), resumeArgs: null };
  }

  private transcriptPath(run: RunMeta): string | null {
    if (!run.dir) return null;
    for (const file of [RUN_FILES.transcript, RUN_FILES.scrollback]) {
      const full = path.join(run.dir, file);
      try {
        if (fs.statSync(full).size > 0) return full;
      } catch {
        /* try the next file */
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- live sessions

  listLive(): LiveSession[] {
    return [...this.live.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  liveCount(): number {
    return this.live.size;
  }

  /** Close a terminal. A run is stopped (and keeps its transcript); a shell just ends. */
  async killPty(ptyId: string): Promise<void> {
    const session = this.live.get(ptyId);
    if (session?.runId) {
      await this.stopRun(session.runId);
      return;
    }
    await this.options.host.kill(ptyId);
  }

  isLive(ptyId: string): boolean {
    return this.live.has(ptyId);
  }

  /** Resolves once the PTY has exited and its run is finished, or after the timeout. */
  waitForExit(ptyId: string, timeoutMs: number): Promise<void> {
    if (!this.live.has(ptyId)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.exitWaiters.get(ptyId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.exitWaiters.set(ptyId, list);
    });
  }

  // ---------------------------------------------------------------- launching

  private preambleFor(agent: Agent, prompt: string, priorTranscript: string | null = null): string {
    const skills = agent.skills.flatMap((id) => {
      const skill = this.store.getSkill(id);
      return skill ? [{ name: skill.name, body: skill.body }] : [];
    });
    return buildPreamble({
      agentName: agent.name,
      places: agent.places,
      brief: agent.brief,
      memory: this.store.readMemory(agent.id),
      skills,
      prompt,
      priorTranscript,
    });
  }

  private async launch(input: {
    origin: RunOrigin;
    title: string;
    engine: { row: EngineRow; binPath: string };
    cwd: string;
    /** What the human asked for, kept for the record. */
    prompt: string;
    /** What reaches the CLI as its first message: a preamble, the plain prompt, or nothing. */
    promptText: string | null;
    /** Text pasted after a continued session loads. */
    pasteAfter?: string | null;
    continueSession?: boolean;
    /** The exact session to reopen, read from the previous run's transcript. */
    resumeArgs?: string[] | null;
    agentId?: string | null;
    routineId?: string | null;
    taskId?: string | null;
    chatId?: string | null;
    workspaceId?: string | null;
    continuedFrom?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<Launched> {
    const started = this.now();
    const { id, dir } = allocateRunDir(this.options.dataRoot, started, input.title);
    const preamblePath = path.join(dir, RUN_FILES.preamble);
    writeFileAtomic(preamblePath, input.promptText ?? "");
    const plan = planLaunch(input.engine.row, input.engine.binPath, {
      prompt: input.promptText,
      continueSession: input.continueSession,
      resumeArgs: input.resumeArgs,
      promptFile: preamblePath,
    });
    const pasteInput = plan.pasteInput ?? input.pasteAfter ?? null;
    let gitStart: string | null = null;
    try {
      gitStart = await this.options.host.gitHead(input.cwd);
    } catch {
      gitStart = null;
    }
    const meta: RunMeta = {
      id,
      origin: input.origin,
      title: input.title,
      agentId: input.agentId ?? null,
      routineId: input.routineId ?? null,
      taskId: input.taskId ?? null,
      chatId: input.chatId ?? null,
      workspaceId: input.workspaceId ?? null,
      engine: input.engine.row.id,
      argv: plan.argv.map((arg) => (input.promptText && arg.includes(input.promptText) ? "{prompt}" : arg)),
      cwd: input.cwd,
      prompt: input.prompt,
      startedAt: started.toISOString(),
      endedAt: null,
      status: "running",
      exitCode: null,
      signal: null,
      stopRequested: false,
      openedAt: null,
      notifiedAt: null,
      dir,
      error: null,
      changes: null,
      gitStart,
      continuedFrom: input.continuedFrom ?? null,
    };
    this.store.saveRun(meta);
    let spawned: { ptyId: string; pid: number };
    try {
      spawned = await this.options.host.spawn({
        cwd: input.cwd,
        argv: plan.argv,
        runDir: dir,
        pasteInput,
        cols: input.cols,
        rows: input.rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveRun({ ...meta, status: "failed", endedAt: this.now().toISOString(), error: message });
      this.emit("runs");
      throw new Error(`Could not start ${input.engine.row.label}: ${message}`);
    }
    this.ptyByRun.set(id, spawned.ptyId);
    this.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: id,
      kind: "run",
      title: input.title,
      cwd: input.cwd,
      pid: spawned.pid,
      startedAt: meta.startedAt,
      origin: input.origin,
      agentId: meta.agentId,
      chatId: meta.chatId,
      taskId: meta.taskId,
      workspaceId: meta.workspaceId,
    });
    if (input.chatId) {
      const chat = this.store.getChat(input.chatId);
      if (chat) {
        this.store.writeChat({ ...chat, runIds: [...chat.runIds, id], cwd: input.cwd, updatedAt: meta.startedAt });
      }
    }
    this.emit("runs", "live", "chats", "routines", "tasks");
    return { runId: id, ptyId: spawned.ptyId };
  }

  // ---------------------------------------------------------------- exits

  async onPtyExit(ptyId: string, exitCode: number | null, signal: number | null): Promise<void> {
    const session = this.live.get(ptyId);
    this.live.delete(ptyId);
    try {
      if (!session?.runId) {
        this.emit("live");
        return;
      }
      this.ptyByRun.delete(session.runId);
      const run = this.store.getRun(session.runId);
      const done = this.finishRun(session.runId, { exitCode, signal, status: run?.stopRequested ? "stopped" : "exited" });
      this.finishing.add(done);
      try {
        await done;
      } finally {
        this.finishing.delete(done);
      }
    } finally {
      const waiters = this.exitWaiters.get(ptyId) ?? [];
      this.exitWaiters.delete(ptyId);
      for (const wake of waiters) wake();
    }
  }

  private async finishRun(
    runId: string,
    outcome: { exitCode: number | null; signal: number | null; status: "exited" | "stopped" },
  ): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    let git = "";
    try {
      git = await this.options.host.snapshotGit(run.cwd, run.gitStart);
    } catch {
      git = "not a git repo\n";
    }
    if (run.dir && isDirectory(run.dir)) {
      try {
        writeFileAtomic(path.join(run.dir, RUN_FILES.git), git.endsWith("\n") ? git : `${git}\n`);
      } catch {
        /* the run folder can vanish if the human deletes it */
      }
    }
    const latest = this.store.getRun(runId) ?? run;
    const finished = this.store.saveRun({
      ...latest,
      status: latest.stopRequested ? "stopped" : outcome.status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      endedAt: this.now().toISOString(),
      changes: summarizeSnapshot(git),
    });
    if (finished.taskId) {
      const task = this.store.getTask(finished.taskId);
      if (task && task.runIds[task.runIds.length - 1] === finished.id) {
        const status = syncTaskWithRun(task, finished.status);
        if (status !== task.status) this.store.writeTask({ ...task, status, updatedAt: this.now().toISOString() });
      }
    }
    this.notifyFinished(finished);
    this.emit("runs", "live", "tasks", "chats", "routines");
  }

  private notifyFinished(run: RunMeta): void {
    if (run.notifiedAt) return;
    if (run.origin !== "routine" && run.origin !== "task") return;
    const settings = this.store.readSettings();
    if (!settings.notify) return;
    if (run.origin === "routine") {
      const routine = run.routineId ? this.store.getRoutine(run.routineId) : null;
      if (routine && !routine.notify) return;
    }
    const outcome =
      run.status === "stopped"
        ? "stopped"
        : run.exitCode && run.exitCode !== 0
          ? `exited with code ${run.exitCode}`
          : "finished";
    try {
      this.options.host.notify({
        title: run.title,
        body: [outcome, run.changes].filter(Boolean).join(" · "),
        runId: run.id,
      });
    } catch {
      return;
    }
    this.store.saveRun({ ...run, notifiedAt: this.now().toISOString() });
  }

  private async settleOrphans(orphans: RunMeta[]): Promise<void> {
    for (const run of orphans) {
      const hasGit = run.dir ? fs.existsSync(path.join(run.dir, RUN_FILES.git)) : true;
      let changes = run.changes;
      if (!hasGit && run.cwd && run.dir && isDirectory(run.dir)) {
        let git = "not a git repo\n";
        try {
          git = await this.options.host.snapshotGit(run.cwd, run.gitStart);
        } catch {
          git = "not a git repo\n";
        }
        try {
          writeFileAtomic(path.join(run.dir, RUN_FILES.git), git);
        } catch {
          /* the folder can disappear */
        }
        changes = summarizeSnapshot(git);
      }
      this.store.saveRun({
        ...run,
        status: "stopped",
        endedAt: run.endedAt ?? this.now().toISOString(),
        error: run.error ?? "VibeForge closed while this run was going.",
        changes,
      });
      if (run.taskId) {
        const task = this.store.getTask(run.taskId);
        if (task?.status === "running") this.store.writeTask({ ...task, status: "review" });
      }
    }
    if (orphans.length) this.emit("runs", "tasks");
  }

  /** Before the app quits: mark every live run as stopped on purpose, so its exit records "stopped". */
  prepareShutdown(): void {
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (run && run.status === "running" && !run.stopRequested) this.store.saveRun({ ...run, stopRequested: true });
    }
  }

  /** Resolves when every exit already reported has finished writing its run. */
  async whenIdle(): Promise<void> {
    while (this.finishing.size) await Promise.allSettled([...this.finishing]);
  }

  /** Last step before quitting: anything the PTY host never reported is recorded as stopped now. */
  shutdown(): string[] {
    const ended = this.now().toISOString();
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (!run || run.status !== "running") continue;
      this.store.saveRun({ ...run, status: "stopped", stopRequested: true, endedAt: ended, error: "Stopped when VibeForge quit." });
      if (run.taskId) {
        const task = this.store.getTask(run.taskId);
        if (task?.status === "running") this.store.writeTask({ ...task, status: "review" });
      }
    }
    return [...this.live.keys()];
  }

  // ---------------------------------------------------------------- helpers

  private firstPlace(places: readonly string[]): string | null {
    for (const place of places) if (isDirectory(place)) return path.resolve(place);
    return null;
  }
}
