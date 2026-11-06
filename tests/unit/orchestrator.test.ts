import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brainArgs, canOrchestrate, cleanBranch, matchName, orchestratorRules, readBrainOutput, resolvePlan, stepIssue, type PlanContext } from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import type { EngineRow } from "../../src/core/types.js";
import { setup, tempDir, until } from "./fixtures/service-harness.js";

const grok: EngineRow = { id: "grok", label: "Grok Build", bin: "grok", args: [] };
const claude: EngineRow = { id: "claude", label: "Claude Code", bin: "claude", args: [] };
const codex: EngineRow = { id: "codex", label: "Codex", bin: "codex", args: [] };

const context: PlanContext = {
  workspaces: [
    { id: "vibeforge", name: "VibeForge", folder: "~/Projects/VibeForge", git: true },
    { id: "dune", name: "Dune", folder: "~/Projects/Dune", git: true },
    { id: "notes", name: "Notes", folder: "~/notes", git: false },
  ],
  engines: [
    { id: "claude", label: "Claude Code", available: true },
    { id: "grok", label: "Grok Build", available: true },
    { id: "kimi", label: "Kimi", available: false },
  ],
  running: [{ id: "pty-4", engine: "Codex", workspace: "Dune", folder: "~/Projects/Dune", working: false, orchestrated: false }],
};

describe("the Orchestrator's plans", () => {
  it("plans with Grok Build or Claude Code, tools off, resuming its own session", () => {
    expect(canOrchestrate(grok)).toBe(true);
    expect(canOrchestrate(claude)).toBe(true);
    expect(canOrchestrate(codex)).toBe(false);
    expect(brainArgs(codex, { text: "hi", rules: "r", sessionId: "s", resume: false })).toBeNull();

    const first = brainArgs(grok, { text: "-start claude", rules: "RULES", sessionId: "abc", resume: false }) ?? [];
    expect(first.slice(0, 4)).toEqual(["-p", "-start claude", "--rules", "RULES"]);
    expect(first).toContain("--json-schema");
    expect(first.slice(-2)).toEqual(["-s", "abc"]);
    expect(brainArgs(grok, { text: "x", rules: "r", sessionId: "abc", resume: true })?.slice(-2)).toEqual(["-r", "abc"]);

    const asked = brainArgs(claude, { text: "--help me", rules: "RULES", sessionId: "abc", resume: true }) ?? [];
    // --tools takes every word up to the next option, so "" comes straight before one.
    expect(asked.slice(0, 3)).toEqual(["--tools", "", "--print"]);
    expect(asked.slice(-4)).toEqual(["--resume", "abc", "--", "--help me"]);
  });

  it("tells the planning CLI what is here and that it never picks an engine itself", () => {
    const rules = orchestratorRules(context);
    expect(rules).toContain("- VibeForge (~/Projects/VibeForge)");
    expect(rules).toContain("- Notes (~/notes, not a git repository)");
    expect(rules).toContain("- grok: Grok Build");
    expect(rules).not.toContain("Kimi");
    expect(rules).toContain("- pty-4: Codex in Dune (~/Projects/Dune), waiting for input");
    expect(rules).toContain("Never pick an engine the person didn't ask for");
  });

  it("reads the plan from Grok Build's and Claude Code's output, or JSON in the text", () => {
    const fromGrok = JSON.stringify({
      text: '{"say":"Starting.","steps":[]}',
      stopReason: "end_turn",
      structuredOutput: { say: "Starting Claude Code in Dune.", steps: [{ kind: "start", engine: "claude", workspace: "Dune" }] },
    });
    expect(readBrainOutput(fromGrok).plan).toEqual({ say: "Starting Claude Code in Dune.", steps: [{ kind: "start", engine: "claude", workspace: "Dune", branch: undefined, prompt: undefined, target: undefined }] });
    const fromClaude = JSON.stringify({ type: "result", result: "ok", structured_output: { say: "Which workspace?", steps: [] } });
    expect(readBrainOutput(fromClaude).plan).toEqual({ say: "Which workspace?", steps: [] });
    expect(readBrainOutput('Here you go: {"say":"Hi.","steps":[]} done').plan?.say).toBe("Hi.");
    expect(readBrainOutput("I can't help with that.").plan).toBeNull();
    expect(readBrainOutput(JSON.stringify({ text: "Sorry, no." })).text).toBe("Sorry, no.");
  });

  it("matches spoken names generously, and not when two fit as well", () => {
    const names = (item: { name: string }) => [item.name];
    const items = [{ name: "VibeForge" }, { name: "Dune" }, { name: "Dune Atlas" }];
    expect(matchName("vibe forge", items, names)?.name).toBe("VibeForge");
    expect(matchName("dune", items, names)?.name).toBe("Dune");
    expect(matchName("atlas", items, names)?.name).toBe("Dune Atlas");
    expect(matchName("du", items, names)).toBeNull();
    expect(matchName("", items, names)).toBeNull();
  });

  it("makes branch names git takes", () => {
    expect(cleanBranch("Fix the Login Timeout!")).toBe("fix-the-login-timeout");
    expect(cleanBranch("feat//New Thing..lock")).toBe("feat/new-thing");
    expect(cleanBranch("../..")).toBe("");
    expect(cleanBranch("x".repeat(90))).toHaveLength(60);
  });

  it("resolves steps to what is here and flags what isn't", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "start", engine: "Claude", workspace: "vibe forge", branch: "Blah Blah", prompt: "Do A, B and C." },
          { kind: "start", engine: "grok build", workspace: "notes", prompt: "Tidy up." },
          { kind: "start", engine: "gemini", workspace: "Dune", prompt: "Write tests for the parser" },
          { kind: "start", engine: "kimi", workspace: "Dune", prompt: "x" },
          { kind: "tell", target: "pty-4", prompt: "Also update the README." },
          { kind: "stop", target: "codex in dune" },
          { kind: "dance" },
        ],
      },
      context,
    );
    expect(steps.map((step) => [step.kind, step.engineId, step.workspaceId, step.branch, step.target])).toEqual([
      ["start", "claude", "vibeforge", "blah-blah", ""],
      ["start", "grok", "notes", "", ""],
      ["start", "", "dune", "write-tests-for-the-parser", ""],
      ["start", "kimi", "dune", "x", ""],
      ["tell", "", "", "", "pty-4"],
      ["stop", "", "", "", "pty-4"],
    ]);
    expect(steps.map((step) => stepIssue(step, context))).toEqual([null, null, "engine", "engineMissing", null, null]);
    expect(steps[2].asked).toBe("gemini · Dune");
    expect(stepIssue({ ...steps[0], prompt: " " }, context)).toBe("prompt");
    expect(stepIssue({ ...steps[4], target: "pty-9" }, context)).toBe("target");
  });
});

