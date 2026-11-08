import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orchestratorFor } from "../../electron/companion.js";
import { newCompanionToken } from "../../src/core/companion.js";
import { HEAR_MAX, startCompanionHttp, type CompanionActions, type OrchestratorActions, type StepPatch } from "../../src/core/companion-http.js";
import { buildPhoneOrchestrator, orchestratorDictationWords, PHONE_TURNS } from "../../src/core/companion-orchestrator.js";
import type { OrchestratorTurn, OrchestratorView } from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import type { LiveSession } from "../../src/core/types.js";
import { setup, tempDir, until } from "./fixtures/service-harness.js";

function live(patch: Partial<LiveSession> & Pick<LiveSession, "ptyId" | "title" | "cwd">): LiveSession {
  return { runId: null, kind: "run", pid: 1, startedAt: "2026-11-07T10:00:00.000Z", origin: "code", agentId: null, chatId: null, taskId: null, workspaceId: null, ...patch };
}

const engines = [
  { id: "grok", label: "Grok Build", bin: "grok", available: true },
  { id: "claude", label: "Claude Code", bin: "claude", available: true },
  { id: "kimi", label: "Kimi", bin: "kimi", available: false },
];
const workspaces = [
  { id: "shop", name: "shop", path: "/work/shop" },
  { id: "shop-cart", name: "shop · add-cart", path: "/work/shop.worktrees/add-cart" },
];

function step(patch: Partial<NonNullable<OrchestratorTurn["steps"]>[number]>) {
  return { id: "s1", kind: "start" as const, engineId: "claude", workspaceId: "shop", branch: "add-cart", prompt: "Build a cart.", target: "", asked: "", state: "planned" as const, error: null, ptyId: null, openedWorkspaceId: null, ...patch };
}

describe("the Orchestrator on the phone", () => {
  it("shows the desktop's conversation with each waiting step checked, the end of it only, and the CLIs running", () => {
    const turns: OrchestratorTurn[] = [
      ...Array.from({ length: PHONE_TURNS }, (_, index): OrchestratorTurn => ({ id: `old${index}`, at: "", from: "you", text: `old ${index}` })),
      { id: "t1", at: "", from: "you", text: "Start Claude in shop on add-cart" },
      {
        id: "t2",
        at: "",
        from: "vibeforge",
        by: "grok",
        text: "Done.",
        plan: "done",
        steps: [step({ state: "done", ptyId: "pty-2", openedWorkspaceId: "shop-cart" }), step({ id: "s2", state: "done", ptyId: "pty-gone" })],
      },
      {
        id: "t3",
        at: "",
        from: "vibeforge",
        text: "Which CLI?",
        plan: "waiting",
        steps: [step({ id: "s3", engineId: "", asked: "gemini · shop" }), step({ id: "s4", kind: "tell", target: "pty-1", prompt: "Wrap up." }), step({ id: "s5", engineId: "kimi" })],
      },
    ];
    const view: OrchestratorView = { engineId: "grok", engineReady: true, mode: "plan", thinking: false, turns };
    const phone = buildPhoneOrchestrator({
      view,
      engines,
      workspaces,
      live: [
        live({ ptyId: "pty-1", kind: "shell", title: "shop", cwd: "/work/shop", workspaceId: "shop", program: "Codex", programEngineId: "codex", working: true, startedAt: "2026-11-07T09:00:00.000Z" }),
        live({ ptyId: "pty-2", runId: "run-2", title: "Claude Code · shop · add-cart", cwd: "/work/shop.worktrees/add-cart", workspaceId: "shop-cart", orchestrated: true, working: false }),
        // A bare shell isn't a CLI.
        live({ ptyId: "pty-3", kind: "shell", title: "shop", cwd: "/work/shop", workspaceId: "shop" }),
      ],
      hear: true,
    });
    expect(phone.turns).toHaveLength(PHONE_TURNS);
    expect(phone.earlier).toBe(3);
    expect(phone.turns.at(-1)?.steps?.map((item) => item.issue)).toEqual(["engine", null, "engineMissing"]);
    // A plan that has run is not checked again; Open works while the terminal it opened is open.
    expect(phone.turns.at(-2)?.steps?.map((item) => [item.issue, item.live, item.runId])).toEqual([
      [null, true, "run-2"],
      [null, false, null],
    ]);
    expect(phone.planners.map((item) => item.id)).toEqual(["grok", "claude"]);
    expect(phone.engines.map((item) => item.id)).toEqual(["grok", "claude", "kimi"]);
    expect(phone.workspaces).toEqual([
      { id: "shop", name: "shop" },
      { id: "shop-cart", name: "shop · add-cart" },
    ]);
    // The Orchestrator's own first; a CLI typed into a shell is interrupted, a run's terminal stopped.
    expect(phone.running).toEqual([
      { ptyId: "pty-2", runId: "run-2", name: "Claude Code", workspace: "shop · add-cart", label: "Claude Code · shop · add-cart", state: "waiting", orchestrated: true, stop: "end" },
      { ptyId: "pty-1", runId: null, name: "Codex", workspace: "shop", label: "Codex · shop", state: "working", orchestrated: false, stop: "interrupt" },
    ]);
    expect(phone.hear).toBe(true);
    // The desk's own conversation is left as it was.
    expect("issue" in (turns.at(-1)?.steps?.[0] ?? {})).toBe(false);
  });

  it("nudges whisper toward the same names as the desktop's box", () => {
    expect(orchestratorDictationWords({ agents: ["Atlas"], routines: ["Nightly"], engines: ["Grok Build"], workspaces: ["star-ledger"] })).toEqual([
      "VibeForge",
      "Atlas",
      "Nightly",
      "Grok Build",
      "star-ledger",
      "star ledger",
      "branch",
      "workspace",
    ]);
  });
});

