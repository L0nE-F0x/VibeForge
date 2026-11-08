import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServiceCore } from "../../src/core/service/core.js";
import { SavedFiles } from "../../src/core/service/messages-files.js";
import { tempDir } from "./fixtures/service-harness.js";

// The files MessageDesk saves for a CLI to read by path (long messages, patches), and their tidying.

const DAY = 24 * 60 * 60 * 1000;

function files(inUse: string[] = []) {
  const dataRoot = tempDir();
  let at = Date.parse("2026-11-08T09:00:00Z");
  const core = { options: { dataRoot }, now: () => new Date(at) } as unknown as ServiceCore;
  return { saved: new SavedFiles(core, () => inUse), dir: path.join(dataRoot, "messages"), now: () => new Date(at), pass: (ms: number) => (at += ms) };
}

describe("saved message files", () => {
  it("saves only a long text, ending in a newline, under a name that starts with when", () => {
    const { saved, dir } = files();
    expect(saved.saveIfLong("messages", "short")).toBeNull();
    const file = saved.saveIfLong("messages", "word ".repeat(3000).trim());
    expect(path.dirname(file!)).toBe(dir);
    expect(path.basename(file!)).toMatch(/^2026-11-08T09-00-00-000Z-[0-9a-f]{6}\.md$/);
    expect(fs.readFileSync(file!, "utf8").endsWith("word\n")).toBe(true);
  });

  it("tidies old files by their name's time, else their own, and keeps one still named or unreadable", () => {
    const named: string[] = [];
    const { saved, dir, now, pass } = files(named);
    const first = saved.saveFile("messages", "md", "first");
    const kept = saved.saveFile("messages", "md", "still in line");
    named.push(`Read ${kept}`);
    // Put there by hand: no time in the name, so its own counts.
    const loose = path.join(dir, "notes.md");
    fs.writeFileSync(loose, "old");
    fs.utimesSync(loose, now(), now());
    // A link to nothing has no time to read, so it's left alone.
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "dangling.md"));
    pass(4 * DAY);
    const fresh = path.join(dir, "fresh.md");
    fs.writeFileSync(fresh, "new");
    fs.utimesSync(fresh, now(), now());
    const last = saved.saveFile("messages", "md", "last");
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(kept), path.basename(last), "dangling.md", "fresh.md"].sort());
    expect(fs.existsSync(first)).toBe(false);
  });
});