function gitRepo(): string {
  const dir = path.join(tempDir(), "shop");
  fs.mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  return dir;
}

/** The harness with a "grok" row that plans (its bin resolves), and a planner that answers from a list. */
function withPlanner(answers: Array<Record<string, unknown> | string>) {
  const ctx = setup();
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan" } });
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  ctx.svc.orchestrator.runner = async (argv, cwd): Promise<BrainRun> => {
    calls.push({ argv, cwd });
    const next = answers.shift() ?? { say: "", steps: [] };
    const stdout = typeof next === "string" ? next : JSON.stringify({ text: "", structuredOutput: next });
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  return { ...ctx, calls };
}

describe("the Orchestrator in the service", () => {
  it("plans, waits for Go, then starts the CLI on a new branch in its own folder", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([{ say: "Starting Argy in shop on blah.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "blah", prompt: "Do A, B and C." }] }, { say: "Nothing else to do.", steps: [] }]);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];

    await ctx.svc.orchestratorAsk("Start Argy in the shop workspace on a branch called blah and do A, B and C");
    let view = ctx.svc.orchestratorView();
    expect(view.engineReady).toBe(true);
    expect(view.thinking).toBe(false);
    expect(view.turns.map((turn) => turn.from)).toEqual(["you", "vibeforge"]);
    const plan = view.turns[1];
    expect(plan).toMatchObject({ text: "Starting Argy in shop on blah.", plan: "waiting" });
    expect(plan.steps?.[0]).toMatchObject({ engineId: "argy", workspaceId: workspace.id, branch: "blah", state: "planned" });
    expect(ctx.spawns).toHaveLength(0);
    expect(ctx.calls[0].argv.slice(0, 3)).toEqual(["/usr/bin/argy", "-p", "Start Argy in the shop workspace on a branch called blah and do A, B and C"]);
    expect(ctx.calls[0].argv.at(-2)).toBe("-s");
    expect(ctx.calls[0].cwd).toBe(path.join(ctx.dataRoot, "orchestrator", "work"));

    await ctx.svc.orchestratorRun(plan.id);
    view = ctx.svc.orchestratorView();
    const step = view.turns[1].steps?.[0];
    expect(view.turns[1].plan).toBe("done");
    expect(step?.state).toBe("done");
    const copy = path.join(path.dirname(repo), "shop.worktrees", "blah");
    expect(fs.existsSync(copy)).toBe(true);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: copy, encoding: "utf8" }).trim()).toBe("blah");
    // The workspace's own folder stays where it was.
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");
    const workspaces = ctx.svc.listWorkspaces();
    const opened = workspaces.workspaces.find((item) => item.id === step?.openedWorkspaceId);
    expect(opened).toMatchObject({ name: "shop · blah", path: copy });
    expect(workspaces.lastWorkspaceId).toBe(workspace.id);
    expect(ctx.spawns[0].cwd).toBe(copy);
    expect(ctx.spawns[0].argv.at(-1)).toBe("Do A, B and C.");
    expect(ctx.svc.listLive().find((session) => session.ptyId === step?.ptyId)).toMatchObject({ orchestrated: true, workspaceId: opened?.id, origin: "code" });

    // The next turn resumes the same session, and knows the CLI it started.
    await ctx.svc.orchestratorAsk("anything else?");
    expect(ctx.calls[1].argv.slice(-2)).toEqual(["-r", ctx.calls[0].argv.at(-1)]);
    const rules = ctx.calls[1].argv[ctx.calls[1].argv.indexOf("--rules") + 1];
    expect(rules).toContain(`- ${step?.ptyId}: Argy in shop · blah`);
    expect(rules).toContain("you started it");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.text).toBe("Nothing else to do.");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.steps).toBeUndefined();
    ctx.svc.close();
  });

  it("carries a plan out at once under Just go, and keeps one that needs a person", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([
      { say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "one", prompt: "First." }] },
      { say: "Which CLI?", steps: [{ kind: "start", engine: "nobody", workspace: "shop", prompt: "Second." }] },
    ]);
    ctx.svc.addWorkspace(repo);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go" } });
    await ctx.svc.orchestratorAsk("start argy on one");
    await until(() => ctx.svc.orchestratorView().turns[1]?.plan === "done");
    expect(ctx.spawns).toHaveLength(1);

    await ctx.svc.orchestratorAsk("and another one");
    const held = ctx.svc.orchestratorView().turns.at(-1);
    expect(held?.plan).toBe("waiting");
    // Picked on the card, then Go.
    ctx.svc.orchestratorEditStep(held?.id ?? "", held?.steps?.[0].id ?? "", { engineId: "pasty" });
    await ctx.svc.orchestratorRun(held?.id ?? "");
    expect(ctx.spawns.map((spawn) => path.basename(spawn.cwd))).toEqual(["one", "second"]);
    expect(ctx.spawns[1].argv[0]).toBe("/usr/bin/pasty");
    ctx.svc.close();
  });

  it("tells and stops running CLIs, replaces a waiting plan, and says when it can't read the answer", async () => {
    const ctx = withPlanner([]);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const running = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const answers: Array<Record<string, unknown> | string> = [
      { say: "First idea.", steps: [{ kind: "stop", target: running.ptyId }] },
      { say: "Telling it, then closing it.", steps: [{ kind: "tell", target: running.ptyId, prompt: "Wrap up." }, { kind: "stop", target: running.ptyId }] },
      "not json at all",
    ];
    ctx.svc.orchestrator.runner = async () => {
      const next = answers.shift() ?? "";
      return { code: 0, stdout: typeof next === "string" ? next : JSON.stringify({ structuredOutput: next }), stderr: "", timedOut: false };
    };
    await ctx.svc.orchestratorAsk("stop it");
    await ctx.svc.orchestratorAsk("no wait, tell it to wrap up first");
    const turns = ctx.svc.orchestratorView().turns;
    expect(turns[1].plan).toBe("replaced");
    expect(() => ctx.svc.orchestratorEditStep(turns[1].id, turns[1].steps?.[0].id ?? "", { prompt: "x" })).toThrow("That plan has already been carried out.");
    await ctx.svc.orchestratorRun(turns[3].id);
    expect(ctx.sent).toContainEqual({ ptyId: running.ptyId, text: "Wrap up." });
    expect(ctx.killed).toContain(running.ptyId);
    await until(() => ctx.ended.length === 1);

    await ctx.svc.orchestratorAsk("hello?");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ problem: "unreadable", detail: "not json at all" });

    ctx.svc.orchestratorClear();
    expect(ctx.svc.orchestratorView().turns).toEqual([]);
    ctx.svc.close();
  });

  it("says so when the planning CLI isn't one that can plan or isn't installed", async () => {
    const ctx = setup();
    ctx.svc.saveSettings({ orchestrator: { engine: "argy", mode: "plan" } });
    expect(ctx.svc.orchestratorView().engineReady).toBe(false);
    await ctx.svc.orchestratorAsk("hi");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ from: "vibeforge", problem: "noEngine" });
    ctx.svc.close();
  });

  it("keeps the conversation across a restart", async () => {
    const ctx = withPlanner([{ say: "Hello.", steps: [] }]);
    await ctx.svc.orchestratorAsk("hi");
    ctx.svc.close();
    const again = setup({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot });
    expect(again.svc.orchestratorView().turns.map((turn) => turn.text)).toEqual(["hi", "Hello."]);
    again.svc.close();
  });
});
