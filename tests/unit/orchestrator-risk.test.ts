import { describe, expect, it } from "vitest";
import {
  approvalPermissiveness,
  classifyPlanRisk,
  classifyStepRisk,
  holdsForGo,
  isHighRiskStep,
  isLowRiskComputerStep,
  isReadOnlyStep,
  orchestratorRules,
  RISK_POLICY_GROUPS,
  resolveSettingsStep,
  safeInCall,
  shouldAutoRunPlan,
  type OrchestratorStep,
  type PlanContext,
  type PlanSettingsContext,
} from "../../src/core/orchestrator.js";
import { en } from "../../src/ui/i18n/en.js";

const step = (partial: Partial<OrchestratorStep>): OrchestratorStep => ({
  id: "s1",
  kind: "show",
  engineId: "",
  workspaceId: "ws1",
  branch: "",
  prompt: "",
  target: "",
  asked: "",
  state: "planned",
  error: null,
  ptyId: null,
  openedWorkspaceId: null,
  ...partial,
});

function baseSettings(mode: "plan" | "go" | "never" = "go", terse = true): PlanSettingsContext {
  return {
    viby: {
      planner: "claude",
      pickedEngine: "claude",
      mode,
      terse,
      model: "",
      effort: "low",
      projectsFolder: "~/Projects",
      availablePlanners: [{ id: "claude", label: "Claude Code", available: true, models: [], efforts: ["low", "medium", "high"] }],
    },
    voice: {
      ready: false,
      activeModel: "",
      pickedModel: "",
      installedModels: [],
      runtimes: { whisperServer: false, whisperCli: false, sherpa: false, recorder: null, piper: false },
      language: "auto",
      talkBack: true,
      talkOver: "auto",
      activeSpeaker: "",
      pickedSpeaker: "",
      installedVoices: [],
      mouseButton: "off",
      sendButton: "pointer",
      agent: "",
    },
    app: {
      defaultEngine: "claude",
      defaultShell: "/bin/bash",
      theme: "omarchy",
      language: "en",
      terminalFontSize: 13,
      terminalFontFamily: "monospace",
      notify: true,
      sounds: { on: true, volume: 0.6, voice: true, attention: true, finished: true, routines: false, inFront: false },
      tray: true,
      closeToTray: true,
      usage: true,
      planLimits: false,
      quotaAlerts: false,
      activity: "git",
      checkUpdates: true,
      companion: { enabled: false, port: 4318 },
      sync: { enabled: false, name: "" },
      agentTalk: { on: false, lead: "", handOff: "ask", reviewRounds: 1, maxMessages: 6, maxWorking: 3, maxHandOffs: 4, leadApplies: false },
      keepRuns: { days: 0, maxMb: 0 },
    },
  };
}

const ctx = (mode: "plan" | "go" | "never" = "go", terse = true): PlanContext => ({
  workspaces: [{ id: "ws1", name: "App", folder: "~/Projects/App", git: true }],
  engines: [{ id: "claude", label: "Claude Code", available: true, bin: "claude" }],
  running: [
    { id: "pty-normal", engine: "Claude Code", workspace: "App", folder: "~/Projects/App", working: false, orchestrated: true },
    { id: "pty-working", engine: "Claude Code", workspace: "App", folder: "~/Projects/App", working: true, orchestrated: true },
    { id: "pty-trust", engine: "Claude Code", workspace: "App", folder: "~/Projects/App", working: false, orchestrated: true, waiting: "Do you trust the files in this folder?" },
    { id: "pty-approve", engine: "Claude Code", workspace: "App", folder: "~/Projects/App", working: false, orchestrated: true, waiting: "Do you want to proceed?" },
  ],
  settings: baseSettings(mode, terse),
});

