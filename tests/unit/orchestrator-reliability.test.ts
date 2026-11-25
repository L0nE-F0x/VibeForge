import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VibyDiagnostics, formatDiagnosticsLogLine } from "../../src/core/service/orchestrator-diagnostics.js";
import type { CallState, OrchestratorTurn } from "../../src/shared/api.js";
import { setup, until } from "./fixtures/service-harness.js";

vi.mock("electron", () => ({ net: {} }));
const { Call } = await import("../../electron/call.js");

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

describe("Viby diagnostics telemetry and inspect diagnostics", () => {
  it("tracks bounded latency metrics, warm hits, repairs, and privacy-safe log lines", () => {
    const diag = new VibyDiagnostics(3);
    expect(diag.formatSummary({ warmActive: false, cachedContext: false })).toContain("no recorded turns yet");

    diag.record({
      at: "2026-11-25T10:00:00.000Z",
      source: "think",
      engineId: "claude",
      model: "haiku",
      warmSession: true,
      totalMs: 120,
      plannerMs: 100,
      outcome: "answered",
      stepKinds: [],
      failedSteps: 0,
    });
    diag.record({
      at: "2026-11-25T10:00:05.000Z",
      source: "think",
      engineId: "claude",
      model: "haiku",
      warmSession: false,
      repaired: true,
      totalMs: 400,
      plannerMs: 360,
      outcome: "planned",
      stepKinds: ["start", "verify"],
      failedSteps: 0,
    });
    diag.record({
      at: "2026-11-25T10:00:10.000Z",
      source: "run",
      totalMs: 250,
      executionMs: 250,
      outcome: "failed",
      stepKinds: ["shell"],
      failedSteps: 1,
      errorKind: "exit_1",
    });
    diag.record({
      at: "2026-11-25T10:00:15.000Z",
      source: "quickAct",
      totalMs: 15,
      outcome: "executed",
      stepKinds: ["show"],
      failedSteps: 0,
    });

    const stats = diag.summary();
    expect(stats.totalTurns).toBe(3); // Bounded at cap = 3
    expect(stats.errorCount).toBe(1);
    expect(stats.repairs).toBe(1);
    expect(stats.avgTotalMs).toBe(Math.round((400 + 250 + 15) / 3));
    expect(stats.avgPlannerMs).toBe(360);
    expect(stats.p95TotalMs).toBeGreaterThanOrEqual(250);

    const formatted = diag.formatSummary({ warmActive: true, cachedContext: true, activeWaits: 2 });
    expect(formatted).toContain("Viby diagnostics (3 turns");
    expect(formatted).toContain("warm planner ready");
    expect(formatted).toContain("2 chained wait(s)");
    expect(formatted).toContain("[think] claude/haiku: planned");

    const logLine = formatDiagnosticsLogLine(stats.recent[0]);
    expect(logLine).toContain("Viby [think] engine=claude/haiku outcome=planned");
    expect(logLine).toContain("repaired=1");
  });

  it("answers inspect diagnostics with Viby metrics alongside health checks", async () => {
    const ctx = setupWithClaude();
    let calls = 0;
    ctx.svc.orchestrator.runner = async () => {
      calls += 1;
      return ok(
        JSON.stringify({
          session_id: "s-diag",
          structured_output:
            calls === 1
              ? { say: "Checking diagnostics.", steps: [{ kind: "inspect", action: "diagnostics", target: "", prompt: "viby diagnostics" }] }
              : { say: "All healthy.", steps: [] },
        }),
      );
    };
    await ctx.svc.orchestratorAsk("run viby diagnostics");
    const last = ctx.svc.orchestratorView().turns.at(-1);
    expect(last?.text).toBe("All healthy.");
    expect(last?.checks?.[0]?.details).toContain("Viby diagnostics");

    calls = 0;
    ctx.svc.orchestrator.runner = async () => {
      calls += 1;
      return ok(
        JSON.stringify({
          session_id: "s-diag",
          structured_output:
            calls === 1
              ? { say: "Checking problems.", steps: [{ kind: "inspect", action: "problems", target: "", prompt: "any problems?" }] }
              : { say: "None found.", steps: [] },
        }),
      );
    };
    await ctx.svc.orchestratorAsk("any problems?");
    const problemTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(problemTurn?.checks?.[0]?.summary).toContain("No active problems");
  });
});

