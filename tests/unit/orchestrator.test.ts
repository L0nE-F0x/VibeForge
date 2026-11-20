import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brainArgs, canOrchestrate, cleanBranch, emptyPromise, lookingLine, matchName, orchestratorRules, plannedId, plannerFor, readBrainOutput, readsAll, resolvePlan, routineAction, sessionGone, showView, signedOut, stepIssue, withPlannedWorkspaces, type PlanContext, type VibyWord } from "../../src/core/orchestrator.js";
import { agyModels, grokModels, plannerEnv, spawnBrain, type BrainRun } from "../../src/core/service/orchestrator.js";
import type { EngineRow } from "../../src/core/types.js";
import { setup, started, tempDir, until } from "./fixtures/service-harness.js";

const grok: EngineRow = { id: "grok", label: "Grok Build", bin: "grok", args: [] };
const claude: EngineRow = { id: "claude", label: "Claude Code", bin: "claude", args: [] };
const codex: EngineRow = { id: "codex", label: "Codex", bin: "codex", args: [] };
const agy: EngineRow = { id: "agy", label: "Antigravity CLI", bin: "agy", args: [] };
const kimi: EngineRow = { id: "kimi", label: "Kimi", bin: "kimi", args: [] };

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
    expect(canOrchestrate(codex)).toBe(true);
    expect(canOrchestrate(agy)).toBe(true);
    expect(canOrchestrate(kimi)).toBe(false);
    expect(brainArgs(kimi, { text: "hi", rules: "r", sessionId: "s", resume: false })).toBeNull();

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

  it("plans with Codex and Antigravity too, read-only, resuming the session each reported", () => {
    const first = brainArgs(codex, { text: "-start grok", rules: 'say "hi"', sessionId: "", resume: false, schemaFile: "/w/plan.json", model: "gpt-x" }) ?? [];
    expect(first[0]).toBe("exec");
    expect(first).toContain('sandbox_mode="read-only"');
    expect(first).toContain(`developer_instructions=${JSON.stringify('say "hi"')}`);
    expect(first.slice(first.indexOf("--output-schema"), first.indexOf("--output-schema") + 2)).toEqual(["--output-schema", "/w/plan.json"]);
    expect(first.slice(-4)).toEqual(["-m", "gpt-x", "--", "-start grok"]);
    const again = brainArgs(codex, { text: "and then", rules: "r", sessionId: "thread-1", resume: true, schemaFile: "/w/plan.json" }) ?? [];
    expect(again.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(again.slice(-3)).toEqual(["--", "thread-1", "and then"]);
    expect(brainArgs(codex, { text: "x", rules: "r", sessionId: "", resume: false })).toBeNull();

    const asked = brainArgs(agy, { text: "Start Grok in Dune", rules: "RULES", sessionId: "", resume: false }) ?? [];
    expect(asked.slice(0, 2)).toEqual(["-p", "RULES\n\nThe person said:\nStart Grok in Dune"]);
    expect(asked).toContain("plan");
    expect(asked).not.toContain("--conversation");
    expect(JSON.parse(asked[asked.indexOf("--json-schema") + 1]).properties.steps.items.required).toEqual([
      "kind",
      "engine",
      "workspace",
      "branch",
      "prompt",
      "target",
      "folder",
      "git",
      "model",
      "effort",
      "inPlace",
      "after",
      "action",
      "name",
      "description",
      "schedule",
      "agent",
      "task",
      "status",
      "places",
      "skills",
      "agents",
      "options",
    ]);
    expect(brainArgs(agy, { text: "x", rules: "r", sessionId: "conv-1", resume: true, model: "gemini-3.8-flash-low" })?.slice(-4)).toEqual(["--model", "gemini-3.8-flash-low", "--conversation", "conv-1"]);
    expect(brainArgs(grok, { text: "x", rules: "r", sessionId: "s", resume: false, model: "grok-4.6" })).toContain("grok-4.6");
    expect(brainArgs(claude, { text: "x", rules: "r", sessionId: "s", resume: false, model: "haiku" })?.slice(-6, -4)).toEqual(["--model", "haiku"]);
  });

  it("reads Antigravity's answer and Codex's lines, and knows a planner that isn't signed in", () => {
    // Antigravity CLI, 2026-11-07.
    const fromAgy = JSON.stringify({
      conversation_id: "270c9b69",
      status: "SUCCESS",
      response: '{"say":"Starting Grok in Dune.","steps":[]}',
      structured_output: { say: "Starting Grok in Dune.", steps: [{ branch: "", engine: "grok", kind: "start", prompt: "", target: "", workspace: "Dune" }] },
    });
    expect(readBrainOutput(fromAgy)).toMatchObject({ sessionId: "270c9b69", plan: { say: "Starting Grok in Dune.", steps: [{ kind: "start", engine: "grok", workspace: "Dune", branch: "" }] } });
    const fromCodex = [
      '{"type":"thread.started","thread_id":"01a1b20d"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"say\\":\\"Which workspace?\\",\\"steps\\":[]}"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(readBrainOutput(fromCodex)).toMatchObject({ sessionId: "01a1b20d", plan: { say: "Which workspace?", steps: [] }, error: "" });
    // Codex, not logged in (2026-11-07).
    const refused = ['{"type":"thread.started","thread_id":"t2"}', '{"type":"turn.started"}', '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}'].join("\n");
    const out = readBrainOutput(refused);
    expect(out.plan).toBeNull();
    expect(signedOut(out.error)).toBe(true);
    expect(signedOut("Invalid API key · Please run /login")).toBe(true);
    expect(signedOut("rate limited, try again")).toBe(false);
    expect(readBrainOutput(JSON.stringify({ session_id: "c1", structured_output: { say: "Hi.", steps: [] } })).sessionId).toBe("c1");
  });

  it("plans with the CLI picked while it's here, else Grok Build, else the first one that can", () => {
    const here = (ids: string[]) => [grok, claude, codex, kimi].map((row) => ({ ...row, available: ids.includes(row.id) }));
    // Only Claude Code installed: it plans, whatever was left in Settings from before.
    expect(plannerFor("", here(["claude", "kimi"]))).toBe("claude");
    expect(plannerFor("grok", here(["claude"]))).toBe("claude");
    expect(plannerFor("codex", here(["grok", "claude", "codex"]))).toBe("codex");
    expect(plannerFor("", here(["claude", "grok"]))).toBe("grok");
    expect(plannerFor("kimi", here(["kimi"]))).toBe("");
    expect(plannerFor("", here([]))).toBe("");
  });

  it("lists the models Grok Build and Antigravity print", () => {
    expect(grokModels("You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n")).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
    expect(agyModels("Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n")).toEqual(["gemini-4-argon-medium", "claude-sonnet-5-5-low"]);
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
    expect(readBrainOutput(fromGrok).plan).toEqual({
      say: "Starting Claude Code in Dune.",
      steps: [{ kind: "start", engine: "claude", workspace: "Dune", branch: undefined, prompt: undefined, target: undefined, folder: undefined, git: false, model: undefined, effort: undefined, inPlace: false, after: false }],
    });
    const fromClaude = JSON.stringify({ type: "result", result: "ok", structured_output: { say: "Which workspace?", steps: [] } });
    expect(readBrainOutput(fromClaude).plan).toEqual({ say: "Which workspace?", steps: [] });
    expect(readBrainOutput('Here you go: {"say":"Hi.","steps":[]} done').plan?.say).toBe("Hi.");
    expect(readBrainOutput("I can't help with that.").plan).toBeNull();
    expect(readBrainOutput(JSON.stringify({ text: "Sorry, no." })).text).toBe("Sorry, no.");

    // Plans over 20 steps are trimmed to 20 with a note in say.
    const many = Array.from({ length: 25 }, (_, i) => ({ kind: "show", target: `t${i}` }));
    const trimmed = readBrainOutput(JSON.stringify({ structured_output: { say: "All of them.", steps: many } })).plan;
    expect(trimmed?.steps).toHaveLength(20);
    expect(trimmed?.say).toContain("All of them.");
    expect(trimmed?.say).toContain("20");
    const trimmedQuiet = readBrainOutput(JSON.stringify({ structured_output: { say: "", steps: many } })).plan;
    expect(trimmedQuiet?.steps).toHaveLength(20);
    expect(trimmedQuiet?.say).toContain("20");
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
    // A CLI can be opened with nothing to do yet; a message can't be empty.
    expect(stepIssue({ ...steps[0], prompt: " " }, context)).toBeNull();
    expect(stepIssue({ ...steps[4], prompt: " " }, context)).toBe("prompt");
    expect(stepIssue({ ...steps[4], target: "pty-9" }, context)).toBe("target");
  });

  it("resolves task, lookup, agent-place, defaultEngine and malformed JSON cases", () => {
    const rich: PlanContext = {
      ...context,
      defaultEngine: "claude",
      agents: [{ id: "agent-1", name: "Atlas", engine: "claude", goodAt: "tests", places: [context.workspaces[0].folder] }],
      tasks: [{ id: "task-1", title: "Existing Task", status: "todo", workspace: context.workspaces[0].name }],
      routines: [{ id: "routine-1", name: "Nightly", agent: "Atlas", enabled: true, schedule: "0 2 * * *" }],
    };
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "start", engine: "Atlas", prompt: "Work in Atlas place." },
          { kind: "start", workspace: "vibeforge", prompt: "Use default CLI." },
          { kind: "task", target: "Existing Task" },
          { kind: "task", engine: "Atlas", workspace: "vibeforge", branch: "Fix OAuth", prompt: "Fix login." },
          { kind: "task", engine: "Atlas", workspace: "vibeforge", prompt: "Refactor routes" },
          { kind: "lookup", prompt: " " },
          { kind: "routine", target: "nonexistent" },
        ],
      },
      rich,
    );
    expect(steps[0]).toMatchObject({ kind: "start", workspaceId: context.workspaces[0].id, engineId: "claude", agentId: "agent-1" });
    expect(steps[1]).toMatchObject({ kind: "start", workspaceId: "vibeforge", engineId: "claude" });
    expect(steps[2]).toMatchObject({ kind: "task", target: "task-1", asked: "Existing Task" });
    expect(steps[3]).toMatchObject({ kind: "task", workspaceId: "vibeforge", agentId: "agent-1", name: "Fix OAuth", prompt: "Fix login." });
    expect(steps[4]).toMatchObject({ kind: "task", name: "refactor routes" });

    expect(stepIssue(steps[2], rich)).toBeNull();
    expect(stepIssue({ ...steps[2], target: "missing-task" }, rich)).toBe("target");
    expect(stepIssue(steps[3], rich)).toBeNull();
    expect(stepIssue({ ...steps[3], workspaceId: "missing" }, rich)).toBe("workspace");
    expect(stepIssue({ ...steps[3], agentId: "" }, rich)).toBe("engine");
    expect(stepIssue({ ...steps[3], prompt: " " }, rich)).toBe("prompt");
    expect(stepIssue(steps[5], rich)).toBe("prompt");
    expect(stepIssue(steps[6], rich)).toBe("target");

    expect(orchestratorRules(rich)).toContain("Existing Task");
    expect(readBrainOutput("Sorry {not: valid json}").plan).toBeNull();
  });
});

