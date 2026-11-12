import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCodingCli } from "../checkout.js";
import { isDirectory, readJson, writeJson } from "../fsx.js";
import {
  brainArgs,
  folderNameOk,
  NEEDS_GO,
  PLANNED_PREFIX,
  plannedId,
  sessionGone,
  withPlannedWorkspaces,
  type MaestroNote,
  type StepPatch,
  brainKind,
  canOrchestrate,
  KNOWN_MODELS,
  plannerFor,
  STRICT_PLAN_SCHEMA,
  signedOut,
  orchestratorRules,
  readBrainOutput,
  resolvePlan,
  stepIssue,
  type MaestroCopy,
  type OrchestratorStep,
  type OrchestratorTurn,
  type OrchestratorView,
  type PlanContext,
} from "../orchestrator.js";
import { isGitRepo, summarizeSnapshot } from "../vcs.js";
import type { ApplyResult } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import type { MessageDesk } from "./messages.js";
import { MaestroCopies, type CopyOutcome } from "./orchestrator-copies.js";
import type { LiveSession } from "../types.js";
import { cleanModel } from "../../shared/launch-options.js";
import type { Deleted } from "./types.js";
import type { WorkspaceDesk } from "./workspaces.js";

/** One planning turn can think for a while (Antigravity's first took 80 s); past this it is given up on. */
const BRAIN_TIMEOUT_MS = 5 * 60_000;
/** How long listing a planner's models may take. */
const MODELS_TIMEOUT_MS = 30_000;
/** Turns kept in the conversation file and shown. */
const KEEP_TURNS = 200;
/** The size a terminal starts at before its pane in Code resizes it. */
const START_SIZE = { cols: 120, rows: 32 };
/** A CLI Maestro started that worked at least this long before going quiet has finished a turn worth a word. */
const NOTE_AFTER_WORK_MS = 20_000;
/** At most one word about a CLI this often, so one that flickers between busy and quiet stays quiet. */
const NOTE_EVERY_MS = 60_000;
/** Turns the planner is reminded of when its session is gone and a new one starts. */
const RECAP_TURNS = 6;

interface Conversation {
  /** The planning CLI's own session, resumed each turn so it remembers what was said. */
  sessionId: string;
  /** The engine that session belongs to; another engine starts a new one. */
  engineId: string;
  /** The session exists (its first turn went through), so the next turn resumes it. */
  begun: boolean;
  turns: OrchestratorTurn[];
}

export interface BrainRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one headless turn of a CLI. The real one spawns it; tests hand in their own. */
export type BrainRunner = (argv: string[], cwd: string, signal: AbortSignal, timeoutMs?: number) => Promise<BrainRun>;

/** How long a planner has to end after SIGTERM before its whole process group is killed. */
const KILL_GRACE_MS = 3000;

/**
 * The environment a planner runs in: VibeForge's own, less what is VibeForge's or Electron's
 * business (its DevTools port, ELECTRON_RUN_AS_NODE), which a CLI has no use for.
 */
export function plannerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "VIBEFORGE_DEBUG" || key === "VIBEFORGE_DEBUG_PORT" || key.startsWith("ELECTRON_")) continue;
    clean[key] = value;
  }
  return { ...clean, NO_COLOR: "1" };
}

/**
 * The real runner. The CLI leads a process group of its own, so Stop and the timeout reach
 * whatever it started as well, and one that ignores SIGTERM is killed outright after a short
 * grace instead of holding the turn open for good.
 */
export const spawnBrain = (argv: string[], cwd: string, signal: AbortSignal, timeoutMs = BRAIN_TIMEOUT_MS, graceMs = KILL_GRACE_MS): Promise<BrainRun> =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: plannerEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    let killTimer: NodeJS.Timeout | null = null;
    const group = (name: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        /* already gone */
      }
    };
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      process.removeListener("exit", onQuit);
      resolve({ code, stdout, stderr, timedOut });
    };
    function stop() {
      if (finished || killTimer) return;
      group("SIGTERM");
      killTimer = setTimeout(() => {
        group("SIGKILL");
        // Something that left the group may still hold the pipes open; the turn ends anyway.
        killTimer = setTimeout(() => done(null), graceMs);
      }, graceMs);
    }
    // VibeForge quitting mid-turn takes the planner with it.
    function onQuit() {
      group("SIGKILL");
    }
    process.once("exit", onQuit);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
    child.on("error", (error) => {
      stderr += error.message;
      done(127);
    });
    child.on("close", (code) => done(code));
  });

