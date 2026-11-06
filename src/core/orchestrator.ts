/**
 * The Orchestrator: a person talks to VibeForge (typed or dictated), one of their own coding CLIs
 * (Grok Build by default) turns that into steps, and VibeForge carries the steps out. The CLI only
 * ever writes a plan, in one headless turn with its tools off; starting, telling and stopping
 * CLIs is VibeForge's own code, so the plan card and its Go button stay in charge. It never picks
 * an engine by itself: the person names them (no routing, see docs/status.md).
 */

import path from "node:path";
import { slugify } from "./slug.js";
import type { EngineRow } from "./types.js";
import { brainKind, type OrchestratorStep, type PlanContext } from "../shared/orchestrator.js";

export * from "../shared/orchestrator.js";

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    say: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["start", "tell", "stop"] },
          engine: { type: "string" },
          workspace: { type: "string" },
          branch: { type: "string" },
          prompt: { type: "string" },
          target: { type: "string" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["say", "steps"],
} as const;

/**
 * One planning turn's command line. Grok Build 1.0.70: `-p` is one turn printed to stdout, and
 * `-s` names a new session that `-r` resumes. Claude Code: `--print`, `--session-id`/`--resume`,
 * and `--tools ""` with nothing else after it but options, as it takes every word up to the next one.
 */
export function brainArgs(row: EngineRow, opts: { text: string; rules: string; sessionId: string; resume: boolean }): string[] | null {
  const schema = JSON.stringify(PLAN_SCHEMA);
  const kind = brainKind(row);
  if (kind === "grok") {
    return [
      ...row.args,
      "-p",
      opts.text,
      "--rules",
      opts.rules,
      "--json-schema",
      schema,
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      opts.resume ? "-r" : "-s",
      opts.sessionId,
    ];
  }
  if (kind === "claude") {
    return [
      ...row.args,
      "--tools",
      "",
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      schema,
      "--append-system-prompt",
      opts.rules,
      opts.resume ? "--resume" : "--session-id",
      opts.sessionId,
      "--",
      opts.text,
    ];
  }
  return null;
}

/** What the planning CLI is told each turn: its job, the steps it may give, and what is here right now. */
export function orchestratorRules(context: PlanContext): string {
  const workspaces = context.workspaces.length
    ? context.workspaces.map((item) => `- ${item.name} (${item.folder}${item.git ? "" : ", not a git repository"})`).join("\n")
    : "- none yet (the person adds them in Code)";
  const engines = context.engines.filter((item) => item.available);
  const engineList = engines.length ? engines.map((item) => `- ${item.id}: ${item.label}`).join("\n") : "- none found on PATH";
  const running = context.running.length
    ? context.running.map((item) => `- ${item.id}: ${item.engine} in ${item.workspace} (${item.folder}), ${item.working ? "working" : "waiting for input"}${item.orchestrated ? ", you started it" : ""}`).join("\n")
    : "- none";
  return [
    "You are the Orchestrator inside VibeForge, a desktop app where a person runs several coding CLIs at once.",
    "The person talks to you, often by voice, so expect dictation slips: misheard names, missing punctuation. Match names generously.",
    "You never write code, read files or use tools yourself. You turn what the person asks into steps that VibeForge carries out, and you answer only in the JSON schema you were given.",
    "",
    "Steps:",
    "- start: open a coding CLI in a workspace, on a new branch in its own copy of that workspace (a git worktree), with its first instruction. Fields: engine (an id below), workspace (a name below), branch (short kebab-case such as fix-login-timeout; use the person's name for it if they gave one), prompt (the complete instruction for that CLI, written to it directly; it sees nothing else, so put in everything it needs from what the person said, and don't invent requirements).",
    "- tell: send a message to a CLI that is already running. Fields: target (its id below), prompt (the message).",
    "- stop: close a running CLI. Fields: target.",
    "",
    "Rules:",
    "- One start step per CLI the person asks for. Several are fine: they run at the same time.",
    "- Use only the workspaces, engines and ids listed below. Never pick an engine the person didn't ask for; if they didn't say which, ask.",
    "- If a name isn't there or the request is unclear, ask in `say` and give no steps. If they only ask a question (what's running, what you can do), answer in `say` with no steps.",
    "- If they change a plan you just gave, give the whole corrected plan again.",
    "- `say` is one or two short plain sentences: what you will do, or your question. No markdown.",
    "",
    "Workspaces:",
    workspaces,
    "",
    "Coding CLIs on this machine:",
    engineList,
    "",
    "Running now:",
    running,
  ].join("\n");
}

