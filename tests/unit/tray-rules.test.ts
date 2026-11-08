import { describe, expect, it } from "vitest";
import { attentionFrom, trayHostAnswer } from "../../electron/guards.js";

describe("who the tray says is waiting", () => {
  it("keeps the page's count and names", () => {
    const route = { view: "code", workspaceId: "w1" };
    expect(attentionFrom({ count: 2, waiters: [{ label: "Claude in api", route }] })).toEqual({ count: 2, waiters: [{ label: "Claude in api", route }] });
  });

  it("makes a whole, non-negative count of whatever came", () => {
    expect(attentionFrom({ count: 2.9, waiters: [] }).count).toBe(2);
    expect(attentionFrom({ count: -3, waiters: [] }).count).toBe(0);
    expect(attentionFrom({ count: "4", waiters: [] } as never).count).toBe(4);
    expect(attentionFrom({ count: Number.NaN, waiters: [] }).count).toBe(0);
    expect(attentionFrom(null)).toEqual({ count: 0, waiters: [] });
    expect(attentionFrom(undefined)).toEqual({ count: 0, waiters: [] });
  });

  it("lists at most eight, each name cut to 80 characters, with no route when none came", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ label: `CLI ${index}`, route: index }));
    expect(attentionFrom({ count: 12, waiters: many }).waiters.map((waiter) => waiter.label)).toEqual(many.slice(0, 8).map((waiter) => waiter.label));
    const long = attentionFrom({ count: 1, waiters: [{ label: "x".repeat(200) } as never] }).waiters[0];
    expect(long).toEqual({ label: "x".repeat(80), route: null });
    expect(attentionFrom({ count: 1, waiters: [null, { label: 7 }] as never }).waiters).toEqual([
      { label: "", route: null },
      { label: "7", route: null },
    ]);
    expect(attentionFrom({ count: 1, waiters: "nope" } as never).waiters).toEqual([]);
  });
});

describe("whether anything hosts tray icons", () => {
  it("reads dbus-send's answer", () => {
    expect(trayHostAnswer(null, "method return time=1 sender=org.freedesktop.DBus\n   boolean true\n")).toBe(true);
    expect(trayHostAnswer(null, "method return time=1 sender=org.freedesktop.DBus\n   boolean false\n")).toBe(false);
  });

  it("leaves it to the settings without dbus-send, and says no when the bus didn't answer", () => {
    expect(trayHostAnswer({ code: "ENOENT" }, "")).toBe(true);
    expect(trayHostAnswer({ code: 1 }, "")).toBe(false);
    expect(trayHostAnswer({ code: null }, "")).toBe(false);
  });
});
