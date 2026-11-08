// The Orchestrator's plans as both sides see them: the main process makes and carries them out
// (src/core/orchestrator.ts), the window shows them and lets a person fix one before Go. No Node
// here, so the window can check a step the same way the main process does.

import type { EngineRow } from "../core/types.js";

export type OrchestratorStepKind = "start" | "tell" | "stop";

/** Why a step can't run as it stands; the plan card asks the person to fix it. */
export type StepIssue = "workspace" | "engine" | "engineMissing" | "target" | "prompt";

export interface OrchestratorStep {
  id: string;
  kind: OrchestratorStepKind;
  /** start: the CLI to open. */
  engineId: string;
  /** start: the workspace it works on. */
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
  openedWorkspaceId: string | null;
}

export type OrchestratorProblem = "noEngine" | "failed" | "unreadable" | "timeout" | "stopped" | "signIn";

export interface OrchestratorTurn {
  id: string;
  at: string;
  from: "you" | "vibeforge";
  text: string;
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
  return [...workspaces.flatMap((name) => [name, name.replace(/[-_.]+/g, " ")]), "branch", "workspace"];
}

export interface PlanContext {
  workspaces: Array<{ id: string; name: string; folder: string; git: boolean }>;
  engines: Array<{ id: string; label: string; available: boolean }>;
  running: Array<{ id: string; engine: string; workspace: string; folder: string; working: boolean; orchestrated: boolean }>;
}

/** What stands in a step's way, given what's here now. */
export function stepIssue(step: OrchestratorStep, context: PlanContext): StepIssue | null {
  if (step.kind === "start") {
    if (!context.workspaces.some((item) => item.id === step.workspaceId)) return "workspace";
    const engine = context.engines.find((item) => item.id === step.engineId);
    if (!engine) return "engine";
    if (!engine.available) return "engineMissing";
    if (!step.prompt.trim()) return "prompt";
    return null;
  }
  if (!context.running.some((item) => item.id === step.target)) return "target";
  if (step.kind === "tell" && !step.prompt.trim()) return "prompt";
  return null;
}
