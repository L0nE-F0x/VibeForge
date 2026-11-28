import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import { detectWaitingPrompt } from "../shared/orchestrator-intel.js";
import { isCutOffRun } from "../shared/routine-result.js";
import type { RoutineRunResult, RunMeta, Schedule } from "./types.js";

export { isCutOffRun };

export const TICK_MS = 30_000;
/** Slots older than this (e.g. while asleep) count as missed rather than running late. */
export const MAX_SLOT_LATENESS_MS = 2 * 60_000;
export const MIN_INTERVAL_MINUTES = 5;
export const DEFAULT_ROUTINE_TIMEOUT_MINUTES = 120;
export const MIN_ROUTINE_TIMEOUT_MINUTES = 5;
export const MAX_ROUTINE_TIMEOUT_MINUTES = 7 * 24 * 60;
/** Failed runs in a row before a routine glows on Routines and Home, and its notification says so. */
export const ROUTINE_FAILING = 3;

export function isRoutineTimeoutValid(minutes: unknown): minutes is number {
  return (
    typeof minutes === "number" &&
    Number.isInteger(minutes) &&
    minutes >= MIN_ROUTINE_TIMEOUT_MINUTES &&
    minutes <= MAX_ROUTINE_TIMEOUT_MINUTES
  );
}

/**
 * A routine's time limit as read from its file. One saved before time limits existed has none
 * (null) until the person sets one; a value out of range falls back to the default.
 */
export function normalizeRoutineTimeout(minutes: unknown): number | null {
  if (minutes === undefined || minutes === null) return null;
  return isRoutineTimeoutValid(minutes) ? minutes : DEFAULT_ROUTINE_TIMEOUT_MINUTES;
}

type StreakRun = Pick<RunMeta, "status"> & Partial<Pick<RunMeta, "result" | "origin" | "cutOff">>;

/**
 * Whether a finished routine run counts as a failure for `failStreak`: it couldn't start, quit
 * with an error, hit its time limit, or was cut off. Only runs that carry a result count, so runs
 * from before results were recorded never light a routine up. A question, or one that ended stuck
 * on a question, is never a failure.
 */
export function isRoutineFailure(run: StreakRun): boolean {
  return run.result === "failed" || run.result === "timeout" || isCutOffRun(run);
}

/**
 * How many of a routine's latest runs failed in a row, newest first. A live run is skipped
 * (unless waiting on a question, which breaks any older streak); anything that isn't a failure
 * ends it: a clean finish, a question, a manual stop, or a run from before results were recorded.
 */
export function failStreak(runs: ReadonlyArray<StreakRun>): number {
  let streak = 0;
  for (const run of runs) {
    if (run.status === "running") {
      if (run.result === "question") break;
      continue;
    }
    if (isRoutineFailure(run)) streak += 1;
    else break;
  }
  return streak;
}

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
  | { action: "skip"; reason: TickSkipReason; scheduledAt?: string };

export interface RoutineTickInput {
  now: Date;
  appStartedAt: Date;
  enabled: boolean;
  allowRoutines: boolean;
  engineAvailable: boolean;
  schedule: Schedule;
  lastFiredAt: string | null;
  previousStillRunning: boolean;
  previousEndedAt?: string | null;
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

/**
 * Interval slots are wall-clock times that line up with local midnight, so "every 60 minutes"
 * fires on the hour and "every day" at midnight, across a change to or from summer time too. A
 * slot is counted in minutes of the local calendar (days since 1970 times 1440, plus the time of
 * day) and turned back into an instant with the offset in force at that slot, not now: with
 * today's offset, the night summer time ended put yesterday's midnight an hour later, after it had
 * already fired, and it fired again.
 */
const DAY_MINUTES = 1440;

/** Minutes since 1970-01-01 00:00 on the local calendar and clock. */
function wallMinutes(at: number): number {
  const date = new Date(at);
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  return day * DAY_MINUTES + date.getHours() * 60 + date.getMinutes();
}

/** The instant a local calendar minute starts (the later one when the clock skips it). */
function fromWall(wall: number): number {
  const day = Math.floor(wall / DAY_MINUTES);
  const minute = wall - day * DAY_MINUTES;
  const date = new Date(day * 86_400_000);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), Math.floor(minute / 60), minute % 60).getTime();
}

