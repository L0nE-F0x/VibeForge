import { describe, expect, it } from "vitest";
import { MainContext } from "../../electron/main-context.js";

function context(): MainContext {
  return new MainContext({
    roots: { configRoot: "/c", dataRoot: "/d" },
    log: {} as never,
    supervisor: {} as never,
    words: {} as never,
    appRoot: "/opt/vibeforge",
    install: "checkout",
    palette: {} as never,
  });
}

/** A stand-in BrowserWindow that records what is done to it. */
function fakeWindow(state: { destroyed?: boolean; minimized?: boolean } = {}) {
  const done: string[] = [];
  const sent: unknown[][] = [];
  const win = {
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => done.push("restore"),
    show: () => done.push("show"),
    focus: () => done.push("focus"),
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  };
  return { win: win as never, done, sent };
}

describe("the main process's shared context", () => {
  it("finds the icon and the one page with the bridge beside the app", () => {
    const ctx = context();
    expect(ctx.iconPath).toBe("/opt/vibeforge/resources/icon.png");
    expect(ctx.page.file).toBe("/opt/vibeforge/dist/index.html");
  });

  it("sends to the page only while the window is open", () => {
    const ctx = context();
    expect(() => ctx.send("host-crash", "gone")).not.toThrow();
    const open = fakeWindow();
    ctx.win = open.win;
    ctx.send("host-crash", "gone");
    expect(open.sent).toEqual([["vf:host-crash", "gone"]]);
    const closed = fakeWindow({ destroyed: true });
    ctx.win = closed.win;
    ctx.send("host-crash", "again");
    expect(closed.sent).toEqual([]);
  });

  it("says the core is still starting until it is there", () => {
    const ctx = context();
    const { svc } = ctx;
    expect(() => svc()).toThrow("VibeForge is still starting.");
    ctx.service = { name: "core" } as never;
    expect(svc()).toBe(ctx.service);
  });

  it("brings a minimized window back before focusing it", () => {
    const ctx = context();
    const { focusWindow } = ctx;
    expect(() => focusWindow()).not.toThrow();
    const small = fakeWindow({ minimized: true });
    ctx.win = small.win;
    focusWindow();
    expect(small.done).toEqual(["restore", "show", "focus"]);
    const plain = fakeWindow();
    ctx.win = plain.win;
    focusWindow();
    expect(plain.done).toEqual(["show", "focus"]);
  });
});

describe("notices from the main process", () => {
  it("waits for a page to take them, then sends new ones as they happen", () => {
    const ctx = context();
    const { win, sent } = fakeWindow();
    ctx.win = win;
    // Before the page has asked (it is loading, or crashed): kept, one of each kind, the newest.
    ctx.notice({ id: "errors", count: 1 });
    ctx.notice({ id: "window-reloaded", reason: "crashed" });
    ctx.notice({ id: "errors", count: 2 });
    expect(sent).toEqual([]);
    expect(ctx.takeNotices()).toEqual([
      { id: "window-reloaded", reason: "crashed" },
      { id: "errors", count: 2 },
    ]);
    ctx.notice({ id: "host-stalled" });
    expect(sent).toEqual([["vf:notice", { id: "host-stalled" }]]);
    expect(ctx.takeNotices()).toEqual([]);
    // The page went: the next notice waits for the one that loads.
    ctx.pageGone();
    ctx.notice({ id: "host-answering" });
    expect(sent).toHaveLength(1);
    expect(ctx.takeNotices()).toEqual([{ id: "host-answering" }]);
  });

  it("keeps a burst of memory proposals from pushing out host-stopped or errors notices", () => {
    const ctx = context();
    const proposed = (agentId: string, note: string) => ({ id: "memory-proposed" as const, agentId, agentName: agentId, note, flagged: false, waiting: 1 });
    ctx.notice({ id: "host-stopped", terminals: 2, runIds: ["r1"] });
    ctx.notice({ id: "errors", count: 3 });
    for (let i = 0; i < 40; i += 1) ctx.notice(proposed(`agent-${i % 8}`, `line ${i}`));
    // One per agent, the newest; only the newest few agents.
    ctx.notice(proposed("agent-7", "newest for 7"));
    const held = ctx.takeNotices();
    expect(held.slice(0, 2)).toEqual([
      { id: "host-stopped", terminals: 2, runIds: ["r1"] },
      { id: "errors", count: 3 },
    ]);
    const kept = held.slice(2);
    expect(kept).toHaveLength(5);
    expect(kept.map((item) => (item.id === "memory-proposed" ? item.agentId : item.id))).toEqual(["agent-3", "agent-4", "agent-5", "agent-6", "agent-7"]);
    expect(kept.at(-1)).toMatchObject({ note: "newest for 7" });
  });
});
