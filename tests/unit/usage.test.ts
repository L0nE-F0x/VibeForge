import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageScanner } from "../../src/core/usage.js";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const NOW = new Date(2026, 8, 26, 21, 0, 0);
const at = (daysAgo: number, hour = 12) => new Date(2026, 8, 26 - daysAgo, hour, 0, 0).toISOString();
const claudeLine = (id: string, when: string, usage: Record<string, number>, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: when, requestId: `req-${id}`, message: { id, model, usage } });

describe("usage", () => {
  it("adds up Claude Code, Codex, Grok and Gemini logs per day, once per model call", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const session = path.join(home, ".claude", "projects", "-p", "one.jsonl");
    const call = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
    // One message spread over two content blocks, each repeating its usage.
    write(session, [claudeLine("m1", at(0), call), claudeLine("m1", at(0), call), claudeLine("m2", at(1), call, "claude-opus-5"), ""].join("\n"));
    // A resumed session copies earlier messages into its new file.
    write(path.join(home, ".claude", "projects", "-p", "two.jsonl"), `${claudeLine("m1", at(0), call)}\n${claudeLine("m3", at(9), call)}\n`);
    write(
      path.join(home, ".codex", "sessions", "2026", "09", "26", "rollout-a.jsonl"),
      [
        JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-5-codex" } }),
        JSON.stringify({
          timestamp: at(0),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40, total_tokens: 340 } },
            rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 36000 }, secondary: { used_percent: 12.5, window_minutes: 10080, resets_at: NOW.getTime() / 1000 - 5 } },
          },
        }),
        "",
      ].join("\n"),
    );
    write(
      path.join(home, ".grok", "sessions", "%2Fp", "s1", "usage.json"),
      JSON.stringify({ turns: [{ endedAt: at(2), modelUsage: { "grok-4.7-build": { totalTokens: 5000, cachedReadTokens: 4000, outputTokens: 70 } } }] }),
    );
    write(
      path.join(home, ".gemini", "tmp", "abc", "chats", "session-1.json"),
      JSON.stringify({ messages: [{ type: "user" }, { type: "gemini", timestamp: at(0), model: "gemini-3-pro", tokens: { input: 80, output: 20, cached: 10, thoughts: 5, tool: 0, total: 105 } }] }),
    );

    const scanner = new UsageScanner(home, { now: () => NOW, env: {} });
    const first = await scanner.scan();
    const by = (id: string) => first.sources.find((source) => source.id === id)!;
    expect(first.sources.map((source) => source.id)).toEqual(["claude", "codex", "grok", "gemini"]);
    expect(by("claude").periods.today.tokens).toEqual({ total: 1160, cached: 1000, output: 50 });
    expect(by("claude").periods.week.tokens.total).toBe(2320);
    expect(by("claude").periods.week.bars).toEqual([0, 0, 0, 0, 0, 1160, 1160]);
    expect(by("claude").periods.week.models).toHaveLength(2);
    expect(by("claude").periods.week.models).toContainEqual({ model: "claude-opus-5", total: 1160 });
    // m3, nine days ago, is in the month and all time but not the week.
    expect(by("claude").periods.month.tokens.total).toBe(3480);
    expect(by("claude").periods.month.bars).toHaveLength(30);
    expect(by("claude").periods.month.bars.slice(-10)).toEqual([1160, 0, 0, 0, 0, 0, 0, 0, 1160, 1160]);
    expect(by("claude").periods.all.tokens.total).toBe(3480);
    expect(by("claude").periods.all.bars).toEqual([1160, 2320]);
    expect(by("claude").since).toBe("2026-09-17");
    expect(by("codex").periods.today).toMatchObject({ tokens: { total: 340, cached: 200, output: 40 }, models: [{ model: "gpt-5-codex", total: 340 }] });
    // The weekly limit already reset, so only the 5-hour one is left.
    expect(by("codex").limits).toEqual([{ windowMinutes: 300, usedPercent: 42, resetsAt: new Date(Date.parse(at(0)) + 36_000_000).toISOString() }]);
    expect(by("codex").limitsAt).toBe(at(0));
    expect(by("grok").periods.week.bars[4]).toBe(5000);
    // All time goes back to Claude's first week for every CLI, so the columns line up.
    expect(by("grok").periods.all.bars).toEqual([0, 5000]);
    expect(by("grok").since).toBe("2026-09-24");
    expect(by("gemini").periods.today.tokens).toEqual({ total: 105, cached: 10, output: 25 });

    const museAt = new Date(at(0)).getTime() * 1000;
    const museCall = (id: string, stream: string) =>
      JSON.stringify({
        id,
        stream: { id: stream },
        recorded_at: museAt,
        payload: { event: { kind: "model_completed", model: "muse-spark-1.3", usage: { input_tokens: 100, cache_read_tokens: 80, cache_write_tokens: 5, output_tokens: 20, reasoning_tokens: 7 } } },
      });
    const museDir = path.join(home, ".local", "share", "muse", "sessions", "2026", "09", "26", "sess");
    write(
      path.join(museDir, "session.jsonl"),
      [
        museCall("a", "sess"),
        museCall("a", "sess"),
        JSON.stringify({
          id: "lim",
          recorded_at: museAt,
          payload: { event: { kind: "note", subscription: { window: { used_percent: 10, window_duration_mins: 300, resets_at: NOW.getTime() / 1000 + 3600 }, weekly: { used_percent: 4, resets_at: NOW.getTime() / 1000 - 5 } } } },
        }),
        "",
      ].join("\n"),
    );
    write(path.join(museDir, "subagent", "child", "session.jsonl"), `${museCall("b", "child")}\n`);
    const withMuse = await new UsageScanner(home, { now: () => NOW, env: {} }).scan();
    const muse = withMuse.sources.find((source) => source.id === "muse")!;
    expect(muse.periods.today.tokens).toEqual({ total: 250, cached: 160, output: 40 });
    expect(muse.periods.today.models).toEqual([{ model: "muse-spark-1.3", total: 250 }]);
    expect(muse.limits).toEqual([{ windowMinutes: 300, usedPercent: 10, resetsAt: new Date(NOW.getTime() + 3_600_000).toISOString() }]);
    expect(muse.limitsAt).toBe(at(0));

    // A log that grows is read from where the last pass stopped.
    fs.appendFileSync(session, `${claudeLine("m4", at(0), { input_tokens: 1, output_tokens: 1 })}\n`);
    const second = await scanner.scan();
    expect(second.sources.find((source) => source.id === "claude")!.periods.today.tokens.total).toBe(1162);
  });

  it("counts Kimi Code's usage records, turn and session alike", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const record = (scope: string, when: string, usage: Record<string, number>, model = "kimi-code/k3") =>
      JSON.stringify({ type: "usage.record", agentId: "main", model, usage, usageScope: scope, time: Date.parse(when) });
    write(
      path.join(home, ".kimi-code", "sessions", "wd_p_1", "session_a", "agents", "main", "wire.jsonl"),
      [
        JSON.stringify({ type: "token_counting.measured", agentId: "main", tokens: 999, time: Date.parse(at(0)) }),
        JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", usage: { inputOther: 999, output: 999 } } }),
        record("turn", at(0), { inputOther: 100, output: 20, inputCacheRead: 1000, inputCacheCreation: 5 }),
        record("session", at(0), { inputOther: 50, output: 10, inputCacheRead: 0, inputCacheCreation: 0 }),
        record("turn", at(1), { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 }, "kimi-code/kimi-for-coding"),
        "",
      ].join("\n"),
    );
    const [kimi] = (await new UsageScanner(home, { now: () => NOW, env: {} }).scan()).sources;
    expect(kimi.id).toBe("kimi");
    expect(kimi.periods.today.tokens).toEqual({ total: 1185, cached: 1000, output: 30 });
    expect(kimi.periods.week.models).toEqual([
      { model: "kimi-code/k3", total: 1185 },
      { model: "kimi-code/kimi-for-coding", total: 10 },
    ]);
    // KIMI_CODE_HOME moves it.
    expect((await new UsageScanner(home, { now: () => NOW, env: { KIMI_CODE_HOME: path.join(home, "elsewhere") } }).scan()).sources).toEqual([]);
  });

  it("keeps each day in its ledger after the CLI clears the log", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const ledger = path.join(home, "data", "usage-days.json");
    const old = path.join(home, ".claude", "projects", "-p", "old.jsonl");
    const call = { input_tokens: 100, output_tokens: 20 };
    write(old, `${claudeLine("a", at(40), call)}\n${claudeLine("b", at(3), call)}\n`);
    const scanner = () => new UsageScanner(home, { now: () => NOW, env: {}, ledger });

    const first = (await scanner().scan()).sources[0];
    expect(first.periods.all.tokens.total).toBe(240);
    expect(first.periods.month.tokens.total).toBe(120);
    expect(first.since).toBe("2026-08-17");
    // A column per 7 days, back to the first week with tokens (40 days ago is in the sixth week back).
    expect(first.periods.all.bars).toEqual([120, 0, 0, 0, 0, 120]);
    const saved = JSON.parse(fs.readFileSync(ledger, "utf8"));
    expect(saved.scanned).toMatchObject({ claude: "2026-09-26", kimi: "2026-09-26" });
    expect(saved.days.claude["2026-08-17"]["claude-opus-5-5"]).toEqual({ total: 120, cached: 0, output: 20 });

    // Claude Code deletes the log; a new VibeForge still counts both days.
    fs.rmSync(old);
    const after = (await scanner().scan()).sources[0];
    expect(after.periods.all.tokens.total).toBe(240);
    expect(after.periods.week.tokens.total).toBe(120);
  });

  it("reads the days it missed while closed, and only the week once caught up", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const ledger = path.join(home, "usage-days.json");
    const file = path.join(home, ".claude", "projects", "-p", "s.jsonl");
    // Last opened 12 days ago; a session that ended 10 days ago was never seen.
    write(ledger, JSON.stringify({ scanned: "2026-09-14", days: { claude: { "2026-09-14": { "claude-opus-5-5": { total: 5, cached: 0, output: 1 } } } } }));
    write(file, `${claudeLine("x", at(10), { input_tokens: 50 })}\n`);
    const ten = new Date(2026, 8, 16, 18).getTime() / 1000;
    fs.utimesSync(file, ten, ten);
    // A log older than the last pass isn't read again.
    const stale = path.join(home, ".claude", "projects", "-p", "stale.jsonl");
    write(stale, `${claudeLine("y", at(20), { input_tokens: 999 })}\n`);
    const twenty = new Date(2026, 8, 6, 18).getTime() / 1000;
    fs.utimesSync(stale, twenty, twenty);

    const scanner = new UsageScanner(home, { now: () => NOW, env: {}, ledger });
    const first = (await scanner.scan()).sources[0];
    expect(first.periods.all.tokens.total).toBe(55);
    expect(first.periods.month.bars.slice(-13, -9)).toEqual([5, 0, 50, 0]);

    // Caught up: the next pass reads the week only, and the ledger keeps the rest.
    fs.appendFileSync(file, `${claudeLine("z", at(0), { input_tokens: 7 })}\n`);
    const second = (await scanner.scan()).sources[0];
    expect(second.periods.all.tokens.total).toBe(62);
    expect(second.periods.today.tokens.total).toBe(7);
  });

  it("reads all of a CLI's logs once when 2.3.0's ledger hasn't seen it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const ledger = path.join(home, "usage-days.json");
    // 2.3.0 wrote one day for every CLI it read, and didn't read Kimi.
    write(ledger, JSON.stringify({ scanned: "2026-09-26", days: { claude: { "2026-09-25": { "claude-opus-5-5": { total: 5, cached: 0, output: 1 } } } } }));
    const old = new Date(2026, 8, 6, 18).getTime() / 1000;
    const kimi = path.join(home, ".kimi-code", "sessions", "wd_p_1", "session_a", "agents", "main", "wire.jsonl");
    write(kimi, `${JSON.stringify({ type: "usage.record", model: "kimi-code/k3", usage: { inputOther: 40 }, usageScope: "turn", time: Date.parse(at(20)) })}\n`);
    fs.utimesSync(kimi, old, old);
    const claude = path.join(home, ".claude", "projects", "-p", "s.jsonl");
    write(claude, `${claudeLine("y", at(20), { input_tokens: 999 })}\n`);
    fs.utimesSync(claude, old, old);

    const sources = (await new UsageScanner(home, { now: () => NOW, env: {}, ledger }).scan()).sources;
    expect(sources.find((source) => source.id === "kimi")!.periods.all.tokens.total).toBe(40);
    // Claude's old log was already behind its last pass, so it isn't read again.
    expect(sources.find((source) => source.id === "claude")!.periods.all.tokens.total).toBe(5);
    expect(JSON.parse(fs.readFileSync(ledger, "utf8")).scanned).toMatchObject({ claude: "2026-09-26", kimi: "2026-09-26" });
  });

  it("starts over from a ledger it can't read", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-"));
    const ledger = path.join(home, "usage-days.json");
    write(ledger, JSON.stringify({ scanned: 12, days: { claude: { "not a day": {}, "2026-09-25": { m: { total: "lots" }, n: { total: 3 } } }, codex: null } }));
    write(path.join(home, ".claude", "projects", "-p", "s.jsonl"), `${claudeLine("a", at(0), { input_tokens: 10 })}\n`);
    const [claude] = (await new UsageScanner(home, { now: () => NOW, env: {}, ledger }).scan()).sources;
    expect(claude.periods.all.tokens.total).toBe(13);
    expect(claude.periods.all.models).toEqual([{ model: "claude-opus-5-5", total: 10 }, { model: "n", total: 3 }]);
    expect(Object.keys(JSON.parse(fs.readFileSync(ledger, "utf8")).days.claude)).toEqual(["2026-09-25", "2026-09-26"]);
  });
});
