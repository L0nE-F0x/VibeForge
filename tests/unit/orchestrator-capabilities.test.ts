import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeRunAction,
  parseWorkbenchAction,
  recentFocusLine,
  resolveLocalReflex,
  stepIssue,
  type OrchestratorStep,
  type OrchestratorTurn,
  type PlanContext,
} from "../../src/core/orchestrator.js";
import { setup, until } from "./fixtures/service-harness.js";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

function setupWithClaude() {
  const ctx = setup();
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "claude", mode: "plan", model: "", projectsFolder: "" } });
  return ctx;
}

const baseStep = (patch: Partial<OrchestratorStep>): OrchestratorStep =>
  ({
    id: "s-1",
    kind: "show",
    asked: "",
    engineId: "",
    agentId: "",
    workspaceId: "",
    branch: "",
    prompt: "",
    target: "",
    model: "",
    effort: "",
    name: "",
    folder: "",
    description: "",
    schedule: "",
    status: "",
    after: false,
    state: "planned",
    ...patch,
  }) as OrchestratorStep;

describe("Viby cross-turn focus memory", () => {
  const ctx: PlanContext = {
    workspaces: [
      { id: "w1", name: "api", folder: "~/Projects/api", git: true },
      { id: "w2", name: "web", folder: "~/Projects/web", git: true },
    ],
    engines: [{ id: "claude", label: "Claude Code", available: true }],
    running: [
      { id: "pty-1", engine: "Claude Code", workspace: "api", folder: "~/Projects/api", working: false, orchestrated: true },
      { id: "pty-2", engine: "Codex", workspace: "web", folder: "~/Projects/web", working: false, orchestrated: true },
    ],
    copies: [{ id: "c1", name: "fix-auth", workspace: "api", branch: "fix-auth" }],
    agents: [{ id: "ag1", name: "Builder", engine: "claude" }],
    tasks: [{ id: "tk1", title: "Write tests", status: "todo" }],
    routines: [{ id: "rt1", name: "Daily Audit", schedule: "0 9 * * 1-5", enabled: true }],
    skills: [{ id: "sk1", name: "Security Check" }],
    chats: [{ id: "ch1", title: "Architecture thread", engine: "claude", live: false }],
  };

  it("returns empty when no prior steps/checks exist and resolves recent step and check entities while omitting active looking target", () => {
    expect(recentFocusLine([{ id: "t0", at: "", from: "you", text: "hi" }], ctx)).toBe("");

    const turns: OrchestratorTurn[] = [
      {
        id: "t1",
        at: "",
        from: "vibeforge",
        text: "Done.",
        steps: [
          baseStep({ id: "s1", kind: "start", ptyId: "pty-1", openedWorkspaceId: "w1", copyId: "c1", agentId: "ag1", taskId: "tk1" }),
          baseStep({ id: "s2", kind: "routine", target: "rt1" }),
        ],
      },
      {
        id: "t2",
        at: "",
        from: "vibeforge",
        text: "Checked.",
        steps: [
          baseStep({ id: "s3", kind: "skill", target: "sk1" }),
          baseStep({ id: "s4", kind: "chat", target: "ch1" }),
        ],
        checks: [{ id: "chk1", kind: "inspect", label: "CLI", summary: "ok", details: "...", ptyId: "pty-2", workspaceId: "w2", copyId: "c1" }],
      },
    ];

    // Omits pty-1 and w1 when user is looking right at them, and caps at 6 items.
    const hint = recentFocusLine(turns, ctx, { view: "code", workspaceId: "w1", ptyId: "pty-1" });
    expect(hint).toContain('CLI Codex [pty-2]');
    expect(hint).toContain('workspace "web" [w2]');
    expect(hint).toContain('skill "Security Check" [sk1]');
    expect(hint).toContain('chat "Architecture thread" [ch1]');
    expect(hint).not.toContain("[pty-1]");
    expect(hint).not.toContain("[w1]");
    expect(hint.split(",")).toHaveLength(6);
  });

  it("injects recent turn focus into subsequent planner prompts", async () => {
    const ctxSvc = setupWithClaude();
    const apiDir = path.join(ctxSvc.place, "api");
    fs.mkdirSync(apiDir, { recursive: true });
    ctxSvc.svc.addWorkspace(apiDir);
    const seenPrompts: string[] = [];
    ctxSvc.svc.orchestrator.runner = async (argv) => {
      seenPrompts.push(argv.join("\n"));
      if (seenPrompts.length === 1) {
        return ok(JSON.stringify({ session_id: "s-mem", structured_output: { say: "I'll inspect api.", steps: [{ kind: "inspect", workspace: "api", prompt: "status" }] } }));
      }
      return ok(JSON.stringify({ session_id: "s-mem", structured_output: { say: "Follow-up ready.", steps: [] } }));
    };

    await ctxSvc.svc.orchestratorAsk("check api");
    await ctxSvc.svc.orchestratorAsk("open its files panel");
    expect(seenPrompts.at(-1)).toContain('(Recent turn focus for "it" / "that one" / "there": workspace "api"');
  });
});

