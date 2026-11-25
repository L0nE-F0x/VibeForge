import { describe, expect, it } from "vitest";
import { callWord } from "../../src/core/call.js";
import type { PlanContext } from "../../src/shared/orchestrator.js";
import { resolveLocalReflex } from "../../src/shared/orchestrator-reflex.js";
import { planAnswer } from "../../src/shared/plan-answer.js";

const context: PlanContext = {
  workspaces: [{ id: "vf", name: "VibeForge", folder: "~/Projects/VibeForge", git: true }],
  engines: [{ id: "claude", label: "Claude Code", available: true }],
  agents: [],
  running: [],
};

describe("answering a plan that waits for Go", () => {
  // Said in a real call on 2026-11-25, where each one went to the planner and the plan waited again.
  const saidInACall = ["Go, go, go, go.", "I said go.", "Go.", "go"];

  it("hears go however it's said", () => {
    for (const said of [
      ...saidInACall,
      "Go go go",
      "Go ahead, go ahead!",
      "Just do it now.",
      "Come on, go!",
      "Yes, go ahead please",
      "Okay, run it.",
      "Do it already",
      "Viby, go now please",
      "Yeah go",
      "Um, go.",
      "Uh, yes.",
      "Go ahead and do it.",
      "Let's go.",
      "Click it.",
      "Yes, click it.",
      "Run that.",
      "Do that.",
      "Proceed.",
      "Approve.",
      "Sounds good.",
      "Yup.",
      "Los, los!",
      "Vas-y.",
      "Ja, bitte",
    ]) {
      expect(planAnswer(said), said).toBe("go");
    }
  });

  it("hears cancel however it's said", () => {
    for (const said of ["No, no, no.", "I said cancel.", "Never mind!", "please stop", "Okay, forget it", "Nein, nein"]) {
      expect(planAnswer(said), said).toBe("cancel");
    }
  });

  it("leaves anything else for Viby", () => {
    for (const said of [
      "Go to settings",
      "go to the VibeForge workspace",
      "don't go",
      "no go",
      "go and also fix the failing tests",
      "start Claude here",
      "Great.",
      "hmm, ok",
      "You didn't do what I asked.",
      "go go go go go go go go go go",
      "",
    ]) {
      expect(planAnswer(said), said).toBeNull();
    }
  });

  it("answers the same in the Viby box and in a call", () => {
    for (const said of [...saidInACall, "Never mind.", "Just do it now."]) {
      const answer = planAnswer(said);
      expect(callWord(said), said).toBe(answer);
      expect(resolveLocalReflex(said, context, null, true), said).toEqual({ kind: answer === "go" ? "plan-go" : "plan-cancel" });
    }
  });

  it("only answers a plan that is waiting", () => {
    expect(resolveLocalReflex("I said go.", context, null, false)).toBeNull();
    expect(resolveLocalReflex("Go, go, go, go.", context, null, false)).toBeNull();
  });

  it("keeps a call's other words", () => {
    expect(callWord("Wait, wait, wait")).toBe("hush");
    expect(callWord("Hang up, hang up")).toBe("hangup");
    expect(callWord("stop")).toBe("cancel");
  });
});
