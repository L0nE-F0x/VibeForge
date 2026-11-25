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
});

