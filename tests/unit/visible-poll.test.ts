import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileShown, type Visibility } from "../../src/ui/visible-poll.js";

/** A page whose visibility the test flips. */
function page(hidden = false) {
  const listeners = new Set<() => void>();
  const fake = {
    hidden,
    listeners,
    addEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.delete(listener),
    set(next: boolean) {
      this.hidden = next;
      for (const listener of listeners) listener();
    },
  };
  return fake satisfies Visibility;
}

describe("polling only while the window is on screen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at once and then on its interval while visible", () => {
    const work = vi.fn();
    pollWhileShown(work, 2000, page());
    expect(work).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6000);
    expect(work).toHaveBeenCalledTimes(4);
  });

  it("sets no timer and runs nothing while hidden, and runs at once on coming back", () => {
    const work = vi.fn();
    const shown = page();
    pollWhileShown(work, 2000, shown);
    shown.set(true);
    const before = work.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(work.mock.calls.length).toBe(before);
    shown.set(false);
    expect(work.mock.calls.length).toBe(before + 1);
    vi.advanceTimersByTime(2000);
    expect(work.mock.calls.length).toBe(before + 2);
  });

  it("waits for the page to show when it starts hidden", () => {
    const work = vi.fn();
    const shown = page(true);
    pollWhileShown(work, 4000, shown);
    vi.advanceTimersByTime(20_000);
    expect(work).not.toHaveBeenCalled();
    shown.set(false);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("stops for good, timer and listener, when stopped", () => {
    const work = vi.fn();
    const shown = page();
    const stop = pollWhileShown(work, 2000, shown);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(shown.listeners.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("doesn't start a second timer when shown twice in a row", () => {
    const work = vi.fn();
    const shown = page();
    pollWhileShown(work, 2000, shown);
    shown.set(false);
    expect(vi.getTimerCount()).toBe(1);
  });
});
