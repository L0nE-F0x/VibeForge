import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseGuiSocket } from "../../electron/sync-engine.js";
import { fallbackSocketDir } from "../../src/core/control.js";

describe("Syncthing GUI socket selection", () => {
  it("uses gui.sock inside Syncthing's home when the path fits unix socket limits", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-st-short-"));
    const home = path.join(tmp, "st");
    expect(chooseGuiSocket(home, {}, process.getuid?.() ?? 1000, tmp)).toEqual({
      socketPath: path.join(home, "gui.sock"),
      external: false,
    });
  });

  it("uses a short hashed socket in XDG_RUNTIME_DIR when home is too deep", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-st-long-"));
    const runtimeDir = path.join(tmp, "rt");
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    const home = path.join(tmp, "a".repeat(120), "sync");
    const chosen = chooseGuiSocket(home, { XDG_RUNTIME_DIR: runtimeDir }, process.getuid?.() ?? 1000, tmp);
    expect(chosen.external).toBe(true);
    expect(path.dirname(chosen.socketPath)).toBe(runtimeDir);
    expect(path.basename(chosen.socketPath)).toMatch(/^vf-st-[0-9a-f]{12}\.sock$/);
    expect(Buffer.byteLength(chosen.socketPath)).toBeLessThanOrEqual(107);
  });

  it("falls back to the private 0700 /tmp socket folder when XDG_RUNTIME_DIR is missing or too open", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-st-fb-"));
    const openRuntime = path.join(tmp, "open-rt");
    fs.mkdirSync(openRuntime, { mode: 0o755 });
    const uid = process.getuid?.() ?? 1000;
    const home = path.join(tmp, "b".repeat(120), "sync");
    const chosen = chooseGuiSocket(home, { XDG_RUNTIME_DIR: openRuntime }, uid, tmp);
    expect(chosen.external).toBe(true);
    expect(path.dirname(chosen.socketPath)).toBe(fallbackSocketDir(uid, tmp));
    expect(fs.statSync(path.dirname(chosen.socketPath)).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(chosen.socketPath)).toBeLessThanOrEqual(107);
  });
});