/** Whether a process is still there; a zombie waiting for init counts as gone soon after. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls for up to ten seconds, for a real process that is slow to start or to be reaped on a busy machine. */
async function eventually(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 10_000; !check() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

describe("the planning CLI's process", () => {
  /** A stand-in planner that ignores SIGTERM and starts a child that does too, then hangs. */
  function stubborn(): { bin: string; pidFile: string } {
    const dir = tempDir();
    const bin = path.join(dir, "stubborn");
    const pidFile = path.join(dir, "child.pid");
    fs.writeFileSync(bin, `#!/bin/bash\ntrap '' TERM\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
    return { bin, pidFile };
  }

  it("kills the whole group when a planner ignores SIGTERM past its timeout", async () => {
    const { bin, pidFile } = stubborn();
    const started = Date.now();
    const turn = spawnBrain([bin], path.dirname(bin), new AbortController().signal, 300, 200);
    await eventually(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    const run = await turn;
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    await eventually(() => !alive(child));
  });

  it("ends a turn that is stopped, even when the planner won't go quietly", async () => {
    const { bin, pidFile } = stubborn();
    const controller = new AbortController();
    const turn = spawnBrain([bin], path.dirname(bin), controller.signal, 60_000, 200);
    await eventually(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    const run = await turn;
    expect(run.timedOut).toBe(false);
    await eventually(() => !alive(child));
  });

  it("runs a planner without VibeForge's debug port or Electron's variables", () => {
    const env = plannerEnv({ PATH: "/usr/bin", HOME: "/home/x", VIBEFORGE_DEBUG: "1", VIBEFORGE_DEBUG_PORT: "9223", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", NO_COLOR: "1" });
  });

  it("reads what a planner prints, and a missing one as code 127", async () => {
    const dir = tempDir();
    const bin = path.join(dir, "says");
    fs.writeFileSync(bin, '#!/bin/bash\necho "{\\"say\\":\\"hi\\"}"\necho oops >&2\n', { mode: 0o755 });
    expect(await spawnBrain([bin], dir, new AbortController().signal)).toMatchObject({ code: 0, stdout: '{"say":"hi"}\n', stderr: "oops\n", timedOut: false });
    expect((await spawnBrain([path.join(dir, "nothing-here")], dir, new AbortController().signal)).code).toBe(127);

    // Runaway planner stdout is capped at a few MB.
    const flood = path.join(dir, "flood");
    fs.writeFileSync(flood, "#!/bin/bash\nhead -c 5000000 /dev/zero | tr '\\0' x\n", { mode: 0o755 });
    const capped = await spawnBrain([flood], dir, new AbortController().signal);
    expect(capped.code).toBe(0);
    expect(capped.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(capped.stdout.length).toBeGreaterThan(0);
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
function withPlanner(answers: Array<Record<string, unknown> | string>, opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: "" } });
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  ctx.svc.orchestrator.runner = async (argv, cwd): Promise<BrainRun> => {
    calls.push({ argv, cwd });
    const next = answers.shift() ?? { say: "", steps: [] };
    const stdout = typeof next === "string" ? next : JSON.stringify({ text: "", structuredOutput: next });
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  return { ...ctx, calls };
}

/** A repository with one committed file, and the shell git commands for it and its copies. */
function repoWithFile(): { repo: string; git: (cwd: string, ...args: string[]) => string } {
  const repo = gitRepo();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "a");
  return { repo, git };
}

/** Plan one start step on `branch` in the shop workspace, Go, and hand back the step and its copy. */
async function startInCopy(ctx: ReturnType<typeof withPlanner>, branch: string) {
  await ctx.svc.orchestratorAsk(`start argy on ${branch}`);
  const turn = ctx.svc.orchestratorView().turns.at(-1);
  await ctx.svc.orchestratorRun(turn?.id ?? "");
  const view = ctx.svc.orchestratorView();
  const step = view.turns.find((item) => item.id === turn?.id)?.steps?.[0];
  const copy = view.copies?.find((item) => item.id === step?.copyId);
  if (!step || !copy) throw new Error("no copy");
  return { step, copy };
}

describe("the Orchestrator in the service", () => {
  it("plans, waits for Go, then starts the CLI on a new branch in its own copy", async () => {
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
    // A copy the way a task gets one: in VibeForge's worktrees folder, on a vibeforge/ branch.
    const copy = path.join(ctx.dataRoot, "worktrees", "blah");
    expect(fs.existsSync(copy)).toBe(true);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: copy, encoding: "utf8" }).trim()).toBe("vibeforge/blah");
    expect(step).toMatchObject({ branch: "vibeforge/blah", copyId: "blah" });
    expect(view.copies).toEqual([expect.objectContaining({ id: "blah", name: "blah", stepId: step?.id, workspaceId: workspace.id, openedWorkspaceId: step?.openedWorkspaceId, path: copy, branch: "vibeforge/blah" })]);
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

  it("brings a step's work back for review: its diff, then Apply into the workspace, which tidies the copy away", async () => {
    const { repo, git } = repoWithFile();
    const plan = (branch: string) => ({ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch, prompt: "Change a." }] });
    const ctx = withPlanner([plan("fix-a"), plan("fix-a")]);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const { step, copy } = await startInCopy(ctx, "fix-a");
    // The CLI works in its copy: one commit and an edit not committed yet, and a new file.
    fs.writeFileSync(path.join(copy.path, "a.txt"), "one\nTWO\n");
    git(copy.path, "commit", "-qam", "two");
    fs.appendFileSync(path.join(copy.path, "a.txt"), "three\n");
    fs.writeFileSync(path.join(copy.path, "b.txt"), "new\n");
    const diff = await ctx.svc.orchestratorCopyDiff(copy.id);
    expect(diff).toContain("+TWO");
    expect(diff).toContain("+three");
    expect(diff).toContain("b/b.txt");
    // Nothing reaches the workspace until Apply.
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");

    // A second step asking for the same branch gets its own name; the first copy's branch is left alone.
    const second = await startInCopy(ctx, "fix-a");
    expect(second.copy).toMatchObject({ id: "fix-a-2", branch: "vibeforge/fix-a-2" });
    expect(git(repo, "rev-parse", "vibeforge/fix-a").trim()).not.toBe(git(repo, "rev-parse", "HEAD").trim());

    const result = await ctx.svc.orchestratorApplyCopy(copy.id);
    expect(result).toMatchObject({ files: ["a.txt", "b.txt"], conflicts: [] });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("new\n");
    // As uncommitted edits: the workspace's branch hasn't moved.
    expect(git(repo, "log", "--format=%s").trim().split("\n")[0]).toBe("a");
    // Its CLI ended first; its copy, branch and workspace are gone, and the step says so.
    expect(ctx.killed).toContain(step.ptyId);
    expect(fs.existsSync(copy.path)).toBe(false);
    expect(git(repo, "branch", "--list", "vibeforge/fix-a").trim()).toBe("");
    expect(ctx.svc.listWorkspaces().workspaces.map((item) => item.id)).toEqual([workspace.id, second.copy.openedWorkspaceId]);
    const view = ctx.svc.orchestratorView();
    expect(view.copies?.map((item) => item.id)).toEqual(["fix-a-2"]);
    expect(view.turns.flatMap((turn) => turn.steps ?? []).find((item) => item.id === step.id)?.outcome).toBe("applied");
    await expect(ctx.svc.orchestratorApplyCopy(copy.id)).rejects.toThrow("That copy is gone.");
    ctx.svc.close();
  });

  it("discards a copy with its workspace, puts both back on Undo, and drops the branch once Undo has passed", async () => {
    const { repo, git } = repoWithFile();
    const ctx = withPlanner([{ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "try-it", prompt: "Try it." }] }]);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const { step, copy } = await startInCopy(ctx, "try-it");
    fs.writeFileSync(path.join(copy.path, "a.txt"), "changed\n");
    ctx.svc.saveLayout(copy.openedWorkspaceId ?? "", { kind: "pane", id: "p1", launch: { type: "shell" } });

    const deleted = await ctx.svc.orchestratorDiscardCopy(copy.id);
    expect(deleted.copyLeft).toBeUndefined();
    expect(ctx.killed).toContain(step.ptyId);
    expect(fs.existsSync(copy.path)).toBe(false);
    expect(ctx.svc.listWorkspaces().workspaces.map((item) => item.id)).toEqual([workspace.id]);
    expect(ctx.svc.orchestratorView().copies).toEqual([]);
    expect(ctx.svc.orchestratorView().turns[1].steps?.[0].outcome).toBe("discarded");
    // The workspace never saw any of it.
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");

    ctx.svc.undoDelete(deleted.undo);
    expect(fs.readFileSync(path.join(copy.path, "a.txt"), "utf8")).toBe("changed\n");
    expect(ctx.svc.listWorkspaces().workspaces.find((item) => item.id === copy.openedWorkspaceId)).toMatchObject({ name: "shop · try-it", path: copy.path });
    expect(ctx.svc.getLayout(copy.openedWorkspaceId ?? "")).toMatchObject({ id: "p1" });
    expect(ctx.svc.orchestratorView().copies?.map((item) => item.id)).toEqual(["try-it"]);
    expect(ctx.svc.orchestratorView().turns[1].steps?.[0].outcome).toBeNull();
    expect(await ctx.svc.orchestratorCopyDiff(copy.id)).toContain("+changed");

    // Discarded again; closing ends the chance to undo, and the branch goes with it.
    await ctx.svc.orchestratorDiscardCopy(copy.id);
    expect(git(repo, "branch", "--list", "vibeforge/try-it").trim()).not.toBe("");
    ctx.svc.close();
    for (let tries = 0; tries < 150 && git(repo, "branch", "--list", "vibeforge/try-it").trim(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(git(repo, "branch", "--list", "vibeforge/try-it").trim()).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("try-it");
  });

  it("keeps a copy that conflicts, keeps copies through a new conversation, and never touches a folder that isn't its own", async () => {
    const { repo, git } = repoWithFile();
    const ctx = withPlanner([{ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "clash", prompt: "Change a." }] }]);
    ctx.svc.addWorkspace(repo);
    const { copy } = await startInCopy(ctx, "clash");
    fs.writeFileSync(path.join(copy.path, "a.txt"), "one\nfrom the copy\n");
    // The workspace moved on underneath, on the same line.
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nfrom the workspace\n");
    git(repo, "commit", "-qam", "meanwhile");
    const result = await ctx.svc.orchestratorApplyCopy(copy.id);
    expect(result.conflicts).toEqual(["a.txt"]);
    expect(fs.existsSync(copy.path)).toBe(true);
    expect(ctx.svc.orchestratorView().copies?.map((item) => item.id)).toEqual(["clash"]);

    // New: the conversation starts over, the copy still waits.
    ctx.svc.orchestratorClear();
    expect(ctx.svc.orchestratorView()).toMatchObject({ turns: [], copies: [expect.objectContaining({ id: "clash" })] });
    ctx.svc.close();

    // A list edited by hand to point somewhere else: Apply refuses, Discard only forgets it.
    const elsewhere = tempDir();
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "mine\n");
    const file = path.join(ctx.dataRoot, "orchestrator", "copies.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { copies: Array<Record<string, unknown>> };
    saved.copies[0].path = elsewhere;
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = setup({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot });
    await expect(again.svc.orchestratorApplyCopy("clash")).rejects.toThrow("This copy is not in VibeForge's worktrees folder, so it was left alone.");
    await expect(again.svc.orchestratorCopyDiff("clash")).rejects.toThrow();
    expect((await again.svc.orchestratorDiscardCopy("clash")).copyLeft).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("mine\n");
    expect(again.svc.orchestratorView().copies).toEqual([]);
    again.svc.close();
  });

  it("carries a plan out at once under Just go, and keeps one that needs a person", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([
      { say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "one", prompt: "First." }] },
      { say: "Which CLI?", steps: [{ kind: "start", engine: "nobody", workspace: "shop", prompt: "Second." }] },
      { say: "Clearing it out.", steps: [{ kind: "shell", workspace: "shop", prompt: "rm -rf build" }] },
      { say: "Stopping it.", steps: [{ kind: "key", target: "argy", prompt: "ctrl+c" }] },
    ]);
    ctx.svc.addWorkspace(repo);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go", model: "", projectsFolder: "" } });
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

    // Just go still asks before a command that deletes, and before Ctrl+C (a stop by another name).
    await ctx.svc.orchestratorAsk("delete the build folder");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.plan).toBe("waiting");
    await ctx.svc.orchestratorAsk("interrupt argy");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.plan).toBe("waiting");
    ctx.svc.close();
  });

  it("skips a step chained after one that didn't carry out", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([]);
    const shop = ctx.svc.addWorkspace(repo).workspaces.find((item) => item.path === repo)!;
    const other = ctx.svc.addWorkspace(ctx.place).workspaces.find((item) => item.path === ctx.place)!;
    ctx.svc.orchestrator.runner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        structuredOutput: {
          say: "Fixing it, then checking.",
          steps: [
            { kind: "start", engine: "argy", workspace: shop.name, prompt: "Fix it." },
            { kind: "shell", workspace: other.name, prompt: "git status", after: true },
          ],
        },
      }),
      stderr: "",
      timedOut: false,
    });
    await ctx.svc.orchestratorAsk("fix it and then check");
    const turn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(turn.plan).toBe("waiting");
    // The first step can't happen any more: the second, which depends on it, mustn't happen either.
    await ctx.svc.removeWorkspace(shop.id);
    await ctx.svc.orchestratorRun(turn.id);
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.steps?.map((step) => step.state)).toEqual(["skipped", "skipped"]);
    expect(ctx.spawns).toHaveLength(0);
    ctx.svc.close();
  });

  it("tells and stops running CLIs, replaces a waiting plan, and says when it can't read the answer", async () => {
    let at = Date.now();
    const ctx = withPlanner([], { now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const running = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    // Past the moment a CLI that just started is left to draw its first screen.
    at += 6000;
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
    // A message like any other, labelled, through the queue.
    expect(ctx.sent).toContainEqual({ ptyId: running.ptyId, text: "Wrap up." });
    expect(ctx.killed).toContain(running.ptyId);
    await until(() => ctx.ended.length === 1);

    await ctx.svc.orchestratorAsk("hello?");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ problem: "unreadable", detail: "not json at all" });

    ctx.svc.orchestratorClear();
    expect(ctx.svc.orchestratorView().turns).toEqual([]);
    ctx.svc.close();
  });

  it("tells a CLI only once it is free, never after Stop, and never into a shell whose CLI has quit", async () => {
    let at = Date.now();
    const ctx = withPlanner([], { now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const run = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const shell = await ctx.svc.startShell({ workspaceId: workspace.id });
    ctx.svc.onPtyProgram(shell.ptyId, ["pasty"], ctx.place);
    at += 6000;
    const plans: Array<Record<string, unknown>> = [];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: plans.shift() }), stderr: "", timedOut: false });
    const tell = async (target: string, prompt: string) => {
      plans.push({ say: "Telling it.", steps: [{ kind: "tell", target, prompt }] });
      await ctx.svc.orchestratorAsk("tell it");
      const turn = ctx.svc.orchestratorView().turns.at(-1);
      await ctx.svc.orchestratorRun(turn?.id ?? "");
      return ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id)?.steps?.[0];
    };

    // Busy: it waits in the queue, and goes in once the CLI has been quiet a moment.
    ctx.svc.onPtyActivity(run.ptyId, true);
    expect(await tell(run.ptyId, "Add tests.")).toMatchObject({ state: "done" });
    expect(ctx.sent).toEqual([]);
    ctx.svc.onPtyActivity(run.ptyId, false);
    at += 4000;
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toEqual([{ ptyId: run.ptyId, text: "Add tests." }]);

    // A person's words through Maestro aren't CLIs talking to each other: that setting doesn't hold them.
    const settings = ctx.svc.store.readSettings();
    ctx.svc.store.writeSettings({ ...settings, agentTalk: { ...settings.agentTalk, on: false } });
    expect(await tell(run.ptyId, "Then lint.")).toMatchObject({ state: "done" });
    at += 4000;
    await ctx.svc.pumpMessages();
    expect(ctx.sent.at(-1)).toEqual({ ptyId: run.ptyId, text: "Then lint." });
    ctx.svc.store.writeSettings(settings);

    // Stop on that terminal holds Maestro's messages too, until a person types there.
    ctx.svc.stopTalk(run.ptyId);
    at += 4000;
    expect(await tell(run.ptyId, "And docs.")).toMatchObject({ state: "failed", error: expect.stringContaining("A person stopped the conversation") });

    // The shell's CLI quits while the message waits for it: nothing is typed at the bare prompt.
    ctx.svc.onPtyActivity(shell.ptyId, true);
    expect(await tell(shell.ptyId, "rm -rf build")).toMatchObject({ state: "done" });
    ctx.svc.onPtyProgram(shell.ptyId, null, ctx.place);
    ctx.svc.onPtyActivity(shell.ptyId, false);
    at += 4000;
    await ctx.svc.pumpMessages();
    expect(ctx.sent.filter((item) => item.ptyId === shell.ptyId)).toEqual([]);
    // And one planned while it ran is checked again at Go.
    expect(await tell(shell.ptyId, "ls")).toMatchObject({ state: "skipped" });
    expect(ctx.sent.filter((item) => item.ptyId === shell.ptyId)).toEqual([]);
    ctx.svc.close();
  });

  it("resumes the session a planner names itself, says when it isn't signed in, and lists models", async () => {
    const ctx = setup();
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "codex", label: "Codex", bin: "argy", args: [] }, { id: "claude", label: "Claude Code", bin: "pasty", args: [] });
    fs.writeFileSync(file, JSON.stringify(engines));
    ctx.svc.saveSettings({ orchestrator: { engine: "codex", mode: "plan", model: "gpt-x", projectsFolder: "" } });
    const calls: string[][] = [];
    const lines = (thread: string, say: string) => [`{"type":"thread.started","thread_id":"${thread}"}`, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ say, steps: [] }) } })].join("\n");
    const answers = [
      { code: 0, stdout: lines("thread-9", "Hello."), stderr: "", timedOut: false },
      { code: 0, stdout: lines("thread-9", "Still here."), stderr: "", timedOut: false },
      { code: 1, stdout: '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}', stderr: "", timedOut: false },
    ];
    ctx.svc.orchestrator.runner = async (argv) => {
      calls.push(argv);
      return answers.shift() ?? { code: 1, stdout: "", stderr: "", timedOut: false };
    };
    await ctx.svc.orchestratorAsk("hi");
    await ctx.svc.orchestratorAsk("still there?");
    expect(calls[0].slice(1, 3)).toEqual(["exec", "--json"]);
    expect(calls[0]).toContain("gpt-x");
    const schemaFile = calls[0][calls[0].indexOf("--output-schema") + 1];
    expect(JSON.parse(fs.readFileSync(schemaFile, "utf8")).required).toEqual(["say", "steps", "hangup"]);
    expect(calls[1].slice(1, 3)).toEqual(["exec", "resume"]);
    expect(calls[1].slice(-3)).toEqual(["--", "thread-9", "still there?"]);
    expect(ctx.svc.orchestratorView().turns.map((turn) => turn.text)).toEqual(["hi", "Hello.", "still there?", "Still here."]);
    await ctx.svc.orchestratorAsk("and now?");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ problem: "signIn", detail: "unexpected status 401 Unauthorized" });
    expect(await ctx.svc.orchestratorModels("claude")).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(await ctx.svc.orchestratorModels("codex")).toEqual([]);
    expect(await ctx.svc.orchestratorModels("argy")).toEqual([]);
    ctx.svc.close();
  });

  it("says so when the planning CLI isn't one that can plan or isn't installed", async () => {
    const ctx = setup();
    ctx.svc.saveSettings({ orchestrator: { engine: "argy", mode: "plan", model: "", projectsFolder: "" } });
    expect(ctx.svc.orchestratorView().engineReady).toBe(false);
    await ctx.svc.orchestratorAsk("hi");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ from: "vibeforge", problem: "noEngine" });
    ctx.svc.close();
  });

  it("plans with Claude Code on a machine that only has Claude Code, until another is picked", async () => {
    const ctx = setup();
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "grok", label: "Grok Build", bin: "grok", args: [] }, { id: "claude", label: "Claude Code", bin: "pasty", args: [] });
    fs.writeFileSync(file, JSON.stringify(engines));
    expect(ctx.svc.getSettings().orchestrator.engine).toBe("");
    expect(ctx.svc.orchestratorView()).toMatchObject({ engineId: "claude", engineReady: true });
    const calls: string[][] = [];
    ctx.svc.orchestrator.runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify({ structured_output: { say: "Hello.", steps: [] } }), stderr: "", timedOut: false };
    };
    // A model left over for a planner that isn't here isn't handed to this one.
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "grok-4.7", projectsFolder: "" } });
    await ctx.svc.orchestratorAsk("hi");
    expect(calls[0][0]).toBe("/usr/bin/pasty");
    expect(calls[0]).toContain("--print");
    expect(calls[0]).not.toContain("grok-4.7");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ by: "claude", text: "Hello." });
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

describe("Maestro's plans, 2.16", () => {
  const founder: PlanContext = {
    workspaces: ["VibeForge", "Kardashev Project", "WoW Addons", "MegaJamTest", "Bunker Busters", "Filthy Net Deck", "SingularityCity", "Stones-to-Stars", "call-papa", "Multiverse Radio", "Holo Card 3D", "UrbanScan", "Cephandrius", "Barber", "apexforge-site", "The Little Naga", "OmaAmp", "Temple Lodge - Accounting", "Black Ink"].map((name) => ({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      folder: `~/Projects/${name}`,
      git: true,
    })),
    engines: [
      ["claude", "Claude Code"],
      ["codex", "Codex"],
      ["grok", "Grok Build"],
      ["cursor-agent", "Cursor Agent"],
      ["agy", "Antigravity CLI"],
      ["opencode", "OpenCode"],
      ["copilot", "Copilot"],
      ["kimi", "Kimi"],
      ["muse", "Muse"],
      ["crush", "Crush"],
      ["pi", "Pi"],
      ["hermes", "Hermes"],
    ].map(([id, label]) => ({ id, label, available: true, bin: id })),
    running: [],
    copies: [{ id: "fix-tray", name: "fix-tray", branch: "vibeforge/fix-tray", workspace: "VibeForge" }],
    projectsFolder: "~/Projects",
  };
  const engineOf = (asked: string) => matchName(asked, founder.engines, (item) => [item.id, item.label], true)?.id ?? null;
  const workspaceOf = (asked: string) => matchName(asked, founder.workspaces, (item) => [item.name], true)?.name ?? null;

  it("finds the founder's CLIs and workspaces the way they're said, and Pi only whole", () => {
    expect(engineOf("GitHub Copilot")).toBe("copilot");
    expect(engineOf("Copilot CLI")).toBe("copilot");
    expect(engineOf("Claude")).toBe("claude");
    expect(engineOf("Antigravity")).toBe("agy");
    expect(engineOf("Open Code")).toBe("opencode");
    expect(engineOf("Cursor")).toBe("cursor-agent");
    expect(engineOf("the Pi agent")).toBe("pi");
    expect(engineOf("Kimi Code")).toBe("kimi");
    expect(engineOf("Gemini")).toBeNull();
    expect(engineOf("pi")).toBe("pi");
    for (const [asked, name] of [
      ["vibe forge", "VibeForge"],
      ["Kardashev", "Kardashev Project"],
      ["little naga", "The Little Naga"],
      ["Temple Lodge", "Temple Lodge - Accounting"],
      ["Wow add-ons", "WoW Addons"],
      ["mega jam test", "MegaJamTest"],
      ["stones to stars", "Stones-to-Stars"],
      ["Call Papa", "call-papa"],
      ["urban scan", "UrbanScan"],
      ["Black ink project", "Black Ink"],
    ]) {
      expect(workspaceOf(asked)).toBe(name);
    }
  });

  it("plans a new workspace, puts it where new ones go, and lets the steps after it work there in place", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "workspace", workspace: "Star Ledger", git: true },
          { kind: "start", engine: "claude", workspace: "star ledger", prompt: "Set up a Vite app.", effort: "High", model: "opus" },
          { kind: "workspace", workspace: "Notes Two", folder: "~/Documents/notes-two" },
        ],
      },
      founder,
    );
    expect(steps[0]).toMatchObject({ kind: "workspace", name: "Star Ledger", folder: "~/Projects/Star Ledger", git: true });
    // A fresh folder has nothing committed to copy: it works there.
    expect(steps[1]).toMatchObject({ kind: "start", engineId: "claude", workspaceId: plannedId(steps[0].id), branch: "", effort: "high", model: "opus" });
    expect(steps[2]).toMatchObject({ folder: "~/Documents/notes-two", git: false });
    const checked = withPlannedWorkspaces(founder, steps);
    expect(steps.map((step) => stepIssue(step, checked))).toEqual([null, null, null]);
    // Once its workspace step is left out, the start has nowhere to go.
    expect(stepIssue(steps[1], withPlannedWorkspaces(founder, steps.slice(1)))).toBe("workspace");
    expect(stepIssue({ ...steps[0], name: "../x" }, founder)).toBe("folder");
    expect(stepIssue({ ...steps[0], folder: "relative/path" }, founder)).toBe("folder");
    expect(stepIssue({ ...steps[1], effort: "ultra" }, checked)).toBe("effort");
  });

  it("opens a CLI in the workspace itself when asked, or when there's nothing for it to do yet", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "start", engine: "claude", workspace: "VibeForge" },
          { kind: "start", engine: "grok", workspace: "VibeForge", prompt: "Fix the tray.", inPlace: true },
          { kind: "start", engine: "codex", workspace: "VibeForge", prompt: "Fix the tray." },
        ],
      },
      founder,
    );
    expect(steps.map((step) => step.branch)).toEqual(["", "", "fix-the-tray"]);
    expect(stepIssue(steps[0], founder)).toBeNull();
  });

  it("names copies for apply and discard, and running CLIs for show", () => {
    const context = { ...founder, running: [{ id: "pty-7", engine: "Claude Code", workspace: "VibeForge", folder: "~/Projects/VibeForge", working: false, orchestrated: true }] };
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "apply", target: "fix tray" },
          { kind: "discard", target: "nothing like it" },
          { kind: "show", target: "Claude Code in VibeForge" },
        ],
      },
      context,
    );
    expect(steps.map((step) => [step.kind, step.target])).toEqual([
      ["apply", "fix-tray"],
      ["discard", ""],
      ["show", "pty-7"],
    ]);
    expect(steps.map((step) => stepIssue(step, context))).toEqual([null, "copy", null]);
  });

  it("tells the planner what each CLI takes, what is waiting for review, and where new workspaces go", () => {
    const rules = orchestratorRules({ ...founder, running: [{ id: "pty-7", engine: "Claude Code", workspace: "VibeForge", folder: "~/x", working: true, orchestrated: true, asked: "Fix the tray.", branch: "vibeforge/fix-tray" }] });
    expect(rules).toContain("- claude: Claude Code (effort: low, medium, high, xhigh, max)");
    expect(rules).toContain("- crush: Crush\n");
    expect(rules).toContain("- fix-tray: fix-tray (branch vibeforge/fix-tray), from VibeForge");
    expect(rules).toContain("in its own copy on vibeforge/fix-tray; asked: Fix the tray.");
    expect(rules).toContain("~/Projects/<name>");
    expect(rules).toContain("- workspace: make a new workspace.");
  });

  it("plans faster: low effort, and no MCP servers for Claude Code", () => {
    expect(brainArgs(claude, { text: "x", rules: "r", sessionId: "s", resume: false })).toEqual(expect.arrayContaining(["--effort", "low", "--strict-mcp-config"]));
    const grokArgs = brainArgs(grok, { text: "x", rules: "r", sessionId: "s", resume: false }) ?? [];
    expect(grokArgs.slice(grokArgs.indexOf("--reasoning-effort"), grokArgs.indexOf("--reasoning-effort") + 2)).toEqual(["--reasoning-effort", "low"]);
  });

  it("knows when the session a planner was asked to resume is gone", () => {
    expect(sessionGone("No conversation found with session ID: 1234")).toBe(true);
    expect(sessionGone("Error: session abc not found")).toBe(true);
    expect(sessionGone("thread not found")).toBe(true);
    expect(sessionGone("unexpected status 401 Unauthorized")).toBe(false);
    expect(sessionGone("Session ID 1234 is already in use.")).toBe(false);
  });
});

describe("Maestro in the service, 2.16", () => {
  it("makes a workspace's folder (a git repository when asked), adds it, and starts the CLI there", async () => {
    const projects = tempDir();
    const ctx = withPlanner([
      {
        say: "Making Star Ledger and starting Claude there.",
        steps: [
          { kind: "workspace", workspace: "Star Ledger", git: true },
          { kind: "start", engine: "claude", workspace: "Star Ledger", prompt: "Set it up.", effort: "high", model: "opus" },
        ],
      },
    ]);
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [], promptArgs: ["{prompt}"] });
    fs.writeFileSync(file, JSON.stringify(engines));
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: projects } });
    expect(ctx.svc.orchestratorView().projectsFolder).toBe(projects);

    await ctx.svc.orchestratorAsk("make a workspace called Star Ledger and start Claude in it on high effort with opus");
    const plan = ctx.svc.orchestratorView().turns.at(-1);
    expect(plan?.steps?.[0]).toMatchObject({ kind: "workspace", name: "Star Ledger", folder: path.join(projects, "Star Ledger") });
    expect(fs.existsSync(path.join(projects, "Star Ledger"))).toBe(false);
    await ctx.svc.orchestratorRun(plan?.id ?? "");
    const done = ctx.svc.orchestratorView().turns.find((turn) => turn.id === plan?.id);
    expect(done?.steps?.map((step) => step.state)).toEqual(["done", "done"]);
    const folder = path.join(projects, "Star Ledger");
    expect(fs.existsSync(path.join(folder, ".git"))).toBe(true);
    const made = ctx.svc.listWorkspaces().workspaces.find((item) => item.path === folder);
    expect(made?.name).toBe("Star Ledger");
    expect(done?.steps?.[1]).toMatchObject({ workspaceId: made?.id, branch: "" });
    expect(ctx.spawns[0].cwd).toBe(folder);
    // The CLI starts on the model and effort asked for, before its prompt.
    expect(ctx.spawns[0].argv.slice(0, 5)).toEqual(["/usr/bin/argy", "--model", "opus", "--effort", "high"]);
    expect(ctx.spawns[0].argv.at(-1)).toBe("Set it up.");
    ctx.svc.close();
  });

  it("only adds a folder that is already there: nothing in it is written, and no repository is made", async () => {
    const projects = tempDir();
    const existing = path.join(projects, "Old Stuff");
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "keep.txt"), "mine\n");
    const ctx = withPlanner([{ say: "Adding it.", steps: [{ kind: "workspace", workspace: "Old Stuff", git: true }] }]);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go", model: "", projectsFolder: projects } });
    await ctx.svc.orchestratorAsk("add old stuff");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(fs.readdirSync(existing)).toEqual(["keep.txt"]);
    expect(ctx.svc.listWorkspaces().workspaces.map((item) => item.name)).toContain("Old Stuff");
    ctx.svc.close();
  });

  it("puts new workspaces where most of them are when Settings don't say", () => {
    const parent = tempDir();
    const ctx = withPlanner([]);
    for (const name of ["a", "b"]) {
      fs.mkdirSync(path.join(parent, name));
      ctx.svc.addWorkspace(path.join(parent, name));
    }
    ctx.svc.addWorkspace(ctx.place);
    expect(ctx.svc.orchestratorView().projectsFolder).toBe(parent);
    ctx.svc.close();
  });

  it("never stops, applies or throws away work under Just go without Go", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([]);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const running = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go", model: "", projectsFolder: "" } });
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: { say: "Stopping it.", steps: [{ kind: "stop", target: running.ptyId }] } }), stderr: "", timedOut: false });
    await ctx.svc.orchestratorAsk("stop it");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.svc.orchestratorView().turns.at(-1)?.plan).toBe("waiting");
    expect(ctx.killed).toEqual([]);
    ctx.svc.close();
  });

  it("applies, discards and shows through a plan once Go is pressed", async () => {
    const { repo, git } = repoWithFile();
    const plan = (branch: string) => ({ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch, prompt: "Change a." }] });
    const ctx = withPlanner([plan("one"), plan("two")]);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const shown: unknown[] = [];
    ctx.host.show = (route) => shown.push(route);
    const one = await startInCopy(ctx, "one");
    fs.writeFileSync(path.join(one.copy.path, "a.txt"), "one\nTWO\n");
    git(one.copy.path, "commit", "-qam", "two");
    const two = await startInCopy(ctx, "two");
    const answers = [
      { say: "Showing it.", steps: [{ kind: "show", target: two.step.ptyId }] },
      { say: "Applying one, dropping two.", steps: [{ kind: "apply", target: "one" }, { kind: "discard", target: "two" }] },
    ];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: answers.shift() }), stderr: "", timedOut: false });
    const ask = async (text: string) => {
      await ctx.svc.orchestratorAsk(text);
      const turn = ctx.svc.orchestratorView().turns.at(-1);
      await ctx.svc.orchestratorRun(turn?.id ?? "");
      return ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id);
    };
    // Showing changes nothing, so it goes without Go.
    await ctx.svc.orchestratorAsk("show me two");
    await until(() => shown.length === 1);
    expect(shown).toEqual([{ view: "code", workspaceId: two.step.openedWorkspaceId, ptyId: two.step.ptyId }]);
    const done = await ask("apply one and throw away two");
    expect(done?.steps?.map((step) => step.state)).toEqual(["done", "done"]);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\nTWO\n");
    expect(ctx.svc.orchestratorView().copies).toEqual([]);
    // Discard can be undone, from the step's own Undo.
    expect(done?.steps?.[1].undo).toBeTruthy();
    expect(workspace.id).toBeTruthy();
    ctx.svc.close();
  });

  it("says when uncommitted edits won't be in a new copy", async () => {
    const { repo } = repoWithFile();
    const ctx = withPlanner([{ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", branch: "x", prompt: "Go." }] }]);
    ctx.svc.addWorkspace(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    await ctx.svc.orchestratorAsk("go");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.steps?.[0].dirty).toBe(2);
    ctx.svc.close();
  });

  it("never names a session twice after a first turn that didn't go through, and starts again when one is gone", async () => {
    const ctx = withPlanner([]);
    const calls: string[][] = [];
    const answers = [
      { code: 1, stdout: "", stderr: "boom", timedOut: false },
      { code: 0, stdout: JSON.stringify({ structuredOutput: { say: "Hello.", steps: [] } }), stderr: "", timedOut: false },
      { code: 1, stdout: "", stderr: "Error: No conversation found with session ID: abc", timedOut: false },
      { code: 0, stdout: JSON.stringify({ structuredOutput: { say: "Back again.", steps: [] } }), stderr: "", timedOut: false },
    ];
    ctx.svc.orchestrator.runner = async (argv) => {
      calls.push(argv);
      return answers.shift() ?? { code: 1, stdout: "", stderr: "", timedOut: false };
    };
    await ctx.svc.orchestratorAsk("hi");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({ problem: "failed" });
    await ctx.svc.orchestratorAsk("hi again");
    // The failed turn's session is never named again.
    expect(calls[1].at(-2)).toBe("-s");
    expect(calls[1].at(-1)).not.toBe(calls[0].at(-1));
    // Resumed, but gone: a new session, told what was said.
    await ctx.svc.orchestratorAsk("and now?");
    expect(calls[2].slice(-2)).toEqual(["-r", calls[1].at(-1)]);
    expect(calls[3].at(-2)).toBe("-s");
    expect(calls[3].at(-1)).not.toBe(calls[1].at(-1));
    const text = calls[3][calls[3].indexOf("-p") + 1];
    expect(text).toContain("The person: hi again");
    expect(text).toContain("You: Hello.");
    expect(text).toContain("The person now says:\nand now?");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.text).toBe("Back again.");
    ctx.svc.close();
  });

  it("hears back from a CLI it started: a turn that ends after real work, and a CLI that closes", async () => {
    let at = Date.now();
    const repo = gitRepo();
    const ctx = withPlanner([{ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", inPlace: true, prompt: "Work." }] }], { now: () => new Date(at) });
    ctx.svc.addWorkspace(repo);
    await ctx.svc.orchestratorAsk("start argy in shop");
    await ctx.svc.orchestratorRun(ctx.svc.orchestratorView().turns.at(-1)?.id ?? "");
    const ptyId = ctx.svc.orchestratorView().turns.at(-1)?.steps?.[0].ptyId ?? "";
    const notes = () => ctx.svc.orchestratorView().turns.filter((turn) => turn.note);

    // A short blip isn't a turn worth a word.
    ctx.svc.onPtyActivity(ptyId, true);
    at += 5000;
    ctx.svc.onPtyActivity(ptyId, false);
    expect(notes()).toEqual([]);
    // Real work, then quiet.
    ctx.svc.onPtyActivity(ptyId, true);
    at += 30_000;
    ctx.svc.onPtyActivity(ptyId, false);
    await until(() => notes().length === 1);
    expect(notes()[0].note).toMatchObject({ kind: "finished", ptyId, engine: "Argy", workspace: "shop", changes: expect.stringContaining("1 file changed") });
    // Working again within the minute: still one word.
    ctx.svc.onPtyActivity(ptyId, true);
    at += 25_000;
    ctx.svc.onPtyActivity(ptyId, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notes()).toHaveLength(1);
    // It closes by itself.
    await ctx.exit(ptyId);
    expect(notes().at(-1)?.note).toMatchObject({ kind: "ended", ptyId });
    ctx.svc.close();
  });

  it("says nothing when a person stops a CLI it started", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([{ say: "On it.", steps: [{ kind: "start", engine: "argy", workspace: "shop", inPlace: true, prompt: "Work." }] }]);
    ctx.svc.addWorkspace(repo);
    await ctx.svc.orchestratorAsk("start argy in shop");
    await ctx.svc.orchestratorRun(ctx.svc.orchestratorView().turns.at(-1)?.id ?? "");
    const ptyId = ctx.svc.orchestratorView().turns.at(-1)?.steps?.[0].ptyId ?? "";
    await ctx.svc.killPty(ptyId);
    await until(() => !ctx.svc.listLive().some((session) => session.ptyId === ptyId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.svc.orchestratorView().turns.filter((turn) => turn.note)).toEqual([]);
    ctx.svc.close();
  });

  it("retries on a fresh session when a planner promises to search or start something with no steps", async () => {
    expect(emptyPromise("I'm checking VibeForge and your projects for the Antigravity Android widget session so I can open the right workspace.")).toBe(true);
    expect(emptyPromise("Sorry for the wait. I'm searching that session id on disk right now.")).toBe(true);
    expect(emptyPromise("Which coding CLI should I start in VibeForge?")).toBe(false);
    expect(emptyPromise("I don't see an Android widget workspace here. Which workspace is it in?")).toBe(false);

    const repo = gitRepo();
    const ctx = withPlanner([
      { say: "Sorry for the wait. I'm searching that session id on disk right now.", steps: [] },
      { say: "Starting Argy in shop to find that session.", steps: [{ kind: "start", engine: "argy", workspace: "shop", inPlace: true, prompt: "Find the Android widget session." }] },
    ]);
    ctx.svc.addWorkspace(repo);
    await ctx.svc.orchestratorAsk("find the Android widget session in shop with argy");
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls[1].argv.at(-2)).toBe("-s");
    expect(ctx.calls[1].argv.at(-1)).not.toBe(ctx.calls[0].argv.at(-1));
    const retryPrompt = ctx.calls[1].argv[ctx.calls[1].argv.indexOf("-p") + 1];
    expect(retryPrompt).toContain("with steps: []");
    const lastTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(lastTurn?.text).toBe("Starting Argy in shop to find that session.");
    expect(lastTurn?.steps?.[0]).toMatchObject({ kind: "start", engineId: "argy" });
    ctx.svc.close();
  });

  it("runs a lookup step immediately in the same turn and hands findings back so Viby plans the real steps", async () => {
    const projects = tempDir();
    const widgetDir = path.join(projects, "android-widget-app");
    fs.mkdirSync(widgetDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: widgetDir });

    const ctx = withPlanner([
      {
        say: "Let me look for that Android widget project.",
        steps: [{ kind: "lookup", prompt: "android-widget" }],
      },
      {
        say: "Found android-widget-app on disk. Adding it as a workspace and starting Argy there.",
        steps: [
          { kind: "workspace", workspace: "android-widget-app", folder: widgetDir, git: true },
          { kind: "start", engine: "argy", workspace: "android-widget-app", inPlace: true, prompt: "Continue the widget layout." },
        ],
      },
    ]);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: projects } });

    await ctx.svc.orchestratorAsk("Hey Viby, find my android-widget project and start argy in it");
    expect(ctx.calls).toHaveLength(2);
    const secondPrompt = ctx.calls[1].argv[ctx.calls[1].argv.indexOf("-p") + 1];
    expect(secondPrompt).toContain("[Findings from VibeForge]");
    expect(secondPrompt).toContain("android-widget-app");
    const lastTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(lastTurn?.text).toContain("Found android-widget-app on disk.");
    expect(lastTurn?.steps?.map((s) => s.kind)).toEqual(["workspace", "start"]);
    ctx.svc.close();
  });

  it("knows Viby's identity, default engine, agents, tasks and routines, and preserves context across planner switches", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([
      { say: "I am Viby, ready to help.", steps: [] },
      { say: "Starting Atlas and running the routine.", steps: [{ kind: "start", engine: "Atlas", workspace: "shop", inPlace: true, prompt: "Check the store." }, { kind: "routine", target: "Nightly Check", prompt: "disable" }] },
    ]);
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "claude", label: "Claude Code", bin: "pasty", args: [] });
    fs.writeFileSync(file, JSON.stringify(engines));

    ctx.svc.addWorkspace(repo);
    const agent = ctx.svc.saveAgent({ name: "Atlas", engine: "argy", goodAt: "backend architecture", brief: "Always check types.", places: [repo] });
    const routine = ctx.svc.saveRoutine({ name: "Nightly Check", schedule: { kind: "cron", expr: "0 2 * * *" }, prompt: "Run checks.", agentId: agent.id, enabled: true });

    await ctx.svc.orchestratorAsk("Hey Viby, who are you?");
    const firstRules = ctx.calls[0].argv[ctx.calls[0].argv.indexOf("--rules") + 1];
    expect(firstRules).toContain("You are Viby (also called Vibey, Vibe, or Maestro");
    expect(firstRules).toContain("Atlas (CLI: argy; backend architecture");
    expect(firstRules).toContain("Nightly Check");

    // Switch planner from Grok to Claude Code: Viby carries the conversation recap into the new planner.
    ctx.svc.saveSettings({ orchestrator: { engine: "claude", mode: "plan", model: "", projectsFolder: "" } });
    await ctx.svc.orchestratorAsk("Start Atlas in shop and pause Nightly Check");
    expect(ctx.calls[1].argv.at(-1)).toContain("The person: Hey Viby, who are you?");
    expect(ctx.calls[1].argv.at(-1)).toContain("You: I am Viby, ready to help.");

    const plan = ctx.svc.orchestratorView().turns.at(-1);
    expect(plan?.steps?.[0]).toMatchObject({ kind: "start", engineId: "argy", agentId: agent.id });
    expect(plan?.steps?.[1]).toMatchObject({ kind: "routine", target: routine.id });

    await ctx.svc.orchestratorRun(plan?.id ?? "");
    expect(ctx.spawns[0].argv.at(-1)).toContain("Always check types.");
    expect(ctx.spawns[0].argv.at(-1)).toContain("Check the store.");
    expect(ctx.svc.listRoutines().find((r) => r.id === routine.id)?.enabled).toBe(false);
    ctx.svc.close();
  });

  it("runs existing tasks and creates new tasks from task steps", async () => {
    const repo = gitRepo();
    const ctx = withPlanner([
      {
        say: "Running existing task and adding a new one.",
        steps: [
          { kind: "task", target: "Existing Fix" },
          { kind: "task", engine: "Atlas", workspace: path.basename(repo), branch: "Audit docs", prompt: "Review README links." },
        ],
      },
    ]);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: "" } });
    const ws = ctx.svc.addWorkspace(repo).workspaces[0];
    const agent = ctx.svc.saveAgent({ name: "Atlas", engine: "argy", brief: "Be brief.", places: [repo] });
    const existing = ctx.svc.saveTask({ title: "Existing Fix", body: "Fix existing bug.", agentId: agent.id, workspaceId: ws.id });

    await ctx.svc.orchestratorAsk("Run Existing Fix and create a task to audit docs");
    const lastTurn = ctx.svc.orchestratorView().turns.at(-1);
    const rules = ctx.calls[0].argv[ctx.calls[0].argv.indexOf("--rules") + 1];
    expect(rules).toContain("Existing Fix");

    await ctx.svc.orchestratorRun(lastTurn?.id ?? "");
    const tasks = ctx.svc.listTasks();
    expect(tasks.some((t) => t.id === existing.id && t.status === "running")).toBe(true);
    expect(tasks.some((t) => t.title === "Audit docs")).toBe(true);
    ctx.svc.close();
  });
});

describe("Viby's agent, task and routine steps do what the board and Chat do", () => {
  it("takes an agent named exactly for that agent, even when its name holds a CLI's", () => {
    const here: PlanContext = { ...context, agents: [{ id: "grok-reviewer", name: "Grok Reviewer", engine: "claude" }] };
    const [byName, byId, cli] = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "start", engine: "Grok Reviewer", workspace: "VibeForge", prompt: "review the diff" },
          { kind: "start", engine: "grok-reviewer", workspace: "VibeForge", prompt: "review it" },
          { kind: "start", engine: "grok", workspace: "VibeForge", prompt: "review it" },
        ],
      },
      here,
    );
    expect(byName).toMatchObject({ agentId: "grok-reviewer", engineId: "claude" });
    expect(byId).toMatchObject({ agentId: "grok-reviewer", engineId: "claude" });
    // A CLI's own id is that CLI.
    expect(cli.engineId).toBe("grok");
    expect(cli.agentId).toBeUndefined();
  });

  it("reads a routine step's on, off or run now, and asks about anything else", () => {
    expect(["", "run", "Run now", "start"].map(routineAction)).toEqual(["", "", "", ""]);
    expect(["enable", "on", "Turn it on", "resume"].map(routineAction)).toEqual(["enable", "enable", "enable", "enable"]);
    expect(["disable", "off", "pause", "Stop."].map(routineAction)).toEqual(["disable", "disable", "disable", "disable"]);
    const here: PlanContext = { ...context, routines: [{ id: "nightly", name: "Nightly", schedule: "every day", enabled: true }, { id: "disable-old", name: "Disable old branches", schedule: "weekly", enabled: true }] };
    const [paused, unclear] = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "routine", target: "Nightly", prompt: "pause" },
          { kind: "routine", target: "Nightly", prompt: "twice" },
        ],
      },
      here,
    );
    expect(paused).toMatchObject({ target: "nightly", prompt: "disable" });
    expect(stepIssue(paused, here)).toBeNull();
    expect(stepIssue(unclear, here)).toBe("prompt");
    // The action is never taken for the routine's name.
    expect(resolvePlan({ say: "", steps: [{ kind: "routine", prompt: "disable" }] }, here)[0].target).toBe("");
  });

  it("doesn't take an answer that waits on the person for an empty promise", () => {
    expect(emptyPromise("I'll start Claude in Dune once you tell me which branch.")).toBe(false);
    expect(emptyPromise("I'll make the workspace as soon as you say where it goes.")).toBe(false);
    expect(emptyPromise("Let me know which routine, and I'll start it.")).toBe(false);
    expect(emptyPromise("I'm searching that session id on disk right now.")).toBe(true);
  });

  it("runs an existing task again as Execute does: fresh, with its instructions, never a Continue", async () => {
    const ctx = withPlanner([{ say: "Running Fix login.", steps: [{ kind: "task", target: "Fix login" }] }]);
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const agent = ctx.svc.saveAgent({ name: "Notes", engine: "argy", brief: "b", places: [ctx.place] });
    const task = ctx.svc.saveTask({ title: "Fix login", body: "Fix the login bug.", agentId: agent.id, workspaceId: ws.id });
    await ctx.exit(started(await ctx.svc.executeTask(task.id)).ptyId);
    await ctx.svc.orchestratorAsk("run fix login again");
    const turn = ctx.svc.orchestratorView().turns.at(-1);
    await ctx.svc.orchestratorRun(turn?.id ?? "");
    expect(ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id)?.steps?.[0]).toMatchObject({ state: "done" });
    const spawn = ctx.spawns.at(-1);
    expect(spawn?.argv).not.toContain("--continue");
    expect(spawn?.argv.join("\n")).toContain("Fix the login bug.");
    ctx.svc.close();
  });

  it("lets a task and a routine in the workspace itself wait their turn while another CLI is busy there", async () => {
    const ctx = withPlanner([
      {
        say: "Running both.",
        steps: [
          { kind: "task", target: "Fix login" },
          { kind: "routine", target: "Nightly" },
        ],
      },
    ]);
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const agent = ctx.svc.saveAgent({ name: "Notes", engine: "argy", brief: "b", places: [ctx.place], allowRoutines: true });
    ctx.svc.saveTask({ title: "Fix login", body: "Fix it.", agentId: agent.id, workspaceId: ws.id, isolated: false });
    ctx.svc.saveRoutine({ name: "Nightly", agentId: agent.id, schedule: { kind: "every", minutes: 60 }, prompt: "tidy" });
    const busy = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "argy" });
    ctx.svc.onPtyActivity(busy.ptyId, true);
    const before = ctx.spawns.length;
    await ctx.svc.orchestratorAsk("run fix login and the nightly routine");
    const turn = ctx.svc.orchestratorView().turns.at(-1);
    await ctx.svc.orchestratorRun(turn?.id ?? "");
    expect(ctx.spawns.length).toBe(before);
    const steps = ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id)?.steps ?? [];
    expect(steps.map((step) => step.result)).toEqual([expect.stringContaining("Waiting for Argy in that folder"), expect.stringContaining("Waiting for Argy in that folder")]);
    expect(ctx.svc.listTasks()[0].waiting).not.toBeNull();
    ctx.svc.close();
  });

  it("makes a new task in a folder that isn't a git repository, in the folder itself", async () => {
    const ctx = withPlanner([{ say: "Making it.", steps: [{ kind: "task", engine: "Notes", workspace: "", branch: "Tidy notes", prompt: "Tidy the notes." }] }]);
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    ctx.svc.saveAgent({ name: "Notes", engine: "argy", brief: "b", places: [ctx.place] });
    await ctx.svc.orchestratorAsk("make a task for notes to tidy the notes");
    const turn = ctx.svc.orchestratorView().turns.at(-1);
    const step = turn?.steps?.[0];
    if (step) ctx.svc.orchestratorEditStep(turn?.id ?? "", step.id, { workspaceId: ws.id });
    await ctx.svc.orchestratorRun(turn?.id ?? "");
    expect(ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id)?.steps?.[0]).toMatchObject({ state: "done" });
    expect(ctx.svc.listTasks()[0]).toMatchObject({ title: "Tidy notes", isolated: false, status: "running" });
    ctx.svc.close();
  });

  it("starts an agent only in its allowed folders, and in a copy tells it to work there", async () => {
    const repo = gitRepo();
    const elsewhere = tempDir();
    const ctx = withPlanner([
      { say: "Starting Notes.", steps: [{ kind: "start", engine: "Notes", workspace: path.basename(elsewhere), prompt: "tidy up" }] },
      { say: "Starting Notes.", steps: [{ kind: "start", engine: "Notes", workspace: "shop", branch: "tidy", prompt: "tidy up" }] },
    ]);
    ctx.svc.addWorkspace(elsewhere);
    ctx.svc.addWorkspace(repo);
    ctx.svc.saveAgent({ name: "Notes", engine: "argy", brief: "b", places: [repo] });
    const before = ctx.spawns.length;
    await ctx.svc.orchestratorAsk("start notes in the other folder");
    const outside = ctx.svc.orchestratorView().turns.at(-1);
    await ctx.svc.orchestratorRun(outside?.id ?? "");
    expect(ctx.spawns.length).toBe(before);
    expect(ctx.svc.orchestratorView().turns.find((item) => item.id === outside?.id)?.steps?.[0]).toMatchObject({ state: "failed", error: `Notes is not allowed in ${path.basename(elsewhere)}.` });

    await ctx.svc.orchestratorAsk("start notes in shop on tidy");
    const inside = ctx.svc.orchestratorView().turns.at(-1);
    await ctx.svc.orchestratorRun(inside?.id ?? "");
    expect(ctx.svc.orchestratorView().turns.find((item) => item.id === inside?.id)?.steps?.[0]).toMatchObject({ state: "done", copyId: expect.any(String) });
    const spawn = ctx.spawns.at(-1);
    expect(spawn?.cwd).not.toBe(repo);
    const preamble = spawn?.argv.join("\n") ?? "";
    expect(preamble).toContain(`- ${spawn?.cwd}`);
    expect(preamble).toContain(`This run works in its own git worktree of ${repo}`);
    ctx.svc.close();
  });

  it("doesn't send each workspace's past runs with every turn: a lookup searches them when asked", async () => {
    const ctx = withPlanner([{ say: "Nothing to start.", steps: [] }]);
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    await ctx.exit((await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "argy", prompt: "Refactor the secret billing module" })).ptyId);
    await ctx.svc.orchestratorAsk("what's running?");
    const rules = ctx.calls[0].argv[ctx.calls[0].argv.indexOf("--rules") + 1];
    expect(rules).toContain(`- ${ws.name} (`);
    expect(rules).not.toContain("secret billing");
    expect((await ctx.svc.orchestrator.lookup("billing")).details).toContain("Refactor the secret billing module");
    ctx.svc.close();
  });

  it("looks a folder up by its own name, so the folders inside one match don't crowd the others out", async () => {
    const home = tempDir();
    const projects = path.join(home, "Projects");
    for (const sub of ["src", "docs", "tests", "scripts", "assets", "public", "config", "lib", "app"]) fs.mkdirSync(path.join(projects, "aardvark", sub), { recursive: true });
    fs.mkdirSync(path.join(projects, "zoo", "aardvark-notes"), { recursive: true });
    fs.mkdirSync(path.join(projects, "zoo", "vark-ideas"), { recursive: true });
    // Only where projects are kept: other folders' names would go to the planner's provider.
    fs.mkdirSync(path.join(home, "Documents", "aardvark-taxes"), { recursive: true });
    fs.mkdirSync(path.join(home, "Desktop", "aardvark-photos"), { recursive: true });
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = withPlanner([]);
      const found = await ctx.svc.orchestrator.lookup("aardvark");
      expect(found.details.split("\n").sort()).toEqual(["- Folder on disk: ~/Projects/aardvark", "- Folder on disk: ~/Projects/zoo/aardvark-notes"]);
      // A path is matched whole only when the query is one.
      expect((await ctx.svc.orchestrator.lookup("aardvark/docs")).details).toContain("~/Projects/aardvark/docs");
      ctx.svc.close();
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe("Viby across the window", () => {
  const here: PlanContext = {
    ...context,
    workspaces: [...context.workspaces, { id: "tasks-ws", name: "Tasks", folder: "~/Projects/tasks", git: true }, { id: "app-settings", name: "app-settings", folder: "~/Projects/app-settings", git: true }],
  };
  const shows = (steps: Array<Record<string, unknown>>, ctx: PlanContext = here) => resolvePlan({ say: "", steps: steps.map((step) => ({ kind: "show", ...step })) }, ctx);

  it("shows a running CLI, a workspace or a view, whichever was named", () => {
    const steps = shows([{ target: "pty-4" }, { workspace: "dune" }, { target: "Dune" }, { target: "runs" }, { target: "the Viby panel" }, { workspace: "settings" }, { target: "Tasks" }, { target: "nowhere at all" }]);
    expect(steps.map((step) => [step.target, step.workspaceId, step.view ?? "", step.asked])).toEqual([
      ["pty-4", "", "", "Codex · Dune"],
      ["", "dune", "", "Dune"],
      // Named as a target, it is the CLI running there: its terminal opens that workspace too.
      ["pty-4", "", "", "Codex · Dune"],
      ["", "", "runs", "Runs"],
      ["", "", "orchestrator", "Viby"],
      // The view, though a workspace's name holds the word; a workspace called exactly that wins.
      ["", "", "settings", "Settings"],
      ["", "tasks-ws", "", "Tasks"],
      ["", "", "", "nowhere at all"],
    ]);
    expect(steps.map((step) => stepIssue(step, here))).toEqual([null, null, null, null, null, null, null, "workspace"]);
    // A workspace removed since, and a CLI that has closed.
    expect(stepIssue(steps[1], { ...here, workspaces: [] })).toBe("workspace");
    expect(stepIssue(steps[0], { ...here, running: [] })).toBe("target");
    expect(stepIssue({ ...steps[3], view: "nope" }, here)).toBe("workspace");
  });

  it("knows the views by the names people use", () => {
    expect(["tasks", "the task board", "Runs view", "history", "Vibey", "terminals", "Settings page", "code"].map((said) => showView(said))).toEqual(["tasks", "tasks", "runs", "runs", "orchestrator", "code", "settings", "code"]);
    expect(showView("the moon")).toBeNull();
    expect(showView("")).toBeNull();
    expect(showView(undefined)).toBeNull();
  });

  it("tells the planner what is in front of the person, when that says something", () => {
    expect(lookingLine({ view: "code", workspaceId: "dune", ptyId: "pty-4" }, context)).toBe('(In front of the person right now: the Code view, workspace "Dune", terminal pty-4 running Codex.)');
    expect(lookingLine({ view: "code", workspaceId: "notes", ptyId: "pty-9" }, context)).toBe('(In front of the person right now: the Code view, workspace "Notes", a terminal with no coding CLI in it.)');
    expect(lookingLine({ view: "code", workspaceId: "notes" }, context)).toBe('(In front of the person right now: the Code view, workspace "Notes".)');
    expect(lookingLine({ view: "tasks", ptyId: "pty-4" }, context)).toBe("(In front of the person right now: the Tasks view, terminal pty-4 running Codex in Dune.)");
    expect(lookingLine({ view: "runs" }, context)).toBe("(In front of the person right now: the Runs view.)");
    // Nothing worth saying: its own panel, Home, Code with nothing open, a view it doesn't know.
    for (const looking of [null, undefined, { view: "orchestrator" }, { view: "home" }, { view: "code" }, { view: "code", workspaceId: "gone" }, { view: "elsewhere" }]) expect(lookingLine(looking, context)).toBe("");
    const rules = orchestratorRules(context);
    expect(rules).toContain("a line in parentheses saying what is in front of the person");
    expect(rules).toContain("word for word");
    expect(rules).toContain("to open that view");
  });

  it("says where the person is ahead of their words, and keeps the words as they were said", async () => {
    const ctx = withPlanner([{ say: "Nothing to do.", steps: [] }]);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    await ctx.svc.orchestratorAsk("what is this one doing?", { view: "code", workspaceId: workspace.id });
    const text = ctx.calls[0].argv[ctx.calls[0].argv.indexOf("-p") + 1];
    expect(text).toBe(`(In front of the person right now: the Code view, workspace "${workspace.name}".)\nwhat is this one doing?`);
    expect(ctx.svc.orchestratorView().turns[0]).toMatchObject({ from: "you", text: "what is this one doing?" });
    ctx.svc.close();
  });

  it("shows at once without Go, as it changes nothing: a workspace, then a view", async () => {
    const ctx = withPlanner([]);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const shown: unknown[] = [];
    ctx.host.show = (route, raise) => shown.push([route, raise]);
    const answers = [
      { say: "Here it is.", steps: [{ kind: "show", workspace: workspace.name }] },
      { say: "Here are your tasks.", steps: [{ kind: "show", target: "tasks" }] },
      { say: "Showing it.", steps: [{ kind: "show", target: "nowhere" }] },
    ];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: answers.shift() }), stderr: "", timedOut: false });
    // Show me first is on: a plan that only shows still goes by itself.
    expect(ctx.svc.getSettings().orchestrator.mode).toBe("plan");
    await ctx.svc.orchestratorAsk("switch to my workspace");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    await ctx.svc.orchestratorAsk("show me my tasks");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(shown).toEqual([
      [{ view: "code", workspaceId: workspace.id }, undefined],
      [{ view: "tasks" }, undefined],
    ]);
    // One that names nothing here waits on its card instead.
    await ctx.svc.orchestratorAsk("show me nowhere");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.plan).toBe("waiting");
    expect(shown).toHaveLength(2);
    ctx.svc.close();
  });

  it("follows what Viby starts and tells during a call, without raising the window", async () => {
    let at = Date.now();
    const ctx = withPlanner([], { now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const shown: unknown[] = [];
    ctx.host.show = (route, raise) => shown.push([route, raise]);
    const answers: Array<Record<string, unknown>> = [];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: answers.shift() }), stderr: "", timedOut: false });
    const go = async (text: string, plan: Record<string, unknown>) => {
      answers.push(plan);
      await ctx.svc.orchestratorAsk(text);
      const turn = ctx.svc.orchestratorView().turns.at(-1);
      await ctx.svc.orchestratorRun(turn?.id ?? "");
      return ctx.svc.orchestratorView().turns.find((item) => item.id === turn?.id)?.steps?.[0];
    };
    // Outside a call the window stays where it is.
    const quiet = await go("start argy", { say: "Starting.", steps: [{ kind: "start", engine: "argy", workspace: workspace.name }] });
    expect(quiet?.state).toBe("done");
    expect(shown).toEqual([]);

    ctx.svc.orchestratorCall(() => undefined);
    const started = await go("start another", { say: "Starting.", steps: [{ kind: "start", engine: "argy", workspace: workspace.name }] });
    expect(shown).toEqual([[{ view: "code", workspaceId: workspace.id, ptyId: started?.ptyId }, false]]);
    // Past the moment a CLI that just started is left to draw its first screen.
    at += 6000;
    const told = await go("tell the first to wrap up", { say: "Telling it.", steps: [{ kind: "tell", target: quiet?.ptyId, prompt: "Wrap up." }] });
    expect(told?.state).toBe("done");
    expect(shown.at(-1)).toEqual([{ view: "code", workspaceId: workspace.id, ptyId: quiet?.ptyId }, false]);

    ctx.svc.orchestratorCall(null);
    await go("and again", { say: "Starting.", steps: [{ kind: "start", engine: "argy", workspace: workspace.name }] });
    expect(shown).toHaveLength(2);
    ctx.svc.close();
  });
});

describe("Viby speaks up", () => {
  it("plans a read of a running CLI's answer: its start, or all of it when asked", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "read", target: "pty-4" },
          { kind: "read", target: "Codex in Dune", prompt: "All of it." },
          { kind: "read", target: "the one in Notes", prompt: "what did it say" },
        ],
      },
      context,
    );
    expect(steps.map((step) => [step.kind, step.target, step.prompt])).toEqual([
      ["read", "pty-4", ""],
      ["read", "pty-4", "all"],
      ["read", "", ""],
    ]);
    expect(steps.map((step) => stepIssue(step, context))).toEqual([null, null, "target"]);
    expect(readsAll("everything")).toBe(true);
    expect(readsAll("")).toBe(false);
    const rules = orchestratorRules(context);
    expect(rules).toContain("- read: read out verbatim to the person what a running CLI last answered");
    expect(rules).toContain("- inspect: inspect a running CLI's terminal screen and latest reply");
  });

  /** A planner that answers with the next plan handed to it, and Go pressed on what it planned. */
  function desk(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = withPlanner([], opts);
    const answers: Array<Record<string, unknown>> = [];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: answers.shift() }), stderr: "", timedOut: false });
    const ask = async (text: string, plan: Record<string, unknown>) => {
      answers.push(plan);
      await ctx.svc.orchestratorAsk(text);
      const id = ctx.svc.orchestratorView().turns.at(-1)?.id ?? "";
      return () => ctx.svc.orchestratorView().turns.find((item) => item.id === id);
    };
    return { ...ctx, ask };
  }

  it("reads a CLI's last answer from its own log at once, without Go, and hands it to a call", async () => {
    const ctx = desk();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const logged = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "grok" });
    const bare = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const asked: unknown[] = [];
    let answer: string | null = "## Done\n\nAll 12 tests pass.";
    ctx.host.lastReply = async (opts) => {
      asked.push(opts.kind);
      return answer;
    };
    let screen = "";
    ctx.host.screen = async () => screen;
    const shown: unknown[] = [];
    ctx.host.show = (route, raise) => shown.push([route, raise]);
    const heard: VibyWord[] = [];
    ctx.svc.orchestratorCall((word) => heard.push(word));

    // Show me first is on, and it still goes at once: reading changes nothing.
    const read = await ctx.ask("what did grok say?", { say: "Reading it out.", steps: [{ kind: "read", target: logged.ptyId }] });
    await until(() => read()?.plan === "done");
    expect(read()?.steps?.[0]).toMatchObject({ state: "done", reply: "## Done\n\nAll 12 tests pass." });
    expect(asked).toEqual(["grok"]);
    expect(heard).toEqual([{ kind: "read", engine: "Grok Build", workspace: workspace.name, reply: "## Done\n\nAll 12 tests pass.", all: false, fromScreen: false }]);
    // In a call its terminal comes up as well, without the window being raised.
    expect(shown).toEqual([[{ view: "code", workspaceId: workspace.id, ptyId: logged.ptyId }, false]]);

    // A CLI whose log VibeForge can't read: the end of its screen, marked as such.
    screen = "╭────╮\n│ ok │\n╰────╯\nAll done here.";
    const fromScreen = await ctx.ask("and argy, all of it?", { say: "Reading it out.", steps: [{ kind: "read", target: bare.ptyId, prompt: "all" }] });
    await until(() => fromScreen()?.plan === "done");
    expect(fromScreen()?.steps?.[0].reply).toContain("All done here.");
    expect(heard.at(-1)).toMatchObject({ kind: "read", engine: "Argy", all: true, fromScreen: true });

    // Nothing answered yet: the step says so.
    answer = null;
    screen = "";
    const nothing = await ctx.ask("what did grok say now?", { say: "Reading it out.", steps: [{ kind: "read", target: logged.ptyId }] });
    await until(() => nothing()?.plan === "done");
    expect(nothing()?.steps?.[0]).toMatchObject({ state: "failed", error: "It hasn't answered anything yet." });
    expect(heard).toHaveLength(2);

    // With something that changes work beside it, the plan waits for Go like any other.
    answer = "Fine.";
    const mixed = await ctx.ask("read it and stop it", { say: "Reading, then closing.", steps: [{ kind: "read", target: logged.ptyId }, { kind: "stop", target: logged.ptyId }] });
    expect(mixed()?.plan).toBe("waiting");
    ctx.svc.close();
  });

  it("hears back from a CLI it told: the answer to those words, however short the work", async () => {
    let at = Date.now();
    const ctx = desk({ now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const running = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "grok" });
    at += 6000;
    const watched: Array<{ kind: string; words: string }> = [];
    let answered: (reply: string | null) => void = () => undefined;
    ctx.host.watchReply = (opts) => {
      watched.push({ kind: opts.kind, words: opts.words });
      return new Promise((resolve) => {
        answered = resolve;
        opts.signal.addEventListener("abort", () => resolve(null));
      });
    };
    const heard: VibyWord[] = [];
    ctx.svc.orchestratorCall((word) => heard.push(word));
    const notes = () => ctx.svc.orchestratorView().turns.filter((turn) => turn.note);

    const told = await ctx.ask("tell grok to run the tests", { say: "Telling it.", steps: [{ kind: "tell", target: running.ptyId, prompt: "Run the tests.\nAll of them." }] });
    await ctx.svc.orchestratorRun(told()?.id ?? "");
    expect(told()?.steps?.[0].state).toBe("done");
    expect(watched).toEqual([{ kind: "grok", words: "Run the tests." }]);
    expect(notes()).toEqual([]);

    // Eight seconds of work: too short for a word about a CLI it started, but this was asked for.
    at += 8000;
    answered("All 12 tests pass.\n\nThe slow one took 4 s.");
    await until(() => notes().length === 1);
    expect(notes()[0].note).toMatchObject({ kind: "finished", ptyId: running.ptyId, engine: "Grok Build", workspace: workspace.name, reply: "All 12 tests pass." });
    expect(heard).toEqual([{ kind: "note", note: notes()[0].note }]);

    // Told again, and the CLI closes before it answers: nothing more is waited for, or said.
    at += 120_000;
    const again = await ctx.ask("tell it to lint", { say: "Telling it.", steps: [{ kind: "tell", target: running.ptyId, prompt: "Lint." }] });
    await ctx.svc.orchestratorRun(again()?.id ?? "");
    expect(watched).toHaveLength(2);
    await ctx.exit(running.ptyId);
    answered("Too late.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notes()).toHaveLength(1);
    ctx.svc.close();
  });

  it("listens to a told CLI whose log it can't read for that one turn, as to one it started", async () => {
    let at = Date.now();
    const ctx = desk({ now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const running = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    at += 6000;
    const notes = () => ctx.svc.orchestratorView().turns.filter((turn) => turn.note);
    // Its own turns, before Viby told it anything, are the person's business.
    ctx.svc.onPtyActivity(running.ptyId, true);
    at += 30_000;
    ctx.svc.onPtyActivity(running.ptyId, false);
    at += 6000;
    const told = await ctx.ask("tell argy to run the tests", { say: "Telling it.", steps: [{ kind: "tell", target: running.ptyId, prompt: "Run the tests." }] });
    await ctx.svc.orchestratorRun(told()?.id ?? "");
    expect(told()?.steps?.[0].state).toBe("done");
    ctx.svc.onPtyActivity(running.ptyId, true);
    at += 30_000;
    ctx.svc.onPtyActivity(running.ptyId, false);
    await until(() => notes().length === 1);
    expect(notes()[0].note).toMatchObject({ kind: "finished", ptyId: running.ptyId, engine: "Argy" });
    expect(notes()[0].note?.reply).toBeUndefined();
    // The turn after that is the person's again.
    at += 120_000;
    ctx.svc.onPtyActivity(running.ptyId, true);
    at += 30_000;
    ctx.svc.onPtyActivity(running.ptyId, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notes()).toHaveLength(1);
    ctx.svc.close();
  });

  it("puts the start of its answer in the word about a CLI it started", async () => {
    let at = Date.now();
    const ctx = desk({ now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    ctx.host.lastReply = async () => "Fixed the login timeout.\n\n- `auth.ts`: the retry\n- tests";
    const started = await ctx.ask("start grok", { say: "Starting.", steps: [{ kind: "start", engine: "grok", workspace: workspace.name, prompt: "Fix it.", inPlace: true }] });
    await ctx.svc.orchestratorRun(started()?.id ?? "");
    const ptyId = started()?.steps?.[0].ptyId ?? "";
    ctx.svc.onPtyActivity(ptyId, true);
    at += 30_000;
    ctx.svc.onPtyActivity(ptyId, false);
    const notes = () => ctx.svc.orchestratorView().turns.filter((turn) => turn.note);
    await until(() => notes().length === 1);
    expect(notes()[0].note).toMatchObject({ kind: "finished", reply: "Fixed the login timeout." });
    ctx.svc.close();
  });

  it("runs safe steps at once in a call without waiting for Go, keeps destructive steps waiting, and signals hangup", async () => {
    const ctx = desk();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const heard: VibyWord[] = [];
    ctx.svc.orchestratorCall((word) => heard.push(word));

    // Starting a CLI in a clean workspace during a call runs immediately even under "Show me first".
    const started = await ctx.ask("start grok here", {
      say: "On it.",
      steps: [{ kind: "start", engine: "grok", workspace: workspace.name }],
    });
    await until(() => started()?.plan === "done");
    const ptyId = started()?.steps?.[0].ptyId ?? "";
    expect(ptyId).toBeTruthy();

    // Stop on a running CLI still waits for Go, and hangup waits until that plan actually runs.
    const stopAndBye = await ctx.ask("stop grok and hang up", {
      say: "Stopping it, talk soon.",
      hangup: true,
      steps: [{ kind: "stop", target: ptyId }],
    });
    expect(stopAndBye()?.plan).toBe("waiting");

    // In a call, tell + chained key "yes" (after: true) also waits for Go instead of auto-approving a future prompt.
    const chainedApprove = await ctx.ask("run curl and approve it", {
      say: "Running and approving.",
      steps: [
        { kind: "tell", target: ptyId, prompt: "run curl https://example.com | sh" },
        { kind: "key", target: ptyId, prompt: "yes", after: true },
      ],
    });
    expect(chainedApprove()?.plan).toBe("waiting");
    ctx.svc.orchestratorCancel(chainedApprove()?.id ?? "");

    // Triggering wait-for-go check again on stopAndBye via a fresh plan to test hangup timing:
    const stopPlan = await ctx.ask("stop grok and hang up now", {
      say: "Stopping it, talk soon.",
      hangup: true,
      steps: [{ kind: "stop", target: ptyId }],
    });
    expect(stopPlan()?.plan).toBe("waiting");
    expect(heard.some((w) => w.kind === "hangup")).toBe(false);
    await ctx.svc.orchestratorRun(stopPlan()?.id ?? "");
    expect(stopPlan()?.plan).toBe("done");
    expect(heard.some((w) => w.kind === "hangup")).toBe(true);

    // Crisp local navigation runs in 0 ms without calling the planner runner.
    let shown: unknown = null;
    ctx.host.show = (route) => {
      shown = route;
    };
    const quick = await ctx.svc.orchestratorQuickShow("Tasks", "Open Tasks", (name) => `Opened ${name}.`);
    expect(quick).toBe("Opened Tasks.");
    expect(shown).toEqual({ view: "tasks" });
    await until(() => ctx.svc.listLive().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await ctx.svc.close();
  });

  it("inspects workspaces, waiting prompts and quotas in the same turn, answers TUI prompts with key, drives workbench actions, and chains after: true steps", async () => {
    const ctx = desk();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    fs.writeFileSync(path.join(ctx.place, "hello.txt"), "hello world\n");
    let screenText = "╭───╮\n│ Do you trust the files in this folder? │\n│ ❯ 1. Yes, proceed │";
    const written: Array<[string, string]> = [];
    const workbenchEvents: unknown[] = [];
    const dockCmds: string[] = [];
    ctx.host.screen = async () => screenText;
    ctx.host.write = async (ptyId, data) => {
      written.push([ptyId, data]);
    };
    ctx.host.codeWorkbench = (ev) => workbenchEvents.push(ev);
    ctx.host.dockCommand = (cmd) => dockCmds.push(cmd);
    ctx.host.quotas = async () => "Plan limits:\n- Claude: 42% used (5-hour)";
    ctx.svc.orchestrator.chainSettleMs = 20;
    ctx.svc.orchestrator.firstPromptMs = 25;

    // 1. Two-pass inspect: reads hello.txt + quotas and feeds findings back into the planner's second pass.
    const promptsSaw: string[] = [];
    const twoPassAnswers = [
      {
        say: "",
        steps: [
          { kind: "inspect", workspace: workspace.name, folder: "hello.txt" },
          { kind: "inspect", prompt: "limits" },
        ],
      },
      { say: "hello.txt says hello world, and Claude is at 42%.", steps: [] },
    ];
    ctx.svc.orchestrator.runner = async (argv) => {
      promptsSaw.push(argv.join(" "));
      return { code: 0, stdout: JSON.stringify({ structuredOutput: twoPassAnswers.shift() }), stderr: "", timedOut: false };
    };
    await ctx.svc.orchestratorAsk("check hello.txt and my limits");
    expect(promptsSaw).toHaveLength(2);
    expect(promptsSaw[1]).toContain("hello world");
    expect(promptsSaw[1]).toContain("Claude: 42% used");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.text).toBe("hello.txt says hello world, and Claude is at 42%.");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.checks?.map((c) => [c.kind, c.label])).toEqual([
      ["inspect", workspace.name],
      ["inspect", "plan limits"],
    ]);
    expect(ctx.svc.orchestratorView().activity).toBeUndefined();

    // 2. First-screen waiting-prompt detection + answering with a `key` step + chained `after: true` shell step!
    const planQueue: Array<Record<string, unknown>> = [];
    ctx.svc.orchestrator.runner = async () => ({ code: 0, stdout: JSON.stringify({ structuredOutput: planQueue.shift() }), stderr: "", timedOut: false });
    ctx.svc.orchestratorCall(() => undefined);

    planQueue.push({
      say: "Starting Grok, then running tests.",
      steps: [
        { kind: "start", engine: "grok", workspace: workspace.name },
        { kind: "shell", workspace: workspace.name, prompt: "git status", after: true },
      ],
    });
    await ctx.svc.orchestratorAsk("start grok and then run tests");
    // Step 1 starts right away; Step 2 waits because `after: true` is set!
    await until(() => Boolean(ctx.svc.orchestratorView().turns.find((t) => t.steps)?.steps?.[0].ptyId));
    const chainedTurn = () => ctx.svc.orchestratorView().turns.find((t) => t.steps?.length === 2);
    const grokPty = chainedTurn()?.steps?.[0].ptyId ?? "";
    expect(chainedTurn()?.steps?.[1].state).toBe("planned");

    // Because Grok has not gone busy yet and sits on a trust screen, firstPromptMs emits a "waiting" note!
    await until(() => ctx.svc.orchestratorView().turns.some((t) => t.note?.kind === "waiting"));
    const waitingNote = ctx.svc.orchestratorView().turns.find((t) => t.note?.kind === "waiting")?.note;
    expect(waitingNote?.reply).toBe("Do you trust the files in this folder?");

    // Answer the numbered trust prompt with `key` ("yes" -> "\r" on "❯ 1. Yes, proceed")!
    planQueue.push({ say: "Approving.", steps: [{ kind: "key", target: grokPty, prompt: "yes" }] });
    await ctx.svc.orchestratorAsk("yes trust it");
    await until(() => written.length === 1);
    expect(written[0]).toEqual([grokPty, "\r"]);

    // Now Grok works and finishes its turn -> unblocks chained Step 2 (`shell`)!
    screenText = "> ";
    ctx.svc.onPtyActivity(grokPty, true);
    ctx.svc.onPtyActivity(grokPty, false);
    await until(() => chainedTurn()?.plan === "done");
    expect(chainedTurn()?.steps?.[1].state).toBe("done");
    expect(chainedTurn()?.steps?.[1].ptyId).toBeTruthy();

    // 3. Workbench steps: mkdir, browser preview URL, reload, side panel, pane split, mark-reviewed!
    planQueue.push({
      say: "Setting up workbench.",
      steps: [
        { kind: "workbench", workspace: workspace.name, prompt: "mkdir", folder: "src/api" },
        { kind: "workbench", workspace: workspace.name, prompt: "browser", target: "localhost:5173" },
        { kind: "workbench", prompt: "reload" },
        { kind: "workbench", workspace: workspace.name, prompt: "split-right" },
        { kind: "workbench", prompt: "mark-reviewed" },
      ],
    });
    await ctx.svc.orchestratorAsk("create src/api, open localhost:5173, reload, split right, and mark runs reviewed");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(fs.existsSync(path.join(ctx.place, "src/api"))).toBe(true);
    expect(ctx.svc.listWorkspaces().workspaces[0].dockUrl).toBe("http://localhost:5173");
    expect(dockCmds).toEqual(["reload"]);
    expect(workbenchEvents).toEqual([
      { kind: "browser-open", workspaceId: workspace.id, url: "http://localhost:5173" },
      { kind: "pane", workspaceId: workspace.id, action: "split-right" },
    ]);

    // 4. While looking at Viby's own panel in a call, starting a CLI stays in Viby; an explicit `show` step navigates.
    const shownRoutes: Array<Record<string, unknown>> = [];
    ctx.host.show = (route) => shownRoutes.push(route);
    ctx.svc.orchestratorLooking({ view: "orchestrator" });
    planQueue.push({
      say: "Started Grok on a branch.",
      steps: [{ kind: "start", engine: "grok", workspace: workspace.name }],
    });
    await ctx.svc.orchestratorAsk("start grok", { view: "orchestrator" });
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(shownRoutes).toEqual([]);

    planQueue.push({
      say: "Opening Tasks.",
      steps: [{ kind: "show", target: "tasks" }],
    });
    await ctx.svc.orchestratorAsk("open tasks", { view: "orchestrator" });
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(shownRoutes).toEqual([{ view: "tasks" }]);

    for (const live of ctx.svc.listLive()) await ctx.svc.killPty(live.ptyId);
    await until(() => ctx.svc.listLive().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await ctx.svc.close();
  });
});

describe("Viby settings awareness and self-configuration", () => {
  it("passes configured reasoning effort to Grok, Claude, Codex and Antigravity, falling back to low when unset or invalid", () => {
    const grokRow = { id: "grok", label: "Grok Build", bin: "grok", args: [] };
    const claudeRow = { id: "claude", label: "Claude Code", bin: "claude", args: [] };
    const codexRow = { id: "codex", label: "Codex", bin: "codex", args: [] };
    const agyRow = { id: "agy", label: "Antigravity", bin: "agy", args: [] };

    expect(brainArgs(grokRow, { text: "hi", rules: "r", sessionId: "s", resume: false, effort: "high" })).toEqual(
      expect.arrayContaining(["--reasoning-effort", "high"]),
    );
    expect(brainArgs(claudeRow, { text: "hi", rules: "r", sessionId: "s", resume: false, effort: "medium" })).toEqual(
      expect.arrayContaining(["--effort", "medium"]),
    );
    expect(brainArgs(claudeRow, { text: "hi", rules: "r", sessionId: "s", resume: false, effort: "minimal" })).toEqual(
      expect.arrayContaining(["--effort", "low"]),
    );
    expect(brainArgs(codexRow, { text: "hi", rules: "r", sessionId: "", resume: false, schemaFile: "/w/s.json", effort: "high" })).toContain(
      'model_reasoning_effort="high"',
    );
    expect(brainArgs(agyRow, { text: "hi", rules: "r", sessionId: "", resume: false, effort: "max" })).toEqual(
      expect.arrayContaining(["--effort", "max"]),
    );
  });

  it("never gives Antigravity an --effort that conflicts with the effort its model id carries", () => {
    const agyRow = { id: "agy", label: "Antigravity", bin: "agy", args: [] };
    const tail = (opts: { model?: string; effort?: string }) => {
      const args = brainArgs(agyRow, { text: "hi", rules: "r", sessionId: "", resume: false, ...opts }) ?? [];
      return args.slice(args.indexOf("plan") + 1);
    };
    // The default model plans at the quick low effort.
    expect(tail({})).toEqual(["--effort", "low"]);
    expect(tail({ effort: "xhigh" })).toEqual(["--effort", "xhigh"]);
    // A model picked from the list, effort left at its default: the model's own level, no low beside it
    // (agy: "--model gemini-4-neon-xhigh conflicts with --effort=low").
    expect(tail({ model: "gemini-4-neon-xhigh" })).toEqual(["--model", "gemini-4-neon-xhigh"]);
    // A model with no levels of its own refuses any --effort.
    expect(tail({ model: "gemini-pro-orchestrator" })).toEqual(["--model", "gemini-pro-orchestrator"]);
    // Both picked and they agree: the model alone says it.
    expect(tail({ model: "gemini-4-neon-xhigh", effort: "xhigh" })).toEqual(["--model", "gemini-4-neon-xhigh"]);
    // Both picked and they differ: the chosen effort on the model's base name.
    expect(tail({ model: "gemini-4-neon-high", effort: "xhigh" })).toEqual(["--effort", "xhigh", "--model", "gemini-4-neon"]);
    expect(tail({ model: "claude-opus-5-5-low", effort: "high" })).toEqual(["--effort", "high", "--model", "claude-opus-5-5"]);
  });

  it("reads Antigravity's error answer as an error, with its own words", () => {
    const out = readBrainOutput(
      '{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \\"gemini-4-neon-high\\" --effort \\"xhigh\\"): --model gemini-4-neon-high conflicts with --effort=xhigh","finished_reason":"error"}',
    );
    expect(out.plan).toBeNull();
    expect(out.error).toContain("conflicts with --effort=xhigh");
  });

  it("shows Viby its own settings & voice models, inspects settings live, and reconfigures itself, voice STT, and VibeForge settings", async () => {
    const downloads: Array<[string, string]> = [];
    let autostartOn = false;
    const ctx = setup();
    const baseEnPath = path.join(ctx.dataRoot, "models", "ggml-base.en.bin");
    fs.mkdirSync(path.join(ctx.dataRoot, "models"), { recursive: true });
    fs.writeFileSync(baseEnPath, Buffer.alloc(1_000_001));
    ctx.host.voiceStatus = () => ({
      ready: true,
      recorder: "pw-record",
      server: "/usr/bin/whisper-server",
      cli: "/usr/bin/whisper-cli",
      sherpa: null,
      model: baseEnPath,
      models: [baseEnPath],
      modelDir: path.join(ctx.dataRoot, "models"),
      language: "en",
      piper: "/usr/bin/piper",
      voices: [],
      speaker: null,
      voiceDir: path.join(ctx.dataRoot, "voices"),
      download: null,
      downloadError: null,
    });
    ctx.host.voiceDownload = (kind, id) => downloads.push([kind, id]);
    ctx.host.autostart = {
      get: () => autostartOn,
      set: (on) => {
        autostartOn = on;
        return autostartOn;
      },
    };
    const enginesFile = path.join(ctx.configRoot, "engines.json");
    const enginesJson = JSON.parse(fs.readFileSync(enginesFile, "utf8")) as { engines: unknown[] };
    enginesJson.engines.push(
      { id: "grok", label: "Grok Build", bin: "argy", args: [] },
      { id: "claude", label: "Claude Code", bin: "pasty", args: [] },
    );
    fs.writeFileSync(enginesFile, JSON.stringify(enginesJson));

    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "grok-4.7", effort: "low", projectsFolder: "" } });

    const calls: string[][] = [];
    const answers: Array<Record<string, unknown>> = [
      // Turn 1: inspect settings & voice in two-pass turn
      { say: "", steps: [{ kind: "inspect", prompt: "settings and voice" }] },
      { say: "You're on Grok 4.7 with ggml-base.en.bin.", steps: [] },
      // Turn 2: plan a settings step to switch voice model, theme, font size, sound volume, autostart, and Viby itself to Claude Sonnet medium effort in Go mode
      {
        say: "Switching voice to Parakeet v3, updating your theme and switching myself to Claude Sonnet on medium effort.",
        steps: [
          { kind: "settings", target: "voice.model", prompt: "parakeet v3" },
          { kind: "settings", target: "voice.speaker", prompt: "en_US-lessac-medium" },
          { kind: "settings", target: "voice.language", prompt: "en" },
          { kind: "settings", target: "theme", prompt: "apex-forge" },
          { kind: "settings", target: "terminalFontSize", prompt: "14" },
          { kind: "settings", target: "sounds.volume", prompt: "50%" },
          { kind: "settings", target: "autostart", prompt: "on" },
          { kind: "settings", target: "viby", engine: "claude", model: "sonnet", effort: "medium", prompt: "go" },
        ],
      },
      // Turn 3 (now running on Claude Code with --model sonnet --effort medium!): change Viby effort to high on the same session
      {
        say: "Moved myself to high effort.",
        steps: [{ kind: "settings", target: "viby.effort", prompt: "high" }],
      },
      // Turn 4 (resumed Claude session): sees `(Updated settings: ...)` with effort=high!
      { say: "Now running on high effort.", steps: [] },
    ];

    ctx.svc.orchestrator.runner = async (argv) => {
      calls.push(argv);
      const next = answers.shift() ?? { say: "", steps: [] };
      return { code: 0, stdout: JSON.stringify({ structuredOutput: next, structured_output: next }), stderr: "", timedOut: false };
    };

    // Turn 1: rules include Viby's active planner/model/effort and installed + catalog voice models; inspect returns live configuration
    await ctx.svc.orchestratorAsk("what settings and voice models do I have?");
    const turn1Rules = calls[0][calls[0].indexOf("--rules") + 1];
    expect(turn1Rules).toContain("Your settings & VibeForge configuration:");
    expect(turn1Rules).toContain("planner=grok, model=grok-4.7, effort=low, mode=plan");
    expect(turn1Rules).toContain("installed STT models: [ggml-base.en.bin]");
    expect(turn1Rules).toContain("parakeet-tdt-0.6b-v3-int8 (640MB, sherpa");
    expect(calls[1][calls[1].indexOf("-p") + 1]).toContain("[Findings from VibeForge]");
    expect(ctx.svc.orchestratorView().turns.at(-1)?.text).toBe("You're on Grok 4.7 with ggml-base.en.bin.");

    // Turn 2: plan waits in `plan` mode; edit one step on the card, then run Go!
    await ctx.svc.orchestratorAsk("switch voice to parakeet v3 and switch yourself to claude sonnet medium");
    const waitingTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(waitingTurn.plan).toBe("waiting");
    const fontStep = waitingTurn.steps!.find((s) => s.target === "terminalFontSize")!;
    ctx.svc.orchestratorEditStep(waitingTurn.id, fontStep.id, { prompt: "15" });
    expect(ctx.svc.orchestratorView().turns.at(-1)!.steps!.find((s) => s.id === fontStep.id)?.asked).toBe("Terminal font size · 15px");

    await ctx.svc.orchestratorRun(waitingTurn.id);
    const updated = ctx.svc.getSettings();
    expect(updated.voice.model).toBe(path.join(ctx.dataRoot, "models", "parakeet-tdt-0.6b-v3-int8"));
    expect(updated.voice.speaker).toBe(path.join(ctx.dataRoot, "voices", "en_US-lessac-medium.onnx"));
    expect(updated.voice.language).toBe("en");
    expect(downloads).toEqual([
      ["model", "parakeet-tdt-0.6b-v3-int8"],
      ["voice", "en_US-lessac-medium"],
    ]);
    expect(updated.theme).toBe("apex-forge");
    expect(updated.terminalFontSize).toBe(15);
    expect(updated.sounds.volume).toBe(0.5);
    expect(autostartOn).toBe(true);
    expect(updated.orchestrator).toEqual({ engine: "claude", mode: "go", model: "sonnet", projectsFolder: "", effort: "medium" });

    // Turn 3: now planned by Claude Code (`pasty`) with `--model sonnet --effort medium`, and since mode is now `go`, runs immediately!
    await ctx.svc.orchestratorAsk("bump your effort to high");
    const claudeCall = calls[3];
    expect(claudeCall[0]).toBe("/usr/bin/pasty");
    expect(claudeCall).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "medium"]));
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 60 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(check()).toBe(true);
    };
    await until(() => ctx.svc.getSettings().orchestrator.effort === "high");

    // Turn 4: resumes the same Claude session with `--effort high` and prepends `(Updated settings: ...)`!
    await ctx.svc.orchestratorAsk("what effort are you on now?");
    const resumedClaude = calls[4];
    expect(resumedClaude).toEqual(expect.arrayContaining(["--resume", "--effort", "high"]));
    expect(resumedClaude.at(-1)).toContain("(Updated settings:");
    expect(resumedClaude.at(-1)).toContain("effort=high");

    await ctx.svc.close();
  });
});
