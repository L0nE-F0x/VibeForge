// The Orchestrator's plans as both sides see them: the main process makes and carries them out
// (src/core/orchestrator.ts), the window shows them and lets a person fix one before Go. No Node
// here, so the window can check a step the same way the main process does.

import type { EngineRow } from "../core/types.js";
import type { en } from "../ui/i18n/en.js";
import { effortLevels } from "./launch-options.js";
import {
  inspectsProblems,
  inspectsStorage,
  isClearWord,
  normalizeAgentAction,
  normalizeChatAction,
  normalizeMemoryAction,
  normalizeRoutineStepAction,
  normalizeRunAction,
  normalizeSkillAction,
  normalizeTalkAction,
  normalizeTaskStepAction,
  normalizeWorkspaceAction,
  parseOptions,
  parseRoutineSchedule,
  parseTaskStatus,
} from "./orchestrator-actions.js";
import { inspectsQuotas, keySequenceFor, parseWorkbenchAction } from "./orchestrator-intel.js";
import { inspectsSettings, resolveSettingsStep, type PlanSettingsContext } from "./orchestrator-settings.js";
import { computerStepIssue } from "./computer-use.js";

export * from "./computer-use.js";
export * from "./orchestrator-actions.js";
export * from "./orchestrator-fuzzy.js";
export * from "./orchestrator-intel.js";
export * from "./orchestrator-reflex.js";
export * from "./orchestrator-repair.js";
export * from "./orchestrator-settings.js";

/**
 * start, tell, stop: a CLI (or an agent). workspace: make, rename, move, or remove a workspace.
 * apply, discard: a copy waiting for review. show: a running CLI, workspace, view, or specific item.
 * read: what a running CLI last answered, shown on the card and read out in a call.
 * inspect: read a CLI's screen/reply, a copy's diff, a workspace's git status/files/branches, quotas, settings, storage, or an agent/skill/routine/task/chat/run.
 * key: send a keystroke/answer (yes, no, enter, escape, option number) to an interactive TUI prompt.
 * shell: open a shell terminal or run a command in a workspace.
 * workbench: folders, git branches, browser dock, panes, diffs, undo last delete, or marking runs reviewed.
 * settings: change VibeForge settings, rail, custom CLIs, Viby's own planner/model/effort, and voice/STT models.
 * lookup: search runs, git branches and project folders on disk.
 * task: create, edit, delete, run, continue, stop, move status, apply/discard copy, or hand off tasks.
 * routine: create, edit, delete, schedule, attach agent/task, run, pause/resume, or cancel wait on routines.
 * agent: create, edit, delete, manage folders/skills, or read/write/clear memory of saved agents.
 * skill: create, edit, delete skills and attach/detach agents.
 * chat: create, send messages to, continue, stop, rename, switch CLI, or delete plain/agent chats.
 * run: continue, stop, mark reviewed/unreviewed, hand off a run, or tidy run storage.
 * talk: coordinate live CLIs (start review loop, send draft between panes, stop talk, start held handed-out tasks).
 * verify: run a test/build/lint check in a workspace or copy and auto-nudge a live CLI to fix failures.
 * memory: append, set, or clear Viby's own durable plain-text memory (~/.config/vibeforge/viby.md).
 */
export type OrchestratorStepKind =
  | "start"
  | "tell"
  | "stop"
  | "workspace"
  | "apply"
  | "discard"
  | "show"
  | "read"
  | "inspect"
  | "key"
  | "shell"
  | "workbench"
  | "settings"
  | "lookup"
  | "task"
  | "routine"
  | "agent"
  | "skill"
  | "chat"
  | "run"
  | "talk"
  | "verify"
  | "memory"
  | "computer";

/** Every kind of step, for checking what a planner wrote. */
export const STEP_KINDS: readonly OrchestratorStepKind[] = [
  "start",
  "tell",
  "stop",
  "workspace",
  "apply",
  "discard",
  "show",
  "read",
  "inspect",
  "key",
  "shell",
  "workbench",
  "settings",
  "lookup",
  "task",
  "routine",
  "agent",
  "skill",
  "chat",
  "run",
  "talk",
  "verify",
  "memory",
  "computer",
];

/** The steps that change or end someone's work: they wait for Go even when plans start at once. */
export const NEEDS_GO: readonly OrchestratorStepKind[] = ["stop", "apply", "discard", "computer"];

/** The steps that change nothing: a plan made only of these goes at once, whatever Settings says. */
export const ONLY_LOOKS: readonly OrchestratorStepKind[] = ["show", "read", "inspect"];

