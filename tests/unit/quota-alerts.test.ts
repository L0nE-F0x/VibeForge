import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanProvider, PlanSummary } from "../../src/core/plans.js";
import { quotaNote, QuotaAlerts } from "../../src/core/quota-alerts.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const RESET = "2026-09-30T14:30:00Z";

function summary(percent: number, extra: Partial<PlanProvider> = {}, resetsAt: string | null = RESET): PlanSummary {
  const provider: PlanProvider = {
    id: "claude",
    percent,
    limiter: "5-hour",
    resetsAt,
    windows: [{ name: "5-hour", percent, resetsAt }],
    credits: null,
    readAt: new Date(NOW - 60_000).toISOString(),
    problem: null,
    history: [],
    fullAt: null,
    ...extra,
  };
  return { providers: [provider], checkedAt: new Date(NOW).toISOString() };
}

describe("quota alerts", () => {
  it("announces 80, 95 and 100 once each per window, and only the highest one passed", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-quota-")), "quota.json");
    const alerts = new QuotaAlerts(file, () => NOW);
    expect(alerts.check(summary(40))).toEqual([]);
    expect(alerts.check(summary(81)).map((alert) => alert.step)).toEqual([80]);
    expect(alerts.check(summary(90))).toEqual([]);
    // 90 → 100 between two readings: one notification, for 100.
    expect(alerts.check(summary(100)).map((alert) => alert.step)).toEqual([100]);
    expect(alerts.check(summary(100))).toEqual([]);
    // A reset time that wanders by seconds is the same window.
    expect(alerts.check(summary(100, {}, "2026-09-30T14:30:07Z"))).toEqual([]);
    // After a restart the same window stays announced.
    expect(new QuotaAlerts(file, () => NOW).check(summary(100))).toEqual([]);
    // The window resets: a new reset time starts over.
    expect(alerts.check(summary(96, {}, "2026-09-30T19:30:00Z")).map((alert) => alert.step)).toEqual([95]);
  });

  it("ignores stale readings, problems and windows already past their reset", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-quota-")), "quota.json");
    const alerts = new QuotaAlerts(file, () => NOW);
    expect(alerts.check(summary(99, { readAt: new Date(NOW - 3_600_000).toISOString() }))).toEqual([]);
    expect(alerts.check(summary(99, { problem: "offline" }))).toEqual([]);
    expect(alerts.check(summary(99, {}, "2026-09-30T11:00:00Z"))).toEqual([]);
  });

  it("words the notification", () => {
    expect(quotaNote({ plan: "claude", window: "5-hour", step: 95, percent: 96.4, resetsAt: RESET }, NOW)).toEqual({
      title: "Claude: 96% of the 5-hour limit used",
      body: "Resets in 2h 30m.",
    });
    expect(quotaNote({ plan: "codex", window: "Weekly", step: 100, percent: 100, resetsAt: null }, NOW).title).toBe("Codex: the Weekly limit is reached");
  });
});
