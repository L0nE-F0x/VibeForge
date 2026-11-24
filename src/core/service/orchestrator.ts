import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCodingCli } from "../checkout.js";
import { readJson, writeJson } from "../fsx.js";
import {
  PLANNED_PREFIX,
  brainArgs,
  branchFromPrompt,
  claudeImageStdin,
  cleanBranch,
  detectWaitingPrompt,
  isApprovalPrompt,
  isFreeWaitingPrompt,
  emptyPromise,
  formatSettingsRules,
  holdsForGo,
  inspectsQuotas,
  inspectsStorage,
  keySequenceFor,
  lookingLine,
  normalizeMemoryAction,
  ONLY_LOOKS,
  parseVerifyOptions,
  plannedFolder,
  resolveLocalReflex,
  resolveSettingsStep,
  safeInCall,
  sessionGone,
  settingsFingerprint,
  withPlannedWorkspaces,
  type MaestroCopy,
  type MaestroNote,
  type PlanSettingsContext,
  type StepPatch,
  brainKind,
  canOrchestrate,
  KNOWN_MODELS,
  plannerFor,
  STEP_KINDS,
  STRICT_PLAN_SCHEMA,
  signedOut,
  orchestratorRules,
  readBrainOutput,
  resolvePlan,
  stepIssue,
  type Looking,
  type OrchestratorActivity,
  type OrchestratorCheck,
  type OrchestratorStep,
  type OrchestratorThreadSummary,
  type OrchestratorTurn,
  type OrchestratorView,
  type PlanContext,
  type VibyWord,
} from "../orchestrator.js";
import { cwdAllowed } from "../places.js";
import { speakable } from "../replies.js";
import { findSherpa } from "../sherpa.js";
import { repoKind } from "../sync/git-rescue.js";
import { listThemes } from "../theme.js";
import { isGitRepo, summarizeSnapshot } from "../vcs.js";
import {
  findPiper,
  findWhisper,
  isEnglishOnly,
  listenLanguage,
  modelBackend,
  pickModel,
  pickVoice,
  planRecorder,
  scanPiperVoices,
  scanVoiceModels,
  voiceName,
  type VoiceBackend,
} from "../voice.js";
import type { ApplyResult } from "../worktrees.js";
import type { ChatDesk } from "./chats.js";
import type { ServiceCore } from "./core.js";
import type { LibraryDesk } from "./library.js";
import type { MessageDesk } from "./messages.js";
import { MaestroCopies, type CopyOutcome } from "./orchestrator-copies.js";
import {
  carryOutAgentStep,
  carryOutChatStep,
  carryOutRoutineStep,
  carryOutRunStep,
  carryOutSettingsStep,
  carryOutSkillStep,
  carryOutTalkStep,
  carryOutTaskStep,
  carryOutWorkbenchStep,
  carryOutWorkspaceStep,
  type EntityStepDeps,
} from "./orchestrator-entities.js";
import { inspectOrchestratorStep, lookupOrchestrator, type InspectDeps } from "./orchestrator-inspect.js";
import {
  boundedVibyMemory,
  deleteSavedThread,
  deriveThreadTitle,
  listThreadSummaries,
  loadSavedThread,
  readSavedImageDataUrl,
  readVibyMemory,
  renameSavedThread,
  savePastedImages,
  saveThreadSnapshot,
  spawnVerifyCommand,
  vibyMemoryFile,
  writeVibyMemory,
  type SavedConversation,
  type SavedPromptImage,
  type VerifyRunner,
} from "./orchestrator-threads.js";
import {
  expandHome,
  formatApplyResult,
  formatLibraryUpdate,
  formatLiveUpdate,
  formatMemoryUpdate,
  hasCommit,
  isInside,
  libraryFingerprint,
  liveStateFingerprint,
  memoryFingerprint,
  oneLine,
  START_SIZE,
  tildify,
  uncommitted,
} from "./orchestrator-utils.js";
import type { LiveSession, Settings } from "../types.js";
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
/** A CLI Maestro started that worked at least this long before going quiet has finished a turn worth a word. */
const NOTE_AFTER_WORK_MS = 20_000;
/** At most one word about a CLI this often, so one that flickers between busy and quiet stays quiet. */
const NOTE_EVERY_MS = 60_000;
/** The most of a CLI's answer a read step keeps on its card. */
const READ_KEEP = 20_000;
/** Turns the planner is reminded of when its session is gone and a new one starts. */
const RECAP_TURNS = 6;
/** Brief cache window for planner context snapshots; invalidated immediately on any core change event. */
const CONTEXT_TTL_MS = 1500;
/** Maximum back-to-back lookup/inspect rounds Viby runs automatically before answering. */
const MAX_INSPECT_ROUNDS = 3;

interface Conversation {
  /** Stable thread id so conversations can be archived, switched, renamed, and deleted. */
  id: string;
  /** Short human title derived from the first ask or renamed explicitly. */
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The planning CLI's own session, resumed each turn so it remembers what was said. */
  sessionId: string;
  /** The engine that session belongs to; another engine starts a new one. */
  engineId: string;
  /** The session exists (its first turn went through), so the next turn resumes it. */
  begun: boolean;
  /** Turn-1 rendered rules kept stable across resumed Claude/Codex turns to preserve prompt caching. */
  initialRules?: string;
  /** Non-copy workspaces present when the session began, so adding one refreshes a planner that caches rules on turn 1. */
  workspacesKey?: string;
  /** Live workspace/running/copy fingerprint from the previous turn for delta updates on resumed cached sessions. */
  liveKey?: string;
  /** Settings fingerprint from the previous turn, so a resumed session hears when settings changed. */
  settingsKey?: string;
  /** Agents/skills/routines/tasks/chats fingerprint so a resumed session hears when library items changed. */
  libraryKey?: string;
  /** Viby durable memory (~/.config/vibeforge/viby.md) fingerprint from the previous turn. */
  memoryKey?: string;
  turns: OrchestratorTurn[];
}

export interface BrainRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one headless turn of a CLI. The real one spawns it; tests hand in their own. */
export type BrainRunner = (argv: string[], cwd: string, signal: AbortSignal, timeoutMs?: number, stdin?: string) => Promise<BrainRun>;

/** How long a planner has to end after SIGTERM before its whole process group is killed. */
const KILL_GRACE_MS = 3000;
/** Cap buffered planner stdout at 4 MB so runaway output cannot exhaust memory. */
const MAX_BRAIN_STDOUT = 4 * 1024 * 1024;

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
export const spawnBrain = (
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = BRAIN_TIMEOUT_MS,
  graceOrStdin: number | string = KILL_GRACE_MS,
  stdin?: string,
): Promise<BrainRun> =>
  new Promise((resolve) => {
    const graceMs = typeof graceOrStdin === "number" ? graceOrStdin : KILL_GRACE_MS;
    const input = typeof graceOrStdin === "string" ? graceOrStdin : stdin;
    const stdio: ["pipe" | "ignore", "pipe", "pipe"] = [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"];
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: plannerEnv(),
      stdio,
      detached: true,
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
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
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_BRAIN_STDOUT) stdout += chunk.slice(0, MAX_BRAIN_STDOUT - stdout.length);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8000)));
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
/** One step of a plan in a few words, for telling the planner what still waits for Go. */
export function stepSummary(step: OrchestratorStep): string {
  const parts: string[] = [step.kind];
  const action = (step as { action?: string }).action;
  if (action) parts.push(action);
  if (step.target) parts.push(step.target);
  if (step.engineId) parts.push(step.engineId);
  if (step.agentId) parts.push(`agent ${step.agentId}`);
  if (step.workspaceId) parts.push(`in ${step.workspaceId}`);
  const said = step.prompt.trim();
  if (said) parts.push(`"${said.length > 80 ? `${said.slice(0, 79)}…` : said}"`);
  return parts.join(" ");
}