/** Why a step can't run as it stands; the plan card asks the person to fix it. */
export type StepIssue = "workspace" | "engine" | "engineMissing" | "target" | "prompt" | "effort" | "folder" | "copy" | "schedule" | "name";

/** A workspace a plan makes, until its step has run: later steps name it by this id. */
export const PLANNED_PREFIX = "new:";
export const plannedId = (stepId: string) => `${PLANNED_PREFIX}${stepId}`;

export interface OrchestratorStep {
  id: string;
  kind: OrchestratorStepKind;
  /** start: the CLI to open. */
  engineId: string;
  /** start, task: a saved VibeForge agent when one was named. */
  agentId?: string;
  /** start, task: the workspace it works on. */
  workspaceId: string;
  /** start: the new branch, in its own copy of the workspace. Empty when the folder isn't a git repository. */
  branch: string;
  /** start: its first instruction. tell: the message. read: "all" for the whole answer, empty for the start of it. */
  prompt: string;
  /** tell, stop, read: the terminal. */
  target: string;
  /** What the plan named, for a workspace, engine or terminal VibeForge couldn't find. */
  asked: string;
  state: "planned" | "running" | "done" | "failed" | "skipped";
  /** Why it failed: the main process's own message. */
  error: string | null;
  /** start: the terminal it opened, and the workspace that terminal is in (the copy's). */
  ptyId: string | null;
  runId?: string | null;
  openedWorkspaceId: string | null;
  /** start: its own copy (a MaestroCopy's id), made when it ran in a git workspace on a branch. */
  copyId?: string | null;
  /** start: what became of that copy, once a person applied or discarded it. */
  outcome?: "applied" | "discarded" | null;
  /** start: the model and reasoning effort it starts with; empty keeps the CLI's own. */
  model?: string;
  effort?: string;
  /** start, on a branch: files changed in the workspace and not committed, which the copy won't have. */
  dirty?: number;
  /** workspace: its name, the folder it is (made if missing), and whether to `git init` a folder it makes. */
  name?: string;
  folder?: string;
  git?: boolean;
  /** apply: how it went, when there's more to say than done (conflicts to sort out). */
  result?: string | null;
  /** discard: the token that undoes it, while it can be undone. */
  undo?: string | null;
  /** read: what that CLI last answered, as it wrote it. It stays on this machine: the planner is never sent it. */
  reply?: string;
  /** show: a view of the window (SHOW_VIEWS), when it shows one instead of a terminal or a workspace. */
  view?: string;
  /** Wait for the preceding step's terminal turn to finish before carrying this step out. */
  after?: boolean;
  /** Sub-action for multi-operation step kinds (agent, routine, task, skill, workspace, chat, run, talk). */
  action?: string;
  /** Short description (skill description, agent goodAt). */
  description?: string;
  /** Routine schedule (5-field cron, interval like "every 30 minutes", or natural phrase). */
  schedule?: string;
  /** Task id attached to a routine step. */
  taskId?: string;
  /** Status, target index, or sub-mode (e.g. task status "todo" | "review" | "done"). */
  status?: string;
  /** Allowed folder paths or planned workspace ids (for agent steps). */
  places?: string[];
  /** Skill ids attached to an agent step. */
  skills?: string[];
  /** Agent ids attached to a skill step, or secondary target PTY id for a talk step. */
  agents?: string[];
  /** Raw options string ("notify=false, shareCheckout=true, isolated=true, tier=strong"). */
  options?: string;
  /** Deep-link route extras for `show` steps (e.g. agentId, tab, taskId, routineId, skillId, chatId, runId, section). */
  route?: Record<string, string>;
}

/** The views a show step can open: the window's own names for them. */
export const SHOW_VIEWS = ["home", "agents", "code", "chat", "tasks", "routines", "skills", "runs", "orchestrator", "settings"] as const;

/** Where the person is in the window when they speak to Viby: the view, and in Code the workspace and the terminal with focus. */
export interface Looking {
  view: string;
  workspaceId?: string;
  ptyId?: string;
}

/**
 * A start step's own copy of its workspace, made the way a task's is: a git worktree in
 * VibeForge's worktrees folder on a `vibeforge/` branch, opened as a workspace of its own. Like a
 * task's, it waits for a person: its changes to review, then Apply into the workspace it came
 * from, or Discard (with Undo), which takes the copy, its branch and its workspace away.
 */
export interface MaestroCopy {
  /** Its folder's name under worktrees/, and its branch's after `vibeforge/`. */
  id: string;
  /** The plan step that made it. */
  turnId: string;
  stepId: string;
  engineId: string;
  prompt: string;
  /** The branch name the plan asked for, for its label. */
  name: string;
  /** The workspace it was made from, which Apply brings the changes into. */
  workspaceId: string;
  /** Its own workspace in Code. */
  openedWorkspaceId: string | null;
  at: string;
  /** The worktree, as src/core/worktrees.ts's WorkingCopy: its folder, branch, base commit and repository. */
  path: string;
  branch: string;
  base: string;
  repo: string;
}

