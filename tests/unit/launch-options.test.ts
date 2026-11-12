import { describe, expect, it } from "vitest";
import { cleanModel, effortLevels, launchKind, launchOptionArgs, planLaunch, takesModel } from "../../src/core/engines.js";
import type { EngineRow } from "../../src/core/types.js";

const row = (id: string, bin = id): EngineRow => ({ id, label: id, bin, args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] });

describe("a CLI's model and effort", () => {
  it("knows each CLI by its id or its binary, the way its instructions are told apart", () => {
    expect(launchKind(row("claude"))).toBe("claude");
    expect(launchKind(row("mine", "/opt/grok/bin/grok"))).toBe("grok");
    expect(launchKind(row("cursor-agent"))).toBe("cursor");
    expect(launchKind(row("agy"))).toBe("agy");
    expect(launchKind(row("pi"))).toBe("pi");
    expect(launchKind(row("crush"))).toBeNull();
    expect(launchKind(row("opencode"))).toBeNull();
    expect(takesModel(row("kimi"))).toBe(true);
    expect(takesModel(row("hermes"))).toBe(false);
  });

  it("offers only the effort levels each CLI's --help lists", () => {
    expect(effortLevels(row("claude"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevels(row("grok"))).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(effortLevels(row("codex"))).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(effortLevels(row("pi"))).toContain("off");
    expect(effortLevels(row("kimi"))).toEqual([]);
    expect(effortLevels(row("cursor-agent"))).toEqual([]);
    expect(effortLevels(row("crush"))).toEqual([]);
  });

  it("turns a model and an effort into each CLI's own options, and leaves out what it doesn't take", () => {
    expect(launchOptionArgs(row("claude"), { model: "opus", effort: "high" })).toEqual(["--model", "opus", "--effort", "high"]);
    expect(launchOptionArgs(row("grok"), { model: "grok-4.7", effort: "low" })).toEqual(["-m", "grok-4.7", "--reasoning-effort", "low"]);
    expect(launchOptionArgs(row("codex"), { effort: "xhigh" })).toEqual(["-c", 'model_reasoning_effort="xhigh"']);
    expect(launchOptionArgs(row("agy"), { model: "gemini-3.8-pro", effort: "max" })).toEqual(["--model", "gemini-3.8-pro", "--effort", "max"]);
    expect(launchOptionArgs(row("copilot"), { effort: "none" })).toEqual(["--reasoning-effort", "none"]);
    expect(launchOptionArgs(row("pi"), { model: "openai/gpt-5", effort: "off" })).toEqual(["--model", "openai/gpt-5", "--thinking", "off"]);
    expect(launchOptionArgs(row("cursor-agent"), { model: "claude-opus-4-8[effort=high]", effort: "high" })).toEqual(["--model", "claude-opus-4-8[effort=high]"]);
    expect(launchOptionArgs(row("kimi"), { model: "k3", effort: "high" })).toEqual(["-m", "k3"]);
    // A level the CLI doesn't list, or no CLI VibeForge knows: nothing it could refuse.
    expect(launchOptionArgs(row("claude"), { effort: "ultra" })).toEqual([]);
    expect(launchOptionArgs(row("crush"), { model: "x", effort: "high" })).toEqual([]);
    expect(launchOptionArgs(row("claude"), {})).toEqual([]);
  });

  it("never lets a model name become another option", () => {
    expect(cleanModel(" sonnet ")).toBe("sonnet");
    expect(cleanModel("--dangerously-skip-permissions")).toBe("");
    expect(cleanModel("opus --print")).toBe("");
    expect(cleanModel("x".repeat(121))).toBe("");
  });

  it("puts them before the resume words and the prompt, and keeps them in the run's record", () => {
    const plan = planLaunch(row("codex"), "/bin/codex", { prompt: "Fix it", continueSession: true, options: ["-m", "gpt-x"] });
    expect(plan.argv).toEqual(["/bin/codex", "-m", "gpt-x", "--continue", "Fix it"]);
    expect(plan.recordArgv).toEqual(["/bin/codex", "-m", "gpt-x", "--continue", "{prompt}"]);
    const told = planLaunch(row("claude"), "/bin/claude", { prompt: "Go", options: ["--effort", "high"], instructions: { argv: ["--append-system-prompt", "NOTE"], record: ["--append-system-prompt", "{VibeForge note}"] } });
    expect(told.argv).toEqual(["/bin/claude", "--effort", "high", "--append-system-prompt", "NOTE", "Go"]);
  });
});