export class OrchestratorDesk {
  private conversation: Conversation;
  private thinking: AbortController | null = null;
  private activity: OrchestratorActivity | null = null;
  private runEpoch = 0;
  private readonly runningPlans = new Map<string, Promise<void>>();
  /** Models each planner listed, kept for this run of VibeForge. */
  private readonly models = new Map<string, string[]>();
  private readonly copies: MaestroCopies;
  private readonly chainWaiters = new Map<string, Set<(ok: boolean) => void>>();
  private readonly chainTimers = new Map<string, NodeJS.Timeout>();
  private readonly firstPromptTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeVerifies = new Set<AbortController>();
  private cachedContext: { at: number; promise: Promise<PlanContext> } | null = null;
  runner: BrainRunner = spawnBrain;
  verifyRunner: VerifyRunner = spawnVerifyCommand;
  /** Quiet time before a chained `after: true` step considers the previous PTY turn settled. */
  chainSettleMs = 1200;
  /** How long a chained step waits on a terminal that never got busy before going ahead. */
  chainIdleMs = 15_000;
  /** Time before checking whether a newly started CLI is stuck on a folder-trust/permission prompt. */
  firstPromptMs = 8000;

  constructor(
    private readonly core: ServiceCore,
    private readonly workspaces: WorkspaceDesk,
    private readonly messages: MessageDesk,
    private readonly tasks?: TaskDesk,
    private readonly routines?: RoutineDesk,
    private readonly runs?: RunDesk,
    private readonly library?: LibraryDesk,
    private readonly chats?: ChatDesk,
  ) {
    this.conversation = this.load();
    this.copies = new MaestroCopies(core, workspaces, (copy, outcome) => this.copySettled(copy, outcome));
    this.core.onChange(() => {
      this.cachedContext = null;
    });
  }

  private get dir(): string {
    return path.join(this.core.options.dataRoot, "orchestrator");
  }

  private get threadsDir(): string {
    return path.join(this.dir, "threads");
  }

  private get imagesDir(): string {
    return path.join(this.dir, "images");
  }

  private toSaved(conv: Conversation): SavedConversation {
    const now = this.core.now().toISOString();
    return {
      id: conv.id,
      title: conv.title || deriveThreadTitle(conv.turns),
      createdAt: conv.createdAt || now,
      updatedAt: conv.turns.at(-1)?.at || conv.updatedAt || now,
      sessionId: conv.sessionId,
      engineId: conv.engineId,
      begun: conv.begun,
      ...(conv.initialRules ? { initialRules: conv.initialRules } : {}),
      ...(conv.workspacesKey !== undefined ? { workspacesKey: conv.workspacesKey } : {}),
      ...(conv.liveKey !== undefined ? { liveKey: conv.liveKey } : {}),
      ...(conv.settingsKey !== undefined ? { settingsKey: conv.settingsKey } : {}),
      ...(conv.libraryKey !== undefined ? { libraryKey: conv.libraryKey } : {}),
      ...(conv.memoryKey !== undefined ? { memoryKey: conv.memoryKey } : {}),
      turns: conv.turns,
    };
  }

  private load(): Conversation {
    const saved = readJson<Partial<Conversation> | null>(path.join(this.dir, "conversation.json"), null);
    const turns = Array.isArray(saved?.turns) ? saved.turns.filter((turn) => turn && typeof turn.text === "string") : [];
    // A plan that was running when VibeForge closed isn't any more.
    for (const turn of turns) {
      if (turn.plan === "running") turn.plan = "done";
      for (const step of turn.steps ?? []) if (step.state === "running") step.state = "failed";
    }
    const now = this.core.now().toISOString();
    return {
      id: typeof saved?.id === "string" && saved.id ? saved.id : randomUUID(),
      ...(typeof saved?.title === "string" && saved.title ? { title: saved.title } : {}),
      createdAt: typeof saved?.createdAt === "string" ? saved.createdAt : now,
      updatedAt: typeof saved?.updatedAt === "string" ? saved.updatedAt : now,
      sessionId: typeof saved?.sessionId === "string" && saved.sessionId ? saved.sessionId : randomUUID(),
      engineId: typeof saved?.engineId === "string" ? saved.engineId : "",
      begun: Boolean(saved?.begun),
      ...(typeof saved?.initialRules === "string" && saved.initialRules ? { initialRules: saved.initialRules } : {}),
      ...(typeof saved?.workspacesKey === "string" ? { workspacesKey: saved.workspacesKey } : {}),
      ...(typeof saved?.liveKey === "string" ? { liveKey: saved.liveKey } : {}),
      ...(typeof saved?.settingsKey === "string" ? { settingsKey: saved.settingsKey } : {}),
      ...(typeof saved?.libraryKey === "string" ? { libraryKey: saved.libraryKey } : {}),
      ...(typeof saved?.memoryKey === "string" ? { memoryKey: saved.memoryKey } : {}),
      turns,
    };
  }

