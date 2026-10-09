import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fsx.js";

// Token usage read from the logs the coding CLIs already keep on this machine. Nothing is sent
// anywhere and no API is called: Claude Code, Codex, Grok Build, Gemini CLI, Kimi Code and Muse Code each
// write what every model call used, and this adds it up per day. Append-only logs are read from
// where the last pass stopped, so a rescan costs only what was written since.
//
// The CLIs clear their own old logs (Claude Code after 30 days), so each day's count is also kept
// in a small ledger of VibeForge's own. That is what the month and all time add up, and a day
// stays counted after its logs are gone.

/** How far back the logs are read on every pass, in days, today included. Older days come from the ledger. */
export const USAGE_DAYS = 7;
/** The days the month adds up, today included. */
export const MONTH_DAYS = 30;
/** At most this many weeks of bars for all time; the total still covers every day. */
export const ALL_WEEKS = 16;

export type UsagePeriod = "today" | "week" | "month" | "all";

export interface Tokens {
  /** Everything the model read and wrote: fresh input, cache reads and writes, and output. */
  total: number;
  /** The part of `total` that was read back from a prompt cache, which plans count for less. */
  cached: number;
  output: number;
}

/** A limit the CLI reported for its plan, such as Codex's 5-hour window. */
export interface UsageLimit {
  /** The window, in minutes (300 for five hours, 10080 for a week). */
  windowMinutes: number;
  usedPercent: number;
  resetsAt: string | null;
}

/** What one CLI used over a period. */
export interface UsageSpan {
  tokens: Tokens;
  /** The period's total per model, largest first. */
  models: Array<{ model: string; total: number }>;
  /**
   * Totals for the bars, oldest first, the last one ending today: a column per day for today
   * (the last 7 days, for scale), the week and the month; a column per 7 days for all time.
   */
  bars: number[];
}

export interface UsageSource {
  /** The engine it belongs to: claude, codex, grok, gemini, kimi or muse. */
  id: string;
  /** Today; the last 7 days; the last 30 days; every day counted. */
  periods: Record<UsagePeriod, UsageSpan>;
  /** The first day with tokens, YYYY-MM-DD; null when there are none. */
  since: string | null;
  limits: UsageLimit[];
  /** When the CLI wrote `limits`, if that log line said. Null when `limits` is empty. */
  limitsAt: string | null;
  /** When the newest counted call happened. */
  lastAt: string | null;
}

export interface UsageSummary {
  sources: UsageSource[];
  scannedAt: string;
}

type Tally = Map<string, Map<string, Tokens>>;

/** VibeForge's own count: tokens per CLI, per day, per model. */
interface Ledger {
  /**
   * The day of the last pass, per CLI. Every day from then on is read from its logs on the next
   * pass; a CLI with none (new to VibeForge) has all its logs read once.
   */
  scanned: Record<string, string>;
  days: Record<string, Record<string, Record<string, Tokens>>>;
}

interface FileState {
  size: number;
  mtimeMs: number;
  /** Bytes already read, for logs that only grow. */
  offset: number;
  /** A line cut off by the end of the last read. */
  rest: string;
  tally: Tally;
  /** Claude Code message ids this file counted; a resumed session repeats them in its new file. */
  keys: Set<string>;
  /** Codex writes the model once per turn; token counts after it belong to it. */
  model: string;
  limits: { at: string; limits: UsageLimit[] } | null;
}

const zero = (): Tokens => ({ total: 0, cached: 0, output: 0 });

function add(into: Tokens, from: Tokens): void {
  into.total += from.total;
  into.cached += from.cached;
  into.output += from.output;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The local date of an ISO time, as YYYY-MM-DD. */
export function dayOf(time: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

function count(tally: Tally, iso: unknown, model: string, tokens: Tokens): void {
  if (typeof iso !== "string" || !tokens.total) return;
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return;
  const day = dayOf(time);
  const models = tally.get(day) ?? new Map<string, Tokens>();
  const into = models.get(model) ?? zero();
  add(into, tokens);
  models.set(model, into);
  tally.set(day, models);
}

/** Files under `root` (to `depth` folders down) matching `pattern`, changed since `since`. */
function recentFiles(root: string, pattern: RegExp, since: number, depth: number): Array<{ file: string; stat: fs.Stats }> {
  const found: Array<{ file: string; stat: fs.Stats }> = [];
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) walk(full, level + 1);
        continue;
      }
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= since) found.push({ file: full, stat });
      } catch {
        /* gone since the listing */
      }
    }
  };
  walk(root, 0);
  return found;
}

// ------------------------------------------------------------------ the formats

