import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatScheduleBrief,
  holdsForGo,
  orchestratorRules,
  parseOptions,
  parseRoutineSchedule,
  parseWorkbenchAction,
  resolvePlan,
  resolveSettingsStep,
  safeInCall,
  stepIssue,
  withPlannedWorkspaces,
  type PlanContext,
} from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import { MEMORY_STARTER } from "../../src/core/store/library.js";
import { setup, tempDir } from "./fixtures/service-harness.js";

function gitRepo(name = "repo"): string {
  const dir = path.join(tempDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  git("add", "README.md");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

function withPlanner(answers: Array<Record<string, unknown> | string>, opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: "" } });
  const shown: Array<{ route: unknown; focus?: boolean }> = [];
  let stopDownloadCalls = 0;
  ctx.host.show = (route, focus) => shown.push({ route, focus });
  ctx.host.voiceStopDownload = () => {
    stopDownloadCalls += 1;
  };
  ctx.host.screen = async () => "All checks passed.\n> ";
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  ctx.svc.orchestrator.runner = async (argv, cwd): Promise<BrainRun> => {
    calls.push({ argv, cwd });
    const next = answers.shift() ?? { say: "", steps: [] };
    const stdout = typeof next === "string" ? next : JSON.stringify({ text: "", structuredOutput: next });
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  return { ...ctx, calls, shown, stopDownloadCalls: () => stopDownloadCalls };
}

async function askAndRun(ctx: ReturnType<typeof withPlanner>, words: string) {
  await ctx.svc.orchestratorAsk(words);
  const turn = ctx.svc.orchestratorView().turns.at(-1);
  if (turn?.plan === "waiting") {
    await ctx.svc.orchestratorRun(turn.id);
  }
  return ctx.svc.orchestratorView().turns.find((t) => t.id === turn?.id) ?? turn;
}

