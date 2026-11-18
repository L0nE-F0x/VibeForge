import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCodingCli } from "../checkout.js";
import { isDirectory, readJson, writeJson } from "../fsx.js";
import {
  brainArgs,
  branchFromPrompt,
  cleanBranch,
  detectWaitingPrompt,
  emptyPromise,
  folderNameOk,
  inspectsQuotas,
  keySequenceFor,
  lookingLine,
  NEEDS_GO,
  ONLY_LOOKS,
  parseWorkbenchAction,
  PLANNED_PREFIX,
  plannedFolder,
  plannedId,
  safeInCall,
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
  type Looking,
  type MaestroCopy,
  type OrchestratorStep,
  type OrchestratorTurn,
  type OrchestratorView,
  type PlanContext,
  type VibyWord,
} from "../orchestrator.js";
import { cwdAllowed } from "../places.js";
import { speakable } from "../replies.js";
import { isGitRepo, summarizeSnapshot } from "../vcs.js";
import type { ApplyResult } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import type { MessageDesk } from "./messages.js";
import { MaestroCopies, type CopyOutcome } from "./orchestrator-copies.js";
import type { LiveSession } from "../types.js";
import { cleanModel, effortLevels, takesModel } from "../../shared/launch-options.js";
import type { RoutineDesk } from "./routines.js";
import type { RunDesk } from "./runs.js";
import type { TaskDesk } from "./tasks.js";
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
/** The most of a CLI's answer a read step keeps on its card. */
const READ_KEEP = 20_000;
/** Turns the planner is reminded of when its session is gone and a new one starts. */
const RECAP_TURNS = 6;
/** Folders on disk a lookup names at most, and how long it may look for them. */
const LOOKUP_FOLDERS = 8;
const LOOKUP_WALK_MS = 3000;

interface Conversation {
  /** The planning CLI's own session, resumed each turn so it remembers what was said. */
  sessionId: string;
  /** The engine that session belongs to; another engine starts a new one. */
  engineId: string;
  /** The session exists (its first turn went through), so the next turn resumes it. */
  begun: boolean;
  /** Non-copy workspaces present when the session began, so adding one refreshes a planner that caches rules on turn 1. */
  workspacesKey?: string;
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
  private runEpoch = 0;
  private readonly runningPlans = new Map<string, Promise<void>>();
  /** Models each planner listed, kept for this run of VibeForge. */
  private readonly models = new Map<string, string[]>();
  private readonly copies: MaestroCopies;
  private readonly chainWaiters = new Map<string, Set<(ok: boolean) => void>>();
  private readonly chainTimers = new Map<string, NodeJS.Timeout>();
  private readonly firstPromptTimers = new Map<string, NodeJS.Timeout>();
  runner: BrainRunner = spawnBrain;
  /** Quiet time before a chained `after: true` step considers the previous PTY turn settled. */
  chainSettleMs = 1200;
  /** Time before checking whether a newly started CLI is stuck on a folder-trust/permission prompt. */
  firstPromptMs = 8000;