/** The fields a plan card can change on a step before Go. */
export type StepPatch = Partial<
  Pick<OrchestratorStep, "engineId" | "agentId" | "workspaceId" | "branch" | "prompt" | "target" | "model" | "effort" | "name" | "folder" | "git" | "description" | "schedule" | "status" | "options">
>;

export type OrchestratorProblem = "noEngine" | "failed" | "unreadable" | "timeout" | "stopped" | "signIn";

/** A word from VibeForge itself about a CLI Maestro started or told: its turn ended, it closed, or it is blocked on a prompt. */
export interface MaestroNote {
  kind: "finished" | "ended" | "waiting";
  ptyId: string;
  runId: string | null;
  /** "Claude Code", and where: "VibeForge · fix-tray". */
  engine: string;
  workspace: string;
  workspaceId: string | null;
  /** Its copy, if it works in one, for Review. */
  copyId: string | null;
  /** "2 commits · 3 files changed", when git could say. */
  changes: string | null;
  /** The start of what it answered, when its own log has that. */
  reply?: string | null;
}

/** What Viby says or does by itself while a call is on: a note about a CLI, an answer a read step fetched, or ending the call. */
export type VibyWord =
  | { kind: "note"; note: MaestroNote }
  | { kind: "read"; engine: string; workspace: string; reply: string; all: boolean; fromScreen: boolean }
  | { kind: "hangup" };

export interface OrchestratorCheck {
  id: string;
  kind: "lookup" | "inspect" | "verify";
  /** Short target label for the chip ("Claude Code · VibeForge", "auth", "npm test"). */
  label: string;
  summary: string;
  details: string;
  ptyId?: string | null;
  workspaceId?: string | null;
  copyId?: string | null;
}

export interface OrchestratorThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
}

export interface OrchestratorActivity {
  kind: OrchestratorStepKind;
  /** Short target label for the live line ("Claude Code · VibeForge", "fix-tray"). */
  label: string;
}

export type PlanConfirmed = "ran" | "risky" | "read" | "fix";

/** The words for a yes the planner heard (`confirmed` on a turn), in the person's language where the window or a call says them. */
export const CONFIRMED_KEY = {
  ran: "core.orchConfirmedRan",
  risky: "core.orchConfirmedRisky",
  read: "core.orchConfirmedRead",
  fix: "core.orchConfirmedFix",
} as const satisfies Record<PlanConfirmed, keyof typeof en>;

export interface OrchestratorTurn {
  id: string;
  at: string;
  from: "you" | "vibeforge";
  text: string;
  /** Image filenames attached to this turn, saved under dataRoot/orchestrator/images/. */
  images?: string[];
  /** VibeForge's own word about a CLI, not the planner's answer. */
  note?: MaestroNote;
  /** Inline inspections or lookups Viby carried out while forming this answer. */
  checks?: OrchestratorCheck[];
  /** A plan: steps, and where it is. "replaced" is a plan the next answer took over. */
  steps?: OrchestratorStep[];
  plan?: "waiting" | "running" | "done" | "cancelled" | "replaced";
  /** End the active voice call once this turn (and any plan it runs) has been carried out. */
  hangup?: boolean;
  /**
   * The planner took what the person said as a yes to the plan waiting for Go. "ran": that plan is
   * carried out as it stood. Otherwise this turn puts the same plan back, still waiting for their own
   * Go, and says why: a step changes or stops something ("risky"), it came from what Viby read ("read"),
   * or a step needs something picked first ("fix").
   */
  confirmed?: PlanConfirmed;
  /**
   * The plan is the same as one still waiting that Viby made from what it read (a screen, a file, a
   * diff or a reply): it waits for Go as that one did, though this turn read nothing (decision D1).
   */
  fromReading?: boolean;
  /** The CLI that gave this answer (an engine id), so its words keep its name after the planner changes. */
  by?: string;
  /** The answer went wrong. `detail` is what the CLI said, if anything. */
  problem?: OrchestratorProblem;
  detail?: string;
}