export interface RawPlan {
  say: string;
  steps: Array<{ kind: string; engine?: string; workspace?: string; branch?: string; prompt?: string; target?: string }>;
}

/**
 * The plan in a planning turn's output: Grok Build's `structuredOutput`, Claude Code's
 * `structured_output`, or JSON in the answer's text. Null when there is none.
 */
export function readBrainOutput(stdout: string): { plan: RawPlan | null; text: string } {
  let outer: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (parsed && typeof parsed === "object") outer = parsed as Record<string, unknown>;
  } catch {
    outer = null;
  }
  const text = outer ? String(outer.text ?? outer.result ?? "") : stdout.trim();
  const candidates: unknown[] = outer ? [outer.structuredOutput, outer.structured_output] : [];
  for (const source of [text, stdout]) {
    const json = jsonIn(source);
    if (json !== undefined) candidates.push(json);
  }
  for (const candidate of candidates) {
    const plan = asPlan(candidate);
    if (plan) return { plan, text };
  }
  return { plan: null, text };
}

function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function asPlan(value: unknown): RawPlan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.say !== "string" && !Array.isArray(record.steps)) return null;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return {
    say: typeof record.say === "string" ? record.say.trim() : "",
    steps: steps.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const step = item as Record<string, unknown>;
      const field = (key: string) => (typeof step[key] === "string" ? (step[key] as string).trim() : undefined);
      return [{ kind: field("kind") ?? "", engine: field("engine"), workspace: field("workspace"), branch: field("branch"), prompt: field("prompt"), target: field("target") }];
    }),
  };
}

/** Lowercase letters and digits only, so "vibe forge", "VibeForge" and "vibe-forge" are one name. */
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The item a spoken name means: its id, its exact name, the same letters, or the one name that starts with or holds it. */
export function matchName<T>(asked: string | undefined, items: readonly T[], names: (item: T) => string[]): T | null {
  const wanted = squash(asked ?? "");
  if (!wanted) return null;
  for (const test of [(name: string) => name === wanted, (name: string) => name.startsWith(wanted), (name: string) => name.includes(wanted) || wanted.includes(name)]) {
    const found = items.filter((item) => names(item).some((name) => name && test(squash(name))));
    if (found.length === 1) return found[0];
    // Two that fit as well as each other: the person picks on the card.
    if (found.length > 1) return null;
  }
  return null;
}

/**
 * A branch name git takes: lowercase words joined by "-", slashes kept between parts, at most 60
 * characters. Empty when nothing usable is left.
 */
export function cleanBranch(value: string): string {
  return value
    .split("/")
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/\.lock$/, "")
        .replace(/-{2,}/g, "-"),
    )
    .filter(Boolean)
    .join("/")
    .slice(0, 60)
    .replace(/[-./]+$/g, "");
}

/** A branch for a start step that named none: a few words of its instruction. */
export function branchFromPrompt(prompt: string): string {
  const words = prompt.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  const slug = slugify(words, 40);
  return slug === "item" ? "orchestrator-task" : slug;
}

let stepCounter = 0;
const newStepId = () => `s${Date.now().toString(36)}${(stepCounter++).toString(36)}`;

/** Turn a raw plan into steps with ids VibeForge knows, each flagged with what's missing. */
export function resolvePlan(raw: RawPlan, context: PlanContext): OrchestratorStep[] {
  const steps: OrchestratorStep[] = [];
  for (const item of raw.steps) {
    const kind = item.kind === "start" || item.kind === "tell" || item.kind === "stop" ? item.kind : null;
    if (!kind) continue;
    const base: OrchestratorStep = { id: newStepId(), kind, engineId: "", workspaceId: "", branch: "", prompt: item.prompt ?? "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null };
    if (kind === "start") {
      const workspace = matchName(item.workspace, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)]);
      const engine = matchName(item.engine, context.engines, (entry) => [entry.id, entry.label]);
      const branch = workspace && !workspace.git ? "" : cleanBranch(item.branch ?? "") || branchFromPrompt(item.prompt ?? "");
      steps.push({ ...base, workspaceId: workspace?.id ?? "", engineId: engine?.id ?? "", branch, asked: [item.engine, item.workspace].filter(Boolean).join(" · ") });
    } else {
      const target = context.running.find((entry) => entry.id === item.target) ?? matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`]);
      steps.push({ ...base, target: target?.id ?? "", asked: item.target ?? "" });
    }
  }
  return steps;
}