describe("Centralized risk classification and approval policy", () => {
  it("classifies read-only and low-risk steps properly", () => {
    const context = ctx();
    for (const kind of ["show", "read", "inspect", "lookup"] as const) {
      const s = step({ kind, target: "pty-normal", prompt: "status" });
      expect(classifyStepRisk(s, context).risk).toBe("read");
      expect(isReadOnlyStep(s)).toBe(true);
    }

    for (const action of ["screenshot", "windows"] as const) {
      const s = step({ kind: "computer", action });
      expect(classifyStepRisk(s, context)).toMatchObject({ risk: "read", category: "read-only" });
      expect(isReadOnlyStep(s)).toBe(true);
      expect(isLowRiskComputerStep(s)).toBe(true);
    }

    for (const action of ["focus-window", "click", "double-click", "right-click", "move", "drag", "scroll", "type", "key", "wait"] as const) {
      for (const surface of ["desktop", "app", "browser"] as const) {
        const s = step({ kind: "computer", action, target: "100,200", prompt: action === "key" ? "Enter" : "hi", options: `surface=${surface}` });
        expect(classifyStepRisk(s, context)).toMatchObject({ risk: "low", category: "computer-use" });
        expect(isHighRiskStep(s, context)).toBe(false);
        expect(holdsForGo(s, context)).toBe(false);
        expect(safeInCall(s, context)).toBe(true);
        expect(isLowRiskComputerStep(s)).toBe(true);
      }
    }

    // Normal tell, bare CLI start, isolated branch start, workspace create/rename, safe workbench, safe settings
    expect(classifyStepRisk(step({ kind: "tell", target: "pty-normal", prompt: "Run tests" }), context)).toMatchObject({ risk: "low", category: "cli-tell" });
    expect(classifyStepRisk(step({ kind: "start", engineId: "claude", prompt: "" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "start", engineId: "claude", branch: "fix-bug", prompt: "Fix it" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "workspace", action: "create", name: "new-ws" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "workbench", prompt: "browser", target: "http://127.0.0.1:5173" }), context)).toMatchObject({ risk: "low", category: "navigation" });
    expect(classifyStepRisk(step({ kind: "key", target: "pty-normal", prompt: "down" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "key", target: "pty-trust", prompt: "yes" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "shell", prompt: "git status" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "settings", target: "viby.terse", prompt: "on" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "settings", target: "viby.mode", prompt: "plan" }), context).risk).toBe("low");
    expect(classifyStepRisk(step({ kind: "talk", action: "review", target: "pty-normal" }), context).risk).toBe("low");
  });

  it("classifies high-risk destructive, in-place, memory, stop, broad settings, and outward actions", () => {
    const context = ctx("go");
    const cases: Array<[Partial<OrchestratorStep>, string]> = [
      [{ kind: "agent", action: "delete", target: "atlas" }, "delete"],
      [{ kind: "skill", action: "delete", target: "lint" }, "delete"],
      [{ kind: "task", action: "delete", target: "t1" }, "delete"],
      [{ kind: "routine", action: "delete", target: "r1" }, "delete"],
      [{ kind: "chat", action: "delete", target: "c1" }, "delete"],
      [{ kind: "workspace", action: "remove", target: "ws1" }, "delete"],
      [{ kind: "run", action: "tidy" }, "delete"],
      [{ kind: "shell", prompt: "rm -rf src" }, "unsafe-shell"],
      [{ kind: "verify", branch: "", prompt: "npm test", dirty: 2 }, "in-place-edit"],
      [{ kind: "apply", target: "c1" }, "copy-mutation"],
      [{ kind: "discard", target: "c1" }, "copy-mutation"],
      [{ kind: "task", action: "apply", target: "t1" }, "copy-mutation"],
      [{ kind: "task", action: "discard", target: "t1" }, "copy-mutation"],
      [{ kind: "start", engineId: "claude", branch: "", prompt: "Edit code in place" }, "in-place-edit"],
      [{ kind: "memory", action: "set", prompt: "new" }, "memory-destructive"],
      [{ kind: "memory", action: "clear" }, "memory-destructive"],
      [{ kind: "agent", action: "memory-clear", target: "a1" }, "memory-destructive"],
      [{ kind: "stop", target: "pty-normal" }, "stop"],
      [{ kind: "task", action: "stop", target: "t1" }, "stop"],
      [{ kind: "key", target: "pty-normal", prompt: "ctrl+c" }, "stop"],
      [{ kind: "key", target: "pty-working", prompt: "escape" }, "stop"],
      [{ kind: "workbench", prompt: "close-pane" }, "stop"],
      [{ kind: "workbench", prompt: "browser", target: "https://example.com" }, "outward-or-privilege"],
      [{ kind: "tell", target: "pty-normal", prompt: "!rm -rf /tmp/x" }, "outward-or-privilege"],
      [{ kind: "tell", target: "pty-approve", prompt: "yes" }, "approval-prompt"],
      [{ kind: "key", target: "pty-approve", prompt: "yes" }, "approval-prompt"],
      [{ kind: "computer", action: "bogus" }, "outward-or-privilege"],
      [{ kind: "settings", target: "companion", prompt: "on" }, "broad-settings"],
      [{ kind: "settings", target: "defaultShell", prompt: "/bin/zsh" }, "broad-settings"],
      [{ kind: "settings", target: "viby.mode", prompt: "never ask" }, "broad-settings"],
      [{ kind: "settings", target: "engines.remove", engineId: "claude" }, "broad-settings"],
      [{ kind: "talk", action: "start-tasks", target: "pty-normal" }, "outward-or-privilege"],
    ];
    for (const [partial, category] of cases) {
      const s = step(partial);
      expect(classifyStepRisk(s, context), JSON.stringify(partial)).toMatchObject({ risk: "high", category });
      expect(isHighRiskStep(s, context)).toBe(true);
      expect(holdsForGo(s, context)).toBe(true);
      expect(safeInCall(s, context)).toBe(false);
    }

    // Loosening from "plan" -> "go" is high risk; staying at "go" is low risk.
    expect(classifyStepRisk(step({ kind: "settings", target: "viby.mode", prompt: "go" }), ctx("plan")).risk).toBe("high");
    expect(classifyStepRisk(step({ kind: "settings", target: "viby.mode", prompt: "go" }), ctx("go")).risk).toBe("low");
    expect(classifyPlanRisk([step({ kind: "show" }), step({ kind: "computer", action: "click", target: "1,2" })], context)).toBe("low");
    expect(classifyPlanRisk([step({ kind: "show" }), step({ kind: "stop", target: "pty-normal" })], context)).toBe("high");
    expect(classifyPlanRisk([], context)).toBe("read");
  });

  it("enforces shouldAutoRunPlan across all three approval modes and observe-then-act chains", () => {
    const context = ctx();
    const readSteps = [step({ kind: "show" }), step({ kind: "inspect", action: "screen" })];
    const computerClick = [step({ kind: "computer", action: "click", target: "10,20" })];
    const startBranch = [step({ kind: "start", engineId: "claude", branch: "feat", prompt: "Build" })];
    const deleteAgent = [step({ kind: "agent", action: "delete", target: "a1" })];

    // "plan" (Ask for everything): only read-only runs automatically, even during a voice call.
    expect(shouldAutoRunPlan([], context, { mode: "plan" })).toBe(true);
    expect(shouldAutoRunPlan(readSteps, context, { mode: "plan" })).toBe(true);
    expect(shouldAutoRunPlan(computerClick, context, { mode: "plan", inCall: true })).toBe(false);
    expect(shouldAutoRunPlan(startBranch, context, { mode: "plan", inCall: true })).toBe(false);

    // "go" (Ask only for risky actions): low-risk actions run straight away; screen->click chains run;
    // D1 protects non-computer steps after reading, and high-risk steps still wait.
    expect(shouldAutoRunPlan(computerClick, context, { mode: "go" })).toBe(true);
    expect(shouldAutoRunPlan(computerClick, context, { mode: "go", fromReading: true })).toBe(true);
    expect(shouldAutoRunPlan(startBranch, context, { mode: "go" })).toBe(true);
    expect(shouldAutoRunPlan(startBranch, context, { mode: "go", fromReading: true })).toBe(false);
    expect(shouldAutoRunPlan(startBranch, context, { mode: "go", inPlaceDirty: true })).toBe(false);
    expect(shouldAutoRunPlan(deleteAgent, context, { mode: "go" })).toBe(false);

    // "never" (Never ask): everything executes immediately.
    expect(shouldAutoRunPlan(deleteAgent, context, { mode: "never" })).toBe(true);
    expect(shouldAutoRunPlan(startBranch, context, { mode: "never", fromReading: true })).toBe(true);

    expect(approvalPermissiveness("plan")).toBeLessThan(approvalPermissiveness("go"));
    expect(approvalPermissiveness("go")).toBeLessThan(approvalPermissiveness("never"));
  });

  it("exposes valid Settings UI risk groups and parses approval & terse settings steps", () => {
    const engines = [{ id: "claude", label: "Claude Code", available: true, bin: "claude" }];
    for (const group of RISK_POLICY_GROUPS) {
      expect(en[group.key as keyof typeof en]).toBeTruthy();
    }

    expect(resolveSettingsStep({ target: "viby.approval", prompt: "ask only for risky actions" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", mode: "go" },
    });
    expect(resolveSettingsStep({ target: "viby.approval", prompt: "never ask" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", mode: "never" },
    });
    expect(resolveSettingsStep({ target: "viby.mode", prompt: "ask for everything" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", mode: "plan" },
    });
    expect(resolveSettingsStep({ target: "viby.terse", prompt: "off" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", terse: false },
    });
    expect(resolveSettingsStep({ target: "viby", options: "mode=never, terse=off" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", mode: "never", terse: false },
    });
    expect(resolveSettingsStep({ target: "viby.terse", prompt: "maybe" }, { engines }).issue).toBe("prompt");

    const rulesNeverTerse = orchestratorRules(ctx("never", true));
    expect(rulesNeverTerse).toContain("Never ask");
    expect(rulesNeverTerse).toContain('leave `say: ""` or give a very short confirmation');

    const rulesPlanVerbose = orchestratorRules(ctx("plan", false));
    expect(rulesPlanVerbose).toContain("Ask for everything");
    expect(rulesPlanVerbose).toContain("conversational");
  });
});
