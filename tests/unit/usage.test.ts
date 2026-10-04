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

    const scanner = new UsageScanner(home, () => NOW, {});
    const first = await scanner.scan();
    const by = (id: string) => first.sources.find((source) => source.id === id)!;
    expect(first.sources.map((source) => source.id)).toEqual(["claude", "codex", "grok", "gemini"]);
    expect(by("claude").today).toEqual({ total: 1160, cached: 1000, output: 50 });
    expect(by("claude").week.total).toBe(2320);
    expect(by("claude").days).toEqual([0, 0, 0, 0, 0, 1160, 1160]);
    expect(by("claude").models).toHaveLength(2);
    expect(by("claude").models).toContainEqual({ model: "claude-opus-5", total: 1160 });
    expect(by("codex")).toMatchObject({ today: { total: 340, cached: 200, output: 40 }, models: [{ model: "gpt-5-codex", total: 340 }] });
    // The weekly limit already reset, so only the 5-hour one is left.
    expect(by("codex").limits).toEqual([{ windowMinutes: 300, usedPercent: 42, resetsAt: new Date(Date.parse(at(0)) + 36_000_000).toISOString() }]);
    expect(by("codex").limitsAt).toBe(at(0));
    expect(by("grok").days[4]).toBe(5000);
    expect(by("gemini").today).toEqual({ total: 105, cached: 10, output: 25 });

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
    const withMuse = await new UsageScanner(home, () => NOW, {}).scan();
    const muse = withMuse.sources.find((source) => source.id === "muse")!;
    expect(muse.today).toEqual({ total: 250, cached: 160, output: 40 });
    expect(muse.models).toEqual([{ model: "muse-spark-1.3", total: 250 }]);
    expect(muse.limits).toEqual([{ windowMinutes: 300, usedPercent: 10, resetsAt: new Date(NOW.getTime() + 3_600_000).toISOString() }]);
    expect(muse.limitsAt).toBe(at(0));

    // A log that grows is read from where the last pass stopped.
    fs.appendFileSync(session, `${claudeLine("m4", at(0), { input_tokens: 1, output_tokens: 1 })}\n`);
    const second = await scanner.scan();
    expect(second.sources.find((source) => source.id === "claude")!.today.total).toBe(1162);
  });
});
