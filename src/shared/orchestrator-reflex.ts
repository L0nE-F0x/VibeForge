// Deterministic 0ms local reflex parser for crisp, unambiguous single-intent Viby commands
// (slash commands, Go/Cancel on a waiting plan, Undo, Mark reviewed, Remember, and deep-link navigation).
// Pure and Node-free so desktop, voice calls, and phone companion share identical reflex logic.

import { planAnswer } from "./plan-answer.js";
import type { Looking, OrchestratorStepKind, PlanContext } from "./orchestrator.js";

export interface ReflexRawStep {
  kind: OrchestratorStepKind;
  action?: string;
  target?: string;
  workspace?: string;
  agent?: string;
  task?: string;
  prompt?: string;
  status?: string;
  options?: string;
}

export type LocalReflex =
  | { kind: "plan-go" }
  | { kind: "plan-cancel" }
  | { kind: "new-thread" }
  | {
      kind: "steps";
      tag: "show" | "undo" | "reviewed" | "remember" | "stop-all";
      label: string;
      rawSteps: ReflexRawStep[];
    };

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const SETTINGS_SECTIONS = new Set([
  "appearance",
  "engines",
  "orchestrator",
  "viby",
  "voice",
  "sounds",
  "tray",
  "usage",
  "agent-talk",
  "phone",
  "sync",
  "storage",
  "rail",
  "updates",
]);

const AGENT_TABS = new Set(["chats", "brief", "memory", "skills", "folders", "runs", "settings"]);

const VIEW_ALIASES: Record<string, string> = {
  home: "home",
  agents: "agents",
  agent: "agents",
  teammates: "agents",
  code: "code",
  terminals: "code",
  terminal: "code",
  chat: "chat",
  chats: "chat",
  tasks: "tasks",
  task: "tasks",
  board: "tasks",
  routines: "routines",
  routine: "routines",
  skills: "skills",
  skill: "skills",
  runs: "runs",
  run: "runs",
  history: "runs",
  viby: "orchestrator",
  vibey: "orchestrator",
  orchestrator: "orchestrator",
  settings: "settings",
  setting: "settings",
};