  constructor(
    private readonly core: ServiceCore,
    private readonly workspaces: WorkspaceDesk,
    private readonly messages: MessageDesk,
    private readonly tasks?: TaskDesk,
    private readonly routines?: RoutineDesk,
    private readonly runs?: RunDesk,
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

  /** What the planning CLI is told is here: workspaces, CLIs, agents, tasks, routines, running sessions, and copies waiting for review. */
  async context(): Promise<PlanContext> {
    const rows = this.core.store.readEngineRows();
    const workspaces = await Promise.all(
      // No past runs here: they'd go with every turn. A lookup step searches them when asked.
      this.core.store.readWorkspaces().workspaces.map(async (item) => ({ id: item.id, name: item.name, folder: tildify(item.path), git: await isGitRepo(item.path).catch(() => false) })),
    );
    const names = new Map(workspaces.map((item) => [item.id, item.name]));
    const copies = this.copies.list();
    const running = await Promise.all(
      this.core
        .listLive()
        .filter(isCodingCli)
        .map(async (session) => {
          const run = session.runId ? this.core.store.getRun(session.runId) : null;
          const copy = session.workspaceId ? copies.find((item) => item.openedWorkspaceId === session.workspaceId) : undefined;
          const asked = oneLine(run?.prompt ?? "", 200);
          const working = Boolean(session.working ?? this.core.hostWorking.get(session.ptyId));
          const screen = !working && this.core.options.host.screen ? await this.core.options.host.screen(session.ptyId).catch(() => "") : "";
          const waiting = screen ? detectWaitingPrompt(screen) : null;
          return {
            id: session.ptyId,
            engine: session.program || session.title.split(" · ")[0] || session.title,
            workspace: (session.workspaceId && names.get(session.workspaceId)) || session.title,
            folder: tildify(session.programCwd || session.cwd),
            working,
            orchestrated: Boolean(session.orchestrated),
            ...(asked ? { asked } : {}),
            ...(copy ? { branch: copy.branch } : {}),
            ...(waiting ? { waiting } : {}),
          };
        }),
    );
    const rawAgents = this.core.store.listAgents();
    const agentNames = new Map(rawAgents.map((item) => [item.id, item.name]));
    const agents = rawAgents.map((item) => ({
      id: item.id,
      name: item.name,
      engine: item.engine,
      ...(item.goodAt ? { goodAt: item.goodAt } : {}),
      ...(item.places.length ? { places: item.places.map(tildify) } : {}),
    }));
    const tasks = this.core.store
      .listTasks()
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        ...(item.workspaceId && names.get(item.workspaceId) ? { workspace: names.get(item.workspaceId) } : {}),
        ...(item.agentId && agentNames.get(item.agentId) ? { agent: agentNames.get(item.agentId) } : {}),
      }));
    const routines = (this.routines ? this.routines.listRoutines() : []).map((item) => ({
      id: item.id,
      name: item.name,
      schedule: item.description,
      enabled: item.enabled,
      ...(item.agentName ? { agent: item.agentName } : {}),
    }));
    const defaultPick = this.core.store.readSettings().defaultEngine;
    const defaultEngine = defaultPick && this.core.resolveEngine(defaultPick) ? defaultPick : undefined;
    return {
      workspaces,
      engines: rows.map((row) => ({ id: row.id, label: row.label, available: Boolean(this.core.resolveEngine(row.id)), bin: row.bin })),
      ...(defaultEngine ? { defaultEngine } : {}),
      running,
      copies: copies.map((item) => ({ id: item.id, name: item.name, branch: item.branch, workspace: names.get(item.workspaceId) ?? item.workspaceId })),
      ...(agents.length ? { agents } : {}),
      ...(tasks.length ? { tasks } : {}),
      ...(routines.length ? { routines } : {}),
      projectsFolder: this.projectsFolder(),
    };
  }

  /**
   * The call that is on, or null. While one is, the window follows Viby: a CLI it starts or tells
   * comes up in Code, without the window being raised over whatever else the person has in front.
   * And the call is handed what Viby has to say by itself: a note about a CLI, an answer read out.
   */
  onCall: ((word: VibyWord) => void) | null = null;

  private followTo(workspaceId: string | null | undefined, ptyId: string): void {
    if (this.onCall) this.core.options.host.show?.({ view: "code", ...(workspaceId ? { workspaceId } : {}), ptyId }, false);
  }

  /**
   * What the person said or typed. The answer, and any plan, arrive as later turns. `looking` is
   * where they are in the window, which the planner is told so "this one" and "here" mean something.
   */
  async ask(text: string, looking?: Looking | null): Promise<void> {
    const words = text.trim();
    if (!words) return;
    if (this.thinking) throw new Error("Viby is still answering. Wait for it, or stop it.");
    const now = this.core.now().toISOString();
    this.conversation.turns.push({ id: turnId(), at: now, from: "you", text: words });
    const controller = new AbortController();
    this.thinking = controller;
    this.save();
    try {
      await this.think(words, controller.signal, looking ?? null);
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

  private async think(words: string, signal: AbortSignal, looking: Looking | null): Promise<void> {
    const { engine: picked, mode, model: chosen } = this.settings();
    const engineId = this.planner();
    // A model picked for another planner means nothing to this one.
    const explicitModel = engineId === picked ? chosen : "";
    const engine = engineId ? this.core.resolveEngine(engineId) : null;
    if (!engine || !canOrchestrate(engine.row)) {
      this.answer({ text: "", problem: "noEngine" });
      return;
    }
    // In a live voice call, default Claude Code to haiku unless the person chose a specific model.
    const model = explicitModel || (this.onCall && brainKind(engine.row) === "claude" ? "haiku" : "");
    const context = await this.context();
    const copies = this.copies.list();
    const currentWorkspacesKey = context.workspaces
      .filter((w) => !copies.some((c) => c.openedWorkspaceId === w.id))
      .map((w) => `${w.id}:${w.name}`)
      .join("|");
    const switchedEngine = Boolean(this.conversation.engineId && this.conversation.engineId !== engineId);
    const workspacesChanged = Boolean(
      this.conversation.begun &&
        this.conversation.workspacesKey !== undefined &&
        this.conversation.workspacesKey !== currentWorkspacesKey &&
        brainKind(engine.row) === "grok",
    );
    if (this.conversation.engineId !== engineId || workspacesChanged) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), engineId, begun: false, workspacesKey: currentWorkspacesKey };
    }
    const work = path.join(this.dir, "work");
    fs.mkdirSync(work, { recursive: true });
    // Codex reads the schema from a file.
    const schemaFile = path.join(work, "plan-schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(STRICT_PLAN_SCHEMA));
    // Said ahead of every request, not in the rules: a resumed session may not read those again.
    const here = lookingLine(looking, context);
    const turn = async (said: string, ctx: PlanContext = context) => {
      const text = here ? `${here}\n${said}` : said;
      const args = brainArgs(engine.row, { text, rules: orchestratorRules(ctx), sessionId: this.conversation.sessionId, resume: this.conversation.begun, model, schemaFile });
      return args ? this.runner([engine.binPath, ...args], work, signal) : null;
    };
    const initialText = (switchedEngine || workspacesChanged) && !this.conversation.begun ? this.recap(words) : words;
    let run = await turn(initialText);
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
    // A planner that says it is searching, checking, or starting something right now while returning
    // steps: [] (e.g. a resumed session with stale rules or acting as if a tool turn follows):
    // start a fresh session with the current workspace and running lists and ask once for real steps.
    if (!signal.aborted && !run.timedOut && output.plan && !output.plan.steps.length && emptyPromise(output.plan.say)) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), begun: false };
      const retried = await turn(
        [
          this.recap(words),
          "",
          `(Your draft answer said "${oneLine(output.plan.say, 200)}" with steps: []. Nothing runs after your answer unless you include steps, and you cannot search or check files yourself. Either return the steps to carry out now using the workspaces and CLIs listed in the rules, or emit a lookup step to search disk and run history, or tell the person plainly what you cannot see and ask.)`,
        ].join("\n"),
      );
      if (retried) {
        run = retried;
        output = readBrainOutput(retried.stdout);
      }
    }
    let { plan, text, sessionId, error } = output;
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
    this.conversation.workspacesKey = currentWorkspacesKey;
    if (!plan) {
      this.answer({ text: "", problem: "unreadable", detail: lastLines(text) });
      return;
    }
    let steps = resolvePlan(plan, context);
    // A plan whose steps are only lookups or inspections: VibeForge gathers the findings at once
    // and hands them back so Viby can answer or give the concrete steps in the same turn.
    if (!signal.aborted && steps.length > 0 && steps.every((step) => (step.kind === "lookup" || step.kind === "inspect") && !stepIssue(step, context))) {
      const results = await Promise.all(steps.map((step) => (step.kind === "lookup" ? this.lookup(step.prompt) : this.inspect(step))));
      if (signal.aborted) return;
      const details = results
        .map((res, idx) => `${steps[idx].kind === "lookup" ? "Lookup" : "Inspection"} "${steps[idx].asked || steps[idx].prompt}":\n${res.details}`)
        .join("\n\n");
      const followUp = await turn(
        [
          "[Findings from VibeForge]",
          details,
          "",
          `Now answer the person's request ("${words}") using these exact findings. Return the concrete steps to carry it out now, or answer clearly in say with steps: [] if nothing should be started.`,
        ].join("\n"),
      );
      if (followUp && !signal.aborted && !followUp.timedOut) {
        const nextOut = readBrainOutput(followUp.stdout);
        if (nextOut.sessionId) this.conversation.sessionId = nextOut.sessionId;
        if (nextOut.plan) {
          plan = nextOut.plan;
          steps = resolvePlan(plan, context);
        }
      }
    }
    if (!steps.length) {
      this.answer({ text: plan.say, ...(plan.hangup ? { hangup: true } : {}) });
      if (plan.hangup) this.onCall?.({ kind: "hangup" });
      return;
    }
    await this.markDirty(steps);
    const inPlaceDirty = this.onCall ? await this.hasDirtyInPlace(steps) : false;
    // A new plan takes the place of one still waiting for Go.
    for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
    const answered = this.answer({ text: plan.say, steps, plan: "waiting", ...(plan.hangup ? { hangup: true } : {}) });
    // Just go: at once, unless a step needs fixing, or would stop, apply or throw away someone's work.
    // Showing something or reading an answer out changes nothing, so a plan of only those goes at once either way.
    // In a voice call, safe steps (isolated branch copies, workspaces, tells, tasks, routines) also go at once.
    const checked = withPlannedWorkspaces(context, steps);
    const ready = steps.every((step) => !stepIssue(step, checked));
    const callSafe = Boolean(this.onCall) && !inPlaceDirty && steps.every((step) => safeInCall(step));
    if (ready && (steps.every((step) => ONLY_LOOKS.includes(step.kind)) || callSafe || (mode === "go" && steps.every((step) => !NEEDS_GO.includes(step.kind))))) {
      void this.run(answered.id);
    }
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

  private async hasDirtyInPlace(steps: OrchestratorStep[]): Promise<boolean> {
    for (const step of steps) {
      if (step.kind !== "start" || step.branch || !step.prompt.trim()) continue;
      const workspace = this.core.workspaceById(step.workspaceId);
      if (workspace && (await uncommitted(workspace.path)) > 0) return true;
    }
    return false;
  }

  /**
   * Instant local navigation for crisp voice commands ("switch to VibeForge", "open Tasks"):
   * resolves against the current context without spawning a planner turn, or null when ambiguous.
   */
  async quickShow(target: string, rawSaid: string, sayText: (label: string) => string): Promise<string | null> {
    if (this.thinking || !this.core.options.host.show) return null;
    const context = await this.context();
    const steps = resolvePlan({ say: "", steps: [{ kind: "show", target, workspace: target }] }, context);
    const step = steps[0];
    if (!step || stepIssue(step, context)) return null;
    const now = this.core.now().toISOString();
    this.conversation.turns.push({ id: turnId(), at: now, from: "you", text: rawSaid.trim() });
    const say = sayText(step.asked);
    const answered = this.answer({ text: say, steps: [step], plan: "running" });
    try {
      await this.carryOut(answered, step);
      step.state = "done";
      answered.plan = "done";
    } catch (error) {
      step.state = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      answered.plan = "done";
    }
    this.save();
    return say;
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

  /** Stop waiting for the planning CLI's answer. `silent` skips adding a "Stopped." card when speech barges in to replace it. */
  stopThinking(silent = false): void {
    if (!this.thinking) return;
    this.thinking.abort();
    this.thinking = null;
    if (!silent) this.answer({ text: "", problem: "stopped" });
    this.save();
  }

  /** Start over: a new session for the planning CLI, and an empty conversation. */
  clear(): void {
    this.thinking?.abort();
    this.thinking = null;
    this.forgetTold();
    this.runEpoch += 1;
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
    const current = steps[at];
    const clean: Partial<OrchestratorStep> = {};
    for (const key of ["engineId", "workspaceId", "branch", "prompt", "target", "model", "effort", "name", "folder"] as const) {
      if (typeof patch[key] === "string") clean[key] = patch[key];
    }
    if (typeof clean.branch === "string") clean.branch = cleanBranch(clean.branch);
    if (typeof clean.model === "string") clean.model = cleanModel(clean.model);
    if (typeof clean.effort === "string") clean.effort = clean.effort.trim().toLowerCase();
    if (typeof patch.git === "boolean") clean.git = patch.git;
    if (current.kind === "workspace" && typeof clean.name === "string" && !("folder" in clean)) {
      const oldDefault = plannedFolder(current.name ?? "", "", this.projectsFolder());
      if (!current.folder || current.folder === oldDefault) {
        clean.folder = plannedFolder(clean.name, "", this.projectsFolder());
      }
    }
    if (current.kind === "start") {
      if (typeof clean.engineId === "string" && clean.engineId !== current.engineId) {
        const nextEngine = this.core.resolveEngine(clean.engineId);
        const nextEffort = clean.effort ?? current.effort ?? "";
        if (nextEffort && (!nextEngine || !effortLevels(nextEngine.row).includes(nextEffort))) clean.effort = "";
        const nextModel = clean.model ?? current.model ?? "";
        if (nextModel && nextEngine && !takesModel(nextEngine.row)) clean.model = "";
      }
      if (typeof clean.workspaceId === "string" && !current.workspaceId && !current.branch && !("branch" in clean)) {
        const nextPrompt = (clean.prompt ?? current.prompt).trim();
        const ws = this.core.workspaceById(clean.workspaceId);
        if (nextPrompt && ws && fs.existsSync(path.join(ws.path, ".git"))) {
          clean.branch = branchFromPrompt(nextPrompt);
        }
      }
    }
    steps[at] = { ...current, ...clean };
    this.save();
    // Another workspace or branch: whether its uncommitted edits stay behind is asked again.
    if ("workspaceId" in clean || "branch" in clean) {
      const step = steps[at];
      void this.markDirty([step]).then(() => {
        if (turn.plan === "waiting" && this.conversation.turns.includes(turn)) this.save();
      });
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
    const existing = this.runningPlans.get(turnIdValue);
    if (existing) return existing;
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") return;
    const work = this.runSteps(turn);
    this.runningPlans.set(turnIdValue, work);
    try {
      await work;
    } finally {
      this.runningPlans.delete(turnIdValue);
    }
  }

  private async runSteps(turn: OrchestratorTurn): Promise<void> {
    const epoch = this.runEpoch;
    turn.plan = "running";
    this.save();
    let prevPtyId: string | null = null;
    let prevSourceWorkspaceId: string | null = null;
    let prevOpenedWorkspaceId: string | null = null;
    for (const step of turn.steps ?? []) {
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (step.after && prevPtyId) {
        const settled = await this.waitForChainedPty(prevPtyId, epoch, turn);
        if (!settled || this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) {
          step.state = "skipped";
          this.save();
          continue;
        }
        // A follow-up shell or inspection targeting the same workspace works in the copy the previous step opened.
        if (
          prevOpenedWorkspaceId &&
          prevSourceWorkspaceId &&
          step.workspaceId === prevSourceWorkspaceId &&
          (step.kind === "shell" || step.kind === "inspect" || (step.kind === "start" && !step.branch))
        ) {
          step.workspaceId = prevOpenedWorkspaceId;
        }
      }
      const context = withPlannedWorkspaces(await this.context(), turn.steps ?? []);
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (stepIssue(step, context)) {
        step.state = "skipped";
        this.save();
        continue;
      }
      const sourceWorkspaceId = step.workspaceId || null;
      step.state = "running";
      this.save();
      try {
        await this.carryOut(turn, step);
        step.state = "done";
        const producedPty = step.ptyId || (step.kind === "tell" ? step.target : null);
        if (producedPty) {
          prevPtyId = producedPty;
          prevSourceWorkspaceId = sourceWorkspaceId;
          prevOpenedWorkspaceId = step.openedWorkspaceId || sourceWorkspaceId;
        }
      } catch (error) {
        step.state = "failed";
        step.error = error instanceof Error ? error.message : String(error);
        prevPtyId = null;
      }
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      this.save();
    }
    if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
    turn.plan = "done";
    this.save();
    if (turn.hangup) this.onCall?.({ kind: "hangup" });
  }

  private waitForChainedPty(ptyId: string, epoch: number, turn: OrchestratorTurn): Promise<boolean> {
    if (!this.core.isLive(ptyId)) {
      const session = this.core.live.get(ptyId);
      const run = session?.runId ? this.core.store.getRun(session.runId) : null;
      return Promise.resolve(!run?.stopRequested);
    }
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        const set = this.chainWaiters.get(ptyId);
        set?.delete(done);
        if (set && !set.size) this.chainWaiters.delete(ptyId);
        resolve(ok && this.runEpoch === epoch && this.conversation.turns.includes(turn));
      };
      const set = this.chainWaiters.get(ptyId) ?? new Set();
      set.add(done);
      this.chainWaiters.set(ptyId, set);
    });
  }

  private settleChainWaiters(ptyId: string, ok: boolean): void {
    const timer = this.chainTimers.get(ptyId);
    if (timer) {
      clearTimeout(timer);
      this.chainTimers.delete(ptyId);
    }
    const set = this.chainWaiters.get(ptyId);
    if (!set) return;
    this.chainWaiters.delete(ptyId);
    for (const waiter of [...set]) waiter(ok);
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
      // A saved agent works only in its allowed folders, as it does when started from Chat or a task.
      const agent = step.agentId ? this.core.store.getAgent(step.agentId) : null;
      if (step.agentId && !agent) throw new Error("That agent no longer exists.");
      if (agent && !cwdAllowed(workspace.path, agent.places)) throw new Error(`${agent.name} is not allowed in ${workspace.name}.`);
      let workspaceId = workspace.id;
      let copyOf: { path: string; of: string } | null = null;
      if (step.branch.trim() && (await isGitRepo(workspace.path).catch(() => false))) {
        if (await hasCommit(workspace.path)) {
          // A copy of its own, as a task gets, so the work comes back for review: Apply or Discard.
          const copy = await this.copies.make({ turnId: turn.id, stepId: step.id, engineId: step.engineId, prompt: step.prompt, branch: step.branch, workspace });
          step.copyId = copy.id;
          step.branch = copy.branch;
          workspaceId = copy.openedWorkspaceId;
          // An agent's brief names its allowed folders: it's told to work in the copy instead.
          const opened = this.core.workspaceById(workspaceId);
          if (opened) copyOf = { path: opened.path, of: workspace.path };
          this.save();
        } else {
          step.branch = "";
        }
      }
      step.openedWorkspaceId = workspaceId;
      const launched = await this.workspaces.startEngine({ workspaceId, engineId: step.engineId, agentId: step.agentId, copyOf, prompt: step.prompt, orchestrated: true, model: step.model, effort: step.effort, ...START_SIZE });
      step.ptyId = launched.ptyId;
      step.runId = launched.runId;
      this.followTo(workspaceId, launched.ptyId);
      this.watchFirstPrompt(launched.ptyId);
      return;
    }
    if (step.kind === "inspect") {
      const inspected = await this.inspect(step);
      step.result = inspected.summary;
      return;
    }
    if (step.kind === "shell") {
      if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
      const workspace = this.core.workspaceById(step.workspaceId);
      if (!workspace) throw new Error("That workspace is gone.");
      const launched = await this.workspaces.startShell({ workspaceId: workspace.id, orchestrated: true, command: step.prompt, ...START_SIZE });
      step.ptyId = launched.ptyId;
      step.openedWorkspaceId = workspace.id;
      this.followTo(workspace.id, launched.ptyId);
      return;
    }
    if (step.kind === "key") {
      if (!this.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
      const session = this.core.live.get(step.target);
      const screen = this.core.options.host.screen ? await this.core.options.host.screen(step.target).catch(() => "") : "";
      const action = keySequenceFor(step.prompt, screen);
      if (!action) throw new Error("Unknown key action.");
      if (this.core.options.host.write) await this.core.options.host.write(step.target, action.data);
      else await this.core.options.host.send(step.target, action.data.replace(/\r$/, ""), action.data.endsWith("\r"));
      this.followTo(session?.workspaceId, step.target);
      step.result = `Sent ${action.label}.`;
      return;
    }
    if (step.kind === "workbench") {
      await this.carryOutWorkbench(step);
      return;
    }
    if (step.kind === "lookup") {
      const found = await this.lookup(step.prompt);
      step.result = found.summary;
      return;
    }
    if (step.kind === "routine") {
      if (!this.routines) throw new Error("That routine no longer exists.");
      const action = step.prompt.trim().toLowerCase();
      if (action === "enable" || action === "disable") {
        this.routines.setRoutineEnabled(step.target, action === "enable");
        return;
      }
      // As Run now on the board: with another CLI busy in its folder, it waits its turn there.
      const launched = await this.routines.runRoutineNow(step.target, START_SIZE);
      if ("ptyId" in launched) {
        step.ptyId = launched.ptyId;
        step.runId = launched.runId;
      } else step.result = waitsTurn(launched.behind);
      return;
    }
    if (step.kind === "task") {
      if (!this.tasks) throw new Error("That task no longer exists.");
      let taskId = step.target;
      if (!taskId) {
        if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
        const workspace = this.core.workspaceById(step.workspaceId);
        // In its own copy where the board would make one: a git workspace with a commit to copy.
        const isolated = Boolean(workspace) && (await isGitRepo(workspace?.path ?? "").catch(() => false)) && (await hasCommit(workspace?.path ?? ""));
        const saved = this.tasks.saveTask({
          title: step.name || branchFromPrompt(step.prompt),
          body: step.prompt,
          agentId: step.agentId || null,
          workspaceId: step.workspaceId || null,
          isolated,
        });
        taskId = saved.id;
        step.target = taskId;
      }
      // As Execute on the board: a fresh start with its instructions (never a Continue of its last
      // session), and in the workspace itself it waits its turn while another CLI is busy there.
      const launched = await this.tasks.executeTask(taskId, START_SIZE);
      if ("ptyId" in launched) {
        step.ptyId = launched.ptyId;
        step.runId = launched.runId;
      } else step.result = waitsTurn(launched.behind);
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
    if (step.kind === "show") {
      const show = this.core.options.host.show;
      if (!show) throw new Error("VibeForge can't show it from here.");
      if (step.target) {
        if (!this.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
        const session = this.core.live.get(step.target);
        show({ view: "code", ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}), ptyId: step.target });
      } else if (step.view) show({ view: step.view });
      else {
        if (!this.core.workspaceById(step.workspaceId)) throw new Error("That workspace is gone.");
        show({ view: "code", workspaceId: step.workspaceId });
      }
      return;
    }
    if (!this.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
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
      this.followTo(session?.workspaceId, step.target);
      this.hearBack(step.target, step.prompt);
      return;
    }
    if (step.kind === "read") {
      const session = this.core.live.get(step.target);
      if (!session || !isCodingCli(session)) throw new Error("That CLI isn't running any more.");
      const answer = await this.messages.answerOf(step.target);
      if (!answer.reply) throw new Error("It hasn't answered anything yet.");
      step.reply = answer.reply.length > READ_KEEP ? `${answer.reply.slice(0, READ_KEEP).trimEnd()}…` : answer.reply;
      // In a call its terminal comes up too, so the answer can be read along with.
      this.followTo(session.workspaceId, step.target);
      this.onCall?.({ kind: "read", ...this.nameOf(session), reply: step.reply, all: step.prompt === "all", fromScreen: answer.fromScreen });
      return;
    }
    await this.core.killPty(step.target);
  }

  private watchFirstPrompt(ptyId: string): void {
    const prev = this.firstPromptTimers.get(ptyId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.firstPromptTimers.delete(ptyId);
      const session = this.core.live.get(ptyId);
      if (!session || session.working || this.workingSince.has(ptyId) || !this.core.options.host.screen) return;
      void this.core.options.host
        .screen(ptyId)
        .catch(() => "")
        .then((screen) => {
          const prompt = detectWaitingPrompt(screen);
          const current = this.core.live.get(ptyId);
          if (!prompt || !current || current.working) return;
          this.addNote(current, "waiting", null, prompt);
        });
    }, this.firstPromptMs);
    timer.unref();
    this.firstPromptTimers.set(ptyId, timer);
  }

  private clearFirstPrompt(ptyId: string): void {
    const timer = this.firstPromptTimers.get(ptyId);
    if (timer) {
      clearTimeout(timer);
      this.firstPromptTimers.delete(ptyId);
    }
  }

  private async carryOutWorkbench(step: OrchestratorStep): Promise<void> {
    const action = parseWorkbenchAction(step);
    if (!action) throw new Error("Unsupported workbench action.");
    if (action.op === "mark-reviewed") {
      this.runs?.markAllOpened();
      step.result = "Marked all runs reviewed.";
      return;
    }
    if (action.op === "mkdir") {
      const ws = step.workspaceId ? this.core.workspaceById(step.workspaceId) : null;
      const raw = expandHome(action.folder);
      const target = path.isAbsolute(raw) ? path.resolve(raw) : ws ? path.resolve(ws.path, raw) : path.resolve(expandHome(this.projectsFolder()), raw);
      if (target === path.parse(target).root || target === os.homedir()) throw new Error("Refusing to modify root or home directory directly.");
      if (ws && !path.isAbsolute(raw) && !isInside(ws.path, target)) throw new Error("Folder path stays inside its workspace.");
      fs.mkdirSync(target, { recursive: true });
      step.result = `Created ${tildify(target)}.`;
      return;
    }
    if (action.op === "branch") {
      const opened = await this.workspaces.openBranch(step.workspaceId, action.branch);
      step.openedWorkspaceId = opened.lastWorkspaceId ?? step.workspaceId;
      if (step.openedWorkspaceId) this.core.options.host.show?.({ view: "code", workspaceId: step.openedWorkspaceId }, Boolean(!this.onCall));
      return;
    }
    if (action.op === "browser-open") {
      this.workspaces.updateWorkspace(step.workspaceId, { dockUrl: action.url });
      this.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, Boolean(!this.onCall));
      this.core.options.host.codeWorkbench?.({ kind: "browser-open", workspaceId: step.workspaceId, url: action.url });
      step.result = action.url;
      return;
    }
    if (action.op === "browser-cmd") {
      this.core.options.host.dockCommand?.(action.command);
      step.result = `Browser: ${action.command}.`;
      return;
    }
    if (action.op === "side") {
      if (step.workspaceId) this.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, Boolean(!this.onCall));
      this.core.options.host.codeWorkbench?.({ kind: "side", ...(step.workspaceId ? { workspaceId: step.workspaceId } : {}), tab: action.tab });
      return;
    }
    if (action.op === "pane") {
      if (step.workspaceId) this.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, Boolean(!this.onCall));
      this.core.options.host.codeWorkbench?.({ kind: "pane", ...(step.workspaceId ? { workspaceId: step.workspaceId } : {}), action: action.action });
      return;
    }
    if (action.op === "diff") {
      const copy = this.copies.list().find((item) => item.id === action.target || item.name === action.target || item.branch === action.target);
      if (copy) {
        this.core.options.host.show?.({ view: "orchestrator", copyId: copy.id }, Boolean(!this.onCall));
        return;
      }
      const run = this.core.store.getRun(action.target) ?? this.core.store.queryRuns({ limit: 50 }).find((r) => r.id === action.target || r.title.toLowerCase().includes(action.target.toLowerCase()));
      if (run) {
        this.core.options.host.show?.({ view: "runs", runId: run.id }, Boolean(!this.onCall));
        return;
      }
      throw new Error(`No copy or run matched "${action.target}".`);
    }
  }

  /**
   * Read-only inspection of quotas/usage, a copy's diff, a running CLI's screen and latest reply,
   * or a workspace's git state and files, so Viby can diagnose, review and brainstorm with real facts.
   */
  async inspect(step: OrchestratorStep): Promise<{ summary: string; details: string }> {
    if (inspectsQuotas(step.prompt) || inspectsQuotas(step.target)) {
      const details = (await this.core.options.host.quotas?.()) ?? "Plan limits and token usage are not enabled in Settings.";
      return { summary: oneLine(details, 140), details };
    }
    const copy = step.target ? this.copies.list().find((item) => item.id === step.target) : undefined;
    if (copy) {
      const diff = await this.copies.diff(copy.id).catch(() => "");
      const clipped = diff.length > 10_000 ? `${diff.slice(0, 10_000)}\n… (truncated)` : diff || "(no diff yet)";
      return {
        summary: `Copy ${copy.name} (${copy.branch}): ${diff ? `${diff.split("\n").length} diff lines` : "no changes yet"}`,
        details: `Copy "${copy.name}" on branch ${copy.branch}:\n${clipped}`,
      };
    }
    const session = step.target ? this.core.live.get(step.target) : undefined;
    if (session) {
      const [answer, screen, status] = await Promise.all([
        isCodingCli(session) ? this.messages.answerOf(session.ptyId, true).catch(() => ({ reply: "", fromScreen: false })) : Promise.resolve({ reply: "", fromScreen: false }),
        this.core.options.host.screen ? this.core.options.host.screen(session.ptyId).catch(() => "") : Promise.resolve(""),
        gitIn(["status", "--short"], session.programCwd || session.cwd),
      ]);
      const tailScreen = screen.split(/\r?\n/).filter((line) => line.trim()).slice(-40).join("\n");
      const waiting = detectWaitingPrompt(screen);
      const parts = [
        `CLI: ${session.program || session.title} in ${tildify(session.programCwd || session.cwd)} (${session.working ? "working" : waiting ? `WAITING ON PROMPT: "${waiting}"` : "idle"})`,
        ...(answer.reply ? [`Latest reply:\n${answer.reply.slice(0, 6000)}`] : []),
        ...(tailScreen ? [`Terminal screen (last lines):\n${tailScreen.slice(-4000)}`] : []),
        ...(status.code === 0 && status.stdout.trim() ? [`Git status:\n${status.stdout.trim().slice(0, 2000)}`] : []),
      ];
      const summary = waiting ? `Waiting on prompt: ${waiting}` : answer.reply ? oneLine(answer.reply, 120) : oneLine(tailScreen || "Idle.", 120);
      return { summary, details: parts.join("\n\n") };
    }
    const ws = step.workspaceId ? this.core.workspaceById(step.workspaceId) : null;
    if (ws && isDirectory(ws.path)) {
      const [branchOut, statusOut, logOut, statOut] = await Promise.all([
        gitIn(["rev-parse", "--abbrev-ref", "HEAD"], ws.path),
        gitIn(["status", "--short"], ws.path),
        gitIn(["log", "-n", "5", "--oneline"], ws.path),
        gitIn(["diff", "--stat"], ws.path),
      ]);
      const parts: string[] = [`Workspace "${ws.name}" (${tildify(ws.path)})`];
      if (branchOut.code === 0 && branchOut.stdout.trim()) parts.push(`Branch: ${branchOut.stdout.trim()}`);
      if (statusOut.code === 0) parts.push(`Git status:\n${statusOut.stdout.trim() || "(clean)"}`);
      if (statOut.code === 0 && statOut.stdout.trim()) parts.push(`Uncommitted diff stat:\n${statOut.stdout.trim()}`);
      if (/\bdiff\b/i.test(step.prompt)) {
        const fullDiff = await gitIn(["diff"], ws.path);
        if (fullDiff.code === 0 && fullDiff.stdout.trim()) parts.push(`Git diff:\n${fullDiff.stdout.slice(0, 6000)}`);
      }
      if (logOut.code === 0 && logOut.stdout.trim()) parts.push(`Recent commits:\n${logOut.stdout.trim()}`);
      const entries = await fs.promises
        .readdir(ws.path, { withFileTypes: true })
        .then((list) => list.filter((e) => !e.name.startsWith(".")).slice(0, 40).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)))
        .catch(() => [] as string[]);
      if (entries.length) parts.push(`Top-level files: ${entries.join(", ")}`);

      const wantedFile = (step.folder || (!/\b(?:status|diff|log|files|tree|commits?)\b/i.test(step.prompt) ? step.prompt : "")).trim();
      if (wantedFile) {
        const candidate = path.resolve(ws.path, wantedFile);
        if (isInside(ws.path, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const content = fs.readFileSync(candidate, "utf8").slice(0, 8000);
          parts.push(`File ${wantedFile}:\n${content}`);
        }
      }
      const cleanStatus = statusOut.code === 0 && statusOut.stdout.trim() ? `${statusOut.stdout.trim().split("\n").length} modified/untracked` : "clean";
      return { summary: `${ws.name}: ${branchOut.stdout.trim() || "folder"} (${cleanStatus})`, details: parts.join("\n\n") };
    }
    return { summary: "Nothing found to inspect.", details: "No matching workspace, running CLI, or copy was found." };
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
    const copies = this.copies.list();
    this.conversation.workspacesKey = this.core.store
      .readWorkspaces()
      .workspaces.filter((w) => !copies.some((c) => c.openedWorkspaceId === w.id))
      .map((w) => `${w.id}:${w.name}`)
      .join("|");
    return id;
  }

  /**
   * Search VibeForge's run history, workspace git branches, and project folders on disk for a
   * session id, branch, or project folder.
   */
  async lookup(query: string): Promise<{ summary: string; details: string }> {
    const raw = query.trim();
    const tokens = raw
      .toLowerCase()
      .split(/[^\p{L}\p{N}._-]+/u)
      .filter((tok) => tok.length >= 2);
    const matches = (haystack: string) => {
      const lower = haystack.toLowerCase();
      if (lower.includes(raw.toLowerCase())) return true;
      return tokens.length > 0 && tokens.every((tok) => lower.includes(tok));
    };
    const anyToken = (haystack: string) => {
      const lower = haystack.toLowerCase();
      return tokens.some((tok) => tok.length >= 3 && lower.includes(tok));
    };
    const lines: string[] = [];
    const workspaces = this.core.store.readWorkspaces().workspaces;
    const wsById = new Map(workspaces.map((w) => [w.id, w]));

    // 1. VibeForge runs index + runs directory on disk
    const allRuns = this.core.store.queryRuns({ limit: 200 });
    const runHits = allRuns.filter((run) => {
      const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
      const blob = [run.id, run.title, run.engine, run.cwd, ws?.name ?? "", run.prompt ?? "", run.changes ?? ""].join(" ");
      return matches(blob);
    });
    const fallbackRuns = runHits.length
      ? runHits
      : allRuns.filter((run) => {
          const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
          const blob = [run.id, run.title, run.engine, run.cwd, ws?.name ?? "", run.prompt ?? ""].join(" ");
          return anyToken(blob);
        });
    for (const run of fallbackRuns.slice(0, 6)) {
      const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
      lines.push(
        `- Run ${run.id}: ${run.engine} in ${tildify(run.cwd)}${ws ? ` (workspace "${ws.name}")` : ""}${run.prompt ? ` — prompt: "${oneLine(run.prompt, 120)}"` : ""}`,
      );
    }

    // 2. Registered workspaces and their local git branches
    for (const ws of workspaces) {
      if (!isDirectory(ws.path)) continue;
      const branchOut = await gitIn(["branch", "--format=%(refname:short)"], ws.path);
      const branches = branchOut.code === 0 ? branchOut.stdout.split("\n").map((b) => b.trim()).filter(Boolean) : [];
      const hitBranches = branches.filter((b) => matches(b) || anyToken(b));
      if (matches(`${ws.name} ${ws.path}`) || hitBranches.length > 0) {
        lines.push(`- Workspace "${ws.name}" (${tildify(ws.path)})${hitBranches.length ? `: matching branches [${hitBranches.slice(0, 8).join(", ")}]` : ""}`);
      }
    }

    // 3. Project folders on disk, three levels down: only where projects are kept (the new-workspace
    // folder and ~/Projects), so no other folder's names are sent to the planner's provider.
    const roots = new Set<string>([path.resolve(expandHome(this.projectsFolder())), path.join(os.homedir(), "Projects")]);
    // A folder counts by its own name: the whole query first, then one word of it. A path counts
    // only for a query that is one ("ApexForge/VibeForge"); otherwise every folder inside a match
    // would match too and crowd the rest out. Read without blocking, and for a few seconds at most.
    const byPath = raw.includes("/");
    const strong: string[] = [];
    const weak: string[] = [];
    const seenDirs = new Set<string>();
    const deadline = Date.now() + LOOKUP_WALK_MS;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || strong.length >= LOOKUP_FOLDERS || Date.now() > deadline) return;
      let resolved: string;
      try {
        resolved = await fs.promises.realpath(dir);
      } catch {
        return;
      }
      if (seenDirs.has(resolved)) return;
      seenDirs.add(resolved);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "target") continue;
        const full = path.join(dir, entry.name);
        const line = () => `- Folder on disk: ${tildify(full)}${fs.existsSync(path.join(full, ".git")) ? " (git repository)" : ""}`;
        if (matches(entry.name) || (byPath && matches(tildify(full)))) strong.push(line());
        else if (weak.length < LOOKUP_FOLDERS && anyToken(entry.name)) weak.push(line());
        if (strong.length >= LOOKUP_FOLDERS) return;
        if (depth < 3) await walk(full, depth + 1);
      }
    };
    for (const root of roots) {
      if (isDirectory(root)) await walk(root, 1);
    }
    lines.push(...[...strong, ...weak].slice(0, LOOKUP_FOLDERS));

    if (!lines.length) {
      return {
        summary: `No runs, branches or folders matched "${oneLine(raw, 60)}".`,
        details: `No runs, git branches, or folders under ${[...new Set([this.projectsFolder(), "~/Projects"])].join(" or ")} matched "${raw}".`,
      };
    }
    return {
      summary: oneLine(lines[0].replace(/^- /, ""), 120),
      details: lines.join("\n"),
    };
  }

  // ---------------------------------------------------------------- hearing back

  /** When each CLI Maestro started began working, and when it was last spoken of. */
  private readonly workingSince = new Map<string, number>();
  private readonly lastNote = new Map<string, number>();
  /** Tells whose answer is still waited for in the CLI's own log, by terminal. */
  private readonly awaited = new Map<string, AbortController>();
  /** CLIs told something whose logs VibeForge can't read: the end of their next turn gets a word, as for one Viby started. */
  private readonly told = new Set<string>();

  /**
   * A tell went in: its answer gets a word when it comes, however short the work was. A CLI whose
   * log can't be read is listened to like one Viby started, for that one turn.
   */
  private hearBack(ptyId: string, words: string): void {
    this.awaited.get(ptyId)?.abort();
    this.awaited.delete(ptyId);
    const waiting = new AbortController();
    const answer = this.messages.awaitAnswer(ptyId, words, waiting.signal);
    if (!answer) {
      this.told.add(ptyId);
      return;
    }
    this.told.delete(ptyId);
    this.awaited.set(ptyId, waiting);
    void answer.then((reply) => {
      if (this.awaited.get(ptyId) !== waiting) return;
      this.awaited.delete(ptyId);
      const session = this.core.live.get(ptyId);
      if (reply === null || !session) return;
      // One word about a turn: going quiet after it says nothing more.
      const now = this.core.now().getTime();
      const last = this.lastNote.get(ptyId);
      if (last !== undefined && now - last < NOTE_EVERY_MS) return;
      this.lastNote.set(ptyId, now);
      return this.noteFinished(session, reply);
    });
  }

  private forgetTold(ptyId?: string): void {
    for (const [id, waiting] of this.awaited) {
      if (ptyId && id !== ptyId) continue;
      waiting.abort();
      this.awaited.delete(id);
    }
    if (ptyId) this.told.delete(ptyId);
    else this.told.clear();
  }

  /** A CLI went busy or quiet: one Maestro started (or told, see hearBack) that ends a turn after real work gets a word. */
  onActivity(ptyId: string, working: boolean): void {
    if (working) {
      this.clearFirstPrompt(ptyId);
      const pendingTimer = this.chainTimers.get(ptyId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.chainTimers.delete(ptyId);
      }
    } else if (this.chainWaiters.has(ptyId) && !this.chainTimers.has(ptyId)) {
      const timer = setTimeout(() => {
        this.chainTimers.delete(ptyId);
        const live = this.core.live.get(ptyId);
        if (!live?.working) this.settleChainWaiters(ptyId, true);
      }, this.chainSettleMs);
      timer.unref();
      this.chainTimers.set(ptyId, timer);
    }
    const session = this.core.live.get(ptyId);
    if (!session || (!session.orchestrated && !this.told.has(ptyId))) return;
    const now = this.core.now().getTime();
    if (working) {
      if (!this.workingSince.has(ptyId)) this.workingSince.set(ptyId, now);
      return;
    }
    const since = this.workingSince.get(ptyId);
    this.workingSince.delete(ptyId);
    if (since === undefined) return;
    // The turn it was told to take is over, long or short.
    this.told.delete(ptyId);
    if (now - since < NOTE_AFTER_WORK_MS) return;
    const last = this.lastNote.get(ptyId);
    if (last !== undefined && now - last < NOTE_EVERY_MS) return;
    this.lastNote.set(ptyId, now);
    void this.noteFinished(session);
  }

  /** A CLI Maestro started closed by itself (not stopped by a person or a step): a word, with what it changed. */
  onExit(session: LiveSession | undefined): void {
    if (!session) return;
    this.clearFirstPrompt(session.ptyId);
    this.forgetTold(session.ptyId);
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    this.settleChainWaiters(session.ptyId, !run?.stopRequested);
    if (!session.orchestrated) return;
    this.workingSince.delete(session.ptyId);
    this.lastNote.delete(session.ptyId);
    if (run?.stopRequested) return;
    this.addNote(session, "ended", run?.changes ?? null);
  }

  /** `answered` is its answer when that is known already; otherwise its own log is asked. */
  private async noteFinished(session: LiveSession, answered?: string): Promise<void> {
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    let changes: string | null = null;
    try {
      changes = summarizeSnapshot(await this.core.options.host.snapshotGit(session.programCwd || session.cwd, run?.gitStart ?? null));
    } catch {
      changes = null;
    }
    const reply = answered ?? (await this.messages.answerOf(session.ptyId, true).catch(() => ({ reply: "" }))).reply;
    // Gone while git was asked: its exit says so instead.
    if (!this.core.isLive(session.ptyId)) return;
    this.addNote(session, "finished", changes, reply);
  }

  /** A CLI as a note and a read step name it: "Claude Code", and its workspace. */
  private nameOf(session: LiveSession): { engine: string; workspace: string } {
    const workspace = session.workspaceId ? this.core.workspaceById(session.workspaceId) : null;
    return { engine: session.program || session.title.split(" · ")[0] || session.title, workspace: workspace?.name ?? session.title };
  }

  private addNote(session: LiveSession, kind: MaestroNote["kind"], changes: string | null, reply = ""): void {
    const copy = session.workspaceId ? this.copies.list().find((item) => item.openedWorkspaceId === session.workspaceId) : undefined;
    // The start of its answer: enough to know how it went, and short enough to be said in a call.
    const said = speakable(reply, "summary");
    const note: MaestroNote = {
      kind,
      ptyId: session.ptyId,
      runId: session.runId,
      ...this.nameOf(session),
      workspaceId: session.workspaceId,
      copyId: copy?.id ?? null,
      changes: changes && changes !== "No changes" ? changes : null,
      ...(said ? { reply: said } : {}),
    };
    this.conversation.turns.push({ id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", text: "", note });
    this.save();
    this.onCall?.({ kind: "note", note });
  }

  close(): void {
    this.forgetTold();
    for (const timer of this.firstPromptTimers.values()) clearTimeout(timer);
    this.firstPromptTimers.clear();
    for (const timer of this.chainTimers.values()) clearTimeout(timer);
    this.chainTimers.clear();
    for (const ptyId of [...this.chainWaiters.keys()]) this.settleChainWaiters(ptyId, false);
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

/** A repository with at least one commit, which a copy can be made from. */
async function hasCommit(folder: string): Promise<boolean> {
  return (await gitIn(["rev-parse", "--verify", "-q", "HEAD"], folder)).code === 0;
}

/** A task or routine step that is waiting for its folder (core.orchWaitsTurn). */
function waitsTurn(behind: readonly string[]): string {
  return `Waiting for ${behind.join(", ") || "another CLI"} in that folder; it starts on its own once it's quiet.`;
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
