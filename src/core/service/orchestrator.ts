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
  extractEarlySay,
  formatSettingsRules,
  inspectsQuotas,
  inspectsStorage,
  isHighRiskStep,
  isLowRiskComputerStep,
  isPersonLedComputerStep,
  isReadOnlyStep,
  keySequenceFor,
  lookingLine,
  normalizeMemoryAction,
  normalizeComputerAction,
  computerGrantFor,
  computerUseBlocked,
  parseComputerSurface,
  parseVerifyOptions,
  plannedFolder,
  resolveLocalReflex,
  resolveSettingsStep,
  sessionGone,
  settingsFingerprint,
  shouldAutoRunPlan,
  withPlannedWorkspaces,
  type MaestroCopy,
  type MaestroNote,
  type PlanSettingsContext,
  type StepPatch,
  brainKind,
  canOrchestrate,
  KNOWN_MODELS,
  STEP_KINDS,
  STRICT_PLAN_SCHEMA,
  signedOut,
  orchestratorRules,
  readBrainOutput,
  recentFocusLine,
  resolvePlan,
  stepIssue,
  type Looking,
  type OrchestratorActivity,
  type OrchestratorCheck,
  type OrchestratorStep,
  type OrchestratorThreadSummary,
  type OrchestratorTurn,
  type OrchestratorView,
  CONFIRMED_KEY,
  type PlanConfirmed,
  type PlanContext,
  type VibyWord,
} from "../orchestrator.js";
import { cwdAllowed } from "../places.js";
import { VibyDiagnostics, formatDiagnosticsLogLine, type VibyTurnOutcome } from "./orchestrator-diagnostics.js";
import { planAnswer } from "../../shared/plan-answer.js";
import { speakable } from "../replies.js";
import { en } from "../../ui/i18n/en.js";
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
import { PlannerSessionPool } from "./planner-session.js";
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
import type { LiveSession, Settings, Task } from "../types.js";
import { cleanModel, effortLevels, takesModel } from "../../shared/launch-options.js";
import {
  LOCAL_ENGINE_ID,
  buildLocalBrainMessages,
  probeLocalServer,
  runLocalBrain,
  type LocalBrainImage,
  type LocalBrainRunner,
  type LocalChatMessage,
} from "../local.js";
import { vibyLocalModel, vibyPlanner } from "../../shared/local.js";
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
/** TTL for cached workspace git-repo checks inside buildContext(). */
const GIT_REPO_CACHE_MS = 15_000;
/** TTL for cached theme directory scans inside buildSettingsContext(). */
const THEMES_CACHE_MS = 30_000;

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
  onEarlySay?: (say: string) => void,
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
    let earlySaySent = false;
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
      if (!earlySaySent && onEarlySay) {
        const early = extractEarlySay(stdout);
        if (early) {
          earlySaySent = true;
          onEarlySay(early);
        }
      }
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

/**
 * What a plan does, as its card shows it, leaving out where each step has got to: two plans with
 * the same key do the same thing. A yes the planner heard only runs the plan the person saw.
 */
export function planKey(steps: readonly OrchestratorStep[]): string {
  return JSON.stringify(
    steps.map((step) => [
      step.kind,
      step.action ?? "",
      step.engineId,
      step.agentId ?? "",
      step.workspaceId,
      step.branch,
      step.prompt,
      step.target,
      step.model ?? "",
      step.effort ?? "",
      step.name ?? "",
      step.folder ?? "",
      step.git ?? false,
      step.after ?? false,
      step.view ?? "",
      step.description ?? "",
      step.schedule ?? "",
      step.taskId ?? "",
      step.status ?? "",
      step.places ?? [],
      step.skills ?? [],
      step.agents ?? [],
      step.options ?? "",
      step.route ?? {},
    ]),
  );
}

/** Whether a plan came from what Viby read: in its own turn, or carried over from a plan that did (decision D1). */
function madeFromReading(turn: OrchestratorTurn): boolean {
  return Boolean(turn.checks?.length || turn.fromReading || turn.confirmed === "read");
}

export class OrchestratorDesk {
  private conversation: Conversation;
  private thinking: AbortController | null = null;
  private thinkingDone: Promise<void> | null = null;
  private activity: OrchestratorActivity | null = null;
  readonly diagnostics = new VibyDiagnostics();
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
  private readonly gitRepoCache = new Map<string, { at: number; git: boolean }>();
  private themesCache: { at: number; ids: string[] } | null = null;
  private readonly plannerPool = new PlannerSessionPool();
  private lastLocalRulesTokens = 0;
  runner: BrainRunner = spawnBrain;
  localRunner: LocalBrainRunner = runLocalBrain;
  verifyRunner: VerifyRunner = spawnVerifyCommand;
  /** Reuse persistent warm stream-json stdio sessions for compatible planners when using `spawnBrain`. */
  warmPlanners = true;
  /** Fired as soon as a streaming planner completes its top-level `"say"` field (for early TTS prep). */
  onEarlySay: ((say: string) => void) | null = null;
  /** Quiet time before a chained `after: true` step considers the previous PTY turn settled. */
  chainSettleMs = 1200;
  /** How long a chained step waits on a terminal that never got busy before going ahead. */
  chainIdleMs = 15_000;
  /** Hard upper bound on a single chained PTY wait so a hung terminal never deadlocks the plan. */
  chainMaxWaitMs = 15 * 60_000;
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
      this.gitRepoCache.clear();
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

  /** The CLI that plans right now: Local when Local mode sends Viby there, else the one picked, or until then the first one here that can (vibyPlanner). */
  private planner(): string {
    const local = this.core.store.readSettings().local;
    const engines = this.core.store
      .readEngineRows()
      .map((row) => ({ id: row.id, bin: row.bin, available: Boolean(this.core.resolveEngine(row.id)) }));
    return vibyPlanner({ local, localReady: Boolean(this.core.localBrainConfig()), picked: this.settings().engine, engines });
  }

