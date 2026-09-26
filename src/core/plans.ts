import fs from "node:fs";
import path from "node:path";
import type { UsageLimit } from "./usage.js";

// How much of each coding plan's windows is used: Claude's 5-hour and 7-day, Grok's credits,
// Kimi's weekly and 5-hour. Codex writes its limits into its own logs; the others are asked,
// with the sign-in their CLI already saved on this machine. That sign-in is read fresh for each
// call and never refreshed, rewritten or kept, so VibeForge can't race a CLI over a rotating
// refresh token. When a sign-in has expired, the last numbers stay up, marked with their age,
// until the CLI renews it.

export type PlanId = "claude" | "codex" | "grok" | "kimi";

export interface PlanWindow {
  /** As the provider names it: "5-hour", "7-day", "Weekly", "GrokBuild". */
  name: string;
  percent: number;
  resetsAt: string | null;
}

export interface PlanPoint {
  t: string;
  percent: number;
}

/** Why the numbers shown aren't fresh. */
export type PlanProblem = "signin" | "offline" | "limited" | "unreadable";

export interface PlanProvider {
  id: PlanId;
  /** The share of the plan used, by its most limiting window; null before the first answer. */
  percent: number | null;
  /** The window that `percent` comes from. */
  limiter: string | null;
  resetsAt: string | null;
  windows: PlanWindow[];
  /** Extra credits left, in dollars, where the plan has them (Grok). */
  credits: number | null;
  /** When these numbers were read. */
  readAt: string | null;
  problem: PlanProblem | null;
  /** The last 24 hours, oldest first. */
  history: PlanPoint[];
  /** When the window fills at the recent pace, if that's within two days. */
  fullAt: string | null;
}

export interface PlanSummary {
  providers: PlanProvider[];
  checkedAt: string;
}