function intervalSlot(at: number, minutes: number): number {
  let wall = Math.floor(wallMinutes(at) / minutes) * minutes;
  // The hour the clock repeats in autumn can put the slot just after `at`: take the one before.
  while (fromWall(wall) > at) wall -= minutes;
  return fromWall(wall);
}

/** The slot after `slot`, on the same wall-clock grid. */
function nextSlot(slot: number, minutes: number): number {
  let wall = (Math.floor(wallMinutes(slot) / minutes) + 1) * minutes;
  // A slot inside the hour the clock skips in spring lands on the same instant as the next one.
  while (fromWall(wall) <= slot) wall += minutes;
  return fromWall(wall);
}

function sameWallMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
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
    // When spring-forward skipped the scheduled hour, prev() jumps back past today: walk forward from 3h ago to pick up the shifted fire (matches nextFireTimes).
    if (prev.getTime() < now.getTime() - 2 * 3600_000) {
      const probe = CronExpressionParser.parse(schedule.expr, { currentDate: new Date(Math.max(prev.getTime(), now.getTime() - 3 * 3600_000)) });
      for (let i = 0; i < 4; i += 1) {
        const next = probe.next().toDate();
        if (next.getTime() > now.getTime()) break;
        candidates.push(next);
      }
    }
    candidates.sort((a, b) => b.getTime() - a.getTime());
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

