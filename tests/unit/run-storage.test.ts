import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compressRun, hasRunFile, planCleanup, readRunText, type CleanupCandidate } from "../../src/core/run-storage.js";
import { normalizeRun, readRunFiles } from "../../src/core/runs.js";
import type { RunMeta } from "../../src/core/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-storage-"));
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00Z");

function candidate(id: string, daysAgo: number, mb: number, extra: Partial<RunMeta> = {}): CleanupCandidate {
  const ended = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  const run = normalizeRun({ id, status: "exited", startedAt: ended, endedAt: ended, openedAt: ended, ...extra }) as RunMeta;
  return { run, bytes: mb * 1024 * 1024 };
}

describe("run storage", () => {
  it("compresses the scrollback and the patch, and reads them back unchanged", async () => {
    const dir = tempDir();
    const scrollback = "\x1b[32mhello\x1b[0m line\r\n".repeat(4000);
    const patch = "diff --git a/a b/a\n+added\n".repeat(2000);
    fs.writeFileSync(path.join(dir, "scrollback.txt"), scrollback);
    fs.writeFileSync(path.join(dir, "diff.patch"), patch);
    fs.writeFileSync(path.join(dir, "transcript.txt"), "hello line\n");
    const saved = await compressRun(dir);
    expect(saved).toBeGreaterThan(100_000);
    expect(fs.existsSync(path.join(dir, "scrollback.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "scrollback.txt.gz"))).toBe(true);
    // Small files are left alone.
    expect(fs.existsSync(path.join(dir, "transcript.txt"))).toBe(true);
    expect(readRunText(dir, "scrollback.txt")).toBe(scrollback);
    expect(readRunText(dir, "diff.patch")).toBe(patch);
    expect(hasRunFile(dir, "diff.patch")).toBe(true);
    expect(readRunFiles(dir)).toMatchObject({ scrollback, patchSaved: true });
    // Again is a no-op.
    expect(await compressRun(dir)).toBe(0);
    expect(await compressRun(path.join(dir, "gone"))).toBe(0);
  });

  it("keeps everything by default", () => {
    expect(planCleanup([candidate("a", 400, 50)], { days: 0, maxMb: 0 }, NOW, new Set())).toEqual([]);
  });

  it("removes runs past their age, oldest first, but never the protected ones", () => {
    const list = [
      candidate("new", 1, 1),
      candidate("old", 40, 1),
      candidate("older", 90, 1),
      candidate("kept", 100, 1),
      candidate("live", 100, 1, { status: "running" }),
    ];
    const plan = planCleanup(list, { days: 30, maxMb: 0 }, NOW, new Set(["kept"]));
    expect(plan.map((item) => item.run.id)).toEqual(["older", "old"]);
  });

  it("removes the oldest runs until everything fits under the cap", () => {
    const list = [candidate("a", 1, 30), candidate("b", 2, 30), candidate("c", 3, 30), candidate("d", 4, 30)];
    const plan = planCleanup(list, { days: 0, maxMb: 70 }, NOW, new Set(["d"]));
    // d is protected, so c and b go: 120 → 60 MB.
    expect(plan.map((item) => item.run.id)).toEqual(["c", "b"]);
  });
});
