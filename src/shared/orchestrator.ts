// The Orchestrator's plans as both sides see them: the main process makes and carries them out
// (src/core/orchestrator.ts), the window shows them and lets a person fix one before Go. No Node
// here, so the window can check a step the same way the main process does.

import type { EngineRow } from "../core/types.js";
import { effortLevels } from "./launch-options.js";

/**
 * start, tell, stop: a CLI (or an agent). workspace: a new workspace (its folder made if it isn't there).
 * apply, discard: a copy waiting for review. show: a running CLI, opened in Code.
 * lookup: search runs, git branches and project folders on disk. task: run or create a task. routine: run or toggle a routine.
 */
export type OrchestratorStepKind = "start" | "tell" | "stop" | "workspace" | "apply" | "discard" | "show" | "lookup" | "task" | "routine";

/** The steps that change or end someone's work: they wait for Go even when plans start at once. */
export const NEEDS_GO: readonly OrchestratorStepKind[] = ["stop", "apply", "discard"];

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
  /** start: its first instruction. tell: the message. */
  prompt: string;
  /** tell, stop: the terminal. */
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

/** A word from VibeForge itself about a CLI Maestro started: its turn ended after real work, or it closed. */
export interface MaestroNote {
  kind: "finished" | "ended";
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
}

export interface OrchestratorTurn {
  id: string;
  at: string;
  from: "you" | "vibeforge";
  text: string;
  /** VibeForge's own word about a CLI, not the planner's answer. */
  note?: MaestroNote;
  /** A plan: steps, and where it is. "replaced" is a plan the next answer took over. */
  steps?: OrchestratorStep[];
  plan?: "waiting" | "running" | "done" | "cancelled" | "replaced";
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
  workspaces: Array<{
    id: string;
    name: string;
    folder: string;
    git: boolean;
    /** Current git branch, when known. */
    branch?: string;
    /** Recent runs in this workspace, newest first. */
    recentRuns?: Array<{ id: string; engine: string; branch?: string; prompt?: string; at: string }>;
  }>;
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
  if (step.kind === "routine") {
    return !step.target || (context.routines && !context.routines.some((item) => item.id === step.target)) ? "target" : null;
  }
  if (step.kind === "task") {
    if (step.target) return context.tasks && !context.tasks.some((item) => item.id === step.target) ? "target" : null;
    if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    if (!step.agentId || (context.agents && !context.agents.some((item) => item.id === step.agentId))) return "engine";
    return step.prompt.trim() ? null : "prompt";
  }
  if (!context.running.some((item) => item.id === step.target)) return "target";
  if (step.kind === "tell" && !step.prompt.trim()) return "prompt";
  return null;
}