export function nextFireTimes(schedule: Schedule, from: Date, count = 3): Date[] {
  if (count <= 0 || !isScheduleValid(schedule)) return [];
  if (schedule.kind === "every") {
    let cursor = intervalSlot(from.getTime(), schedule.minutes);
    if (cursor <= from.getTime()) cursor = nextSlot(cursor, schedule.minutes);
    const fires: Date[] = [];
    for (let index = 0; index < count; index += 1) {
      fires.push(new Date(cursor));
      cursor = nextSlot(cursor, schedule.minutes);
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

export function firedAtOrAfter(lastFiredAt: string | null, slot: Date): boolean {
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
  if (input.schedule.kind === "cron" && input.lastFiredAt) {
    const last = new Date(input.lastFiredAt);
    const lastSlot = Number.isNaN(last.getTime()) ? null : mostRecentSlot(input.schedule, last);
    // Autumn fallback repeats the same local wall-clock hour: fire at most once for that wall-clock slot.
    if (lastSlot && sameWallMinute(lastSlot, slot)) return { action: "skip", reason: "not-due" };
  }
  const scheduledAt = slot.toISOString();
  if (slot.getTime() < input.appStartedAt.getTime()) return { action: "miss", scheduledAt };
  // A slot that comes while the last run is still open is skipped, and recorded as skipped.
  if (input.previousStillRunning) return { action: "skip", reason: "still-running", scheduledAt };
  if (input.now.getTime() - slot.getTime() > MAX_SLOT_LATENESS_MS) {
    // A run that finished after this slot overlapped it while running, so it wasn't missed while closed.
    const prevEnd = input.previousEndedAt ? Date.parse(input.previousEndedAt) : Number.NaN;
    if (Number.isFinite(prevEnd) && prevEnd >= slot.getTime()) return { action: "skip", reason: "still-running", scheduledAt };
    return { action: "miss", scheduledAt };
  }
  return { action: "fire", scheduledAt };
}

export function decideRunNow(input: RunNowInput): RunNowDecision {
  if (input.allowRoutines === false) return { ok: false, reason: "disallowed" };
  if (input.engineAvailable === false) return { ok: false, reason: "engine-missing" };
  if (input.previousStillRunning) return { ok: false, reason: "still-running" };
  return { ok: true };
}

const CHOICE_OPTION_LINE = /^(?:[-*•]|\d+[.)])\s+\S.*$/;
/** A line that waits for a person without asking in so many words: "Press Enter", "Waiting for approval…". */
const PERSON_PROMPT_LINE = /\bpress (?:enter|return|any key|space)\b|\bapprov(?:al|e)\b|\bwaiting for\b|\bawaiting\b|\((?:y\/n|yes\/no)\)|\[(?:y\/n|Y\/n|y\/N)\]/i;
/** Frame and prompt marks a TUI draws around its text. */
const CHROME = /^[\s│┃║╭╮╰╯┌┐└┘├┤─━═❯›>*•·]+|[\s│┃║╭╮╰╯┌┐└┘├┤─━═]+$/g;

function stripCodeAndUrls(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

function endsWithQuestionMark(line: string): boolean {
  const cleaned = line.replace(/["'”’)\]*_~`]+$/g, "").trimEnd();
  return cleaned.endsWith("?") || cleaned.endsWith("？");
}

/** The lines of `text` with words in them, oldest first; `framed` takes a TUI's frame marks off too. */
function meaningfulLines(text: string, framed = false): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => (framed ? line.replace(CHROME, "") : line).trim())
    .filter((line) => /[\p{L}\p{N}?？]/u.test(line));
}

/**
 * Whether a CLI's reply (from its log, or the end of its screen) ends asking the person
 * something: its last line, past a short list of choices, ends in "?" or waits for a key or an
 * approval. Fail safe: any question at all counts, "Anything else?" too.
 */
export function replyAsks(reply: string | null | undefined): boolean {
  const lines = meaningfulLines(stripCodeAndUrls(reply ?? "")).map((line) => line.replace(/^>\s?/, ""));
  if (!lines.length) return false;
  // A question followed by a short bulleted or numbered list of choices puts the "?" right above the choices.
  let dropped = 0;
  while (lines.length > 1 && dropped < 6 && CHOICE_OPTION_LINE.test(lines[lines.length - 1]) && lines[lines.length - 1].length <= 120) {
    if (endsWithQuestionMark(lines[lines.length - 1])) break;
    lines.pop();
    dropped += 1;
  }
  const last = lines[lines.length - 1];
  return endsWithQuestionMark(last) || PERSON_PROMPT_LINE.test(last);
}

/**
 * Whether a quiet terminal's screen shows it waiting on a person: a prompt VibeForge knows
 * (trust, approval, sign-in), a line near the bottom ending in "?" (choices and the CLI's own
 * frame can sit below it), or "Press Enter" / "Waiting for…" / "approval" in its last lines.
 */
export function screenAsks(screen: string | null | undefined): boolean {
  if (!screen?.trim()) return false;
  if (detectWaitingPrompt(screen)) return true;
  const lines = meaningfulLines(screen, true);
  return lines.slice(-6).some(endsWithQuestionMark) || lines.slice(-3).some((line) => PERSON_PROMPT_LINE.test(line));
}

/** Whether a reply or screen ends waiting on a person. */
export function isQuestionForPerson(reply: string | null | undefined, screen?: string | null): boolean {
  return replyAsks(reply) || Boolean(screen && detectWaitingPrompt(screen));
}

/**
 * A closing offer after the work is done ("Want me to also open a PR?", "Anything else?",
 * "Let me know if…"): the turn finished, and nothing waits on the answer. Only clearly optional
 * offers; a question about the task itself ("Should I delete them?") still waits.
 */
const CLOSING_OFFER = /\b(?:anything else|is there anything else|let me know if|(?:do you )?want me to (?:also|go ahead and also)|would you like me to (?:also|next)|shall i also|should i also)\b|\bas well\?\s*$/i;

/** Whether a reply from the CLI's log ends on a closing offer rather than a question about the work. */
export function endsOnOffer(reply: string | null | undefined): boolean {
  const lines = meaningfulLines(stripCodeAndUrls(reply ?? "")).map((line) => line.replace(/^>\s?/, ""));
  const last = lines[lines.length - 1] ?? "";
  return CLOSING_OFFER.test(last) && !PERSON_PROMPT_LINE.test(last);
}

/**
 * What a routine turn event from the watcher means. Only the CLI's own log can say a turn
 * finished; a quiet screen can only mean "question" (it waits for a person) or "working" (keep
 * watching), never "finished", so a routine is never ended mid-work. A CLI whose log VibeForge
 * can't read is never ended on its screen at all: it stays open until its time limit, or until it
 * quits by itself.
 */
export function classifyRoutineTurn(input: {
  reply: string | null;
  screen?: string | null;
  fromScreen: boolean;
  hasLogReader: boolean;
}): Extract<RoutineRunResult, "finished" | "question"> | "working" {
  if (input.fromScreen) return screenAsks(input.screen) || replyAsks(input.reply) ? "question" : "working";
  // The log says the turn ended on a closing offer: the work is done.
  if (input.hasLogReader && endsOnOffer(input.reply) && !(input.screen && detectWaitingPrompt(input.screen))) return "finished";
  if (isQuestionForPerson(input.reply, input.screen)) return "question";
  return input.hasLogReader ? "finished" : "working";
}