describe("full-app control parsers and validators", () => {
  it("parses cron, intervals, and natural spoken schedules into valid Schedule objects", () => {
    expect(parseRoutineSchedule("0 9 * * 1-5")).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(parseRoutineSchedule("every 30 minutes")).toEqual({ kind: "every", minutes: 30 });
    expect(parseRoutineSchedule("every 2 hours")).toEqual({ kind: "every", minutes: 120 });
    expect(parseRoutineSchedule("every 1 day")).toEqual({ kind: "every", minutes: 1440 });
    expect(parseRoutineSchedule("hourly")).toEqual({ kind: "cron", expr: "0 * * * *" });
    expect(parseRoutineSchedule("30m")).toEqual({ kind: "every", minutes: 30 });
    expect(parseRoutineSchedule("weekdays at 9am")).toEqual({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(parseRoutineSchedule("daily at 6:30pm")).toEqual({ kind: "cron", expr: "30 18 * * *" });
    expect(parseRoutineSchedule("every Monday at 10am")).toEqual({ kind: "cron", expr: "0 10 * * 1" });
    expect(parseRoutineSchedule("Mon,Wed,Fri at 8:15am")).toEqual({ kind: "cron", expr: "15 8 * * 1,3,5" });
    expect(parseRoutineSchedule("weekends at 11am")).toEqual({ kind: "cron", expr: "0 11 * * 0,6" });
    expect(parseRoutineSchedule("daily at noon")).toEqual({ kind: "cron", expr: "0 12 * * *" });
    expect(parseRoutineSchedule("daily at midnight")).toEqual({ kind: "cron", expr: "0 0 * * *" });
    expect(formatScheduleBrief({ kind: "every", minutes: 90 })).toBe("every 90 minutes");
    expect(formatScheduleBrief({ kind: "every", minutes: 120 })).toBe("every 2 hours");
    expect(formatScheduleBrief({ kind: "cron", expr: "0 9 * * 1-5" })).toBe("0 9 * * 1-5");

    // Invalid schedules
    expect(parseRoutineSchedule("")).toBeNull();
    expect(parseRoutineSchedule("every 2 minutes")).toBeNull();
    expect(parseRoutineSchedule("every 30 days")).toBeNull();
    expect(parseRoutineSchedule("60 9 * * *")).toBeNull();
    expect(parseRoutineSchedule("sometime next tuesday maybe")).toBeNull();
  });

  it("parses tri-state option strings and workbench undo actions", () => {
    const opts = parseOptions('allowRoutines=false, tier=strong; voice="lessac", notify=yes');
    expect(opts.bool("allowRoutines")).toBe(false);
    expect(opts.bool("notify")).toBe(true);
    expect(opts.str("tier")).toBe("strong");
    expect(opts.str("voice")).toBe("lessac");
    expect(opts.has("missing")).toBe(false);

    expect(parseWorkbenchAction({ prompt: "undo" })).toEqual({ op: "undo" });
    expect(parseWorkbenchAction({ prompt: "undo", target: "tok-123" })).toEqual({ op: "undo", token: "tok-123" });
    expect(parseWorkbenchAction({ action: "undo-delete" })).toEqual({ op: "undo" });
  });

  it("resolves new settings: rail, companion nudges, voice stopDownload, and custom engines", () => {
    const engines = [
      { id: "claude", label: "Claude Code", available: true, bin: "claude" },
      { id: "grok", label: "Grok Build", available: true, bin: "grok" },
    ];
    expect(resolveSettingsStep({ target: "voice.stopDownload" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-stop-download" },
    });
    expect(resolveSettingsStep({ target: "companion.nudges", prompt: "Keep going | Check tests" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { companion: { nudges: ["Keep going", "Check tests"] } } },
    });
    expect(resolveSettingsStep({ target: "rail.hide", prompt: "skills, routines" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "rail", mode: "hide", views: ["skills", "routines"] },
    });
    // Code is pinned and cannot be hidden
    expect(resolveSettingsStep({ target: "rail.hide", prompt: "code" }, { engines }).issue).toBe("prompt");
    expect(resolveSettingsStep({ target: "rail.show", prompt: "skills" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "rail", mode: "show", views: ["skills"] },
    });
    expect(resolveSettingsStep({ target: "rail.order", prompt: "code, viby, agents" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "rail", mode: "order", views: ["code", "orchestrator", "agents"] },
    });
    expect(resolveSettingsStep({ target: "engines.recheck" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "engines-recheck" },
    });
    expect(
      resolveSettingsStep(
        { target: "engines.add", engine: "aider", name: "Aider", folder: "aider", prompt: "--no-auto-commits", options: "continueArgs=--restore-chat-history" },
        { engines },
      ),
    ).toMatchObject({
      issue: null,
      action: {
        op: "engine-save",
        row: { id: "aider", label: "Aider", bin: "aider", args: ["--no-auto-commits"], continueArgs: ["--restore-chat-history"] },
      },
    });
    expect(resolveSettingsStep({ target: "engines.remove", engine: "grok" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "engine-remove", id: "grok" },
    });
  });

  it("chains newly created workspace, skill, agent, task, routine, and deep-link show across one plan without validation issues", () => {
    const baseCtx: PlanContext = {
      workspaces: [],
      engines: [{ id: "claude", label: "Claude Code", available: true, bin: "claude" }],
      running: [],
      projectsFolder: "~/Projects",
    };
    const steps = resolvePlan(
      {
        say: "Setting up your whole review pipeline.",
        steps: [
          { kind: "workspace", action: "create", name: "Acme", folder: "~/Projects/Acme", git: true },
          { kind: "skill", action: "create", name: "Security Audit", description: "Check auth", prompt: "# Security\nReview auth flows." },
          {
            kind: "agent",
            action: "create",
            name: "Sentinel",
            engine: "Claude Code",
            prompt: "You are a strict security reviewer.",
            places: ["Acme"],
            skills: ["Security Audit"],
            options: "tier=strong, allowRoutines=true",
          },
          { kind: "task", action: "create", name: "Weekly Auth Audit", prompt: "Audit all OAuth routes.", agent: "Sentinel", workspace: "Acme" },
          { kind: "routine", action: "create", name: "Monday Security Pass", task: "Weekly Auth Audit", schedule: "every Monday at 9am" },
          { kind: "show", target: "Sentinel", options: "tab=memory" },
        ],
      },
      baseCtx,
    );
    expect(steps).toHaveLength(6);
    const checked = withPlannedWorkspaces(baseCtx, steps);
    expect(steps.map((s) => stepIssue(s, checked))).toEqual([null, null, null, null, null, null]);
    expect(steps[2].places).toEqual([`new:${steps[0].id}`]);
    expect(steps[2].skills).toEqual([`new:${steps[1].id}`]);
    expect(steps[4].agentId).toBe(`new:${steps[2].id}`);
    expect(steps[4].taskId).toBe(`new:${steps[3].id}`);
    expect(steps[5].route).toEqual({ view: "agents", agentId: `new:${steps[2].id}`, tab: "memory" });
  });

  it("holds destructive steps for Go while letting non-destructive steps auto-run", () => {
    const ctx: PlanContext = {
      workspaces: [{ id: "ws1", name: "Acme", folder: "/tmp/acme", git: true }],
      engines: [{ id: "claude", label: "Claude Code", available: true, bin: "claude" }],
      agents: [{ id: "ag1", name: "Atlas", engine: "claude", places: ["/tmp/acme"] }],
      skills: [{ id: "sk1", name: "Audit" }],
      tasks: [{ id: "tk1", title: "Fix bug", status: "todo", workspaceId: "ws1", agentId: "ag1" }],
      routines: [{ id: "rt1", name: "Daily", schedule: "0 9 * * *", enabled: true, agentId: "ag1" }],
      chats: [{ id: "ch1", title: "Scratch", engine: "claude", live: false }],
      runs: [{ id: "rn1", title: "Run 1", status: "exited", engine: "claude", origin: "task", opened: false }],
      running: [],
    };
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "agent", action: "create", name: "Scout", engine: "claude", prompt: "Explore code.", places: ["Acme"] },
          { kind: "agent", action: "delete", target: "Atlas" },
          { kind: "agent", action: "memory-clear", target: "Atlas" },
          { kind: "skill", action: "delete", target: "Audit" },
          { kind: "routine", action: "delete", target: "Daily" },
          { kind: "task", action: "delete", target: "Fix bug" },
          { kind: "task", action: "status", target: "Fix bug", status: "done" },
          { kind: "workspace", action: "remove", target: "Acme" },
          { kind: "chat", action: "delete", target: "Scratch" },
          { kind: "run", action: "tidy" },
          { kind: "settings", target: "engines.remove", engine: "claude" },
        ],
      },
      ctx,
    );
    expect(steps.map((s) => holdsForGo(s, ctx))).toEqual([
      true, // agent create: a new agent with folders, a CLI and a brief waits for Go (D1)
      true, // agent delete
      true, // agent memory-clear
      true, // skill delete
      true, // routine delete
      true, // task delete
      false, // task status
      true, // workspace remove
      true, // chat delete
      true, // run tidy
      true, // settings engines.remove
    ]);
    expect(safeInCall(steps[0], ctx)).toBe(false); // a new agent waits for Go in a call too (D1)
    expect(safeInCall(steps[1], ctx)).toBe(false);
    expect(orchestratorRules(ctx)).toContain("Atlas");
    expect(orchestratorRules(ctx)).toContain("Audit");
    expect(orchestratorRules(ctx)).toContain("Fix bug");
    expect(orchestratorRules(ctx)).toContain("Daily");
    expect(orchestratorRules(ctx)).toContain("Scratch");
    expect(orchestratorRules(ctx)).toContain("Run 1");
  });
});

