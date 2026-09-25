import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type { Schedule } from "./types.js";

export const TICK_MS = 30_000;
export const MIN_INTERVAL_MINUTES = 5;

export type TickSkipReason =
  | "invalid-schedule"
  | "disabled"
  | "disallowed"
  | "engine-missing"
  | "not-due"
  | "still-running";

export type TickDecision =
  | { action: "fire"; scheduledAt: string }
  | { action: "miss"; scheduledAt: string }
  | { action: "skip"; reason: TickSkipReason };

export interface RoutineTickInput {
  now: Date;
  appStartedAt: Date;
  enabled: boolean;
  allowRoutines: boolean;
  engineAvailable: boolean;
  schedule: Schedule;
  lastFiredAt: string | null;
  previousStillRunning: boolean;
}

export type RunNowDecision =
  | { ok: true }
  | { ok: false; reason: "disallowed" | "engine-missing" | "still-running" };

export interface RunNowInput {
  allowRoutines: boolean;
  engineAvailable: boolean;
  previousStillRunning: boolean;
}

export function isScheduleValid(schedule: Schedule | null | undefined): boolean {
  if (!schedule) return false;
  if (schedule.kind === "every") {
    return (
      typeof schedule.minutes === "number" &&
      Number.isInteger(schedule.minutes) &&
      schedule.minutes >= MIN_INTERVAL_MINUTES &&
      schedule.minutes <= 7 * 24 * 60
    );
  }
  if (schedule.kind === "cron") {
    const expr = typeof schedule.expr === "string" ? schedule.expr.trim() : "";
    if (expr.split(/\s+/).length !== 5) return false;
    try {
      CronExpressionParser.parse(expr);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Interval slots line up with local midnight, so "every 60 minutes" fires on the hour. */
function localOffsetMs(at: number): number {
  return -new Date(at).getTimezoneOffset() * 60_000;
}

function intervalSlot(at: number, minutes: number): number {
  const interval = minutes * 60_000;
  const offset = localOffsetMs(at);
  return Math.floor((at + offset) / interval) * interval - offset;
}

export function mostRecentSlot(schedule: Schedule, now: Date): Date | null {
  if (!isScheduleValid(schedule)) return null;
  if (schedule.kind === "every") return new Date(intervalSlot(now.getTime(), schedule.minutes));
  try {
    // cron-parser's prev() skips a fire that lands exactly on currentDate, so check both sides.
    const prev = CronExpressionParser.parse(schedule.expr, { currentDate: now }).prev().toDate();
    const onTheDot = CronExpressionParser.parse(schedule.expr, { currentDate: new Date(now.getTime() - 1) })
      .next()
      .toDate();
    const candidates = [prev, onTheDot].filter((date) => date.getTime() <= now.getTime());
    candidates.sort((a, b) => b.getTime() - a.getTime());
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

export function nextFireTimes(schedule: Schedule, from: Date, count = 3): Date[] {
  if (count <= 0 || !isScheduleValid(schedule)) return [];
  if (schedule.kind === "every") {
    const interval = schedule.minutes * 60_000;
    let cursor = intervalSlot(from.getTime(), schedule.minutes);
    if (cursor <= from.getTime()) cursor += interval;
    const fires: Date[] = [];
    for (let index = 0; index < count; index += 1) {
      fires.push(new Date(cursor));
      cursor += interval;
    }
    return fires;
  }
  try {
    const expression = CronExpressionParser.parse(schedule.expr, { currentDate: from });
    const fires: Date[] = [];
    while (fires.length < count) fires.push(expression.next().toDate());
    return fires;
  } catch {
    return [];
  }
}

export function describeSchedule(schedule: Schedule): string {
  if (!isScheduleValid(schedule)) return "Not a valid schedule";
  if (schedule.kind === "every") {
    const minutes = schedule.minutes;
    if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  try {
    return cronstrue.toString(schedule.expr, { use24HourTimeFormat: true, verbose: false });
  } catch {
    return schedule.expr;
  }
}

function firedAtOrAfter(lastFiredAt: string | null, slot: Date): boolean {
  if (!lastFiredAt) return false;
  const ms = Date.parse(lastFiredAt);
  if (Number.isNaN(ms)) return false;
  return ms >= slot.getTime();
}

export function decideRoutineTick(input: RoutineTickInput): TickDecision {
  if (!isScheduleValid(input.schedule)) return { action: "skip", reason: "invalid-schedule" };
  if (input.enabled === false) return { action: "skip", reason: "disabled" };
  if (input.allowRoutines === false) return { action: "skip", reason: "disallowed" };
  if (input.engineAvailable === false) return { action: "skip", reason: "engine-missing" };
  const slot = mostRecentSlot(input.schedule, input.now);
  if (!slot || firedAtOrAfter(input.lastFiredAt, slot)) return { action: "skip", reason: "not-due" };
  const scheduledAt = slot.toISOString();
  if (slot.getTime() < input.appStartedAt.getTime()) return { action: "miss", scheduledAt };
  if (input.previousStillRunning) return { action: "skip", reason: "still-running" };
  return { action: "fire", scheduledAt };
}

export function decideRunNow(input: RunNowInput): RunNowDecision {
  if (input.allowRoutines === false) return { ok: false, reason: "disallowed" };
  if (input.engineAvailable === false) return { ok: false, reason: "engine-missing" };
  if (input.previousStillRunning) return { ok: false, reason: "still-running" };
  return { ok: true };
}
