// Centralized risk classification and auto-run approval policy for Viby Orchestrator plans.
// Pure and Node-free so the main process, Settings UI, and unit tests share one source of truth.

import type { OrchestratorMode } from "../core/types.js";
import { isReadOnlyComputerAction, normalizeComputerAction, validateKeyCombo, type ComputerActionKind } from "./computer-use.js";
import { isDestructiveStepAction, parseOptions } from "./orchestrator-actions.js";
import { isFreeWaitingPrompt, isLoopbackUrl, isSafeShellCommand, keySequenceFor, parseWorkbenchAction } from "./orchestrator-intel.js";
import { resolveSettingsStep } from "./orchestrator-settings.js";
import type { OrchestratorStep, OrchestratorStepKind, PlanContext } from "./orchestrator.js";

export type StepRisk = "read" | "low" | "high";

export type RiskCategory =
  | "read-only"
  | "computer-use"
  | "navigation"
  | "cli-tell"
  | "safe-action"
  | "delete"
  | "copy-mutation"
  | "in-place-edit"
  | "memory-destructive"
  | "stop"
  | "broad-settings"
  | "unsafe-shell"
  | "outward-or-privilege"
  | "approval-prompt";

export interface StepRiskAssessment {
  risk: StepRisk;
  category: RiskCategory;
  reason: string;
}

export interface ApprovalPolicyInput {
  mode: OrchestratorMode;
  fromReading?: boolean;
  /** What the person said for this plan; typing and key shortcuts after a read must come from it. */
  said?: string;
  inPlaceDirty?: boolean;
}

export interface RiskPolicyGroup {
  risk: "low" | "high";
  key: string;
}

/** Step kinds that only observe or navigate without changing state. */
export const READ_ONLY_STEP_KINDS: readonly OrchestratorStepKind[] = ["show", "read", "inspect", "lookup"];

/** Computer-use observation actions that do not inject input. */
export const READ_ONLY_COMPUTER_ACTIONS: readonly ComputerActionKind[] = ["screenshot", "windows"];

/** Computer-use input/focus actions considered low-risk on user-granted surfaces. */
export const LOW_RISK_COMPUTER_ACTIONS: readonly ComputerActionKind[] = [
  "focus-window",
  "click",
  "double-click",
  "right-click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
];

/** Human-readable risk summary groups shown in Settings → Orchestrator. */
export const RISK_POLICY_GROUPS: readonly RiskPolicyGroup[] = [
  { risk: "low", key: "orch.risk.low.computer" },
  { risk: "low", key: "orch.risk.low.read" },
  { risk: "low", key: "orch.risk.low.navigation" },
  { risk: "low", key: "orch.risk.low.tell" },
  { risk: "low", key: "orch.risk.low.safe" },
  { risk: "high", key: "orch.risk.high.delete" },
  { risk: "high", key: "orch.risk.high.copies" },
  { risk: "high", key: "orch.risk.high.inPlace" },
  { risk: "high", key: "orch.risk.high.memory" },
  { risk: "high", key: "orch.risk.high.stop" },
  { risk: "high", key: "orch.risk.high.settings" },
  { risk: "high", key: "orch.risk.high.outward" },
  { risk: "high", key: "orch.risk.high.screen" },
];

const RISK_ORDER: Record<StepRisk, number> = { read: 0, low: 1, high: 2 };
const MODE_PERMISSIVENESS: Record<OrchestratorMode, number> = { plan: 0, go: 1, never: 2 };

export function approvalPermissiveness(mode: OrchestratorMode): number {
  return MODE_PERMISSIVENESS[mode];
}

export function isReadOnlyStep(step: OrchestratorStep): boolean {
  if (READ_ONLY_STEP_KINDS.includes(step.kind)) return true;
  if (step.kind === "computer") {
    return isReadOnlyComputerAction(normalizeComputerAction(step.action || step.prompt));
  }
  return false;
}

export function isLowRiskComputerStep(step: OrchestratorStep): boolean {
  if (step.kind !== "computer") return false;
  const action = normalizeComputerAction(step.action || step.prompt);
  return action !== null && (READ_ONLY_COMPUTER_ACTIONS.includes(action) || LOW_RISK_COMPUTER_ACTIONS.includes(action));
}