const turnId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The Orchestrator's side of the main process: the conversation, one planning turn at a time
 * through the CLI chosen in Settings, and carrying plans out. Starting goes through Code's own
 * `startEngine`, each CLI in a new branch's folder beside its workspace.
 */
export class OrchestratorDesk {
  private conversation: Conversation;
  private thinking: AbortController | null = null;
  /** Models each planner listed, kept for this run of VibeForge. */
  private readonly models = new Map<string, string[]>();
  private readonly copies: MaestroCopies;
  runner: BrainRunner = spawnBrain;

  constructor(
    private readonly core: ServiceCore,
    private readonly workspaces: WorkspaceDesk,
    private readonly messages: MessageDesk,
  ) {
    this.conversation = this.load();
    this.copies = new MaestroCopies(core, workspaces, (copy, outcome) => this.copySettled(copy, outcome));
  }

  private get dir(): string {
    return path.join(this.core.options.dataRoot, "orchestrator");
  }

  private load(): Conversation {
    const saved = readJson<Partial<Conversation> | null>(path.join(this.dir, "conversation.json"), null);
    const turns = Array.isArray(saved?.turns) ? saved.turns.filter((turn) => turn && typeof turn.text === "string") : [];
    // A plan that was running when VibeForge closed isn't any more.
    for (const turn of turns) {
      if (turn.plan === "running") turn.plan = "done";
      for (const step of turn.steps ?? []) if (step.state === "running") step.state = "failed";
    }
    return {
      sessionId: typeof saved?.sessionId === "string" && saved.sessionId ? saved.sessionId : randomUUID(),
      engineId: typeof saved?.engineId === "string" ? saved.engineId : "",
      begun: Boolean(saved?.begun),
      turns,
    };
  }

  private save(): void {
    this.conversation.turns = this.conversation.turns.slice(-KEEP_TURNS);
    writeJson(path.join(this.dir, "conversation.json"), this.conversation);
    this.core.emit("orchestrator");
  }

  private settings() {
    return this.core.store.readSettings().orchestrator;
  }

  /** The CLI that plans right now: the one picked, or until then the first one here that can (plannerFor). */
  private planner(): string {
    const rows = this.core.store.readEngineRows().map((row) => ({ id: row.id, bin: row.bin, available: Boolean(this.core.resolveEngine(row.id)) }));
    return plannerFor(this.settings().engine, rows);
  }

  view(): OrchestratorView {
    const { engine, mode } = this.settings();
    const planner = this.planner();
    return {
      engineId: planner || engine,
      engineReady: Boolean(planner),
      mode,
      thinking: this.thinking !== null,
      turns: this.conversation.turns,
      copies: this.copies.list(),
      projectsFolder: this.projectsFolder(),
    };
  }

  /**
   * Where a new workspace's folder goes: the one in Settings; else the folder most workspaces sit
   * in (two or more); else ~/Projects.
   */
  projectsFolder(): string {
    const picked = this.settings().projectsFolder?.trim();
    if (picked) return tildify(expandHome(picked));
    const parents = new Map<string, number>();
    for (const item of this.core.store.readWorkspaces().workspaces) {
      // A copy's folder is VibeForge's own, never where a person keeps projects.
      if (isInside(path.join(this.core.options.dataRoot, "worktrees"), item.path)) continue;
      const parent = path.dirname(path.resolve(item.path));
      parents.set(parent, (parents.get(parent) ?? 0) + 1);
    }
    const [best] = [...parents.entries()].sort((a, b) => b[1] - a[1]);
    return tildify(best && best[1] >= 2 ? best[0] : path.join(os.homedir(), "Projects"));
  }

