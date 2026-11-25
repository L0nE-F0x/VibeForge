import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateRunDir, normalizeRun } from "../../src/core/runs.js";
import { Store } from "../../src/core/store.js";
import type { RunMeta } from "../../src/core/types.js";
import { cliCommand, firstSteps, firstStepsDone, isTyping, showShellHint, START_CLI_EVENT, startCliIn, type StartCliDetail } from "../../src/ui/first-run.js";
import { issueUrl } from "../../src/ui/components/Help.js";
import { tourOf } from "../../src/ui/components/Tour.js";

describe("the first ten minutes", () => {
  it("types a CLI's program and fixed arguments, quoted for the shell", () => {
    expect(cliCommand({ bin: "claude", args: [] })).toBe("claude");
    expect(cliCommand({ bin: "codex" })).toBe("codex");
    expect(cliCommand({ bin: "/opt/my cli/run", args: ["--model", "big one"] })).toBe("'/opt/my cli/run' --model 'big one'");
  });

  it("counts keys as typing, but not focus reports, the mouse or arrow keys", () => {
    expect(isTyping("c")).toBe(true);
    expect(isTyping("\r")).toBe(true);
    expect(isTyping("\x1b[I")).toBe(false);
    expect(isTyping("\x1b[O")).toBe(false);
    expect(isTyping("\x1b[A")).toBe(false);
    expect(isTyping("\x1b[<0;10;5M")).toBe(false);
    expect(isTyping("")).toBe(false);
  });

  it("marks Home's three steps done from what is there, and keeps them until all three are", () => {
    const none = firstSteps({ workspaces: 0, runs: [] });
    expect(none.map((step) => [step.key, step.done])).toEqual([
      ["folder", false],
      ["cli", false],
      ["review", false],
    ]);
    expect(firstStepsDone(none)).toBe(false);
    const ran = firstSteps({ workspaces: 1, runs: [{ openedAt: null }] });
    expect(ran.map((step) => step.done)).toEqual([true, true, false]);
    expect(firstStepsDone(ran)).toBe(false);
    const read = firstSteps({ workspaces: 2, runs: [{ openedAt: null }, { openedAt: "2026-11-25T10:00:00.000Z" }] });
    expect(firstStepsDone(read)).toBe(true);
    // A run opened somewhere without a workspace still leaves "Open a folder" to do.
    expect(firstStepsDone(firstSteps({ workspaces: 0, runs: [{ openedAt: "2026-11-25T10:00:00.000Z" }] }))).toBe(false);
  });

  it("keeps a run opened once as reviewed, however many unopened runs came after it", () => {
    // Each CLI session in Code is recorded as a run, and most are never opened in Runs: after a day
    // of work the run that was opened is far behind the newest ones.
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vf-first-runs-"));
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "vf-first-config-")), dataRoot);
    for (let n = 0; n < 25; n += 1) {
      const startedAt = new Date(Date.UTC(2026, 10, 25, 9, n));
      const { id, dir } = allocateRunDir(dataRoot, startedAt, `Session ${n + 1}`);
      const run = normalizeRun({ id, dir, origin: "code", status: "exited", startedAt: startedAt.toISOString(), title: `Session ${n + 1}` }) as RunMeta;
      // The first one is the run the person opened, the third step of the first ten minutes.
      store.saveRun(n === 0 ? { ...run, openedAt: "2026-11-25T09:01:00.000Z" } : run);
    }
    // What Home reads: the newest runs, and the newest one that was opened.
    const home = [...store.queryRuns({ limit: 20 }), ...store.queryRuns({ opened: true, limit: 1 })];
    expect(firstSteps({ workspaces: 1, runs: home }).map((step) => step.done)).toEqual([true, true, true]);
    expect(store.queryRuns({ opened: true }).map((run) => run.title)).toEqual(["Session 1"]);
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("shows the hint only over a fresh live shell with nothing in its foreground", () => {
    const fresh = { shell: true, fresh: true, live: true, program: null };
    expect(showShellHint(fresh)).toBe(true);
    expect(showShellHint({ ...fresh, fresh: false })).toBe(false);
    expect(showShellHint({ ...fresh, live: false })).toBe(false);
    expect(showShellHint({ ...fresh, shell: false })).toBe(false);
    expect(showShellHint({ ...fresh, program: "Claude Code" })).toBe(false);
  });

  describe("asking Code to start a CLI", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    const stubWindow = () => {
      const target = new EventTarget();
      vi.stubGlobal("window", target);
      return target;
    };

    it("answers with the terminal Code started", async () => {
      const target = stubWindow();
      let asked: StartCliDetail | null = null;
      target.addEventListener(START_CLI_EVENT, (event) => {
        asked = (event as CustomEvent<StartCliDetail>).detail;
        asked.done("pty-7");
      });
      await expect(startCliIn("ws-1", "claude")).resolves.toBe("pty-7");
      expect(asked).toMatchObject({ workspaceId: "ws-1", engineId: "claude" });
    });

    it("gives up with null when nothing answers", async () => {
      vi.useFakeTimers();
      stubWindow();
      const answer = startCliIn("ws-1", null, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(answer).resolves.toBeNull();
    });
  });

  it("tells the short tour from the full one", () => {
    expect(tourOf(new CustomEvent("x", { detail: "full" }))).toBe("full");
    expect(tourOf(new CustomEvent("x", { detail: "short" }))).toBe("short");
    expect(tourOf(new Event("x"))).toBe("short");
  });

  it("fills in what the window showed when a problem is reported as a bug", () => {
    const url = new URL(issueUrl("bug", undefined, [], "Terminal host problem\nThe terminal host stopped (SIGKILL)."));
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("what-happened")).toContain("The terminal host stopped (SIGKILL).");
    expect(new URL(issueUrl("bug", undefined, [])).searchParams.has("what-happened")).toBe(false);
  });
});
