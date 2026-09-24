import { CronExpressionParser } from "cron-parser";

export const TICK_MS = 30_000;
import type { Schedule } from "./types.js";

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

interface CronPoint {
  toDate?: () => Date;
  getTime: () => number;
}

function cronToDate(value: CronPoint): Date {
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value.getTime());
  return new Date(date.getTime());
}

export function isScheduleValid(schedule: Schedule | null | undefined): boolean {
  if (!schedule) return false;
  if (schedule.kind === "every") {
    return typeof schedule.minutes === "number" && Number.isFinite(schedule.minutes) && schedule.minutes >= 5;
  }
  if (schedule.kind === "cron") {
    if (typeof schedule.expr !== "string" || schedule.expr.trim().length === 0) return false;
    try {
      CronExpressionParser.parse(schedule.expr);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function mostRecentSlot(schedule: Schedule, now: Date): Date | null {
  if (!isScheduleValid(schedule)) return null;
  if (schedule.kind === "every") {
    const intervalMs = schedule.minutes * 60_000;
    return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
  }
  try {
    // cron-parser's prev() skips a fire that lands exactly on currentDate.
    const prev = cronToDate(CronExpressionParser.parse(schedule.expr, { currentDate: now }).prev());
    const upcoming = cronToDate(
      CronExpressionParser.parse(schedule.expr, { currentDate: new Date(now.getTime() - 1) }).next(),
    );
    const candidates = [prev, upcoming].filter((date) => date.getTime() <= now.getTime());
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.getTime() - a.getTime());
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

export function nextFireTimes(schedule: Schedule, from: Date, count = 3): Date[] {
  if (count <= 0 || !isScheduleValid(schedule)) return [];
  if (schedule.kind === "every") {
    const intervalMs = schedule.minutes * 60_000;
    let cursor = Math.floor(from.getTime() / intervalMs) * intervalMs;
    if (cursor <= from.getTime()) cursor += intervalMs;
    const fires: Date[] = [];
    for (let index = 0; index < count; index += 1) {
      fires.push(new Date(cursor));
      cursor += intervalMs;
    }
    return fires;
  }
  try {
    const expression = CronExpressionParser.parse(schedule.expr, { currentDate: from });
    const fires: Date[] = [];
    let guard = 0;
    while (fires.length < count && guard < count + 8) {
      guard += 1;
      const next = cronToDate(expression.next());
      if (next.getTime() > from.getTime()) fires.push(next);
    }
    return fires;
  } catch {
    return [];
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
