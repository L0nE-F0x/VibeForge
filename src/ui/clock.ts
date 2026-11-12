// One clock per interval for the whole window. Every "3m ago" and running timer on screen reads the
// same one instead of each starting its own interval: a list of 300 runs is one timer, not 300.

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/** The time as the clock that ticks every `intervalMs` last read it. The same number until it ticks. */
export function clockNow(intervalMs: number): number {
  return clockFor(intervalMs).now;
}

/** Hear that clock tick. The clock runs while anyone listens, and stops with the last one. */
export function subscribeClock(intervalMs: number, listener: () => void): () => void {
  const clock = clockFor(intervalMs);
  clock.listeners.add(listener);
  if (!clock.timer) {
    // Fresh when it starts, so what mounts after a quiet spell doesn't show a time from back then.
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      for (const each of [...clock.listeners]) each();
    }, intervalMs);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size || !clock.timer) return;
    clearInterval(clock.timer);
    clock.timer = null;
  };
}
