import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeError, LogFile, PageErrors } from "../../src/core/log.js";
import crypto from "node:crypto";
import { INSTALL_URL, installKind, isNewer, parseVersion, releaseFrom, updateCommand, type Release } from "../../src/core/updates.js";

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
    ).toEqual({ version: "0.3.0", tag: "v0.3.0", name: "VibeForge 0.3.0", url: "https://github.com/x/releases/tag/v0.3.0", notes: "Notes", publishedAt: "2026-09-25T20:00:00Z", installer: null });
    expect(releaseFrom({ tag_name: "v1.2.3", name: "" })?.name).toBe("VibeForge v1.2.3");
    expect(releaseFrom({ message: "Not Found" })).toBeNull();
    expect(releaseFrom(null)).toBeNull();
  });

  it("reads the release's install.sh and the checksum GitHub lists for it", () => {
    const sha = "a".repeat(64);
    const asset = (name: string, digest?: string) => ({ name, browser_download_url: "https://evil.example/install.sh", ...(digest ? { digest } : {}) });
    const release = releaseFrom({ tag_name: "v2.16.0", assets: [asset("SHA256SUMS"), asset("install.sh", `sha256:${sha.toUpperCase()}`)] });
    // Made from the tag, whatever download address the answer gives.
    expect(release?.installer).toEqual({ url: "https://github.com/L0nE-F0x/VibeForge/releases/download/v2.16.0/install.sh", sha256: sha });
    expect(releaseFrom({ tag_name: "v2.13.0", assets: [asset("install.sh")] })?.installer?.sha256).toBeNull();
    expect(releaseFrom({ tag_name: "v2.13.0", assets: [asset("install.sh", "md5:abc")] })?.installer?.sha256).toBeNull();
    expect(releaseFrom({ tag_name: "v1.0.0", assets: [] })?.installer).toBeNull();
    expect(releaseFrom({ tag_name: "v1.0.0" })?.installer).toBeNull();
    // A tag that couldn't sit safely in a command line gets no installer.
    expect(releaseFrom({ tag_name: "v1.0.0;rm", assets: [asset("install.sh", `sha256:${sha}`)] })?.installer).toBeNull();
  });

  it("knows how this copy was installed", () => {
    const installer = "/home/me/.local/share/vibeforge-app";
    expect(installKind(installer, { installerHome: installer, marked: false, checkout: true })).toBe("installer");
    expect(installKind("/opt/elsewhere", { installerHome: installer, marked: true, checkout: true })).toBe("installer");
    // A ready-made build has the mark and no .git, wherever it was unpacked.
    expect(installKind("/opt/vibeforge", { installerHome: installer, marked: true, checkout: false })).toBe("installer");
    expect(installKind("/home/me/code/VibeForge", { installerHome: installer, marked: false, checkout: true })).toBe("checkout");
    expect(installKind("/usr/lib/vibeforge", { installerHome: installer, marked: false, checkout: false })).toBe("other");
  });

  it("builds the update command for each kind, quoting paths", () => {
    expect(INSTALL_URL).toBe("https://github.com/L0nE-F0x/VibeForge/releases/latest/download/install.sh");
    expect(updateCommand("installer", "/home/me/My Apps/vf")).toBe(`set -o pipefail; curl -fsSL ${INSTALL_URL} | VIBEFORGE_HOME='/home/me/My Apps/vf' bash`);
    expect(updateCommand("installer", "/home/me/My Apps/vf", undefined, null)).toContain(INSTALL_URL);
    // npm ci leaves package-lock.json alone, so the next git pull --ff-only still applies.
    expect(updateCommand("checkout", "/home/me/VibeForge")).toBe("cd /home/me/VibeForge && git pull --ff-only && npm ci --no-audit --no-fund && npm run build");
    expect(updateCommand("other", "/usr/lib/vibeforge")).toBeNull();
    expect(updateCommand("other", "/usr/lib/vibeforge", "yay -Syu vibeforge")).toBe("yay -Syu vibeforge");
  });

  it("fails the installer's update when the download or the install fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-update-"));
    const app = path.join(dir, "My App");
    const command = updateCommand("installer", app) as string;
    // A stand-in curl: CURL_SAYS is what it "downloads", CURL_EXIT how it ends.
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "curl"), '#!/bin/bash\nprintf %s "$CURL_SAYS"\nexit "$CURL_EXIT"\n', { mode: 0o755 });
    // The terminal runs it the way the service does: bash -c.
    const run = (says: string, exit = 0) =>
      spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, CURL_SAYS: says, CURL_EXIT: String(exit) },
      });

    const installed = run('echo "installing into $VIBEFORGE_HOME"\n');
    expect(installed.status).toBe(0);
    expect(installed.stdout).toBe(`installing into ${app}\n`);
    // No network: curl fails and sends nothing.
    expect(run("", 6).status).not.toBe(0);
    // Cut off part-way: the installer's main() never got its closing brace.
    expect(run('main() {\n  echo "half"\n', 18).status).not.toBe(0);
    // The installer itself failing.
    expect(run("exit 1\n").status).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the release's own installer only when it matches the checksum GitHub lists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-update-"));
    const app = path.join(dir, "My App");
    const script = 'echo "installing $VIBEFORGE_VERSION into $VIBEFORGE_HOME"\n';
    const sha = crypto.createHash("sha256").update(script).digest("hex");
    const at = (sha256: string | null): Release => ({
      version: "2.16.0",
      tag: "v2.16.0",
      name: "VibeForge 2.16.0",
      url: "",
      notes: "",
      publishedAt: null,
      installer: { url: "https://github.com/L0nE-F0x/VibeForge/releases/download/v2.16.0/install.sh", sha256 },
    });
    // A stand-in curl: writes CURL_SAYS to its -o file, after noting the address it was asked for.
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(
      path.join(dir, "bin", "curl"),
      '#!/bin/bash\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) echo "$1" >>"$CURL_LOG" ;; esac; shift; done\nprintf %s "$CURL_SAYS" >"$out"\nexit "$CURL_EXIT"\n',
      { mode: 0o755 },
    );
    const run = (release: Release, says: string, exit = 0) =>
      spawnSync("/bin/bash", ["-c", updateCommand("installer", app, undefined, release) as string], {
        encoding: "utf8",
        env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, CURL_SAYS: says, CURL_EXIT: String(exit), CURL_LOG: path.join(dir, "asked") },
      });

    const good = run(at(sha), script);
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toBe(`installing v2.16.0 into ${app}\n`);
    expect(fs.readFileSync(path.join(dir, "asked"), "utf8")).toBe("https://github.com/L0nE-F0x/VibeForge/releases/download/v2.16.0/install.sh\n");
    // Changed on the way: not run.
    const tampered = run(at(sha), 'echo "something else"\n');
    expect(tampered.status).toBe(1);
    expect(tampered.stdout).toBe("");
    expect(tampered.stderr).toContain("does not match the checksum GitHub lists for v2.16.0");
    // No network.
    expect(run(at(sha), "", 6).status).not.toBe(0);
    // A release from before GitHub listed checksums still installs its own tag.
    expect(run(at(null), script).stdout).toBe(`installing v2.16.0 into ${app}\n`);
    // The downloaded installer doesn't stay behind in /tmp.
    expect(updateCommand("installer", app, undefined, at(sha))).toContain(`trap 'rm -f "$f"' EXIT`);
    fs.rmSync(dir, { recursive: true, force: true });
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

  it("drops benign page notices and folds bursts of the same error", () => {
    const lines: string[] = [];
    let now = 0;
    const errors = new PageErrors((line) => lines.push(line), 10_000, () => now);
    for (let i = 0; i < 50; i++) errors.report("ResizeObserver loop completed with undelivered notifications. (index.html:0)");
    expect(lines).toEqual([]);
    for (let i = 0; i < 4; i++) {
      errors.report("boom (index.html:1)");
      now += 1000;
    }
    errors.report("other (index.html:2)");
    now += 60_000;
    errors.report("other (index.html:2)");
    errors.flush();
    expect(lines).toEqual(["boom (index.html:1)", "boom (index.html:1) (repeated 3 more times)", "other (index.html:2)", "other (index.html:2)"]);
  });

  it("describes errors on one line plus a few frames", () => {
    expect(describeError("plain")).toBe("plain");
    const text = describeError(new Error("broke"));
    expect(text.split("\n")[0]).toBe("broke");
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
  });
});