/** Claude Code: one line per content block, each repeating its message's usage. */
function claudeLine(state: FileState, line: string, seen: Set<string>): void {
  if (!line.includes('"usage"')) return;
  let record: { timestamp?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const usage = record.message?.usage;
  if (!usage) return;
  const model = record.message?.model || "claude";
  if (model === "<synthetic>") return;
  const key = `${record.message?.id ?? ""}:${record.requestId ?? ""}`;
  if (key !== ":" && seen.has(key)) return;
  if (key !== ":") {
    seen.add(key);
    state.keys.add(key);
  }
  const cached = num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  const total = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + cached + output;
  count(state.tally, record.timestamp, model, { total, cached, output });
}

function codexLimit(value: unknown, at: Date): UsageLimit | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const windowMinutes = num(record.window_minutes);
  if (!windowMinutes || typeof record.used_percent !== "number") return null;
  let resetsAt: string | null = null;
  if (num(record.resets_at)) resetsAt = new Date(num(record.resets_at) * 1000).toISOString();
  else if (num(record.resets_in_seconds)) resetsAt = new Date(at.getTime() + num(record.resets_in_seconds) * 1000).toISOString();
  return { windowMinutes, usedPercent: Math.min(100, Math.max(0, record.used_percent)), resetsAt };
}

/** Codex: a token_count event after each model call, with what that call used and the plan's limits. */
function codexLine(state: FileState, line: string): void {
  if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
  let record: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const payload = record.payload ?? {};
  if (record.type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model;
    return;
  }
  if (payload.type !== "token_count") return;
  const last = (payload.info as { last_token_usage?: Record<string, unknown> } | null)?.last_token_usage;
  if (last) {
    const cached = num(last.cached_input_tokens);
    const output = num(last.output_tokens);
    const total = num(last.total_tokens) || num(last.input_tokens) + output;
    count(state.tally, record.timestamp, state.model || "codex", { total, cached, output });
  }
  const limits = payload.rate_limits as { primary?: unknown; secondary?: unknown } | undefined;
  if (limits && typeof record.timestamp === "string") {
    const at = new Date(record.timestamp);
    const found = [codexLimit(limits.primary, at), codexLimit(limits.secondary, at)].filter((item): item is UsageLimit => item !== null);
    if (found.length) state.limits = { at: record.timestamp, limits: found };
  }
}

/** Grok Build: usage.json per session, with each turn's tokens per model. */
function grokFile(state: FileState, text: string): void {
  let record: { turns?: Array<{ endedAt?: string; modelUsage?: Record<string, Record<string, unknown>> }> };
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  for (const turn of record.turns ?? []) {
    for (const [model, usage] of Object.entries(turn.modelUsage ?? {})) {
      count(state.tally, turn.endedAt, model, { total: num(usage.totalTokens), cached: num(usage.cachedReadTokens), output: num(usage.outputTokens) });
    }
  }
}

/** Microseconds, milliseconds or seconds since the epoch, as ISO. */
function museTime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e14 ? value / 1000 : value > 1e11 ? value : value * 1000;
  const time = new Date(ms);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

function museLimit(minutes: number, row: Record<string, unknown> | null): UsageLimit | null {
  if (!row || typeof row.used_percent !== "number" || !Number.isFinite(row.used_percent) || minutes <= 0) return null;
  let resetsAt: string | null = null;
  const resets = row.resets_at;
  if (typeof resets === "number" && resets > 10_000) resetsAt = new Date(resets > 1e12 ? resets : resets * 1000).toISOString();
  else if (typeof resets === "string" && !Number.isNaN(Date.parse(resets))) resetsAt = new Date(resets).toISOString();
  return { windowMinutes: minutes, usedPercent: Math.min(100, Math.max(0, row.used_percent)), resetsAt };
}

/**
 * Muse Code: one `model_completed` event per model call in session.jsonl. `input_tokens` already
 * includes cache reads. A subscription frame in the same log, when Muse wrote one, carries the
 * plan's windows. Child sessions count too; the same record is counted once.
 */
