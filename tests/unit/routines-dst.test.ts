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
});
