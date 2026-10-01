import { describe, expect, it } from "vitest";
import { cwdOverlaps, hasTurn, TURN_GRACE_MS, writersIn } from "../../src/core/checkout.js";
import type { LiveSession } from "../../src/core/types.js";

const NOW = Date.parse("2026-10-01T09:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function session(over: Partial<LiveSession>): LiveSession {
  return {
    ptyId: "p",
    runId: null,
    kind: "shell",
    title: "bash",
    cwd: "/home/me/repo",
    pid: 1,
    startedAt: ago(10 * 60_000),
    origin: null,
    agentId: null,
    chatId: null,
    taskId: null,
    workspaceId: null,
    ...over,
  };
}

describe("who else is in a folder", () => {
  it("treats a folder and a folder inside it as one checkout only within one repository", () => {
    expect(cwdOverlaps("/home/me/repo", "/home/me/repo", null, null)).toBe(true);
    expect(cwdOverlaps("/home/me/repo", "/home/me/repo/src", "/home/me/repo", "/home/me/repo")).toBe(true);
    expect(cwdOverlaps("/home/me/repo/src", "/home/me/repo", "/home/me/repo", "/home/me/repo")).toBe(true);
    // A CLI in the home folder doesn't overlap every project under it.
    expect(cwdOverlaps("/home/me/repo", "/home/me", "/home/me/repo", null)).toBe(false);
    // A repository nested in another is its own checkout.
    expect(cwdOverlaps("/home/me/repo", "/home/me/repo/vendor/lib", "/home/me/repo", "/home/me/repo/vendor/lib")).toBe(false);
    expect(cwdOverlaps("/home/me/repo", "/home/me/repo-other", "/home/me/repo", "/home/me/repo-other")).toBe(false);
    expect(cwdOverlaps("/tmp/a", "/tmp/a/b", null, null)).toBe(false);
  });

  it("counts coding CLIs, not bare shells or vim, and knows which still have their turn", () => {
    const repos = new Map([
      ["/home/me/repo", "/home/me/repo"],
      ["/home/me/repo/src", "/home/me/repo"],
    ]);
    const live = [
      session({ ptyId: "shell" }),
      session({ ptyId: "vim", program: "vim", programCwd: "/home/me/repo" }),
      session({ ptyId: "typed", program: "Claude Code", programEngineId: "claude", programCwd: "/home/me/repo/src", working: true }),
      session({ ptyId: "task", kind: "run", title: "Fix lamp", taskId: "fix-lamp", origin: "task", quietAt: ago(TURN_GRACE_MS + 1) }),
      session({ ptyId: "elsewhere", kind: "run", cwd: "/home/me/other" }),
    ];
    const found = writersIn(live, "/home/me/repo", repos, NOW);
    expect(found.map((writer) => [writer.ptyId, writer.label, writer.busy])).toEqual([
      ["typed", "Claude Code", true],
      ["task", "Fix lamp", false],
    ]);
    expect(writersIn(live, "/home/me/repo", repos, NOW, new Set(["typed"])).map((writer) => writer.ptyId)).toEqual(["task"]);
  });

  it("gives a CLI its turn while working, just after it goes quiet, and just after it starts", () => {
    expect(hasTurn(session({ kind: "run", working: true, quietAt: ago(TURN_GRACE_MS * 10) }), NOW)).toBe(true);
    expect(hasTurn(session({ kind: "run", quietAt: ago(1000) }), NOW)).toBe(true);
    expect(hasTurn(session({ kind: "run", quietAt: ago(TURN_GRACE_MS + 1) }), NOW)).toBe(false);
    expect(hasTurn(session({ kind: "run", startedAt: ago(1000) }), NOW)).toBe(true);
    expect(hasTurn(session({ programEngineId: "claude", startedAt: ago(TURN_GRACE_MS * 10), cliSince: ago(1000) }), NOW)).toBe(true);
    expect(hasTurn(session({ kind: "run" }), NOW)).toBe(false);
  });
});

describe("one git job at a time per repository", () => {
  it("runs jobs in order and doesn't let a failure hold up the next one", async () => {
    const { withRepoLock } = await import("../../src/core/worktrees.js");
    const order: string[] = [];
    let release!: () => void;
    const first = withRepoLock("/repo", () => new Promise<void>((resolve) => (release = resolve)).then(() => void order.push("first")));
    const failing = withRepoLock("/repo/", async () => {
      order.push("failing");
      throw new Error("index.lock");
    });
    const third = withRepoLock("/repo", async () => void order.push("third"));
    const other = withRepoLock("/elsewhere", async () => void order.push("other"));
    await other;
    expect(order).toEqual(["other"]);
    release();
    await first;
    await expect(failing).rejects.toThrow("index.lock");
    await third;
    expect(order).toEqual(["other", "first", "failing", "third"]);
  });
});
