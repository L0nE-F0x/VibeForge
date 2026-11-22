import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { configTopics } from "../../electron/config-watch.js";
import { orchestratorFor } from "../../electron/companion.js";
import { lastReply, watchReply } from "../../electron/replies.js";
import { buildPhoneOrchestrator } from "../../src/core/companion-orchestrator.js";
import { holdsForGo, brainArgs, claudeImageStdin, readBrainOutput, resolveLocalReflex, resolvePlan, safeInCall, stepIssue, type PlanContext } from "../../src/core/orchestrator.js";
import { copilotLogCwd, copilotTurn, lastReplyIn, opencodeTurn, replyLogFor, splitForSpeech, startsTurn } from "../../src/core/replies.js";
import { type BrainRun } from "../../src/core/service/orchestrator.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN, readSavedImageDataUrl, savePastedImages, spawnVerifyCommand } from "../../src/core/service/orchestrator-threads.js";
import { setup, tempDir, until } from "./fixtures/service-harness.js";

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 15));
  expect(check()).toBe(true);
}

function gitRepo(name = "shop"): string {
  const dir = path.join(tempDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "app.ts"), ["line 1", "line 2 needle", "line 3", "line 4", "line 5"].join("\n") + "\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const tokenCheck = () => true;\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

function withPlanner(answers: Array<Record<string, unknown>>, opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: "" } });
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  ctx.svc.orchestrator.runner = async (argv, cwd): Promise<BrainRun> => {
    calls.push({ argv, cwd });
    const next = answers.shift() ?? { say: "Done.", steps: [] };
    return { code: 0, stdout: JSON.stringify({ text: "", structuredOutput: next }), stderr: "", timedOut: false };
  };
  return { ...ctx, calls };
}

