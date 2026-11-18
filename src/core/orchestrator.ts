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
import {
  brainKind,
  formatSettingsRules,
  inspectsQuotas,
  inspectsSettings,
  isSafeShellCommand,
  keySequenceFor,
  NEEDS_GO,
  parseWorkbenchAction,
  plannedId,
  resolveSettingsStep,
  SHOW_VIEWS,
  STEP_KINDS,
  type Looking,
  type OrchestratorStep,
  type PlanContext,
} from "../shared/orchestrator.js";

export * from "../shared/orchestrator.js";

const STEP_FIELDS = ["kind", "engine", "workspace", "branch", "prompt", "target", "folder", "git", "model", "effort", "inPlace", "after"] as const;

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    say: { type: "string" },
    hangup: { type: "boolean" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...STEP_KINDS] },
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
          after: { type: "boolean" },
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
  required: ["say", "steps", "hangup"],
} as const;

export interface BrainOptions {
  text: string;
  rules: string;
  /** The planner's session: ours for Grok Build and Claude Code, the one it reported for Codex and Antigravity. */
  sessionId: string;
  resume: boolean;
  /** A model the person picked; empty keeps the CLI's own default. */
  model?: string;
  /** Reasoning effort the person picked; empty defaults to "low" so planning answers quickly. */
  effort?: string;
  /** Codex reads the schema from a file. */
  schemaFile?: string;
}

/**
 * One planning turn's command line, tools off or read-only, output held to the plan's schema.
 * - Grok Build 1.0.77: `-p` one turn, `--rules`, `--json-schema`, `-s <uuid>` names a session that `-r`
 *   resumes, low `--reasoning-effort` unless configured otherwise.
 * - Claude Code 2.1: `--print`, `--append-system-prompt`, `--session-id`/`--resume`, and `--tools ""`
 *   with only options after it, as it takes every word up to the next one. Low effort by default, and
 *   `--strict-mcp-config` with no MCP config, so none of the person's MCP servers start for a plan.
 * - Codex 0.16x: `exec --json`, `--output-schema <file>`, a read-only sandbox, the rules as developer
 *   instructions; it names its own thread, which `exec resume <id>` picks up. Low reasoning effort by default.
 * - Antigravity CLI: `-p` with the rules in the message (it has no option for them), `--json-schema`,
 *   plan mode, `--conversation <id>` from its last answer. Low effort by default: a first turn at its default took 80 s.
 */
