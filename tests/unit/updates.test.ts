import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeError, LogFile, PageErrors } from "../../src/core/log.js";
import crypto from "node:crypto";
import {
  INSTALL_URL,
  INSTALLER_MARK,
  installKind,
  installRoot,
  inVersions,
  isNewer,
  parseVersion,
  previousVersion,
  relaunchOptions,
  releaseFrom,
  releaseListUrl,
  releasesBetween,
  restartVia,
  rollbackCommand,
  updateCommand,
  type Release,
} from "../../src/core/updates.js";
import { headline } from "../../src/ui/notes.js";

describe("updates", () => {
  it("compares versions numerically, with or without a leading v", () => {
    expect(parseVersion("v0.3.0")).toEqual([0, 3, 0]);
    expect(parseVersion("banana")).toBeNull();
    expect(isNewer("0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.2.9", "0.3.0")).toBe(false);
    expect(isNewer("nightly", "0.3.0")).toBe(false);
    expect(isNewer("3.2.0", "3.2.0-rc.1")).toBe(true);
    expect(isNewer("3.2.0-rc.1", "3.2.0")).toBe(false);
    expect(isNewer("3.2.0-rc.2", "3.2.0-rc.1")).toBe(true);
    expect(isNewer("3.2.0-beta.1", "3.2.0-alpha.9")).toBe(true);
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

  it("builds the update command for each kind, quoting paths, and refuses installer updates without a digest", () => {
    expect(INSTALL_URL).toBe("https://github.com/L0nE-F0x/VibeForge/releases/latest/download/install.sh");
    expect(updateCommand("installer", "/home/me/My Apps/vf")).toBeNull();
    expect(updateCommand("installer", "/home/me/My Apps/vf", undefined, null)).toBeNull();
    expect(
      updateCommand("installer", "/home/me/My Apps/vf", undefined, {
        version: "2.16.0",
        tag: "v2.16.0",
        name: "VibeForge 2.16.0",
        url: "",
        notes: "",
        publishedAt: null,
        installer: { url: "https://github.com/L0nE-F0x/VibeForge/releases/download/v2.16.0/install.sh", sha256: null },
      }),
    ).toBeNull();
    // npm ci leaves package-lock.json alone, so the next git pull --ff-only still applies.
    expect(updateCommand("checkout", "/home/me/VibeForge")).toBe("cd /home/me/VibeForge && git pull --ff-only && npm ci --no-audit --no-fund && npm run build");
    expect(updateCommand("other", "/usr/lib/vibeforge")).toBeNull();
    expect(updateCommand("other", "/usr/lib/vibeforge", "yay -Syu vibeforge")).toBe("yay -Syu vibeforge");
  });

  it("runs the release's own installer only when it has a matching SHA-256 digest and restricts curl to https", () => {
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
    const command = updateCommand("installer", app, undefined, at(sha));
    expect(command).toContain("--proto =https --proto-redir =https");
    expect(command).toContain("sha256sum --check --status");
    expect(updateCommand("installer", app, undefined, at(null))).toBeNull();

    // A stand-in curl: writes CURL_SAYS to its -o file, after noting the address it was asked for.
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(
      path.join(dir, "bin", "curl"),
      '#!/bin/bash\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) echo "$1" >>"$CURL_LOG" ;; esac; shift; done\nprintf %s "$CURL_SAYS" >"$out"\nexit "$CURL_EXIT"\n',
      { mode: 0o755 },
    );
    const run = (says: string, exit = 0) =>
      spawnSync("/bin/bash", ["-c", command as string], {
        encoding: "utf8",
        env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, CURL_SAYS: says, CURL_EXIT: String(exit), CURL_LOG: path.join(dir, "asked") },
      });

    const good = run(script);
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toBe(`installing v2.16.0 into ${app}\n`);
    expect(fs.readFileSync(path.join(dir, "asked"), "utf8")).toBe("https://github.com/L0nE-F0x/VibeForge/releases/download/v2.16.0/install.sh\n");
    // Changed on the way: not run.
    const tampered = run('echo "something else"\n');
    expect(tampered.status).toBe(1);
    expect(tampered.stdout).toBe("");
    expect(tampered.stderr).toContain("does not match the checksum GitHub lists for v2.16.0");
    // No network or partial download.
    expect(run("", 6).status).not.toBe(0);
    expect(run('main() {\n  echo "half"\n', 18).status).not.toBe(0);
    expect(run(`${script}exit 1\n`).status).not.toBe(0);
    // The downloaded installer doesn't stay behind in /tmp.
    expect(command).toContain(`trap 'rm -f "$f"' EXIT`);
    // A version in the installer's versions/ updates the install folder above it, never itself.
    const versioned = updateCommand("installer", path.join(app, "versions", "3.8.0"), undefined, at(sha));
    const inside = spawnSync("/bin/bash", ["-c", versioned as string], {
      encoding: "utf8",
      env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, CURL_SAYS: script, CURL_EXIT: "0", CURL_LOG: path.join(dir, "asked") },
    });
    expect(inside.stdout).toBe(`installing v2.16.0 into ${app}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("versioned installs", () => {
  const root = "/home/me/.local/share/vibeforge-app";
  const version = `${root}/versions/3.8.0`;

  it("tells a version in versions/ from a copy that is its own folder", () => {
    expect(installRoot(version)).toBe(root);
    expect(installRoot(`${version}/`)).toBe(root);
    expect(inVersions(version)).toBe(true);
    // An install from before versions/, and a checkout.
    expect(installRoot(root)).toBe(root);
    expect(inVersions(root)).toBe(false);
    expect(inVersions("/home/me/code/VibeForge")).toBe(false);
  });

  it("reads the version Go back returns to from the install folder's previous link", () => {
    const files: Record<string, string> = { [`${root}/previous/package.json`]: JSON.stringify({ name: "vibeforge", version: "3.7.2" }) };
    const read = (file: string) => files[file] ?? null;
    expect(previousVersion(version, read)).toBe("3.7.2");
    expect(previousVersion(root, read)).toBeNull();
    expect(previousVersion(version, () => null)).toBeNull();
    expect(previousVersion(version, () => "not json")).toBeNull();
    expect(previousVersion(version, () => JSON.stringify({ version: "banana" }))).toBeNull();
  });

  it("goes back with the running version's own installer, for installer copies in versions/ only", () => {
    expect(rollbackCommand("installer", version)).toBe(`VIBEFORGE_HOME=${root} bash ${version}/scripts/install.sh --rollback`);
    expect(rollbackCommand("installer", "/home/me/My Apps/vf/versions/1.0.0")).toBe("VIBEFORGE_HOME='/home/me/My Apps/vf' bash '/home/me/My Apps/vf/versions/1.0.0/scripts/install.sh' --rollback");
    expect(rollbackCommand("installer", root)).toBeNull();
    expect(rollbackCommand("checkout", version)).toBeNull();
    expect(rollbackCommand("other", version)).toBeNull();
  });

  it("restarts an installer copy through the current launcher, and falls back otherwise", () => {
    const launcher = `${root}/current/scripts/vibeforge`;
    const mark = `${root}/${INSTALLER_MARK}`;
    const there = (file: string) => file === launcher;
    const markedRoot = (file: string) => file === launcher || file === mark;
    expect(restartVia(version, [version, "--class=vibeforge", "--enable-wayland-ime", "--voice", "start"], there)).toEqual({ execPath: launcher, args: ["--voice", "start"] });
    expect(restartVia(version, [`${version}/`], there)).toEqual({ execPath: launcher, args: [] });
    expect(restartVia(root, [root, "--class=vibeforge"], markedRoot)).toEqual({ execPath: launcher, args: [] });
    expect(relaunchOptions(version, "/usr/bin/electron", [version, "--hidden"], there)).toEqual({ execPath: launcher, args: ["--hidden"] });
    // Unmarked checkout or missing launcher: restart as it started.
    expect(restartVia(root, [root], there)).toBeNull();
    expect(restartVia(version, [version], () => false)).toBeNull();
    expect(relaunchOptions("/home/me/code/VibeForge", "/usr/bin/electron", ["/home/me/code/VibeForge"], () => false)).toEqual({
      execPath: "/usr/bin/electron",
      args: ["/home/me/code/VibeForge"],
    });
  });

  it("lists the releases between this version and the newest, newest first, without drafts or pre-releases", () => {
    expect(releaseListUrl("https://api.github.com/repos/x/y/releases/latest")).toBe("https://api.github.com/repos/x/y/releases?per_page=50");
    expect(releaseListUrl("http://127.0.0.1:9/fake")).toBeNull();
    const list = ["v3.8.0", "v3.7.2", "v3.7.1", "v3.7.0", "v3.6.2", "v3.9.0-rc.1"].map((tag) => ({ tag_name: tag, body: `**${tag} changed.** More.`, prerelease: tag.includes("-") }));
    list.push({ tag_name: "v3.7.3", body: "", prerelease: false, draft: true } as never);
    expect(releasesBetween(list, "3.7.0", "3.8.0").map((release) => release.version)).toEqual(["3.7.2", "3.7.1"]);
    expect(releasesBetween(list, "3.7.2", "3.8.0")).toEqual([]);
    expect(releasesBetween({ message: "rate limited" }, "3.7.0", "3.8.0")).toEqual([]);
    expect(releasesBetween([null, 4, { tag_name: "nope" }], "3.7.0", "3.8.0")).toEqual([]);
  });

  it("finds what a release's notes lead with", () => {
    expect(headline("**Updates download only what changed.** Electron stays.")).toBe("Updates download only what changed.");
    expect(headline("- **Two\nlines** after")).toBe("Two lines");
    expect(headline("\n\n## Fixed\n- a thing")).toBe("Fixed");
    expect(headline("")).toBe("");
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