export interface OrchestratorView {
  /** The engine that plans, and whether it is on this machine. */
  engineId: string;
  engineReady: boolean;
  mode: "plan" | "go";
  /** Waiting for the planning CLI's answer. */
  thinking: boolean;
  /** What Viby is actively checking or carrying out right now, for the thin live status line. */
  activity?: OrchestratorActivity | null;
  turns: OrchestratorTurn[];
  /** Copies waiting for a person to apply or discard them, oldest first. */
  copies?: MaestroCopy[];
  /** Where a new workspace's folder goes unless a step says otherwise (Settings, or where most are). */
  projectsFolder?: string;
  /** Active conversation thread id, and saved threads for quick switching/search. */
  activeThreadId?: string;
  threads?: OrchestratorThreadSummary[];
  /** Whether ~/.config/vibeforge/viby.md currently holds non-empty memory. */
  hasMemory?: boolean;
}

/** The engines that can plan: the ones with a headless turn, structured output and a way to turn tools off. */
export function canOrchestrate(row: Pick<EngineRow, "id" | "bin">): boolean {
  return brainKind(row) !== null;
}

export type BrainKind = "grok" | "claude" | "codex" | "agy";

/**
 * The CLI that plans: the one picked in Settings while it is on this machine; until one is picked
 * (or once it's gone), Grok Build, else the first CLI here that can plan, so a machine with only
 * Claude Code plans with Claude Code. Empty when none can.
 */
export function plannerFor(picked: string, engines: ReadonlyArray<Pick<EngineRow, "id" | "bin"> & { available: boolean }>): string {
  const usable = engines.filter((engine) => engine.available && canOrchestrate(engine));
  return (usable.find((engine) => engine.id === picked) ?? usable.find((engine) => brainKind(engine) === "grok") ?? usable[0])?.id ?? "";
}

/**
 * Which planner a CLI is: the four frontier labs' own CLIs, each with a headless turn, output held
 * to a JSON schema, and a way to keep it from changing anything. Grok Build, Claude Code, Codex,
 * and Antigravity CLI (Google's, for Gemini).
 */
export function brainKind(row: Pick<EngineRow, "id" | "bin">): BrainKind | null {
  const name = `${row.id} ${row.bin.split("/").pop() ?? row.bin}`.toLowerCase();
  if (/\bgrok\b/.test(name)) return "grok";
  if (/\bclaude\b/.test(name)) return "claude";
  if (/\bcodex\b/.test(name)) return "codex";
  if (/\bagy\b|antigravity/.test(name)) return "agy";
  return null;
}

/** Model names a planner takes without asking it: Claude Code's aliases. The others list theirs. */
export const KNOWN_MODELS: Partial<Record<BrainKind, string[]>> = {
  claude: ["haiku", "sonnet", "opus", "fable"],
};

/**
 * What whisper is told to listen for when someone talks to the Orchestrator, on the desktop or the
 * phone: workspace names are what gets misheard ("Star Ledger", "frontier-halls"), and a few words
 * every request has.
 */
export function orchestratorVoiceWords(
  workspaces: readonly string[],
  extra?: { agents?: readonly string[]; engines?: readonly string[]; skills?: readonly string[]; routines?: readonly string[] },
): string[] {
  const wsWords = workspaces.flatMap((name) => [name, name.replace(/[-_.]+/g, " ")]);
  if (!extra) return ["Viby", "Vibey", ...wsWords, "branch", "workspace"];
  const all = [
    "VibeForge",
    "Omarchy",
    "Hyprland",
    ...(extra.agents ?? []),
    ...(extra.engines ?? []),
    ...(extra.skills ?? []),
    ...(extra.routines ?? []),
    "Viby",
    "Vibey",
    ...wsWords,
  ];
  const deduped = [...new Set(all.map((w) => w.trim()).filter(Boolean))];
  return [...deduped, "branch", "workspace"];
}