export function brainArgs(row: EngineRow, opts: BrainOptions): string[] | null {
  const kind = brainKind(row);
  const model = cleanModel(opts.model);
  const allowedEfforts = effortLevels(row);
  const requestedEffort = (opts.effort ?? "").trim().toLowerCase();
  const effort = requestedEffort && allowedEfforts.includes(requestedEffort) ? requestedEffort : "low";
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
      // Planning is light work: a low effort answers sooner unless the person chose higher.
      "--reasoning-effort",
      effort,
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
      effort,
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
      `model_reasoning_effort=${JSON.stringify(effort)}`,
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
      effort,
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
  const workspaces = context.workspaces.length ? context.workspaces.map((item) => `- ${item.name} (${item.folder}${item.git ? "" : ", not a git repository"})`).join("\n") : "- none yet";
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
            `- ${item.id}: ${item.engine} in ${item.workspace} (${item.folder}), ${item.working ? "working" : item.waiting ? `WAITING ON PROMPT: "${item.waiting}"` : "waiting for input"}${item.orchestrated ? ", you started it" : ""}${item.branch ? `, in its own copy on ${item.branch}` : ""}${item.asked ? `; asked: ${item.asked}` : ""}`,
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
    "You are Viby (also called Vibey, Vibe, or Maestro; speech-to-text may write any of those, 'VIB', or 'I\\'ll be'), the person's conversational partner, personal orchestrator and main point of access inside VibeForge, a desktop app where they run several coding CLIs, agents, tasks and routines at once.",
    "Whatever planning CLI runs you under the hood, you are always Viby. The person often talks to you in a live voice call, so expect dictation slips: misheard names ('Oh Marchy' = Omarchy, 'Hyperland' = Hyprland, homophones of workspace and agent names), missing punctuation, or spoken thoughts. Match names generously and infer intent smartly.",
    "You are both a sharp, warm sounding board when the person wants to think or brainstorm out loud, and a decisive orchestrator when they want something done. You never write code, read files or use tools yourself; you turn actions into steps that VibeForge carries out, and you answer only in the JSON schema you were given.",
    "",
    "Steps:",
    "- start: open a coding CLI (or a saved VibeForge agent) in a workspace. Fields: engine (a CLI id or agent name below; leave empty only to use the default CLI when one is marked [default]), workspace (a name below, or one a workspace step in this plan makes), prompt (the complete instruction for that CLI, written to it directly; it sees nothing else, so put in everything it needs from what the person said, and don't invent requirements; empty when they only want it opened), branch (short kebab-case such as fix-login-timeout; use the person's name for it if they gave one): by default each CLI works on a new branch in its own copy of the workspace (a git worktree), so its work comes back for review. inPlace: true when the person wants it in the workspace's own folder, with no copy, or only asks to open it there. model and effort: only when the person asks for them; effort must be one the CLI lists below.",
    `- workspace: make a new workspace. Fields: workspace (its name, in the person's words), folder (only if they said where; otherwise leave it empty and it goes in ${projects}/<name>), git (true when they want it to be a git repository). An existing folder is only added, never changed.`,
    "- lookup: search VibeForge's run history, git branches and project folders on disk when the person asks to find a past session, branch, or project folder not listed below. Fields: prompt (the session id, branch, folder name, or keywords to search for). VibeForge runs the lookup at once and hands you the findings.",
    "- inspect: inspect a running CLI's terminal screen and latest reply, a copy's git diff, a workspace's git status/log/diff/files (or a specific file in `folder`), plan limits and token usage (`prompt: \"limits\"` or `\"usage\"`), or current Viby/VibeForge/voice settings and models (`prompt: \"settings\"`, `\"voice\"`, or `\"themes\"`). VibeForge runs `inspect` immediately and hands you the findings in the same turn so you can diagnose errors, review work, or answer configuration questions accurately. Fields: target (a running CLI id or copy id), workspace (workspace name), folder (optional relative file path inside workspace), prompt (what to inspect, e.g. \"screen\", \"diff\", \"status\", \"limits\", \"settings\", \"voice\", or a file path).",
    "- tell: send a message to a CLI that is already running at its normal input prompt. Fields: target (its id below), prompt (the message).",
    "- key: answer an interactive TUI prompt or send a keystroke directly to a running CLI (such as folder trust, y/n confirmation, numbered menu choice, Enter, Escape, or Ctrl+C). Fields: target (its id below), prompt (\"yes\", \"no\", \"enter\", \"escape\", \"interrupt\", \"1\"..\"9\", \"up\", \"down\", \"tab\").",
    "- shell: open a shell terminal in a workspace, optionally running a command in it. Fields: workspace (workspace name), prompt (shell command to run, e.g. \"npm test\" or \"mkdir -p src/lib\"; leave empty to only open a shell).",
    "- workbench: control VibeForge's workbench directly. Fields: workspace (workspace name when applicable), prompt (\"mkdir\", \"branch\", \"browser\", \"reload\", \"back\", \"forward\", \"files\", \"close-side\", \"split-right\", \"split-down\", \"zoom\", \"close-pane\", \"diff\", or \"mark-reviewed\"), folder (path for mkdir), branch (branch name to open as its own workspace), target (URL such as \"http://localhost:5173\" for browser, or copy/run id for diff).",
    "- settings: change VibeForge settings — including your own planning CLI, model, reasoning effort, plan/go mode, and voice/STT model or download — directly on the person's behalf. Fields: target (\"viby\", \"viby.engine\", \"viby.model\", \"viby.effort\", \"viby.mode\", \"viby.projectsFolder\", \"voice.model\", \"voice.download\", \"voice.speaker\", \"voice.language\", \"voice.talkBack\", \"voice.talkOver\", \"voice.mouseButton\", \"voice.sendButton\", \"voice.agent\", \"defaultEngine\", \"defaultShell\", \"theme\", \"language\", \"terminalFontSize\", \"terminalFontFamily\", \"notify\", \"sounds\", \"sounds.volume\", \"tray\", \"closeToTray\", \"autostart\", \"usage\", \"planLimits\", \"quotaAlerts\", \"activity\", \"checkUpdates\", \"agentTalk\", \"agentTalk.lead\", \"agentTalk.handOff\", \"companion\", \"sync\", \"sync.name\", \"keepRuns.days\", \"keepRuns.maxMb\"), prompt (new value, such as \"parakeet-tdt-0.6b-v3-int8\", \"claude\", \"sonnet\", \"medium\", \"go\", \"tokyo-night\", \"15\", \"on\", \"off\", or \"auto\"), plus optional engine, model, effort and folder when target is \"viby\". Selecting an uninstalled catalog STT model on `voice.model` (or voice on `voice.speaker`) downloads and selects it automatically.",
    "- stop: close a running CLI. Fields: target.",
    "- show: bring something up on the person's screen. It changes nothing, so it never needs asking about. Fields: target (a running CLI's id below, to open its terminal), or workspace (a workspace's name below, to open it in Code), or target as one of home, agents, code, chat, tasks, routines, skills, runs, viby, settings (to open that view).",
    "- read: read out verbatim to the person what a running CLI last answered (\"read me its whole answer\", \"read what Claude wrote word for word\"). Fields: target (its id below), prompt (\"all\" when they ask for all of it; otherwise empty).",
    "- apply: bring a copy's changes into the workspace it came from. discard: throw a copy away. Fields: target (a copy's id below).",
    "- task: run an existing task on the board, or create and start a new task for an agent. Fields: target (existing task id/title, or the agent's id/name for a new task), workspace (workspace name, for a new task), branch (short title for a new task), prompt (instructions for a new task).",
    "- routine: run a scheduled routine now, or turn it on/off. Fields: target (a routine's id or name below), prompt (\"enable\", \"disable\", or empty to run now).",
    "- Chaining (`after: true`): set `after: true` on any step that must wait for the immediately preceding step's CLI turn to finish first (for example: Step 1 starts Claude to fix a bug, Step 2 with `after: true` starts Grok to review it or runs `npm test` in a shell). Leave `after` false when steps should run in parallel.",
    "",
    "Rules:",
    "- One start step per CLI the person asks for. Several are fine: they run at the same time.",
    `- Use only the workspaces, engines, agents, tasks, routines, ids and copies listed below, or a workspace this plan makes. ${defaultRule}`,
    "- When they ask for a workspace, session or branch that isn't listed below, use a `lookup` step first to search disk, branches and run history if they are asking you to find an existing one; make it with a `workspace` step if they asked for a new one or gave its folder.",
    "- If the request is unclear, ask in `say` and give no steps. If they only ask a question (what's running, how it's going, what you can do) or want to brainstorm and talk through an idea before starting work, talk with them naturally in `say` with no steps.",
    "- When the person says they are done with the call, thanks you and says goodbye, or asks you to end/hang up the call (such as 'you can end the call now, thank you', 'talk to you later', 'that\\'s all, bye'), set top-level `hangup: true` (alongside any final steps they asked for) and give a brief warm sign-off in `say`. Otherwise leave `hangup` false or omitted.",
    "- If they change a plan you just gave, give the whole corrected plan again.",
    "- A request may begin with a line in parentheses saying what is in front of the person right now. \"This\", \"here\", \"this one\" and \"this workspace\" mean what that line names, and so does \"it\" when nothing else was just mentioned: \"tell it to run the tests\" is a tell to the terminal in front of them, \"start Claude here\" a start in that workspace.",
    "- When they ask to switch to, open, go to or see a workspace, a running CLI or a view, that is a show step.",
    "- A tell's prompt is what the person said to pass on, word for word, without the part spoken to you (\"tell Claude to\", \"ask it to\"). Put right a name speech-to-text got wrong; don't shorten it, polish it or add to it.",
    "- You don't see terminal screens, CLI replies, diffs or files until you ask: use an `inspect` step whenever the person asks why something failed, what a CLI is asking or answered, how a diff or workspace looks, or what their plan limits/tokens are, then summarise clearly in your own words. Use `read` when they specifically ask you to read a CLI's answer out loud verbatim. Never guess at unseen output.",
    "- After a tell or a start, VibeForge itself tells the person when that CLI has answered, with the start of its answer. Don't add a read step for an answer that isn't there yet, and don't tell them to ask for it.",
    "- Your turn ends as soon as you output JSON; nothing runs in the background after your answer unless it is in `steps`. Never say in `say` that you are searching, checking, looking up, or starting something when `steps` is empty — emit a `lookup` or `start` step instead.",
    "- `say` is spoken aloud like a sharp, warm human teammate on a phone call: one or two natural, conversational sentences in the person's language, using contractions ('On it — starting Claude on a branch.', 'Switched to VibeForge.'). No stiff filler, no markdown, and never an id such as pty-3: name a CLI by what it is and where (\"Claude in Dune\").",
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
    ...(context.settings ? ["", "Your settings & VibeForge configuration:", ...formatSettingsRules(context.settings)] : []),
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
  after?: boolean;
}