function findMatch<T>(query: string, items: readonly T[], nameOf: (item: T) => string[]): T | null {
  const wanted = squash(query);
  if (!wanted) return null;
  const exact = items.filter((item) => nameOf(item).some((n) => n && squash(n) === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const starts = items.filter((item) => nameOf(item).some((n) => n && squash(n).startsWith(wanted)));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;
  if (wanted.length >= 3) {
    const contains = items.filter((item) => nameOf(item).some((n) => n && squash(n).includes(wanted)));
    if (contains.length === 1) return contains[0];
  }
  return null;
}

function buildShowStep(rawTarget: string, context: PlanContext, looking?: Looking | null): { step: ReflexRawStep; label: string } | null {
  const cleaned = rawTarget
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/\s+(?:workspace|view|panel|page|tab|section|settings)$/i, (m) => (m.toLowerCase().includes("settings") ? " settings" : ""))
    .trim();
  if (!cleaned) return null;

  // "this workspace" / "here"
  if (/^(?:this|here|this workspace)$/i.test(cleaned) && looking?.workspaceId) {
    const ws = context.workspaces.find((w) => w.id === looking.workspaceId);
    if (ws) return { step: { kind: "show", workspace: ws.id }, label: ws.name };
  }

  // "<section> settings" or "settings <section>"
  const settingsMatch = /^(?:settings\s+(.+)|(.+?)\s+settings)$/i.exec(cleaned);
  if (settingsMatch) {
    const rawSec = (settingsMatch[1] || settingsMatch[2] || "").trim().toLowerCase().replace(/\s+/g, "-");
    const sec = rawSec === "viby" ? "orchestrator" : rawSec === "agenttalk" || rawSec === "agents-together" ? "agent-talk" : rawSec;
    if (SETTINGS_SECTIONS.has(sec)) {
      return {
        step: { kind: "show", target: "settings", options: `section=${sec}` },
        label: `Settings · ${sec}`,
      };
    }
  }

  // "<agent>'s <tab>" or "<agent> <tab>"
  const agentTabMatch = /^(.+?)(?:'s|’s)?\s+(chats|brief|memory|skills|folders|runs|settings)$/i.exec(cleaned);
  if (agentTabMatch && !VIEW_ALIASES[squash(cleaned)]) {
    const agent = findMatch(agentTabMatch[1], context.agents ?? [], (a) => [a.id, a.name]);
    const tab = agentTabMatch[2].toLowerCase();
    if (agent && AGENT_TABS.has(tab)) {
      return {
        step: { kind: "show", target: "agents", agent: agent.id, options: `tab=${tab}` },
        label: `${agent.name} · ${tab}`,
      };
    }
  }

  // Exact or unambiguous view name
  const viewKey = squash(cleaned);
  if (VIEW_ALIASES[viewKey]) {
    const label = cleaned[0].toUpperCase() + cleaned.slice(1);
    return { step: { kind: "show", target: VIEW_ALIASES[viewKey] }, label };
  }

  // Workspace / Live CLI / Agent / Task / Routine / Skill / Chat / Copy
  const ws = findMatch(cleaned, context.workspaces, (w) => [w.id, w.name]);
  if (ws) return { step: { kind: "show", workspace: ws.id }, label: ws.name };

  const cli = findMatch(cleaned, context.running, (r) => [r.id, r.engine, `${r.engine} ${r.workspace}`, `${r.engine} in ${r.workspace}`]);
  if (cli) return { step: { kind: "show", target: cli.id }, label: `${cli.engine} · ${cli.workspace}` };

  const agent = findMatch(cleaned, context.agents ?? [], (a) => [a.id, a.name]);
  if (agent) return { step: { kind: "show", target: agent.id, agent: agent.id }, label: agent.name };

  const task = findMatch(cleaned, context.tasks ?? [], (t) => [t.id, t.title]);
  if (task) return { step: { kind: "show", target: task.id, task: task.id }, label: task.title };

  const routine = findMatch(cleaned, context.routines ?? [], (r) => [r.id, r.name]);
  if (routine) return { step: { kind: "show", target: routine.id }, label: routine.name };

  const skill = findMatch(cleaned, context.skills ?? [], (s) => [s.id, s.name]);
  if (skill) return { step: { kind: "show", target: skill.id }, label: skill.name };

  const copy = findMatch(cleaned, context.copies ?? [], (c) => [c.id, c.name, c.branch]);
  if (copy) return { step: { kind: "show", target: copy.id }, label: copy.name };

  return null;
}

/**
 * Resolves crisp, unambiguous single-intent commands locally in 0ms without calling a planning CLI.
 * Returns `null` when the request is conversational, compound, uncertain, or requires LLM reasoning.
 */
export function resolveLocalReflex(
  said: string,
  context: PlanContext,
  looking?: Looking | null,
  hasWaitingPlan = false,
): LocalReflex | null {
  const trimmed = said.trim();
  if (!trimmed) return null;

  // 1. Explicit slash commands (always deterministic)
  if (trimmed.startsWith("/")) {
    const match = /^\/([a-z-]+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
    if (!match) return null;
    const cmd = match[1].toLowerCase();
    const arg = (match[2] ?? "").trim();
    if (cmd === "go" && !arg) return hasWaitingPlan ? { kind: "plan-go" } : null;
    if (cmd === "cancel" && !arg) return hasWaitingPlan ? { kind: "plan-cancel" } : null;
    if ((cmd === "new" || cmd === "clear") && !arg) return { kind: "new-thread" };
    if (cmd === "undo" && !arg) {
      return { kind: "steps", tag: "undo", label: "Undo", rawSteps: [{ kind: "workbench", prompt: "undo" }] };
    }
    if ((cmd === "review" || cmd === "mark-reviewed") && !arg) {
      return { kind: "steps", tag: "reviewed", label: "Mark all runs reviewed", rawSteps: [{ kind: "workbench", prompt: "mark-reviewed" }] };
    }
    if ((cmd === "memory" || cmd === "remember") && arg) {
      return {
        kind: "steps",
        tag: "remember",
        label: arg,
        rawSteps: [{ kind: "memory", action: "append", prompt: arg }],
      };
    }
    if (cmd === "stop-all" && !arg) {
      const own = context.running.filter((r) => r.orchestrated);
      if (!own.length) return null;
      return {
        kind: "steps",
        tag: "stop-all",
        label: `${own.length}`,
        rawSteps: own.map((r) => ({ kind: "stop", target: r.id })),
      };
    }
    if ((cmd === "open" || cmd === "show") && arg) {
      const nav = buildShowStep(arg, context, looking);
      if (nav) return { kind: "steps", tag: "show", label: nav.label, rawSteps: [nav.step] };
    }
    return null;
  }

  // Questions always go to the LLM planner.
  if (trimmed.includes("?")) return null;

  const stripped = trimmed
    .replace(/^(?:(?:hey|ok|okay|alright|all right|please)\s+)*(?:(?:viby|vibey|vibe|maestro)[,:\s]+)?/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!stripped) return null;
  const lower = stripped.toLowerCase();

  // Remember reflex (can hold natural clauses like "because ...", so check before compound filter)
  const rememberMatch = /^(?:remember(?:\s+that)?[:,\s]+|note(?:\s+that)?[:,\s]+)(.+)$/i.exec(stripped);
  if (rememberMatch) {
    const note = rememberMatch[1].trim();
    if (note.length >= 3 && note.length <= 500) {
      return {
        kind: "steps",
        tag: "remember",
        label: note,
        rawSteps: [{ kind: "memory", action: "append", prompt: note }],
      };
    }
  }

  // Waiting-plan reflexes
  if (hasWaitingPlan) {
    // The same answers a call hears: "go", "go, go, go", "I said go", "never mind" (plan-answer.ts).
    const answer = planAnswer(trimmed);
    if (answer === "go") return { kind: "plan-go" };
    if (answer === "cancel") return { kind: "plan-cancel" };
  }

  // Single-intent undo & mark-reviewed reflexes
  if (/^(?:undo|undo that|undo last delete|undo the last delete|restore that|put that back)$/.test(lower)) {
    return { kind: "steps", tag: "undo", label: "Undo", rawSteps: [{ kind: "workbench", prompt: "undo" }] };
  }
  if (/^(?:mark all(?: runs)? reviewed|clear review inbox|mark everything reviewed)$/.test(lower)) {
    return { kind: "steps", tag: "reviewed", label: "Mark all runs reviewed", rawSteps: [{ kind: "workbench", prompt: "mark-reviewed" }] };
  }

  // Never hijack compound sentences for navigation
  if (/\b(?:and|then|also|start|tell|ask|run|make|create|new|stop|close|kill|apply|discard|check|inspect|search|find|why|how|what)\b/i.test(stripped)) {
    return null;
  }

  // Crisp navigation reflexes
  const showMatch = /^(?:switch to|open up|open|show me|show|go to)\s+(.+)$/i.exec(stripped);
  if (showMatch) {
    const nav = buildShowStep(showMatch[1], context, looking);
    if (nav) return { kind: "steps", tag: "show", label: nav.label, rawSteps: [nav.step] };
  }

  return null;
}