  private save(): void {
    this.conversation.turns = this.conversation.turns.slice(-KEEP_TURNS);
    this.conversation.updatedAt = this.conversation.turns.at(-1)?.at || this.core.now().toISOString();
    if (!this.conversation.title && this.conversation.turns.some((turn) => turn.text.trim())) {
      this.conversation.title = deriveThreadTitle(this.conversation.turns);
    }
    writeJson(path.join(this.dir, "conversation.json"), this.conversation);
    if (this.conversation.turns.length) {
      saveThreadSnapshot(this.threadsDir, this.toSaved(this.conversation));
    }
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
      ...(this.activity ? { activity: this.activity } : {}),
      turns: this.conversation.turns,
      copies: this.copies.list(),
      projectsFolder: this.projectsFolder(),
      activeThreadId: this.conversation.id,
      threads: listThreadSummaries(this.threadsDir, this.toSaved(this.conversation)),
      hasMemory: Boolean(boundedVibyMemory(this.core.options.configRoot)),
    };
  }

  private setActivity(next: OrchestratorActivity | null): void {
    if (this.activity?.kind === next?.kind && this.activity?.label === next?.label) return;
    this.activity = next;
    this.core.emit("orchestrator");
  }

  private stepActivityLabel(step: OrchestratorStep, context: PlanContext): string {
    if (step.kind === "start") {
      const engine = context.engines.find((item) => item.id === step.engineId)?.label || step.engineId;
      const ws = context.workspaces.find((item) => item.id === step.workspaceId)?.name || step.asked;
      return step.branch ? `${engine} · ${step.branch}` : [engine, ws].filter(Boolean).join(" · ");
    }
    if (step.kind === "inspect") {
      if (inspectsQuotas(step.prompt)) return "plan limits";
      if (inspectsStorage(step.prompt) || step.action === "storage") return "storage";
      if (step.target) {
        const copy = context.copies?.find((item) => item.id === step.target);
        if (copy) return copy.name;
        const run = context.running.find((item) => item.id === step.target);
        if (run) return `${run.engine} · ${run.workspace}`;
      }
      if (step.workspaceId) return context.workspaces.find((item) => item.id === step.workspaceId)?.name || step.asked;
      return step.asked || step.prompt;
    }
    if (step.kind === "verify") return context.workspaces.find((item) => item.id === step.workspaceId)?.name || step.asked || step.prompt;
    if (step.kind === "memory") return step.asked || "Viby memory";
    if (step.kind === "lookup") return step.asked || step.prompt;
    if (step.kind === "workspace") return step.name || step.asked || "";
    if (step.kind === "tell" || step.kind === "read" || step.kind === "stop" || step.kind === "key") {
      const run = context.running.find((item) => item.id === step.target);
      return run ? `${run.engine} · ${run.workspace}` : step.asked;
    }
    if (step.kind === "apply" || step.kind === "discard") {
      const copy = context.copies?.find((item) => item.id === step.target);
      return copy ? copy.name : step.asked;
    }
    if (step.kind === "shell") return context.workspaces.find((item) => item.id === step.workspaceId)?.name || step.asked;
    return step.name || step.asked || step.view || step.prompt;
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
  async context(fresh = false): Promise<PlanContext> {
    if (!fresh && this.cachedContext && Date.now() - this.cachedContext.at < CONTEXT_TTL_MS) {
      return this.cachedContext.promise;
    }
    const promise = this.buildContext().catch((error) => {
      if (this.cachedContext?.promise === promise) this.cachedContext = null;
      throw error;
    });
    this.cachedContext = { at: Date.now(), promise };
    return promise;
  }

  private async buildContext(): Promise<PlanContext> {
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
    const rawSkills = this.core.store.listSkills();
    const skillNames = new Map(rawSkills.map((item) => [item.id, item.name]));
    const agents = rawAgents.map((item) => ({
      id: item.id,
      name: item.name,
      engine: item.engine,
      ...(item.goodAt ? { goodAt: item.goodAt } : {}),
      ...(item.places.length ? { places: item.places.map(tildify) } : {}),
      ...(item.skills.length ? { skills: item.skills.map((sid) => skillNames.get(sid) ?? sid) } : {}),
      allowRoutines: item.allowRoutines,
      ...(item.tier ? { tier: item.tier } : {}),
    }));
    const skills = rawSkills.map((item) => {
      const attached = rawAgents.filter((a) => a.skills.includes(item.id)).map((a) => a.name);
      return {
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        ...(attached.length ? { agents: attached } : {}),
      };
    });
    const rawTasks = this.tasks ? this.tasks.listTasks() : this.core.store.listTasks().map((t) => ({ ...t, waiting: null }));
    const tasks = rawTasks.slice(0, 25).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.workspaceId && names.get(item.workspaceId) ? { workspace: names.get(item.workspaceId) } : {}),
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
      ...(item.agentId && agentNames.get(item.agentId) ? { agent: agentNames.get(item.agentId) } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      isolated: item.isolated,
      ...(item.copy ? { hasCopy: true } : {}),
      ...(item.waiting ? { waiting: true } : {}),
    }));
    const routines = (this.routines ? this.routines.listRoutines() : []).map((item) => ({
      id: item.id,
      name: item.name,
      schedule: item.description,
      enabled: item.enabled,
      ...(item.agentName ? { agent: item.agentName } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      notify: item.notify,
      shareCheckout: item.shareCheckout,
      ...(item.waiting ? { waiting: true } : {}),
      ...(item.stillRunning ? { running: true } : {}),
    }));
    const rawChats = this.chats ? this.chats.listChats() : [];
    const chats = [...rawChats]
      .sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        title: item.title,
        engine: item.engine,
        ...(item.agentId && agentNames.get(item.agentId) ? { agent: agentNames.get(item.agentId) } : {}),
        agentId: item.agentId,
        live: item.live,
      }));
    const runs = this.core.store.queryRuns({ limit: 15 }).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      engine: item.engine,
      origin: item.origin,
      opened: Boolean(item.openedAt),
      ...(item.changes ? { changes: item.changes } : {}),
      ...(item.agentId && agentNames.get(item.agentId) ? { agent: agentNames.get(item.agentId) } : {}),
    }));
    const allSettings = this.core.store.readSettings();
    const defaultPick = allSettings.defaultEngine;
    const defaultEngine = defaultPick && this.core.resolveEngine(defaultPick) ? defaultPick : undefined;
    const memory = boundedVibyMemory(this.core.options.configRoot);
    return {
      workspaces,
      engines: rows.map((row) => ({ id: row.id, label: row.label, available: Boolean(this.core.resolveEngine(row.id)), bin: row.bin })),
      ...(defaultEngine ? { defaultEngine } : {}),
      running,
      copies: copies.map((item) => ({ id: item.id, name: item.name, branch: item.branch, workspace: names.get(item.workspaceId) ?? item.workspaceId })),
      ...(agents.length ? { agents } : {}),
      ...(skills.length ? { skills } : {}),
      ...(tasks.length ? { tasks } : {}),
      ...(routines.length ? { routines } : {}),
      ...(chats.length ? { chats } : {}),
      ...(runs.length ? { runs } : {}),
      ...(memory ? { memory } : {}),
      projectsFolder: this.projectsFolder(),
      settings: this.buildSettingsContext(allSettings, rows),
    };
  }

  private buildSettingsContext(all: Settings = this.core.store.readSettings(), rows = this.core.store.readEngineRows()): PlanSettingsContext {
    const planner = this.planner();
    const availablePlanners = rows
      .filter((row) => canOrchestrate(row))
      .map((row) => {
        const kind = brainKind(row);
        const models = (kind && KNOWN_MODELS[kind]) ?? this.models.get(row.id) ?? [];
        return {
          id: row.id,
          label: row.label,
          available: Boolean(this.core.resolveEngine(row.id)),
          models: [...models],
          efforts: [...effortLevels(row)],
        };
      });

    const hostVoice = this.core.options.host.voiceStatus?.();
    const home = os.homedir();
    const dataRoot = this.core.options.dataRoot;
    const models = hostVoice ? hostVoice.models : scanVoiceModels(home, dataRoot);
    const voices = hostVoice ? hostVoice.voices : scanPiperVoices(home, dataRoot);
    const whisper = hostVoice
      ? { server: hostVoice.server, cli: hostVoice.cli }
      : findWhisper(this.core.options.host.resolveBin, { server: process.env.VIBEFORGE_WHISPER_SERVER, cli: process.env.VIBEFORGE_WHISPER_CLI });
    const sherpaCli = hostVoice
      ? (hostVoice.sherpa ?? null)
      : findSherpa(this.core.options.host.resolveBin, dataRoot, { cli: process.env.VIBEFORGE_SHERPA_CLI }).cli;
    const recorder = hostVoice
      ? hostVoice.recorder
      : (planRecorder(this.core.options.host.resolveBin, process.env.VIBEFORGE_VOICE_RECORDER)?.label ?? null);
    const piper = hostVoice ? hostVoice.piper : findPiper(this.core.options.host.resolveBin, process.env.VIBEFORGE_PIPER);

    const backends = new Set<VoiceBackend>();
    if (whisper.server || whisper.cli) backends.add("whisper");
    if (sherpaCli) backends.add("sherpa");
    const runnableModel = hostVoice ? (hostVoice.ready ? hostVoice.model : null) : pickModel(models, all.voice.model, all.voice.language, backends);
    const activeModelPath = hostVoice ? hostVoice.model : (runnableModel ?? pickModel(models, all.voice.model, all.voice.language));
    const activeSpeakerPath = hostVoice
      ? hostVoice.speaker
      : pickVoice(voices, all.voice.speaker, all.language === "system" ? "en" : all.language);

    let availableThemes: string[] = [];
    try {
      availableThemes = listThemes().themes.map((t) => t.id);
    } catch {
      availableThemes = [];
    }

    return {
      viby: {
        planner,
        pickedEngine: all.orchestrator.engine,
        mode: all.orchestrator.mode,
        model: planner && planner === all.orchestrator.engine ? all.orchestrator.model : "",
        effort: planner && planner === all.orchestrator.engine ? (all.orchestrator.effort ?? "") : "",
        projectsFolder: this.projectsFolder(),
        availablePlanners,
      },
      voice: {
        ready: hostVoice ? hostVoice.ready : Boolean(recorder && runnableModel),
        activeModel: activeModelPath ? path.basename(activeModelPath) : "",
        pickedModel: all.voice.model ? path.basename(all.voice.model) : "",
        installedModels: models.map((file) => ({
          name: path.basename(file),
          path: file,
          backend: modelBackend(file),
          englishOnly: isEnglishOnly(file),
        })),
        runtimes: {
          whisperServer: Boolean(whisper.server),
          whisperCli: Boolean(whisper.cli),
          sherpa: Boolean(sherpaCli),
          recorder,
          piper: Boolean(piper),
        },
        language: activeModelPath ? listenLanguage(activeModelPath, all.voice.language) : all.voice.language,
        talkBack: all.voice.talkBack,
        talkOver: all.voice.talkOver,
        activeSpeaker: activeSpeakerPath ? voiceName(activeSpeakerPath) : "",
        pickedSpeaker: all.voice.speaker ? voiceName(all.voice.speaker) : "",
        installedVoices: voices.map((file) => ({ name: voiceName(file), path: file })),
        mouseButton: all.voice.mouseButton,
        sendButton: all.voice.sendButton,
        agent: all.voice.agent,
      },
      app: {
        defaultEngine: all.defaultEngine,
        defaultShell: all.defaultShell,
        theme: all.theme,
        ...(availableThemes.length ? { availableThemes } : {}),
        language: all.language,
        terminalFontSize: all.terminalFontSize,
        terminalFontFamily: all.terminalFontFamily,
        notify: all.notify,
        sounds: { ...all.sounds },
        tray: all.tray,
        closeToTray: all.closeToTray,
        ...(this.core.options.host.autostart ? { autostart: this.core.options.host.autostart.get() } : {}),
        usage: all.usage,
        planLimits: all.planLimits,
        quotaAlerts: all.quotaAlerts,
        activity: all.activity,
        checkUpdates: all.checkUpdates,
        companion: { enabled: all.companion.enabled, port: all.companion.port },
        sync: { enabled: all.sync.enabled, name: all.sync.name },
        agentTalk: { ...all.agentTalk },
        keepRuns: { ...all.keepRuns },
        ...(all.terminalPassthrough ? { terminalPassthrough: true } : {}),
      },
    };
  }

  /**
   * The call that is on, or null. While one is, the window follows Viby: a CLI it starts or tells
   * comes up in Code, without the window being raised over whatever else the person has in front.
   * And the call is handed what Viby has to say by itself: a note about a CLI, an answer read out.
   */
  onCall: ((word: VibyWord) => void) | null = null;
  looking: Looking | null = null;

  private followTo(workspaceId: string | null | undefined, ptyId: string, force = false): void {
    if (!this.onCall) return;
    // While the person is in Viby's own call panel, keep them there: the chip under Viby's reply opens Code on tap.
    if (!force && this.looking?.view === "orchestrator") return;
    this.core.options.host.show?.({ view: "code", ...(workspaceId ? { workspaceId } : {}), ptyId }, false);
  }

  /** Read a saved image thumbnail as a data URL for desktop or phone preview. */
  imageData(name: string): string | null {
    return readSavedImageDataUrl(this.imagesDir, name);
  }

  /**
   * What the person said or typed. The answer, and any plan, arrive as later turns. `looking` is
   * where they are in the window, which the planner is told so "this one" and "here" mean something.
   */
  async ask(text: string, looking?: Looking | null, images?: string[]): Promise<void> {
    const words = text.trim();
    if (!words && !images?.length) return;
    if (this.thinking) throw new Error("Viby is still answering. Wait for it, or stop it.");
    const savedImages = savePastedImages(this.imagesDir, images);
    if (looking !== undefined) this.looking = looking;
    const now = this.core.now().toISOString();
    const filenames = savedImages.map((img) => img.filename);
    this.conversation.turns.push({
      id: turnId(),
      at: now,
      from: "you",
      text: words,
      ...(filenames.length ? { images: filenames } : {}),
    });
    const controller = new AbortController();
    this.thinking = controller;
    this.save();
    try {
      const promptText = words || "Please examine the attached screenshot(s).";
      await this.think(promptText, controller.signal, looking ?? this.looking, savedImages);
    } finally {
      if (this.thinking === controller) {
        this.thinking = null;
        this.activity = null;
      }
      this.save();
    }
  }

  private answer(turn: Omit<OrchestratorTurn, "id" | "at" | "from">): OrchestratorTurn {
    const full: OrchestratorTurn = { id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", by: this.planner() || this.settings().engine, ...turn };
    this.conversation.turns.push(full);
    return full;
  }

  private async think(words: string, signal: AbortSignal, looking: Looking | null, savedImages: SavedPromptImage[] = []): Promise<void> {
    const { engine: picked, mode, model: chosen, effort: chosenEffort } = this.settings();
    const engineId = this.planner();
    // A model or effort picked for another planner means nothing to this one.
    const explicitModel = engineId === picked ? chosen : "";
    const explicitEffort = engineId === picked ? (chosenEffort ?? "") : "";
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
    const currentLiveKey = liveStateFingerprint(context);
    const currentSettingsKey = settingsFingerprint(context.settings);
    const currentLibraryKey = libraryFingerprint(context);
    const currentMemoryKey = memoryFingerprint(context.memory ?? "");
    const switchedEngine = Boolean(this.conversation.engineId && this.conversation.engineId !== engineId);
    const plannerKind = brainKind(engine.row);
    const workspacesChanged = Boolean(
      this.conversation.begun &&
        this.conversation.workspacesKey !== undefined &&
        this.conversation.workspacesKey !== currentWorkspacesKey &&
        plannerKind === "grok",
    );
    if (this.conversation.engineId !== engineId || workspacesChanged) {
      this.conversation = {
        ...this.conversation,
        sessionId: randomUUID(),
        engineId,
        begun: false,
        initialRules: undefined,
        workspacesKey: currentWorkspacesKey,
        liveKey: currentLiveKey,
        settingsKey: currentSettingsKey,
        libraryKey: currentLibraryKey,
        memoryKey: currentMemoryKey,
      };
    }
    const settingsChanged = Boolean(
      this.conversation.begun &&
        this.conversation.settingsKey !== undefined &&
        this.conversation.settingsKey !== currentSettingsKey &&
        context.settings,
    );
    const libraryChanged = Boolean(
      this.conversation.begun &&
        this.conversation.libraryKey !== undefined &&
        this.conversation.libraryKey !== currentLibraryKey,
    );
    const memoryChanged = Boolean(
      this.conversation.begun &&
        this.conversation.memoryKey !== undefined &&
        this.conversation.memoryKey !== currentMemoryKey,
    );
    const settingsLine = settingsChanged && context.settings ? `(Updated settings:\n${formatSettingsRules(context.settings, { slim: true }).join("\n")})` : "";
    const libraryLine = libraryChanged ? formatLibraryUpdate(context) : "";
    const memoryLine = memoryChanged ? formatMemoryUpdate(context.memory ?? "") : "";
    const work = path.join(this.dir, "work");
    fs.mkdirSync(work, { recursive: true });
    // Codex reads the schema from a file.
    const schemaFile = path.join(work, "plan-schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(STRICT_PLAN_SCHEMA));
    // Said ahead of every request, not in the rules: a resumed session may not read those again.
    const here = lookingLine(looking, context);
    const imageLine = savedImages.length
      ? `(${savedImages.length === 1 ? "Attached screenshot saved on disk" : "Attached screenshots saved on disk"}: ${savedImages.map((img) => img.path).join(", ")})`
      : "";
    // A plan that waits for Go hasn't run: say so, or the planner takes "great" or "you didn't do it"
    // as thanks for work it only proposed (a real call, 2026-11-25).
    const waiting = [...this.conversation.turns].reverse().find((item) => item.plan === "waiting" && item.steps?.length);
    const waitingLine = waiting?.steps?.length ? `(Your last plan is waiting for the person's Go and has NOT run yet: ${waiting.steps.map(stepSummary).join("; ")}.)` : "";
    let capturedInitialRules = this.conversation.initialRules;
    const turn = async (said: string, ctx: PlanContext = context, includeImages = false) => {
      const keepPromptCache = this.conversation.begun && (plannerKind === "claude" || plannerKind === "codex") && Boolean(this.conversation.initialRules);
      const liveChanged = keepPromptCache && this.conversation.liveKey !== undefined && this.conversation.liveKey !== liveStateFingerprint(ctx);
      const liveLine = liveChanged ? formatLiveUpdate(ctx) : "";
      const rules = keepPromptCache ? this.conversation.initialRules! : orchestratorRules(ctx);
      if (!this.conversation.begun) capturedInitialRules = rules;
      const turnImages = includeImages ? savedImages : [];
      const prefix = [
        here,
        waitingLine,
        includeImages ? imageLine : "",
        liveLine,
        this.conversation.begun ? settingsLine : "",
        this.conversation.begun ? libraryLine : "",
        this.conversation.begun ? memoryLine : "",
      ]
        .filter(Boolean)
        .join("\n");
      const text = prefix ? `${prefix}\n${said}` : said;
      const args = brainArgs(engine.row, {
        text,
        rules,
        sessionId: this.conversation.sessionId,
        resume: this.conversation.begun,
        model,
        effort: explicitEffort,
        schemaFile,
        ...(turnImages.length ? { images: turnImages.map((img) => img.path) } : {}),
      });
      if (!args) return null;
      if (plannerKind === "claude" && turnImages.length) {
        const stdin = claudeImageStdin(text, turnImages);
        return this.runner([engine.binPath, ...args], work, signal, undefined, stdin);
      }
      return this.runner([engine.binPath, ...args], work, signal);
    };
    const initialText = (switchedEngine || workspacesChanged) && !this.conversation.begun ? this.recap(words) : words;
    let run = await turn(initialText, context, true);
    if (!run) {
      this.answer({ text: "", problem: "noEngine" });
      return;
    }
    let output = readBrainOutput(run.stdout);
    // The session it was asked to resume is gone (tidied away by the CLI): start a new one, once,
    // reminded of what was said lately.
    if (!signal.aborted && !run.timedOut && this.conversation.begun && !output.plan && (run.code !== 0 || output.error) && sessionGone(`${output.error}\n${run.stderr}\n${run.stdout}`)) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), begun: false, initialRules: undefined, liveKey: undefined };
      const retried = await turn(this.recap(words), context, true);
      if (retried) {
        run = retried;
        output = readBrainOutput(run.stdout);
      }
    }
    // A planner that says it is searching, checking, or starting something right now while returning
    // steps: [] (e.g. a resumed session with stale rules or acting as if a tool turn follows):
    // start a fresh session with the current workspace and running lists and ask once for real steps.
    if (!signal.aborted && !run.timedOut && output.plan && !output.plan.steps.length && emptyPromise(output.plan.say)) {
      this.conversation = { ...this.conversation, sessionId: randomUUID(), begun: false, initialRules: undefined, liveKey: undefined };
      const retried = await turn(
        [
          this.recap(words),
          "",
          `(Your draft answer said "${oneLine(output.plan.say, 200)}" with steps: []. Nothing runs after your answer unless you include steps, and you cannot search or check files yourself. Either return the steps to carry out now using the workspaces and CLIs listed in the rules, or emit a lookup step to search disk and run history, or tell the person plainly what you cannot see and ask.)`,
        ].join("\n"),
        context,
        true,
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
    if (!this.conversation.initialRules && capturedInitialRules) this.conversation.initialRules = capturedInitialRules;
    this.conversation.workspacesKey = currentWorkspacesKey;
    this.conversation.liveKey = currentLiveKey;
    this.conversation.settingsKey = currentSettingsKey;
    this.conversation.libraryKey = currentLibraryKey;
    this.conversation.memoryKey = currentMemoryKey;
    if (!plan) {
      this.answer({ text: "", problem: "unreadable", detail: lastLines(text) });
      return;
    }
    let currentContext = context;
    let steps = resolvePlan(plan, currentContext);
    const droppedKinds = (rawSteps: NonNullable<typeof plan>["steps"]) => rawSteps.map((s) => s.kind).filter((k) => k && !(STEP_KINDS as readonly string[]).includes(k));
    let unknownKinds = droppedKinds(plan.steps);
    const checks: OrchestratorCheck[] = [];
    const seenChecks = new Set<string>();
    const checkKey = (step: OrchestratorStep) => `${step.kind}:${step.action ?? ""}:${step.workspaceId}:${step.target}:${step.prompt}`;
    // A plan whose steps are only lookups or inspections: VibeForge gathers the findings (up to
    // MAX_INSPECT_ROUNDS rounds with deduplication) and hands them back so Viby can answer or
    // give the concrete steps in the same turn.
    for (let round = 0; round < MAX_INSPECT_ROUNDS; round += 1) {
      if (signal.aborted || unknownKinds.length || !steps.length) break;
      if (!steps.every((step) => (step.kind === "lookup" || step.kind === "inspect") && !stepIssue(step, currentContext))) break;
      const freshSteps = steps.filter((step) => !seenChecks.has(checkKey(step)));
      if (!freshSteps.length) {
        steps = [];
        unknownKinds = [];
        break;
      }
      for (const step of freshSteps) seenChecks.add(checkKey(step));
      this.setActivity({ kind: freshSteps[0].kind, label: this.stepActivityLabel(freshSteps[0], currentContext) });
      const results = await Promise.all(freshSteps.map((step) => (step.kind === "lookup" ? this.lookup(step.prompt) : this.inspect(step))));
      this.setActivity(null);
      if (signal.aborted) return;
      const currentCopies = currentContext.copies ?? copies;
      checks.push(
        ...freshSteps.map((step, idx) => {
          const copy = step.kind === "inspect" ? currentCopies.find((item) => item.id === step.target) : undefined;
          const session = step.kind === "inspect" && step.target ? this.core.live.get(step.target) : undefined;
          return {
            id: step.id,
            kind: step.kind as "lookup" | "inspect",
            label: this.stepActivityLabel(step, currentContext),
            summary: results[idx].summary,
            details: results[idx].details.slice(0, 6000),
            ...(session ? { ptyId: session.ptyId, workspaceId: session.workspaceId } : step.workspaceId ? { workspaceId: step.workspaceId } : {}),
            ...(copy ? { copyId: copy.id } : {}),
          };
        }),
      );
      const details = results
        .map((res, idx) => `${freshSteps[idx].kind === "lookup" ? "Lookup" : "Inspection"} "${freshSteps[idx].asked || freshSteps[idx].prompt}":\n${res.details}`)
        .join("\n\n");
      const guidance =
        round < MAX_INSPECT_ROUNDS - 1
          ? `Now answer the person's request ("${words}") using these exact findings. Return concrete steps to carry it out, emit further inspect/lookup steps ONLY if a critical detail is still missing, or answer clearly in say with steps: [] if nothing should be started.`
          : `Now answer the person's request ("${words}") using these exact findings. Return the concrete steps to carry it out now, or answer clearly in say with steps: [] if nothing should be started.`;
      const followUp = await turn(["[Findings from VibeForge]", details, "", guidance].join("\n"), currentContext);
      let followed = false;
      if (followUp && !signal.aborted && !followUp.timedOut) {
        const nextOut = readBrainOutput(followUp.stdout);
        if (nextOut.sessionId) this.conversation.sessionId = nextOut.sessionId;
        if (nextOut.plan) {
          plan = nextOut.plan;
          currentContext = await this.context(true);
          if (signal.aborted) return;
          this.conversation.liveKey = liveStateFingerprint(currentContext);
          this.conversation.settingsKey = settingsFingerprint(currentContext.settings);
          this.conversation.libraryKey = libraryFingerprint(currentContext);
          this.conversation.memoryKey = memoryFingerprint(currentContext.memory ?? "");
          steps = resolvePlan(plan, currentContext);
          unknownKinds = droppedKinds(plan.steps);
          followed = true;
        }
      }
      if (signal.aborted) return;
      // No answer to the findings: they are the answer (on its checks), not a plan to inspect it all again.
      if (!followed) {
        steps = [];
        unknownKinds = [];
        break;
      }
    }
    if (unknownKinds.length) {
      const note = `Skipped unsupported step: ${[...new Set(unknownKinds)].join(", ")}.`;
      plan = { ...plan, say: plan.say ? `${plan.say} (${note})` : note };
    }
    if (!steps.length) {
      this.answer({ text: plan.say, ...(checks.length ? { checks } : {}), ...(plan.hangup ? { hangup: true } : {}) });
      if (plan.hangup) this.onCall?.({ kind: "hangup" });
      return;
    }
    await this.markDirty(steps);
    const inPlaceDirty = this.onCall ? await this.hasDirtyInPlace(steps) : false;
    // A new plan takes the place of one still waiting for Go.
    for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
    const answered = this.answer({ text: plan.say, ...(checks.length ? { checks } : {}), steps, plan: "waiting", ...(plan.hangup ? { hangup: true } : {}) });
    // Just go: at once, unless a step needs fixing, or would stop, apply or throw away someone's work.
    // Showing something or reading an answer out changes nothing, so a plan of only those goes at once either way.
    // In a voice call, safe steps (isolated branch copies, workspaces, tells, tasks, routines) also go at once.
    const checked = withPlannedWorkspaces(currentContext, steps);
    const ready = steps.every((step) => !stepIssue(step, checked));
    const callSafe = Boolean(this.onCall) && !inPlaceDirty && steps.every((step) => safeInCall(step, checked));
    if (ready && !unknownKinds.length && (steps.every((step) => ONLY_LOOKS.includes(step.kind)) || callSafe || (mode === "go" && steps.every((step) => !holdsForGo(step, checked))))) {
      void this.run(answered.id, true);
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
        const workspace = this.core.workspaceById(step.workspaceId);
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
    this.activity = null;
    if (!silent) this.answer({ text: "", problem: "stopped" });
    this.save();
  }

  private cancelInFlight(): void {
    this.thinking?.abort();
    this.thinking = null;
    this.activity = null;
    for (const ac of this.activeVerifies) ac.abort();
    this.activeVerifies.clear();
    this.forgetTold();
    this.runEpoch += 1;
    // Plans waiting on a terminal to finish end now, instead of staying "running" in the old conversation.
    for (const ptyId of [...this.chainWaiters.keys()]) this.settleChainWaiters(ptyId, false);
  }

  /** Start over: archive the current non-empty conversation, then begin a fresh thread and planner session. */
  clear(): void {
    if (this.conversation.turns.length) {
      saveThreadSnapshot(this.threadsDir, this.toSaved(this.conversation));
    }
    this.cancelInFlight();
    const now = this.core.now().toISOString();
    this.conversation = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      sessionId: randomUUID(),
      engineId: this.planner(),
      begun: false,
      turns: [],
    };
    this.save();
  }

  readMemory(): string {
    return readVibyMemory(this.core.options.configRoot);
  }

  writeMemory(text: string): void {
    writeVibyMemory(this.core.options.configRoot, text);
    this.cachedContext = null;
    this.core.emit("orchestrator");
  }

  listThreads(): OrchestratorThreadSummary[] {
    return listThreadSummaries(this.threadsDir, this.toSaved(this.conversation));
  }

  selectThread(id: string): void {
    if (id === this.conversation.id) return;
    if (this.conversation.turns.length) {
      saveThreadSnapshot(this.threadsDir, this.toSaved(this.conversation));
    }
    this.cancelInFlight();
    const loaded = loadSavedThread(this.threadsDir, id);
    this.conversation = {
      id: loaded.id,
      title: loaded.title,
      createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt,
      sessionId: loaded.sessionId,
      engineId: loaded.engineId,
      begun: loaded.begun,
      ...(loaded.initialRules ? { initialRules: loaded.initialRules } : {}),
      ...(loaded.workspacesKey !== undefined ? { workspacesKey: loaded.workspacesKey } : {}),
      ...(loaded.liveKey !== undefined ? { liveKey: loaded.liveKey } : {}),
      ...(loaded.settingsKey !== undefined ? { settingsKey: loaded.settingsKey } : {}),
      ...(loaded.libraryKey !== undefined ? { libraryKey: loaded.libraryKey } : {}),
      ...(loaded.memoryKey !== undefined ? { memoryKey: loaded.memoryKey } : {}),
      turns: loaded.turns,
    };
    this.save();
  }

  renameThread(id: string, title: string): void {
    const active = renameSavedThread(this.threadsDir, id, title, this.toSaved(this.conversation));
    if (active) {
      this.conversation.title = oneLine(title, 80);
      this.save();
    } else {
      this.core.emit("orchestrator");
    }
  }

  deleteThread(id: string): Deleted {
    if (id === this.conversation.id) {
      if (this.conversation.turns.length) {
        saveThreadSnapshot(this.threadsDir, this.toSaved(this.conversation));
      }
      const deleted = deleteSavedThread(this.core, this.threadsDir, id, () => this.core.emit("orchestrator"));
      this.cancelInFlight();
      const now = this.core.now().toISOString();
      this.conversation = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        sessionId: randomUUID(),
        engineId: this.planner(),
        begun: false,
        turns: [],
      };
      this.save();
      return deleted;
    }
    return deleteSavedThread(this.core, this.threadsDir, id, () => this.core.emit("orchestrator"));
  }

  /**
   * 0ms local reflex dispatch for deterministic slash commands, waiting-plan approvals/cancels,
   * undo, mark-reviewed, memory append, stop-all, and single-intent view/workspace navigation.
   */
  async quickAct(
    text: string,
    looking?: Looking | null,
    words?: {
      going?: string;
      cancelled?: string;
      newThread?: string;
      undone?: string;
      reviewed?: string;
      remembered?: (note: string) => string;
      stopped?: (count: number) => string;
      opened?: (label: string) => string;
    },
  ): Promise<{ handled: boolean; reply?: string }> {
    const trimmed = text.trim();
    if (!trimmed || this.thinking) return { handled: false };
    const waitingPlan = [...this.conversation.turns].reverse().find((turn) => turn.plan === "waiting" && turn.steps?.length);
    const currentLooking = looking !== undefined ? looking : this.looking;
    const context = await this.context();
    const reflex = resolveLocalReflex(trimmed, context, currentLooking, Boolean(waitingPlan));
    if (!reflex) return { handled: false };
    if (looking !== undefined) this.looking = looking;
    if (reflex.kind === "plan-go" && waitingPlan) {
      void this.run(waitingPlan.id).catch(() => undefined);
      return { handled: true, reply: words?.going ?? "On it." };
    }
    if (reflex.kind === "plan-cancel" && waitingPlan) {
      this.cancel(waitingPlan.id);
      return { handled: true, reply: words?.cancelled ?? "Cancelled." };
    }
    if (reflex.kind === "new-thread") {
      this.clear();
      return { handled: true, reply: words?.newThread ?? "Started a new conversation." };
    }
    if (reflex.kind !== "steps") return { handled: false };
    if (reflex.tag === "show" && !this.core.options.host.show) return { handled: false };
    const steps = resolvePlan({ say: "", steps: reflex.rawSteps }, context);
    if (!steps.length || steps.some((step) => stepIssue(step, context))) return { handled: false };
    const now = this.core.now().toISOString();
    this.conversation.turns.push({ id: turnId(), at: now, from: "you", text: trimmed });
    const reply =
      reflex.tag === "show"
        ? (words?.opened?.(reflex.label) ?? `Opened ${reflex.label}.`)
        : reflex.tag === "undo"
          ? (words?.undone ?? "Restored.")
          : reflex.tag === "reviewed"
            ? (words?.reviewed ?? "Marked all runs reviewed.")
            : reflex.tag === "remember"
              ? (words?.remembered?.(reflex.label) ?? `Remembered in Viby memory: ${reflex.label}`)
              : (words?.stopped?.(steps.length) ?? `Stopped ${steps.length} running CLI${steps.length === 1 ? "" : "s"}.`);
    const answered = this.answer({ text: reply, steps, plan: "running" });
    for (const step of steps) {
      step.state = "running";
      try {
        await this.carryOut(answered, step);
        step.state = "done";
      } catch (error) {
        step.state = "failed";
        step.error = error instanceof Error ? error.message : String(error);
      }
    }
    answered.plan = "done";
    this.save();
    return { handled: true, reply };
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
    for (const key of ["engineId", "agentId", "workspaceId", "branch", "prompt", "target", "model", "effort", "name", "folder", "description", "schedule", "status", "options"] as const) {
      if (typeof patch[key] === "string") clean[key] = patch[key];
    }
    if (typeof clean.branch === "string") clean.branch = cleanBranch(clean.branch);
    if (typeof clean.model === "string") clean.model = cleanModel(clean.model);
    if (typeof clean.effort === "string") clean.effort = clean.effort.trim().toLowerCase();
    if (typeof patch.git === "boolean") clean.git = patch.git;
    if (current.kind === "workspace" && (!current.action || current.action === "create") && typeof clean.name === "string" && !("folder" in clean)) {
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
        if (nextPrompt && ws && repoKind(ws.path) !== "none") {
          clean.branch = branchFromPrompt(nextPrompt);
        }
      }
    }
    const nextStep: OrchestratorStep = { ...current, ...clean };
    if (nextStep.kind === "settings") {
      const rows = this.core.store.readEngineRows();
      const agents = this.core.store.listAgents().map((item) => ({ id: item.id, name: item.name }));
      const resolved = resolveSettingsStep(
        {
          target: nextStep.target,
          prompt: nextStep.prompt,
          engine: nextStep.engineId,
          model: nextStep.model,
          effort: nextStep.effort,
          folder: nextStep.folder,
          branch: nextStep.branch,
          name: nextStep.name,
          options: nextStep.options,
        },
        {
          engines: rows.map((row) => ({ id: row.id, label: row.label, available: Boolean(this.core.resolveEngine(row.id)), bin: row.bin })),
          agents,
          settings: this.buildSettingsContext(),
        },
      );
      nextStep.asked = resolved.asked;
    }
    steps[at] = nextStep;
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
  async run(turnIdValue: string, auto = false): Promise<void> {
    const existing = this.runningPlans.get(turnIdValue);
    if (existing) return existing;
    const turn = this.plan(turnIdValue);
    if (turn.plan !== "waiting") return;
    const work = this.runSteps(turn, auto);
    this.runningPlans.set(turnIdValue, work);
    try {
      await work;
    } finally {
      this.runningPlans.delete(turnIdValue);
    }
  }

  private async runSteps(turn: OrchestratorTurn, auto = false): Promise<void> {
    const epoch = this.runEpoch;
    turn.plan = "running";
    this.save();
    let wavePtys: string[] = [];
    let lastSourceWorkspaceId: string | null = null;
    let lastOpenedWorkspaceId: string | null = null;
    // Whether the step or wave before carried out: one marked `after` depends on it, so it doesn't run when
    // that failed or was skipped ("fix it, then push" must not push a fix that never started).
    let prevOk = true;
    for (const step of turn.steps ?? []) {
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (step.after && !prevOk) {
        step.state = "skipped";
        this.save();
        continue;
      }
      if (step.after && wavePtys.length) {
        const waitingOn = [...wavePtys];
        wavePtys = [];
        const settled = await Promise.all(waitingOn.map((ptyId) => this.waitForChainedPty(ptyId, epoch, turn)));
        if (!settled.every(Boolean) || this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) {
          step.state = "skipped";
          prevOk = false;
          this.save();
          continue;
        }
        // A follow-up shell, verify, or inspection targeting the same workspace works in the copy the previous wave opened.
        if (
          lastOpenedWorkspaceId &&
          lastSourceWorkspaceId &&
          step.workspaceId === lastSourceWorkspaceId &&
          (step.kind === "shell" || step.kind === "inspect" || step.kind === "verify" || (step.kind === "start" && !step.branch))
        ) {
          step.workspaceId = lastOpenedWorkspaceId;
        }
      }
      const context = withPlannedWorkspaces(await this.context(), turn.steps ?? []);
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (stepIssue(step, context)) {
        step.state = "skipped";
        prevOk = false;
        this.save();
        continue;
      }
      const sourceWorkspaceId = step.workspaceId || null;
      step.state = "running";
      this.activity = { kind: step.kind, label: this.stepActivityLabel(step, context) };
      this.save();
      try {
        await this.carryOut(turn, step, epoch, auto);
        step.state = "done";
        prevOk = true;
        const producedPty = step.ptyId || (step.kind === "tell" ? step.target : null);
        if (producedPty) {
          if (step.after) wavePtys = [producedPty];
          else if (!wavePtys.includes(producedPty)) wavePtys.push(producedPty);
          lastSourceWorkspaceId = sourceWorkspaceId;
          lastOpenedWorkspaceId = step.openedWorkspaceId || sourceWorkspaceId;
        }
      } catch (error) {
        step.state = "failed";
        step.error = error instanceof Error ? error.message : String(error);
        if (step.after) wavePtys = [];
        prevOk = false;
      }
      this.activity = null;
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      this.save();
    }
    this.activity = null;
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
      // Only going busy and then quiet settles the wait. A terminal that never gets busy (a command that
      // finished at once, a CLI already idle) would hold the plan "running" for good: once it has been
      // quiet this long with nothing pending, the next step goes.
      const idle = setTimeout(() => {
        if (set.has(done) && !this.core.live.get(ptyId)?.working && !this.chainTimers.has(ptyId)) done(true);
      }, this.chainIdleMs);
      idle.unref();
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

  private entityDeps(): EntityStepDeps {
    return {
      core: this.core,
      workspaces: this.workspaces,
      messages: this.messages,
      tasks: this.tasks,
      routines: this.routines,
      runs: this.runs,
      library: this.library,
      chats: this.chats,
      copies: this.copies,
      context: (fresh) => this.context(fresh),
      planner: () => this.planner(),
      projectsFolder: () => this.projectsFolder(),
      updateWorkspacesKey: () => {
        const copies = this.copies.list();
        this.conversation.workspacesKey = this.core.store
          .readWorkspaces()
          .workspaces.filter((w) => !copies.some((c) => c.openedWorkspaceId === w.id))
          .map((w) => `${w.id}:${w.name}`)
          .join("|");
      },
      hasCall: () => Boolean(this.onCall),
    };
  }

  private inspectDeps(): InspectDeps {
    return {
      core: this.core,
      workspaces: this.workspaces,
      messages: this.messages,
      runs: this.runs,
      library: this.library,
      routines: this.routines,
      tasks: this.tasks,
      chats: this.chats,
      copies: this.copies,
      models: this.models,
      planner: () => this.planner(),
      listModels: (engineId) => this.listModels(engineId),
      buildSettingsContext: () => this.buildSettingsContext(),
      projectsFolder: () => this.projectsFolder(),
    };
  }

  private async carryOut(turn: OrchestratorTurn, step: OrchestratorStep, epoch = this.runEpoch, auto = false): Promise<void> {
    if (step.kind === "workspace") {
      await carryOutWorkspaceStep(this.entityDeps(), turn, step);
      return;
    }
    if (step.kind === "agent") {
      await carryOutAgentStep(this.entityDeps(), turn, step);
      return;
    }
    if (step.kind === "skill") {
      await carryOutSkillStep(this.entityDeps(), turn, step);
      return;
    }
    if (step.kind === "verify") {
      await this.carryOutVerifyStep(turn, step, epoch);
      return;
    }
    if (step.kind === "memory") {
      this.carryOutMemoryStep(step);
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
      if (!this.core.isLive(step.target) || !(await this.core.refreshShellForeground(step.target))) throw new Error("That CLI isn't running any more.");
      const session = this.core.live.get(step.target);
      const screen = this.core.options.host.screen ? await this.core.options.host.screen(step.target).catch(() => "") : "";
      const action = keySequenceFor(step.prompt, screen);
      if (!action) throw new Error("Unknown key action.");
      const approves = action.label === "Yes" || action.label === "Enter" || /^Option [1-9]$/.test(action.label);
      if (auto && approves) {
        // Re-check the live screen right before writing: a prompt can move from trust to approval while planning.
        const livePrompt = detectWaitingPrompt(screen);
        if (!livePrompt || !isFreeWaitingPrompt(livePrompt) || isApprovalPrompt(screen)) {
          throw new Error("That CLI is waiting on an approval prompt; say Go to answer it.");
        }
      }
      if (this.core.options.host.write) await this.core.options.host.write(step.target, action.data);
      else await this.core.options.host.send(step.target, action.data.replace(/\r$/, ""), action.data.endsWith("\r"));
      this.followTo(session?.workspaceId, step.target);
      step.result = `Sent ${action.label}.`;
      return;
    }
    if (step.kind === "workbench") {
      await carryOutWorkbenchStep(this.entityDeps(), step);
      return;
    }
    if (step.kind === "settings") {
      await carryOutSettingsStep(this.entityDeps(), step);
      return;
    }
    if (step.kind === "lookup") {
      const found = await this.lookup(step.prompt);
      step.result = found.summary;
      return;
    }
    if (step.kind === "routine") {
      await carryOutRoutineStep(this.entityDeps(), turn, step);
      return;
    }
    if (step.kind === "task") {
      await carryOutTaskStep(this.entityDeps(), turn, step, formatApplyResult);
      return;
    }
    if (step.kind === "chat") {
      await carryOutChatStep(this.entityDeps(), turn, step);
      return;
    }
    if (step.kind === "run") {
      await carryOutRunStep(this.entityDeps(), step);
      return;
    }
    if (step.kind === "talk") {
      await carryOutTalkStep(this.entityDeps(), step);
      return;
    }
    if (step.kind === "apply") {
      const result = await this.copies.apply(step.target);
      const note = formatApplyResult(result, "");
      if (note) step.result = note;
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
      } else if (step.route) {
        show(step.route as Parameters<typeof show>[0]);
      } else if (step.view) show({ view: step.view });
      else {
        if (!this.core.workspaceById(step.workspaceId)) throw new Error("That workspace is gone.");
        show({ view: "code", workspaceId: step.workspaceId });
      }
      return;
    }
    if (!this.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
    if (step.kind === "tell") {
      // Looked at again now: a pane whose CLI has quit since the plan or last 1 s poll is a bare
      // shell, and the message would run there as a command.
      if (!(await this.core.refreshShellForeground(step.target))) throw new Error("That CLI isn't running any more.");
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
      // In a call outside Viby's own panel (or when only the screen can be shown), bring the terminal up.
      this.followTo(session.workspaceId, step.target, answer.fromScreen);
      this.onCall?.({ kind: "read", ...this.nameOf(session), reply: step.reply, all: step.prompt === "all", fromScreen: answer.fromScreen });
      return;
    }
    await this.core.killPty(step.target);
  }

  private async carryOutVerifyStep(turn: OrchestratorTurn, step: OrchestratorStep, epoch: number): Promise<void> {
    if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
    const workspace = this.core.workspaceById(step.workspaceId);
    if (!workspace) throw new Error("That workspace is gone.");
    const command = step.prompt.trim();
    if (!command) throw new Error("Write a verification command to run.");
    const { retries, timeoutMs } = parseVerifyOptions(step.options);
    const findFixerPty = (): string => {
      if (step.target && this.core.isLive(step.target)) return step.target;
      const priorSteps = turn.steps ?? [];
      const selfIdx = priorSteps.indexOf(step);
      for (let i = (selfIdx >= 0 ? selfIdx : priorSteps.length) - 1; i >= 0; i -= 1) {
        const s = priorSteps[i];
        if ((s.kind !== "start" && s.kind !== "tell") || !s.ptyId && !s.target) continue;
        const pty = s.ptyId || s.target;
        if (pty && this.core.isLive(pty) && (s.openedWorkspaceId === workspace.id || s.workspaceId === workspace.id)) return pty;
      }
      return this.core.listLive().find((s) => isCodingCli(s) && s.workspaceId === workspace.id)?.ptyId ?? "";
    };
    const fixerPtyId = findFixerPty();
    const fixerSession = fixerPtyId ? this.core.live.get(fixerPtyId) : undefined;
    const copies = this.copies.list();
    const copy = copies.find((item) => item.openedWorkspaceId === (fixerSession?.workspaceId ?? workspace.id));
    const fixerHandle = fixerPtyId && copy ? this.messages.list().find((item) => item.ptyId === fixerPtyId) : undefined;
    const maxAttempts = fixerHandle ? retries + 1 : 1;
    let lastOutput = "";
    let lastCode: number | null = null;
    let timedOut = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      this.setActivity({ kind: "verify", label: maxAttempts > 1 ? `${workspace.name} (${attempt}/${maxAttempts})` : workspace.name });
      const ac = new AbortController();
      this.activeVerifies.add(ac);
      let res: { code: number | null; output: string; timedOut: boolean };
      try {
        res = await this.verifyRunner(command, workspace.path, ac.signal, timeoutMs, plannerEnv());
      } finally {
        this.activeVerifies.delete(ac);
      }
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      lastOutput = res.output;
      lastCode = res.code;
      timedOut = res.timedOut;
      if (!timedOut && res.code === 0) {
        turn.checks = [...(turn.checks ?? []).filter((c) => c.id !== `verify-${step.id}`), {
          id: `verify-${step.id}`,
          kind: "verify",
          label: command,
          summary: attempt > 1 ? `Passed after ${attempt - 1} fix${attempt === 2 ? "" : "es"}` : "Passed",
          details: (res.output || "(no output)").slice(-6000),
          workspaceId: workspace.id,
          ...(copy ? { copyId: copy.id } : {}),
          ...(fixerPtyId ? { ptyId: fixerPtyId } : {}),
        }];
        step.result = attempt > 1 ? `Passed after ${attempt - 1} fix round${attempt === 2 ? "" : "s"}.` : "Passed.";
        return;
      }
      if (attempt < maxAttempts && fixerHandle && this.core.isLive(fixerPtyId)) {
        const tail = res.output.trim().slice(-3500);
        const fixPrompt = `Verification command "${command}" failed (exit ${res.timedOut ? "timeout" : String(res.code ?? "?")}). Fix the failure below and stop when done:\n\n${tail || "(no output)"}`;
        const sent = await this.messages.tell({ fromPty: null, to: fixerHandle.handle, text: fixPrompt, fromPerson: true });
        if (!sent.ok || sent.delivered === "draft") break;
        const settled = await this.waitForChainedPty(fixerPtyId, epoch, turn);
        if (!settled || this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      }
    }

    turn.checks = [...(turn.checks ?? []).filter((c) => c.id !== `verify-${step.id}`), {
      id: `verify-${step.id}`,
      kind: "verify",
      label: command,
      summary: timedOut ? "Timed out" : `Exit ${lastCode ?? "?"}`,
      details: (lastOutput || "(no output)").slice(-6000),
      workspaceId: workspace.id,
      ...(copy ? { copyId: copy.id } : {}),
      ...(fixerPtyId ? { ptyId: fixerPtyId } : {}),
    }];
    if (timedOut) throw new Error(`Verification timed out: ${command}.`);
    throw new Error(`Verification failed (${String(lastCode ?? "?")}): ${command}.`);
  }

  private carryOutMemoryStep(step: OrchestratorStep): void {
    const action = normalizeMemoryAction(step.action, Boolean(step.prompt.trim())) ?? "append";
    const configRoot = this.core.options.configRoot;
    const file = vibyMemoryFile(configRoot);
    const hadFile = fs.existsSync(file);
    const prev = hadFile ? readVibyMemory(configRoot) : "";
    if (action === "clear") {
      if (hadFile) {
        const bin = this.core.trash.stash([file]);
        step.undo = this.core.keepForUndo(bin, () => {
          this.cachedContext = null;
          this.core.emit("orchestrator");
        }).undo;
      }
      this.cachedContext = null;
      step.result = "Cleared Viby memory (~/.config/vibeforge/viby.md).";
      return;
    }
    if (action === "set") {
      const text = step.prompt.trim();
      if (!text) throw new Error("Type something to save to memory.");
      const bin = this.core.trash.stash([]);
      writeVibyMemory(configRoot, `${text}\n`);
      step.undo = this.core.keepForUndo(bin, () => {
        if (hadFile) writeVibyMemory(configRoot, prev);
        else fs.rmSync(file, { force: true });
        this.cachedContext = null;
        this.core.emit("orchestrator");
      }).undo;
      this.cachedContext = null;
      step.result = "Updated Viby memory (~/.config/vibeforge/viby.md).";
      return;
    }
    const addition = step.prompt.trim();
    if (!addition) throw new Error("Type something to save to memory.");
    const next = prev.trimEnd() ? `${prev.trimEnd()}\n- ${addition}\n` : `# Viby Memory\n\n- ${addition}\n`;
    writeVibyMemory(configRoot, next);
    this.cachedContext = null;
    step.result = "Saved to Viby memory (~/.config/vibeforge/viby.md).";
  }

  /**
   * Read-only inspection of quotas/usage, settings/voice, storage, saved entities (agents, skills,
   * routines, tasks, chats, runs), a copy's diff, a running CLI's screen and latest reply, or a
   * workspace's git state, branches and files, so Viby can diagnose, review and brainstorm with real facts.
   */
  inspect(step: OrchestratorStep): Promise<{ summary: string; details: string }> {
    return inspectOrchestratorStep(this.inspectDeps(), step);
  }

  /**
   * Search VibeForge's run history, workspace git branches, and project folders on disk for a
   * session id, branch, or project folder.
   */
  lookup(query: string): Promise<{ summary: string; details: string }> {
    return lookupOrchestrator(this.inspectDeps(), query);
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
    for (const ac of this.activeVerifies) ac.abort();
    this.activeVerifies.clear();
    for (const timer of this.firstPromptTimers.values()) clearTimeout(timer);
    this.firstPromptTimers.clear();
    for (const timer of this.chainTimers.values()) clearTimeout(timer);
    this.chainTimers.clear();
    for (const ptyId of [...this.chainWaiters.keys()]) this.settleChainWaiters(ptyId, false);
    this.thinking?.abort();
    this.thinking = null;
  }
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