function museLine(state: FileState, line: string, seen: Set<string>): void {
  if (!line.includes('"model_completed"') && !line.includes('"subscription"') && !line.includes('"subs_usage"')) return;
  let record: { id?: string; recorded_at?: number; stream?: { id?: string }; payload?: { event?: Record<string, unknown> } };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const event = record.payload?.event;
  if (!event) return;
  const subscription = (event.subscription ?? event.subs_usage) as Record<string, unknown> | undefined;
  if (subscription && typeof subscription === "object") {
    const window = subscription.window as Record<string, unknown> | undefined;
    const weekly = subscription.weekly as Record<string, unknown> | undefined;
    const minutes = typeof window?.window_duration_mins === "number" ? window.window_duration_mins : 300;
    const found = [museLimit(minutes, window && typeof window === "object" ? window : null), museLimit(7 * 24 * 60, weekly && typeof weekly === "object" ? weekly : null)].filter(
      (item): item is UsageLimit => item !== null,
    );
    const at = museTime(record.recorded_at);
    if (found.length && at) state.limits = { at, limits: found };
  }
  if (event.kind !== "model_completed") return;
  const usage = event.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  const key = `${record.stream?.id ?? ""}:${record.id ?? ""}`;
  if (key !== ":" && seen.has(key)) return;
  if (key !== ":") {
    seen.add(key);
    state.keys.add(key);
  }
  const cached = num(usage.cache_read_tokens);
  const output = num(usage.output_tokens);
  const total = num(usage.input_tokens) + num(usage.cache_write_tokens) + output;
  const model = typeof event.model === "string" && event.model ? event.model : "muse";
  count(state.tally, museTime(record.recorded_at), model, { total, cached, output });
}

/**
 * Kimi Code: a `usage.record` line per model call in each agent's wire.jsonl. Most are scoped to a
 * turn; the few scoped to the session are calls outside a turn (such as squeezing the context),
 * not a sum of the turns, so they count too.
 */
function kimiLine(state: FileState, line: string): void {
  if (!line.includes('"usage.record"')) return;
  let record: { type?: string; model?: string; time?: number; usage?: Record<string, unknown> };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const usage = record.usage;
  if (record.type !== "usage.record" || !usage) return;
  const cached = num(usage.inputCacheRead);
  const output = num(usage.output);
  const total = num(usage.inputOther) + num(usage.inputCacheCreation) + cached + output;
  count(state.tally, museTime(record.time), typeof record.model === "string" && record.model ? record.model : "kimi", { total, cached, output });
}

/** Gemini CLI: a chat file per session, whose answers carry their tokens. */
function geminiFile(state: FileState, text: string): void {
  let record: { messages?: Array<{ type?: string; timestamp?: string; model?: string; tokens?: Record<string, unknown> }> };
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  for (const message of record.messages ?? []) {
    const tokens = message.tokens;
    if (!tokens) continue;
    const output = num(tokens.output) + num(tokens.thoughts);
    const total = num(tokens.total) || num(tokens.input) + output + num(tokens.tool);
    count(state.tally, message.timestamp, message.model || "gemini", { total, cached: num(tokens.cached), output });
  }
}

// ------------------------------------------------------------------ the ledger

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight at the start of a YYYY-MM-DD day, local time. */
function startOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** The `count` days ending on `now`'s, oldest first, as YYYY-MM-DD. */
function lastDays(now: Date, count: number): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    days.push(dayOf(day));
  }
  return days;
}

/** A ledger file as read, keeping only well-formed days and numbers. */
function cleanLedger(value: unknown): Ledger {
  const ledger: Ledger = { scanned: {}, days: {} };
  if (!value || typeof value !== "object") return ledger;
  const record = value as { scanned?: unknown; days?: unknown };
  if (!record.days || typeof record.days !== "object") return ledger;
  if (typeof record.scanned === "string" && DAY.test(record.scanned)) {
    // 2.3.0 kept one day for every CLI it read then, each of which has an entry in `days`.
    for (const id of Object.keys(record.days)) ledger.scanned[id] = record.scanned;
  } else if (record.scanned && typeof record.scanned === "object") {
    for (const [id, day] of Object.entries(record.scanned)) if (typeof day === "string" && DAY.test(day)) ledger.scanned[id] = day;
  }
  for (const [id, days] of Object.entries(record.days as Record<string, unknown>)) {
    if (!days || typeof days !== "object") continue;
    const into: Ledger["days"][string] = {};
    for (const [day, models] of Object.entries(days as Record<string, unknown>)) {
      if (!DAY.test(day) || !models || typeof models !== "object") continue;
      const kept: Record<string, Tokens> = {};
      for (const [model, tokens] of Object.entries(models as Record<string, Record<string, unknown> | null>)) {
        if (!tokens || typeof tokens !== "object" || !num(tokens.total)) continue;
        kept[model] = { total: num(tokens.total), cached: num(tokens.cached), output: num(tokens.output) };
      }
      if (Object.keys(kept).length) into[day] = kept;
    }
    ledger.days[id] = into;
  }
  return ledger;
}