  view(): OrchestratorView {
    const { engine, mode } = this.settings();
    const planner = this.planner();
    const localBrain = planner === LOCAL_ENGINE_ID ? this.core.localBrainConfig() : null;
    const ctxLen = localBrain ? this.core.cachedLocalContext(localBrain.url, localBrain.model) : null;
    const neededTokens = (this.lastLocalRulesTokens || 3500) + 2048;
    const localContextWarning =
      ctxLen !== null && ctxLen < neededTokens ? { contextLength: ctxLen, neededTokens } : null;
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
      ...(localContextWarning ? { localContextWarning } : {}),
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

  private async isGitRepoCached(folder: string): Promise<boolean> {
    const key = path.resolve(folder);
    const now = Date.now();
    const cached = this.gitRepoCache.get(key);
    if (cached && now - cached.at < GIT_REPO_CACHE_MS) return cached.git;
    const git = await isGitRepo(folder).catch(() => false);
    this.gitRepoCache.set(key, { at: now, git });
    return git;
  }

  private listThemesCached(): string[] {
    const now = Date.now();
    if (this.themesCache && now - this.themesCache.at < THEMES_CACHE_MS) return this.themesCache.ids;
    let ids: string[] = [];
    try {
      ids = listThemes().themes.map((t) => t.id);
    } catch {
      ids = [];
    }
    this.themesCache = { at: now, ids };
    return ids;
  }

  private async buildContext(): Promise<PlanContext> {
    const rows = this.core.store.readEngineRows();
    const workspaces = await Promise.all(
      // No past runs here: they'd go with every turn. A lookup step searches them when asked.
      this.core.store.readWorkspaces().workspaces.map(async (item) => ({ id: item.id, name: item.name, folder: tildify(item.path), git: await this.isGitRepoCached(item.path) })),
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
    // A list that can't be read is left out and named, so Viby doesn't take it for empty and make it all again.
    const unreadable: string[] = this.core.store.unreadableItems().map((file) => file.error);
    const readable = <T>(read: () => T[]): T[] => {
      try {
        return read();
      } catch (error) {
        unreadable.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    };
    const rawAgents = readable(() => this.core.store.listAgents());
    const agentNames = new Map(rawAgents.map((item) => [item.id, item.name]));
    const rawSkills = readable(() => this.core.store.listSkills());
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
    const rawTasks = readable<Task & { waiting: unknown }>(() => (this.tasks ? this.tasks.listTasks() : this.core.store.listTasks().map((t) => ({ ...t, waiting: null }))));
    const tasks = [...rawTasks]
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"))
      .slice(0, 20)
      .map((item) => ({
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
    const routines = readable(() => (this.routines ? this.routines.listRoutines() : [])).map((item) => ({
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
      .slice(0, 12)
      .map((item) => ({
        id: item.id,
        title: item.title,
        engine: item.engine,
        ...(item.agentId && agentNames.get(item.agentId) ? { agent: agentNames.get(item.agentId) } : {}),
        agentId: item.agentId,
        live: item.live,
      }));
    const runs = this.core.store
      .queryRuns({ limit: 15 })
      .sort((a, b) => Number(Boolean(a.openedAt)) - Number(Boolean(b.openedAt)))
      .slice(0, 10)
      .map((item) => ({
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
    const listedEngines = this.core.listEngines();
    const defaultPick = this.core.effectiveDefaultEngine();
    const defaultEngine = defaultPick && this.core.resolveEngine(defaultPick) ? defaultPick : undefined;
    const memory = boundedVibyMemory(this.core.options.configRoot);
    return {
      workspaces,
      engines: listedEngines.map((row) => ({ id: row.id, label: row.label, available: row.available, bin: row.bin })),
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
      ...(unreadable.length ? { unreadable } : {}),
      projectsFolder: this.projectsFolder(),
      settings: this.buildSettingsContext(allSettings, rows),
    };
  }

  private buildSettingsContext(all: Settings = this.core.store.readSettings(), rows = this.core.store.readEngineRows()): PlanSettingsContext {
    const planner = this.planner();
    const localBrain = this.core.localBrainConfig();
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
    if (all.local.enabled) {
      const localModel = vibyLocalModel(all.local);
      availablePlanners.push({
        id: LOCAL_ENGINE_ID,
        label: "Local",
        available: Boolean(localBrain),
        models: localModel ? [localModel] : [],
        efforts: [],
      });
    }

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

    const availableThemes = this.listThemesCached();

    return {
      viby: {
        planner,
        pickedEngine: all.orchestrator.engine,
        mode: all.orchestrator.mode,
        terse: all.orchestrator.terse !== false,
        model:
          planner === LOCAL_ENGINE_ID
            ? vibyLocalModel(all.local)
            : planner && planner === all.orchestrator.engine
              ? all.orchestrator.model
              : "",
        effort: planner && planner === all.orchestrator.engine ? (all.orchestrator.effort ?? "") : "",
        projectsFolder: this.projectsFolder(),
        computer: all.computerUse,
        availablePlanners,
      },
      local: {
        enabled: all.local.enabled,
        active: all.local.active,
        overrideAgents: all.local.overrideAgents,
        url: all.local.url,
        model: all.local.model,
        vibyModel: all.local.vibyModel,
        viby: all.local.viby,
        harness: all.local.harness,
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
    // Wait for a recently aborted/stopped turn to unwind its cleanup before launching the next one.
    if (this.thinkingDone) await this.thinkingDone.catch(() => undefined);
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
    let finishThinking!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      finishThinking = resolve;
    });
    this.thinkingDone = donePromise;
    this.save();
    try {
      const promptText = words || "Please examine the attached screenshot(s).";
      await this.think(promptText, controller.signal, looking ?? this.looking, savedImages);
    } finally {
      if (this.thinking === controller) {
        this.thinking = null;
        this.activity = null;
      }
      if (this.thinkingDone === donePromise) this.thinkingDone = null;
      finishThinking();
      this.save();
    }
  }

  private answer(turn: Omit<OrchestratorTurn, "id" | "at" | "from">): OrchestratorTurn {
    const full: OrchestratorTurn = { id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", by: this.planner() || this.settings().engine, ...turn };
    this.conversation.turns.push(full);
    return full;
  }

  private async think(words: string, signal: AbortSignal, looking: Looking | null, savedImages: SavedPromptImage[] = []): Promise<void> {
    const turnStartedAt = Date.now();
    let contextMs = 0;
    let plannerMs = 0;
    let warmHit = false;
    let repaired = false;
    let outcome: VibyTurnOutcome = "aborted";
    let stepKinds: string[] = [];
    let errorKind: string | undefined;
    const { engine: picked, mode, model: chosen, effort: chosenEffort, terse } = this.settings();
    const terseReplies = terse !== false;
    const engineId = this.planner();
    let model = "";
    try {
    // A model or effort picked for another planner means nothing to this one.
    const explicitModel = engineId === picked ? chosen : "";
    const explicitEffort = engineId === picked ? (chosenEffort ?? "") : "";
    const localBrain = engineId === LOCAL_ENGINE_ID ? this.core.localBrainConfig() : null;
    const engine = engineId && engineId !== LOCAL_ENGINE_ID ? this.core.resolveEngine(engineId) : null;
    if (engineId === LOCAL_ENGINE_ID ? !localBrain : !engine || !canOrchestrate(engine.row)) {
      outcome = "noEngine";
      errorKind = "noEngine";
      this.answer({ text: "", problem: "noEngine" });
      return;
    }
    // In a live voice call, default Claude Code to haiku unless the person chose a specific model.
    model =
      engineId === LOCAL_ENGINE_ID
        ? localBrain!.model
        : explicitModel || (this.onCall && engine && brainKind(engine.row) === "claude" ? "haiku" : "");
    const contextStartedAt = Date.now();
    const context = await this.context();
    contextMs = Date.now() - contextStartedAt;
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
    const plannerKind = engineId === LOCAL_ENGINE_ID ? "local" : brainKind(engine!.row);
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
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    fs.chmodSync(work, 0o700);
    // Codex reads the schema from a file.
    const schemaFile = path.join(work, "plan-schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(STRICT_PLAN_SCHEMA), { mode: 0o600 });
    // Said ahead of every request, not in the rules: a resumed session may not read those again.
    const here = lookingLine(looking, context);
    const recentFocus = recentFocusLine(this.conversation.turns.slice(0, -1), context, looking);
    const imageLine = savedImages.length
      ? `(${savedImages.length === 1 ? "Attached screenshot saved on disk" : "Attached screenshots saved on disk"}: ${savedImages.map((img) => img.path).join(", ")})`
      : "";
    // A plan that waits for Go hasn't run: say so, or the planner takes "great" or "you didn't do it"
    // as thanks for work it only proposed (a real call, 2026-11-25).
    const waiting = [...this.conversation.turns].reverse().find((item) => item.plan === "waiting" && item.steps?.length);
    const waitingLine = waiting?.steps?.length
      ? `(Your last plan is waiting for the person's Go and has NOT run yet: ${waiting.steps.map(stepSummary).join("; ")}. If they are saying yes to it as it stands, set confirmWaiting: true with steps: [].)`
      : "";
    // The plan as the person saw it when they answered: a yes is to this, and nothing else.
    const waitingSeen = waiting?.steps?.length ? planKey(waiting.steps) : "";
    let capturedInitialRules = this.conversation.initialRules;
    const localExtraMessages: LocalChatMessage[] = [];
    const turn = async (said: string, ctx: PlanContext = context, includeImages = false, extraImages: SavedPromptImage[] = []) => {
      const keepPromptCache = this.conversation.begun && (plannerKind === "claude" || plannerKind === "codex") && Boolean(this.conversation.initialRules);
      const liveChanged = keepPromptCache && this.conversation.liveKey !== undefined && this.conversation.liveKey !== liveStateFingerprint(ctx);
      const liveLine = liveChanged ? formatLiveUpdate(ctx) : "";
      const rules = keepPromptCache ? this.conversation.initialRules! : orchestratorRules(ctx);
      if (!this.conversation.begun && plannerKind !== "local") capturedInitialRules = rules;
      const turnImages = [...(includeImages ? savedImages : []), ...extraImages];
      const extraImageLine = extraImages.length
        ? `(Captured screen image${extraImages.length === 1 ? "" : "s"} saved on disk: ${extraImages.map((img) => img.path).join(", ")})`
        : "";
      const prefix = [
        here,
        recentFocus,
        waitingLine,
        includeImages ? imageLine : "",
        extraImageLine,
        liveLine,
        this.conversation.begun && plannerKind !== "local" ? settingsLine : "",
        this.conversation.begun && plannerKind !== "local" ? libraryLine : "",
        this.conversation.begun && plannerKind !== "local" ? memoryLine : "",
      ]
        .filter(Boolean)
        .join("\n");
      const text = prefix ? `${prefix}\n${said}` : said;
      const brainOpts = {
        text,
        rules,
        sessionId: this.conversation.sessionId,
        resume: this.conversation.begun,
        model,
        effort: explicitEffort,
        schemaFile,
        ...(turnImages.length ? { images: turnImages.map((img) => img.path) } : {}),
      };
      const pStartedAt = Date.now();
      if (plannerKind === "local") {
        if (!localBrain) return null;
        this.lastLocalRulesTokens = Math.ceil(rules.length / 4);
        const localImages: LocalBrainImage[] = turnImages.map((img) => ({ mediaType: img.mediaType, base64: img.base64 }));
        const messages = buildLocalBrainMessages(
          rules,
          this.conversation.turns.slice(0, -1),
          localExtraMessages,
          text,
          localImages,
        );
        const runResult = await this.localRunner({
          url: localBrain.url,
          model: localBrain.model,
          messages,
          schema: STRICT_PLAN_SCHEMA as unknown as Record<string, unknown>,
          signal,
          timeoutMs: BRAIN_TIMEOUT_MS,
          ...(this.onEarlySay ? { onEarlySay: this.onEarlySay } : {}),
        });
        if (runResult.code === 0 && runResult.stdout) {
          localExtraMessages.push({ role: "user", content: text }, { role: "assistant", content: runResult.stdout });
        }
        plannerMs += Date.now() - pStartedAt;
        return runResult;
      }
      if (this.runner === spawnBrain && this.warmPlanners && plannerKind === "claude") {
        const warmRun = await this.plannerPool.runTurn({
          binPath: engine!.binPath,
          row: engine!.row,
          opts: brainOpts,
          images: turnImages.length ? turnImages : undefined,
          cwd: work,
          signal,
          timeoutMs: BRAIN_TIMEOUT_MS,
          onEarlySay: this.onEarlySay ?? undefined,
        });
        if (warmRun && (warmRun.timedOut || signal.aborted || warmRun.code === 0)) {
          warmHit = true;
          plannerMs += Date.now() - pStartedAt;
          return warmRun;
        }
      }
      const args = brainArgs(engine!.row, brainOpts);
      if (!args) return null;
      const runResult =
        plannerKind === "claude" && turnImages.length
          ? await this.runner([engine!.binPath, ...args], work, signal, undefined, claudeImageStdin(text, turnImages))
          : this.runner === spawnBrain && this.onEarlySay
            ? await spawnBrain([engine!.binPath, ...args], work, signal, BRAIN_TIMEOUT_MS, KILL_GRACE_MS, undefined, this.onEarlySay)
            : await this.runner([engine!.binPath, ...args], work, signal);
      plannerMs += Date.now() - pStartedAt;
      return runResult;
    };
    const initialText = (switchedEngine || workspacesChanged) && !this.conversation.begun ? this.recap(words) : words;
    let run = await turn(initialText, context, true);
    if (!run) {
      outcome = "noEngine";
      errorKind = "noEngine";
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
    // If a planner exited cleanly with malformed/unparseable output, run one compact schema-repair retry before failing.
    if (!signal.aborted && !run.timedOut && run.code === 0 && !output.error && !output.plan) {
      repaired = true;
      const repairPrompt = [
        this.recap(words),
        "",
        `(Your previous answer could not be parsed as valid plan JSON. Respond ONLY with a single JSON object matching {"say": string, "steps": [...]} for the person's request. Valid step kinds: ${STEP_KINDS.join(", ")}.)`,
      ].join("\n");
      const repairedTurn = await turn(repairPrompt, context, true);
      if (repairedTurn && !signal.aborted && !repairedTurn.timedOut && repairedTurn.code === 0) {
        const nextOut = readBrainOutput(repairedTurn.stdout);
        if (nextOut.plan) {
          run = repairedTurn;
          output = nextOut;
        }
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
      outcome = "timeout";
      errorKind = "timeout";
      this.answer({ text: "", problem: "timeout" });
      return;
    }
    if ((run.code !== 0 || error) && !plan) {
      const detail = lastLines(error || run.stderr || run.stdout);
      const isSignIn = signedOut(`${error}\n${run.stderr}\n${run.stdout}`);
      outcome = isSignIn ? "signIn" : "failed";
      errorKind = isSignIn ? "signIn" : error ? "cliError" : `exit_${run.code}`;
      this.answer({ text: "", problem: isSignIn ? "signIn" : "failed", detail });
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
      outcome = "unreadable";
      errorKind = "unreadable";
      this.answer({ text: "", problem: "unreadable", detail: lastLines(text) });
      return;
    }
    let currentContext = context;
    let steps = resolvePlan(plan, currentContext);
    const droppedKinds = (rawSteps: NonNullable<typeof plan>["steps"]) => rawSteps.map((s) => s.kind).filter((k) => k && !(STEP_KINDS as readonly string[]).includes(k));
    let unknownKinds = droppedKinds(plan.steps);
    // If every emitted step used an unknown kind, give the planner one repair turn naming the valid kinds.
    if (!signal.aborted && unknownKinds.length && !steps.length) {
      repaired = true;
      const repairPrompt = `Your previous plan used unsupported step kind(s): ${[...new Set(unknownKinds)].join(", ")}. Valid step kinds are ONLY: ${STEP_KINDS.join(", ")}. Rewrite the plan JSON for "${oneLine(words, 240)}" using only valid step kinds (or steps: [] with a clear explanation in say).`;
      const repairedTurn = await turn(repairPrompt, currentContext, false);
      if (repairedTurn && !signal.aborted && !repairedTurn.timedOut && repairedTurn.code === 0) {
        const nextOut = readBrainOutput(repairedTurn.stdout);
        if (nextOut.sessionId) this.conversation.sessionId = nextOut.sessionId;
        if (nextOut.plan) {
          const nextSteps = resolvePlan(nextOut.plan, currentContext);
          const nextUnknown = droppedKinds(nextOut.plan.steps);
          if (!nextUnknown.length) {
            plan = nextOut.plan;
            steps = nextSteps;
            unknownKinds = nextUnknown;
          }
        }
      }
    }
    const checks: OrchestratorCheck[] = [];
    const executedChainSteps: OrchestratorStep[] = [];
    const chainSummaries: string[] = [];
    const seenChecks = new Set<string>();
    const checkKey = (step: OrchestratorStep) => `${step.kind}:${step.action ?? ""}:${step.workspaceId}:${step.target}:${step.prompt}`;
    const epoch = this.runEpoch;
    // Observe-then-act loop (up to MAX_INSPECT_ROUNDS): executes leading instant actions
    // (such as focus-window/show) + trailing lookup/inspect steps and feeds findings and
    // screenshots back to the planner in the same turn.
    for (let round = 0; round < MAX_INSPECT_ROUNDS; round += 1) {
      if (signal.aborted || unknownKinds.length || !steps.length) break;
      if (steps.some((step) => stepIssue(step, currentContext))) break;
      const observeStart = steps.findLastIndex((step) => step.kind !== "lookup" && step.kind !== "inspect") + 1;
      const observeSteps = steps.slice(observeStart);
      if (!observeSteps.length) break;
      const leading = steps.slice(0, observeStart);
      if (
        leading.length > 0 &&
        !(
          leading.every((step) => !step.after && (step.kind === "computer" || step.kind === "show" || step.kind === "workbench")) &&
          shouldAutoRunPlan(leading, currentContext, { mode, fromReading: checks.length > 0, said: words })
        )
      ) {
        break;
      }
      if (leading.length > 0) {
        const chainTurn: OrchestratorTurn = { id: turnId(), at: this.core.now().toISOString(), from: "vibeforge", text: "" };
        for (let i = 0; i < leading.length; i += 1) {
          const step = leading[i];
          step.state = "running";
          this.setActivity({ kind: step.kind, label: this.stepActivityLabel(step, currentContext) });
          try {
            await this.carryOut(chainTurn, step, epoch, mode !== "never");
            step.state = "done";
            executedChainSteps.push(step);
            chainSummaries.push(`${step.asked || step.kind}${step.result ? `: ${step.result}` : ""}`);
          } catch (error) {
            step.state = "failed";
            step.error = error instanceof Error ? error.message : String(error);
            this.setActivity(null);
            const remaining = steps.slice(i + 1).map((pending) => ({ ...pending, state: "skipped" as const }));
            const allFailedChain = [...executedChainSteps, step, ...remaining];
            outcome = "planned";
            stepKinds = allFailedChain.map((item) => item.kind);
            this.answer({
              text: step.error || plan.say,
              ...(checks.length ? { checks } : {}),
              steps: allFailedChain,
              plan: "done",
              ...(plan.hangup ? { hangup: true } : {}),
            });
            return;
          }
          if (signal.aborted) return;
        }
        this.setActivity(null);
      }
      // If a leading action just ran (e.g. focus-window), allow re-capturing observe steps so screenshots stay fresh.
      const freshSteps = leading.length > 0 ? observeSteps : observeSteps.filter((step) => !seenChecks.has(checkKey(step)));
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
      const details = [
        ...(chainSummaries.length ? [`Already carried out in this turn:\n${chainSummaries.map((line) => `- ${line}`).join("\n")}`] : []),
        ...results.map((res, idx) => `${freshSteps[idx].kind === "lookup" ? "Lookup" : "Inspection"} "${freshSteps[idx].asked || freshSteps[idx].prompt}":\n${res.details}`),
      ].join("\n\n");
      const terseNote = terseReplies
        ? ' Keep `say` ultra-short (e.g. "Clicked play." or "") if your steps auto-run; use future tense ("I\'ll ...") only if a step will wait for Go.'
        : ' Leave `say: ""` on any further inspect steps; use future tense ("I\'ll ...") only if a step will wait for Go.';
      const guidance =
        round < MAX_INSPECT_ROUNDS - 1
          ? `Now answer the person's request ("${words}") using these exact findings. Return concrete steps to carry it out, emit further inspect/lookup steps ONLY if a critical detail is still missing, or answer clearly in say with steps: [] if nothing should be started.${terseNote}`
          : `Now answer the person's request ("${words}") using these exact findings. Return the concrete steps to carry it out now, or answer clearly in say with steps: [] if nothing should be started.${terseNote}`;
      const inspectImages: SavedPromptImage[] = results.flatMap((res) => {
        const imgPath = "imagePath" in res && typeof res.imagePath === "string" ? res.imagePath : "";
        if (!imgPath) return [];
        try {
          return [{ filename: path.basename(imgPath), path: imgPath, mediaType: "image/png", base64: fs.readFileSync(imgPath).toString("base64") }];
        } catch {
          return [];
        }
      });
      const followUp = await turn(["[Findings from VibeForge]", details, "", guidance].join("\n"), currentContext, false, inspectImages);
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
    // A yes to the plan that waits, with nothing new to do (W21 task 2).
    if (plan.confirmWaiting && waiting && !unknownKinds.length && (!steps.length || planKey(steps) === waitingSeen)) {
      if (await this.confirmWaiting(waiting, waitingSeen, checks, Boolean(plan.hangup), signal, words)) {
        outcome = "answered";
        return;
      }
      if (signal.aborted) return;
    }
    if (!steps.length) {
      outcome = executedChainSteps.length ? "planned" : "answered";
      if (executedChainSteps.length) stepKinds = executedChainSteps.map((step) => step.kind);
      this.answer({
        text: plan.say,
        ...(checks.length ? { checks } : {}),
        ...(executedChainSteps.length ? { steps: executedChainSteps, plan: "done" as const } : {}),
        ...(plan.hangup ? { hangup: true } : {}),
      });
      if (plan.hangup) this.onCall?.({ kind: "hangup" });
      return;
    }
    await this.markDirty(steps);
    const inPlaceDirty = await this.hasDirtyInPlace(steps);
    // The same steps as a waiting plan made from what Viby read are still made from it: returned
    // unchanged in a later turn, they keep the mark rather than lose it (decision D1).
    const key = planKey(steps);
    const carried = this.conversation.turns.some((item) => item.plan === "waiting" && item.steps?.length && madeFromReading(item) && planKey(item.steps) === key);
    // A new plan takes the place of one still waiting for Go.
    for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
    const checked = withPlannedWorkspaces(currentContext, steps);
    const ready = steps.every((step) => !stepIssue(step, checked));
    // Once Viby has read a screen, a file, a diff or a reply in this turn, what it read could be
    // steering the plan: under "go", low-risk computer actions the person asked for still auto-run
    // (pointing where the screen shows; typing and shortcuts only from their own words), while
    // code-writing / destructive actions stay guarded (decision D1).
    const readSomething = checks.length > 0 || carried;
    const willAutoRun =
      ready &&
      !unknownKinds.length &&
      shouldAutoRunPlan(steps, checked, {
        mode,
        fromReading: readSomething,
        said: words,
        inPlaceDirty,
      });
    const combinedChecks: OrchestratorCheck[] = !willAutoRun && executedChainSteps.length
      ? [
          ...checks,
          ...executedChainSteps.map((step) => ({
            id: step.id,
            kind: "inspect" as const,
            label: step.asked || step.kind,
            summary: step.result || "Done",
            details: `${step.asked || step.kind}${step.result ? `: ${step.result}` : ""}`,
          })),
        ]
      : checks;
    const finalSteps = willAutoRun && executedChainSteps.length ? [...executedChainSteps, ...steps] : steps;
    outcome = "planned";
    stepKinds = finalSteps.map((step) => step.kind);
    const answered = this.answer({
      text: plan.say,
      ...(combinedChecks.length ? { checks: combinedChecks } : {}),
      ...(carried ? { fromReading: true } : {}),
      steps: finalSteps,
      plan: "waiting",
      ...(plan.hangup ? { hangup: true } : {}),
    });
    if (willAutoRun) {
      void this.run(answered.id, mode !== "never");
    }
    } finally {
      const finalOutcome: VibyTurnOutcome = signal.aborted ? "aborted" : outcome;
      const metric = {
        at: this.core.now().toISOString(),
        source: "think" as const,
        ...(engineId ? { engineId } : {}),
        ...(model ? { model } : {}),
        warmSession: warmHit,
        repaired,
        totalMs: Math.max(0, Date.now() - turnStartedAt),
        contextMs,
        plannerMs,
        outcome: finalOutcome,
        stepKinds,
        failedSteps: 0,
        ...(errorKind && !signal.aborted ? { errorKind } : {}),
      };
      this.diagnostics.record(metric);
      this.core.options.host.logDiagnostics?.(formatDiagnosticsLogLine(metric));
    }
  }

  /**
   * The planner took what the person said ("alright, do the thing you said") as a yes to the plan
   * waiting for Go. That is the planner's reading of their words, not their Go, so the plan runs, as
   * its card stands, only where Just go would run it by itself: no step that waits for Go even in
   * Just go (or, in a call, isn't safe in one), none that needs fixing, and nothing Viby read in the
   * turn that made it or in this one (decision D1). Otherwise the same plan comes back to the front,
   * still waiting, with why. False when the plan isn't the one the person answered any more: then
   * the answer goes on as any other.
   */
  private async confirmWaiting(waiting: OrchestratorTurn, seen: string, checks: OrchestratorCheck[], hangup: boolean, signal: AbortSignal, words: string): Promise<boolean> {
    const unchanged = () => !signal.aborted && waiting.plan === "waiting" && this.conversation.turns.includes(waiting) && Boolean(waiting.steps?.length) && planKey(waiting.steps ?? []) === seen;
    if (!unchanged()) return false;
    const steps = waiting.steps ?? [];
    let why: Exclude<PlanConfirmed, "ran"> | null = null;
    await this.markDirty(steps);
    const context = withPlannedWorkspaces(await this.context(), steps);
    const inPlaceDirty = await this.hasDirtyInPlace(steps);
    const mode = this.settings().mode;
    const directGo = planAnswer(words) === "go";
    if (steps.some((step) => stepIssue(step, context))) {
      why = "fix";
    } else if (mode === "never" || directGo) {
      why = null;
    } else if (checks.length > 0) {
      why = "read";
    } else if (inPlaceDirty || steps.some((step) => isHighRiskStep(step, context))) {
      why = "risky";
    } else if (
      madeFromReading(waiting) &&
      !steps.every((step) => isReadOnlyStep(step) || (isLowRiskComputerStep(step) && isPersonLedComputerStep(step, `${this.askedFor(waiting)} ${words}`)))
    ) {
      why = "read";
    }
    // Stopped, Go or Cancel pressed, or the card changed, while that was checked.
    if (!unchanged()) return false;
    if (!why) {
      if (hangup) waiting.hangup = true;
      this.answer({ text: en[CONFIRMED_KEY.ran], confirmed: "ran" });
      void this.run(waiting.id, !directGo && mode !== "never").catch(() => undefined);
      return true;
    }
    // The same plan again, newest, so a spoken "go" finds it; still waiting for the person's own Go.
    for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
    const fromReading = why === "read" || madeFromReading(waiting);
    this.answer({
      text: en[CONFIRMED_KEY[why]],
      confirmed: why,
      ...(checks.length ? { checks } : {}),
      ...(fromReading ? { fromReading: true } : {}),
      steps: structuredClone(steps),
      plan: "waiting",
      ...(hangup ? { hangup: true } : {}),
    });
    return true;
  }

  /** What the person said that led to this turn: their last words before it. */
  private askedFor(turn: OrchestratorTurn): string {
    const at = this.conversation.turns.indexOf(turn);
    for (let i = at - 1; i >= 0; i -= 1) {
      const item = this.conversation.turns[i];
      if (item.from === "you") return item.text;
    }
    return "";
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
    if (engineId === LOCAL_ENGINE_ID) {
      const { url, model, vibyModel } = this.core.store.readSettings().local;
      if (!url) return [vibyModel || model].filter(Boolean);
      const probe = await probeLocalServer(url);
      this.core.recordLocalProbe(probe);
      const ids = probe.models.map((item) => item.id);
      if (ids.length) {
        this.models.set(LOCAL_ENGINE_ID, ids);
        return ids;
      }
      return this.models.get(LOCAL_ENGINE_ID) ?? [vibyModel || model].filter(Boolean);
    }
    const engine = this.core.resolveEngine(engineId);
    const kind = engine ? brainKind(engine.row) : null;
    if (!engine || !kind) return [];
    const known = KNOWN_MODELS[kind];
    if (known) return known;
    if (kind !== "grok" && kind !== "agy") return [];
    const cached = this.models.get(engineId);
    if (cached) return cached;
    const work = path.join(this.dir, "work");
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    fs.chmodSync(work, 0o700);
    const run = await this.runner([engine.binPath, ...engine.row.args, "models"], work, new AbortController().signal, MODELS_TIMEOUT_MS);
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
    this.plannerPool.dropSession();
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
    const turns = this.conversation.turns;
    const latestNonNote = turns.findLast((turn) => !turn.note);
    const anyWaiting = [...turns].reverse().find((turn) => turn.plan === "waiting" && turn.steps?.length);
    const waitingForWord = latestNonNote?.plan === "waiting" && latestNonNote.steps?.length ? latestNonNote : undefined;
    const explicitSlash = /^\/(?:go|cancel)(?:\s|$)/i.test(trimmed);
    const waitingPlan = explicitSlash ? anyWaiting : waitingForWord;
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
    const effectiveContext = reflex.tag === "trust" ? await this.context(true) : context;
    const steps = resolvePlan({ say: "", steps: reflex.rawSteps }, effectiveContext);
    if (!steps.length || steps.some((step) => stepIssue(step, effectiveContext))) return { handled: false };
    const now = this.core.now().toISOString();
    this.conversation.turns.push({ id: turnId(), at: now, from: "you", text: trimmed });
    const startedAt = Date.now();
    if (reflex.tag === "diagnostics") {
      steps[0].state = "running";
      try {
        const res = await this.inspect(steps[0]);
        steps[0].state = "done";
        steps[0].result = res.summary;
        const answered = this.answer({
          text: res.summary,
          checks: [{ id: steps[0].id, kind: "inspect", label: "Diagnostics", summary: res.summary, details: res.details.slice(0, 6000) }],
          steps,
          plan: "done",
        });
        void answered;
        const metric = {
          at: this.core.now().toISOString(),
          source: "quickAct" as const,
          totalMs: Math.max(0, Date.now() - startedAt),
          outcome: "executed" as VibyTurnOutcome,
          stepKinds: steps.map((step) => step.kind),
          failedSteps: 0,
        };
        this.diagnostics.record(metric);
        this.core.options.host.logDiagnostics?.(formatDiagnosticsLogLine(metric));
        this.save();
        return { handled: true, reply: res.summary };
      } catch (error) {
        steps[0].state = "failed";
        steps[0].error = error instanceof Error ? error.message : String(error);
        const msg = steps[0].error || "Diagnostics failed.";
        this.answer({ text: msg, steps, plan: "done" });
        this.save();
        return { handled: true, reply: msg };
      }
    }
    if (reflex.tag === "trust" && this.settings().mode !== "never" && isHighRiskStep(steps[0], effectiveContext)) {
      for (const item of this.conversation.turns) if (item.plan === "waiting") item.plan = "replaced";
      const reply = `${reflex.label} is waiting on an approval prompt; say Go or press Go to confirm.`;
      this.answer({ text: reply, steps, plan: "waiting" });
      const metric = {
        at: this.core.now().toISOString(),
        source: "quickAct" as const,
        totalMs: Math.max(0, Date.now() - startedAt),
        outcome: "planned" as VibyTurnOutcome,
        stepKinds: steps.map((step) => step.kind),
        failedSteps: 0,
      };
      this.diagnostics.record(metric);
      this.core.options.host.logDiagnostics?.(formatDiagnosticsLogLine(metric));
      this.save();
      return { handled: true, reply };
    }
    const reply =
      reflex.tag === "show"
        ? (words?.opened?.(reflex.label) ?? `Opened ${reflex.label}.`)
        : reflex.tag === "undo"
          ? (words?.undone ?? "Restored.")
          : reflex.tag === "reviewed"
            ? (words?.reviewed ?? "Marked all runs reviewed.")
            : reflex.tag === "remember"
              ? (words?.remembered?.(reflex.label) ?? `Remembered in Viby memory: ${reflex.label}`)
              : reflex.tag === "trust"
                ? `Sent Enter to ${reflex.label}.`
                : reflex.tag === "routine-pause"
                  ? `Paused routine ${reflex.label}.`
                  : reflex.tag === "theme"
                    ? `Switched theme to ${reflex.label}.`
                    : (words?.stopped?.(steps.length) ?? `Stopped ${steps.length} running CLI${steps.length === 1 ? "" : "s"}.`);
    const answered = this.answer({ text: reply, steps, plan: "running" });
    let failedSteps = 0;
    for (const step of steps) {
      step.state = "running";
      try {
        await this.carryOut(answered, step);
        step.state = "done";
      } catch (error) {
        failedSteps += 1;
        step.state = "failed";
        step.error = error instanceof Error ? error.message : String(error);
      }
    }
    answered.plan = "done";
    const metric = {
      at: this.core.now().toISOString(),
      source: "quickAct" as const,
      totalMs: Math.max(0, Date.now() - startedAt),
      outcome: (failedSteps ? "failed" : "executed") as VibyTurnOutcome,
      stepKinds: steps.map((step) => step.kind),
      failedSteps,
    };
    this.diagnostics.record(metric);
    this.core.options.host.logDiagnostics?.(formatDiagnosticsLogLine(metric));
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
          engines: this.core.listEngines().map((row) => ({ id: row.id, label: row.label, available: row.available, bin: row.bin })),
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
    const runStartedAt = Date.now();
    const epoch = this.runEpoch;
    turn.plan = "running";
    this.save();
    let wavePtys: string[] = [];
    let lastSourceWorkspaceId: string | null = null;
    let lastOpenedWorkspaceId: string | null = null;
    // Whether the step or wave before carried out: one marked `after` depends on it, so it doesn't run when
    // that failed or was skipped ("fix it, then push" must not push a fix that never started).
    let prevOk = true;
    const allSteps = turn.steps ?? [];
    for (let idx = 0; idx < allSteps.length; idx += 1) {
      const step = allSteps[idx];
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (step.state === "done") {
        prevOk = true;
        continue;
      }
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
      const context = withPlannedWorkspaces(await this.context(), allSteps);
      if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
      if (stepIssue(step, context)) {
        step.state = "skipped";
        prevOk = false;
        this.save();
        continue;
      }
      // Run consecutive independent `start` steps in the current wave concurrently when all inputs are ready.
      if (step.kind === "start" && !step.after && !step.workspaceId.startsWith(PLANNED_PREFIX)) {
        const batch: OrchestratorStep[] = [step];
        for (let look = idx + 1; look < allSteps.length; look += 1) {
          const next = allSteps[look];
          if (next.kind !== "start" || next.after || next.workspaceId.startsWith(PLANNED_PREFIX) || stepIssue(next, context)) break;
          batch.push(next);
        }
        if (batch.length > 1) {
          for (const item of batch) item.state = "running";
          this.activity = { kind: "start", label: batch.map((item) => this.stepActivityLabel(item, context)).join(" · ") };
          this.save();
          const sourceWorkspaces = batch.map((item) => item.workspaceId || null);
          await Promise.all(
            batch.map(async (item) => {
              try {
                await this.carryOut(turn, item, epoch, auto);
                item.state = "done";
              } catch (error) {
                item.state = "failed";
                item.error = error instanceof Error ? error.message : String(error);
              }
            }),
          );
          for (let b = 0; b < batch.length; b += 1) {
            const item = batch[b];
            if (item.state === "done" && item.ptyId) {
              if (!wavePtys.includes(item.ptyId)) wavePtys.push(item.ptyId);
              lastSourceWorkspaceId = sourceWorkspaces[b];
              lastOpenedWorkspaceId = item.openedWorkspaceId || sourceWorkspaces[b];
            }
          }
          prevOk = batch.every((item) => item.state === "done");
          this.activity = null;
          if (this.runEpoch !== epoch || !this.conversation.turns.includes(turn)) return;
          this.save();
          idx += batch.length - 1;
          continue;
        }
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
    const failedSteps = allSteps.filter((step) => step.state === "failed").length;
    const metric = {
      at: this.core.now().toISOString(),
      source: "run" as const,
      totalMs: Math.max(0, Date.now() - runStartedAt),
      executionMs: Math.max(0, Date.now() - runStartedAt),
      outcome: (failedSteps ? "failed" : "executed") as VibyTurnOutcome,
      stepKinds: allSteps.map((step) => step.kind),
      failedSteps,
    };
    this.diagnostics.record(metric);
    this.core.options.host.logDiagnostics?.(formatDiagnosticsLogLine(metric));
    this.save();
    if (turn.hangup) this.onCall?.({ kind: "hangup" });
  }

  private async checkChainedPtyPrompt(ptyId: string): Promise<boolean> {
    if (!this.core.options.host.screen) return false;
    const screen = await this.core.options.host.screen(ptyId).catch(() => "");
    const waiting = screen ? detectWaitingPrompt(screen) : null;
    if (!waiting) return false;
    const session = this.core.live.get(ptyId);
    if (session?.orchestrated) this.addNote(session, "waiting", null, waiting);
    return true;
  }

  private waitForChainedPty(ptyId: string, epoch: number, turn: OrchestratorTurn): Promise<boolean> {
    if (!this.core.isLive(ptyId)) {
      const session = this.core.live.get(ptyId);
      const run = session?.runId ? this.core.store.getRun(session.runId) : null;
      return Promise.resolve(!run?.stopRequested);
    }
    return new Promise((resolve) => {
      let settled = false;
      let idle: NodeJS.Timeout | undefined;
      let maxWait: NodeJS.Timeout | undefined;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        if (maxWait) clearTimeout(maxWait);
        const set = this.chainWaiters.get(ptyId);
        set?.delete(done);
        if (set && !set.size) this.chainWaiters.delete(ptyId);
        resolve(ok && this.runEpoch === epoch && this.conversation.turns.includes(turn));
      };
      const set = this.chainWaiters.get(ptyId) ?? new Set();
      set.add(done);
      this.chainWaiters.set(ptyId, set);
      // Only going busy and then quiet settles the wait. A terminal that never gets busy
      // would hold the plan "running" for good, EXCEPT when blocked on a waiting TUI prompt.
      idle = setTimeout(() => {
        if (settled || !set.has(done) || this.core.live.get(ptyId)?.working || this.chainTimers.has(ptyId)) return;
        void this.checkChainedPtyPrompt(ptyId).then((blocked) => {
          if (!settled) done(!blocked);
        });
      }, this.chainIdleMs);
      idle.unref();
      maxWait = setTimeout(() => {
        done(false);
      }, this.chainMaxWaitMs);
      maxWait.unref();
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
      diagnostics: () =>
        this.diagnostics.formatSummary({
          warmActive: this.plannerPool.activePid !== null,
          cachedContext: this.cachedContext !== null,
          activeWaits: this.chainWaiters.size,
        }),
    };
  }

  private async carryOut(turn: OrchestratorTurn, step: OrchestratorStep, epoch = this.runEpoch, auto = false): Promise<void> {
    if (step.kind === "workspace") {
      await carryOutWorkspaceStep(this.entityDeps(), turn, step, auto);
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
    if (step.kind === "computer") {
      const computer = this.core.options.host.computer;
      if (!computer) throw new Error("Desktop computer control is not available on this display session.");
      const action = normalizeComputerAction(step.action || step.prompt);
      if (!action) throw new Error("Unsupported action.");
      const surface = parseComputerSurface(step.options, step.target);
      // Checked when it runs, not when it was planned: the person may have changed it since.
      const blocked = computerUseBlocked(this.core.store.readSettings().computerUse, surface, computerGrantFor(action));
      if (blocked) throw new Error(blocked);
      step.result = await computer.act({
        action,
        surface,
        target: step.target,
        prompt: step.prompt,
        ...(step.options ? { options: step.options } : {}),
      });
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
      let setupCommand: string | null = null;
      if (step.branch.trim() && (await isGitRepo(workspace.path).catch(() => false))) {
        if (await hasCommit(workspace.path)) {
          // A copy of its own, as a task gets, so the work comes back for review: Apply or Discard.
          const copy = await this.copies.make({ turnId: turn.id, stepId: step.id, engineId: step.engineId, prompt: step.prompt, branch: step.branch, workspace });
          step.copyId = copy.id;
          step.branch = copy.branch;
          workspaceId = copy.openedWorkspaceId;
          setupCommand = copy.setupCommand;
          // An agent's brief names its allowed folders: it's told to work in the copy instead.
          const opened = this.core.workspaceById(workspaceId);
          if (opened) copyOf = { path: opened.path, of: workspace.path };
          this.save();
        } else {
          step.branch = "";
        }
      }
      step.openedWorkspaceId = workspaceId;
      const launched = await this.workspaces.startEngine({ workspaceId, engineId: step.engineId, agentId: step.agentId, copyOf, prompt: step.prompt, orchestrated: true, setupCommand, model: step.model, effort: step.effort, ...START_SIZE });
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
  inspect(step: OrchestratorStep): Promise<{ summary: string; details: string; imagePath?: string }> {
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
        if (!live?.working) {
          void this.checkChainedPtyPrompt(ptyId).then((blocked) => {
            if (this.core.live.get(ptyId)?.working) return;
            this.settleChainWaiters(ptyId, !blocked);
          });
        }
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
    this.plannerPool.dispose();
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
