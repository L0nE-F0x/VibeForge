import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateRunDir, normalizeRun } from "../../src/core/runs.js";
import type { RunMeta } from "../../src/core/types.js";
import { setup } from "./fixtures/service-harness.js";

const DAY = 24 * 60 * 60 * 1000;

/** Ended runs, oldest first, each with `kb` KB in a file the tidy-up doesn't compress; their folders settled. */
function endedRuns(ctx: ReturnType<typeof setup>, count: number, kb: number) {
  return Array.from({ length: count }, (_, index) => {
    const when = new Date(Date.now() - (100 - index * 10) * DAY).toISOString();
    const { id, dir } = allocateRunDir(ctx.dataRoot, new Date(when), `run-${index}`);
    ctx.svc.store.saveRun(normalizeRun({ id, dir, origin: "code", status: "exited", startedAt: when, endedAt: when, openedAt: when, title: `Run ${index}` }) as RunMeta);
    fs.writeFileSync(path.join(dir, "notes.bin"), Buffer.alloc(kb * 1024));
    const then = Date.now() / 1000 - 3600;
    fs.utimesSync(dir, then, then);
    return { id, dir };
  });
}

/** How many times each run folder was walked to add up its size. */
function countWalks(dirs: string[]) {
  const read = vi.spyOn(fs, "readdirSync");
  return () => dirs.map((dir) => read.mock.calls.filter(([name]) => name === dir).length);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run upkeep", () => {
  it("measures run folders only for a size limit, and a folder that holds still only once", async () => {
    const ctx = setup();
    const runs = endedRuns(ctx, 4, 8);
    const walks = countWalks(runs.map((run) => run.dir));

    // Keeping every run needs no sizes.
    expect(await ctx.svc.maintainRuns()).toMatchObject({ removed: 0 });
    expect(walks()).toEqual([0, 0, 0, 0]);

    ctx.svc.saveSettings({ keepRuns: { days: 0, maxMb: 1000 } });
    await ctx.svc.maintainRuns();
    await ctx.svc.maintainRuns();
    expect(walks()).toEqual([1, 1, 1, 1]);

    // A folder that changes is measured again.
    fs.writeFileSync(path.join(runs[2].dir, "more.bin"), "x");
    await ctx.svc.maintainRuns();
    expect(walks()).toEqual([1, 1, 2, 1]);
    ctx.svc.close();
  });

  it("removes the oldest runs past the size limit, and counts what they freed", async () => {
    const ctx = setup();
    // 4 × 400 KB against a 1 MB limit: the two oldest go.
    const runs = endedRuns(ctx, 4, 400);
    ctx.svc.saveSettings({ keepRuns: { days: 0, maxMb: 1 } });
    const result = await ctx.svc.maintainRuns();
    expect(result.removed).toBe(2);
    expect(result.freed).toBeGreaterThanOrEqual(2 * 400 * 1024);
    expect(runs.map((run) => fs.existsSync(run.dir))).toEqual([false, false, true, true]);
    ctx.svc.close();
  });

  it("with only a day limit, measures just the runs it removes", async () => {
    const ctx = setup();
    const runs = endedRuns(ctx, 3, 8);
    const walks = countWalks(runs.map((run) => run.dir));
    // Ended 100, 90 and 80 days ago; keep 95 days.
    ctx.svc.saveSettings({ keepRuns: { days: 95, maxMb: 0 } });
    const result = await ctx.svc.maintainRuns();
    expect(result.removed).toBe(1);
    expect(result.freed).toBeGreaterThanOrEqual(8 * 1024);
    expect(walks()).toEqual([1, 0, 0]);
    ctx.svc.close();
  });
});
