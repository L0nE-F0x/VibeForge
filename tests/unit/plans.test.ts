import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexReading, fullAt, parseAgy, parseClaude, parseCodexWham, parseGrok, parseKimi, parseMuse, PlanWatcher } from "../../src/core/plans.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const TOKEN = "t".repeat(40);
const inHours = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();

function jwt(expSeconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds })}.sig`;
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A home signed in to Claude, Grok and Kimi, with tokens that are still good at NOW. */
function signedInHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
  write(path.join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: TOKEN, refreshToken: "r", expiresAt: NOW + 3600_000 } });
  write(path.join(home, ".grok", "auth.json"), { "https://auth.x.ai::id": { key: TOKEN, refresh_token: "r", expires_at: inHours(2) } });
  write(path.join(home, ".kimi-code", "credentials", "kimi-code.json"), { access_token: jwt(NOW / 1000 + 900), refresh_token: "r", expires_at: 0 });
  fs.writeFileSync(path.join(home, ".kimi-code", "device_id"), "device-1\n");
  return home;
}

const ANSWERS: Record<string, unknown> = {
  "api.anthropic.com": { five_hour: { utilization: 37, resets_at: inHours(3) }, seven_day: { utilization: 99, resets_at: inHours(32) }, seven_day_opus: null },
  "cli-chat-proxy.grok.com": {
    config: {
      creditUsagePercent: 77,
      currentPeriod: { end: { seconds: (NOW + 11 * 3600_000) / 1000 } },
      productUsage: [
        { name: "GrokBuild", usagePercent: 76 },
        { name: "GrokChat", usagePercent: 1 },
      ],
    },
  },
  "daily-cloudcode-pa.googleapis.com": {
    groups: [
      {
        groupName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.8, resetTime: inHours(72), window: "weekly" },
          { bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: inHours(2), window: "5h" },
        ],
      },
      {
        groupName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", remainingFraction: 1, window: "weekly" },
          { bucketId: "3p-5h", remainingFraction: 1, window: "5h" },
        ],
      },
      {
        groupName: "Gemini 4 Argon",
        buckets: [
          {
            bucketId: "gemini-argon-wtu-weekly",
            displayName: "Gemini 4 Argon Weekly Limit",
            remainingFraction: 0.41,
            resetTime: inHours(140),
            window: "weekly",
          },
        ],
      },
    ],
  },
  "api.kimi.com": {
    // As Kimi sends it: counts as strings, resets as resetTime.
    usage: { limit: "100", used: "40", remaining: "60", resetTime: inHours(90) },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "100", resetTime: inHours(2) } }],
  },
};

function fakeNetwork(status: (host: string) => number = () => 200) {
  const calls: Array<{ host: string; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    const host = new URL(url).host;
    calls.push({ host, headers: init.headers });
    const code = status(host);
    return { status: code, text: async () => JSON.stringify(ANSWERS[host] ?? {}) };
  };
  return { calls, fetch };
}

describe("plan limits", () => {
  it("reads each provider's answer the way the providers shape it", () => {
    const claude = parseClaude(ANSWERS["api.anthropic.com"] as Record<string, unknown>);
    expect(claude).toMatchObject({ percent: 99, limiter: "7-day" });
    expect(claude?.windows.map((window) => [window.name, window.percent])).toEqual([
      ["5-hour", 37],
      ["7-day", 99],
    ]);

    const grok = parseGrok(ANSWERS["cli-chat-proxy.grok.com"] as Record<string, unknown>);
    expect(grok).toMatchObject({ percent: 77, limiter: "GrokBuild", resetsAt: inHours(11) });
    expect(grok?.windows).toHaveLength(2);

    const agy = parseAgy(ANSWERS["daily-cloudcode-pa.googleapis.com"] as Record<string, unknown>);
    expect(agy).toMatchObject({ percent: 59, limiter: "Gemini 4 Argon", resetsAt: inHours(140) });
    expect(agy?.windows.map((window) => [window.name, Math.round(window.percent)])).toEqual([
      ["5-hour", 25],
      ["7-day", 20],
      ["Gemini 4 Argon", 59],
    ]);

    const kimi = parseKimi(ANSWERS["api.kimi.com"] as Record<string, unknown>);
    expect(kimi).toMatchObject({ percent: 100, limiter: "5-hour", resetsAt: inHours(2) });
    expect(kimi?.windows.map((window) => [window.name, window.percent])).toEqual([
      ["Weekly", 40],
      ["5-hour", 100],
    ]);

    // Claude's newer `limits` list, and a model-scoped weekly window.
    const listed = parseClaude({ limits: [{ kind: "session", utilization: 12 }, { kind: "weekly_scoped", utilization: 50, scope: { model: { display_name: "Opus" } } }] });
    expect(listed?.windows.map((window) => window.name)).toEqual(["5-hour", "Opus"]);

    expect(parseClaude({})).toBeNull();
    expect(parseGrok({ config: {} })).toBeNull();
    expect(parseAgy({})).toBeNull();

    const codex = codexReading([
      { windowMinutes: 10080, usedPercent: 20, resetsAt: null },
      { windowMinutes: 300, usedPercent: 20, resetsAt: null },
    ]);
    expect(codex?.windows.map((window) => window.name)).toEqual(["5-hour", "7-day"]);
    // A tie goes to the shorter window, which frees up first.
    expect(codex?.limiter).toBe("5-hour");
  });

  it("asks only the providers this machine is signed in to, with their own sign-in, and keeps no token", async () => {
    const home = signedInHome();
    const file = path.join(home, "data", "plans.json");
    const network = fakeNetwork();
    const watcher = new PlanWatcher({ home, file, now: () => NOW, fetch: network.fetch, env: {} });

    const summary = await watcher.summary({ network: true, local: [] });
    expect(summary.providers.map((provider) => [provider.id, provider.percent])).toEqual([
      ["claude", 99],
      ["grok", 77],
      ["kimi", 100],
    ]);
    expect(network.calls.map((call) => call.host).sort()).toEqual(["api.anthropic.com", "api.kimi.com", "cli-chat-proxy.grok.com"]);
    expect(network.calls.every((call) => call.headers.Authorization.startsWith("Bearer "))).toBe(true);
    expect(network.calls.find((call) => call.host === "api.kimi.com")?.headers["X-Msh-Device-Id"]).toBe("device-1");

    // Kept: percentages, never a sign-in.
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).not.toContain(TOKEN);
    expect(saved).not.toContain("Bearer");

    // Within a few minutes nothing is asked again, unless a Refresh forces it.
    await watcher.summary({ network: true, local: [] });
    expect(network.calls).toHaveLength(3);

    // Off: nothing is asked, and nothing but Codex is shown.
    const off = await new PlanWatcher({ home, file, now: () => NOW, fetch: network.fetch, env: {} }).summary({
      network: false,
      local: [{ id: "codex", limits: [{ windowMinutes: 300, usedPercent: 12, resetsAt: inHours(1) }] }],
    });
    expect(off.providers.map((provider) => provider.id)).toEqual(["codex"]);
    expect(network.calls).toHaveLength(3);
  });

  it("never renews a sign-in: an expired one keeps the last numbers and says to open the CLI", async () => {
    const home = signedInHome();
    const file = path.join(home, "plans.json");
    let now = NOW;
    const network = fakeNetwork((host) => (host === "cli-chat-proxy.grok.com" && now > NOW ? 401 : 200));
    const watcher = new PlanWatcher({ home, file, now: () => now, fetch: network.fetch, env: {} });
    await watcher.summary({ network: true, local: [] });
    const credentials = fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8");

    // Two and a half hours on: Claude's token has expired, Grok's is refused, and Kimi's 5-hour window has reset.
    now = NOW + 2.5 * 3600_000;
    const later = await watcher.summary({ network: true, local: [] });
    const claude = later.providers.find((provider) => provider.id === "claude");
    const grok = later.providers.find((provider) => provider.id === "grok");
    const kimi = later.providers.find((provider) => provider.id === "kimi");
    expect(claude).toMatchObject({ problem: "signin", percent: 99, readAt: new Date(NOW).toISOString() });
    expect(network.calls.filter((call) => call.host === "api.anthropic.com")).toHaveLength(1);
    expect(grok).toMatchObject({ problem: "signin", percent: 77 });
    // Kimi's token was only good for 15 minutes too, so its old numbers stand, with the reset applied.
    expect(kimi).toMatchObject({ problem: "signin", percent: 40, limiter: "Weekly" });
    expect(kimi?.windows.find((window) => window.name === "5-hour")?.percent).toBe(0);

    // Nothing touched the CLIs' files.
    expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8")).toBe(credentials);

    // The last numbers survive a restart.
    const reopened = await new PlanWatcher({ home, file, now: () => now, fetch: network.fetch, env: {} }).summary({ network: true, local: [] });
    expect(reopened.providers.find((provider) => provider.id === "claude")?.percent).toBe(99);
  });

  it("shows Muse and Codex only when this machine is signed in to them", async () => {
    const muse = parseMuse({
      api_key: `LLM|${"k".repeat(40)}`,
      subs_usage: { window: { used_percent: 15, window_duration_mins: 300, resets_at: NOW / 1000 + 3600 }, weekly: { used_percent: 40, resets_at: NOW / 1000 + 86_400 } },
    });
    expect(muse?.windows.map((window) => [window.name, window.percent])).toEqual([
      ["5-hour", 15],
      ["7-day", 40],
    ]);
    expect(parseMuse({ is_subs_active: false })).toBeNull();
    expect(parseMuse({ subs_usage: { window: { used_percent: 110, window_duration_mins: 300 } } })?.percent).toBe(100);
    // An active plan with nothing used yet: Meta sends no subs_usage. That is 0%, not an unreadable answer.
    const idle = parseMuse({ is_subs_active: true, api_key: `LLM|${"k".repeat(40)}` });
    expect([idle?.limiter, idle?.percent, idle?.resetsAt]).toEqual(["5-hour", 0, null]);
    expect(parseMuse({ is_subs_active: true, subs_usage: { window: { remaining_percent: 70, window_duration_mins: 300 } } })?.percent).toBe(30);
    expect(parseMuse({})).toBeNull();

    const codex = parseCodexWham({
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 1000 },
        secondary_window: { used_percent: 8, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 50_000 },
      },
    });
    expect(codex?.windows.map((window) => window.name)).toEqual(["5-hour", "7-day"]);
    expect(codex?.percent).toBe(25);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    const museAuth = path.join(home, ".config", "muse", "auth.json");
    write(museAuth, { providers: { meta: { access_token: `dca:${TOKEN}`, api_key: `LLM|${"k".repeat(40)}` } } });
    const before = fs.readFileSync(museAuth, "utf8");
    write(path.join(home, ".codex", "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: jwt(NOW / 1000 + 3600), account_id: "acct-1" } });
    const network = fakeNetwork();
    network.fetch = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      const host = new URL(url).host;
      network.calls.push({ host, headers: init.headers });
      const body =
        host === "api.meta.ai"
          ? { api_key: `LLM|${"n".repeat(40)}`, subs_usage: { window: { used_percent: 15, window_duration_mins: 300, resets_at: NOW / 1000 + 3600 }, weekly: { used_percent: 40, resets_at: NOW / 1000 + 86_400 } } }
          : { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 1000 }, secondary_window: { used_percent: 8, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 50_000 } } };
      expect(host === "api.meta.ai" ? init.method : "GET").toBe(host === "api.meta.ai" ? "POST" : "GET");
      return { status: 200, text: async () => JSON.stringify(body) };
    };
    const file = path.join(home, "plans.json");
    const summary = await new PlanWatcher({ home, file, now: () => NOW, fetch: network.fetch, env: {} }).summary({ network: true });
    expect(summary.providers.map((provider) => [provider.id, provider.percent])).toEqual([
      ["codex", 25],
      ["muse", 40],
    ]);
    expect(network.calls.map((call) => call.host).sort()).toEqual(["api.meta.ai", "chatgpt.com"]);
    expect(network.calls.find((call) => call.host === "chatgpt.com")?.headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(fs.readFileSync(museAuth, "utf8")).toBe(before);
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).not.toContain(TOKEN);
    expect(saved).not.toContain("LLM|");
    expect(saved).not.toContain("dca:");

    // Pay-as-you-go: signed in, no subscription, so no card.
    write(museAuth, { providers: { meta: { access_token: `dca:${TOKEN}` } } });
    const empty = fakeNetwork();
    const quiet = await new PlanWatcher({
      home,
      file: path.join(home, "empty.json"),
      now: () => NOW,
      fetch: async (url, init) => {
        empty.calls.push({ host: new URL(url).host, headers: init.headers });
        return { status: 200, text: async () => JSON.stringify({ is_subs_active: false }) };
      },
      env: {},
    }).summary({ network: true });
    // Codex's auth.json is still there, so Codex stays. Muse does not.
    expect(quiet.providers.map((provider) => provider.id)).toEqual(["codex"]);
  });

  it("replaces an old Muse reading with 0% once its window resets and Meta stops sending usage", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    write(path.join(home, ".config", "muse", "auth.json"), { providers: { meta: { access_token: `dca:${TOKEN}` } } });
    const file = path.join(home, "plans.json");
    let now = NOW;
    let answer: Record<string, unknown> = { is_subs_active: true, subs_usage: { window: { used_percent: 64, window_duration_mins: 300, resets_at: NOW / 1000 + 600 } } };
    const watcher = new PlanWatcher({ home, file, now: () => now, fetch: async () => ({ status: 200, text: async () => JSON.stringify(answer) }), env: {} });
    expect((await watcher.summary({ network: true })).providers.map((p) => [p.id, p.percent])).toEqual([["muse", 64]]);
    now += 9 * 3600e3;
    answer = { is_subs_active: true };
    const later = (await watcher.summary({ network: true })).providers.find((p) => p.id === "muse");
    expect([later?.percent, later?.problem, later?.readAt]).toEqual([0, null, new Date(now).toISOString()]);
  });

  it("keeps a plan from the CLI's log when asking is off, and lets a fresh answer replace it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    write(path.join(home, ".codex", "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: jwt(NOW / 1000 + 3600), account_id: "acct-1" } });
    const limits = [{ windowMinutes: 300, usedPercent: 12, resetsAt: inHours(1) }];
    const off = await new PlanWatcher({ home, file: path.join(home, "a.json"), now: () => NOW, fetch: async () => { throw new Error("no network"); }, env: {} }).summary({
      network: false,
      local: [{ id: "codex", limits }],
    });
    expect(off.providers.map((provider) => [provider.id, provider.percent])).toEqual([["codex", 12]]);

    const on = await new PlanWatcher({
      home,
      file: path.join(home, "b.json"),
      now: () => NOW,
      fetch: async () => ({ status: 200, text: async () => JSON.stringify({ rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 1000 } } }) }),
      env: {},
    }).summary({ network: true, local: [{ id: "codex", limits }] });
    expect(on.providers.find((provider) => provider.id === "codex")?.percent).toBe(60);
  });

  it("keeps the newer of an online reading and a CLI log, and labels the log with its own time", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    write(path.join(home, ".codex", "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: jwt(NOW / 1000 + 3600), account_id: "acct-1" } });
    let now = NOW;
    const watcher = new PlanWatcher({
      home,
      file: path.join(home, "plans.json"),
      now: () => now,
      fetch: async () => ({ status: 200, text: async () => JSON.stringify({ rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 1000 } } }) }),
      env: {},
    });
    const older = [{ windowMinutes: 300, usedPercent: 12, resetsAt: inHours(1) }];
    const loggedAt = new Date(NOW - 3600_000).toISOString();
    await watcher.summary({ network: true, local: [{ id: "codex", limits: older, at: loggedAt }] });

    // Still inside the few minutes where the provider is not asked again. The older log must not take over.
    now = NOW + 60_000;
    const held = await watcher.summary({ network: true, local: [{ id: "codex", limits: older, at: loggedAt }] });
    expect(held.providers.find((provider) => provider.id === "codex")).toMatchObject({ percent: 60, readAt: new Date(NOW).toISOString() });

    // A log written after that answer is the one to show, at the time the CLI wrote it.
    const loggedLater = new Date(NOW + 30_000).toISOString();
    const followed = await watcher.summary({
      network: true,
      local: [{ id: "codex", limits: [{ windowMinutes: 300, usedPercent: 80, resetsAt: inHours(1) }], at: loggedLater }],
    });
    expect(followed.providers.find((provider) => provider.id === "codex")).toMatchObject({ percent: 80, readAt: loggedLater });
  });

  it("works out when a window fills at the recent pace", () => {
    const points = [0, 1, 2, 3].map((step) => ({ t: new Date(NOW - (3 - step) * 3600_000).toISOString(), percent: 40 + step * 10 }));
    // 70% now, climbing 10% an hour: full in three hours.
    expect(fullAt(points, 70, NOW)).toBe(inHours(3));
    // A reset in the middle: only the climb since counts, and two points aren't enough.
    const reset = [...points, { t: inHours(0.5), percent: 5 }, { t: inHours(1), percent: 6 }];
    expect(fullAt(reset, 6, NOW + 3600_000)).toBeNull();
    // Flat or falling never fills.
    expect(fullAt(points.map((point) => ({ ...point, percent: 50 })), 50, NOW)).toBeNull();
  });

  it("removes a plan once its paid period ends or the CLI signs out, and brings it back if renewed", async () => {
    // Kimi's managed `usages` ratios, and zero-quota / ended-membership answers.
    const ratioKimi = parseKimi({ usages: { limit_5h: { used_ratio: 0.25, reset_time: inHours(3) }, limit_7d: { used_ratio: 0.6, reset_time: inHours(80) } } });
    expect(ratioKimi?.windows.map((window) => [window.name, window.percent])).toEqual([
      ["5-hour", 25],
      ["Weekly", 60],
    ]);
    expect(parseKimi({ usage: { limit: "0", used: "0", remaining: "0" }, limits: [] })).toBeNull();
    expect(parseKimi({ user: { membership: { level: "LEVEL_NONE" } }, usage: { limit: "100", used: "10" } })).toBeNull();

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    const museAuth = path.join(home, ".config", "muse", "auth.json");
    const kimiCreds = path.join(home, ".kimi-code", "credentials", "kimi-code.json");
    const codexAuth = path.join(home, ".codex", "auth.json");
    write(museAuth, { providers: { meta: { access_token: `dca:${TOKEN}` } } });
    write(kimiCreds, { access_token: jwt(NOW / 1000 + 2 * 3600), refresh_token: "r" });
    write(codexAuth, { auth_mode: "chatgpt", tokens: { access_token: jwt(NOW / 1000 + 8 * 3600), account_id: "acct-1" } });

    let now = NOW;
    let museStatus = 200;
    let museBody: Record<string, unknown> = {
      is_subs_active: true,
      subs_usage: { window: { used_percent: 20, window_duration_mins: 300, resets_at: NOW / 1000 + 3600 }, weekly: { used_percent: 35, resets_at: NOW / 1000 + 5 * 86_400 } },
    };
    let kimiStatus = 200;
    let kimiBody: Record<string, unknown> = ANSWERS["api.kimi.com"] as Record<string, unknown>;
    let codexStatus = 200;
    let codexBody: Record<string, unknown> = {
      rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 } },
    };
    let offline = false;

    const fetch = async (url: string) => {
      if (offline) throw new Error("network down");
      const host = new URL(url).host;
      if (host === "api.meta.ai") return { status: museStatus, text: async () => JSON.stringify(museBody) };
      if (host === "api.kimi.com") return { status: kimiStatus, text: async () => JSON.stringify(kimiBody) };
      return { status: codexStatus, text: async () => JSON.stringify(codexBody) };
    };

    const file = path.join(home, "plans.json");
    const watcher = new PlanWatcher({ home, file, now: () => now, fetch, env: {} });
    // Cancelled today, still inside the paid period: all three show and save to disk.
    const museLocal = [{ id: "muse", limits: [{ windowMinutes: 10_080, usedPercent: 35, resetsAt: inHours(120) }], at: new Date(NOW - 600_000).toISOString() }];
    const active = await watcher.summary({ network: true, local: museLocal });
    expect(active.providers.map((p) => [p.id, p.percent])).toEqual([
      ["codex", 15],
      ["kimi", 100],
      ["muse", 35],
    ]);

    // Muse's billing period ends: Meta flips is_subs_active to false while auth.json and the weekly session log remain.
    now = NOW + 30 * 60_000;
    museBody = { is_subs_active: false };
    const afterMuse = await watcher.summary({ network: true, local: museLocal });
    expect(afterMuse.providers.map((p) => p.id)).toEqual(["codex", "kimi"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).last.muse).toBeUndefined();

    // Inside the 3-minute cache window, Muse stays hidden.
    now += 30_000;
    expect((await watcher.summary({ network: true, local: museLocal })).providers.map((p) => p.id)).toEqual(["codex", "kimi"]);

    // Kimi's yearly plan ends: Kimi answers with a membership-expired 403 (or 404/402/LEVEL_NONE).
    now += 10 * 60_000;
    kimiStatus = 403;
    kimiBody = { error: { message: "We're unable to verify your membership benefits at this time. Please ensure your membership is active." } };
    const afterKimi = await watcher.summary({ network: true, local: museLocal });
    expect(afterKimi.providers.map((p) => p.id)).toEqual(["codex"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).last.kimi).toBeUndefined();

    // Three hours later Kimi's short-lived JWT has expired and the network blips; neither ended plan resurfaces.
    now = NOW + 4 * 3600_000;
    offline = true;
    expect((await watcher.summary({ network: true, local: museLocal })).providers.map((p) => p.id)).toEqual(["codex"]);
    offline = false;

    // A restart reads plans.json and still keeps ended plans off the list, including Kimi's 404 / empty-usages answers.
    write(kimiCreds, { access_token: jwt(now / 1000 + 3600), refresh_token: "r" });
    kimiStatus = 404;
    kimiBody = { message: "Usage endpoint not available. Try Kimi For Coding." };
    const reopened = new PlanWatcher({ home, file, now: () => now, fetch, env: {} });
    expect((await reopened.summary({ network: true, local: museLocal })).providers.map((p) => p.id)).toEqual(["codex"]);

    // Signing out of Codex clears it even when an old session log still has an unexpired window.
    fs.rmSync(codexAuth);
    now += 5 * 60_000;
    const codexLocal = [{ id: "codex", limits: [{ windowMinutes: 300, usedPercent: 15, resetsAt: inHours(6) }], at: new Date(NOW).toISOString() }];
    expect((await reopened.summary({ network: true, local: codexLocal })).providers).toEqual([]);

    // Re-subscribing to Kimi brings its card straight back; a zero-quota or empty-usages 200 hides it again,
    // while an unexpected shape (`{}`) is flagged as unreadable rather than mistaken for an ended plan.
    now += 5 * 60_000;
    kimiStatus = 200;
    kimiBody = { usages: { limit_5h: { used_ratio: 0.1, reset_time: inHours(10) } } };
    const renewed = await reopened.summary({ network: true });
    expect(renewed.providers.map((p) => [p.id, p.percent])).toEqual([["kimi", 10]]);

    now += 5 * 60_000;
    kimiBody = {};
    expect((await reopened.summary({ network: true })).providers.find((p) => p.id === "kimi")).toMatchObject({ percent: 10, problem: "unreadable" });

    now += 5 * 60_000;
    kimiBody = { usages: {} };
    expect((await reopened.summary({ network: true })).providers).toEqual([]);
  });

  it("hides every provider when its 200 or 402 answer reports no active subscription", async () => {
    const home = signedInHome();
    write(path.join(home, ".codex", "auth.json"), { auth_mode: "chatgpt", tokens: { access_token: jwt(NOW / 1000 + 3600) } });
    write(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), { access_token: TOKEN, expiry: inHours(2) });
    write(path.join(home, ".config", "muse", "auth.json"), { providers: { meta: { access_token: `dca:${TOKEN}` } } });
    const bodies: Record<string, { status: number; body: Record<string, unknown> }> = {
      "api.anthropic.com": { status: 200, body: { five_hour: null, seven_day: null } },
      "cli-chat-proxy.grok.com": { status: 200, body: { config: { currentPeriod: null } } },
      "daily-cloudcode-pa.googleapis.com": { status: 200, body: { groups: [] } },
      "api.kimi.com": { status: 200, body: { usage: { limit: "0", used: "0" }, limits: [] } },
      "chatgpt.com": { status: 200, body: { plan_type: "free", rate_limit: null } },
      "api.meta.ai": { status: 402, body: { require_payment: true } },
    };
    const watcher = new PlanWatcher({
      home,
      file: path.join(home, "plans.json"),
      now: () => NOW,
      fetch: async (url) => {
        const entry = bodies[new URL(url).host];
        return { status: entry.status, text: async () => JSON.stringify(entry.body) };
      },
      env: {},
    });
    expect((await watcher.summary({ network: true })).providers).toEqual([]);
  });

  it("doesn't say a window fills after it resets, or read one window's climb as another's", () => {
    const climb = [0, 1, 2, 3].map((step) => ({ t: new Date(NOW - (3 - step) * 3600_000).toISOString(), percent: 25 + step * 5, w: "5h" }));
    // 40% now, 5% an hour: twelve hours to go, but the window resets in one.
    expect(fullAt(climb, 40, NOW, { limiter: "5h", resetsAt: inHours(1) })).toBeNull();
    expect(fullAt(climb, 40, NOW, { limiter: "5h", resetsAt: inHours(20) })).toBe(inHours(12));
    // The week became the fullest a moment ago: the 5-hour window's points are no pace for it.
    const switched = [...climb, { t: new Date(NOW).toISOString(), percent: 41, w: "week" }];
    expect(fullAt(switched, 41, NOW, { limiter: "week", resetsAt: inHours(100) })).toBeNull();
  });

  it("treats non-empty Kimi usages or coalesced network summary requests accurately", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-plans-"));
    fs.mkdirSync(path.join(home, ".kimi-code", "credentials"), { recursive: true });
    write(path.join(home, ".kimi-code", "credentials", "kimi-code.json"), { access_token: jwt(NOW / 1000 + 900), refresh_token: "r", expires_at: 0 });
    fs.writeFileSync(path.join(home, ".kimi-code", "device_id"), "device-1\n");
    let netCalls = 0;
    const watcher = new PlanWatcher({
      home,
      file: path.join(home, "plans.json"),
      now: () => NOW,
      fetch: async () => {
        netCalls += 1;
        return { status: 200, text: async () => JSON.stringify({ usages: { detail: "unknown-format" } }) };
      },
      env: {},
    });
    // Local-only summary followed concurrently by network:true runs the network pass rather than dropping it.
    const [first, second] = await Promise.all([watcher.summary({ network: false }), watcher.summary({ network: true })]);
    expect(first.providers).toEqual([]);
    expect(netCalls).toBe(1);
    expect(second.providers.find((p) => p.id === "kimi")?.problem).toBe("unreadable");
  });
});