export interface RawPlan {
  say: string;
  steps: RawStep[];
  hangup?: boolean;
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
    ...(record.hangup === true ? { hangup: true } : {}),
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
          after: flag("after"),
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
  for (const item of raw.steps) {
    const kind = STEP_KINDS.find((value) => value === item.kind) ?? null;
    if (!kind) continue;
    const base: OrchestratorStep = {
      id: newStepId(),
      kind,
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: item.prompt ?? "",
      target: "",
      asked: "",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
      ...(item.after === true ? { after: true } : {}),
    };
    if (kind === "workspace") {
      const name = (item.workspace ?? "").trim();
      const step: OrchestratorStep = { ...base, prompt: "", name, folder: plannedFolder(name, item.folder, context.projectsFolder ?? ""), git: Boolean(item.git), asked: name };
      planned.push({ id: plannedId(step.id), name, folder: step.folder ?? "", git: false });
      steps.push(step);
    } else if (kind === "start") {
      const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
      // An agent named exactly comes first, so "Grok Reviewer" isn't taken for Grok Build; a CLI's
      // own id still means that CLI.
      const said = squash(item.engine ?? "");
      const exactAgent =
        said && !context.engines.some((entry) => squash(entry.id) === said) ? (context.agents ?? []).find((entry) => squash(entry.id) === said || squash(entry.name) === said) : undefined;
      const namedEngine = exactAgent ? null : matchName(item.engine, context.engines, (entry) => [entry.id, entry.label], true);
      const agent = exactAgent ?? (!namedEngine ? matchName(item.engine || item.target, context.agents ?? [], (entry) => [entry.id, entry.name], true) : null);
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
    } else if (kind === "inspect") {
      const copies = context.copies ?? [];
      const globalInspect = inspectsQuotas(item.target) || inspectsSettings(item.target);
      const cli = item.target && !globalInspect
        ? (context.running.find((entry) => entry.id === item.target) ??
          matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`]))
        : null;
      const copy = !cli && item.target && !globalInspect
        ? (copies.find((entry) => entry.id === item.target) ?? matchName(item.target, copies, (entry) => [entry.id, entry.name, entry.branch, `${entry.workspace} ${entry.name}`]))
        : null;
      const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
      const ws = fresh ?? matchName(item.workspace || (!cli && !copy && !globalInspect ? item.target : ""), context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
      const asked = cli ? `${cli.engine} · ${cli.workspace}` : copy ? `${copy.name} · ${copy.workspace}` : ws ? [ws.name, item.folder].filter(Boolean).join(" · ") : item.prompt || item.target || item.workspace || "";
      steps.push({
        ...base,
        target: cli?.id ?? copy?.id ?? "",
        workspaceId: ws?.id ?? "",
        ...(item.folder ? { folder: item.folder.trim() } : {}),
        prompt: (item.prompt || (globalInspect ? item.target : "") || "").trim(),
        asked,
      });
    } else if (kind === "settings") {
      const resolved = resolveSettingsStep(
        {
          target: item.target,
          prompt: item.prompt,
          engine: item.engine,
          model: item.model,
          effort: item.effort,
          folder: item.folder,
          branch: item.branch,
        },
        context,
      );
      steps.push({
        ...base,
        target: (item.target ?? "").trim(),
        prompt: (item.prompt ?? "").trim(),
        engineId: (item.engine ?? "").trim(),
        ...(item.model ? { model: cleanModel(item.model) } : {}),
        ...(item.effort ? { effort: item.effort.trim().toLowerCase() } : {}),
        ...(item.folder ? { folder: item.folder.trim() } : {}),
        asked: resolved.asked,
      });
    } else if (kind === "key") {
      const target =
        context.running.find((entry) => entry.id === item.target) ??
        matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`]) ??
        (context.running.length === 1 && !item.target?.trim() ? context.running[0] : null);
      const asked = target ? `${target.engine} · ${target.workspace}` : (item.target ?? "");
      steps.push({ ...base, target: target?.id ?? "", prompt: (item.prompt ?? "").trim(), asked });
    } else if (kind === "shell") {
      const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
      const ws = fresh ?? matchName(item.workspace, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
      steps.push({ ...base, workspaceId: ws?.id ?? "", prompt: (item.prompt ?? "").trim(), asked: ws?.name || item.workspace || "" });
    } else if (kind === "workbench") {
      const fresh = matchName(item.workspace, planned, (entry) => [entry.name]);
      const ws = fresh ?? matchName(item.workspace, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
      const label = [ws?.name || item.workspace, item.branch || item.folder || item.target || item.prompt].filter(Boolean).join(" · ");
      steps.push({
        ...base,
        workspaceId: ws?.id ?? "",
        prompt: (item.prompt ?? "").trim(),
        target: (item.target ?? "").trim(),
        branch: (item.branch ?? "").trim(),
        ...(item.folder ? { folder: item.folder.trim() } : {}),
        asked: label,
      });
    } else if (kind === "routine") {
      const routines = context.routines ?? [];
      const routine = routines.find((entry) => entry.id === item.target) ?? matchName(item.target || item.workspace, routines, (entry) => [entry.id, entry.name], true);
      const asked = routine ? routine.name : (item.target || item.workspace || "");
      steps.push({ ...base, prompt: routineAction(item.prompt), target: routine?.id ?? "", asked });
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
    } else if (kind === "show") {
      steps.push({ ...base, prompt: "", ...showWhat(item, context) });
    } else {
      const target = context.running.find((entry) => entry.id === item.target) ?? matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`]);
      const asked = target ? `${target.engine} · ${target.workspace}` : (item.target ?? "");
      steps.push({ ...base, prompt: kind === "tell" ? base.prompt : kind === "read" && readsAll(item.prompt) ? "all" : "", target: target?.id ?? "", asked });
    }
  }
  return steps;
}

/** A read step asked for the whole answer ("all", "all of it", "full"), not just the start of it. */
export function readsAll(said: string | undefined): boolean {
  return /^(all|all of it|everything|full|the whole thing|whole)$/.test((said ?? "").trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** What people call the views, beyond the window's own names for them. */
const VIEW_NAMES: Record<string, (typeof SHOW_VIEWS)[number]> = {
  viby: "orchestrator",
  vibey: "orchestrator",
  vibe: "orchestrator",
  maestro: "orchestrator",
  agent: "agents",
  teammates: "agents",
  terminals: "code",
  terminal: "code",
  chats: "chat",
  task: "tasks",
  board: "tasks",
  taskboard: "tasks",
  routine: "routines",
  skill: "skills",
  run: "runs",
  history: "runs",
  setting: "settings",
};

/** The view a show step named ("tasks", "the Tasks view", "Viby"), or null when it named none. */
export function showView(said: string | undefined): (typeof SHOW_VIEWS)[number] | null {
  const name = squash(said ?? "").replace(/^the/, "").replace(/(view|panel|page|tab)$/, "");
  if (!name) return null;
  return SHOW_VIEWS.find((view) => view === name) ?? VIEW_NAMES[name] ?? null;
}

/**
 * What a show step shows, in this order: a running CLI it named, a workspace called exactly that,
 * a view, then a workspace whose name comes close. So a workspace named "Tasks" beats the view,
 * and "settings" is the view even with a workspace called app-settings.
 */
export function showWhat(item: RawStep, context: PlanContext): Pick<OrchestratorStep, "target" | "workspaceId" | "asked"> & { view?: string } {
  const running = item.target ? (context.running.find((entry) => entry.id === item.target) ?? matchName(item.target, context.running, (entry) => [entry.id, `${entry.engine} ${entry.workspace}`, `${entry.engine} in ${entry.workspace}`])) : null;
  if (running) return { target: running.id, workspaceId: "", asked: `${running.engine} · ${running.workspace}` };
  const said = (item.workspace || item.target || "").trim();
  const exact = context.workspaces.filter((entry) => squash(entry.name) === squash(said));
  const view = exact.length === 1 ? null : (showView(item.target) ?? showView(item.workspace));
  const workspace = exact.length === 1 ? exact[0] : view ? null : matchName(said, context.workspaces, (entry) => [entry.name, path.basename(entry.folder)], true);
  if (workspace) return { target: "", workspaceId: workspace.id, asked: workspace.name };
  if (view) return { target: "", workspaceId: "", view, asked: view === "orchestrator" ? "Viby" : `${view[0].toUpperCase()}${view.slice(1)}` };
  return { target: "", workspaceId: "", asked: said };
}

/**
 * What is in front of the person, said to the planner ahead of their words, so "this one" and
 * "here" mean something. It goes with each request and not in the rules, which a resumed session
 * may not read again. Empty when where they are says nothing (Viby's own panel, Home).
 */
export function lookingLine(looking: Looking | null | undefined, context: PlanContext): string {
  if (!looking) return "";
  const parts: string[] = [];
  if (looking.view === "code") {
    const workspace = context.workspaces.find((item) => item.id === looking.workspaceId);
    const running = context.running.find((item) => item.id === looking.ptyId);
    if (!workspace && !running) return "";
    parts.push("the Code view");
    if (workspace) parts.push(`workspace "${workspace.name}"`);
    if (running) parts.push(`terminal ${running.id} running ${running.engine}`);
    else if (looking.ptyId) parts.push("a terminal with no coding CLI in it");
  } else {
    const view = (SHOW_VIEWS as readonly string[]).includes(looking.view) && looking.view !== "orchestrator" && looking.view !== "home" ? looking.view : "";
    const running = context.running.find((item) => item.id === looking.ptyId);
    if (!view) return "";
    parts.push(`the ${view[0].toUpperCase()}${view.slice(1)} view`);
    if (running) parts.push(`terminal ${running.id} running ${running.engine} in ${running.workspace}`);
  }
  return `(In front of the person right now: ${parts.join(", ")}.)`;
}

/**
 * A routine step's action in the words the step keeps: "enable", "disable", or "" to run it now.
 * Anything else is kept as said, and the plan card asks for it to be fixed (stepIssue).
 */
export function routineAction(said: string | undefined): string {
  const text = (said ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!text || /^(run|run it|run now|run it now|now|start|start it|go)$/.test(text)) return "";
  if (/^(enable|enabled|on|turn on|turn it on|switch on|resume|unpause)$/.test(text)) return "enable";
  if (/^(disable|disabled|off|turn off|turn it off|switch off|pause|stop)$/.test(text)) return "disable";
  return text;
}

/**
 * Whether an answer with no steps still promises to be searching, checking, or starting something
 * right now (a planner acting as if another tool turn will follow its JSON output).
 */
export function emptyPromise(say: string): boolean {
  const text = say.trim();
  if (!text || text.includes("?")) return false;
  // Waiting on the person ("I'll start it once you tell me which branch") is an answer, not a promise.
  if (/\b(once|when|after|as soon as|if)\s+(you|you've|you're|you'd)\b|\blet me know\b|\btell me\b|\bconfirm\b/i.test(text)) return false;
  return /\b(i['’]?m|i am|still)\s+(still\s+)?(searching|checking|looking|locating|finding|verifying|opening|starting|working\b|on it\b)|\b(i['’]?ll|i will)\s+(look up|search|check|locate|find|open|start|make)\b|\b(searching|checking|looking up|locating)\s+(the|that|your|for|vibe|on disk)\b/i.test(text);
}

/**
 * Whether a step in a voice call can run at once without asking "Say go, or cancel": anything that
 * only looks, makes or opens a workspace, tells a CLI, runs a task/routine, or starts a CLI in an
 * isolated review copy (or in a clean/blank checkout). Stopping a CLI, applying or discarding a
 * copy, or starting work in place over uncommitted edits still waits for Go.
 */
export function safeInCall(step: OrchestratorStep): boolean {
  if (NEEDS_GO.includes(step.kind)) return false;
  if (step.kind === "start" && !step.branch && Boolean(step.prompt.trim()) && Boolean(step.dirty)) return false;
  if (step.kind === "key") return !keySequenceFor(step.prompt)?.interrupts;
  if (step.kind === "shell") return isSafeShellCommand(step.prompt);
  if (step.kind === "workbench") {
    const action = parseWorkbenchAction(step);
    return !(action?.op === "pane" && action.action === "close");
  }
  if (step.kind === "settings") {
    const parsed = resolveSettingsStep(step, { engines: [] });
    return !(parsed.action?.op === "app-patch" && parsed.action.networkOn);
  }
  return true;
}
