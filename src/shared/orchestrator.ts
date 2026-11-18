// The Orchestrator's plans as both sides see them: the main process makes and carries them out
// (src/core/orchestrator.ts), the window shows them and lets a person fix one before Go. No Node
// here, so the window can check a step the same way the main process does.

import type { EngineRow } from "../core/types.js";
import { effortLevels } from "./launch-options.js";
import { inspectsQuotas, keySequenceFor, parseWorkbenchAction } from "./orchestrator-intel.js";

export * from "./orchestrator-intel.js";

/**
 * start, tell, stop: a CLI (or an agent). workspace: a new workspace (its folder made if it isn't there).
 * apply, discard: a copy waiting for review. show: a running CLI, workspace or view.
 * read: what a running CLI last answered, shown on the card and read out in a call.
 * inspect: read a CLI's screen/reply, a copy's diff, a workspace's git status/files, or quotas for Viby.
 * key: send a keystroke/answer (yes, no, enter, escape, option number) to an interactive TUI prompt.
 * shell: open a shell terminal or run a command in a workspace.
 * workbench: folders, git branches, browser dock, panes, diffs, or marking runs reviewed.
 * lookup: search runs, git branches and project folders on disk. task: run or create a task. routine: run or toggle a routine.
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
  | "lookup"
  | "task"
  | "routine";

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
  "lookup",
  "task",
  "routine",
];

/** The steps that change or end someone's work: they wait for Go even when plans start at once. */
export const NEEDS_GO: readonly OrchestratorStepKind[] = ["stop", "apply", "discard"];

/** The steps that change nothing: a plan made only of these goes at once, whatever Settings says. */
export const ONLY_LOOKS: readonly OrchestratorStepKind[] = ["show", "read", "inspect"];

/** Why a step can't run as it stands; the plan card asks the person to fix it. */
export type StepIssue = "workspace" | "engine" | "engineMissing" | "target" | "prompt" | "effort" | "folder" | "copy";

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
export type StepPatch = Partial<Pick<OrchestratorStep, "engineId" | "workspaceId" | "branch" | "prompt" | "target" | "model" | "effort" | "name" | "folder" | "git">>;

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
  kind: "lookup" | "inspect";
  /** Short target label for the chip ("Claude Code · VibeForge", "auth"). */
  label: string;
  summary: string;
  details: string;
  ptyId?: string | null;
  workspaceId?: string | null;
  copyId?: string | null;
}

export interface OrchestratorActivity {
  kind: OrchestratorStepKind;
  /** Short target label for the live line ("Claude Code · VibeForge", "fix-tray"). */
  label: string;
}

export interface OrchestratorTurn {
  id: string;
  at: string;
  from: "you" | "vibeforge";
  text: string;
  /** VibeForge's own word about a CLI, not the planner's answer. */
  note?: MaestroNote;
  /** Inline inspections or lookups Viby carried out while forming this answer. */
  checks?: OrchestratorCheck[];
  /** A plan: steps, and where it is. "replaced" is a plan the next answer took over. */
  steps?: OrchestratorStep[];
  plan?: "waiting" | "running" | "done" | "cancelled" | "replaced";
  /** End the active voice call once this turn (and any plan it runs) has been carried out. */
  hangup?: boolean;
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
export function orchestratorVoiceWords(workspaces: readonly string[]): string[] {
  return ["Viby", "Vibey", ...workspaces.flatMap((name) => [name, name.replace(/[-_.]+/g, " ")]), "branch", "workspace"];
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
  agents?: Array<{ id: string; name: string; engine: string; goodAt?: string; places?: string[] }>;
  /** Tasks on the board. */
  tasks?: Array<{ id: string; title: string; status: string; workspace?: string; agent?: string }>;
  /** Scheduled routines. */
  routines?: Array<{ id: string; name: string; schedule: string; enabled: boolean; agent?: string }>;
  /** Where a new workspace goes when the person doesn't say. */
  projectsFolder?: string;
}

/**
 * The context a plan's steps are checked against: what is here, plus the workspaces the plan's own
 * workspace steps will make while those steps can still run, under their placeholder ids.
 */
export function withPlannedWorkspaces(context: PlanContext, steps: readonly OrchestratorStep[]): PlanContext {
  const planned = steps.filter((step) => step.kind === "workspace" && (step.state === "planned" || step.state === "running"));
  if (!planned.length) return context;
  return { ...context, workspaces: [...context.workspaces, ...planned.map((step) => ({ id: plannedId(step.id), name: step.name ?? "", folder: step.folder ?? "", git: false }))] };
}

/** A workspace's name as a folder's: something, and nothing that would put it somewhere else. */
export function folderNameOk(name: string): boolean {
  const clean = name.trim();
  return clean.length > 0 && clean.length <= 120 && !/[\\/\0]/.test(clean) && clean !== "." && clean !== "..";
}

/** What stands in a step's way, given what's here now. */
export function stepIssue(step: OrchestratorStep, context: PlanContext): StepIssue | null {
  if (step.kind === "workspace") {
    const folder = (step.folder ?? "").trim();
    const stripped = folder.replace(/\/+$/, "");
    if (!folderNameOk(step.name ?? "") || !(folder.startsWith("/") || folder.startsWith("~/")) || !stripped || stripped === "~" || folder.split("/").includes("..")) return "folder";
    return null;
  }
  if (step.kind === "start") {
    if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    const engine = context.engines.find((item) => item.id === step.engineId);
    if (!engine) return "engine";
    if (!engine.available) return "engineMissing";
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
  if (step.kind === "inspect") {
    if (inspectsQuotas(step.prompt) || inspectsQuotas(step.target)) return null;
    if (step.target) {
      const hasCli = context.running.some((item) => item.id === step.target);
      const hasCopy = (context.copies ?? []).some((item) => item.id === step.target);
      return hasCli || hasCopy ? null : "target";
    }
    if (step.workspaceId) return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
    return "workspace";
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
    if ((action.op === "branch" || action.op === "browser-open") && !context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    return null;
  }
  if (step.kind === "routine") {
    if (!step.target || (context.routines && !context.routines.some((item) => item.id === step.target))) return "target";
    // Run it now (""), or turn it on or off: anything else would be guessed at.
    return step.prompt === "" || step.prompt === "enable" || step.prompt === "disable" ? null : "prompt";
  }
  if (step.kind === "task") {
    if (step.target) return context.tasks && !context.tasks.some((item) => item.id === step.target) ? "target" : null;
    if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    if (!step.agentId || (context.agents && !context.agents.some((item) => item.id === step.agentId))) return "engine";
    return step.prompt.trim() ? null : "prompt";
  }
  if (step.kind === "show" && !step.target) {
    // A view, or a workspace opened in Code; neither needs anything to be running.
    if (step.view) return (SHOW_VIEWS as readonly string[]).includes(step.view) ? null : "workspace";
    return context.workspaces.some((item) => item.id === step.workspaceId) ? null : "workspace";
  }
  if (!context.running.some((item) => item.id === step.target)) return "target";
  if (step.kind === "tell" && !step.prompt.trim()) return "prompt";
  return null;
}
