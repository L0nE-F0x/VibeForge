import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { controlSocketPath, fallbackSocketDir, prepareSocketDir } from "../../src/core/control.js";

const uid = process.getuid?.() ?? 0;
const data = "/home/me/.local/share/vibeforge";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sock-"));
}

const mode = (dir: string) => fs.statSync(dir).mode & 0o777;

/**
 * scripts/vibeforge's control_sock(), run in bash. With `tmp`, its /tmp is swapped for that folder
 * so the test never makes anything in the real /tmp.
 */
function controlSock(env: { runtime?: string; tmp?: string }): { out: string; err: string; status: number | null } {
  const script = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", "vibeforge"), "utf8");
  let fn = /^control_sock\(\) \{\n[\s\S]*?^\}\n/m.exec(script)?.[0] ?? "";
  expect(fn).toContain('dir="/tmp/vibeforge-$(id -u)"');
  if (env.tmp) fn = fn.replace('dir="/tmp/vibeforge-', `dir="${env.tmp}/vibeforge-`);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\ncontrol_sock`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/home/me", VIBEFORGE_DATA: data, ...(env.runtime ? { XDG_RUNTIME_DIR: env.runtime } : {}) },
  });
  return { out: result.stdout.trim(), err: result.stderr.trim(), status: result.status };
}

describe("the control socket's path", () => {
  it("sits in the runtime folder, or else in a private folder in /tmp, the same in TypeScript and bash", () => {
    expect(controlSocketPath(data, "/run/user/1000", 1000)).toMatch(/^\/run\/user\/1000\/vibeforge-[0-9a-f]{8}\.sock$/);
    expect(controlSocketPath(data, undefined, 42)).toMatch(/^\/tmp\/vibeforge-42\/vibeforge-[0-9a-f]{8}\.sock$/);
    expect(path.dirname(controlSocketPath(data, "", 42))).toBe(fallbackSocketDir(42));

    const runtime = tempDir();
    expect(controlSock({ runtime })).toEqual({ out: controlSocketPath(data, runtime, uid), err: "", status: 0 });
    const tmp = tempDir();
    expect(controlSock({ tmp }).out).toBe(controlSocketPath(data, undefined, uid, tmp));
    expect(mode(fallbackSocketDir(uid, tmp))).toBe(0o700);
  });

  it("makes the /tmp folder private, and closes up one of its own that was left open", () => {
    const tmp = tempDir();
    const socket = controlSocketPath(data, undefined, uid, tmp);
    expect(prepareSocketDir(socket, uid, tmp)).toBe(true);
    expect(mode(path.dirname(socket))).toBe(0o700);
    fs.chmodSync(path.dirname(socket), 0o755);
    expect(prepareSocketDir(socket, uid, tmp)).toBe(true);
    expect(mode(path.dirname(socket))).toBe(0o700);

    const shared = tempDir();
    fs.mkdirSync(fallbackSocketDir(uid, shared), { mode: 0o777 });
    fs.chmodSync(fallbackSocketDir(uid, shared), 0o777);
    expect(controlSock({ tmp: shared }).out).toBe(controlSocketPath(data, undefined, uid, shared));
    expect(mode(fallbackSocketDir(uid, shared))).toBe(0o700);
  });

  it("won't use a /tmp folder that someone else made, or a link or file in its place", () => {
    // Someone else's folder: the same check, seen as a user it doesn't belong to.
    const tmp = tempDir();
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid + 1, tmp), uid + 1, tmp)).toBe(false);

    const linked = tempDir();
    fs.symlinkSync(tempDir(), fallbackSocketDir(uid, linked));
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid, linked), uid, linked)).toBe(false);
    expect(controlSock({ tmp: linked })).toMatchObject({ out: "", status: 0 });
    expect(controlSock({ tmp: linked }).err).toContain("isn't yours");

    const file = tempDir();
    fs.writeFileSync(fallbackSocketDir(uid, file), "");
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid, file), uid, file)).toBe(false);
    expect(controlSock({ tmp: file }).out).toBe("");
  });

  it("leaves a runtime folder alone", () => {
    const runtime = tempDir();
    fs.chmodSync(runtime, 0o755);
    expect(prepareSocketDir(controlSocketPath(data, runtime, uid), uid)).toBe(true);
    expect(mode(runtime)).toBe(0o755);
  });
});
