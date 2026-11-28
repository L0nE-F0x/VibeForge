import { copySetupChange, type CopySetupChange } from "../shared/copy-setup.js";
import { isCodingSession } from "./companion.js";
import {
  canOrchestrate,
  orchestratorVoiceWords,
  stepIssue,
  withPlannedWorkspaces,
  type OrchestratorActivity,
  type OrchestratorStep,
  type OrchestratorThreadSummary,
  type OrchestratorTurn,
  type OrchestratorView,
  type PlanContext,
  type StepIssue,
} from "./orchestrator.js";
import type { LiveSession, OrchestratorMode } from "./types.js";

// The Orchestrator as the phone page sees it: the desktop's own conversation and plans
// (src/core/service/orchestrator.ts), with what the window works out for itself already done.
// The phone only shows and asks; planning and carrying plans out stay on the computer.

/** Turns the phone is sent: the end of the conversation. The computer keeps the rest. */
export const PHONE_TURNS = 40;
/** Of an answer a read step fetched, the phone is sent this much; the computer's card has all of it. */
export const PHONE_REPLY = 4000;

export interface PhoneStep extends OrchestratorStep {
  /** What stands in its way, while its plan waits for Go (the desktop card's check). */
  issue: StepIssue | null;
  /** start, once done: whether the terminal it opened is still open, and its run, for Open. */
  live: boolean;
  runId: string | null;
  /** A workspace copy-setup step: what it changes, for the card to show before Go. */
  copySetup?: CopySetupChange;
}

export type PhoneTurn = Omit<OrchestratorTurn, "steps"> & { steps?: PhoneStep[] };

/** A coding CLI running on the computer, as the Orchestrator's Running list shows it. */
export interface PhoneRunning {
  ptyId: string;
  runId: string | null;
  /** The CLI: "Claude Code". */
  name: string;
  /** The workspace it is in: "shop · add-cart". */
  workspace: string;
  /** How a plan's tell or stop step names it: "Claude Code · shop · add-cart". */
  label: string;
  state: "working" | "waiting";
  /** The Orchestrator started it. */
  orchestrated: boolean;
  /** "end" closes a run's own terminal; "interrupt" stops a CLI typed into a shell and leaves the shell (as the phone's Stop does). */
  stop: "end" | "interrupt";
}

export interface PhoneOrchestrator {
  engineId: string;
  engineReady: boolean;
  mode: OrchestratorMode;
  thinking: boolean;
  activity?: OrchestratorActivity | null;
  /** Turns before the ones sent. */
  earlier: number;
  turns: PhoneTurn[];
  /** The CLIs that can plan, for "Planned by". */
  planners: Array<{ id: string; label: string; available: boolean }>;
  /** Every CLI, for a step's CLI and for naming who answered. */
  engines: Array<{ id: string; label: string; available: boolean }>;
  workspaces: Array<{ id: string; name: string }>;
  running: PhoneRunning[];
  /** Copies waiting for review, for a plan's apply and discard steps to name. */
  copies?: Array<{ id: string; name: string; branch: string }>;
  /** The computer can turn the phone's speech into words (whisper.cpp and a model, from Settings → Voice). */
  hear: boolean;
  activeThreadId?: string;
  threads?: OrchestratorThreadSummary[];
  hasMemory?: boolean;
}

export interface PhoneOrchestratorInput {
  view: OrchestratorView;
  engines: Array<{ id: string; label: string; bin: string; available: boolean }>;
  workspaces: Array<{ id: string; name: string; path: string }>;
  live: readonly LiveSession[];
  hear: boolean;
  agents?: Array<{ id: string; name: string; engine: string; places?: string[]; skills?: string[] }>;
  skills?: Array<{ id: string; name: string; description?: string }>;
  tasks?: Array<{ id: string; title: string; status: string; agentId?: string | null; workspaceId?: string | null }>;
  routines?: Array<{ id: string; name: string; schedule: string; enabled: boolean; agentId?: string }>;
  chats?: Array<{ id: string; title: string; engine: string; agentId?: string | null; live: boolean }>;
}

/** A live CLI's name, the way the desktop's Running list and plan card say it. */
function cliName(session: LiveSession): string {
  return session.program || session.title.split(" · ")[0] || session.title;
}

