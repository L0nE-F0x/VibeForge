// Pure parsing, normalization, and safety checks for Viby's full-app orchestrator steps:
// agents, routines (including schedule parsing), tasks, skills, workspaces, chats, runs, and talk.
// No Node imports here so the main process, desktop plan card, and phone view share identical logic.

import type { AgentTier, Schedule, TaskStatus } from "../core/types.js";

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

// ------------------------------------------------------------------ options parsing

export interface ParsedOptions {
  raw: Map<string, string>;
  has(key: string): boolean;
  str(key: string): string | undefined;
  bool(key: string): boolean | undefined;
  num(key: string): number | undefined;
}

export function parseBoolWord(raw: string | undefined): boolean | null {
  const clean = (raw ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:on|true|yes|1|enable|enabled)$/.test(clean)) return true;
  if (/^(?:off|false|no|0|disable|disabled)$/.test(clean)) return false;
  return null;
}

/**
 * Parses an `options` string into normalized key/value entries. Accepts comma- or semicolon-separated
 * `key=value` pairs (e.g. `"notify=false, shareCheckout=true, tier=strong"`), bare flags (`"isolated"`),
 * or a JSON object string (`'{"notify":false}'`). Keys are compared case/punctuation-insensitively.
 */
export function parseOptions(text: string | undefined): ParsedOptions {
  const raw = new Map<string, string>();
  const trimmed = (text ?? "").trim();
  if (trimmed) {
    let parsedJson = false;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            const key = squash(k);
            if (!key || v === undefined || v === null) continue;
            raw.set(key, String(v).trim());
          }
          parsedJson = true;
        }
      } catch {
        parsedJson = false;
      }
    }
    if (!parsedJson) {
      for (const part of trimmed.split(/[;,\n]+/)) {
        const item = part.trim();
        if (!item) continue;
        const sep = item.search(/[=:]/);
        if (sep > 0) {
          const key = squash(item.slice(0, sep));
          const val = item
            .slice(sep + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (key) raw.set(key, val);
        } else {
          const key = squash(item);
          if (key) raw.set(key, "true");
        }
      }
    }
  }
  return {
    raw,
    has: (key: string) => raw.has(squash(key)),
    str: (key: string) => raw.get(squash(key)),
    bool: (key: string) => {
      const value = raw.get(squash(key));
      if (value === undefined) return undefined;
      const parsed = parseBoolWord(value);
      return parsed === null ? undefined : parsed;
    },
    num: (key: string) => {
      const value = raw.get(squash(key));
      if (value === undefined || !value.trim()) return undefined;
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : undefined;
    },
  };
}

export function isClearWord(value: string | undefined): boolean {
  return /^(?:none|clear|empty|default|reset|auto|off)$/i.test((value ?? "").trim());
}

// ------------------------------------------------------------------ routine schedule parsing

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAYS_SHORT: Record<string, number> = {
  sun: 0,
  sunday: 0,
  sundays: 0,
  mon: 1,
  monday: 1,
  mondays: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  tuesdays: 2,
  wed: 3,
  wednesday: 3,
  wednesdays: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  thursdays: 4,
  fri: 5,
  friday: 5,
  fridays: 5,
  sat: 6,
  saturday: 6,
  saturdays: 6,
};

function parseCronAtom(atom: string, min: number, max: number, names?: Record<string, number>): number | null {
  const lower = atom.toLowerCase();
  if (names && lower in names) return names[lower];
  if (!/^\d+$/.test(lower)) return null;
  const num = Number(lower);
  return num >= min && num <= max ? num : null;
}

function isCronFieldValid(field: string, min: number, max: number, names?: Record<string, number>): boolean {
  if (!field) return false;
  for (const part of field.split(",")) {
    if (!part) return false;
    const pieces = part.split("/");
    if (pieces.length > 2) return false;
    const [range, stepRaw] = pieces;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return false;
      const step = Number(stepRaw);
      if (step < 1 || step > max - min + 1) return false;
    }
    if (range === "*") continue;
    if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) return false;
      const a = parseCronAtom(bounds[0], min, max, names);
      const b = parseCronAtom(bounds[1], min, max, names);
      if (a === null || b === null || a > b) return false;
      continue;
    }
    if (parseCronAtom(range, min, max, names) === null) return false;
  }
  return true;
}

