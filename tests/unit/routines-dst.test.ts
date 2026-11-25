// The time zone is set before anything here reads the clock: Node picks a change to TZ up at once.
process.env.TZ = "Europe/Berlin";

import { describe, expect, it } from "vitest";
import { decideRoutineTick, mostRecentSlot, nextFireTimes } from "../../src/core/routines.js";

// Summer time in Berlin ended on 2026-10-25 (03:00 CEST became 02:00 CET) and starts on
// 2026-03-29 (02:00 CET became 03:00 CEST).

const daily = { kind: "every", minutes: 1440 } as const;
const hourly = { kind: "every", minutes: 60 } as const;
const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

describe("interval routines across summer time", () => {
  it("fires a daily routine once on the night summer time ends", () => {
    // It fired at midnight, 00:00 CEST.
    const lastFiredAt = "2026-10-24T22:00:00.000Z";
    const tick = (now: string) =>
      decideRoutineTick({ now: new Date(now), appStartedAt: new Date("2026-10-24T12:00:00Z"), enabled: true, allowRoutines: true, engineAvailable: true, schedule: daily, lastFiredAt, previousStillRunning: false });
    // 02:30 CET, after the clocks went back, and the evening after.
    expect(tick("2026-10-25T01:30:00Z")).toEqual({ action: "skip", reason: "not-due" });
    expect(tick("2026-10-25T20:00:00Z")).toEqual({ action: "skip", reason: "not-due" });
    // The next midnight is 00:00 CET.
    expect(tick("2026-10-25T23:00:30Z")).toEqual({ action: "fire", scheduledAt: "2026-10-25T23:00:00.000Z" });
    expect(mostRecentSlot(daily, new Date("2026-10-25T01:30:00Z"))?.toISOString()).toBe(lastFiredAt);
  });

  it("shows the next fires at local midnight and on the hour on both sides of a change", () => {
    expect(iso(nextFireTimes(daily, new Date("2026-10-24T12:00:00Z"), 3))).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", "2026-10-26T23:00:00.000Z"]);
    // 01:30 CET on the night the clock skips 02:00 to 03:00.
    expect(iso(nextFireTimes(hourly, new Date("2026-03-29T00:30:00Z"), 3))).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z", "2026-03-29T03:00:00.000Z"]);
    expect(iso(nextFireTimes({ kind: "every", minutes: 720 }, new Date("2026-03-28T13:00:00Z"), 2))).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T10:00:00.000Z"]);
  });

  it("marks a slot missed instead of running hours late after sleep", () => {
    const decision = decideRoutineTick({
      now: new Date("2026-10-25T10:30:00Z"),
      appStartedAt: new Date("2026-10-25T07:00:00Z"),
      enabled: true,
      allowRoutines: true,
      engineAvailable: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      lastFiredAt: null,
      previousStillRunning: false,
    });
    expect(decision).toEqual({ action: "miss", scheduledAt: "2026-10-25T08:00:00.000Z" });
  });

  it("fires a cron routine once across autumn fallback and spring forward", () => {
    const cron = { kind: "cron", expr: "30 2 * * *" } as const;
    const base = { appStartedAt: new Date("2026-03-01T00:00:00Z"), enabled: true, allowRoutines: true, engineAvailable: true, schedule: cron, previousStillRunning: false } as const;

    // Autumn fallback (2026-10-25): 02:30 happens in CEST (+0200, 00:30Z) and again in CET (+0100, 01:30Z).
    const first = decideRoutineTick({ ...base, now: new Date("2026-10-25T00:30:30.000Z"), lastFiredAt: "2026-10-24T00:30:00.000Z" });
    expect(first).toEqual({ action: "fire", scheduledAt: "2026-10-25T00:30:00.000Z" });
    const repeated = decideRoutineTick({ ...base, now: new Date("2026-10-25T01:30:30.000Z"), lastFiredAt: "2026-10-25T00:30:05.000Z" });
    expect(repeated).toEqual({ action: "skip", reason: "not-due" });
    const nextDay = decideRoutineTick({ ...base, now: new Date("2026-10-26T01:30:30.000Z"), lastFiredAt: "2026-10-25T00:30:05.000Z" });
    expect(nextDay).toEqual({ action: "fire", scheduledAt: "2026-10-26T01:30:00.000Z" });

    // Spring forward (2026-03-29): 02:00 CET jumps to 03:00 CEST, so 02:30 moves to 03:30 CEST (01:30Z) matching nextFireTimes.
    expect(nextFireTimes(cron, new Date("2026-03-29T00:59:00.000Z"), 1).map((d) => d.toISOString())).toEqual(["2026-03-29T01:30:00.000Z"]);
    const skippedHour = decideRoutineTick({ ...base, now: new Date("2026-03-29T01:30:30.000Z"), lastFiredAt: "2026-03-28T01:30:00.000Z" });
    expect(skippedHour).toEqual({ action: "fire", scheduledAt: "2026-03-29T01:30:00.000Z" });
  });
});

describe("cron routines where summer time starts at midnight", () => {
  it("fires a midnight routine at 01:00 on the night the clock skips midnight", () => {
    // Chile's clocks went from 00:00 to 01:00 on Sunday 2026-09-06; Egypt, Cuba and Lebanon change
    // at midnight too.
    process.env.TZ = "America/Santiago";
    try {
      const base = { appStartedAt: new Date("2026-09-01T00:00:00Z"), enabled: true, allowRoutines: true, engineAvailable: true, previousStillRunning: false } as const;
      const daily = { kind: "cron", expr: "0 0 * * *" } as const;
      // The Routines page says the next one is at 01:00 (-03), and that is when it fires.
      expect(iso(nextFireTimes(daily, new Date("2026-09-05T23:00:00Z"), 2))).toEqual(["2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"]);
      expect(decideRoutineTick({ ...base, schedule: daily, now: new Date("2026-09-06T04:00:30Z"), lastFiredAt: "2026-09-05T04:00:00.000Z" })).toEqual({ action: "fire", scheduledAt: "2026-09-06T04:00:00.000Z" });
      // Once, and on time again the next night.
      expect(decideRoutineTick({ ...base, schedule: daily, now: new Date("2026-09-06T04:01:00Z"), lastFiredAt: "2026-09-06T04:00:00.000Z" })).toEqual({ action: "skip", reason: "not-due" });
      expect(decideRoutineTick({ ...base, schedule: daily, now: new Date("2026-09-07T03:00:30Z"), lastFiredAt: "2026-09-06T04:00:00.000Z" })).toEqual({ action: "fire", scheduledAt: "2026-09-07T03:00:00.000Z" });
      // A weekly one on Sundays at midnight too.
      const weekly = { kind: "cron", expr: "0 0 * * 0" } as const;
      expect(decideRoutineTick({ ...base, schedule: weekly, now: new Date("2026-09-06T04:00:30Z"), lastFiredAt: "2026-08-30T04:00:00.000Z" })).toEqual({ action: "fire", scheduledAt: "2026-09-06T04:00:00.000Z" });
    } finally {
      process.env.TZ = "Europe/Berlin";
    }
  });
});