/** Lower-case words and numbers only, so "Type: Hello, world!" and "hello world" compare equal. */
function plainWords(text: string): string {
  return ` ${text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

// German keyboards (and the German window) call Ctrl "Strg", said "Steuerung".
const MODIFIER_WORDS: Record<"ctrl" | "alt" | "shift" | "super", readonly string[]> = {
  ctrl: ["ctrl", "control", "command", "cmd", "strg", "steuerung"],
  alt: ["alt", "option"],
  shift: ["shift"],
  super: ["super", "windows", "win", "meta", "cmd", "command", "hyper", "mod"],
};

/**
 * Whether a computer step, planned after Viby looked at the screen, is led by what the person said
 * rather than by what Viby saw. Pointing, focusing and waiting only act where the person sent Viby,
 * so they count. Typed text counts only when the person said those words; a key with ctrl, alt or
 * super only when they named those keys. The screen can show Viby *where*, never *what*: a page
 * saying "type this in your terminal" can't get it typed without Go.
 */
export function isPersonLedComputerStep(step: OrchestratorStep, said: string): boolean {
  if (step.kind !== "computer") return false;
  const action = normalizeComputerAction(step.action || step.prompt);
  if (action === null) return false;
  if (action === "type") {
    const typed = plainWords(step.prompt ?? "");
    return typed.trim().length > 0 && plainWords(said).includes(typed);
  }
  if (action === "key") {
    const combo = validateKeyCombo(step.prompt || step.target);
    if (!combo) return false;
    const heard = plainWords(said);
    return combo.modifiers.every((mod) => mod === "shift" || MODIFIER_WORDS[mod].some((word) => heard.includes(` ${word} `)));
  }
  return READ_ONLY_COMPUTER_ACTIONS.includes(action) || LOW_RISK_COMPUTER_ACTIONS.includes(action);
}

/**
 * Steps that give an agent, skill, routine, chat, run, or Viby memory more instructions or
 * autonomous reach: they stay high-risk even under "ask only for risky actions" so inspected
 * screen/file content cannot silently inject persistent or autonomous prompts (decision D1).
 */
export function reachesFurther(step: OrchestratorStep): boolean {
  const act = (step.action ?? "").toLowerCase();
  const said = Boolean(step.prompt.trim());
  const syncOn = parseOptions(step.options).bool("sync") === true;
  switch (step.kind) {
    case "agent":
      return (
        act === "create" ||
        act === "add-folder" ||
        act === "add-skill" ||
        act === "memory-append" ||
        (act === "edit" && (Boolean(step.places?.length) || Boolean(step.engineId) || said || Boolean(step.skills?.length) || syncOn))
      );
    case "skill":
      return act === "create" || act === "attach" || act === "set-agents" || (act === "edit" && (said || syncOn));
    case "routine":
      return act === "create" || act === "enable" || (act === "edit" && said);
    case "task":
      return act === "create-run";
    case "chat":
      return (act === "create" || act === "send") && said;
    case "run":
      return act === "continue" && said;
    case "memory":
      return act === "append";
    default:
      return false;
  }
}

/** Agent talk turned on, given a lead, or raised limits beyond current settings. */
export function lessTalkLimit(
  patch: Record<string, unknown> | undefined,
  now: { on: boolean; lead: string; reviewRounds: number; maxMessages: number; maxWorking: number; maxHandOffs: number } | undefined,
): boolean {
  if (!patch) return false;
  if (patch.on === true && !now?.on) return true;
  if (typeof patch.lead === "string" && patch.lead && patch.lead !== now?.lead) return true;
  for (const field of ["maxMessages", "maxWorking", "maxHandOffs", "reviewRounds"] as const) {
    const next = patch[field];
    if (typeof next === "number" && (now === undefined || next > now[field])) return true;
  }
  return false;
}

function destructiveCategory(step: OrchestratorStep): RiskCategory {
  const act = (step.action ?? "").toLowerCase();
  if (step.kind === "task" && (act === "apply" || act === "discard")) return "copy-mutation";
  if ((step.kind === "memory" && (act === "set" || act === "clear")) || (step.kind === "agent" && (act === "memory-set" || act === "memory-clear"))) {
    return "memory-destructive";
  }
  if (act === "stop") return "stop";
  if (act === "start-tasks" || act === "run-now") return "outward-or-privilege";
  return "delete";
}

/**
 * Classifies a single planned step into `"read"`, `"low"`, or `"high"` risk with a category
 * and explanation. Every approval gate in Viby delegates here.
 */
export function classifyStepRisk(step: OrchestratorStep, context: PlanContext | null = null): StepRiskAssessment {
  if (READ_ONLY_STEP_KINDS.includes(step.kind)) {
    return { risk: "read", category: "read-only", reason: "Reads state or navigates views without mutating data" };
  }
  if (step.kind === "computer") {
    const action = normalizeComputerAction(step.action || step.prompt);
    if (isReadOnlyComputerAction(action)) {
      return { risk: "read", category: "read-only", reason: "Reads screen or window list" };
    }
    if (action && LOW_RISK_COMPUTER_ACTIONS.includes(action)) {
      return { risk: "low", category: "computer-use", reason: `Direct UI action (${action}) on a granted surface` };
    }
    return { risk: "high", category: "outward-or-privilege", reason: "Unrecognized computer-use action" };
  }
  if (step.kind === "stop") {
    return { risk: "high", category: "stop", reason: "Stops a running coding CLI" };
  }
  if (step.kind === "apply" || step.kind === "discard") {
    return { risk: "high", category: "copy-mutation", reason: `Mutates or discards a review copy (${step.kind})` };
  }
  if (isDestructiveStepAction(step.kind, step.action)) {
    return { risk: "high", category: destructiveCategory(step), reason: "Destructive or high-impact operation" };
  }
  if (step.kind === "start") {
    if (!step.prompt.trim()) {
      return { risk: "low", category: "safe-action", reason: "Opens a CLI without running edits" };
    }
    if (step.branch) {
      return { risk: "low", category: "safe-action", reason: "Runs in an isolated branch review copy" };
    }
    return { risk: "high", category: "in-place-edit", reason: "Edits code in place without an isolated branch copy" };
  }
  if (reachesFurther(step)) {
    return { risk: "high", category: "outward-or-privilege", reason: "Expands agent, routine, skill, chat, or memory instructions" };
  }
  if (step.kind === "tell") {
    if (/^[!/]/.test(step.prompt.trimStart())) {
      return { risk: "high", category: "outward-or-privilege", reason: "Shell escape or slash command in tell" };
    }
    const target = context?.running.find((item) => item.id === step.target);
    if (target?.waiting && !isFreeWaitingPrompt(target.waiting)) {
      return { risk: "high", category: "approval-prompt", reason: "CLI is waiting on an approval prompt" };
    }
    return { risk: "low", category: "cli-tell", reason: "Messages a running CLI at its normal prompt" };
  }
  if (step.kind === "key") {
    const action = keySequenceFor(step.prompt);
    if (!action) return { risk: "low", category: "safe-action", reason: "Keystroke step" };
    if (action.interrupts) {
      return { risk: "high", category: "stop", reason: "Interrupts the running process" };
    }
    const target = context?.running.find((item) => item.id === step.target);
    if (action.label === "Escape" && target?.working) {
      return { risk: "high", category: "stop", reason: "Interrupts an active CLI turn" };
    }
    const approves = action.label === "Yes" || action.label === "Enter" || /^Option [1-9]$/.test(action.label);
    if (approves && !(!step.after && target && !target.working && isFreeWaitingPrompt(target.waiting))) {
      return { risk: "high", category: "approval-prompt", reason: "Approves a CLI confirmation or tool prompt" };
    }
    return { risk: "low", category: "safe-action", reason: "Non-destructive CLI keystroke" };
  }
  if (step.kind === "shell" || step.kind === "verify") {
    if (!isSafeShellCommand(step.prompt)) {
      return { risk: "high", category: "unsafe-shell", reason: "Shell command may modify files or access external targets" };
    }
    if (step.kind === "verify" && !step.branch && Boolean(step.dirty)) {
      return { risk: "high", category: "in-place-edit", reason: "Verification in a dirty in-place workspace" };
    }
    return { risk: "low", category: "safe-action", reason: "Safe read-only or test verification command" };
  }
  if (step.kind === "workbench") {
    const action = parseWorkbenchAction(step);
    if (action?.op === "pane" && action.action === "close") {
      return { risk: "high", category: "stop", reason: "Closes a workbench pane" };
    }
    if (action?.op === "browser-open" && !isLoopbackUrl(action.url)) {
      return { risk: "high", category: "outward-or-privilege", reason: "Opens a non-local browser URL" };
    }
    return { risk: "low", category: "navigation", reason: "Workbench layout, diff, or local browser control" };
  }
  if (step.kind === "settings") {
    const action = resolveSettingsStep(step, context ?? { engines: [] }).action;
    if (!action) return { risk: "low", category: "safe-action", reason: "Unparsed settings step" };
    if (action.op === "voice-download" || action.op === "engine-save" || action.op === "engine-remove") {
      return { risk: "high", category: "broad-settings", reason: "Downloads runtimes or modifies engine definitions" };
    }
    if ((action.op === "voice-model" || action.op === "voice-speaker") && Boolean(action.downloadId)) {
      return { risk: "high", category: "broad-settings", reason: "Downloads a voice/STT model from the network" };
    }
    if (action.op === "viby") {
      const currentMode: OrchestratorMode = context?.settings?.viby.mode ?? "plan";
      if (action.mode !== undefined && approvalPermissiveness(action.mode) > approvalPermissiveness(currentMode)) {
        return { risk: "high", category: "broad-settings", reason: "Loosens Viby approval policy" };
      }
      return { risk: "low", category: "safe-action", reason: "Updates Viby planner, effort, or terse setting" };
    }
    if (action.op === "app-patch") {
      const agentTalk = action.patch.agentTalk as { handOff?: string; leadApplies?: boolean } | undefined;
      const keepRuns = action.patch.keepRuns as { days?: number; maxMb?: number } | undefined;
      const curKeep = context?.settings?.app.keepRuns;
      const shrinks = (next: number | undefined, prev: number | undefined) =>
        typeof next === "number" && next > 0 && (prev === undefined || prev === 0 || next < prev);
      if (
        Boolean(action.networkOn) ||
        "defaultShell" in action.patch ||
        action.patch.terminalPassthrough === true ||
        agentTalk?.handOff === "go" ||
        agentTalk?.leadApplies === true ||
        lessTalkLimit(action.patch.agentTalk as Record<string, unknown> | undefined, context?.settings?.app.agentTalk) ||
        shrinks(keepRuns?.days, curKeep?.days) ||
        shrinks(keepRuns?.maxMb, curKeep?.maxMb)
      ) {
        return { risk: "high", category: "broad-settings", reason: "Changes network, shell, retention, or agent autonomy settings" };
      }
    }
    return { risk: "low", category: "safe-action", reason: "Safe UI or local preference update" };
  }
  return { risk: "low", category: "safe-action", reason: "Non-destructive step" };
}

export function classifyPlanRisk(steps: readonly OrchestratorStep[], context: PlanContext | null = null): StepRisk {
  let highest: StepRisk = "read";
  for (const step of steps) {
    const { risk } = classifyStepRisk(step, context);
    if (RISK_ORDER[risk] > RISK_ORDER[highest]) highest = risk;
    if (highest === "high") return "high";
  }
  return highest;
}

export function isHighRiskStep(step: OrchestratorStep, context: PlanContext | null = null): boolean {
  return classifyStepRisk(step, context).risk === "high";
}

/**
 * Whether a ready plan (no stepIssue, no unknown kinds) should run straight away without
 * waiting for Go under the user's approval level.
 */
export function shouldAutoRunPlan(steps: readonly OrchestratorStep[], context: PlanContext | null, opts: ApprovalPolicyInput): boolean {
  if (!steps.length) return true;
  if (steps.every(isReadOnlyStep)) return true;
  if (opts.mode === "never") return true;
  if (opts.mode === "plan") return false;
  // opts.mode === "go" ("ask only for risky actions")
  if (opts.inPlaceDirty) return false;
  if (steps.some((step) => isHighRiskStep(step, context))) return false;
  if (!opts.fromReading) return true;
  // Screen/UI inspection -> low-risk computer-use actions the person asked for run in one turn.
  // What Viby read may say where to click, never what to type or which shortcut to press, and other
  // steps steered by inspected content (a workspace, a coding CLI, ...) keep decision D1.
  const said = opts.said ?? "";
  return steps.every((step) => isReadOnlyStep(step) || (isLowRiskComputerStep(step) && isPersonLedComputerStep(step, said)));
}