/** Pure 5-field cron validator (minute hour day-of-month month day-of-week). */
export function isCronExprValid(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, month, dow] = fields;
  const dowNames: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return (
    isCronFieldValid(min, 0, 59) &&
    isCronFieldValid(hour, 0, 23) &&
    isCronFieldValid(dom, 1, 31) &&
    isCronFieldValid(month, 1, 12, MONTHS) &&
    isCronFieldValid(dow, 0, 7, dowNames)
  );
}

function parseClockTime(raw: string): { hour: number; minute: number } | null {
  const text = raw.trim().toLowerCase();
  if (text === "midnight") return { hour: 0, minute: 0 };
  if (text === "noon") return { hour: 12, minute: 0 };
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/.exec(text);
  if (ampm) {
    const h = Number(ampm[1]);
    const m = ampm[2] ? Number(ampm[2]) : 0;
    const pm = ampm[3].startsWith("p");
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    const hour = pm ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h;
    return { hour, minute: m };
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
  const bare = /^(\d{1,2})$/.exec(text);
  if (bare) {
    const hour = Number(bare[1]);
    if (hour >= 0 && hour <= 23) return { hour, minute: 0 };
  }
  return null;
}

function parseDowPhrase(phrase: string): string | null {
  const clean = phrase
    .trim()
    .toLowerCase()
    .replace(/^(?:every|on|each)\s+/, "")
    .trim();
  if (!clean || /^(?:day|daily|morning|evening|night)$/.test(clean)) return "*";
  if (/^(?:weekday|weekdays|workday|workdays|mon\s*(?:-|to|through)\s*fri|monday\s*(?:-|to|through)\s*friday)$/.test(clean)) {
    return "1-5";
  }
  if (/^(?:weekend|weekends|sat\s*(?:and|&|,)\s*sun|saturday\s*(?:and|&|,)\s*sunday)$/.test(clean)) {
    return "0,6";
  }
  const range = /^([a-z]+)\s*(?:-|to|through)\s*([a-z]+)$/.exec(clean);
  if (range && range[1] in DAYS_SHORT && range[2] in DAYS_SHORT) {
    const a = DAYS_SHORT[range[1]];
    const b = DAYS_SHORT[range[2]];
    if (a <= b) return `${a}-${b}`;
  }
  const tokens = clean
    .replace(/\band\b/g, ",")
    .split(/[\s,&]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length > 0 && tokens.every((tok) => tok in DAYS_SHORT)) {
    const nums = [...new Set(tokens.map((tok) => DAYS_SHORT[tok]))].sort((a, b) => a - b);
    return nums.join(",");
  }
  return null;
}

/**
 * Turns a 5-field cron expression, an interval ("every 30 minutes", "2h", "60"), or a spoken
 * schedule phrase ("weekdays at 9am", "daily at 18:00", "every Monday at 10am") into VibeForge's
 * `Schedule`, or null when invalid or unclear.
 */
export function parseRoutineSchedule(raw: string | undefined): Schedule | null {
  const trimmed = (raw ?? "").trim().replace(/[.!]+$/, "").trim();
  if (!trimmed) return null;

  // 1. Direct 5-field cron expression
  const normalizedCron = trimmed.replace(/\s+/g, " ");
  if (normalizedCron.split(" ").length === 5 && isCronExprValid(normalizedCron)) {
    return { kind: "cron", expr: normalizedCron };
  }

  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");

  // 2. Simple interval shortcuts ("every 30 minutes", "every 2 hours", "30m", "2h", "60")
  if (/^(?:hourly|every hour|once an hour)$/.test(lower)) {
    return { kind: "cron", expr: "0 * * * *" };
  }
  if (/^(?:daily|every day|once a day)$/.test(lower)) {
    return { kind: "every", minutes: 1440 };
  }
  if (/^(?:weekdays?|every weekday)$/.test(lower)) {
    return { kind: "cron", expr: "0 9 * * 1-5" };
  }
  if (/^(?:weekends?|every weekend)$/.test(lower)) {
    return { kind: "cron", expr: "0 10 * * 0,6" };
  }
  if (/^(?:weekly|every week|once a week)$/.test(lower)) {
    return { kind: "cron", expr: "0 9 * * 1" };
  }

  const intervalMatch = /^(?:every\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(lower);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    const mult = unit.startsWith("d") ? 1440 : unit.startsWith("h") ? 60 : 1;
    const minutes = Math.round(amount * mult);
    if (Number.isInteger(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES) {
      return { kind: "every", minutes };
    }
    return null;
  }

  // Bare integer minutes (e.g. "30" or "every:30")
  const bareMinutes = /^(?:every\s*[:=]\s*)?(\d+)$/.exec(lower);
  if (bareMinutes) {
    const minutes = Number(bareMinutes[1]);
    if (minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES) {
      return { kind: "every", minutes };
    }
    return null;
  }

  // 3. Natural day + clock time ("weekdays at 9am", "every Monday at 10:30", "daily at 6pm", "at 9am weekdays")
  const atSplit = /^(.*?)\s+at\s+([0-9:a-z.\s]+)$/.exec(lower);
  if (atSplit) {
    const left = atSplit[1].trim();
    const right = atSplit[2].trim();
    const clock = parseClockTime(right);
    if (clock) {
      const dow = parseDowPhrase(left);
      if (dow) {
        // "every evening at 7" / "every night at 9" without am/pm implies PM when hour is 1..11.
        let hour = clock.hour;
        if (/\b(?:evening|night)\b/.test(left) && !/[ap]\.?m\.?/i.test(right) && hour >= 1 && hour <= 11) {
          hour += 12;
        }
        return { kind: "cron", expr: `${clock.minute} ${hour} * * ${dow}` };
      }
    }
  }

  const leadingAt = /^at\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight|noon)(?:\s+(.*))?$/.exec(lower);
  if (leadingAt) {
    const clock = parseClockTime(leadingAt[1]);
    if (clock) {
      const dow = parseDowPhrase(leadingAt[2] ?? "");
      if (dow) return { kind: "cron", expr: `${clock.minute} ${clock.hour} * * ${dow}` };
    }
  }

  // Compact "<time> <day>" ("9am weekdays", "18:00 daily")
  const timeFirst = /^(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|midnight|noon)\s+(.+)$/.exec(lower);
  if (timeFirst) {
    const clock = parseClockTime(timeFirst[1]);
    const dow = parseDowPhrase(timeFirst[2]);
    if (clock && dow) return { kind: "cron", expr: `${clock.minute} ${clock.hour} * * ${dow}` };
  }

  // Named day(s) with no time -> default 9:00
  const onlyDay = parseDowPhrase(lower);
  if (onlyDay && onlyDay !== "*") {
    return { kind: "cron", expr: `0 9 * * ${onlyDay}` };
  }

  return null;
}

export function formatScheduleBrief(schedule: Schedule): string {
  if (schedule.kind === "cron") return schedule.expr;
  if (schedule.minutes % 1440 === 0) {
    const d = schedule.minutes / 1440;
    return d === 1 ? "every day" : `every ${d} days`;
  }
  if (schedule.minutes % 60 === 0) {
    const h = schedule.minutes / 60;
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  return `every ${schedule.minutes} minutes`;
}

// ------------------------------------------------------------------ domain types & normalizers

export type AgentAction = "create" | "edit" | "delete" | "add-folder" | "remove-folder" | "add-skill" | "remove-skill" | "memory-set" | "memory-append" | "memory-clear";
export type RoutineStepAction = "create" | "edit" | "delete" | "run" | "run-now" | "enable" | "disable" | "cancel-wait";
export type TaskStepAction = "create" | "create-run" | "edit" | "delete" | "run" | "run-now" | "continue" | "stop" | "status" | "cancel-wait" | "apply" | "discard" | "handoff";
export type SkillAction = "create" | "edit" | "delete" | "attach" | "detach" | "set-agents";
export type WorkspaceAction = "create" | "rename" | "remove" | "move";
export type ChatAction = "create" | "send" | "continue" | "stop" | "rename" | "set-engine" | "delete";
export type RunAction = "continue" | "stop" | "mark-reviewed" | "mark-unreviewed" | "mark-all-reviewed" | "handoff" | "tidy";
export type TalkAction = "review" | "send-draft" | "stop" | "start-tasks";
export type MemoryStepAction = "append" | "set" | "clear";

export function normalizeMemoryAction(rawAction: string | undefined, hasPrompt: boolean): MemoryStepAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return hasPrompt ? "append" : null;
  if (/^(?:append|add|remember|note|save|memoryappend|appendmemory)$/.test(key)) return hasPrompt ? "append" : null;
  if (/^(?:set|write|replace|overwrite|memoryset|setmemory)$/.test(key)) return "set";
  if (/^(?:clear|wipe|forget|reset|empty|memoryclear|clearmemory)$/.test(key)) return "clear";
  return null;
}

/**
 * Parses `verify` step options (`retries=0..3`, `timeout=10..300` seconds).
 */
export function parseVerifyOptions(options: string | undefined): { retries: number; timeoutMs: number } {
  const opts = parseOptions(options);
  const rawRetries = opts.num("retries") ?? opts.num("retry");
  const retries = rawRetries !== undefined ? Math.max(0, Math.min(3, Math.round(rawRetries))) : 2;
  const rawTimeout = opts.num("timeout") ?? opts.num("timeoutSec") ?? opts.num("seconds");
  const timeoutSec = rawTimeout !== undefined ? Math.max(10, Math.min(300, Math.round(rawTimeout))) : 180;
  return { retries, timeoutMs: timeoutSec * 1000 };
}

export function normalizeAgentAction(rawAction: string | undefined, hasTarget: boolean): AgentAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return hasTarget ? "edit" : "create";
  if (/^(?:create|new|add|make|save)$/.test(key)) return hasTarget ? "edit" : "create";
  if (/^(?:edit|update|modify|change|rename|set)$/.test(key)) return "edit";
  if (/^(?:delete|remove|trash|drop)$/.test(key)) return "delete";
  if (/^(?:addfolder|addplace|allowfolder|allowworkspace|addworkspace)$/.test(key)) return "add-folder";
  if (/^(?:removefolder|removeplace|disallowfolder|removeworkspace)$/.test(key)) return "remove-folder";
  if (/^(?:addskill|attachskill|installskill|enableskill)$/.test(key)) return "add-skill";
  if (/^(?:removeskill|detachskill|uninstallskill|disableskill)$/.test(key)) return "remove-skill";
  if (/^(?:memoryset|setmemory|writememory|replacememory)$/.test(key)) return "memory-set";
  if (/^(?:memoryappend|appendmemory|addmemory|remember|memory|note)$/.test(key)) return "memory-append";
  if (/^(?:memoryclear|clearmemory|wipememory|forgetmemory|resetmemory)$/.test(key)) return "memory-clear";
  return null;
}

