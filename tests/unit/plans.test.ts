import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexReading, fullAt, parseClaude, parseGrok, parseKimi, PlanWatcher } from "../../src/core/plans.js";

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

    const summary = await watcher.summary({ network: true, codex: [] });
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
    await watcher.summary({ network: true, codex: [] });
    expect(network.calls).toHaveLength(3);

    // Off: nothing is asked, and nothing but Codex is shown.
    const off = await new PlanWatcher({ home, file, now: () => NOW, fetch: network.fetch, env: {} }).summary({
      network: false,
      codex: [{ windowMinutes: 300, usedPercent: 12, resetsAt: inHours(1) }],
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
    await watcher.summary({ network: true, codex: [] });
    const credentials = fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8");

    // Two and a half hours on: Claude's token has expired, Grok's is refused, and Kimi's 5-hour window has reset.
    now = NOW + 2.5 * 3600_000;
    const later = await watcher.summary({ network: true, codex: [] });
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
    const reopened = await new PlanWatcher({ home, file, now: () => now, fetch: network.fetch, env: {} }).summary({ network: true, codex: [] });
    expect(reopened.providers.find((provider) => provider.id === "claude")?.percent).toBe(99);
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