function desk(patch: Partial<OrchestratorActions> = {}): OrchestratorActions & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    view: () => ({ engineId: "grok", engineReady: true, mode: "plan", thinking: false, earlier: 0, turns: [], planners: [], engines: [], workspaces: [], running: [], hear: false }),
    ask: (text) => void calls.push(["ask", text]),
    stopThinking: () => void calls.push(["stop"]),
    clear: () => void calls.push(["new"]),
    run: async (turnId) => void calls.push(["go", turnId]),
    cancel: (turnId) => void calls.push(["cancel", turnId]),
    editStep: (turnId: string, stepId: string, patch: StepPatch) => void calls.push(["step", turnId, stepId, patch]),
    removeStep: (turnId, stepId) => void calls.push(["remove", turnId, stepId]),
    settings: (patch) => void calls.push(["settings", patch]),
    ...patch,
  };
}

function actions(orchestrator: OrchestratorActions, hear?: CompanionActions["hear"]): CompanionActions {
  return {
    desk: () => ({ nudges: [], agents: [], engines: [], workspaces: [] }),
    session: async () => ({ ptyId: "p", runId: "r", title: "", detail: "", state: "waiting", changes: null, screen: "", canSend: true, stop: "end" }),
    send: async () => ({ working: false, ptyId: "p", runId: "r" }),
    stop: async () => undefined,
    launch: async () => ({ ptyId: "p", runId: "r" }),
    plans: async () => null,
    orchestrator,
    hear: hear ?? (async () => ({ text: "", empty: "short" })),
  };
}

async function server(orchestrator: OrchestratorActions, hear?: CompanionActions["hear"], language = "en") {
  const token = newCompanionToken();
  const http = await startCompanionHttp({ port: 0, token, root: path.join(import.meta.dirname, "../../companion"), icon: null, actions: actions(orchestrator, hear), language: () => language });
  const base = `http://127.0.0.1:${http.port}`;
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { http, base, token, post };
}