describe("Viby reliability: barge-in cleanup race, chained PTY prompt guards, and call errors", () => {
  it("awaits unwinding an aborted turn on immediate barge-in ask while rejecting concurrent un-stopped asks", async () => {
    const ctx = setupWithClaude();
    let releaseFirst!: () => void;
    let turnNum = 0;
    let activeCount = 0;
    let maxConcurrent = 0;
    ctx.svc.orchestrator.runner = async (_argv, _cwd, signal) => {
      turnNum += 1;
      const myTurn = turnNum;
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      try {
        if (myTurn === 1 && !signal.aborted) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          // Simulate a short async unwind even after abort signal fired.
          await new Promise((r) => setTimeout(r, 35));
          return { code: 1, stdout: "", stderr: "aborted", timedOut: false };
        }
        return ok(JSON.stringify({ session_id: "s-barge", structured_output: { say: "Second answered cleanly.", steps: [] } }));
      } finally {
        activeCount -= 1;
      }
    };

    const firstAsk = ctx.svc.orchestratorAsk("first request");
    await until(() => Boolean(releaseFirst));
    // Trying to ask while NOT stopped still rejects cleanly.
    await expect(ctx.svc.orchestratorAsk("overlap")).rejects.toThrow("Viby is still answering. Wait for it, or stop it.");

    // Barge-in stops first turn silently, then asks immediately: waits for unwind without overlapping.
    ctx.svc.orchestratorStopThinking(true);
    const secondAsk = ctx.svc.orchestratorAsk("second request");
    releaseFirst();
    await Promise.all([firstAsk, secondAsk]);

    expect(maxConcurrent).toBe(1);
    expect(ctx.svc.orchestratorView().turns.at(-1)?.text).toBe("Second answered cleanly.");
    const recent = ctx.svc.orchestrator.diagnostics.recent();
    expect(recent.map((m) => m.outcome)).toEqual(["aborted", "answered"]);
  });

  it("blocks after:true chained steps when the prior CLI pauses on an interactive approval prompt", async () => {
    const ctx = setupWithClaude();
    const apiDir = path.join(ctx.place, "api");
    fs.mkdirSync(apiDir, { recursive: true });
    ctx.svc.addWorkspace(apiDir);
    let screenText = "Working...";
    ctx.host.screen = async () => screenText;
    ctx.svc.orchestrator.chainSettleMs = 15;
    ctx.svc.orchestrator.chainIdleMs = 400;
    ctx.svc.orchestrator.runner = async () =>
      ok(
        JSON.stringify({
          session_id: "s-chain-prompt",
          structured_output: {
            say: "Starting build then running tests.",
            steps: [
              { kind: "start", engine: "argy", workspace: "api", prompt: "fix tests" },
              { kind: "shell", workspace: "api", prompt: "npm test", after: true },
            ],
          },
        }),
      );

    await ctx.svc.orchestratorAsk("fix tests then run npm test");
    const planTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(planTurn.steps).toHaveLength(2);

    const running = ctx.svc.orchestratorRun(planTurn.id);
    await until(() => Boolean(ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)?.steps?.[0]?.ptyId));
    const ptyId = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!.steps![0].ptyId!;
    ctx.svc.onPtyActivity(ptyId, true);
    // CLI stops outputting because it hit a blocking interactive prompt.
    screenText = "Allow running bash command `rm -rf build`?\n[Y/n]";
    ctx.svc.onPtyActivity(ptyId, false);
    await running;

    const updated = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!;
    expect(updated.steps?.[0].state).toBe("done");
    expect(updated.steps?.[1].state).toBe("skipped");
    expect(ctx.spawns).toHaveLength(1); // Chained shell never ran over the unapproved prompt!
    const waitingNotes = ctx.svc.orchestratorView().turns.filter((t) => t.note?.kind === "waiting");
    expect(waitingNotes.length).toBeGreaterThanOrEqual(1);
  });

  it("bounds chained PTY waits with chainMaxWaitMs so a permanently busy terminal skips cleanly", async () => {
    const ctx = setupWithClaude();
    const apiDir = path.join(ctx.place, "api");
    fs.mkdirSync(apiDir, { recursive: true });
    ctx.svc.addWorkspace(apiDir);
    ctx.svc.orchestrator.chainIdleMs = 200;
    ctx.svc.orchestrator.chainMaxWaitMs = 45;
    ctx.svc.orchestrator.runner = async () =>
      ok(
        JSON.stringify({
          session_id: "s-chain-max",
          structured_output: {
            say: "Running step then follow-up.",
            steps: [
              { kind: "start", engine: "argy", workspace: "api", prompt: "hang forever" },
              { kind: "shell", workspace: "api", prompt: "echo done", after: true },
            ],
          },
        }),
      );

    await ctx.svc.orchestratorAsk("run then echo");
    const planTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    const running = ctx.svc.orchestratorRun(planTurn.id);
    await until(() => Boolean(ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)?.steps?.[0]?.ptyId));
    const ptyId = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!.steps![0].ptyId!;
    ctx.svc.onPtyActivity(ptyId, true);
    await running;

    const updated = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!;
    expect(updated.steps?.[0].state).toBe("done");
    expect(updated.steps?.[1].state).toBe("skipped");
  });

  it("formats errors through coreText and emits state updates on Call turn failures", async () => {
    type EarEvents = { heard: (pcm: Buffer) => void; level: (l: number, h: boolean, ms: number) => void; closed: (err: string) => void };
    let events: EarEvents | null = null;
    const states: CallState[] = [];
    const warnings: string[] = [];
    const localized = vi.fn((text: string) => `localized:${text}`);
    const instance = new Call({
      voice: {
        openEar: (cb: EarEvents) => {
          events = cb;
          return { close: () => undefined, deaf: () => undefined, detects: false, cancelsEcho: false };
        },
        transcribe: async () => ({ text: "status check", seconds: 1 }),
        status: () => ({ backend: "whisper" }),
        voiceFor: () => null,
        speaker: { piper: () => null, player: () => null, speak: async () => undefined, stop: () => undefined },
        dictating: false,
      } as never,
      service: () =>
        ({
          orchestratorView: () => ({ turns: [] as OrchestratorTurn[] }),
          orchestratorAsk: async () => {
            throw new Error("planner crashed");
          },
          orchestratorRun: async () => undefined,
          orchestratorCancel: () => undefined,
          orchestratorCall: () => undefined,
          listAgents: () => [],
          listEngines: () => [],
          listWorkspaces: () => ({ workspaces: [] }),
          getSettings: () => ({ voice: { talkBack: false, talkOver: "never" } }),
        }) as never,
      looking: () => null,
      words: { say: (k: string) => k, coreText: localized } as never,
      log: { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined } as never,
      send: (state) => void states.push(state),
      afterSpeechMs: 0,
    });

    instance.start();
    (events as EarEvents | null)?.heard(Buffer.alloc(3200));
    await until(() => states.length >= 4 && states.at(-1)?.phase === "listening");

    expect(localized).toHaveBeenCalledWith("planner crashed");
    expect(states.some((s) => s.said === "localized:planner crashed")).toBe(true);
    expect(instance.get()).toMatchObject({ phase: "listening", said: "localized:planner crashed" });
    expect(warnings.at(-1)).toContain("planner crashed");
    instance.stop();
  });
});
