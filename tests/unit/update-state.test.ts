import { afterEach, describe, expect, it, vi } from "vitest";
import { isStaleChunk, markUpdated, preloadWhenIdle, wasUpdated } from "../../src/ui/update-state.js";

describe("an update under the running window", () => {
  afterEach(() => vi.useRealTimers());

  it("knows a view whose file an update replaced from any other failure", () => {
    expect(isStaleChunk(new TypeError("Failed to fetch dynamically imported module: file:///app/dist/assets/Settings-DTuOIVcr.js"))).toBe(true);
    expect(isStaleChunk(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isStaleChunk(null)).toBe(false);
  });

  it("loads every lazy part once the window is idle, even when it never gets an idle moment", async () => {
    vi.useFakeTimers();
    const loads: string[] = [];
    const failing = () => Promise.reject(new Error("gone"));
    preloadWhenIdle([async () => loads.push("agents"), failing, async () => loads.push("settings")], 1000);
    expect(loads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loads).toEqual(["agents", "settings"]);
    // Cancelled before it ran: nothing loads.
    const later: string[] = [];
    const cancel = preloadWhenIdle([async () => later.push("x")], 1000);
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(later).toEqual([]);
  });

  it("remembers that the copy was updated", () => {
    markUpdated();
    expect(wasUpdated()).toBe(true);
  });
});
