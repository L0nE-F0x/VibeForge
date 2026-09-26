import fs from "node:fs";
import path from "node:path";

// Token usage read from the logs the coding CLIs already keep on this machine. Nothing is sent
// anywhere and no API is called: Claude Code, Codex, Grok Build and Gemini CLI each write what
// every model call used, and this adds it up per day. Append-only logs are read from where the
// last pass stopped, so a rescan costs only what was written since.

/** How far back usage is kept, in days, today included. */
export const USAGE_DAYS = 7;

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

export interface UsageSource {
  /** The engine it belongs to: claude, codex, grok or gemini. */
  id: string;
  today: Tokens;
  week: Tokens;
  /** Total tokens per day, oldest first, ending today. */
  days: number[];
  /** This week's total per model, largest first. */
  models: Array<{ model: string; total: number }>;
  limits: UsageLimit[];
  /** When the newest counted call happened. */
  lastAt: string | null;
}

export interface UsageSummary {
  sources: UsageSource[];
  scannedAt: string;
}

type Tally = Map<string, Map<string, Tokens>>;

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
  private readonly sources: Source[];
  private readonly now: () => Date;

  constructor(home: string, now: () => Date = () => new Date(), env: NodeJS.ProcessEnv = process.env) {
    this.now = now;
    const claudeRoots = (env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(",") : [path.join(home, ".claude"), path.join(home, ".config", "claude")]).map((root) =>
      path.join(root.trim(), "projects"),
    );
    this.sources = [
      { id: "claude", roots: claudeRoots, pattern: /\.jsonl$/, depth: 3, lines: (state, line) => claudeLine(state, line, this.claudeSeen) },
      { id: "codex", roots: [path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions")], pattern: /\.jsonl$/, depth: 4, lines: codexLine },
      { id: "grok", roots: [path.join(home, ".grok", "sessions")], pattern: /^usage\.json$/, depth: 2, whole: grokFile },
      { id: "gemini", roots: [path.join(env.GEMINI_CLI_HOME || home, ".gemini", "tmp")], pattern: /^session-.*\.json$/, depth: 2, whole: geminiFile },
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

  private async scanNow(): Promise<UsageSummary> {
    const now = this.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (USAGE_DAYS - 1));
    const since = start.getTime();
    const dayKeys: string[] = [];
    for (let index = 0; index < USAGE_DAYS; index += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      dayKeys.push(dayOf(day));
    }
    const today = dayKeys[dayKeys.length - 1];
    const live = new Set<string>();
    const sources: UsageSource[] = [];

    for (const source of this.sources) {
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
      const perDay = dayKeys.map((day) => [...(days.get(day)?.values() ?? [])].reduce((sum, tokens) => sum + tokens.total, 0));
      if (!perDay.some(Boolean) && !limits) continue;
      const week = zero();
      const todayTokens = zero();
      const models = new Map<string, number>();
      for (const day of dayKeys) {
        for (const [model, tokens] of days.get(day) ?? []) {
          add(week, tokens);
          if (day === today) add(todayTokens, tokens);
          models.set(model, (models.get(model) ?? 0) + tokens.total);
        }
      }
      sources.push({
        id: source.id,
        today: todayTokens,
        week,
        days: perDay,
        models: [...models].map(([model, total]) => ({ model, total })).sort((a, b) => b.total - a.total),
        // A limit that has reset since it was written says nothing any more.
        limits: (limits?.limits ?? []).filter((limit) => !limit.resetsAt || Date.parse(limit.resetsAt) > now.getTime()),
        lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      });
    }

    // Forget files that fell out of the window.
    for (const [file, state] of this.files) {
      if (live.has(file)) continue;
      for (const key of state.keys) this.claudeSeen.delete(key);
      this.files.delete(file);
    }
    return { sources, scannedAt: now.toISOString() };
  }

  private async read(source: Source, file: string, stat: fs.Stats): Promise<FileState> {
    let state = this.files.get(file);
    if (state && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;
    const fresh = (): FileState => ({ size: 0, mtimeMs: 0, offset: 0, rest: "", tally: new Map(), keys: new Set(), model: "", limits: null });
    if (!state || source.whole || stat.size < state.offset) {
      for (const key of state?.keys ?? []) this.claudeSeen.delete(key);
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
