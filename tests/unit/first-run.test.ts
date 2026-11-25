import { afterEach, describe, expect, it, vi } from "vitest";
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