export interface PlanContext {
  workspaces: Array<{ id: string; name: string; folder: string; git: boolean }>;
  /** `bin` tells which model and effort options a CLI takes; without it, none are checked. */
  engines: Array<{ id: string; label: string; available: boolean; bin?: string }>;
  /** Default CLI id when the person asks to start work without naming a specific CLI. */
  defaultEngine?: string;
  running: Array<{
    id: string;
    engine: string;
    workspace: string;
    folder: string;
    working: boolean;
    orchestrated: boolean;
    /** What it was first asked to do, cut short. */
    asked?: string;
    /** Its copy's branch, when it works in one. */
    branch?: string;
    /** Interactive TUI prompt on screen waiting for a person (folder trust, y/n confirmation). */
    waiting?: string;
  }>;
  /** Copies waiting for review (Apply or Discard). */
  copies?: Array<{ id: string; name: string; branch: string; workspace: string }>;
  /** Saved VibeForge agents (teammates with their own brief, memory, skills and engine). */
  agents?: Array<{
    id: string;
    name: string;
    engine: string;
    goodAt?: string;
    places?: string[];
    skills?: string[];
    allowRoutines?: boolean;
    tier?: string;
  }>;
  /** Reusable skills (SKILL.md know-how attached to agents). */
  skills?: Array<{ id: string; name: string; description?: string; agents?: string[] }>;
  /** Tasks on the board. */
  tasks?: Array<{
    id: string;
    title: string;
    status: string;
    workspace?: string;
    workspaceId?: string;
    agent?: string;
    agentId?: string;
    isolated?: boolean;
    hasCopy?: boolean;
    waiting?: boolean;
  }>;
  /** Scheduled routines. */
  routines?: Array<{
    id: string;
    name: string;
    schedule: string;
    enabled: boolean;
    agent?: string;
    agentId?: string;
    notify?: boolean;
    shareCheckout?: boolean;
    waiting?: boolean;
    running?: boolean;
  }>;
  /** Plain and agent chats. */
  chats?: Array<{ id: string; title: string; engine: string; agent?: string; agentId?: string | null; live: boolean }>;
  /** Recent runs (for continuing, marking reviewed, inspecting, or handing off). */
  runs?: Array<{ id: string; title: string; status: string; engine: string; origin: string; opened: boolean; changes?: string | null; agent?: string }>;
  /** Where a new workspace goes when the person doesn't say. */
  projectsFolder?: string;
  /** Viby's own durable plain-text memory (~/.config/vibeforge/viby.md). */
  memory?: string;
  /** Agents, skills, routines or tasks that are there but couldn't be read, each as why: not missing, so not to be made again. */
  unreadable?: string[];
  /** Viby's own settings, voice/STT models, and VibeForge configuration. */
  settings?: PlanSettingsContext;
}

/**
 * The context a plan's steps are checked against: what is here, plus any workspaces, agents, skills,
 * tasks, routines, or chats that earlier steps in the same plan will create, under placeholder ids.
 */
export function withPlannedWorkspaces(context: PlanContext, steps: readonly OrchestratorStep[]): PlanContext {
  const active = steps.filter((step) => step.state === "planned" || step.state === "running");
  const plannedWs = active.filter((step) => step.kind === "workspace" && (!step.action || step.action === "create"));
  const plannedAgents = active.filter((step) => step.kind === "agent" && step.action === "create");
  const plannedSkills = active.filter((step) => step.kind === "skill" && step.action === "create");
  const plannedTasks = active.filter((step) => step.kind === "task" && (step.action === "create" || step.action === "create-run" || (!step.action && !step.target)));
  const plannedRoutines = active.filter((step) => step.kind === "routine" && step.action === "create");
  const plannedChats = active.filter((step) => step.kind === "chat" && step.action === "create");
  if (!plannedWs.length && !plannedAgents.length && !plannedSkills.length && !plannedTasks.length && !plannedRoutines.length && !plannedChats.length) {
    return context;
  }
  return {
    ...context,
    workspaces: [
      ...context.workspaces,
      ...plannedWs.map((step) => ({ id: plannedId(step.id), name: step.name ?? "", folder: step.folder ?? "", git: false })),
    ],
    ...(plannedAgents.length
      ? {
          agents: [
            ...(context.agents ?? []),
            ...plannedAgents.map((step) => ({ id: plannedId(step.id), name: step.name ?? "", engine: step.engineId, places: step.places ?? [] })),
          ],
        }
      : {}),
    ...(plannedSkills.length
      ? {
          skills: [
            ...(context.skills ?? []),
            ...plannedSkills.map((step) => ({ id: plannedId(step.id), name: step.name ?? "", description: step.description ?? "" })),
          ],
        }
      : {}),
    ...(plannedTasks.length
      ? {
          tasks: [
            ...(context.tasks ?? []),
            ...plannedTasks.map((step) => ({
              id: plannedId(step.id),
              title: step.name ?? "",
              status: "todo",
              ...(step.agentId ? { agentId: step.agentId } : {}),
              ...(step.workspaceId ? { workspaceId: step.workspaceId } : {}),
            })),
          ],
        }
      : {}),
    ...(plannedRoutines.length
      ? {
          routines: [
            ...(context.routines ?? []),
            ...plannedRoutines.map((step) => ({ id: plannedId(step.id), name: step.name ?? "", schedule: step.schedule ?? "", enabled: true })),
          ],
        }
      : {}),
    ...(plannedChats.length
      ? {
          chats: [
            ...(context.chats ?? []),
            ...plannedChats.map((step) => ({ id: plannedId(step.id), title: step.name ?? "New chat", engine: step.engineId, live: false })),
          ],
        }
      : {}),
  };
}

/** A workspace's name as a folder's: something, and nothing that would put it somewhere else. */
export function folderNameOk(name: string): boolean {
  const clean = name.trim();
  return clean.length > 0 && clean.length <= 120 && !/[\\/\0]/.test(clean) && clean !== "." && clean !== "..";
}

