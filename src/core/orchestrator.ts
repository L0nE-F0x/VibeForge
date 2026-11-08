/**
 * Maestro (the Orchestrator in code): a person talks to VibeForge (typed or dictated), one of
 * their own coding CLIs (see plannerFor) turns that into steps, and VibeForge carries them out.
 * The CLI only ever writes a plan, in one headless turn with its tools off; starting, telling and
 * stopping CLIs is VibeForge's own code, so the plan card and its Go button stay in charge. It
 * never picks an engine by itself: the person names them (no routing, see docs/status.md).
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
 * The same plan, the way OpenAI's structured output wants it: every field required. Codex and
 * Antigravity get this one; an empty string stands for a field that doesn't apply.
 */
export const STRICT_PLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: {
    ...PLAN_SCHEMA.properties,
    steps: { ...PLAN_SCHEMA.properties.steps, items: { ...PLAN_SCHEMA.properties.steps.items, required: ["kind", "engine", "workspace", "branch", "prompt", "target"] } },
  },
} as const;

export interface BrainOptions {
  text: string;
  rules: string;
  /** The planner's session: ours for Grok Build and Claude Code, the one it reported for Codex and Antigravity. */
  sessionId: string;
  resume: boolean;
  /** A model the person picked; empty keeps the CLI's own default. */
  model?: string;
  /** Codex reads the schema from a file. */
  schemaFile?: string;
}

/**
 * One planning turn's command line, tools off or read-only, output held to the plan's schema.
 * - Grok Build 1.0.77: `-p` one turn, `--rules`, `--json-schema`, `-s <uuid>` names a session that `-r` resumes.
 * - Claude Code 2.1: `--print`, `--append-system-prompt`, `--session-id`/`--resume`, and `--tools ""`
 *   with only options after it, as it takes every word up to the next one.
 * - Codex 0.16x: `exec --json`, `--output-schema <file>`, a read-only sandbox, the rules as developer
 *   instructions; it names its own thread, which `exec resume <id>` picks up. Low reasoning effort.
 * - Antigravity CLI: `-p` with the rules in the message (it has no option for them), `--json-schema`,
 *   plan mode, `--conversation <id>` from its last answer. Low effort: a first turn at its default took 80 s.
 */
export function brainArgs(row: EngineRow, opts: BrainOptions): string[] | null {
  const kind = brainKind(row);
  const model = opts.model?.trim() ?? "";
  if (kind === "grok") {
    return [
      ...row.args,
      "-p",
      opts.text,
      "--rules",
      opts.rules,
      "--json-schema",
      JSON.stringify(PLAN_SCHEMA),
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      ...(model ? ["-m", model] : []),
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
      JSON.stringify(PLAN_SCHEMA),
      "--append-system-prompt",
      opts.rules,
      ...(model ? ["--model", model] : []),
      opts.resume ? "--resume" : "--session-id",
      opts.sessionId,
      "--",
      opts.text,
    ];
  }
  if (kind === "codex") {
    if (!opts.schemaFile) return null;
    const options = [
      "--json",
      "--skip-git-repo-check",
      "--output-schema",
      opts.schemaFile,
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'model_reasoning_effort="low"',
      // -c takes TOML, and a JSON string is a TOML basic string.
      "-c",
      `developer_instructions=${JSON.stringify(opts.rules)}`,
      ...(model ? ["-m", model] : []),
    ];
    const resume = opts.resume && opts.sessionId;
    return [...row.args, "exec", ...(resume ? ["resume"] : []), ...options, "--", ...(resume ? [opts.sessionId] : []), opts.text];
  }
  if (kind === "agy") {
    const resume = opts.resume && opts.sessionId;
    return [
      ...row.args,
      "-p",
      `${opts.rules}\n\nThe person said:\n${opts.text}`,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(STRICT_PLAN_SCHEMA),
      "--mode",
      "plan",
      "--effort",
      "low",
      ...(model ? ["--model", model] : []),
      ...(resume ? ["--conversation", opts.sessionId] : []),
    ];
  }
  return null;
}

/** Whether a planner's error means it isn't signed in, so the card can say so plainly. */
export function signedOut(text: string): boolean {
  return /\b401\b|unauthori[sz]ed|not logged in|please run \/login|log ?in again|sign ?in (again|first|required)|invalid api key/i.test(text);
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
    "You are Maestro, the orchestrator inside VibeForge, a desktop app where a person runs several coding CLIs at once.",
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

/** What one planning turn printed: the plan, its words, the session it reported, and any error. */
export interface BrainOutput {
  plan: RawPlan | null;
  text: string;
  sessionId: string;
  error: string;
}

/**
 * The plan in a planning turn's output: Grok Build's `structuredOutput`, Claude Code's and
 * Antigravity's `structured_output`, Codex's last agent message in its JSON lines, or JSON in the
 * answer's text. `plan` is null when there is none.
 */
export function readBrainOutput(stdout: string): BrainOutput {
  let outer: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outer = parsed as Record<string, unknown>;
  } catch {
    outer = null;
  }
  // A single line of Codex's events is still an event, not an answer.
  if (outer && typeof outer.type === "string" && /^(thread|turn|item)\.|^error$/.test(outer.type)) outer = null;
  let sessionId = "";
  let error = "";
  let text = "";
  const candidates: unknown[] = [];
  if (outer) {
    text = String(outer.text ?? outer.result ?? outer.response ?? "");
    sessionId = String(outer.sessionId ?? outer.session_id ?? outer.conversation_id ?? "");
    if (outer.is_error === true) error = text;
    candidates.push(outer.structuredOutput, outer.structured_output);
  } else {
    // Codex: one event per line.
    for (const line of stdout.split("\n")) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const item = (event.item ?? {}) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
      else if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") text = item.text;
      else if (event.type === "turn.failed") error = String((event.error as { message?: unknown } | undefined)?.message ?? "");
      else if (event.type === "error" && typeof event.message === "string") error = event.message;
    }
    if (!text && !sessionId && !error) text = stdout.trim();
  }
  for (const source of [text, outer ? stdout : ""]) {
    const json = jsonIn(source);
    if (json !== undefined) candidates.push(json);
  }
  for (const candidate of candidates) {
    const plan = asPlan(candidate);
    if (plan) return { plan, text, sessionId, error: "" };
  }
  return { plan: null, text, sessionId, error };
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

