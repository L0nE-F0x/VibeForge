import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNewer } from "../../src/core/updates.js";

// The website names the current version in several hand-written places: the header's release link,
// the install window's transcript and the update dialog's art. A release PR bumps them by hand, and
// once the transcript said "Downloading 2.14.1" above "2.15.0 is installed". These keep them in step
// with package.json.

const repo = path.resolve(import.meta.dirname, "..", "..");
const html = fs.readFileSync(path.join(repo, "site", "index.html"), "utf8");
const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };

/** Every capture of `pattern` in the page; the test fails when it finds none. */
function all(pattern: RegExp): string[] {
  const found = [...html.matchAll(pattern)].map((match) => match[1]);
  expect(found.length, String(pattern)).toBeGreaterThan(0);
  return found;
}

describe("the website's version", () => {
  it("links the current release in the header", () => {
    expect(all(/What's new in ([\d.]+)"/g)).toEqual([version]);
    expect(all(/title="What's new in [\d.]+">v([\d.]+)</g)).toEqual([version]);
  });

  it("installs the current release in the install window's transcript", () => {
    const transcript = html.slice(html.indexOf('class="iw-ln'));
    expect(all(/Downloading VibeForge ([\d.]+), ready-made for/g)).toEqual([version]);
    expect([...transcript.matchAll(/iw-done[^>]*>.*?VibeForge ([\d.]+) is installed/g)].map((match) => match[1])).toEqual([version]);
  });

  it("updates from the current release to a later one in the update art", () => {
    const [have] = all(/You have ([\d.]+)\./g);
    const [offered] = all(/VibeForge ([\d.]+) is available\./g);
    expect(have).toBe(version);
    expect(isNewer(offered, have)).toBe(true);
  });
});
