import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexReading, fullAt, parseClaude, parseCodexWham, parseGrok, parseKimi, parseMuse, PlanWatcher } from "../../src/core/plans.js";

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
});