export function normalizeRoutineStepAction(rawAction: string | undefined, rawPrompt: string | undefined, hasTarget: boolean, hasCreateFields: boolean): RoutineStepAction | null {
  const key = squash(rawAction ?? "");
  if (key) {
    if (/^(?:create|new|add|make|schedule)$/.test(key)) return "create";
    if (/^(?:edit|update|modify|change|reschedule|attach|attachtask|attachagent|rename)$/.test(key)) return "edit";
    if (/^(?:delete|remove|trash|drop)$/.test(key)) return "delete";
    if (/^(?:run|start|trigger|execute|go)$/.test(key)) return "run";
    if (/^(?:runnow|force|runforce|startnow|runanyway|anyway)$/.test(key)) return "run-now";
    if (/^(?:enable|on|turnon|resume|unpause)$/.test(key)) return "enable";
    if (/^(?:disable|off|turnoff|pause)$/.test(key)) return "disable";
    if (/^(?:cancelwait|stopwaiting|unqueue|dequeue)$/.test(key)) return "cancel-wait";
    return null;
  }
  // Legacy mode (no explicit `action`): infer create when no existing target and create fields exist,
  // otherwise keep exact legacy routineAction semantics ("", "enable", "disable").
  if (!hasTarget && hasCreateFields) return "create";
  const text = (rawPrompt ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!text || /^(?:run|run it|run now|run it now|now|start|start it|go)$/.test(text)) return "run";
  if (/^(?:enable|enabled|on|turn on|turn it on|switch on|resume|unpause)$/.test(text)) return "enable";
  if (/^(?:disable|disabled|off|turn off|turn it off|switch off|pause|stop)$/.test(text)) return "disable";
  return null;
}

