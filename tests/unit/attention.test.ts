import { beforeEach, describe, expect, it } from "vitest";
import type { LiveSession } from "../../src/shared/api.js";
import { FIRST_SCREEN_MS, resetAttention, trackLive, type Looking } from "../../src/ui/attention.js";
import { routeForMark } from "../../src/ui/state.js";

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
const look = (ptys: string[] = [], workspaceId: string | null = null, chatId: string | null = null): Looking => ({ ptys: new Set(ptys), chatId, workspaceId });
let now = 0;
const track = (live: LiveSession[], looking: Looking | null) => trackLive(live, looking, (now += 1000));
const names = (marks: Array<{ ptyId: string; attention: string }>) => marks.map((mark) => `${mark.ptyId}:${mark.attention}`);

beforeEach(() => {
  resetAttention();
  now = 0;
});

describe("attention", () => {
  it("marks each terminal that went quiet out of sight, and looking at one leaves the others", () => {
    const busy = [session("a", "ws", { ...claude, working: true }), session("b", "ws", { ...claude, working: true })];
    track(busy, look(["a"], "ws"));
    // Both go quiet; the focused one is being watched.
    const quiet = [session("a", "ws", claude), session("b", "ws", claude)];
    expect(names(track(quiet, look(["a"], "ws")))).toEqual(["b:waiting"]);
    // Looking at "a" again, in the same workspace, doesn't clear "b".
    expect(track(quiet, look(["a"], "ws"))).toEqual([]);
    let marks = track(quiet, look(["a"], "ws"));
    expect(marks).toEqual([]);
    // Focusing "b" clears it.
    track(quiet, look(["b"], "ws"));
    marks = track([session("a", "ws", { ...claude, working: true }), session("b", "ws", claude)], look(["b"], "ws"));
    expect(marks).toEqual([]);
  });

  it("still marks the focused pane when VibeForge is in the background", () => {
    track([session("a", "ws", { ...claude, working: true })], look(["a"], "ws"));
    expect(names(track([session("a", "ws", claude)], null))).toEqual(["a:waiting"]);
    // Already waiting: no second knock.
    expect(track([session("a", "ws", claude)], null)).toEqual([]);
  });

  it("counts a CLI sitting on its first screen as waiting, once", () => {
    const first = [session("t", "ws", { kind: "run", origin: "task", taskId: "fix", title: "Fix lamp" })];
    expect(track(first, null)).toEqual([]);
    now += FIRST_SCREEN_MS;
    expect(names(track(first, null))).toEqual(["t:waiting"]);
    expect(track(first, null)).toEqual([]);
    // A CLI that got to work at once never had a question to ask.
    track([session("u", "ws", { ...claude, working: true })], null);
    now += FIRST_SCREEN_MS;
    expect(track([session("u", "ws", { ...claude, working: true })], null)).toEqual([]);
  });

  it("marks a finished CLI done, and a waiting one that ends only quietly", () => {
    track([session("a", "ws", { ...claude, working: true }), session("b", "ws", { ...claude, working: true })], null);
    expect(names(track([session("a", "ws", claude), session("b", "ws", { ...claude, working: true })], null))).toEqual(["a:waiting"]);
    expect(names(track([], null))).toEqual(["b:done"]);
    // Opening the workspace clears what ended there.
    expect(track([], look([], "ws"))).toEqual([]);
  });

  it("marks an agent's chat and clears it when the chat is in view", () => {
    const chat = (working: boolean) => session("p-chat", "ws", { kind: "run", origin: "agent-chat", agentId: "atlas", chatId: "c1", title: "Atlas", working });
    track([chat(true)], null);
    const [mark] = track([chat(false)], look([], "ws"));
    expect(mark).toMatchObject({ chatId: "c1", agentId: "atlas", label: "Atlas", attention: "waiting" });
    expect(routeForMark(mark, true)).toEqual({ view: "agents", agentId: "atlas", tab: "chats", chatId: "c1" });
    track([chat(false)], look([], null, "c1"));
    track([chat(true)], null);
    expect(track([chat(false)], null)).toHaveLength(1);
    // Quiet while you're looking at it: nothing.
    track([chat(false)], look([], null, "c1"));
    track([chat(true)], look([], null, "c1"));
    expect(track([chat(false)], look([], null, "c1"))).toEqual([]);
  });

  it("opens each waiter where it waits", () => {
    const base = { ptyId: "p", attention: "waiting" as const, label: "x", agentId: null, chatId: null, taskId: null, routineId: null, runId: "r1", since: 0 };
    expect(routeForMark({ ...base, origin: "task", taskId: "fix", workspaceId: "ws" }, true)).toEqual({ view: "tasks", taskId: "fix" });
    expect(routeForMark({ ...base, origin: null, workspaceId: "ws" }, true)).toEqual({ view: "code", workspaceId: "ws", ptyId: "p" });
    expect(routeForMark({ ...base, origin: "code", workspaceId: "ws" }, false)).toEqual({ view: "code", workspaceId: "ws", ptyId: undefined });
    expect(routeForMark({ ...base, origin: "routine", routineId: "daily", workspaceId: null }, true)).toEqual({ view: "runs", runId: "r1" });
  });
});

describe("routes handed back by the main process", () => {
  it("follows only a route this page could have made", async () => {
    const { isRoute } = await import("../../src/ui/state.js");
    expect(isRoute({ view: "tasks", taskId: "fix" })).toBe(true);
    expect(isRoute({ view: "code", workspaceId: "ws", ptyId: undefined })).toBe(true);
    expect(isRoute({ view: "nowhere" })).toBe(false);
    expect(isRoute({ view: "runs", runId: { evil: true } })).toBe(false);
    expect(isRoute(null)).toBe(false);
  });
});
