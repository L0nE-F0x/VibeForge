import { describe, expect, it } from "vitest";
import { openNote, type NoteTarget } from "../../electron/guards.js";

function opened(note: NoteTarget): unknown[][] {
  const sent: unknown[][] = [];
  openNote(note, (event, payload) => sent.push([event, payload]));
  return sent;
}

describe("clicking a desktop notification", () => {
  it("opens the route the page gave it, over anything else it names", () => {
    const route = { view: "code", workspaceId: "w1" };
    expect(opened({ route, runId: "r1", workspaceId: "w1" })).toEqual([["open-route", { route }]]);
  });

  it("opens a task, then a routine, then a run, by what the core named", () => {
    expect(opened({ taskId: "t1", routineId: "o1", runId: "r1" })).toEqual([["open-route", { route: { view: "tasks", taskId: "t1" } }]]);
    expect(opened({ routineId: "o1", runId: "r1" })).toEqual([["open-route", { route: { view: "routines", routineId: "o1" } }]]);
    expect(opened({ runId: "r1", workspaceId: "w1" })).toEqual([["open-run", { runId: "r1" }]]);
  });

  it("opens a chat with its agent, else the workspace", () => {
    expect(opened({ chatId: "c1", agentId: "a1", workspaceId: "w1" })).toEqual([["open-chat", { chatId: "c1", agentId: "a1" }]]);
    expect(opened({ chatId: "c1" })).toEqual([["open-chat", { chatId: "c1", agentId: null }]]);
    expect(opened({ workspaceId: "w1", chatId: null })).toEqual([["open-workspace", { workspaceId: "w1" }]]);
  });

  it("only brings the window up when it names nowhere", () => {
    expect(opened({})).toEqual([]);
    expect(opened({ workspaceId: null, chatId: null, route: null })).toEqual([]);
  });
});