export function buildPhoneOrchestrator(input: PhoneOrchestratorInput): PhoneOrchestrator {
  const coding = input.live.filter(isCodingSession);
  const names = new Map(input.workspaces.map((item) => [item.id, item.name]));
  // What the desktop's plan card checks a step against (usePlanContext in src/ui/views/Orchestrator.tsx).
  const context: PlanContext = {
    workspaces: input.workspaces.map((item) => ({ id: item.id, name: item.name, folder: item.path, git: true })),
    engines: input.engines.map((item) => ({ id: item.id, label: item.label, available: item.available, bin: item.bin })),
    running: coding.map((item) => ({ id: item.ptyId, engine: cliName(item), workspace: (item.workspaceId && names.get(item.workspaceId)) || item.title, folder: item.cwd, working: Boolean(item.working), orchestrated: Boolean(item.orchestrated) })),
    copies: (input.view.copies ?? []).map((item) => ({ id: item.id, name: item.name, branch: item.branch, workspace: names.get(item.workspaceId) ?? item.workspaceId })),
    ...(input.agents ? { agents: input.agents } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.tasks
      ? {
          tasks: input.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            ...(t.agentId ? { agentId: t.agentId } : {}),
            ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
          })),
        }
      : {}),
    ...(input.routines ? { routines: input.routines } : {}),
    ...(input.chats ? { chats: input.chats } : {}),
  };
  const turns = input.view.turns.slice(-PHONE_TURNS).map((turn): PhoneTurn => {
    if (!turn.steps) return turn as PhoneTurn;
    // A plan's own new workspaces count as there for its later steps, as on the desktop's card.
    const checked = withPlannedWorkspaces(context, turn.steps);
    return {
      ...turn,
      steps: turn.steps.map((step) => {
        const opened = step.ptyId ? coding.find((item) => item.ptyId === step.ptyId) : undefined;
        const reply = step.reply && step.reply.length > PHONE_REPLY ? { reply: `${step.reply.slice(0, PHONE_REPLY).trimEnd()}…` } : {};
        const copySetup = copySetupChange(step);
        return {
          ...step,
          ...reply,
          issue: turn.plan === "waiting" ? stepIssue(step, checked) : null,
          live: Boolean(opened),
          runId: opened?.runId ?? step.runId ?? null,
          ...(copySetup ? { copySetup } : {}),
        };
      }),
    };
  });
  // The Orchestrator's own first, then oldest first (TeamPanel on the desktop).
  const running = [...coding]
    .sort((a, b) => Number(Boolean(b.orchestrated)) - Number(Boolean(a.orchestrated)) || a.startedAt.localeCompare(b.startedAt))
    .map((item): PhoneRunning => {
      const where = item.workspaceId ? names.get(item.workspaceId) : undefined;
      return {
        ptyId: item.ptyId,
        runId: item.runId,
        name: cliName(item),
        workspace: where || item.title,
        label: where ? `${cliName(item)} · ${where}` : item.title,
        state: item.working ? "working" : "waiting",
        orchestrated: Boolean(item.orchestrated),
        stop: item.kind === "run" ? "end" : "interrupt",
      };
    });
  return {
    engineId: input.view.engineId,
    engineReady: input.view.engineReady,
    mode: input.view.mode,
    thinking: input.view.thinking,
    ...(input.view.activity ? { activity: input.view.activity } : {}),
    earlier: Math.max(0, input.view.turns.length - turns.length),
    turns,
    planners: input.engines.filter((item) => canOrchestrate(item)).map((item) => ({ id: item.id, label: item.label, available: item.available })),
    engines: input.engines.map((item) => ({ id: item.id, label: item.label, available: item.available })),
    workspaces: input.workspaces.map((item) => ({ id: item.id, name: item.name })),
    running,
    copies: (input.view.copies ?? []).map((item) => ({ id: item.id, name: item.name, branch: item.branch })),
    hear: input.hear,
    ...(input.view.activeThreadId ? { activeThreadId: input.view.activeThreadId } : {}),
    ...(input.view.threads?.length ? { threads: input.view.threads } : {}),
    ...(input.view.hasMemory ? { hasMemory: true } : {}),
  };
}

/**
 * Names whisper is nudged toward when the phone dictates to the Orchestrator: the same list the
 * desktop's box gives it (src/ui/voice.tsx, then the Orchestrator's own words).
 */
export function orchestratorDictationWords(input: { agents: string[]; routines: string[]; engines: string[]; workspaces: string[]; skills?: string[] }): string[] {
  return ["VibeForge", ...input.agents, ...input.routines, ...(input.skills ?? []), ...input.engines, ...orchestratorVoiceWords(input.workspaces)];
}
