import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeError, LogFile } from "../../src/core/log.js";
import { INSTALL_URL, installKind, isNewer, parseVersion, releaseFrom, updateCommand } from "../../src/core/updates.js";

describe("updates", () => {
  it("compares versions numerically, with or without a leading v", () => {
    expect(parseVersion("v0.3.0")).toEqual([0, 3, 0]);
    expect(parseVersion("banana")).toBeNull();
    expect(isNewer("0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.2.9", "0.3.0")).toBe(false);
    expect(isNewer("nightly", "0.3.0")).toBe(false);
  });

  it("reads GitHub's latest-release answer", () => {
    expect(
      releaseFrom({ tag_name: "v0.3.0", name: "VibeForge 0.3.0", html_url: "https://github.com/x/releases/tag/v0.3.0", body: "Notes", published_at: "2026-09-25T20:00:00Z" }),
    ).toEqual({ version: "0.3.0", name: "VibeForge 0.3.0", url: "https://github.com/x/releases/tag/v0.3.0", notes: "Notes", publishedAt: "2026-09-25T20:00:00Z" });
    expect(releaseFrom({ tag_name: "v1.2.3", name: "" })?.name).toBe("VibeForge v1.2.3");
    expect(releaseFrom({ message: "Not Found" })).toBeNull();
    expect(releaseFrom(null)).toBeNull();
  });

  it("knows how this copy was installed", () => {
    const installer = "/home/me/.local/share/vibeforge-app";
    expect(installKind(installer, { installerHome: installer, marked: false, checkout: true })).toBe("installer");
    expect(installKind("/opt/elsewhere", { installerHome: installer, marked: true, checkout: true })).toBe("installer");
    expect(installKind("/home/me/code/VibeForge", { installerHome: installer, marked: false, checkout: true })).toBe("checkout");
    expect(installKind("/usr/lib/vibeforge", { installerHome: installer, marked: false, checkout: false })).toBe("other");
  });

  it("builds the update command for each kind, quoting paths", () => {
    expect(updateCommand("installer", "/home/me/My Apps/vf")).toBe(`curl -fsSL ${INSTALL_URL} | VIBEFORGE_HOME='/home/me/My Apps/vf' bash`);
    expect(updateCommand("checkout", "/home/me/VibeForge")).toBe("cd /home/me/VibeForge && git pull --ff-only && npm install --no-audit --no-fund && npm run build");
    expect(updateCommand("other", "/usr/lib/vibeforge")).toBeNull();
    expect(updateCommand("other", "/usr/lib/vibeforge", "yay -Syu vibeforge")).toBe("yay -Syu vibeforge");
  });
});

describe("the log file", () => {
  it("appends lines, rotates past its cap, and reads the tail across both files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-log-"));
    const file = path.join(dir, "logs", "vibeforge.log");
    let tick = 0;
    const log = new LogFile(file, 400, () => new Date(Date.UTC(2026, 8, 25, 12, 0, tick++)));
    for (let i = 1; i <= 12; i++) log.info(`event ${i}`);
    log.error("two\nlines");
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    const tail = log.tail(6);
    expect(tail).toHaveLength(6);
    expect(tail.at(-2)).toMatch(/ERROR two$/);
    expect(tail.at(-1)).toBe("    lines");
    expect(tail[0]).toMatch(/^2026-09-25T12:00:\d\d\.000Z INFO  event \d+$/);
    expect(log.tail(1000).filter((line) => line.includes("event")).length).toBeGreaterThan(6);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("describes errors on one line plus a few frames", () => {
    expect(describeError("plain")).toBe("plain");
    const text = describeError(new Error("broke"));
    expect(text.split("\n")[0]).toBe("broke");
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
  });
});