export function normalizeTaskStepAction(rawAction: string | undefined, hasExistingTarget: boolean, hasCreatePayload: boolean): TaskStepAction | null {
  const key = squash(rawAction ?? "");
  if (!key) {
    if (hasExistingTarget && !hasCreatePayload) return "run";
    return hasExistingTarget ? "run" : "create-run";
  }
  if (/^(?:create|new|add|make|draft|todo)$/.test(key)) return "create";
  if (/^(?:createrun|createandrun|startnew|newrun|createexecute)$/.test(key)) return "create-run";
  if (/^(?:edit|update|modify|change|assign|reassign|rename)$/.test(key)) return "edit";
  if (/^(?:delete|remove|trash|drop)$/.test(key)) return "delete";
  if (/^(?:run|execute|start|go)$/.test(key)) return "run";
  if (/^(?:runnow|force|executeanyway|anyway|startnow)$/.test(key)) return "run-now";
  if (/^(?:continue|resume|followup)$/.test(key)) return "continue";
  if (/^(?:stop|kill|abort|cancel)$/.test(key)) return "stop";
  if (/^(?:status|setstatus|move|mark|markdone|done|review)$/.test(key)) return "status";
  if (/^(?:cancelwait|stopwaiting|unqueue|dequeue)$/.test(key)) return "cancel-wait";
  if (/^(?:apply|applycopy|merge)$/.test(key)) return "apply";
  if (/^(?:discard|discardcopy|dropcopy)$/.test(key)) return "discard";
  if (/^(?:handoff|handover|delegate)$/.test(key)) return "handoff";
  return null;
}

