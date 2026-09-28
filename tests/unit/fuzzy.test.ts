import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../../src/ui/fuzzy.js";

const rank = (query: string, names: string[]) =>
  names
    .map((name) => ({ name, score: fuzzyScore(query, name) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.name);

describe("fuzzyScore", () => {
  it("matches nothing for letters that aren't there, and everything for an empty query", () => {
    expect(fuzzyScore("xyz", "Atlas")).toBe(-1);
    expect(fuzzyScore("", "Atlas")).toBe(0);
  });

  it("puts a name that starts with the query first, then a word start, then the middle", () => {
    expect(rank("at", ["Great plan", "Data audit", "Atlas"])).toEqual(["Atlas", "Data audit", "Great plan"]);
  });

  it("finds initials above scattered letters, and both below whole matches", () => {
    expect(rank("rn", ["Run now", "release-notes", "Burn"])).toEqual(["Burn", "release-notes", "Run now"]);
    expect(fuzzyScore("rn", "release-notes")).toBeGreaterThan(fuzzyScore("rn", "random things now"));
  });

  it("ignores case and prefers the shorter of two equal matches", () => {
    expect(rank("ATL", ["Atlas the second", "atlas"])).toEqual(["atlas", "Atlas the second"]);
  });
});