/** The first day with tokens in a CLI's ledger, or null. */
function firstDay(kept: Ledger["days"][string]): string | null {
  return (
    Object.keys(kept)
      .filter((day) => Object.values(kept[day]).some((tokens) => tokens.total > 0))
      .sort()[0] ?? null
  );
}

/** Weeks of bars for all time: back to the week of `since`, at most ALL_WEEKS. */
function weeksSince(since: string | null, now: Date): number {
  if (!since) return 1;
  const spanDays = Math.round((startOf(dayOf(now)) - startOf(since)) / 86_400_000) + 1;
  return Math.min(ALL_WEEKS, Math.max(1, Math.ceil(spanDays / 7)));
}

/** Each period's totals for one CLI, from its days in the ledger; all time in `weeks` columns. */
function periodsOf(kept: Ledger["days"][string], now: Date, weeks: number): Record<UsagePeriod, UsageSpan> {
  const dayTotal = (day: string) => Object.values(kept[day] ?? {}).reduce((sum, tokens) => sum + tokens.total, 0);
  const span = (days: string[], bars: number[]): UsageSpan => {
    const tokens = zero();
    const models = new Map<string, number>();
    for (const day of days) {
      for (const [model, used] of Object.entries(kept[day] ?? {})) {
        add(tokens, used);
        models.set(model, (models.get(model) ?? 0) + used.total);
      }
    }
    return { tokens, models: [...models].map(([model, total]) => ({ model, total })).sort((a, b) => b.total - a.total), bars };
  };
  const week = lastDays(now, USAGE_DAYS);
  const month = lastDays(now, MONTH_DAYS);
  const weekBars = week.map(dayTotal);
  // A column per 7 days, the last one ending today.
  const allDays = lastDays(now, weeks * 7).map(dayTotal);
  const allBars = Array.from({ length: weeks }, (_, column) => allDays.slice(column * 7, column * 7 + 7).reduce((sum, value) => sum + value, 0));
  return {
    today: span(week.slice(-1), weekBars),
    week: span(week, weekBars),
    month: span(month, month.map(dayTotal)),
    all: span(Object.keys(kept), allBars),
  };
}

// ------------------------------------------------------------------ the scanner

interface Source {
  id: string;
  roots: string[];
  pattern: RegExp;
  depth: number;
  /** Logs that only grow are read line by line from where the last pass stopped. */
  lines?: (state: FileState, line: string) => void;
  whole?: (state: FileState, text: string) => void;
}

export class UsageScanner {
  private readonly files = new Map<string, FileState>();
  /** Claude Code message ids counted so far, across files. */
  private readonly claudeSeen = new Set<string>();
  /** Muse record ids counted so far, across a session and its child sessions. */
  private readonly museSeen = new Set<string>();
  private readonly sources: Source[];
  private readonly now: () => Date;
  /** Where the ledger is kept; without one it lasts only as long as this scanner. */
  private readonly ledgerFile: string | null;
  private ledger: Ledger | null = null;

