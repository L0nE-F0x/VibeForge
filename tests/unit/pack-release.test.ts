import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchSyncthing, mark, parseSums, pinned, present, RELEASE_KEY, sourceNote, verifiedSums } from "../../scripts/fetch-syncthing.mjs";
import { APP_FILES, ENTRIES, LEFT_OUT, PACKAGES, provided, ships, specifiers } from "../../scripts/pack-release.mjs";

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
    // vendor/syncthing is fetched while packing, like dist is built: neither is in the repository.
    for (const file of APP_FILES.filter((item) => item !== "dist" && item !== "dist-electron" && item !== "vendor/syncthing")) {
      expect(fs.existsSync(path.join(repo, file.replace(/\/\*.*$/, ""))), file).toBe(true);
    }
    // Whole folders, so a module added to the phone page or the scripts ships with it.
    expect(shipped("companion/js/new-module.js")).toBe(true);
    expect(shipped("electron/pty-host.cjs")).toBe(true);
    expect(shipped("electron/main.ts")).toBe(false);
    // The Android widget is installed on its own: neither a built one nor its build script ships.
    expect(shipped("scripts/build-android-widget.sh")).toBe(false);
    expect(shipped("companion/vibeforge-widget.apk")).toBe(false);
    expect(shipped("scripts/talk.mjs")).toBe(true);
    expect(LEFT_OUT.every((file) => fs.existsSync(path.join(repo, file)))).toBe(true);
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
      for (const [, args] of read(path.join("electron", file)).matchAll(/path\.join\((?:[\w.]+\.)?appRoot(?:\(\))?,\s*((?:"[^"]+"\s*,?\s*)+)\)/g)) {
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

  it("extracts static, dynamic, re-export, and require specifiers via AST while ignoring comments and strings", () => {
    const sample = [
      "#!/usr/bin/env node",
      "// import 'fake-from-line-comment';",
      "/* export * from 'fake-block-comment'; require('fake-block-require'); */",
      "/** @import { Something } from './jsdoc-only.js' */",
      'const msg = "failed to read from \'fake-string-pkg\'";',
      'const msg2 = "/* fake */ require(\\"fake-in-string\\")";',
      'const obj = { require: (x) => x };',
      "obj.require('not-real-require');",
      'import a from "pkg-a";',
      'import "pkg-side";',
      'import {\n  x,\n  // inline comment\n  y,\n} from "pkg-multi";',
      'export * from "./all.js";',
      'export { z } from "@scope/pkg/sub";',
      'const loader = () => import("./dyn.mjs");',
      'const pty = require("node-pty");',
      'const xterm = require(`@xterm/headless`);',
      'import "node:fs";',
      "void a; void x; void y; void msg; void msg2; void loader; void pty; void xterm;",
    ].join("\n");
    expect(new Set(specifiers(sample))).toEqual(
      new Set(["pkg-a", "pkg-side", "pkg-multi", "./all.js", "@scope/pkg/sub", "./dyn.mjs", "node-pty", "@xterm/headless", "node:fs"]),
    );
  });

  it("ships what the installer checks for after unpacking", () => {
    const install = read("scripts/install.sh");
    const parts = /^REQUIRED_PARTS=\(([^)]+)\)/m.exec(install)?.[1].trim().split(/\s+/) ?? [];
    expect(parts.length).toBeGreaterThan(0);
    // It also loads node-pty from the unpacked copy to see that its addon works on this system.
    expect(install).toContain('"$STAGE/node_modules/node-pty"');
    parts.push("node_modules/node-pty/package.json", "node_modules/node-pty/lib/index.js");
    for (const part of parts) {
      const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(part);
      if (pkg) expect(PACKAGES[pkg[1]]?.some((item) => pkg[2] === item || pkg[2].startsWith(`${item}/`)), part).toBe(true);
      else expect(shipped(part), part).toBe(true);
    }
  });

  it("is packed and tried by one script, in CI's smoke job and in the release", () => {
    for (const workflow of ["ci.yml", "release.yml"]) {
      expect(read(path.join(".github", "workflows", workflow)), workflow).toMatch(/xvfb-run [^\n]*scripts\/build-release\.sh /);
    }
    expect(read("scripts/build-release.sh")).toContain("scripts/pack-release.mjs");
  });

  it("loads on a bare checkout with no node_modules in any parent folder", async () => {
    expect(specifiers(read("scripts/pack-release.mjs")).filter((spec) => !spec.startsWith("node:"))).toEqual([]);
    const os = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-bare-pack-"));
    try {
      fs.mkdirSync(path.join(bare, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(bare, "electron"), { recursive: true });
      fs.writeFileSync(path.join(bare, "electron", "pty-host.cjs"), "");
      fs.copyFileSync(path.join(repo, "scripts", "pack-release.mjs"), path.join(bare, "scripts", "pack-release.mjs"));
      const loaded = await import(pathToFileURL(path.join(bare, "scripts", "pack-release.mjs")).href);
      expect(typeof loaded.ships).toBe("function");
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("the Syncthing a copy of VibeForge carries", () => {
  const pin = pinned();

  it("is one pinned release, with a checksum for each CPU, never committed", () => {
    expect(pin.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pin.license).toBe("MPL-2.0");
    expect(pin.source).toBe(`https://github.com/syncthing/syncthing/tree/${pin.version}`);
    expect(Object.keys(pin.builds).sort()).toEqual(["arm64", "x64"]);
    for (const [arch, build] of Object.entries(pin.builds)) {
      expect(build.file).toBe(`syncthing-linux-${arch === "x64" ? "amd64" : arch}-${pin.version}.tar.gz`);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(read(".gitignore").split("\n")).toContain("vendor/");
    expect(RELEASE_KEY).toMatch(/^[0-9A-F]{40}$/);
  });

  it("ships in the ready-made build, with its license and where its source is", () => {
    expect(shipped("vendor/syncthing/syncthing")).toBe(true);
    expect(shipped("vendor/syncthing/LICENSE.txt")).toBe(true);
    expect(shipped("scripts/syncthing.json")).toBe(true);
    // Packed from the pin, by the same script a checkout uses.
    expect(read("scripts/pack-release.mjs")).toMatch(/fetch-syncthing\.mjs"\), "--to", path\.join\(build, "vendor", "syncthing"\)/);
    // And the main process runs that copy, never one found on PATH.
    expect(read("electron/sync.ts")).toContain('path.join(this.ctx.appRoot, "vendor", "syncthing", "syncthing")');
    expect(read("electron/sync.ts")).not.toMatch(/resolveBin|which\(/);
    const note = sourceNote(pin);
    expect(note).toContain(`Syncthing ${pin.version}`);
    expect(note).toContain(pin.source);
    expect(note).toContain("Mozilla Public License 2.0");
    expect(note).toContain("does not\nchange it");
  });

  it("is fetched for source builds by the installer, and before the tests in CI", () => {
    expect(read("scripts/install.sh")).toContain("scripts/fetch-syncthing.mjs");
    expect(read(path.join(".github", "workflows", "ci.yml"))).toContain("node scripts/fetch-syncthing.mjs");
  });

  it("reads a release's checksum list for the bump, and refuses one without both builds", () => {
    const list = ["-----BEGIN PGP SIGNED MESSAGE-----", "", `${"a".repeat(64)}  syncthing-linux-amd64-v9.9.9.tar.gz`, `${"b".repeat(64)}  syncthing-linux-arm64-v9.9.9.tar.gz`, `${"c".repeat(64)}  syncthing-macos-arm64-v9.9.9.zip`].join("\n");
    expect(parseSums(list, "v9.9.9")).toEqual({
      x64: { file: "syncthing-linux-amd64-v9.9.9.tar.gz", sha256: "a".repeat(64) },
      arm64: { file: "syncthing-linux-arm64-v9.9.9.tar.gz", sha256: "b".repeat(64) },
    });
    expect(() => parseSums(list, "v9.9.8")).toThrow(/no line for syncthing-linux-amd64-v9\.9\.8/);
  });

  it("knows a fetched copy by its mark, and fetches nothing when it is there", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "vibeforge-vendor-"));
    expect(present(dir, pin, "x64")).toBe(false);
    fs.writeFileSync(path.join(dir, "syncthing"), Buffer.alloc(1_100_000));
    fs.writeFileSync(path.join(dir, "PIN"), mark(pin, "x64"));
    expect(present(dir, pin, "x64")).toBe(true);
    // Another CPU's copy, or an older pin's, is not this one.
    expect(present(dir, pin, "arm64")).toBe(false);
    expect(present(dir, { ...pin, version: "v0.0.1" }, "x64")).toBe(false);
    expect(await fetchSyncthing({ dir, arch: "x64" })).toBe("present");
    await expect(fetchSyncthing({ dir, arch: "riscv64" })).rejects.toThrow(/not pinned for riscv64/);
  });

  it("extracts only the gpg-verified body from a clearsigned checksum file and rejects wrong keys", async () => {
    const { execFileSync } = await import("node:child_process");
    const os = await import("node:os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-gpg-test-"));
    fs.chmodSync(home, 0o700);
    const batch = path.join(home, "gen.batch");
    fs.writeFileSync(batch, "%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nName-Real: Test Signer\nName-Email: test@example.com\n%commit\n");
    execFileSync("gpg", ["--homedir", home, "--batch", "--gen-key", batch], { stdio: "pipe" });
    const fpr = execFileSync("gpg", ["--homedir", home, "--batch", "--with-colons", "--list-keys"], { stdio: "pipe" })
      .toString("utf8")
      .split("\n")
      .find((line) => line.startsWith("fpr:"))!
      .split(":")[9];
    const pubKey = execFileSync("gpg", ["--homedir", home, "--batch", "--armor", "--export"], { stdio: "pipe" });
    const realBody = `${"a".repeat(64)}  syncthing-linux-amd64-v9.9.9.tar.gz\n${"b".repeat(64)}  syncthing-linux-arm64-v9.9.9.tar.gz\n`;
    const bodyFile = path.join(home, "body.txt");
    fs.writeFileSync(bodyFile, realBody);
    const signed = execFileSync("gpg", ["--homedir", home, "--batch", "--clearsign", "--output", "-", bodyFile], { stdio: "pipe" }).toString("utf8");
    const smuggled = [
      `${"f".repeat(64)}  syncthing-linux-amd64-v9.9.9.tar.gz`,
      signed,
      `${"e".repeat(64)}  syncthing-linux-arm64-v9.9.9.tar.gz`,
    ].join("\n");

    const verified = verifiedSums(Buffer.from(smuggled, "utf8"), pubKey, fpr);
    expect(parseSums(verified, "v9.9.9")).toEqual({
      x64: { file: "syncthing-linux-amd64-v9.9.9.tar.gz", sha256: "a".repeat(64) },
      arm64: { file: "syncthing-linux-arm64-v9.9.9.tar.gz", sha256: "b".repeat(64) },
    });
    expect(() => verifiedSums(Buffer.from(smuggled, "utf8"), pubKey, RELEASE_KEY)).toThrow(/not signed/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

