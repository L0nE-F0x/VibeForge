import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogFile } from "../../src/core/log.js";
import { defaultSettings } from "../../src/core/store/config.js";
import type { Settings } from "../../src/core/types.js";

// What decides whether VibeForge reaches out to anyone about your plans and activity. Off means
// no request at all: these tests fail if one is made.

const { Stats } = await import("../../electron/stats.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stats(settings: Partial<Settings>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vf-stats-"));
  // A scratch home, so nothing real is read, signed in to Claude with a made-up token: with plan
  // limits on, that would be asked about.
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up-token-for-the-test", expiresAt: Date.now() + 3_600_000 } }));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "GEMINI_CLI_HOME", "CLAUDE_CONFIG_DIR", "KIMI_HOME", "MUSE_HOME"]) vi.stubEnv(name, "");
  // Nor the desktop keyring (Antigravity's sign-in can live there): no secret-tool on this PATH.
  vi.stubEnv("PATH", path.join(home, "no-bin"));
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const all = { ...defaultSettings(), ...settings };
  const ctx = {
    roots: { configRoot: path.join(home, "config"), dataRoot: path.join(home, "data") },
    log: new LogFile(path.join(home, "data", "log.txt")),
    svc: () => ({ getSettings: () => all }),
    service: { listWorkspaces: () => ({ workspaces: [] }) },
    words: { alerts: () => ({}) },
  };
  return { stats: new Stats(ctx as never, () => undefined, "2.15.0"), fetch };
}

describe("what is asked of the network", () => {
  it("starts with plan limits and GitHub activity off, and the update check on", () => {
    const settings = defaultSettings();
    expect(settings.planLimits).toBe(false);
    expect(settings.activity).toBe("git");
    expect(settings.checkUpdates).toBe(true);
  });

  it("asks no provider about plan limits while they are off", async () => {
    const off = stats({ usage: false, planLimits: false });
    expect(await off.stats.planSummary(true)).toBeNull();
    const localOnly = stats({ usage: true, planLimits: false });
    await localOnly.stats.planSummary(true);
    expect(off.fetch).not.toHaveBeenCalled();
    expect(localOnly.fetch).not.toHaveBeenCalled();
    // The same sign-in with plan limits on is asked about: the switch is what holds it back.
    const on = stats({ usage: false, planLimits: true });
    await on.stats.planSummary(true);
    expect(on.fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
  });

  it("draws no activity graph while it is off", () => {
    expect(stats({ activity: "off" }).stats.activityFor("off", true)).toBeNull();
  });
});
