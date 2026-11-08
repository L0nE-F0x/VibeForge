import { describe, expect, it } from "vitest";
import { ActivityCache } from "../../electron/stats.js";
import type { Activity } from "../../src/core/activity.js";

function setUp() {
  let now = 1_000_000;
  const reads: Array<[string, string[]]> = [];
  const cache = new ActivityCache(
    async (source, paths) => {
      reads.push([source, paths]);
      return { source, days: [], total: reads.length, login: null, error: null } as unknown as Activity;
    },
    () => now,
  );
  return { cache, reads, later: (ms: number) => (now += ms) };
}

describe("the activity graph's cache", () => {
  it("reads git again after five minutes, or when the workspaces change", async () => {
    const { cache, reads, later } = setUp();
    const first = cache.get("git", ["/a", "/b"], false);
    later(4 * 60_000);
    expect(cache.get("git", ["/a", "/b"], false)).toBe(first);
    expect(reads).toHaveLength(1);
    cache.get("git", ["/a"], false);
    expect(reads).toHaveLength(2);
    later(5 * 60_000);
    cache.get("git", ["/a"], false);
    expect(reads).toEqual([
      ["git", ["/a", "/b"]],
      ["git", ["/a"]],
      ["git", ["/a"]],
    ]);
  });

  it("keeps GitHub's for half an hour, whatever the workspaces", () => {
    const { cache, reads, later } = setUp();
    const first = cache.get("github", ["/a"], false);
    later(29 * 60_000);
    expect(cache.get("github", ["/b"], false)).toBe(first);
    later(60_000);
    cache.get("github", ["/b"], false);
    expect(reads).toHaveLength(2);
  });

  it("reads afresh when asked to, and when the source changes", () => {
    const { cache, reads } = setUp();
    cache.get("git", ["/a"], false);
    cache.get("git", ["/a"], true);
    cache.get("github", ["/a"], false);
    cache.get("git", ["/a"], false);
    expect(reads.map(([source]) => source)).toEqual(["git", "git", "github", "git"]);
  });
});