export function normalizeSkillAction(rawAction: string | undefined, hasTarget: boolean): SkillAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return hasTarget ? "edit" : "create";
  if (/^(?:create|new|add|make|write)$/.test(key)) return hasTarget ? "edit" : "create";
  if (/^(?:edit|update|modify|change|rename)$/.test(key)) return "edit";
  if (/^(?:delete|remove|trash|drop)$/.test(key)) return "delete";
  if (/^(?:attach|addagent|addagents|install|enable|assign)$/.test(key)) return "attach";
  if (/^(?:detach|removeagent|removeagents|uninstall|disable|unassign)$/.test(key)) return "detach";
  if (/^(?:setagents|agents|assignonly)$/.test(key)) return "set-agents";
  return null;
}

export function normalizeWorkspaceAction(rawAction: string | undefined): WorkspaceAction | null {
  const key = squash(rawAction ?? "");
  if (!key || /^(?:create|new|add|make|open)$/.test(key)) return "create";
  if (/^(?:rename|update|edit)$/.test(key)) return "rename";
  if (/^(?:remove|delete|drop|close)$/.test(key)) return "remove";
  if (/^(?:move|reorder|position)$/.test(key)) return "move";
  return null;
}

export function normalizeChatAction(rawAction: string | undefined, hasTarget: boolean, hasPrompt: boolean): ChatAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return hasTarget ? (hasPrompt ? "send" : "continue") : "create";
  if (/^(?:create|new|start|open)$/.test(key)) return "create";
  if (/^(?:send|message|say|ask|tell|reply)$/.test(key)) return "send";
  if (/^(?:continue|resume|reopen)$/.test(key)) return "continue";
  if (/^(?:stop|kill|end)$/.test(key)) return "stop";
  if (/^(?:rename|title|retitle)$/.test(key)) return "rename";
  if (/^(?:setengine|engine|switchengine|cli|switchcli)$/.test(key)) return "set-engine";
  if (/^(?:delete|remove|trash|drop)$/.test(key)) return "delete";
  return null;
}