function folderPathOk(folder: string): boolean {
  const trimmed = folder.trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return Boolean(stripped && stripped !== "~" && (trimmed.startsWith("/") || trimmed.startsWith("~/")) && !trimmed.split("/").includes(".."));
}

function placeOk(place: string, context: PlanContext): boolean {
  const trimmed = place.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(PLANNED_PREFIX)) return context.workspaces.some((item) => item.id === trimmed);
  return folderPathOk(trimmed);
}

function checkEngine(engineId: string, context: PlanContext): StepIssue | null {
  const engine = context.engines.find((item) => item.id === engineId);
  if (!engine) return "engine";
  if (!engine.available) return "engineMissing";
  return null;
}

/** What stands in a step's way, given what's here now. */
export function stepIssue(step: OrchestratorStep, context: PlanContext): StepIssue | null {
  if (step.kind === "workspace") {
    const action = normalizeWorkspaceAction(step.action);
    if (!action) return "prompt";
    if (action === "create") {
      if (!folderNameOk(step.name ?? "") || !folderPathOk(step.folder ?? "")) return "folder";
      return null;
    }
    const wsId = step.workspaceId || step.target;
    if (!wsId || !context.workspaces.some((item) => item.id === wsId)) return "workspace";
    if (action === "rename") return folderNameOk(step.name ?? step.prompt ?? "") ? null : "name";
    if (action === "move") {
      const pos = (step.status || step.prompt || parseOptions(step.options).str("index") || "").trim().toLowerCase();
      if (!pos) return "prompt";
      if (/^(?:top|first|bottom|last|up|down|\d+)$/.test(pos)) return null;
      return "prompt";
    }
    return null;
  }
  if (step.kind === "start") {
    if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    const engineErr = checkEngine(step.engineId, context);
    if (engineErr) return engineErr;
    const engine = context.engines.find((item) => item.id === step.engineId)!;
    const effort = step.effort?.trim().toLowerCase();
    if (effort && engine.bin !== undefined && !effortLevels({ id: engine.id, bin: engine.bin }).includes(effort)) return "effort";
    return null;
  }
  if (step.kind === "apply" || step.kind === "discard") {
    return (context.copies ?? []).some((item) => item.id === step.target) ? null : "copy";
  }
  if (step.kind === "lookup") {
    return step.prompt.trim() ? null : "prompt";
  }
  if (step.kind === "computer") {
    return computerStepIssue(step);
  }
  if (step.kind === "inspect") {
    if (
      inspectsQuotas(step.prompt) ||
      inspectsQuotas(step.target) ||
      inspectsSettings(step.prompt) ||
      inspectsSettings(step.target) ||
      inspectsStorage(step.prompt) ||
      inspectsStorage(step.target) ||
      inspectsProblems(step.prompt) ||
      inspectsProblems(step.target) ||
      step.action === "storage" ||
      step.action === "problems" ||
      step.action === "diagnostics" ||
      step.action === "screen" ||
      step.action === "desktop" ||
      step.action === "windows" ||
      step.action === "app-ui" ||
      step.action === "browser-ui"
    ) {
      return null;
    }
    if (step.action === "compare") {
      return (context.copies ?? []).length > 0 ? null : "copy";
    }
    if (step.action && ["agent", "skill", "routine", "task", "chat", "run"].includes(step.action)) {
      if (!step.target) return "target";
      if (step.action === "agent" && context.agents && !context.agents.some((a) => a.id === step.target)) return "target";
      if (step.action === "skill" && context.skills && !context.skills.some((s) => s.id === step.target)) return "target";
      if (step.action === "routine" && context.routines && !context.routines.some((r) => r.id === step.target)) return "target";
      if (step.action === "task" && context.tasks && !context.tasks.some((t) => t.id === step.target)) return "target";
      if (step.action === "chat" && context.chats && !context.chats.some((c) => c.id === step.target)) return "target";
      return null;
    }
    if (step.target) {
      const hasCli = context.running.some((item) => item.id === step.target);
      const hasCopy = (context.copies ?? []).some((item) => item.id === step.target);
      const hasAgent = (context.agents ?? []).some((item) => item.id === step.target);
      const hasSkill = (context.skills ?? []).some((item) => item.id === step.target);
      const hasRoutine = (context.routines ?? []).some((item) => item.id === step.target);
      const hasTask = (context.tasks ?? []).some((item) => item.id === step.target);
      const hasChat = (context.chats ?? []).some((item) => item.id === step.target);
      const hasRun = (context.runs ?? []).some((item) => item.id === step.target);
      return hasCli || hasCopy || hasAgent || hasSkill || hasRoutine || hasTask || hasChat || hasRun ? null : "target";
    }
    if (step.workspaceId) return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
    return "workspace";
  }
  if (step.kind === "settings") {
    return resolveSettingsStep(step, context).issue;
  }
  if (step.kind === "key") {
    if (!context.running.some((item) => item.id === step.target)) return "target";
    return keySequenceFor(step.prompt) ? null : "prompt";
  }
  if (step.kind === "shell") {
    return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
  }
  if (step.kind === "workbench") {
    const action = parseWorkbenchAction(step);
    if (!action) return "prompt";
    if ((action.op === "branch" || action.op === "browser-open" || action.op === "open-folder") && !context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    return null;
  }
  if (step.kind === "agent") {
    const action = normalizeAgentAction(step.action, Boolean(step.target));
    if (!action) return "prompt";
    if (action === "create") {
      if (!(step.name ?? "").trim()) return "name";
      const engineErr = checkEngine(step.engineId, context);
      if (engineErr) return engineErr;
      if (!step.prompt.trim()) return "prompt";
      const places = step.places ?? [];
      if (!places.length || !places.every((p) => placeOk(p, context))) return "folder";
      if (step.skills?.length && context.skills && !step.skills.every((id) => context.skills!.some((s) => s.id === id))) return "target";
      return null;
    }
    if (!step.target || (context.agents && !context.agents.some((item) => item.id === step.target))) return "target";
    if (action === "delete" || action === "memory-clear") return null;
    if (action === "memory-set" || action === "memory-append") return step.prompt.trim() ? null : "prompt";
    if (action === "add-folder" || action === "remove-folder") {
      const places = step.places ?? [];
      return places.length > 0 && places.every((p) => placeOk(p, context)) ? null : "folder";
    }
    if (action === "add-skill" || action === "remove-skill") {
      const skills = step.skills ?? [];
      if (!skills.length) return "target";
      if (context.skills && !skills.every((id) => context.skills!.some((s) => s.id === id))) return "target";
      return null;
    }
    // edit
    if (step.engineId) {
      const engineErr = checkEngine(step.engineId, context);
      if (engineErr) return engineErr;
    }
    if (step.places?.length && !step.places.every((p) => placeOk(p, context))) return "folder";
    if (step.skills?.length && context.skills && !step.skills.every((id) => context.skills!.some((s) => s.id === id))) return "target";
    return null;
  }
  if (step.kind === "skill") {
    const action = normalizeSkillAction(step.action, Boolean(step.target));
    if (!action) return "prompt";
    if (action === "create") {
      if (!(step.name ?? "").trim()) return "name";
      if (step.agents?.length && context.agents && !step.agents.every((id) => context.agents!.some((a) => a.id === id))) return "engine";
      return null;
    }
    if (!step.target || (context.skills && !context.skills.some((item) => item.id === step.target))) return "target";
    if (action === "delete" || action === "edit") return null;
    if (action === "attach" || action === "detach") {
      const agents = step.agents ?? [];
      if (!agents.length) return "engine";
      if (context.agents && !agents.every((id) => context.agents!.some((a) => a.id === id))) return "engine";
      return null;
    }
    // set-agents
    const opts = parseOptions(step.options);
    const clearing = isClearWord(opts.str("agents"));
    const agents = step.agents ?? [];
    if (!agents.length && !clearing) return "engine";
    if (context.agents && !agents.every((id) => context.agents!.some((a) => a.id === id))) return "engine";
    return null;
  }
  if (step.kind === "routine") {
    const hasCreateFields = Boolean(step.schedule?.trim() || step.name?.trim() || step.agentId || step.taskId);
    const action = normalizeRoutineStepAction(step.action, step.prompt, Boolean(step.target), hasCreateFields);
    if (!action) return "prompt";
    if (action === "create") {
      const task = step.taskId ? (context.tasks ?? []).find((item) => item.id === step.taskId) : undefined;
      if (step.taskId && context.tasks && !task) return "target";
      if (!(step.name ?? "").trim() && !step.taskId) return "name";
      const effectiveAgentId = step.agentId || task?.agentId || "";
      const hasAgentViaTaskName = Boolean(!effectiveAgentId && task?.agent);
      if (!effectiveAgentId && !hasAgentViaTaskName) return "engine";
      if (effectiveAgentId && context.agents && !context.agents.some((item) => item.id === effectiveAgentId)) return "engine";
      if (!parseRoutineSchedule(step.schedule)) return "schedule";
      if (!step.prompt.trim() && !step.taskId) return "prompt";
      return null;
    }
    if (!step.target || (context.routines && !context.routines.some((item) => item.id === step.target))) return "target";
    if (action === "edit") {
      if (step.schedule?.trim() && !parseRoutineSchedule(step.schedule)) return "schedule";
      if (step.agentId && context.agents && !context.agents.some((item) => item.id === step.agentId)) return "engine";
      if (step.taskId && context.tasks && !context.tasks.some((item) => item.id === step.taskId)) return "target";
      return null;
    }
    // Legacy prompt safety check when action was omitted
    if (!step.action && step.prompt !== "" && step.prompt !== "enable" && step.prompt !== "disable") return "prompt";
    return null;
  }
  if (step.kind === "task") {
    const action = normalizeTaskStepAction(step.action, Boolean(step.target), Boolean(step.workspaceId || step.agentId || step.name || step.prompt));
    if (!action) return "prompt";
    if (action === "handoff") {
      if (!step.target.trim()) return "target";
      if (!step.agentId || (context.agents && !context.agents.some((item) => item.id === step.agentId))) return "engine";
      return null;
    }
    if (action === "create") {
      if (!(step.name ?? "").trim() && !step.prompt.trim()) return "name";
      if (step.workspaceId && !context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
      if (step.agentId && context.agents && !context.agents.some((item) => item.id === step.agentId)) return "engine";
      return null;
    }
    if (action === "create-run") {
      if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
      if (!step.agentId || (context.agents && !context.agents.some((item) => item.id === step.agentId))) return "engine";
      return step.prompt.trim() ? null : "prompt";
    }
    if (!step.target || (context.tasks && !context.tasks.some((item) => item.id === step.target))) return "target";
    if (action === "status") return parseTaskStatus(step.status || step.prompt) ? null : "prompt";
    if (action === "edit") {
      if (step.workspaceId && !context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
      if (step.agentId && context.agents && !context.agents.some((item) => item.id === step.agentId)) return "engine";
      if (step.status?.trim() && !parseTaskStatus(step.status)) return "prompt";
      return null;
    }
    return null;
  }
  if (step.kind === "chat") {
    const action = normalizeChatAction(step.action, Boolean(step.target), Boolean(step.prompt.trim()));
    if (!action) return "prompt";
    if (action === "create") {
      if (step.agentId) {
        return context.agents && !context.agents.some((item) => item.id === step.agentId) ? "engine" : null;
      }
      return checkEngine(step.engineId, context);
    }
    if (action === "send") {
      if (!step.prompt.trim()) return "prompt";
      if (step.target) return context.chats && !context.chats.some((item) => item.id === step.target) ? "target" : null;
      if (step.agentId) return context.agents && !context.agents.some((item) => item.id === step.agentId) ? "engine" : null;
      return "target";
    }
    if (!step.target || (context.chats && !context.chats.some((item) => item.id === step.target))) return "target";
    if (action === "rename") return (step.name ?? step.prompt ?? "").trim() ? null : "name";
    if (action === "set-engine") return checkEngine(step.engineId, context);
    return null;
  }
  if (step.kind === "run") {
    const action = normalizeRunAction(step.action);
    if (!action) return "prompt";
    if (action === "mark-all-reviewed" || action === "tidy") return null;
    if (!step.target.trim()) return "target";
    if (action === "handoff") {
      if (!step.agentId || (context.agents && !context.agents.some((item) => item.id === step.agentId))) return "engine";
    }
    return null;
  }
  if (step.kind === "talk") {
    const action = normalizeTalkAction(step.action);
    if (!action) return "prompt";
    if (!context.running.some((item) => item.id === step.target)) return "target";
    if (action === "review" || action === "send-draft") {
      const other = step.agents?.[0] ?? "";
      if (!other || other === step.target || !context.running.some((item) => item.id === other)) return "target";
    }
    return null;
  }
  if (step.kind === "verify") {
    if (!step.prompt.trim()) return "prompt";
    if (step.workspaceId) return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
    if (step.target) return context.running.some((item) => item.id === step.target) ? null : "target";
    return "workspace";
  }
  if (step.kind === "memory") {
    const action = normalizeMemoryAction(step.action, Boolean(step.prompt.trim()));
    if (!action || (action !== "clear" && !step.prompt.trim())) return "prompt";
    return null;
  }
  if (step.kind === "show" && !step.target) {
    // A view (optionally deep-linked), or a workspace opened in Code; neither needs anything to be running.
    if (step.view) return (SHOW_VIEWS as readonly string[]).includes(step.view) ? null : "workspace";
    return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
  }
  if (!context.running.some((item) => item.id === step.target)) return "target";
  if (step.kind === "tell" && !step.prompt.trim()) return "prompt";
  return null;
}