  /** What the planning CLI is told is here: workspaces, CLIs, the ones running, and copies waiting for review. */
  async context(): Promise<PlanContext> {
    const rows = this.core.store.readEngineRows();
    const workspaces = await Promise.all(
      this.core.store.readWorkspaces().workspaces.map(async (item) => ({ id: item.id, name: item.name, folder: tildify(item.path), git: await isGitRepo(item.path).catch(() => false) })),
    );
    const names = new Map(workspaces.map((item) => [item.id, item.name]));
    const copies = this.copies.list();
    const running = this.core
      .listLive()
      .filter(isCodingCli)
      .map((session) => {
        const run = session.runId ? this.core.store.getRun(session.runId) : null;
        const copy = session.workspaceId ? copies.find((item) => item.openedWorkspaceId === session.workspaceId) : undefined;
        const asked = oneLine(run?.prompt ?? "", 200);
        return {
          id: session.ptyId,
          engine: session.program || session.title.split(" · ")[0] || session.title,
          workspace: (session.workspaceId && names.get(session.workspaceId)) || session.title,
          folder: tildify(session.programCwd || session.cwd),
          working: Boolean(session.working ?? this.core.hostWorking.get(session.ptyId)),
          orchestrated: Boolean(session.orchestrated),
          ...(asked ? { asked } : {}),
          ...(copy ? { branch: copy.branch } : {}),
        };
      });
    return {
      workspaces,
      engines: rows.map((row) => ({ id: row.id, label: row.label, available: Boolean(this.core.resolveEngine(row.id)), bin: row.bin })),
      running,
      copies: copies.map((item) => ({ id: item.id, name: item.name, branch: item.branch, workspace: names.get(item.workspaceId) ?? item.workspaceId })),
      projectsFolder: this.projectsFolder(),
    };
  }

  /** What the person said or typed. The answer, and any plan, arrive as later turns. */
  async ask(text: string): Promise<void> {
    const words = text.trim();
    if (!words) return;
    if (this.thinking) throw new Error("Maestro is still answering. Wait for it, or stop it.");
    const now = this.core.now().toISOString();
    this.conversation.turns.push({ id: turnId(), at: now, from: "you", text: words });
    const controller = new AbortController();
    this.thinking = controller;
    this.save();
    try {
      await this.think(words, controller.signal);
    } finally {
      if (this.thinking === controller) this.thinking = null;
      this.save();
    }
  }