describe("Viby next-level capabilities", () => {
  it("resolves 0ms local reflexes for slash commands, waiting plans, memory, undo, and view navigation", async () => {
    const context: PlanContext = {
      workspaces: [{ id: "vf", name: "VibeForge", folder: "~/Projects/VibeForge", git: true }],
      engines: [{ id: "grok", label: "Grok Build", available: true }],
      agents: [{ id: "ag-1", name: "Atlas", engine: "claude" }],
      running: [{ id: "pty-1", engine: "Claude Code", workspace: "VibeForge", folder: "~/Projects/VibeForge", working: false, orchestrated: true }],
    };

    expect(resolveLocalReflex("/new", context)).toEqual({ kind: "new-thread" });
    expect(resolveLocalReflex("/go", context, null, true)).toEqual({ kind: "plan-go" });
    expect(resolveLocalReflex("/go", context, null, false)).toBeNull();
    expect(resolveLocalReflex("/cancel", context, null, true)).toEqual({ kind: "plan-cancel" });
    expect(resolveLocalReflex("go", context, null, true)).toEqual({ kind: "plan-go" });
    expect(resolveLocalReflex("cancel that", context, null, true)).toEqual({ kind: "plan-cancel" });
    expect(resolveLocalReflex("/undo", context)).toMatchObject({ kind: "steps", tag: "undo" });
    expect(resolveLocalReflex("/review", context)).toMatchObject({ kind: "steps", tag: "reviewed" });
    expect(resolveLocalReflex("/remember prefer vitest", context)).toMatchObject({ kind: "steps", tag: "remember" });
    expect(resolveLocalReflex("remember that we use pnpm", context)).toMatchObject({ kind: "steps", tag: "remember" });
    expect(resolveLocalReflex("switch to VibeForge", context)).toMatchObject({
      kind: "steps",
      tag: "show",
      rawSteps: [{ kind: "show", workspace: "vf" }],
    });
    expect(resolveLocalReflex("switch to Claude", context)).toMatchObject({
      kind: "steps",
      tag: "show",
      rawSteps: [{ kind: "show", target: "pty-1" }],
    });
    expect(resolveLocalReflex("open voice settings", context)).toMatchObject({
      kind: "steps",
      tag: "show",
      rawSteps: [{ kind: "show", target: "settings", options: "section=voice" }],
    });
    expect(resolveLocalReflex("open Atlas memory", context)).toMatchObject({
      kind: "steps",
      tag: "show",
      rawSteps: [{ kind: "show", target: "agents", agent: "ag-1", options: "tab=memory" }],
    });
    expect(resolveLocalReflex("open tasks?", context)).toBeNull();
    expect(resolveLocalReflex("open VibeForge and run tests", context)).toBeNull();
    expect(resolveLocalReflex("/stop-all", context)).toMatchObject({ kind: "steps", tag: "stop-all" });

    // End-to-end 0ms dispatch without spawning planner runner
    const ctx = withPlanner([]);
    const repo = gitRepo();
    ctx.svc.addWorkspace(repo);
    const rememberRes = await ctx.svc.orchestratorQuickAct("/remember always run biome lint");
    expect(rememberRes.handled).toBe(true);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.svc.orchestratorReadMemory()).toContain("always run biome lint");
    const newRes = await ctx.svc.orchestratorQuickAct("/new");
    expect(newRes.handled).toBe(true);
    expect(ctx.svc.orchestratorView().turns).toHaveLength(0);
    expect(ctx.svc.orchestratorView().threads?.length).toBeGreaterThanOrEqual(1);
  });

  it("supports search, tree, line ranges, copy compare, problems inspection, and multi-round deduplicated inspect", async () => {
    const repo = gitRepo();
    const shown: unknown[] = [];
    const ctx = withPlanner([
      { say: "Checking tree first.", steps: [{ kind: "inspect", workspace: "shop", prompt: "tree" }] },
      { say: "Searching needle.", steps: [{ kind: "inspect", workspace: "shop", prompt: "search=needle" }] },
      { say: "Reading range.", steps: [{ kind: "inspect", workspace: "shop", prompt: "app.ts:2-4" }] },
      { say: "Found `line 2 needle` in app.ts.", steps: [] },
    ]);
    ctx.host.show = (route) => shown.push(route);
    ctx.svc.addWorkspace(repo);

    await ctx.svc.orchestratorAsk("Where is needle defined in shop?");
    expect(ctx.calls).toHaveLength(4);
    const turns = ctx.svc.orchestratorView().turns;
    const reply = turns.at(-1);
    expect(reply?.text).toContain("line 2 needle");
    expect(reply?.checks?.length).toBe(3);
    expect(reply?.checks?.[0].details).toContain("src/");
    expect(reply?.checks?.[1].details).toContain("app.ts:2:");
    expect(reply?.checks?.[2].details).toContain("2: line 2 needle");

    // Duplicate check guard: repeating an already-run inspect step stops instead of burning another turn
    const dup = withPlanner([
      { say: "One", steps: [{ kind: "inspect", workspace: "shop", prompt: "tree" }] },
      { say: "Repeat", steps: [{ kind: "inspect", workspace: "shop", prompt: "tree" }] },
    ]);
    dup.svc.addWorkspace(repo);
    await dup.svc.orchestratorAsk("loop check");
    expect(dup.calls).toHaveLength(2);
    expect(dup.svc.orchestratorView().turns.at(-1)?.checks).toHaveLength(1);

    // Problems inspection + copy compare
    const problemsRes = await ctx.svc.orchestrator.inspect({
      id: "i1",
      kind: "inspect",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "problems",
      target: "",
      asked: "problems",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(problemsRes.summary.toLowerCase()).toContain("problems");

    // Create two copies touching the same file -> compare detects overlap, plus populated problems inspection
    const copyPlan = withPlanner([
      {
        say: "Starting two.",
        steps: [
          { kind: "start", engine: "argy", workspace: "shop", branch: "feat-cmp", prompt: "edit 1" },
          { kind: "start", engine: "argy", workspace: "shop", branch: "feat-cmp-2", prompt: "edit 2" },
        ],
      },
    ]);
    copyPlan.host.screen = async () => "Trust the files in this folder?\n1. Yes, continue";
    copyPlan.svc.addWorkspace(repo);

    // Empty compare check (0 copies)
    const emptyCmp = await copyPlan.svc.orchestrator.inspect({
      id: "ic0",
      kind: "inspect",
      action: "compare",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "compare",
      target: "",
      asked: "compare",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(emptyCmp.summary).toContain("No copies waiting");

    await copyPlan.svc.orchestratorAsk("start two copies on feat-cmp");
    const planTurn = copyPlan.svc.orchestratorView().turns.at(-1)!;
    await copyPlan.svc.orchestratorRun(planTurn.id);
    const copies = copyPlan.svc.orchestratorView().copies ?? [];
    expect(copies).toHaveLength(2);
    const copy = copies[0];
    fs.writeFileSync(path.join(copy.path, "src", "auth.ts"), "export const tokenCheck = () => false;\n");
    fs.writeFileSync(path.join(copies[1].path, "src", "auth.ts"), "export const tokenCheck = () => null;\n");
    const copyDiff = await copyPlan.svc.orchestrator.inspect({
      id: "ic",
      kind: "inspect",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "diff",
      target: copy.id,
      asked: copy.name,
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(copyDiff.details).toContain("tokenCheck");

    const cmp = await copyPlan.svc.orchestrator.inspect({
      id: "ic2",
      kind: "inspect",
      action: "compare",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "compare",
      target: "",
      asked: "compare",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(cmp.summary).toContain("overlapping");
    expect(cmp.details).toContain("Overlapping files");
    expect(cmp.details).toContain("src/auth.ts");

    // Populated inspectProblems: waiting prompt + pending copies + broken routine
    const tmpFolder = tempDir();
    const ag = copyPlan.svc.saveAgent({ name: "Helper", engine: "argy", brief: "help", places: [tmpFolder] });
    copyPlan.svc.saveRoutine({ name: "Nightly", agentId: ag.id, enabled: true, schedule: { kind: "every", minutes: 60 }, prompt: "check" });
    fs.rmSync(tmpFolder, { recursive: true, force: true });
    const populatedProblems = await copyPlan.svc.orchestrator.inspect({
      id: "ip2",
      kind: "inspect",
      action: "problems",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "problems",
      target: "",
      asked: "problems",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(populatedProblems.details).toContain("Waiting for user prompt");
    expect(populatedProblems.details).toContain("Copies waiting for review");
    expect(populatedProblems.details).toContain("Routines needing attention");

    // Non-git folder fallback walk for search & tree
    const plainDir = path.join(tempDir(), "plain");
    fs.mkdirSync(path.join(plainDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(plainDir, "nested", "notes.txt"), "hello fallback needle\n");
    const plainCtx = withPlanner([]);
    const plainWsId = plainCtx.svc.addWorkspace(plainDir).workspaces.find((w) => w.path === plainDir)!.id;
    const plainTree = await plainCtx.svc.orchestrator.inspect({
      id: "pt",
      kind: "inspect",
      action: "tree",
      engineId: "",
      workspaceId: plainWsId,
      branch: "",
      prompt: "tree nested",
      target: "",
      asked: "tree",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(plainTree.details).toContain("nested/notes.txt");
    const plainSearch = await plainCtx.svc.orchestrator.inspect({
      id: "ps",
      kind: "inspect",
      action: "search",
      engineId: "",
      workspaceId: plainWsId,
      branch: "",
      prompt: "fallback needle",
      target: "",
      asked: "search",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(plainSearch.details).toContain("nested/notes.txt:1:");
    const noHitSearch = await plainCtx.svc.orchestrator.inspect({
      id: "ps2",
      kind: "inspect",
      action: "search",
      engineId: "",
      workspaceId: plainWsId,
      branch: "",
      prompt: "zzz-not-present",
      target: "",
      asked: "search",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(noHitSearch.summary).toContain("No matches");
  });

  it("persists viby.md memory with Go gates on set/clear, Undo restore, delta updates, and file-watch mapping", async () => {
    expect(configTopics("viby.md")).toEqual(["orchestrator"]);

    const ctx = withPlanner([
      { say: "Remembering convention.", steps: [{ kind: "memory", action: "append", prompt: "Use strict TypeScript." }] },
      { say: "Replacing memory.", steps: [{ kind: "memory", action: "set", prompt: "Fresh rules only." }] },
      { say: "Clearing memory.", steps: [{ kind: "memory", action: "clear", prompt: "" }] },
    ]);
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go", model: "", projectsFolder: "" } });

    // Append runs freely in go mode
    await ctx.svc.orchestratorAsk("remember Use strict TypeScript");
    await until(() => ctx.svc.orchestratorReadMemory().includes("Use strict TypeScript"));

    // Set holds for Go even in "go" mode, and produces an Undo token
    const setSteps = resolvePlan({ say: "", steps: [{ kind: "memory", action: "set", prompt: "Fresh" }] }, { workspaces: [], engines: [], running: [] });
    expect(holdsForGo(setSteps[0])).toBe(true);
    await ctx.svc.orchestratorAsk("replace memory with Fresh rules only");
    const setTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(setTurn.plan).toBe("waiting");
    await ctx.svc.orchestratorRun(setTurn.id);
    const setUndo = ctx.svc.orchestratorView().turns.at(-1)?.steps?.[0].undo;
    expect(setUndo).toBeTruthy();
    expect(ctx.svc.orchestratorReadMemory().trim()).toBe("Fresh rules only.");

    // Undo restores previous content!
    ctx.svc.undoDelete(setUndo!);
    expect(ctx.svc.orchestratorReadMemory()).toContain("Use strict TypeScript.");

    // Clear also holds for Go and can be undone
    await ctx.svc.orchestratorAsk("clear viby memory");
    const clrTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(clrTurn.plan).toBe("waiting");
    await ctx.svc.orchestratorRun(clrTurn.id);
    const clrUndo = ctx.svc.orchestratorView().turns.at(-1)?.steps?.[0].undo;
    expect(ctx.svc.orchestratorReadMemory()).toBe("");
    ctx.svc.undoDelete(clrUndo!);
    expect(ctx.svc.orchestratorReadMemory()).toContain("Use strict TypeScript.");
  });

  it("archives, switches, renames, deletes, and undoes Viby conversation threads", async () => {
    const ctx = withPlanner([
      { say: "First thread answer.", steps: [] },
      { say: "Second thread answer.", steps: [] },
    ]);
    await ctx.svc.orchestratorAsk("First topic");
    const t1 = ctx.svc.orchestratorView().activeThreadId!;
    expect(t1).toBeTruthy();

    ctx.svc.orchestratorClear();
    const t2 = ctx.svc.orchestratorView().activeThreadId!;
    expect(t2).not.toBe(t1);
    await ctx.svc.orchestratorAsk("Second topic");

    ctx.svc.orchestratorRenameThread(t1, "Renamed Thread One");
    const threads = ctx.svc.orchestratorView().threads ?? [];
    expect(threads.find((t) => t.id === t1)?.title).toBe("Renamed Thread One");

    ctx.svc.orchestratorSelectThread(t1);
    expect(ctx.svc.orchestratorView().activeThreadId).toBe(t1);
    expect(ctx.svc.orchestratorView().turns[0].text).toBe("First topic");

    const del = ctx.svc.orchestratorDeleteThread(t2);
    expect((ctx.svc.orchestratorView().threads ?? []).some((t) => t.id === t2)).toBe(false);
    ctx.svc.undoDelete(del.undo);
    expect((ctx.svc.orchestratorView().threads ?? []).some((t) => t.id === t2)).toBe(true);
  });

  it("waits on all parallel wave CLIs before after:true and runs verify with isolated auto-fix retries", async () => {
    const repo = gitRepo();
    let nowMs = Date.now();
    const ctx = withPlanner(
      [
        {
          say: "Running two CLIs then verifying.",
          steps: [
            { kind: "start", engine: "claude", workspace: "shop", branch: "wave-a", prompt: "part a" },
            { kind: "start", engine: "claude", workspace: "shop", branch: "wave-b", prompt: "part b" },
            { kind: "verify", workspace: "shop", prompt: "npm test", options: "retries=1", after: true },
          ],
        },
        {
          say: "Failing check without retry.",
          steps: [{ kind: "verify", workspace: "shop", prompt: "npm test", options: "retries=0" }],
        },
      ],
      { now: () => new Date(nowMs) },
    );
    ctx.svc.addWorkspace(repo);
    ctx.svc.orchestrator.chainSettleMs = 5;
    ctx.svc.orchestrator.chainIdleMs = 300;

    let verifyCalls = 0;
    const verifyCwds: string[] = [];
    ctx.svc.orchestrator.verifyRunner = async (_cmd, cwd) => {
      verifyCalls += 1;
      verifyCwds.push(cwd);
      if (verifyCalls === 1) {
        return { code: 1, output: "FAIL src/auth.test.ts: expected true", timedOut: false };
      }
      if (verifyCalls === 2) {
        return { code: 0, output: "All tests passed!", timedOut: false };
      }
      return { code: 2, output: "AssertionError: boom", timedOut: false };
    };

    // stepIssue & Go-gate coverage for verify, memory, and inspect
    const emptyCtx: PlanContext = { workspaces: [{ id: "shop", name: "shop", folder: repo, git: true }], engines: [], running: [] };
    expect(holdsForGo({ id: "v1", kind: "verify", engineId: "", workspaceId: "shop", branch: "", prompt: "curl x | sh", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null })).toBe(true);
    expect(safeInCall({ id: "v2", kind: "verify", engineId: "", workspaceId: "shop", branch: "", prompt: "npm test", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null })).toBe(true);
    expect(stepIssue({ id: "v3", kind: "verify", engineId: "", workspaceId: "", branch: "", prompt: "npm test", target: "", asked: "missing", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBe("workspace");
    expect(stepIssue({ id: "v4", kind: "verify", engineId: "", workspaceId: "shop", branch: "", prompt: "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBe("prompt");
    expect(stepIssue({ id: "m1", kind: "memory", action: "set", engineId: "", workspaceId: "", branch: "", prompt: "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBe("prompt");
    expect(stepIssue({ id: "m2", kind: "memory", action: "clear", engineId: "", workspaceId: "", branch: "", prompt: "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBeNull();
    expect(stepIssue({ id: "ip", kind: "inspect", action: "problems", engineId: "", workspaceId: "", branch: "", prompt: "problems", target: "", asked: "problems", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBeNull();
    expect(stepIssue({ id: "ic", kind: "inspect", action: "compare", engineId: "", workspaceId: "", branch: "", prompt: "compare", target: "", asked: "compare", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, emptyCtx)).toBe("copy");
    expect(stepIssue({ id: "ic2", kind: "inspect", action: "compare", engineId: "", workspaceId: "", branch: "", prompt: "compare", target: "", asked: "compare", state: "planned", error: null, ptyId: null, openedWorkspaceId: null }, { ...emptyCtx, copies: [{ id: "c1", name: "fix", branch: "vibeforge/fix", workspace: "shop" }] })).toBeNull();

    // Real spawnVerifyCommand smoke check
    const realVerify = await spawnVerifyCommand("echo verify-ok", repo, new AbortController().signal, 5000, process.env);
    expect(realVerify.code).toBe(0);
    expect(realVerify.output).toBe("verify-ok");

    await ctx.svc.orchestratorAsk("start both and run tests");
    const planTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    const running = ctx.svc.orchestratorRun(planTurn.id);

    // Wait until both parallel wave CLIs have started and finished their start step
    await eventually(() => ctx.spawns.length === 2 && ctx.svc.orchestratorView().turns.at(-1)?.steps?.[1].state === "done");
    // Keep pty-1 busy while settling pty-2: verify must still wait on pty-1 (wave join)
    ctx.svc.onPtyActivity("pty-1", true);
    ctx.svc.onPtyActivity("pty-2", true);
    ctx.svc.onPtyActivity("pty-2", false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(verifyCalls).toBe(0);

    // Settle pty-1 so verify attempt 1 runs, fails, and queues fix tail to pty-2
    ctx.svc.onPtyActivity("pty-1", false);
    await eventually(() => verifyCalls === 1);
    nowMs += 6000;
    await eventually(() => ctx.sent.some((m) => m.ptyId === "pty-2" && m.text.includes("FAIL src/auth.test.ts")));

    // Settle pty-2 after receiving the fix prompt so verify attempt 2 runs and passes
    ctx.svc.onPtyActivity("pty-2", true);
    ctx.svc.onPtyActivity("pty-2", false);
    await running;

    expect(verifyCalls).toBe(2);
    const doneTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(doneTurn.steps?.[2].state).toBe("done");
    expect(doneTurn.steps?.[2].result).toBe("Passed after 1 fix round.");
    expect(doneTurn.checks?.find((c) => c.kind === "verify")?.summary).toBe("Passed after 1 fix");
    // Verify ran inside the isolated worktree copy, not the untouched main repo
    expect(verifyCwds[0]).not.toBe(repo);

    // Retries exhausted failure path records Exit check & marks step failed
    await ctx.svc.orchestratorAsk("verify again without retries");
    const failPlan = ctx.svc.orchestratorView().turns.at(-1)!;
    await ctx.svc.orchestratorRun(failPlan.id);
    const failTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(failTurn.steps?.[0].state).toBe("failed");
    expect(failTurn.steps?.[0].error).toBe("Verification failed (2): npm test.");
    expect(failTurn.checks?.find((c) => c.kind === "verify")?.summary).toBe("Exit 2");
  });

  it("streams TTS sentence-by-sentence and reads Copilot & OpenCode session logs with prompt disambiguation", async () => {
    const chunks = splitForSpeech("First sentence is quick. Second sentence gives detail. Third sentence finishes cleanly.");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(splitForSpeech("Short phrase.")).toEqual(["Short phrase."]);
    expect(splitForSpeech("")).toEqual([]);
    const commaSentence = Array.from({ length: 10 }, (_, idx) => `clause number ${idx}`).join(", ");
    expect(splitForSpeech(commaSentence, 45, 70).length).toBeGreaterThanOrEqual(3);
    const longText = `${"Alpha beta gamma delta epsilon. ".repeat(12)}`;
    const splitLong = splitForSpeech(longText, 90, 140);
    expect(splitLong.length).toBeGreaterThanOrEqual(3);
    expect(splitLong[0].length).toBeLessThanOrEqual(90);

    // Copilot log parsing, cwd extraction, startsTurn, & multi-session disambiguation
    expect(replyLogFor("copilot", "copilot")).toBe("copilot");
    expect(replyLogFor("opencode", "opencode")).toBe("opencode");
    expect(copilotLogCwd(JSON.stringify({ type: "session.start", data: { cwd: "/tmp/fallback" } }))).toBe("/tmp/fallback");
    expect(copilotLogCwd("{bad json")).toBeNull();
    expect(startsTurn("copilot", { type: "user.message", data: { content: "hi" } })).toBe(true);
    expect(startsTurn("opencode", { type: "user", time: 1, text: "hi" })).toBe(true);
    expect(copilotTurn([{ type: "user.message", timestamp: 1000, data: { prompt: "check" } }, { type: "user.message", timestamp: 2000, data: { prompt: "next" } }], 900).reply).toBeNull();
    expect(copilotTurn([{ type: "user.message", timestamp: 1000, data: { prompt: "check" } }, { type: "assistant.message", timestamp: 1100, data: { text: "All good" } }, { type: "assistant.turn_end", timestamp: 1200 }], 900).reply).toBe("All good");
    expect(opencodeTurn([{ type: "user", time: 1000, text: "one" }, { type: "user", time: 2000, text: "two" }], 900).reply).toBeNull();
    expect(opencodeTurn([{ type: "user", time: 1000, text: "one" }, { type: "assistant", time: 1100, text: "End" }, { type: "turn_end", time: 1200 }], 900).reply).toBe("End");
    expect(lastReplyIn("opencode", [{ type: "user", time: 1000, text: "match me" }, { type: "assistant", time: 1100, text: "Matched reply", done: true }], "", "match me")).toBe("Matched reply");
    const fakeHome = tempDir();
    const cwd = path.join(fakeHome, "proj");
    const copilotBase = path.join(fakeHome, ".copilot", "session-state");
    fs.mkdirSync(path.join(copilotBase, "s1"), { recursive: true });
    fs.mkdirSync(path.join(copilotBase, "s2"), { recursive: true });
    const t0 = Date.now() - 10_000;
    const makeCopilotEvents = (prompt: string, reply: string, tsOffset: number) =>
      [
        JSON.stringify({ type: "session.start", timestamp: new Date(t0 + tsOffset).toISOString(), data: { context: { cwd } } }),
        JSON.stringify({ type: "user.message", timestamp: new Date(t0 + tsOffset + 100).toISOString(), data: { content: prompt } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(t0 + tsOffset + 200).toISOString(), data: { content: reply } }),
        JSON.stringify({ type: "assistant.turn_end", timestamp: new Date(t0 + tsOffset + 300).toISOString() }),
      ].join("\n");
    fs.writeFileSync(path.join(copilotBase, "s1", "events.jsonl"), makeCopilotEvents("fix auth bug", "Fixed auth token validation.", 0));
    fs.writeFileSync(path.join(copilotBase, "s2", "events.jsonl"), makeCopilotEvents("write readme docs", "Updated README sections.", 500));

    expect(copilotTurn(fs.readFileSync(path.join(copilotBase, "s1", "events.jsonl"), "utf8"), t0, "auth").reply).toBe("Fixed auth token validation.");
    const disamb = await lastReply({ kind: "copilot", home: fakeHome, cwd, since: t0, words: "fix auth bug" });
    expect(disamb).toBe("Fixed auth token validation.");

    // OpenCode SQLite DB read-only reader
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(fakeHome, ".local", "share");
    try {
      const ocDir = path.join(process.env.XDG_DATA_HOME, "opencode");
      fs.mkdirSync(ocDir, { recursive: true });
      const db = new DatabaseSync(path.join(ocDir, "opencode.db"));
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `);
      db.prepare("INSERT INTO session VALUES (?, ?, ?)").run("oc-1", cwd, t0 + 1000);
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", "oc-1", t0 + 100, JSON.stringify({ role: "user" }));
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("p1", "m1", "oc-1", t0 + 110, JSON.stringify({ type: "text", text: "refactor parser" }));
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m2", "oc-1", t0 + 200, JSON.stringify({ role: "assistant", time: { completed: t0 + 300 } }));
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("p2", "m2", "oc-1", t0 + 210, JSON.stringify({ type: "text", text: "Parser refactored cleanly." }));
      db.close();

      expect(opencodeTurn([{ type: "user", time: t0 + 100, text: "refactor parser" }, { type: "assistant", time: t0 + 200, text: "Done.", done: true }], t0).reply).toBe("Done.");
      expect(lastReplyIn("opencode", [{ type: "user", time: t0 + 100, text: "refactor parser" }, { type: "assistant", time: t0 + 200, text: "Done.", done: true }])).toBe("Done.");
      const ocReply = await lastReply({ kind: "opencode", home: fakeHome, cwd, since: t0, words: "refactor parser" });
      expect(ocReply).toBe("Parser refactored cleanly.");
      const ac = new AbortController();
      const watched = await watchReply({ kind: "opencode", home: fakeHome, cwd, since: t0, words: "refactor parser", signal: ac.signal });
      expect(watched).toBe("Parser refactored cleanly.");
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });

  it("exposes activity, threads, and viby.md memory on Phone Companion", async () => {
    const ctx = withPlanner([{ say: "Phone reply.", steps: [] }]);
    await ctx.svc.orchestratorAsk("Hello from desktop");
    const firstId = ctx.svc.orchestratorView().activeThreadId!;
    const phone = orchestratorFor({ service: ctx.svc, canHear: () => true, log: () => undefined });

    phone.writeMemory?.("Always verify before Apply.");
    expect(phone.readMemory?.()).toBe("Always verify before Apply.");

    const snap = phone.view();
    expect(snap.activeThreadId).toBe(firstId);
    expect(snap.hasMemory).toBe(true);
    expect(snap.threads?.length).toBeGreaterThanOrEqual(1);

    const directPhone = buildPhoneOrchestrator({
      view: {
        engineId: "grok",
        engineReady: true,
        mode: "plan",
        thinking: true,
        activity: { kind: "verify", label: "shop" },
        turns: [],
        activeThreadId: firstId,
        threads: snap.threads,
        hasMemory: true,
      },
      engines: [{ id: "grok", label: "Grok Build", bin: "grok", available: true }],
      workspaces: [],
      live: [],
      hear: true,
    });
    expect(directPhone.activity).toEqual({ kind: "verify", label: "shop" });
    expect(directPhone.hasMemory).toBe(true);

    // /new shortcut on phone clears cleanly; normal ask triggers planner synchronously (thinking=true)
    phone.ask("/new");
    expect(phone.view().turns).toHaveLength(0);
    phone.selectThread?.(firstId);
    expect(phone.view().turns.length).toBe(2);
  });

  it("validates, stores, serves, and passes pasted screenshots across multimodal CLIs and Phone", async () => {
    const TINY_PNG =
      "data:image/png;base64," +
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).toString("base64");
    const TINY_JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
    const BAD_MAGIC = "data:image/png;base64," + Buffer.from("not-really-a-png").toString("base64");
    const TOO_BIG = "data:image/png;base64," + Buffer.alloc(MAX_IMAGE_BYTES + 16, 0x89).toString("base64");

    const imgDir = path.join(tempDir(), "images");
    const saved = savePastedImages(imgDir, [TINY_PNG, TINY_JPEG, TINY_PNG, TINY_PNG, TINY_JPEG]);
    expect(saved).toHaveLength(MAX_IMAGES_PER_TURN);
    expect(saved[0].filename).toMatch(/^img-[a-z0-9-]+\.png$/);
    expect(saved[1].filename).toMatch(/^img-[a-z0-9-]+\.jpg$/);
    expect(readSavedImageDataUrl(imgDir, saved[0].filename)).toBe(TINY_PNG);
    expect(readSavedImageDataUrl(imgDir, "../secret.png")).toBeNull();
    expect(() => savePastedImages(imgDir, [BAD_MAGIC])).toThrow("Unsupported image format.");
    expect(() => savePastedImages(imgDir, [TOO_BIG])).toThrow("That image is larger than 10 MB.");

    // Codex receives --image flags; Claude receives stream-json stdin & parses result NDJSON.
    const codexArgs = brainArgs(
      { id: "codex", label: "Codex", bin: "codex", args: [] },
      { text: "Fix button alignment", rules: "Rules", sessionId: "s1", resume: false, schemaFile: "/tmp/schema.json", images: ["/tmp/a.png"] },
    );
    expect(codexArgs).toContain("--image");
    expect(codexArgs).toContain("/tmp/a.png");

    const claudeArgs = brainArgs(
      { id: "claude", label: "Claude Code", bin: "claude", args: [] },
      { text: "Fix alignment", rules: "Rules", sessionId: "s2", resume: false, images: ["/tmp/a.png"] },
    );
    expect(claudeArgs).toContain("stream-json");
    expect(claudeArgs).not.toContain("--");
    const stdinPayload = JSON.parse(claudeImageStdin("Fix alignment", [{ mediaType: "image/png", base64: "AAAA" }]).trim()) as {
      type: string;
      message: { content: Array<{ type: string; source?: { media_type: string; data: string }; text?: string }> };
    };
    expect(stdinPayload.type).toBe("user");
    expect(stdinPayload.message.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png", data: "AAAA" } });
    expect(stdinPayload.message.content[1]).toEqual({ type: "text", text: "Fix alignment" });

    const streamOut = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-9" }),
      JSON.stringify({ type: "result", session_id: "sess-9", is_error: false, structured_output: { say: "Looks crooked.", steps: [] } }),
    ].join("\n");
    expect(readBrainOutput(streamOut)).toMatchObject({ sessionId: "sess-9", plan: { say: "Looks crooked.", steps: [] } });

    // End-to-end Claude ask with image-only message (empty text) + Phone Companion imageData.
    const ctx = setup();
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [] });
    fs.writeFileSync(file, JSON.stringify(engines));
    ctx.svc.saveSettings({ orchestrator: { engine: "claude", mode: "plan", model: "", projectsFolder: "" } });
    let capturedStdin: string | undefined;
    ctx.svc.orchestrator.runner = async (_argv, _cwd, _signal, _timeoutMs, stdin): Promise<BrainRun> => {
      capturedStdin = stdin;
      return {
        code: 0,
        stdout: JSON.stringify({ type: "result", session_id: "c1", is_error: false, structured_output: { say: "I see the overlap.", steps: [] } }),
        stderr: "",
        timedOut: false,
      };
    };

    await ctx.svc.orchestratorAsk("", null, [TINY_PNG]);
    const view = ctx.svc.orchestratorView();
    const youTurn = view.turns.find((t) => t.from === "you");
    expect(youTurn?.images).toHaveLength(1);
    expect(ctx.svc.orchestratorImageData(youTurn!.images![0])).toBe(TINY_PNG);
    expect(capturedStdin).toContain(youTurn!.images![0]);
    expect(view.turns.find((t) => t.from === "vibeforge")?.text).toBe("I see the overlap.");

    const phone = orchestratorFor({ service: ctx.svc, canHear: () => false, log: () => undefined });
    expect(phone.imageData?.(youTurn!.images![0])).toBe(TINY_PNG);
    expect(phone.imageData?.("../evil.png")).toBeNull();
  });
});