describe("the phone page's Orchestrator routes", () => {
  it("passes each button on to the desk, behind the pairing code, and refuses what isn't one", async () => {
    const orchestrator = desk();
    const { http, base, token, post } = await server(orchestrator);
    try {
      expect((await fetch(`${base}/api/orchestrator`)).status).toBe(401);
      expect((await fetch(`${base}/api/orchestrator/ask`, { method: "POST", body: "{}" })).status).toBe(401);
      expect(await (await fetch(`${base}/api/orchestrator`, { headers: { Authorization: `Bearer ${token}` } })).json()).toMatchObject({ engineId: "grok", mode: "plan" });
      expect((await post("/api/orchestrator/ask", { text: "  Start Claude in shop  " })).status).toBe(200);
      expect((await post("/api/orchestrator/ask", { text: "   " })).status).toBe(400);
      await post("/api/orchestrator/stop", {});
      await post("/api/orchestrator/new", {});
      await post("/api/orchestrator/go", { turnId: "t2" });
      await post("/api/orchestrator/cancel", { turnId: "t3" });
      await post("/api/orchestrator/step", { turnId: "t2", stepId: "s1", patch: { prompt: "Do it.", branch: "add-cart", state: "done", engineId: 4 } });
      await post("/api/orchestrator/remove", { turnId: "t2", stepId: "s1" });
      await post("/api/orchestrator/settings", { engine: "claude", mode: "go" });
      await post("/api/orchestrator/settings", { mode: "sometimes" });
      expect((await post("/api/orchestrator/go", {})).status).toBe(400);
      expect((await post("/api/orchestrator/step", { turnId: "t2" })).status).toBe(400);
      expect((await post("/api/orchestrator/settings", { mode: "sometimes" })).status).toBe(400);
      expect((await post("/api/orchestrator/launch-rockets", {})).status).toBe(404);
      expect(orchestrator.calls).toEqual([
        ["ask", "Start Claude in shop"],
        ["stop"],
        ["new"],
        ["go", "t2"],
        ["cancel", "t3"],
        // Only the fields a card can change, and only strings.
        ["step", "t2", "s1", { prompt: "Do it.", branch: "add-cart" }],
        ["remove", "t2", "s1"],
        ["settings", { engine: "claude", mode: "go" }],
      ]);
    } finally {
      await http.close();
    }
  });

  it("says why the desk refused, in the phone's language", async () => {
    const orchestrator = desk({
      ask: () => {
        throw new Error("Maestro is still answering. Wait for it, or stop it.");
      },
      view: () => ({
        engineId: "grok",
        engineReady: true,
        mode: "plan",
        thinking: true,
        earlier: 0,
        turns: [{ id: "t", at: "", from: "vibeforge", text: "", plan: "done", steps: [{ ...step({ state: "failed", error: "That workspace is gone." }), issue: null, live: false, runId: null }] }],
        planners: [],
        engines: [],
        workspaces: [],
        running: [],
        hear: false,
      }),
    });
    const { http, base, token, post } = await server(orchestrator, undefined, "de");
    try {
      const busy = await post("/api/orchestrator/ask", { text: "and another" });
      expect(busy.status).toBe(400);
      expect((await busy.json()).error).not.toContain("still answering");
      const view = await (await fetch(`${base}/api/orchestrator`, { headers: { Authorization: `Bearer ${token}` } })).json();
      expect(view.turns[0].steps[0].error).toBeTruthy();
      expect(view.turns[0].steps[0].error).not.toBe("That workspace is gone.");
    } finally {
      await http.close();
    }
  });

  it("hears up to three minutes of speech from the phone and refuses more", async () => {
    const heard: Buffer[] = [];
    const { http, base, token } = await server(desk(), async (pcm) => {
      heard.push(pcm);
      return { text: "Start Claude in shop.", empty: null };
    });
    const send = (body: Buffer) => fetch(`${base}/api/orchestrator/hear`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) });
    try {
      expect((await fetch(`${base}/api/orchestrator/hear`, { method: "POST", body: new Uint8Array(4) })).status).toBe(401);
      const speech = Buffer.alloc(32_000, 7);
      const answer = await send(speech);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ text: "Start Claude in shop.", empty: null });
      expect(heard[0].equals(speech)).toBe(true);
      expect(HEAR_MAX).toBe(180 * 32_000);
      expect((await send(Buffer.alloc(HEAR_MAX + 2))).status).toBe(413);
      expect(heard).toHaveLength(1);
    } finally {
      await http.close();
    }
  });

  it("serves the mic's worklet as a script from the page itself", async () => {
    const { http, base } = await server(desk());
    try {
      const worklet = await fetch(`${base}/mic-worklet.js`);
      expect(worklet.status).toBe(200);
      expect(worklet.headers.get("content-type")).toContain("text/javascript");
      expect(await worklet.text()).toContain('registerProcessor("vibeforge-mic"');
    } finally {
      await http.close();
    }
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

describe("the phone working the desktop's Orchestrator", () => {
  it("asks without waiting for the answer, fixes a step on the card, and Go starts the CLI on its branch", async () => {
    const repo = gitRepo();
    const ctx = setup();
    const file = path.join(ctx.configRoot, "engines.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    rows.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] }, { id: "claude", label: "Claude Code", bin: "pasty", args: [] });
    fs.writeFileSync(file, JSON.stringify(rows));
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "grok-4.7" } });
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const answers: Array<(run: BrainRun) => void> = [];
    ctx.svc.orchestrator.runner = () => new Promise((resolve) => answers.push(resolve));
    const logged: string[] = [];
    const phone = orchestratorFor({ service: ctx.svc, canHear: () => true, log: (line) => logged.push(line) });

    phone.ask("Start Argy in shop on a branch called blah and do A, B and C");
    // Back at once; the planner is still thinking.
    expect(phone.view()).toMatchObject({ thinking: true, hear: true });
    expect(() => phone.ask("and another")).toThrow("Maestro is still answering. Wait for it, or stop it.");
    await until(() => answers.length === 1);
    answers[0]({ code: 0, stdout: JSON.stringify({ structuredOutput: { say: "Starting it.", steps: [{ kind: "start", engine: "nobody", workspace: "shop", branch: "blah", prompt: "Do A, B and C." }] } }), stderr: "", timedOut: false });
    await until(() => !phone.view().thinking);
    let view = phone.view();
    const plan = view.turns.at(-1);
    expect(plan).toMatchObject({ from: "vibeforge", text: "Starting it.", plan: "waiting" });
    expect(plan?.steps?.[0]).toMatchObject({ engineId: "", workspaceId: workspace.id, branch: "blah", issue: "engine", asked: "nobody · shop" });
    expect(ctx.spawns).toHaveLength(0);

    // The card on the phone: pick the CLI, change the words, then Go.
    phone.editStep(plan?.id ?? "", plan?.steps?.[0].id ?? "", { engineId: "argy", prompt: "Do A and B." });
    expect(phone.view().turns.at(-1)?.steps?.[0]).toMatchObject({ engineId: "argy", prompt: "Do A and B.", issue: null });
    await phone.run(plan?.id ?? "");
    view = phone.view();
    const done = view.turns.at(-1)?.steps?.[0];
    expect(view.turns.at(-1)?.plan).toBe("done");
    expect(done).toMatchObject({ state: "done", live: true });
    expect(done?.runId).toBeTruthy();
    const copy = path.join(ctx.dataRoot, "worktrees", "blah");
    expect(ctx.spawns[0].cwd).toBe(copy);
    expect(ctx.spawns[0].argv.at(-1)).toBe("Do A and B.");
    expect(view.running[0]).toMatchObject({ ptyId: done?.ptyId, name: "Argy", workspace: "shop · blah", orchestrated: true, stop: "end" });
    expect(() => phone.editStep(plan?.id ?? "", plan?.steps?.[0].id ?? "", { prompt: "x" })).toThrow("That plan has already been carried out.");

    // The view's header: another planner starts on its own default model; one that can't plan is refused.
    phone.settings({ mode: "go" });
    expect(ctx.svc.getSettings().orchestrator).toEqual({ engine: "grok", mode: "go", model: "grok-4.7" });
    phone.settings({ engine: "claude" });
    expect(ctx.svc.getSettings().orchestrator).toEqual({ engine: "claude", mode: "go", model: "" });
    expect(() => phone.settings({ engine: "argy" })).toThrow();
    expect(ctx.svc.getSettings().orchestrator.engine).toBe("claude");

    phone.clear();
    expect(phone.view().turns).toEqual([]);
    expect(logged).toEqual([]);
    ctx.svc.close();
  });
});
