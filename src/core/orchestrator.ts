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
import { cleanModel, effortLevels } from "../shared/launch-options.js";
import { brainKind, plannedId, type OrchestratorStep, type PlanContext } from "../shared/orchestrator.js";

export * from "../shared/orchestrator.js";

const STEP_FIELDS = ["kind", "engine", "workspace", "branch", "prompt", "target", "folder", "git", "model", "effort", "inPlace"] as const;

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
          kind: { type: "string", enum: ["start", "tell", "stop", "workspace", "apply", "discard", "show", "lookup", "task", "routine"] },
          engine: { type: "string" },
          workspace: { type: "string" },
          branch: { type: "string" },
          prompt: { type: "string" },
          target: { type: "string" },
          folder: { type: "string" },
          git: { type: "boolean" },
          model: { type: "string" },
          effort: { type: "string" },
          inPlace: { type: "boolean" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["say", "steps"],
} as const;

/**
 * The same plan, the way OpenAI's structured output wants it: every field required. Codex and
 * Antigravity get this one; an empty string (or false) stands for a field that doesn't apply.
 */
export const STRICT_PLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: {
    ...PLAN_SCHEMA.properties,
    steps: { ...PLAN_SCHEMA.properties.steps, items: { ...PLAN_SCHEMA.properties.steps.items, required: [...STEP_FIELDS] } },
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
 * - Grok Build 1.0.77: `-p` one turn, `--rules`, `--json-schema`, `-s <uuid>` names a session that `-r`
 *   resumes, low `--reasoning-effort`.
 * - Claude Code 2.1: `--print`, `--append-system-prompt`, `--session-id`/`--resume`, and `--tools ""`
 *   with only options after it, as it takes every word up to the next one. Low effort, and
 *   `--strict-mcp-config` with no MCP config, so none of the person's MCP servers start for a plan.
 * - Codex 0.16x: `exec --json`, `--output-schema <file>`, a read-only sandbox, the rules as developer
 *   instructions; it names its own thread, which `exec resume <id>` picks up. Low reasoning effort.
 * - Antigravity CLI: `-p` with the rules in the message (it has no option for them), `--json-schema`,
 *   plan mode, `--conversation <id>` from its last answer. Low effort: a first turn at its default took 80 s.
 */
export function brainArgs(row: EngineRow, opts: BrainOptions): string[] | null {
  const kind = brainKind(row);
  const model = cleanModel(opts.model);
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
      // Planning is light work: a low effort answers sooner.
      "--reasoning-effort",
      "low",
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
      // Planning is light work, and needs none of the person's MCP servers (each one is started first).
      "--effort",
      "low",
      "--strict-mcp-config",
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

/**
 * Whether a planner's error means the session it was asked to resume isn't there any more (its
 * files were tidied away, or it was never saved), so a new one has to start.
 */
export function sessionGone(text: string): boolean {
  return /no conversation found|(session|conversation|thread) (id )?(\S+ )?(was )?not found|could not find (the )?(session|conversation|thread)|unknown (session|conversation|thread)|no (such )?(session|conversation|thread)( found| with)/i.test(text);
}

/** What the planning CLI is told each turn: its job, the steps it may give, and what is here right now. */
export function orchestratorRules(context: PlanContext): string {
  const workspaces = context.workspaces.length
    ? context.workspaces
        .map((item) => {
          const head = `- ${item.name} (${item.folder}${item.git ? "" : ", not a git repository"})${item.branch ? ` [branch: ${item.branch}]` : ""}`;
          if (!item.recentRuns?.length) return head;
          const runs = item.recentRuns.map((run) => `  · run ${run.id}: ${run.engine}${run.branch ? ` on ${run.branch}` : ""}${run.prompt ? ` — "${run.prompt}"` : ""}`).join("\n");
          return `${head}\n${runs}`;
        })
        .join("\n")
    : "- none yet";
  const engines = context.engines.filter((item) => item.available);
  const engineList = engines.length
    ? engines
        .map((item) => {
          const efforts = item.bin !== undefined ? effortLevels({ id: item.id, bin: item.bin }) : [];
          return `- ${item.id}: ${item.label}${efforts.length ? ` (effort: ${efforts.join(", ")})` : ""}${context.defaultEngine === item.id ? " [default]" : ""}`;
        })
        .join("\n")
    : "- none found on PATH";
  const running = context.running.length
    ? context.running
        .map(
          (item) =>
            `- ${item.id}: ${item.engine} in ${item.workspace} (${item.folder}), ${item.working ? "working" : "waiting for input"}${item.orchestrated ? ", you started it" : ""}${item.branch ? `, in its own copy on ${item.branch}` : ""}${item.asked ? `; asked: ${item.asked}` : ""}`,
        )
        .join("\n")
    : "- none";
  const copies = context.copies?.length ? context.copies.map((item) => `- ${item.id}: ${item.name} (branch ${item.branch}), from ${item.workspace}`).join("\n") : "- none";
  const agents = context.agents?.length
    ? context.agents.map((item) => `- ${item.id}: ${item.name} (CLI: ${item.engine}${item.goodAt ? `; ${item.goodAt}` : ""}${item.places?.length ? `; folders: ${item.places.join(", ")}` : ""})`).join("\n")
    : "";
  const tasks = context.tasks?.length
    ? context.tasks.map((item) => `- ${item.id}: ${item.title} [${item.status}]${item.workspace ? ` in ${item.workspace}` : ""}${item.agent ? ` (${item.agent})` : ""}`).join("\n")
    : "";
  const routines = context.routines?.length
    ? context.routines.map((item) => `- ${item.id}: ${item.name} (${item.schedule}, ${item.enabled ? "enabled" : "paused"}${item.agent ? `, agent: ${item.agent}` : ""})`).join("\n")
    : "";
  const projects = context.projectsFolder || "~/Projects";
  const defaultRule = context.defaultEngine
    ? `Never pick an engine the person didn't ask for unless they asked to start work without naming a CLI, in which case use their default CLI (${context.defaultEngine}).`
    : "Never pick an engine the person didn't ask for; if they didn't say which, ask.";
  return [
    "You are Viby (also called Vibey, Vibe, or Maestro; speech-to-text may write any of those), the person's personal orchestrator and main point of access inside VibeForge, a desktop app where they run several coding CLIs, agents, tasks and routines at once.",
    "Whatever planning CLI runs you under the hood, you are always Viby. The person talks to you, often by voice, so expect dictation slips: misheard names, missing punctuation. Match names generously.",
    "You never write code, read files or use tools yourself. You turn what the person asks into steps that VibeForge carries out, and you answer only in the JSON schema you were given.",
    "",
    "Steps:",
    "- start: open a coding CLI (or a saved VibeForge agent) in a workspace. Fields: engine (a CLI id or agent name below; leave empty only to use the default CLI when one is marked [default]), workspace (a name below, or one a workspace step in this plan makes), prompt (the complete instruction for that CLI, written to it directly; it sees nothing else, so put in everything it needs from what the person said, and don't invent requirements; empty when they only want it opened), branch (short kebab-case such as fix-login-timeout; use the person's name for it if they gave one): by default each CLI works on a new branch in its own copy of the workspace (a git worktree), so its work comes back for review. inPlace: true when the person wants it in the workspace's own folder, with no copy, or only asks to open it there. model and effort: only when the person asks for them; effort must be one the CLI lists below.",
    `- workspace: make a new workspace. Fields: workspace (its name, in the person's words), folder (only if they said where; otherwise leave it empty and it goes in ${projects}/<name>), git (true when they want it to be a git repository). An existing folder is only added, never changed.`,
    "- lookup: search VibeForge's run history, git branches and project folders on disk when the person asks to find a past session, branch, or project folder not listed below. Fields: prompt (the session id, branch, folder name, or keywords to search for). VibeForge runs the lookup at once and hands you the findings.",
    "- tell: send a message to a CLI that is already running. Fields: target (its id below), prompt (the message).",
    "- stop: close a running CLI. Fields: target.",
    "- show: open a running CLI in Code for the person to look at. Fields: target.",
    "- apply: bring a copy's changes into the workspace it came from. discard: throw a copy away. Fields: target (a copy's id below).",
    "- task: run an existing task on the board, or create and start a new task for an agent. Fields: target (existing task id/title, or the agent's id/name for a new task), workspace (workspace name, for a new task), branch (short title for a new task), prompt (instructions for a new task).",
    "- routine: run a scheduled routine now, or turn it on/off. Fields: target (a routine's id or name below), prompt (\"enable\", \"disable\", or empty to run now).",
    "",
    "Rules:",
    "- One start step per CLI the person asks for. Several are fine: they run at the same time.",
    `- Use only the workspaces, engines, agents, tasks, routines, ids and copies listed below, or a workspace this plan makes. ${defaultRule}`,
    "- When they ask for a workspace, session or branch that isn't listed below, use a `lookup` step first to search disk, branches and run history if they are asking you to find an existing one; make it with a `workspace` step if they asked for a new one or gave its folder.",
    "- If the request is unclear, ask in `say` and give no steps. If they only ask a question (what's running, how it's going, what you can do), answer in `say` with no steps.",
    "- If they change a plan you just gave, give the whole corrected plan again.",
    "- Your turn ends as soon as you output JSON; nothing runs in the background after your answer unless it is in `steps`. Never say in `say` that you are searching, checking, looking up, or starting something when `steps` is empty — emit a `lookup` or `start` step instead.",
    "- `say` is one or two short plain sentences in the person's language: what you will do, or your question. No markdown.",
    "",
    "Workspaces:",
    workspaces,
    "",
    "Coding CLIs on this machine:",
    engineList,
    ...(agents ? ["", "Agents (teammates):", agents] : []),
    "",
    "Running now:",
    running,
    "",
    "Copies waiting for review:",
    copies,
    ...(tasks ? ["", "Tasks on the board:", tasks] : []),
    ...(routines ? ["", "Scheduled routines:", routines] : []),
  ].join("\n");
}

export interface RawStep {
  kind: string;
  engine?: string;
  workspace?: string;
  branch?: string;
  prompt?: string;
  target?: string;
  folder?: string;
  git?: boolean;
  model?: string;
  effort?: string;
  inPlace?: boolean;
}

export interface RawPlan {
  say: string;
  steps: RawStep[];
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
      const flag = (key: string) => step[key] === true;
      return [
        {
          kind: field("kind") ?? "",
          engine: field("engine"),
          workspace: field("workspace"),
          branch: field("branch"),
          prompt: field("prompt"),
          target: field("target"),
          folder: field("folder"),
          git: flag("git"),
          model: field("model"),
          effort: field("effort"),
          inPlace: flag("inPlace"),
        },
      ];
    }),
  };
}