  private answer(turn: Omit<OrchestratorTurn, "id" | "at" | "from">): OrchestratorTurn {
    const full: OrchestratorTurn = { id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", by: this.planner() || this.settings().engine, ...turn };
    this.conversation.turns.push(full);
    return full;
  }

  private async think(words: string, signal: AbortSignal): Promise<void> {
    const { engine: picked, mode, model: chosen } = this.settings();
    const engineId = this.planner();
    // A model picked for another planner means nothing to this one.
    const model = engineId === picked ? chosen : "";
    const engine = engineId ? this.core.resolveEngine(engineId) : null;
    if (!engine || !canOrchestrate(engine.row)) {
      this.answer({ text: "", problem: "noEngine" });
      return;
    }
    if (this.conversation.engineId !== engineId) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), engineId, begun: false };
    }
    const context = await this.context();
    const work = path.join(this.dir, "work");
    fs.mkdirSync(work, { recursive: true });
    // Codex reads the schema from a file.
    const schemaFile = path.join(work, "plan-schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(STRICT_PLAN_SCHEMA));
    const turn = async (text: string) => {
      const args = brainArgs(engine.row, { text, rules: orchestratorRules(context), sessionId: this.conversation.sessionId, resume: this.conversation.begun, model, schemaFile });
      return args ? this.runner([engine.binPath, ...args], work, signal) : null;
    };
    let run = await turn(words);
    if (!run) {
      this.answer({ text: "", problem: "noEngine" });
      return;
    }
    let output = readBrainOutput(run.stdout);
    // The session it was asked to resume is gone (tidied away by the CLI): start a new one, once,
    // reminded of what was said lately.
    if (!signal.aborted && !run.timedOut && this.conversation.begun && !output.plan && (run.code !== 0 || output.error) && sessionGone(`${output.error}\n${run.stderr}\n${run.stdout}`)) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), begun: false };
      const retried = await turn(this.recap(words));
      if (retried) {
        run = retried;
        output = readBrainOutput(run.stdout);
      }
    }
    const { plan, text, sessionId, error } = output;
    const completed = !signal.aborted && !run.timedOut && Boolean(plan || (run.code === 0 && !error));
    // A first turn that didn't go through may still have left its session behind (Claude Code
    // saves it at the start), and naming it again would be refused as already in use: next time
    // starts a new one.
    if (!completed && !this.conversation.begun) this.conversation.sessionId = randomUUID();
    if (signal.aborted) return;
    if (run.timedOut) {
      this.answer({ text: "", problem: "timeout" });
      return;
    }
    if ((run.code !== 0 || error) && !plan) {
      const detail = lastLines(error || run.stderr || run.stdout);
      this.answer({ text: "", problem: signedOut(`${error}\n${run.stderr}\n${run.stdout}`) ? "signIn" : "failed", detail });
      return;
    }
    // Codex and Antigravity name their own session; the next turn resumes that one.
    if (sessionId) this.conversation.sessionId = sessionId;
    this.conversation.begun = true;
    if (!plan) {
      this.answer({ text: "", problem: "unreadable", detail: lastLines(text) });
      return;
    }
    const steps = resolvePlan(plan, context);
    if (!steps.length) {
      this.answer({ text: plan.say });
      return;
    }
    await this.markDirty(steps);
    // A new plan takes the place of one still waiting for Go.
    for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
    const answered = this.answer({ text: plan.say, steps, plan: "waiting" });
    // Just go: at once, unless a step needs fixing, or would stop, apply or throw away someone's work.
    const checked = withPlannedWorkspaces(context, steps);
    if (mode === "go" && steps.every((step) => !stepIssue(step, checked) && !NEEDS_GO.includes(step.kind))) void this.run(answered.id);
  }

  /** What a new planner session is told: the last few turns, then what the person just said. */
  private recap(words: string): string {
    const said = this.conversation.turns
      .slice(0, -1)
      .filter((turn) => turn.text && !turn.note)
      .slice(-RECAP_TURNS)
      .map((turn) => `${turn.from === "you" ? "The person" : "You"}: ${oneLine(turn.text, 400)}`);
    if (!said.length) return words;
    return ["(Your earlier session is gone. What was said last, for context:)", ...said, "", "The person now says:", words].join("\n");
  }

  /**
   * A start step on a branch works in a copy made from the last commit: say on its card how many
   * files are changed and not committed in the workspace, as those stay behind.
   */
  private async markDirty(steps: OrchestratorStep[]): Promise<void> {
    await Promise.all(
      steps.map(async (step) => {
        if (step.kind !== "start") return;
        const workspace = step.branch ? this.core.workspaceById(step.workspaceId) : null;
        const dirty = workspace ? await uncommitted(workspace.path) : 0;
        if (dirty > 0) step.dirty = dirty;
        else delete step.dirty;
      }),
    );
  }

  /**
   * The models a planner offers, for the picker in Settings: Claude Code's aliases, or what
   * `grok models` and `agy models` list (they ask their own service, so only when the picker is
   * opened). Codex has no list; the picker takes a name typed in.
   */
  async listModels(engineId: string): Promise<string[]> {
    const engine = this.core.resolveEngine(engineId);
    const kind = engine ? brainKind(engine.row) : null;
    if (!engine || !kind) return [];
    const known = KNOWN_MODELS[kind];
    if (known) return known;
    if (kind !== "grok" && kind !== "agy") return [];
    const cached = this.models.get(engineId);
    if (cached) return cached;
    fs.mkdirSync(path.join(this.dir, "work"), { recursive: true });
    const run = await this.runner([engine.binPath, ...engine.row.args, "models"], path.join(this.dir, "work"), new AbortController().signal, MODELS_TIMEOUT_MS);
    const listed = kind === "grok" ? grokModels(run.stdout) : agyModels(run.stdout);
    if (listed.length) this.models.set(engineId, listed);
    return listed;
  }

  /** Stop waiting for the planning CLI's answer. */
  stopThinking(): void {
    if (!this.thinking) return;
    this.thinking.abort();
    this.thinking = null;
    this.answer({ text: "", problem: "stopped" });
    this.save();
  }

  /** Start over: a new session for the planning CLI, and an empty conversation. */
  clear(): void {
    this.thinking?.abort();
    this.thinking = null;
    this.conversation = { sessionId: randomUUID(), engineId: this.planner(), begun: false, turns: [] };
    this.save();
  }

  private plan(turnIdValue: string): OrchestratorTurn {
    const turn = this.conversation.turns.find((item) => item.id === turnIdValue);
    if (!turn?.steps) throw new Error("That plan is gone.");
    return turn;
  }

  /** A change made on the plan card before Go: a step's CLI, workspace, branch, words, model, effort, or a new workspace's name and folder. */
  editStep(turnIdValue: string, stepId: string, patch: StepPatch): void {
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") throw new Error("That plan has already been carried out.");
    const steps = turn.steps ?? [];
    const at = steps.findIndex((step) => step.id === stepId);
    if (at < 0) throw new Error("That plan is gone.");
    const clean: Partial<OrchestratorStep> = {};
    for (const key of ["engineId", "workspaceId", "branch", "prompt", "target", "model", "effort", "name", "folder"] as const) {
      if (typeof patch[key] === "string") clean[key] = patch[key];
    }
    if (typeof clean.model === "string") clean.model = cleanModel(clean.model);
    if (typeof clean.effort === "string") clean.effort = clean.effort.trim().toLowerCase();
    if (typeof patch.git === "boolean") clean.git = patch.git;
    steps[at] = { ...steps[at], ...clean };
    this.save();
    // Another workspace or branch: whether its uncommitted edits stay behind is asked again.
    if ("workspaceId" in clean || "branch" in clean) {
      const step = steps[at];
      void this.markDirty([step]).then(() => this.save());
    }
  }

  removeStep(turnIdValue: string, stepId: string): void {
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") throw new Error("That plan has already been carried out.");
    turn.steps = (turn.steps ?? []).filter((step) => step.id !== stepId);
    if (!turn.steps.length) turn.plan = "cancelled";
    this.save();
  }

  cancel(turnIdValue: string): void {
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") return;
    turn.plan = "cancelled";
    for (const step of turn.steps ?? []) step.state = "skipped";
    this.save();
  }

  // ---------------------------------------------------------------- copies

  /** A step's copy: everything it changed, as Apply would bring it in. */
  copyDiff(copyId: string): Promise<string> {
    return this.copies.diff(copyId);
  }

  /** Apply a step's copy into the workspace it came from (see MaestroCopies.apply). */
  applyCopy(copyId: string): Promise<ApplyResult> {
    return this.copies.apply(copyId);
  }

  /** Throw a step's copy away, with Undo (see MaestroCopies.discard). */
  discardCopy(copyId: string): Promise<Deleted> {
    return this.copies.discard(copyId);
  }

  /** The step that made a copy says what became of it, while that plan is still in the conversation. */
  private copySettled(copy: MaestroCopy, outcome: CopyOutcome): void {
    const step = this.conversation.turns.find((turn) => turn.id === copy.turnId)?.steps?.find((item) => item.id === copy.stepId);
    if (!step) return;
    step.outcome = outcome;
    this.save();
  }

  /** Go: carry the plan out, one step after another. A step that fails doesn't stop the rest. */
  async run(turnIdValue: string): Promise<void> {
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") return;
    turn.plan = "running";
    this.save();
    for (const step of turn.steps ?? []) {
      const context = withPlannedWorkspaces(await this.context(), turn.steps ?? []);
      if (stepIssue(step, context)) {
        step.state = "skipped";
        this.save();
        continue;
      }
      step.state = "running";
      this.save();
      try {
        await this.carryOut(turn, step);
        step.state = "done";
      } catch (error) {
        step.state = "failed";
        step.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    turn.plan = "done";
    this.save();
  }

  private async carryOut(turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
    if (step.kind === "workspace") {
      const workspaceId = await this.makeWorkspace(step);
      step.openedWorkspaceId = workspaceId;
      // The plan's later steps named it by its placeholder; now it has a real id.
      for (const later of turn.steps ?? []) if (later.workspaceId === plannedId(step.id)) later.workspaceId = workspaceId;
      return;
    }
    if (step.kind === "start") {
      if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
      const workspace = this.core.workspaceById(step.workspaceId);
      if (!workspace) throw new Error("That workspace is gone.");
      let workspaceId = workspace.id;
      if (step.branch.trim() && (await isGitRepo(workspace.path).catch(() => false))) {
        // A copy of its own, as a task gets, so the work comes back for review: Apply or Discard.
        const copy = await this.copies.make({ turnId: turn.id, stepId: step.id, engineId: step.engineId, prompt: step.prompt, branch: step.branch, workspace });
        step.copyId = copy.id;
        step.branch = copy.branch;
        workspaceId = copy.openedWorkspaceId;
        this.save();
      }
      step.openedWorkspaceId = workspaceId;
      const launched = await this.workspaces.startEngine({ workspaceId, engineId: step.engineId, prompt: step.prompt, orchestrated: true, model: step.model, effort: step.effort, ...START_SIZE });
      step.ptyId = launched.ptyId;
      return;
    }
    if (step.kind === "apply") {
      const result = await this.copies.apply(step.target);
      if (result.conflicts.length) step.result = `Applied with conflicts to sort out in ${result.conflicts.slice(0, 5).join(", ")}${result.conflicts.length > 5 ? "…" : ""}. The copy stays until they are.`;
      return;
    }
    if (step.kind === "discard") {
      const deleted = await this.copies.discard(step.target);
      step.undo = deleted.undo;
      return;
    }
    if (!this.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
    if (step.kind === "show") {
      const session = this.core.live.get(step.target);
      if (!this.core.options.host.show) throw new Error("VibeForge can't show it from here.");
      this.core.options.host.show({ view: "code", ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}), ptyId: step.target });
      return;
    }
    if (step.kind === "tell") {
      // Looked at again now: a pane whose CLI has quit since the plan was made is a bare shell,
      // and the message would run there as a command.
      const session = this.core.live.get(step.target);
      const to = session && isCodingCli(session) ? this.messages.list().find((item) => item.ptyId === step.target) : undefined;
      if (!to) throw new Error("That CLI isn't running any more.");
      // The way every message to a CLI goes: in once it is idle and nobody is typing there, and
      // not at all after Stop. It is checked for its CLI once more as it goes in.
      const sent = await this.messages.tell({ fromPty: null, to: to.handle, text: step.prompt, fromPerson: true });
      if (!sent.ok) throw new Error(sent.error);
      return;
    }
    await this.core.killPty(step.target);
  }

  /**
   * A workspace step: its folder, made when it isn't there (and set up as a git repository when
   * asked), then added as a workspace with the name the plan gave it. A folder that is already
   * there is only added: nothing in it is written, moved or deleted.
   */
  private async makeWorkspace(step: OrchestratorStep): Promise<string> {
    const name = (step.name ?? "").trim();
    if (!folderNameOk(name)) throw new Error("A new workspace needs a name that isn't a path.");
    const folder = path.resolve(expandHome((step.folder ?? "").trim()));
    if (!(step.folder ?? "").trim() || folder === path.parse(folder).root || folder === os.homedir()) throw new Error("Choose a folder for the new workspace.");
    if (fs.existsSync(folder) && !isDirectory(folder)) throw new Error(`There's a file at ${tildify(folder)}, not a folder.`);
    const fresh = !fs.existsSync(folder) || fs.readdirSync(folder).length === 0;
    fs.mkdirSync(folder, { recursive: true });
    // Only a folder that is new (or was empty) is made a repository: an existing one stays as it is.
    if (step.git && fresh && !(await isGitRepo(folder).catch(() => false))) {
      const made = await gitIn(["init", "-q"], folder);
      if (made.code !== 0) throw new Error(`Could not make ${tildify(folder)} a git repository: ${made.stderr.trim().split("\n")[0] || "git failed"}`);
    }
    const known = this.core.store.readWorkspaces().workspaces.find((item) => path.resolve(item.path) === folder);
    if (known) return known.id;
    const id = this.workspaces.addQuietly(folder, name);
    return id;
  }

  // ---------------------------------------------------------------- hearing back

  /** When each CLI Maestro started began working, and when it was last spoken of. */
  private readonly workingSince = new Map<string, number>();
  private readonly lastNote = new Map<string, number>();

  /** A CLI went busy or quiet: one Maestro started that ends a turn after real work gets a word. */
  onActivity(ptyId: string, working: boolean): void {
    const session = this.core.live.get(ptyId);
    if (!session?.orchestrated) return;
    const now = this.core.now().getTime();
    if (working) {
      if (!this.workingSince.has(ptyId)) this.workingSince.set(ptyId, now);
      return;
    }
    const since = this.workingSince.get(ptyId);
    this.workingSince.delete(ptyId);
    if (since === undefined || now - since < NOTE_AFTER_WORK_MS) return;
    const last = this.lastNote.get(ptyId);
    if (last !== undefined && now - last < NOTE_EVERY_MS) return;
    this.lastNote.set(ptyId, now);
    void this.noteFinished(session);
  }

  /** A CLI Maestro started closed by itself (not stopped by a person or a step): a word, with what it changed. */
  onExit(session: LiveSession | undefined): void {
    if (!session?.orchestrated) return;
    this.workingSince.delete(session.ptyId);
    this.lastNote.delete(session.ptyId);
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    if (run?.stopRequested) return;
    this.addNote(session, "ended", run?.changes ?? null);
  }

  private async noteFinished(session: LiveSession): Promise<void> {
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    let changes: string | null = null;
    try {
      changes = summarizeSnapshot(await this.core.options.host.snapshotGit(session.programCwd || session.cwd, run?.gitStart ?? null));
    } catch {
      changes = null;
    }
    // Gone while git was asked: its exit says so instead.
    if (!this.core.isLive(session.ptyId)) return;
    this.addNote(session, "finished", changes);
  }

  private addNote(session: LiveSession, kind: MaestroNote["kind"], changes: string | null): void {
    const workspace = session.workspaceId ? this.core.workspaceById(session.workspaceId) : null;
    const copy = session.workspaceId ? this.copies.list().find((item) => item.openedWorkspaceId === session.workspaceId) : undefined;
    const note: MaestroNote = {
      kind,
      ptyId: session.ptyId,
      runId: session.runId,
      engine: session.program || session.title.split(" · ")[0] || session.title,
      workspace: workspace?.name ?? session.title,
      workspaceId: session.workspaceId,
      copyId: copy?.id ?? null,
      changes: changes && changes !== "No changes" ? changes : null,
    };
    this.conversation.turns.push({ id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", text: "", note });
    this.save();
  }

  close(): void {
    this.thinking?.abort();
    this.thinking = null;
  }
}

function expandHome(folder: string): string {
  return folder === "~" ? os.homedir() : folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function gitIn(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Files changed and not committed in a repository (new ones included); 0 when git can't say. */
async function uncommitted(folder: string): Promise<number> {
  const status = await gitIn(["status", "--porcelain", "--untracked-files=normal"], folder);
  return status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
}

function tildify(folder: string): string {
  const home = os.homedir();
  return folder === home || folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/** `grok models`: "  * grok-4.7 (default)" and "  - grok-4.6" lines. */
export function grokModels(text: string): string[] {
  return [...text.matchAll(/^\s*[*-]\s+([\w.:/-]+)/gm)].map((match) => match[1]);
}

/** `agy models`: an id, a tab, and its name, on each line. */
export function agyModels(text: string): string[] {
  return text.split("\n").flatMap((line) => (/^[\w.:/-]+\t/.test(line) ? [line.split("\t")[0]] : []));
}

function lastLines(text: string): string {
  return text.trim().split("\n").filter(Boolean).slice(-4).join("\n").slice(0, 600);
}
