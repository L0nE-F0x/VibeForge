import { afterEach, describe, expect, it, vi } from "vitest";
import { clockNow, subscribeClock } from "../../src/ui/clock.js";

describe("the shared clock", () => {
  afterEach(() => vi.useRealTimers());

  it("runs one timer for every listener on an interval, and stops with the last one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const ticks: string[] = [];
    const offA = subscribeClock(20_000, () => ticks.push("a"));
    const offB = subscribeClock(20_000, () => ticks.push("b"));
    expect(vi.getTimerCount()).toBe(1);
    const before = clockNow(20_000);
    // Between ticks every reader sees the same time.
    vi.advanceTimersByTime(5_000);
    expect(clockNow(20_000)).toBe(before);
    vi.advanceTimersByTime(15_000);
    expect(ticks).toEqual(["a", "b"]);
    expect(clockNow(20_000)).toBe(before + 20_000);
    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });
});