  constructor(home: string, { now = () => new Date(), env = process.env, ledger = null }: { now?: () => Date; env?: NodeJS.ProcessEnv; ledger?: string | null } = {}) {
    this.now = now;
    this.ledgerFile = ledger;
    const claudeRoots = (env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(",") : [path.join(home, ".claude"), path.join(home, ".config", "claude")]).map((root) =>
      path.join(root.trim(), "projects"),
    );
    this.sources = [
      { id: "claude", roots: claudeRoots, pattern: /\.jsonl$/, depth: 3, lines: (state, line) => claudeLine(state, line, this.claudeSeen) },
      { id: "codex", roots: [path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions")], pattern: /\.jsonl$/, depth: 4, lines: codexLine },
      { id: "grok", roots: [path.join(home, ".grok", "sessions")], pattern: /^usage\.json$/, depth: 2, whole: grokFile },
      { id: "gemini", roots: [path.join(env.GEMINI_CLI_HOME || home, ".gemini", "tmp")], pattern: /^session-.*\.json$/, depth: 2, whole: geminiFile },
      { id: "kimi", roots: [path.join(env.KIMI_CODE_HOME || path.join(home, ".kimi-code"), "sessions")], pattern: /^wire\.jsonl$/, depth: 5, lines: kimiLine },
      {
        id: "muse",
        roots: [path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "muse", "sessions")],
        pattern: /^session\.jsonl$/,
        depth: 6,
        lines: (state, line) => museLine(state, line, this.museSeen),
      },
    ];
  }

  /** Only one pass at a time; callers during a pass get its result. */
  private pass: Promise<UsageSummary> | null = null;

  scan(): Promise<UsageSummary> {
    this.pass ??= this.scanNow().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private loadLedger(): Ledger {
    this.ledger ??= cleanLedger(this.ledgerFile ? readJson<unknown>(this.ledgerFile, null) : null);
    return this.ledger;
  }

  private async scanNow(): Promise<UsageSummary> {
    const now = this.now();
    const today = dayOf(now);
    const ledger = this.loadLedger();
    const windowStart = startOf(lastDays(now, USAGE_DAYS)[0]);
    let changed = false;
    const live = new Set<string>();
    const found: Array<Omit<UsageSource, "periods">> = [];

    for (const source of this.sources) {
      // The days since the last pass may have grown while VibeForge was closed, so they are read
      // again in full; a CLI's first pass reads every log it still keeps.
      const last = ledger.scanned[source.id];
      const since = last ? Math.min(windowStart, startOf(last)) : 0;
      if (last !== today) changed = true;
      ledger.scanned[source.id] = today;
      const days = new Map<string, Map<string, Tokens>>();
      let limits: FileState["limits"] = null;
      let lastAt = 0;
      for (const root of source.roots) {
        for (const { file, stat } of recentFiles(root, source.pattern, since, source.depth)) {
          live.add(file);
          const state = await this.read(source, file, stat);
          lastAt = Math.max(lastAt, stat.mtimeMs);
          if (state.limits && (!limits || state.limits.at > limits.at)) limits = state.limits;
          for (const [day, models] of state.tally) {
            const into = days.get(day) ?? new Map<string, Tokens>();
            for (const [model, tokens] of models) {
              const sum = into.get(model) ?? zero();
              add(sum, tokens);
              into.set(model, sum);
            }
            days.set(day, into);
          }
        }
      }
      ledger.days[source.id] ??= {};
      const kept = ledger.days[source.id];
      for (const [day, models] of days) {
        kept[day] ??= {};
        const into = kept[day];
        for (const [model, tokens] of models) {
          // A day's count only grows: a smaller one means its logs were cleared, not that tokens came back.
          if (tokens.total <= (into[model]?.total ?? 0)) continue;
          into[model] = { ...tokens };
          changed = true;
        }
      }
      const first = firstDay(kept);
      const liveLimits = (limits?.limits ?? []).filter((limit) => !limit.resetsAt || Date.parse(limit.resetsAt) > now.getTime());
      if (!first && !liveLimits.length) continue;
      found.push({
        id: source.id,
        since: first,
        // A limit that has reset since it was written says nothing any more.
        limits: liveLimits,
        limitsAt: liveLimits.length ? (limits?.at ?? null) : null,
        lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      });
    }
    // Every CLI's all-time bars go back as far as the oldest one's, so their columns line up.
    const weeks = weeksSince(found.map((source) => source.since).filter((day): day is string => day !== null).sort()[0] ?? null, now);
    const sources: UsageSource[] = found.map((source) => ({ ...source, periods: periodsOf(ledger.days[source.id], now, weeks) }));

    // Forget files that fell out of the window; their days are in the ledger.
    for (const [file, state] of this.files) {
      if (live.has(file)) continue;
      for (const key of state.keys) {
        this.claudeSeen.delete(key);
        this.museSeen.delete(key);
      }
      this.files.delete(file);
    }
    if (changed && this.ledgerFile) {
      try {
        writeJson(this.ledgerFile, ledger);
      } catch {
        /* kept in memory; written on the next pass that can */
      }
    }
    return { sources, scannedAt: now.toISOString() };
  }

  private async read(source: Source, file: string, stat: fs.Stats): Promise<FileState> {
    let state = this.files.get(file);
    if (state && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;
    const fresh = (): FileState => ({ size: 0, mtimeMs: 0, offset: 0, rest: "", tally: new Map(), keys: new Set(), model: "", limits: null });
    if (!state || source.whole || stat.size < state.offset) {
      for (const key of state?.keys ?? []) {
        this.claudeSeen.delete(key);
        this.museSeen.delete(key);
      }
      state = fresh();
    }
    try {
      if (source.whole) {
        source.whole(state, await fs.promises.readFile(file, "utf8"));
      } else if (source.lines && stat.size > state.offset) {
        const handle = await fs.promises.open(file, "r");
        try {
          const length = stat.size - state.offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, state.offset);
          const lines = (state.rest + buffer.toString("utf8")).split("\n");
          state.rest = lines.pop() ?? "";
          for (const line of lines) source.lines(state, line);
          state.offset = stat.size;
        } finally {
          await handle.close();
        }
      }
    } catch {
      /* unreadable now; counted as it was */
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    this.files.set(file, state);
    return state;
  }
}