export function normalizeRunAction(rawAction: string | undefined): RunAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return null;
  if (/^(?:continue|resume|reopen|followup)$/.test(key)) return "continue";
  if (/^(?:stop|kill|abort|end)$/.test(key)) return "stop";
  if (/^(?:markreviewed|reviewed|markopened|opened|open|ack)$/.test(key)) return "mark-reviewed";
  if (/^(?:markunreviewed|unreviewed|markunopened|unread)$/.test(key)) return "mark-unreviewed";
  if (/^(?:markallreviewed|reviewall|clearinbox|markallopened)$/.test(key)) return "mark-all-reviewed";
  if (/^(?:handoff|handover|delegate)$/.test(key)) return "handoff";
  if (/^(?:tidy|cleanup|clean|prune|compress|maintain|tidystorage)$/.test(key)) return "tidy";
  return null;
}

export function normalizeTalkAction(rawAction: string | undefined): TalkAction | null {
  const key = squash(rawAction ?? "");
  if (!key) return null;
  if (/^(?:review|startreview|reviewwith)$/.test(key)) return "review";
  if (/^(?:senddraft|draft|sendto|forward)$/.test(key)) return "send-draft";
  if (/^(?:stop|stoptalk|pause|mute)$/.test(key)) return "stop";
  if (/^(?:starttasks|startheld|startheldtasks|approvehanded)$/.test(key)) return "start-tasks";
  return null;
}

export function parseTaskStatus(raw: string | undefined): Exclude<TaskStatus, "running"> | null {
  const key = squash(raw ?? "");
  if (/^(?:todo|backlog|open|reopen)$/.test(key)) return "todo";
  if (/^(?:review|inreview|forreview|readyforreview)$/.test(key)) return "review";
  if (/^(?:done|complete|completed|finished|close|closed)$/.test(key)) return "done";
  return null;
}

export function parseAgentTier(raw: string | undefined): AgentTier | null {
  const key = squash(raw ?? "");
  if (!key || /^(?:none|default|clear|unset|auto)$/.test(key)) return "";
  if (/^(?:fast|quick|cheap|light)$/.test(key)) return "fast";
  if (/^(?:everyday|normal|standard|balanced|medium)$/.test(key)) return "everyday";
  if (/^(?:strong|heavy|smart|best|deep|high)$/.test(key)) return "strong";
  return null;
}

/** Whether an `inspect` step asks for disk / run storage usage. */
export function inspectsStorage(text: string | undefined): boolean {
  const words = (text ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s,/&+-]+/)
    .filter(Boolean);
  if (!words.some((w) => /^(?:storage|disk|space|size)$/.test(w))) return false;
  return words.every((w) => /^(?:storage|disk|space|size|usage|runs?|summary|my|the|how|much|used|vibe|vibeforge)$/.test(w));
}

/** Whether an `inspect` step asks for app/workspace problems, failures, or attention prompts. */
export function inspectsProblems(text: string | undefined): boolean {
  const clean = (text ?? "").trim().toLowerCase().replace(/[?!.]+$/g, "");
  if (!clean) return false;
  return /^(?:problems?|diagnostics?|issues?|failures?|errors?|attention|stuck|waiting|what(?:'s| is) (?:wrong|failing|broken|stuck|waiting)|any (?:problems|issues|failures))\b/.test(clean);
}

/**
 * Whether an action on one of the entity/app step kinds is destructive or irreversible enough to
 * require explicit Go confirmation (even in "Just go" mode and live voice calls).
 */
export function isDestructiveStepAction(kind: string, action: string | undefined): boolean {
  const act = (action ?? "").trim().toLowerCase();
  if (kind === "agent") return act === "delete" || act === "memory-clear" || act === "memory-set" || squash(act) === "memoryset";
  if (kind === "routine") return act === "delete" || act === "run-now";
  if (kind === "task") return act === "delete" || act === "stop" || act === "apply" || act === "discard" || act === "run-now";
  if (kind === "skill") return act === "delete";
  if (kind === "workspace") return act === "remove";
  if (kind === "chat") return act === "delete" || act === "stop";
  if (kind === "run") return act === "stop" || act === "tidy";
  if (kind === "talk") return normalizeTalkAction(action) === "start-tasks";
  if (kind === "memory") return act === "set" || act === "clear" || squash(act) === "set" || squash(act) === "clear";
  return false;
}