describe("end-to-end Viby full-app control via TeamService", () => {
  it("executes a multi-step chained plan creating workspace, skill, agent, task, routine, and deep-link show", async () => {
    const projectsRoot = tempDir();
    const newRepoPath = path.join(projectsRoot, "Orion");
    const ctx = withPlanner([
      {
        say: "Creating Orion, the Code Review skill, your Reviewer agent, the audit task, and scheduling it weekdays at 9am.",
        steps: [
          { kind: "workspace", action: "create", name: "Orion", folder: newRepoPath, git: true },
          { kind: "skill", action: "create", name: "Code Review", description: "Thorough PR checklist", prompt: "# Checklist\nCheck edge cases and tests." },
          {
            kind: "agent",
            action: "create",
            name: "Reviewer",
            engine: "Argy",
            description: "Finds subtle bugs",
            prompt: "Review code carefully and flag bugs.",
            places: ["Orion"],
            skills: ["Code Review"],
            options: "tier=strong, allowRoutines=true",
          },
          {
            kind: "task",
            action: "create",
            name: "Nightly Lint Sweep",
            prompt: "Run linter and report issues.",
            agent: "Reviewer",
            workspace: "Orion",
            options: "isolated=false",
          },
          {
            kind: "routine",
            action: "create",
            name: "Weekday Audit",
            task: "Nightly Lint Sweep",
            schedule: "weekdays at 9am",
            prompt: "Post a concise summary at the end.",
            options: "notify=false, shareCheckout=true",
          },
          { kind: "show", target: "Reviewer", options: "tab=skills" },
        ],
      },
    ]);

    const turn = await askAndRun(ctx, "Set up Orion with a Reviewer agent, Code Review skill, audit task, and weekday routine.");
    expect(turn?.plan).toBe("done");
    expect(turn?.steps?.every((s) => s.state === "done")).toBe(true);

    const workspaces = ctx.svc.listWorkspaces().workspaces;
    const orion = workspaces.find((w) => w.name === "Orion");
    expect(orion).toBeTruthy();
    expect(fs.existsSync(path.join(newRepoPath, ".git"))).toBe(true);

    const skills = ctx.svc.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "Code Review", description: "Thorough PR checklist" });

    const agents = ctx.svc.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "Reviewer",
      engine: "argy",
      goodAt: "Finds subtle bugs",
      tier: "strong",
      allowRoutines: true,
      places: [path.resolve(newRepoPath)],
      skills: [skills[0].id],
    });

    const tasks = ctx.svc.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Nightly Lint Sweep",
      status: "todo",
      agentId: agents[0].id,
      workspaceId: orion?.id,
      isolated: false,
    });
    // action: "create" adds to board without spawning a CLI
    expect(ctx.spawns).toHaveLength(0);

    const routines = ctx.svc.listRoutines();
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      name: "Weekday Audit",
      agentId: agents[0].id,
      schedule: { kind: "cron", expr: "0 9 * * 1-5" },
      notify: false,
      shareCheckout: true,
      enabled: true,
    });
    expect(routines[0].prompt).toContain("Task: Nightly Lint Sweep");
    expect(routines[0].prompt).toContain("Run linter and report issues.");
    expect(routines[0].prompt).toContain("Post a concise summary at the end.");

    expect(ctx.shown.at(-1)?.route).toEqual({ view: "agents", agentId: agents[0].id, tab: "skills" });
  });

  it("manages saved agents end-to-end: edit, folders, skills, memory, inspect, delete, and voice undo", async () => {
    const repo1 = gitRepo("alpha");
    const repo2 = gitRepo("beta");
    const ctx = withPlanner([
      // Turn 1: create agent
      {
        say: "Creating Atlas.",
        steps: [
          { kind: "agent", action: "create", name: "Atlas", engine: "Argy", prompt: "Initial brief.", places: [repo1] },
        ],
      },
      // Turn 2: edit, add-folder, add-skill, memory-append
      {
        say: "Updating Atlas.",
        steps: [
          { kind: "agent", action: "edit", target: "Atlas", name: "Atlas Prime", engine: "Pasty", description: "Backend refactors", options: "tier=everyday, allowRoutines=false" },
          { kind: "agent", action: "add-folder", target: "Atlas", places: [repo2] },
          { kind: "agent", action: "add-skill", target: "Atlas", skills: ["TDD"] },
          { kind: "agent", action: "memory-append", target: "Atlas", prompt: "Always run vitest before committing." },
        ],
      },
      // Turn 3 (inspect inline + final reply)
      {
        say: "Checking Atlas.",
        steps: [{ kind: "inspect", action: "agent", target: "Atlas Prime" }],
      },
      {
        say: "Atlas Prime remembers to run vitest and has TDD attached.",
        steps: [],
      },
      // Turn 4: remove folder, remove skill, memory-set, memory-clear, delete
      {
        say: "Cleaning up and deleting Atlas Prime.",
        steps: [
          { kind: "agent", action: "remove-folder", target: "Atlas Prime", places: [repo2] },
          { kind: "agent", action: "remove-skill", target: "Atlas Prime", skills: ["TDD"] },
          { kind: "agent", action: "memory-set", target: "Atlas Prime", prompt: "Fresh note." },
          { kind: "agent", action: "memory-clear", target: "Atlas Prime" },
          { kind: "agent", action: "delete", target: "Atlas Prime" },
        ],
      },
      // Turn 5: undo delete via workbench
      {
        say: "Undoing the delete.",
        steps: [{ kind: "workbench", prompt: "undo" }],
      },
    ]);
    ctx.svc.addWorkspace(repo1);
    ctx.svc.addWorkspace(repo2);
    const tdd = ctx.svc.saveSkill({ name: "TDD", description: "Test first", body: "Write failing tests first." });

    // Turn 1
    await askAndRun(ctx, "Create Atlas");
    expect(ctx.svc.listAgents()).toHaveLength(1);

    // Turn 2: resumed session should receive Updated library state with Atlas's real id!
    await askAndRun(ctx, "Update Atlas");
    const secondPrompt = ctx.calls[1].argv[ctx.calls[1].argv.indexOf("-p") + 1];
    expect(secondPrompt).toContain("(Updated library state:");
    expect(secondPrompt).toContain("Atlas");

    const updated = ctx.svc.listAgents()[0];
    expect(updated).toMatchObject({
      name: "Atlas Prime",
      engine: "pasty",
      goodAt: "Backend refactors",
      tier: "everyday",
      allowRoutines: false,
      places: [path.resolve(repo1), path.resolve(repo2)],
      skills: [tdd.id],
    });
    expect(ctx.svc.readMemory(updated.id)).toContain("Always run vitest before committing.");

    // Turn 3: inline inspect
    await ctx.svc.orchestratorAsk("Inspect Atlas Prime");
    const inspectTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(inspectTurn?.checks?.[0].details).toContain("Always run vitest before committing.");
    expect(inspectTurn?.text).toContain("Atlas Prime remembers");

    // Turn 4: remove folder, remove skill, memory-set, memory-clear, delete
    const delTurn = await askAndRun(ctx, "Delete Atlas Prime");
    expect(delTurn?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(delTurn?.steps?.at(-1)?.undo).toBeTruthy();
    expect(ctx.svc.listAgents()).toHaveLength(0);

    // Turn 5: undo via workbench
    const undoTurn = await askAndRun(ctx, "Undo that");
    expect(undoTurn?.steps?.[0].state).toBe("done");
    expect(ctx.svc.listAgents()).toHaveLength(1);
    expect(ctx.svc.listAgents()[0].name).toBe("Atlas Prime");
    expect(ctx.svc.readMemory(ctx.svc.listAgents()[0].id)).toBe(MEMORY_STARTER);
  });

  it("manages skills end-to-end: create, edit, attach, detach, set-agents, inspect, delete", async () => {
    const repo = gitRepo("skills-repo");
    const ctx = withPlanner([
      {
        say: "Managing skills.",
        steps: [
          { kind: "skill", action: "create", name: "Release", description: "Ship safely", prompt: "Tag and verify build.", agents: ["A1"] },
          { kind: "skill", action: "edit", target: "Release", description: "Ship safely v2", prompt: "Run tests, tag, verify." },
          { kind: "skill", action: "attach", target: "Release", agents: ["A2"] },
        ],
      },
      {
        say: "Detaching and clearing.",
        steps: [
          { kind: "skill", action: "detach", target: "Release", agents: ["A1"] },
          { kind: "skill", action: "set-agents", target: "Release", options: "agents=none" },
          { kind: "skill", action: "delete", target: "Release" },
        ],
      },
    ]);
    const a1 = ctx.svc.saveAgent({ name: "A1", brief: "b1", engine: "argy", places: [repo] });
    const a2 = ctx.svc.saveAgent({ name: "A2", brief: "b2", engine: "argy", places: [repo] });

    await askAndRun(ctx, "Create Release skill");
    const skill = ctx.svc.listSkills()[0];
    expect(skill).toMatchObject({ name: "Release", description: "Ship safely v2", body: "Run tests, tag, verify." });
    expect(ctx.svc.getAgent(a1.id)?.skills).toEqual([skill.id]);
    expect(ctx.svc.getAgent(a2.id)?.skills).toEqual([skill.id]);

    const delTurn = await askAndRun(ctx, "Remove Release skill");
    expect(delTurn?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(ctx.svc.listSkills()).toHaveLength(0);
    expect(ctx.svc.getAgent(a2.id)?.skills).toEqual([]);
  });

  it("manages routines end-to-end: create, edit, pause, resume, run, run-now, cancel-wait, delete", async () => {
    const repo = gitRepo("routine-repo");
    const ctx = withPlanner([
      {
        say: "Creating and updating routine.",
        steps: [
          { kind: "routine", action: "create", name: "Morning Check", agent: "Scout", schedule: "daily at 8am", prompt: "Check CI status." },
          { kind: "routine", action: "edit", target: "Morning Check", schedule: "every 45 minutes", prompt: "Check CI and lint.", options: "notify=false" },
          { kind: "routine", action: "disable", target: "Morning Check" },
          { kind: "routine", action: "enable", target: "Morning Check" },
          { kind: "routine", action: "run", target: "Morning Check" },
        ],
      },
      {
        say: "Deleting routine.",
        steps: [
          { kind: "routine", action: "cancel-wait", target: "Morning Check" },
          { kind: "routine", action: "delete", target: "Morning Check" },
        ],
      },
    ]);
    const scout = ctx.svc.saveAgent({ name: "Scout", brief: "Check status.", engine: "argy", places: [repo] });

    const t1 = await askAndRun(ctx, "Create and run Morning Check");
    expect(t1?.steps?.every((s) => s.state === "done")).toBe(true);
    const rt = ctx.svc.listRoutines()[0];
    expect(rt).toMatchObject({
      name: "Morning Check",
      agentId: scout.id,
      schedule: { kind: "every", minutes: 45 },
      prompt: "Check CI and lint.",
      notify: false,
      enabled: true,
    });
    expect(t1?.steps?.[4].ptyId).toBeTruthy();

    // Exit the run, then delete
    if (t1?.steps?.[4].ptyId) await ctx.exit(t1.steps[4].ptyId, 0);
    const t2 = await askAndRun(ctx, "Delete Morning Check");
    expect(t2?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(ctx.svc.listRoutines()).toHaveLength(0);
  });

  it("manages tasks end-to-end: create draft, edit, status, execute, stop, continue, handoff, apply/discard copy, delete", async () => {
    const repo = gitRepo("task-repo");
    const ctx = withPlanner([
      {
        say: "Creating and updating task.",
        steps: [
          { kind: "task", action: "create", name: "Fix Cache", prompt: "Add TTL.", agent: "Builder", workspace: "task-repo", options: "isolated=true" },
          { kind: "task", action: "edit", target: "Fix Cache", name: "Fix Cache TTL", prompt: "Add 60s TTL.", status: "review" },
          { kind: "task", action: "status", target: "Fix Cache TTL", status: "todo" },
          { kind: "task", action: "run", target: "Fix Cache TTL" },
        ],
      },
      {
        say: "Stopping and continuing.",
        steps: [
          { kind: "task", action: "stop", target: "Fix Cache TTL" },
          { kind: "task", action: "continue", target: "Fix Cache TTL", prompt: "Also add unit test." },
        ],
      },
      {
        say: "Discarding copy, handing off run, and deleting task.",
        steps: [
          { kind: "task", action: "discard", target: "Fix Cache TTL" },
          { kind: "task", action: "delete", target: "Fix Cache TTL" },
        ],
      },
    ]);
    const ws = ctx.svc.addWorkspace(repo).workspaces[0];
    const builder = ctx.svc.saveAgent({ name: "Builder", brief: "Write code.", engine: "argy", places: [repo] });
    const reviewer = ctx.svc.saveAgent({ name: "Reviewer", brief: "Review.", engine: "argy", places: [repo] });

    const t1 = await askAndRun(ctx, "Create and run Fix Cache");
    expect(t1?.steps?.every((s) => s.state === "done")).toBe(true);
    const task = ctx.svc.listTasks()[0];
    expect(task).toMatchObject({ title: "Fix Cache TTL", body: "Add 60s TTL.", status: "running", agentId: builder.id, workspaceId: ws.id, isolated: true });
    expect(task.copy).toBeTruthy();

    const t2 = await askAndRun(ctx, "Stop and continue Fix Cache TTL");
    expect(t2?.steps?.every((s) => s.state === "done")).toBe(true);
    const contPty = t2?.steps?.[1].ptyId;
    const contRunId = t2?.steps?.[1].runId;
    expect(contPty).toBeTruthy();
    if (contPty) await ctx.exit(contPty, 0);

    // Hand off the finished run to Reviewer
    const handoffCtxSteps = resolvePlan(
      { say: "Handing off.", steps: [{ kind: "task", action: "handoff", target: contRunId ?? "", agent: "Reviewer" }] },
      await ctx.svc.orchestrator.context(),
    );
    expect(handoffCtxSteps[0]).toMatchObject({ kind: "task", action: "handoff", agentId: reviewer.id });

    const t3 = await askAndRun(ctx, "Discard copy and delete task");
    expect(t3?.steps?.every((s) => s.state === "done")).toBe(true);
    // Discarding the copy can be undone from its step, as deleting can.
    expect(t3?.steps?.[0].undo).toBeTruthy();
    expect(ctx.svc.listTasks()).toHaveLength(0);
  });

  it("manages workspaces, chats, runs, talk, inspect storage/branches, and settings", async () => {
    const repoA = gitRepo("ws-alpha");
    const repoB = gitRepo("ws-beta");
    const ctx = withPlanner([
      // 1. Workspace rename, move; chat create+send, rename, set-engine, stop; settings updates
      {
        say: "Applying workspace, chat, and settings changes.",
        steps: [
          { kind: "workspace", action: "rename", target: "ws-alpha", name: "Alpha Prime" },
          { kind: "workspace", action: "move", target: "ws-beta", status: "top" },
          { kind: "chat", action: "create", engine: "Argy", name: "Quick Brainstorm", prompt: "List 3 ideas." },
          { kind: "chat", action: "rename", target: "Quick Brainstorm", name: "Launch Ideas" },
          { kind: "chat", action: "set-engine", target: "Launch Ideas", engine: "Pasty" },
          { kind: "chat", action: "stop", target: "Launch Ideas" },
          { kind: "settings", target: "rail.hide", prompt: "skills" },
          { kind: "settings", target: "companion.nudges", prompt: "Continue | Run tests" },
          { kind: "settings", target: "voice.stopDownload" },
          { kind: "settings", target: "engines.recheck" },
          { kind: "settings", target: "engines.add", engine: "customcli", name: "Custom CLI", folder: "argy", prompt: "--fast" },
        ],
      },
      // 2. Inspect storage & workspace branches (inline checks)
      {
        say: "Checking storage and branches.",
        steps: [
          { kind: "inspect", prompt: "storage" },
          { kind: "inspect", workspace: "Alpha Prime", prompt: "branches" },
        ],
      },
      {
        say: "Storage is clean and Alpha Prime is on main.",
        steps: [],
      },
      // 3. Run mark-reviewed, mark-unreviewed, mark-all-reviewed, handoff, tidy; remove workspace & custom engine; delete chat
      {
        say: "Managing runs and cleanup.",
        steps: [
          { kind: "run", action: "mark-all-reviewed" },
          { kind: "run", action: "tidy" },
          { kind: "chat", action: "delete", target: "Launch Ideas" },
          { kind: "workspace", action: "remove", target: "ws-beta" },
          { kind: "settings", target: "engines.remove", engine: "customcli" },
          { kind: "settings", target: "rail.show", prompt: "skills" },
        ],
      },
    ]);
    ctx.svc.addWorkspace(repoA);
    ctx.svc.addWorkspace(repoB);

    const t1 = await askAndRun(ctx, "Do workspace, chat, and settings updates");
    expect(t1?.steps?.every((s) => s.state === "done")).toBe(true);
    const wsOrder = ctx.svc.listWorkspaces().workspaces.map((w) => w.name);
    expect(wsOrder).toEqual(["ws-beta", "Alpha Prime"]);

    const chat = ctx.svc.listChats()[0];
    expect(chat).toMatchObject({ title: "Launch Ideas", engine: "pasty" });
    expect(ctx.svc.getSettings().rail.hidden).toContain("skills");
    expect(ctx.svc.getSettings().companion.nudges).toEqual(["Continue", "Run tests"]);
    expect(ctx.stopDownloadCalls()).toBe(1);
    expect(ctx.svc.listEngines().some((e) => e.id === "customcli")).toBe(true);

    // Inline inspect storage & branches
    await ctx.svc.orchestratorAsk("How much storage and what branches?");
    const inspectTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(inspectTurn?.checks).toHaveLength(2);
    expect(inspectTurn?.checks?.[0].details).toContain("VibeForge data root:");
    expect(inspectTurn?.checks?.[1].details).toContain("Local branches:");
    expect(inspectTurn?.checks?.[1].details).toContain("main (current)");

    // Cleanup turn
    const t3 = await askAndRun(ctx, "Tidy runs and clean up");
    expect(t3?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(ctx.svc.listChats()).toHaveLength(0);
    expect(ctx.svc.listWorkspaces().workspaces.map((w) => w.name)).toEqual(["Alpha Prime"]);
    expect(ctx.svc.listEngines().some((e) => e.id === "customcli")).toBe(false);
    expect(ctx.svc.getSettings().rail.hidden).not.toContain("skills");
  });

  it("coordinates live CLIs via talk steps (review, send-draft, stop)", async () => {
    const repo = gitRepo("talk-repo");
    const ctx = withPlanner([
      {
        say: "Starting review and sending draft.",
        steps: [
          { kind: "talk", action: "review", target: "pty-1", agents: ["pty-2"] },
          { kind: "talk", action: "send-draft", target: "pty-1", agents: ["pty-2"], prompt: "reply" },
          { kind: "talk", action: "stop", target: "pty-1" },
        ],
      },
    ]);
    ctx.svc.saveSettings({ agentTalk: { ...ctx.svc.getSettings().agentTalk, on: true } });
    const ws = ctx.svc.addWorkspace(repo).workspaces[0];
    await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "argy" });
    await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "pasty" });

    const turn = await askAndRun(ctx, "Have Pasty review Argy, send Argy's reply as a draft, then pause talk");
    expect(turn?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(ctx.sent.some((m) => m.ptyId === "pty-2" && m.enter === false)).toBe(true);
    await ctx.svc.pumpMessages();
    await ctx.exit("pty-1", 0);
    await ctx.exit("pty-2", 0);
  });

  it("handles run actions (mark-reviewed/unreviewed, continue, handoff), entity inspections, agent chat, and deep-link show routes", async () => {
    const repo = gitRepo("deep-repo");
    const ctx = withPlanner([
      // Turn 1: create agent chat + send, then inspect skill/routine/task/chat/run in turn 2
      {
        say: "Messaging Scout and opening views.",
        steps: [
          { kind: "chat", action: "send", agent: "Scout", prompt: "Summarize the repo." },
          { kind: "show", target: "Settings", options: "section=voice" },
          { kind: "show", target: "Deploy Skill" },
          { kind: "show", target: "Daily Digest" },
          { kind: "show", target: "Ship v2" },
        ],
      },
      // Turn 2: inline inspect across skill, routine, task, chat, and run
      {
        say: "Checking everything.",
        steps: [
          { kind: "inspect", action: "skill", target: "Deploy Skill" },
          { kind: "inspect", action: "routine", target: "Daily Digest" },
          { kind: "inspect", action: "task", target: "Ship v2" },
          { kind: "inspect", action: "chat", target: "Summarize the repo." },
        ],
      },
      {
        say: "Everything looks healthy.",
        steps: [],
      },
      // Turn 3: run mark-reviewed, mark-unreviewed, handoff, and continue
      {
        say: "Reviewing and handing off the run.",
        steps: [
          { kind: "run", action: "mark-reviewed", target: "Scout · Summarize the repo." },
          { kind: "run", action: "mark-unreviewed", target: "Scout · Summarize the repo." },
          { kind: "run", action: "handoff", target: "Scout · Summarize the repo.", agent: "Reviewer" },
          { kind: "run", action: "continue", target: "Scout · Summarize the repo.", prompt: "Double-check tests." },
        ],
      },
    ]);
    const ws = ctx.svc.addWorkspace(repo).workspaces[0];
    const scout = ctx.svc.saveAgent({ name: "Scout", brief: "Inspect repos.", engine: "argy", places: [repo] });
    const reviewer = ctx.svc.saveAgent({ name: "Reviewer", brief: "Review.", engine: "argy", places: [repo] });
    const skill = ctx.svc.saveSkill({ name: "Deploy Skill", description: "Deploy steps", body: "1. Build\n2. Deploy" });
    const routine = ctx.svc.saveRoutine({ name: "Daily Digest", agentId: scout.id, schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "Write digest." });
    const task = ctx.svc.saveTask({ title: "Ship v2", body: "Release v2.", agentId: scout.id, workspaceId: ws.id });

    // Turn 1
    const t1 = await askAndRun(ctx, "Message Scout and open views");
    expect(t1?.steps?.every((s) => s.state === "done")).toBe(true);
    const chatPty = t1?.steps?.[0].ptyId;
    const chatRunId = t1?.steps?.[0].runId;
    expect(chatPty).toBeTruthy();
    expect(chatRunId).toBeTruthy();
    if (chatPty) await ctx.exit(chatPty, 0);

    expect(ctx.shown.map((s) => s.route)).toEqual([
      { view: "settings", section: "voice" },
      { view: "skills", skillId: skill.id },
      { view: "routines", routineId: routine.id },
      { view: "tasks", taskId: task.id },
    ]);

    // Turn 2: inline inspections
    await ctx.svc.orchestratorAsk("Inspect skill, routine, task, and chat");
    const t2 = ctx.svc.orchestratorView().turns.at(-1);
    expect(t2?.checks).toHaveLength(4);
    expect(t2?.checks?.[0].details).toContain("1. Build");
    expect(t2?.checks?.[1].details).toContain("Write digest.");
    expect(t2?.checks?.[2].details).toContain("Release v2.");
    expect(t2?.checks?.[3].details).toContain("Agent chat (Scout)");

    // Turn 3: run lifecycle
    const t3 = await askAndRun(ctx, "Review, handoff, and continue run");
    expect(t3?.steps?.every((s) => s.state === "done")).toBe(true);
    expect(ctx.svc.listTasks().some((item) => item.agentId === reviewer.id && item.sourceRunId === chatRunId)).toBe(true);
    const contPty = t3?.steps?.[3].ptyId;
    expect(contPty).toBeTruthy();
    if (contPty) await ctx.exit(contPty, 0);
  });

  it("defaults Viby-made tasks to an isolated copy only in git repositories with a commit", async () => {
    const withCommit = gitRepo("iso-commit");
    const plainDir = tempDir();
    const emptyRepo = path.join(tempDir(), "iso-empty");
    fs.mkdirSync(emptyRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: emptyRepo });

    const ctx = withPlanner([
      {
        say: "Creating tasks across three workspaces.",
        steps: [
          { kind: "task", action: "create", name: "Committed Create", prompt: "Work in copy.", agent: "Builder", workspace: "iso-commit" },
          { kind: "task", action: "create-run", name: "Committed Run", prompt: "Run in copy.", agent: "Builder", workspace: "iso-commit" },
          { kind: "task", action: "create", name: "Plain Folder Task", prompt: "Work in place.", agent: "Builder", workspace: path.basename(plainDir) },
          { kind: "task", action: "create", name: "Empty Repo Task", prompt: "No commit yet.", agent: "Builder", workspace: "iso-empty" },
        ],
      },
    ]);
    ctx.svc.addWorkspace(withCommit);
    ctx.svc.addWorkspace(plainDir);
    ctx.svc.addWorkspace(emptyRepo);
    ctx.svc.saveAgent({ name: "Builder", brief: "Write code.", engine: "argy", places: [withCommit, plainDir, emptyRepo] });

    const turn = await askAndRun(ctx, "Create tasks with default isolation");
    expect(turn?.steps?.every((s) => s.state === "done")).toBe(true);
    const byTitle = (title: string) => ctx.svc.listTasks().find((t) => t.title === title);
    expect(byTitle("Committed Create")?.isolated).toBe(true);
    expect(byTitle("Committed Run")).toMatchObject({ isolated: true, status: "running" });
    expect(byTitle("Committed Run")?.copy).toBeTruthy();
    expect(byTitle("Plain Folder Task")?.isolated).toBe(false);
    expect(byTitle("Empty Repo Task")?.isolated).toBe(false);
    for (const live of ctx.svc.listLive()) await ctx.exit(live.ptyId, 0);
    await ctx.svc.close();
  });

  it("refuses to read outside files through symlinks during inspect", async () => {
    const outsideDir = tempDir();
    const secretFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secretFile, "TOP-SECRET-KEY-123\n");

    const wsDir = gitRepo("sym-repo");
    fs.writeFileSync(path.join(wsDir, "notes.txt"), "safe local notes\n");
    fs.symlinkSync(secretFile, path.join(wsDir, "leak.txt"));
    fs.symlinkSync(outsideDir, path.join(wsDir, "out"));

    const ctx = withPlanner([
      {
        say: "",
        steps: [
          { kind: "inspect", workspace: "sym-repo", folder: "leak.txt" },
          { kind: "inspect", workspace: "sym-repo", folder: "out/secret.txt" },
          { kind: "inspect", workspace: "sym-repo", folder: "notes.txt" },
        ],
      },
      { say: "Checked.", steps: [] },
    ]);
    ctx.svc.addWorkspace(wsDir);

    await ctx.svc.orchestratorAsk("check leak.txt, out/secret.txt and notes.txt");
    const turn = ctx.svc.orchestratorView().turns.at(-1);
    expect(turn?.checks).toHaveLength(3);
    expect(turn?.checks?.[0].details).not.toContain("TOP-SECRET-KEY-123");
    expect(turn?.checks?.[1].details).not.toContain("TOP-SECRET-KEY-123");
    expect(turn?.checks?.[2].details).toContain("safe local notes");
    await ctx.svc.close();
  });
});
