import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainContext } from "../../electron/main-context.js";
import { Disposables, startSchedules } from "../../electron/timers.js";
import { LogFile } from "../../src/core/log.js";
import { TICK_MS } from "../../src/core/routines.js";

let scratch = "";
afterEach(() => {
  vi.useRealTimers();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the list a quit stops", () => {
  it("stops what was added, in that order, once", () => {
    const order: string[] = [];
    const list = new Disposables();
    list.add(() => order.push("a"), () => order.push("b"));
    list.add(() => order.push("c"));
    list.dispose();
    list.dispose();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("clears its timers and intervals", () => {
    vi.useFakeTimers();
    let runs = 0;
    const list = new Disposables();
    list.timeout(() => (runs += 1), 1000);
    list.interval(() => (runs += 10), 500);
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(21);
    list.dispose();
    vi.advanceTimersByTime(10_000);
    expect(runs).toBe(21);
  });
});

describe("what runs on a clock", () => {
  function setUp(service: Record<string, unknown>) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vf-timers-"));
    const log = new LogFile(path.join(scratch, "vibeforge.log"));
    const ctx = new MainContext({
      roots: { configRoot: scratch, dataRoot: scratch },
      log,
      supervisor: {} as never,
      words: {} as never,
      appRoot: scratch,
      install: "checkout",
      palette: {} as never,
    });
    ctx.service = service as never;
    const lines = () => log.tail(20).map((line) => line.replace(/^\S+ /, ""));
    return { ctx, lines };
  }

  it("checks routines 3 s after start and then every tick, and tidies runs after two minutes", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { ctx, lines } = setUp({
      tick: async () => {
        calls.push("tick");
        return [{ routineId: "nightly", error: "no such CLI" }, { routineId: "ok", error: null }];
      },
      maintainRuns: async () => {
        calls.push("upkeep");
        return { compressed: 2, removed: 1, freed: 3 * 1024 * 1024 };
      },
    });
    const timers = new Disposables();
    startSchedules(ctx, timers);
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["tick"]);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(calls.filter((call) => call === "tick").length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(calls).toContain("upkeep");
    expect(lines()).toContain("WARN  Routine nightly could not start: no such CLI");
    expect(lines()).toContain("INFO  Runs tidied: 2 compressed, 1 removed, 3 MB freed");
    timers.dispose();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    expect(calls).toHaveLength(before);
  });

  it("logs a scheduler or upkeep failure and keeps going", async () => {
    vi.useFakeTimers();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, lines } = setUp({
      tick: async () => {
        throw new Error("index locked");
      },
      maintainRuns: async () => {
        throw new Error("disk full");
      },
    });
    const timers = new Disposables();
    startSchedules(ctx, timers);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    timers.dispose();
    quiet.mockRestore();
    expect(lines().some((line) => line.startsWith("ERROR Routine scheduler: index locked"))).toBe(true);
    expect(lines().some((line) => line.startsWith("WARN  Run upkeep: disk full"))).toBe(true);
  });
});