describe("Viby expanded 0ms reflexes and safety gates", () => {
  it("resolves /diagnostics, /trust, pause routine, and switch theme cleanly without spawning planner", async () => {
    const context: PlanContext = {
      workspaces: [{ id: "w1", name: "api", folder: "~/Projects/api", git: true }],
      engines: [{ id: "claude", label: "Claude Code", available: true }],
      running: [{ id: "pty-1", engine: "Claude Code", workspace: "api", folder: "~/Projects/api", working: false, orchestrated: true, waiting: "Do you trust the files in this folder?" }],
      routines: [{ id: "rt-1", name: "Daily Audit", schedule: "0 9 * * *", enabled: true }],
      settings: {
        viby: { planner: "claude", pickedEngine: "", mode: "plan", model: "", effort: "low", projectsFolder: "~/Projects", availablePlanners: [] },
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
          mouseButton: "",
          sendButton: "",
          agent: "",
        },
        app: {
          defaultEngine: "claude",
          defaultShell: "bash",
          theme: "omarchy",
          availableThemes: ["catppuccin-mocha", "tokyo-night", "nord"],
          language: "en",
          terminalFontSize: 13,
          terminalFontFamily: "monospace",
          notify: true,
          sounds: { on: true, volume: 0.7, voice: true, attention: true, finished: true, routines: true, inFront: true },
          tray: true,
          closeToTray: true,
          usage: true,
          planLimits: false,
          quotaAlerts: false,
          activity: "off",
          checkUpdates: true,
          companion: { enabled: false, port: 0 },
          sync: { enabled: false, name: "" },
          agentTalk: { on: false, lead: "", handOff: "ask", reviewRounds: 2, maxMessages: 12, maxWorking: 3, maxHandOffs: 5, leadApplies: false },
          keepRuns: { days: 30, maxMb: 500 },
        },
      },
    };

    expect(resolveLocalReflex("/diagnostics", context)).toMatchObject({ kind: "steps", tag: "diagnostics" });
    expect(resolveLocalReflex("/status", context)).toMatchObject({ kind: "steps", tag: "diagnostics" });
    expect(resolveLocalReflex("/trust", context)).toMatchObject({ kind: "steps", tag: "trust", rawSteps: [{ kind: "key", target: "pty-1", prompt: "enter" }] });
    expect(resolveLocalReflex("pause routine daily audit", context)).toMatchObject({
      kind: "steps",
      tag: "routine-pause",
      rawSteps: [{ kind: "routine", action: "disable", target: "rt-1" }],
    });
    expect(resolveLocalReflex("switch theme to tokyo night", context)).toMatchObject({
      kind: "steps",
      tag: "theme",
      label: "tokyo-night",
      rawSteps: [{ kind: "settings", target: "theme", prompt: "tokyo-night" }],
    });
    expect(resolveLocalReflex("set theme to omarchy", context)).toMatchObject({
      kind: "steps",
      tag: "theme",
      label: "omarchy",
    });
    // Ambiguous /trust across multiple non-waiting CLIs falls back to planner.
    const twoRunning: PlanContext = {
      ...context,
      running: [
        { id: "pty-1", engine: "Claude Code", workspace: "api", folder: "~/Projects/api", working: false, orchestrated: true },
        { id: "pty-2", engine: "Codex", workspace: "api", folder: "~/Projects/api", working: false, orchestrated: true },
      ],
    };
    expect(resolveLocalReflex("/trust", twoRunning)).toBeNull();
    // Looking at a CLI that asks nothing while another asks (a CLI Viby just started in a new copy
    // asks whether to trust that folder): the Enter goes to the one asking. In the pane in front it
    // would send whatever is typed in that CLI's prompt, and the question would stay.
    const oneAsking: PlanContext = {
      ...context,
      running: [twoRunning.running[0], { ...twoRunning.running[1], waiting: "Do you trust the files in this folder?" }],
    };
    expect(resolveLocalReflex("/trust", oneAsking, { view: "code", ptyId: "pty-1" })).toMatchObject({
      kind: "steps",
      tag: "trust",
      rawSteps: [{ kind: "key", target: "pty-2", prompt: "enter" }],
    });
    // The one in front is asking too: it is the one answered.
    const bothAsking: PlanContext = { ...context, running: oneAsking.running.map((cli) => ({ ...cli, waiting: "Do you trust the files in this folder?" })) };
    expect(resolveLocalReflex("/trust", bothAsking, { view: "code", ptyId: "pty-1" })).toMatchObject({ rawSteps: [{ target: "pty-1" }] });
    // Nothing shows a question: the CLI in front, as before (one asking may not have been recognised).
    expect(resolveLocalReflex("/trust", twoRunning, { view: "code", ptyId: "pty-2" })).toMatchObject({ rawSteps: [{ target: "pty-2" }] });

    // Service end-to-end execution of quickAct reflexes
    const ctxSvc = setupWithClaude();
    const apiDir = path.join(ctxSvc.place, "api");
    fs.mkdirSync(apiDir, { recursive: true });
    ctxSvc.svc.addWorkspace(apiDir);
    let runnerCalls = 0;
    ctxSvc.svc.orchestrator.runner = async () => {
      runnerCalls += 1;
      return ok(JSON.stringify({ session_id: "s-none", structured_output: { say: "unused", steps: [] } }));
    };

    const diagRes = await ctxSvc.svc.orchestrator.quickAct("/diagnostics");
    expect(diagRes.handled).toBe(true);
    expect(diagRes.reply).toContain("Viby diagnostics");

    const rt = await ctxSvc.svc.saveRoutine({
      name: "Daily Audit",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      agentId: (await ctxSvc.svc.saveAgent({ name: "Reviewer", brief: "Review PRs", engine: "argy", places: [apiDir] })).id,
      prompt: "audit repo",
      enabled: true,
    });
    const pauseRes = await ctxSvc.svc.orchestrator.quickAct("pause routine Daily Audit");
    expect(pauseRes).toEqual({ handled: true, reply: "Paused routine Daily Audit." });
    expect(ctxSvc.svc.listRoutines().find((r) => r.id === rt.id)?.enabled).toBe(false);

    const themeRes = await ctxSvc.svc.orchestrator.quickAct("switch theme to omarchy");
    expect(themeRes).toEqual({ handled: true, reply: "Switched theme to omarchy." });
    expect(ctxSvc.svc.getSettings().theme).toBe("omarchy");

    // Start a CLI whose screen shows an approval prompt vs trust prompt
    const startedCli = await ctxSvc.svc.startEngine({ workspaceId: ctxSvc.svc.listWorkspaces().workspaces[0].id, engineId: "argy" });
    let screenText = "Allow running `rm -rf /tmp/foo`? [Y/n]";
    ctxSvc.host.screen = async () => screenText;
    const writes: Array<{ ptyId: string; data: string }> = [];
    ctxSvc.host.write = async (ptyId, data) => void writes.push({ ptyId, data });
    ctxSvc.host.foreground = async () => ({ known: true, argv: ["argy"], cwd: apiDir });

    const blockedTrust = await ctxSvc.svc.orchestrator.quickAct("/trust", { view: "code", ptyId: startedCli.ptyId });
    expect(blockedTrust.handled).toBe(true);
    expect(blockedTrust.reply).toContain("waiting on an approval prompt");
    expect(ctxSvc.svc.orchestratorView().turns.at(-1)?.plan).toBe("waiting");
    expect(writes).toHaveLength(0);

    // Safe folder-trust prompt executes immediately on /trust
    screenText = "Do you trust the files in this folder?\n❯ 1. Yes, trust this folder";
    const allowedTrust = await ctxSvc.svc.orchestrator.quickAct("/trust", { view: "code", ptyId: startedCli.ptyId });
    expect(allowedTrust.handled).toBe(true);
    expect(allowedTrust.reply).toContain("Sent Enter to");
    expect(writes).toEqual([{ ptyId: startedCli.ptyId, data: "\r" }]);
    expect(runnerCalls).toBe(0);
  });
});