/** Lowercase letters and digits only, so "vibe forge", "VibeForge" and "vibe-forge" are one name. */
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The words in a name, squashed: "GitHub Copilot" is ["github", "copilot"]. */
const words = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The item a spoken name means: its id, its exact name, the same letters, the one name that starts
 * with or holds it, or (with `byWord`, for CLIs and workspaces, not ids) the one that shares a whole
 * word with it ("GitHub Copilot" is Copilot). A name of one or two letters ("pi") only counts whole,
 * so it can't turn up inside another word.
 */
export function matchName<T>(asked: string | undefined, items: readonly T[], names: (item: T) => string[], byWord = false): T | null {
  const wanted = squash(asked ?? "");
  if (!wanted) return null;
  const spoken = words(asked ?? "");
  const holds = (name: string) => (name.length >= 3 && wanted.includes(name)) || (wanted.length >= 3 && name.includes(wanted));
  // Every word of its name was said ("the Pi agent" is Pi), then any longer word of it ("GitHub Copilot").
  const said = (raw: string) => words(raw).every((word) => spoken.includes(word));
  const shares = (raw: string) => words(raw).some((word) => word.length >= 3 && spoken.includes(word));
  const tests: Array<(name: string, raw: string) => boolean> = [
    (name) => name === wanted,
    (name) => name.startsWith(wanted),
    (name) => holds(name),
    ...(byWord ? [(_name: string, raw: string) => said(raw), (_name: string, raw: string) => shares(raw)] : []),
  ];
  for (const test of tests) {
    const found = items.filter((item) => names(item).some((raw) => raw && test(squash(raw), raw)));
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

/** The folder a new workspace gets: the one the plan named, else `<projects folder>/<name>`. */
export function plannedFolder(name: string, folder: string | undefined, projects: string): string {
  const named = (folder ?? "").trim().replace(/\/+$/, "");
  if (named) return named;
  return `${(projects || "~/Projects").replace(/\/+$/, "")}/${name.trim()}`;
}

/** Turn a raw plan into steps with ids VibeForge knows, each flagged with what's missing. */
export function resolvePlan(raw: RawPlan, context: PlanContext): OrchestratorStep[] {
  const steps: OrchestratorStep[] = [];
  // The workspaces this plan makes, under placeholder ids, for its later steps to name.
  const planned: PlanContext["workspaces"] = [];
  const kinds = ["start", "tell", "stop", "workspace", "apply", "discard", "show", "lookup", "task", "routine"] as const;
  for (const item of raw.steps) {
    const kind = kinds.find((value) => value === item.kind) ?? null;
    if (!kind) continue;
    const base: OrchestratorStep = { id: newStepId(), kind, engineId: "", workspaceId: "", branch: "", prompt: item.prompt ?? "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null };
    if (kind === "workspace") {
      const name = (item.workspace ?? "").trim();
      const step: OrchestratorStep = { ...base, prompt: "", name, folder: plannedFolder(name, item.folder, context.projectsFolder ?? ""), git: Boolean(item.git), asked: name };
      planned.push({ id: plannedId(step.id), name, folder: step.folder ?? "", git: false });
      steps.push(step);
    } else if (kind === "start") {
      const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
      const namedEngine = matchName(item.engine, context.engines, (entry) => [entry.id, entry.label], true);
      const agent = !namedEngine ? matchName(item.engine || item.target, context.agents ?? [], (entry) => [entry.id, entry.name], true) : null;
      const fallbackEngine = !item.engine?.trim() && !agent && context.defaultEngine ? (context.engines.find((entry) => entry.id === context.defaultEngine) ?? null) : null;
      const engineId = namedEngine?.id ?? (agent ? agent.engine : (fallbackEngine?.id ?? ""));
      const matchedWorkspace = fresh ?? matchName(item.workspace, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
      const agentWorkspace = !matchedWorkspace && !item.workspace?.trim() && agent?.places?.length
        ? context.workspaces.find((entry) => agent.places?.some((place) => entry.folder === place || path.basename(entry.folder) === path.basename(place)))
        : undefined;
      const workspace = matchedWorkspace ?? agentWorkspace ?? null;
      const prompt = item.prompt ?? "";
      const named = cleanBranch(item.branch ?? "");
      // No copy: a folder that isn't a repository (or is new, with nothing committed), one the person
      // asked to work in directly, or a CLI only opened with no work and no branch to put it on.
      const inPlace = !workspace?.git || item.inPlace === true || (!named && !prompt.trim());
      const branch = inPlace ? "" : named || branchFromPrompt(prompt);
      const effort = (item.effort ?? "").trim().toLowerCase();
      steps.push({
        ...base,
        workspaceId: workspace?.id ?? "",
        engineId,
        ...(agent ? { agentId: agent.id } : {}),
        branch,
        model: cleanModel(item.model),
        effort,
        asked: [agent?.name || item.engine, item.workspace || workspace?.name].filter(Boolean).join(" · "),
      });
    } else if (kind === "lookup") {
      const query = (item.prompt || item.target || item.workspace || item.folder || "").trim();
      steps.push({ ...base, prompt: query, asked: query });
    } else if (kind === "routine") {
      const routines = context.routines ?? [];
      const routine = routines.find((entry) => entry.id === item.target) ?? matchName(item.target || item.workspace || item.prompt, routines, (entry) => [entry.id, entry.name], true);
      const asked = routine ? routine.name : (item.target || item.workspace || "");
      steps.push({ ...base, prompt: (item.prompt ?? "").trim(), target: routine?.id ?? "", asked });
    } else if (kind === "task") {
      const tasks = context.tasks ?? [];
      const existing = item.target ? (tasks.find((entry) => entry.id === item.target) ?? matchName(item.target, tasks, (entry) => [entry.id, entry.title], true)) : null;
      if (existing && !item.workspace && !item.prompt) {
        steps.push({ ...base, prompt: "", target: existing.id, asked: existing.title });
      } else {
        const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
        const workspace = fresh ?? matchName(item.workspace, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
        const agent = matchName(item.engine || item.target, context.agents ?? [], (entry) => [entry.id, entry.name], true);
        const title = (item.branch || "").trim() || branchFromPrompt(item.prompt ?? "").replace(/-/g, " ");
        steps.push({
          ...base,
          workspaceId: workspace?.id ?? "",
          agentId: agent?.id ?? "",
          engineId: agent?.engine ?? "",
          name: title,
          prompt: item.prompt ?? "",
          asked: [agent?.name || item.engine || item.target, workspace?.name || item.workspace].filter(Boolean).join(" · "),
        });
      }
    } else if (kind === "apply" || kind === "discard") {
      const copies = context.copies ?? [];
      const copy = copies.find((entry) => entry.id === item.target) ?? matchName(item.target, copies, (entry) => [entry.id, entry.name, entry.branch, `${entry.workspace} ${entry.name}`]);
      const asked = copy ? `${copy.name} · ${copy.workspace}` : (item.target ?? "");
      steps.push({ ...base, prompt: "", target: copy?.id ?? "", asked });
    } else {
      const target = context.running.find((entry) => entry.id === item.target) ?? matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`]);
      const asked = target ? `${target.engine} · ${target.workspace}` : (item.target ?? "");
      steps.push({ ...base, prompt: kind === "tell" ? base.prompt : "", target: target?.id ?? "", asked });
    }
  }
  return steps;
}

/**
 * Whether an answer with no steps still promises to be searching, checking, or starting something
 * right now (a planner acting as if another tool turn will follow its JSON output).
 */
export function emptyPromise(say: string): boolean {
  const text = say.trim();
  if (!text || text.includes("?")) return false;
  return /\b(i['’]?m|i am|still)\s+(still\s+)?(searching|checking|looking|locating|finding|verifying|opening|starting|working\b|on it\b)|\b(i['’]?ll|i will)\s+(look up|search|check|locate|find|open|start|make)\b|\b(searching|checking|looking up|locating)\s+(the|that|your|for|vibe|on disk)\b/i.test(text);
}
