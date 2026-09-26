import { describe, expect, it } from "vitest";
import type { LiveSession } from "../../src/shared/api.js";
import { trackLive } from "../../src/ui/attention.js";

const session = (ptyId: string, workspaceId: string, patch: Partial<LiveSession> = {}): LiveSession => ({
  ptyId,
  runId: null,
  kind: "shell",
  title: workspaceId,
  cwd: "/tmp",
  pid: 1,
  startedAt: "2026-09-26T00:00:00.000Z",
  origin: null,
  agentId: null,
  chatId: null,
  taskId: null,
  workspaceId,
  ...patch,
});

const claude = { program: "Claude Code", programEngineId: "claude" };

describe("attention", () => {
  it("flags a workspace out of sight whose CLI went quiet or finished, and clears it on a look", () => {
    trackLive([session("a", "one", { ...claude, working: true }), session("b", "two", claude), session("c", "three")], "one");
    // Quiet in the workspace on screen: nothing to flag.
    expect(trackLive([session("a", "one", { ...claude, working: false }), session("b", "two", claude), session("c", "three")], "one")).toEqual([]);

    trackLive([session("a", "one", { ...claude, working: true }), session("b", "two", claude), session("c", "three")], "two");
    const flagged = trackLive([session("a", "one", claude), session("b", "two"), session("c", "three")], "two");
    expect(flagged).toEqual([{ workspaceId: "one", label: "Claude Code", attention: "waiting" }]);
    // "two" finished on screen, and a plain shell never counts.
    const later = trackLive([session("a", "one", claude), session("c", "three")], null);
    expect(later).toEqual([]);

    // Looking at it clears it.
    expect(trackLive([session("a", "one", claude)], "one")).toEqual([]);
    trackLive([session("a", "one", claude)], "two");
    expect(trackLive([], "two")).toEqual([{ workspaceId: "one", label: "Claude Code", attention: "done" }]);
  });
});