describe("Viby workbench and run UI parity", () => {
  it("parses, validates, and executes open-folder, focus-next/prev, check-updates, and copy-markdown", async () => {
    expect(parseWorkbenchAction({ prompt: "open-folder" })).toEqual({ op: "open-folder" });
    expect(parseWorkbenchAction({ prompt: "focus-next" })).toEqual({ op: "pane", action: "focus-next" });
    expect(parseWorkbenchAction({ prompt: "previous pane" })).toEqual({ op: "pane", action: "focus-prev" });
    expect(parseWorkbenchAction({ prompt: "check for updates" })).toEqual({ op: "check-updates" });
    expect(normalizeRunAction("copy-markdown")).toBe("copy-markdown");
    expect(normalizeRunAction("copy as markdown")).toBe("copy-markdown");

    const dummyCtx: PlanContext = { workspaces: [{ id: "w1", name: "api", folder: "~/Projects/api", git: true }], engines: [], running: [] };
    expect(stepIssue(baseStep({ kind: "workbench", prompt: "open-folder", workspaceId: "" }), dummyCtx)).toBe("workspace");
    expect(stepIssue(baseStep({ kind: "workbench", prompt: "open-folder", workspaceId: "w1" }), dummyCtx)).toBeNull();
    expect(stepIssue(baseStep({ kind: "run", action: "copy-markdown", target: "" }), dummyCtx)).toBe("target");
    expect(stepIssue(baseStep({ kind: "run", action: "copy-markdown", target: "run-1" }), dummyCtx)).toBeNull();

    const ctx = setupWithClaude();
    const apiDir = path.join(ctx.place, "api");
    fs.mkdirSync(apiDir, { recursive: true });
    const added = ctx.svc.addWorkspace(apiDir);
    const openedFolders: string[] = [];
    const workbenchEvents: unknown[] = [];
    const clipboardWrites: string[] = [];
    let updateChecks = 0;
    ctx.host.openFolder = async (folderPath) => void openedFolders.push(folderPath);
    ctx.host.codeWorkbench = (event) => void workbenchEvents.push(event);
    ctx.host.writeClipboard = (text) => void clipboardWrites.push(text);
    ctx.host.checkUpdates = async () => {
      updateChecks += 1;
      return "Up to date (3.8.0).";
    };

    const launched = await ctx.svc.startEngine({ workspaceId: added.lastWorkspaceId!, engineId: "argy", prompt: "hello world" });
    ctx.exit(launched.ptyId, 0);
    await until(() => ctx.svc.listRuns().length === 1);
    const runId = ctx.svc.listRuns()[0].id;

    ctx.svc.orchestrator.runner = async () =>
      ok(
        JSON.stringify({
          session_id: "s-parity",
          structured_output: {
            say: "Carrying out workbench actions.",
            steps: [
              { kind: "workbench", workspace: "api", prompt: "open-folder" },
              { kind: "workbench", workspace: "api", prompt: "focus-next" },
              { kind: "workbench", workspace: "api", prompt: "focus-prev" },
              { kind: "workbench", prompt: "check-updates" },
              { kind: "run", action: "copy-markdown", target: runId },
            ],
          },
        }),
      );

    await ctx.svc.orchestratorAsk("open api folder, switch panes, check updates, copy run markdown");
    const planTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(planTurn.steps).toHaveLength(5);
    await ctx.svc.orchestratorRun(planTurn.id);

    const doneTurn = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!;
    expect(doneTurn.steps?.every((s) => s.state === "done")).toBe(true);
    expect(openedFolders).toEqual([apiDir]);
    expect(workbenchEvents).toEqual([
      { kind: "pane", workspaceId: added.lastWorkspaceId, action: "focus-next" },
      { kind: "pane", workspaceId: added.lastWorkspaceId, action: "focus-prev" },
    ]);
    expect(updateChecks).toBe(1);
    expect(doneTurn.steps?.[3].result).toBe("Up to date (3.8.0).");
    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]).toContain("hello world");
  });
});
