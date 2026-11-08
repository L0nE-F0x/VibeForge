import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_FILES, ENTRIES, PACKAGES, provided, ships, specifiers } from "../../scripts/pack-release.mjs";

// scripts/pack-release.mjs packs a list of files, not the whole checkout. These keep the list in
// step with what the app reads from its folder at runtime, so a change that loads something new
// is caught in review, not by the release's smoke test on release day.

const repo = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");
const shipped = ships;
const packageOf = (spec: string) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

describe("the ready-made build's file list", () => {
  it("names files that are there (the build makes dist and dist-electron)", () => {
    for (const file of APP_FILES.filter((item) => item !== "dist" && item !== "dist-electron")) {
      expect(fs.existsSync(path.join(repo, file.replace(/\/\*.*$/, ""))), file).toBe(true);
    }
    // Whole folders, so a module added to the phone page or the scripts ships with it.
    expect(shipped("companion/js/new-module.js")).toBe(true);
    expect(shipped("electron/pty-host.cjs")).toBe(true);
    expect(shipped("electron/main.ts")).toBe(false);
    expect(ENTRIES).toEqual(expect.arrayContaining(["electron/pty-host.cjs", "electron/terminal-capture.cjs", "scripts/talk.mjs"]));
  });

  it("ships every module the terminal host and `vibeforge tell` load", () => {
    for (const entry of ENTRIES) {
      expect(shipped(entry), entry).toBe(true);
      for (const spec of specifiers(read(entry))) {
        if (provided(spec)) continue;
        if (spec.startsWith(".")) expect(shipped(path.posix.join(path.posix.dirname(entry), spec)), `${entry} → ${spec}`).toBe(true);
        else expect(Object.keys(PACKAGES), `${entry} → ${spec}`).toContain(packageOf(spec));
      }
    }
  });

  it("ships every file the main process opens from the app's folder", () => {
    const joins: string[] = [];
    const sources = fs.readdirSync(path.join(repo, "electron"), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
    for (const file of sources) {
      for (const [, args] of read(path.join("electron", file)).matchAll(/path\.join\(appRoot(?:\(\))?,\s*((?:"[^"]+"\s*,?\s*)+)\)/g)) {
        joins.push([...args.matchAll(/"([^"]+)"/g)].map((match) => match[1]).join("/"));
      }
    }
    // The icon, the page, the preload, the launcher, the terminal host and the phone page at least.
    expect(joins.length).toBeGreaterThanOrEqual(5);
    // .git only tells a checkout from an installer copy, which has none.
    for (const file of joins.filter((join) => join !== ".git")) expect(shipped(file), file).toBe(true);
    // The main process loads the screen restorer from disk too (src/core/restore-screen.ts).
    expect(read("src/core/restore-screen.ts")).toContain("electron/terminal-capture.cjs");
    expect(shipped("electron/terminal-capture.cjs")).toBe(true);
  });

  it("ships what the installer checks for after unpacking", () => {
    const install = read("scripts/install.sh");
    const parts = /for part in ([^;]+); do/.exec(install)?.[1].trim().split(/\s+/) ?? [];
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(part);
      if (pkg) expect(PACKAGES[pkg[1]]?.some((item) => pkg[2] === item || pkg[2].startsWith(`${item}/`)), part).toBe(true);
      else expect(shipped(part), part).toBe(true);
    }
  });
});
