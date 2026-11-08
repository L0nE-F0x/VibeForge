import { describe, expect, it } from "vitest";
import { IDLE_KEEP, QueryCache, sameData } from "../../src/ui/query-cache.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetcher whose answers the test sets, counting how often it was asked. */
function source<T>(first: T) {
  const state = { value: first, calls: 0, fail: null as string | null };
  const fetcher = async () => {
    state.calls += 1;
    if (state.fail) throw new Error(state.fail);
    return state.value;
  };
  return { state, fetcher };
}

describe("query cache", () => {
  it("leaves readers alone when a refetch finds the same data", async () => {
    const cache = new QueryCache(String);
    const { state, fetcher } = source([{ id: "a", live: true }]);
    const entry = cache.entry("runs", ["runs", "live"], fetcher);
    let renders = 0;
    cache.subscribe(entry, () => (renders += 1), entry.topics);
    await tick();
    expect(renders).toBe(1);
    const first = entry.snapshot;

    state.value = [{ id: "a", live: true }];
    cache.invalidate(["live"]);
    await tick();
    expect(state.calls).toBe(2);
    expect(renders).toBe(1);
    expect(entry.snapshot).toBe(first);

    state.value = [{ id: "a", live: false }];
    cache.invalidate(["live"]);
    await tick();
    expect(renders).toBe(2);
    expect(entry.snapshot.data).toEqual([{ id: "a", live: false }]);
  });

  it("publishes an error once, and the data again when it comes back", async () => {
    const cache = new QueryCache((error) => (error instanceof Error ? error.message : String(error)));
    const { state, fetcher } = source({ n: 1 });
    const entry = cache.entry("x", ["runs"], fetcher);
    let renders = 0;
    cache.subscribe(entry, () => (renders += 1), entry.topics);
    await tick();
    state.fail = "gone";
    await cache.load(entry);
    await cache.load(entry);
    expect(renders).toBe(2);
    expect(entry.snapshot).toMatchObject({ error: "gone", data: { n: 1 } });
    state.fail = null;
    await cache.load(entry);
    expect(renders).toBe(3);
    expect(entry.snapshot.error).toBeNull();
  });

  it("follows the topics of everyone reading, and the last render's while nobody is", async () => {
    const cache = new QueryCache(String);
    const { state, fetcher } = source({ status: "done" });
    const entry = cache.entry("run:1", ["runs"], fetcher);
    const off = cache.subscribe(entry, () => undefined, ["runs"]);
    const offLive = cache.subscribe(entry, () => undefined, ["runs", "live"]);
    await tick();
    cache.invalidate(["live"]);
    await tick();
    expect(state.calls).toBe(2);
    offLive();
    cache.invalidate(["live"]);
    await tick();
    expect(state.calls).toBe(2);
    off();
    cache.invalidate(["runs"]);
    expect(entry.loaded).toBe(false);
  });

  it("chooses topics from what it read last: a running run follows its terminal", async () => {
    const cache = new QueryCache(String);
    const { state, fetcher } = source({ status: "running" });
    const pick = (data: unknown) => ((data as { status?: string } | undefined)?.status === "running" ? (["runs", "live", "working"] as const) : (["runs"] as const));
    let entry = cache.entry("run:2", pick, fetcher);
    expect(entry.topics).toEqual(["runs"]);
    await cache.load(entry);
    entry = cache.entry("run:2", pick, fetcher);
    expect(entry.topics).toEqual(["runs", "live", "working"]);
    state.value = { status: "exited" };
    await cache.load(entry);
    expect(cache.entry("run:2", pick, fetcher).topics).toEqual(["runs"]);
  });

  it("refetches only what follows a topic: a busy flip doesn't reach runs or chats", async () => {
    const cache = new QueryCache(String);
    const live = source([]);
    const runs = source([]);
    const tasks = source([]);
    for (const [key, topics, fetcher] of [
      ["live", ["live", "working"], live.fetcher],
      ["runs:all", ["runs", "live"], runs.fetcher],
      ["tasks", ["tasks", "live", "working"], tasks.fetcher],
    ] as const) {
      const entry = cache.entry(key, topics, fetcher);
      cache.subscribe(entry, () => undefined, entry.topics);
    }
    await tick();
    cache.invalidate(["working"]);
    await tick();
    expect([live.state.calls, runs.state.calls, tasks.state.calls]).toEqual([2, 1, 2]);
  });

  it("drops searches nobody reads, keeping the last few", async () => {
    const cache = new QueryCache(String);
    const kept = cache.entry("runs:all", ["runs"], source([]).fetcher);
    cache.subscribe(kept, () => undefined, ["runs"])();
    const texts = Array.from({ length: IDLE_KEEP + 3 }, (_, index) => `runs:search:${index}`);
    for (const key of texts) {
      const entry = cache.entry(key, ["runs"], source([]).fetcher, { keep: false });
      cache.subscribe(entry, () => undefined, ["runs"])();
    }
    expect(texts.filter((key) => cache.has(key))).toEqual(texts.slice(-IDLE_KEEP));
    expect(cache.has("runs:all")).toBe(true);
  });

  it("brings back an entry its reader subscribes to again after it was dropped", async () => {
    const cache = new QueryCache(String);
    const entry = cache.entry("runs:search:a", ["runs"], source([]).fetcher, { keep: false });
    cache.subscribe(entry, () => undefined, ["runs"])();
    for (let index = 0; index < IDLE_KEEP + 1; index += 1) cache.subscribe(cache.entry(`other:${index}`, ["runs"], source([]).fetcher, { keep: false }), () => undefined, ["runs"])();
    expect(cache.has("runs:search:a")).toBe(false);
    cache.subscribe(entry, () => undefined, ["runs"]);
    expect(cache.has("runs:search:a")).toBe(true);
  });

  it("leaves the run files out of the 30 s refresh", async () => {
    const cache = new QueryCache(String);
    const tasks = source([]);
    const bundle = source({});
    cache.subscribe(cache.entry("tasks", ["tasks"], tasks.fetcher), () => undefined, ["tasks"]);
    cache.subscribe(cache.entry("run:1", ["runs"], bundle.fetcher, { poll: false }), () => undefined, ["runs"]);
    await tick();
    cache.refresh();
    await tick();
    expect([tasks.state.calls, bundle.state.calls]).toEqual([2, 1]);
  });
});

describe("sameData", () => {
  it("compares what comes over IPC by value", () => {
    expect(sameData({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null })).toBe(true);
    expect(sameData({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameData([], {})).toBe(false);
    expect(sameData(Number.NaN, Number.NaN)).toBe(true);
    expect(sameData("a", "b")).toBe(false);
  });

  it("counts anything but plain objects as changed unless it is the same one", () => {
    const date = new Date(0);
    expect(sameData(date, date)).toBe(true);
    expect(sameData(new Date(0), new Date(0))).toBe(false);
    expect(sameData(new Map(), new Map())).toBe(false);
  });
});
