import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brainArgs, canOrchestrate, cleanBranch, matchName, orchestratorRules, plannedId, plannerFor, readBrainOutput, resolvePlan, sessionGone, signedOut, stepIssue, withPlannedWorkspaces, type PlanContext } from "../../src/core/orchestrator.js";
import { agyModels, grokModels, plannerEnv, spawnBrain, type BrainRun } from "../../src/core/service/orchestrator.js";
import type { EngineRow } from "../../src/core/types.js";
import { setup, tempDir, until } from "./fixtures/service-harness.js";

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
    expect(JSON.parse(asked[asked.indexOf("--json-schema") + 1]).properties.steps.items.required).toEqual(["kind", "engine", "workspace", "branch", "prompt", "target", "folder", "git", "model", "effort", "inPlace"]);
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
      steps: [{ kind: "start", engine: "claude", workspace: "Dune", branch: undefined, prompt: undefined, target: undefined, folder: undefined, git: false, model: undefined, effort: undefined, inPlace: false }],
    });
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
    // A CLI can be opened with nothing to do yet; a message can't be empty.
    expect(stepIssue({ ...steps[0], prompt: " " }, context)).toBeNull();
    expect(stepIssue({ ...steps[4], prompt: " " }, context)).toBe("prompt");
    expect(stepIssue({ ...steps[4], target: "pty-9" }, context)).toBe("target");
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

/** Polls for up to three seconds, for a real process that is slow to start or to be reaped. */
async function eventually(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 150 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
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
    expect(JSON.parse(fs.readFileSync(schemaFile, "utf8")).required).toEqual(["say", "steps"]);
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
    await ask("show me two");
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
});