interface Reading {
  percent: number;
  limiter: string | null;
  resetsAt: string | null;
  windows: PlanWindow[];
  credits: number | null;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

interface Asked {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  parse: (data: Record<string, unknown>) => Reading | null;
}

/** A sign-in on this machine: what to ask, or that it has expired. */
type SignIn = { expired: true } | { expired: false; ask: Asked };

const HISTORY_MS = 24 * 3600_000;
/** How long an answer is trusted before the provider is asked again. */
const FRESH_MS = 3 * 60_000;
/** The shortest gap a Refresh can force. */
const FORCE_MS = 20_000;

// ------------------------------------------------------------------ small readers

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** ISO text, or seconds or milliseconds since the epoch, as ISO. */
function isoTime(value: unknown): string | null {
  if (typeof value === "number" && value > 10_000) return new Date(value > 1e12 ? value : value * 1000).toISOString();
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function usedPercent(used: unknown, limit: unknown, remaining: unknown): number | null {
  const cap = num(limit);
  let spent = num(used);
  const left = num(remaining);
  if (spent === null && left !== null && cap !== null) spent = cap - left;
  if (spent === null || cap === null || cap <= 0) return null;
  return clamp((spent / cap) * 100);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** A JWT's own expiry, which Kimi's stored expires_at can't be trusted over. */
function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return num(record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")))?.exp) ?? null;
  } catch {
    return null;
  }
}

/** The most limiting window; on a tie, the shorter one, which frees up sooner and matters first. */
function hottest(windows: PlanWindow[], shortFirst: (name: string) => boolean): PlanWindow | null {
  let best: PlanWindow | null = null;
  for (const window of windows) {
    if (!best || window.percent > best.percent || (window.percent === best.percent && shortFirst(window.name) && !shortFirst(best.name))) best = window;
  }
  return best;
}

function fromWindows(windows: PlanWindow[], shortFirst: (name: string) => boolean): Reading | null {
  const top = hottest(windows, shortFirst);
  if (!top) return null;
  return { percent: top.percent, limiter: top.name, resetsAt: top.resetsAt, windows, credits: null };
}

function addWindow(windows: PlanWindow[], window: PlanWindow | null): void {
  if (!window) return;
  const same = windows.findIndex((item) => item.name === window.name);
  if (same < 0) windows.push(window);
  else if (window.percent > windows[same].percent) windows[same] = window;
}

// ------------------------------------------------------------------ the answers

function claudeWindow(name: string, value: unknown): PlanWindow | null {
  const row = record(value);
  if (!row) return null;
  const percent = num(row.utilization, row.percent) ?? usedPercent(row.used, row.limit, row.remaining);
  if (percent === null) return null;
  return { name, percent: clamp(percent), resetsAt: isoTime(row.resets_at ?? row.resetsAt ?? row.reset_at ?? row.resetAt) };
}

/** Anthropic's OAuth usage: five_hour, seven_day and per-model seven_day_* windows. */
export function parseClaude(data: Record<string, unknown>): Reading | null {
  const windows: PlanWindow[] = [];
  addWindow(windows, claudeWindow("5-hour", data.five_hour));
  addWindow(windows, claudeWindow("7-day", data.seven_day));
  for (const [key, value] of Object.entries(data)) {
    const scoped = /^seven_day_(\w+)$/.exec(key);
    if (!scoped) continue;
    const label = scoped[1].replace(/_/g, " ");
    addWindow(windows, claudeWindow(`${label[0].toUpperCase()}${label.slice(1)} 7-day`, value));
  }
  const kinds: Record<string, string> = { session: "5-hour", weekly_all: "7-day" };
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    const row = record(item);
    if (!row) continue;
    const kind = String(row.kind ?? row.type ?? "");
    const model = record(row.scope)?.model;
    const label =
      kinds[kind] ?? (typeof model === "string" && model.trim() ? model.trim() : typeof record(model)?.display_name === "string" ? String(record(model)?.display_name) : "Weekly model");
    addWindow(windows, claudeWindow(label, row));
  }
  return fromWindows(windows, (name) => name === "5-hour");
}

/** xAI's billing for Grok Build: one credit percentage, split by product, over a billing period. */
export function parseGrok(data: Record<string, unknown>): Reading | null {
  const inner = record(data.config) ?? data;
  const percent = num(inner.creditUsagePercent, inner.credit_usage_percent, data.creditUsagePercent, data.credit_usage_percent);
  if (percent === null) return null;
  const period = record(inner.currentPeriod ?? inner.current_period ?? data.currentPeriod ?? data.current_period);
  let end: unknown = period?.end ?? period?.endsAt ?? period?.endTime;
  const endRecord = record(end);
  if (endRecord) end = num(endRecord.seconds, endRecord.secondsSinceEpoch) ?? endRecord.iso ?? endRecord.time;
  const resetsAt = isoTime(end);
  const windows: PlanWindow[] = [];
  const products = inner.productUsage ?? inner.product_usage ?? inner.categories ?? data.productUsage ?? data.product_usage ?? [];
  for (const item of Array.isArray(products) ? products : []) {
    const row = record(item);
    const used = num(row?.usagePercent, row?.usage_percent, row?.percent);
    if (!row || used === null) continue;
    addWindow(windows, { name: String(row.name ?? row.product ?? row.id ?? "Usage"), percent: clamp(used), resetsAt });
  }
  const credits = record(inner.extraUsageCredits ?? inner.extra_usage_credits ?? inner.credits);
  const top = hottest(windows, () => false);
  return {
    percent: clamp(percent),
    limiter: top?.name ?? null,
    resetsAt,
    windows,
    credits: credits ? num(credits.remaining, credits.balance, credits.amount, credits.usd) : num(inner.extraCredits, inner.extra_credits),
  };
}

function kimiLabel(row: Record<string, unknown>, detail: Record<string, unknown>): string {
  for (const key of ["name", "title", "scope"]) {
    const value = row[key] ?? detail[key];
    if (typeof value === "string" && value) return value;
  }
  const window = record(row.window) ?? {};
  const length = num(window.duration, row.duration, detail.duration);
  const unit = String(window.timeUnit ?? row.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if (length) {
    if (unit.includes("MINUTE")) return length >= 60 && length % 60 === 0 ? `${length / 60}-hour` : `${length}-min`;
    if (unit.includes("HOUR")) return `${length}-hour`;
    if (unit.includes("DAY")) return `${length}-day`;
  }
  return "Limit";
}

function kimiWindow(label: string, value: unknown): PlanWindow | null {
  const row = record(value);
  if (!row) return null;
  let percent = usedPercent(row.used, row.limit, row.remaining) ?? num(row.utilization, row.percent, row.usage_percent);
  if (percent === null && num(row.used) === 0) percent = 0;
  if (percent === null) return null;
  const name = typeof row.name === "string" && row.name ? row.name : typeof row.title === "string" && row.title ? row.title : label;
  return { name, percent: clamp(percent), resetsAt: isoTime(row.resetTime ?? row.reset_time ?? row.reset_at ?? row.resetAt ?? row.resets_at ?? row.resetsAt) };
}

/** Kimi Code's usages: the weekly allowance and shorter windows under `limits`. */
export function parseKimi(data: Record<string, unknown>): Reading | null {
  const windows: PlanWindow[] = [];
  addWindow(windows, kimiWindow("Weekly", data.usage));
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    const row = record(item);
    if (!row) continue;
    const detail = record(row.detail) ?? row;
    addWindow(windows, kimiWindow(kimiLabel(row, detail), detail));
  }
  if (!windows.length) addWindow(windows, kimiWindow("Usage", data));
  return fromWindows(windows, (name) => name.toLowerCase().includes("hour"));
}

/** Codex's limits from its logs, named like the others. */
export function codexReading(limits: readonly UsageLimit[]): Reading | null {
  const name = (minutes: number) => (minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-min`);
  const windows = [...limits].sort((a, b) => a.windowMinutes - b.windowMinutes).map((limit) => ({ name: name(limit.windowMinutes), percent: clamp(limit.usedPercent), resetsAt: limit.resetsAt }));
  return fromWindows(windows, (label) => label.endsWith("-hour") || label.endsWith("-min"));
}

// ------------------------------------------------------------------ the sign-ins

interface Provider {
  id: Exclude<PlanId, "codex">;
  /** Null when this machine isn't signed in to it. */
  signIn: (now: number) => SignIn | null;
}

function providers(home: string, env: NodeJS.ProcessEnv, agent: string): Provider[] {
  const base = { Accept: "application/json", "User-Agent": agent };
  const claudeDirs = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(",").map((dir) => dir.trim()) : [path.join(home, ".claude")];
  const kimiDirs = [path.join(home, ".kimi-code"), path.join(home, ".kimi")];
  return [
    {
      id: "claude",
      signIn: (now) => {
        const creds = claudeDirs.map((dir) => readJson(path.join(dir, ".credentials.json"))).find(Boolean);
        const oauth = record(creds?.claudeAiOauth);
        const token = oauth?.accessToken ?? oauth?.access_token;
        if (typeof token !== "string" || token.length < 20) return null;
        const expires = num(oauth?.expiresAt, oauth?.expires_at);
        if (expires !== null && expires <= now) return { expired: true };
        return {
          expired: false,
          ask: {
            url: "https://api.anthropic.com/api/oauth/usage",
            headers: { ...base, Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
            timeoutMs: 10_000,
            parse: parseClaude,
          },
        };
      },
    },
    {
      id: "grok",
      signIn: (now) => {
        const auth = readJson(path.join(home, ".grok", "auth.json"));
        const entry = Object.values(auth ?? {})
          .map(record)
          .find((item) => item && (item.key || item.access_token));
        const token = entry?.key ?? entry?.access_token;
        if (typeof token !== "string" || token.length < 20) return null;
        const expires = isoTime(entry?.expires_at);
        if (expires && Date.parse(expires) <= now) return { expired: true };
        return {
          expired: false,
          ask: {
            url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
            headers: {
              ...base,
              Authorization: `Bearer ${token}`,
              "x-grok-client-surface": "grok-build",
              "x-xai-token-auth": "xai-grok-cli",
              "x-grok-client-version": "1",
            },
            timeoutMs: 6_000,
            parse: parseGrok,
          },
        };
      },
    },
    {
      id: "kimi",
      signIn: (now) => {
        const dir = kimiDirs.find((candidate) => fs.existsSync(path.join(candidate, "credentials", "kimi-code.json")));
        if (!dir) return null;
        const creds = readJson(path.join(dir, "credentials", "kimi-code.json"));
        const token = creds?.access_token ?? creds?.accessToken;
        if (typeof token !== "string" || token.length < 20) return null;
        const expires = jwtExpiry(token) ?? num(creds?.expires_at);
        if (expires !== null && expires * 1000 <= now) return { expired: true };
        const headers: Record<string, string> = { ...base, Authorization: `Bearer ${token}`, "X-Msh-Platform": "kimi_cli" };
        try {
          const device = fs.readFileSync(path.join(dir, "device_id"), "utf8").trim();
          if (device && /^[\x20-\x7e]+$/.test(device)) headers["X-Msh-Device-Id"] = device;
        } catch {
          /* optional */
        }
        return { expired: false, ask: { url: "https://api.kimi.com/coding/v1/usages", headers, timeoutMs: 6_000, parse: parseKimi } };
      },
    },
  ];
}

// ------------------------------------------------------------------ pace

/** When `percent` reaches 100 at the pace of the recent points, or null if it won't within two days. */
export function fullAt(history: readonly PlanPoint[], percent: number | null, now: number): string | null {
  if (percent === null || percent >= 100) return null;
  let points: Array<{ t: number; v: number }> = [];
  for (const point of history) {
    const t = Date.parse(point.t);
    if (Number.isNaN(t)) continue;
    // A big drop is a window resetting; only the climb since then says anything.
    if (points.length && point.percent < points[points.length - 1].v - 15) points = [];
    points.push({ t, v: point.percent });
  }
  points = points.slice(-8);
  if (points.length < 3) return null;
  const n = points.length;
  const t0 = points[0].t;
  let sumT = 0;
  let sumV = 0;
  let sumTT = 0;
  let sumTV = 0;
  for (const { t, v } of points) {
    const x = t - t0;
    sumT += x;
    sumV += v;
    sumTT += x * x;
    sumTV += x * v;
  }
  const denominator = n * sumTT - sumT * sumT;
  if (!denominator) return null;
  const slope = (n * sumTV - sumT * sumV) / denominator;
  if (!(slope > 0)) return null;
  const left = (100 - percent) / slope;
  if (!Number.isFinite(left) || left <= 0 || left > 48 * 3600_000) return null;
  return new Date(now + left).toISOString();
}

// ------------------------------------------------------------------ the watcher

interface Kept {
  reading: Reading | null;
  readAt: string | null;
  problem: PlanProblem | null;
  /** When the provider was last asked, answer or not. */
  askedAt: number;
}

interface Saved {
  last: Partial<Record<PlanId, { reading: Reading; readAt: string }>>;
  history: Partial<Record<PlanId, PlanPoint[]>>;
}

export interface PlanWatcherOptions {
  home: string;
  /** Where the last numbers and the day's history are kept (percentages only, no sign-in). */
  file: string;
  agent?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetch?: Fetch;
}

export class PlanWatcher {
  private readonly file: string;
  private readonly now: () => number;
  private readonly fetch: Fetch;
  private readonly providers: Provider[];
  private readonly kept = new Map<PlanId, Kept>();
  private history: Partial<Record<PlanId, PlanPoint[]>> = {};
  private pass: Promise<PlanSummary> | null = null;

  constructor(options: PlanWatcherOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.providers = providers(options.home, options.env ?? process.env, options.agent ?? "VibeForge");
    const saved = readJson(this.file) as Partial<Saved> | null;
    for (const [id, last] of Object.entries(saved?.last ?? {})) {
      if (last?.reading && last.readAt) this.kept.set(id as PlanId, { reading: last.reading, readAt: last.readAt, problem: null, askedAt: 0 });
    }
    this.history = saved?.history ?? {};
  }

  /**
   * The plans this machine is signed in to. `network` allows asking the providers; Codex's
   * limits come from its logs either way. Only one pass runs at a time.
   */
  summary(options: { network: boolean; codex: readonly UsageLimit[]; fresh?: boolean }): Promise<PlanSummary> {
    this.pass ??= this.summaryNow(options).finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async summaryNow({ network, codex, fresh }: { network: boolean; codex: readonly UsageLimit[]; fresh?: boolean }): Promise<PlanSummary> {
    const now = this.now();
    const shown: PlanId[] = [];
    let dirty = false;

    const fromCodex = codexReading(codex);
    if (fromCodex) {
      this.kept.set("codex", { reading: fromCodex, readAt: new Date(now).toISOString(), problem: null, askedAt: now });
      dirty = this.remember("codex", fromCodex.percent, now) || dirty;
      shown.push("codex");
    }

    if (network) {
      const asks = this.providers.map(async (provider) => {
        const signIn = provider.signIn(now);
        if (!signIn) return;
        shown.push(provider.id);
        const kept = this.kept.get(provider.id);
        const age = now - (kept?.askedAt ?? 0);
        if (age < (fresh ? FORCE_MS : FRESH_MS)) return;
        const next = await this.ask(signIn);
        const reading = next.reading ?? kept?.reading ?? null;
        this.kept.set(provider.id, { reading, readAt: next.reading ? new Date(now).toISOString() : (kept?.readAt ?? null), problem: next.problem, askedAt: now });
        if (next.reading) dirty = this.remember(provider.id, next.reading.percent, now) || dirty;
      });
      await Promise.all(asks);
    }

    if (dirty) this.save();
    const order: PlanId[] = ["claude", "codex", "grok", "kimi"];
    return {
      providers: order.filter((id) => shown.includes(id)).map((id) => this.view(id, now)),
      checkedAt: new Date(now).toISOString(),
    };
  }

  private async ask(signIn: SignIn): Promise<{ reading: Reading | null; problem: PlanProblem | null }> {
    if (signIn.expired) return { reading: null, problem: "signin" };
    const { ask } = signIn;
    try {
      const response = await this.fetch(ask.url, { headers: ask.headers, signal: AbortSignal.timeout(ask.timeoutMs) });
      if (response.status === 401 || response.status === 403) return { reading: null, problem: "signin" };
      if (response.status === 429) return { reading: null, problem: "limited" };
      if (response.status < 200 || response.status >= 300) return { reading: null, problem: "offline" };
      const data = record(JSON.parse(await response.text()));
      const reading = data ? ask.parse(data) : null;
      return reading ? { reading, problem: null } : { reading: null, problem: "unreadable" };
    } catch (error) {
      return { reading: null, problem: error instanceof SyntaxError ? "unreadable" : "offline" };
    }
  }

  /** Adds a point to the day's line, unless it only repeats the last one. */
  private remember(id: PlanId, percent: number, now: number): boolean {
    const points = (this.history[id] ?? []).filter((point) => now - Date.parse(point.t) < HISTORY_MS);
    const last = points[points.length - 1];
    if (last && last.percent === percent && now - Date.parse(last.t) < 10 * 60_000) {
      this.history[id] = points;
      return false;
    }
    points.push({ t: new Date(now).toISOString(), percent });
    this.history[id] = points;
    return true;
  }

  private view(id: PlanId, now: number): PlanProvider {
    const kept = this.kept.get(id);
    const history = (this.history[id] ?? []).filter((point) => now - Date.parse(point.t) < HISTORY_MS);
    const reading = kept?.reading;
    if (!reading) {
      return { id, percent: null, limiter: null, resetsAt: null, windows: [], credits: null, readAt: null, problem: kept?.problem ?? null, history, fullAt: null };
    }
    // A window that has reset since it was read starts again from nothing.
    const passed = (at: string | null) => Boolean(at && Date.parse(at) <= now);
    const windows = reading.windows.map((window) => (passed(window.resetsAt) ? { ...window, percent: 0, resetsAt: null } : window));
    let percent = reading.percent;
    let limiter = reading.limiter;
    let resetsAt = reading.resetsAt;
    if (passed(resetsAt)) {
      const top = hottest(windows, () => false);
      percent = id === "grok" ? 0 : (top?.percent ?? 0);
      limiter = id === "grok" ? limiter : (top?.name ?? null);
      resetsAt = id === "grok" ? null : (top?.resetsAt ?? null);
    }
    return {
      id,
      percent,
      limiter,
      resetsAt,
      windows,
      credits: reading.credits,
      readAt: kept.readAt,
      problem: kept.problem,
      history,
      fullAt: kept.problem ? null : fullAt(history, percent, now),
    };
  }

  private save(): void {
    const last: Saved["last"] = {};
    for (const [id, kept] of this.kept) {
      if (id !== "codex" && kept.reading && kept.readAt) last[id] = { reading: kept.reading, readAt: kept.readAt };
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ last, history: this.history } satisfies Saved), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      /* the numbers come back on the next answer */
    }
  }
}
