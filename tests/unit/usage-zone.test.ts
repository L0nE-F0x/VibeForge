// The time zone is set before anything here reads the clock: Node picks a change to TZ up at once.
process.env.TZ = "Asia/Tokyo";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageScanner } from "../../src/core/usage.js";

const claudeLine = (id: string, when: string, total: number) =>
  JSON.stringify({ type: "assistant", timestamp: when, requestId: `req-${id}`, message: { id, model: "claude-opus-5-5", usage: { input_tokens: total, output_tokens: 0 } } });

describe("token days after a move to another time zone", () => {
  it("counts the week's days again instead of keeping both days' counts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-usage-zone-"));
    const ledger = path.join(home, "usage-days.json");
    // 2026-11-10 20:00 UTC: the 11th in Tokyo, the 10th in New York.
    fs.mkdirSync(path.join(home, ".claude", "projects", "-p"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "projects", "-p", "one.jsonl"), `${claudeLine("m1", "2026-11-10T20:00:00Z", 500)}\n`);
    const now = () => new Date("2026-11-12T03:00:00Z");
    const scanner = new UsageScanner(home, { now, env: {}, ledger });
    const tokyo = await scanner.scan();
    expect(tokyo.sources[0].periods.week.tokens.total).toBe(500);
    expect(Object.keys(JSON.parse(fs.readFileSync(ledger, "utf8")).days.claude)).toEqual(["2026-11-11"]);

    process.env.TZ = "America/New_York";
    const york = await scanner.scan();
    expect(york.sources[0].periods.week.tokens.total).toBe(500);
    expect(york.sources[0].periods.all.tokens.total).toBe(500);
    const saved = JSON.parse(fs.readFileSync(ledger, "utf8"));
    expect(Object.keys(saved.days.claude)).toEqual(["2026-11-10"]);
    expect(saved.zone).toBe("America/New_York");
    // A fresh start reads the same ledger the same way.
    const again = await new UsageScanner(home, { now, env: {}, ledger }).scan();
    expect(again.sources[0].periods.all.tokens.total).toBe(500);
  });
});
