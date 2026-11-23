import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Version headings are Markdown reference links. The definitions at the bottom of CHANGELOG.md
// were last updated for 2.15.0 and then left behind, so 2.16.0 through 3.4.2 rendered as plain
// brackets. This fails the build when a new heading ships without its link.

const repo = path.resolve(import.meta.dirname, "..", "..");
const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };

describe("changelog links", () => {
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
  const links = new Map([...changelog.matchAll(/^\[([^\]]+)\]: (\S+)\s*$/gm)].map((match) => [match[1], match[2]]));
  const versions = headings.filter((heading) => heading !== "Unreleased");

  it("links every heading, and only those headings", () => {
    expect(headings.length).toBeGreaterThan(0);
    expect([...links.keys()]).toEqual(headings);
  });

  it("points Unreleased at the newest tagged version, which is package.json", () => {
    expect(versions[0]).toBe(version);
    expect(links.get("Unreleased")).toBe(`https://github.com/L0nE-F0x/VibeForge/compare/v${version}...HEAD`);
  });

  it("points each version at that tag", () => {
    for (const release of versions) {
      expect(links.get(release), release).toContain(`/v${release}`);
    }
  });
});
