import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv, loadShellPath, mergePath, parseShellPath } from "../../electron/shell-env.js";

const M = "__VIBEFORGE_PATH__";

function fakeShell(body: string, interpreter = "/bin/sh"): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-shell-")), "fakesh");
  fs.writeFileSync(file, `#!${interpreter}\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("login-shell PATH", () => {
  it("reads the PATH between the markers and drops what isn't a directory path", () => {
    expect(parseShellPath(`Welcome!\n${M}/a/bin:/usr/bin\n${M}`)).toBe("/a/bin:/usr/bin");
    expect(parseShellPath(`${M}/a/bin::relative:~/bin:/usr/bin${M}`)).toBe("/a/bin:/usr/bin");
    expect(parseShellPath(`${M}fish: Unknown command${M}`)).toBeNull();
    expect(parseShellPath("no markers at all")).toBeNull();
  });

  it("keeps mise's entries when a probe returned something odd", () => {
    const merged = mergePath(parseShellPath(`${M}/usr/bin /home/me/bin${M}`), "/home/me/.local/share/mise/shims:/usr/bin");
    expect(merged.split(":")).toEqual(["/usr/bin /home/me/bin", "/home/me/.local/share/mise/shims", "/usr/bin"]);
  });

  it("asks the shell for the exported PATH and gives up quietly on a slow one", async () => {
    const shell = fakeShell(`eval "$2"`);
    expect(await loadShellPath(4000, shell)).toBe(parseShellPath(`${M}${process.env.PATH}${M}`));
    expect(await loadShellPath(200, fakeShell("sleep 5"))).toBeNull();
  });

  it("holds its cap against a shell that ignores SIGTERM or waits on stdin", async () => {
    // An interactive bash ignores SIGTERM; a profile can `read` from a terminal that isn't there.
    const stubborn = fakeShell(`trap '' TERM\nsleep 9`, "/bin/bash");
    let started = Date.now();
    expect(await loadShellPath(300, stubborn)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2500);
    const reader = fakeShell(`read -r line\neval "$2"`, "/bin/bash");
    started = Date.now();
    // stdin is closed, so the read ends at once and the PATH still comes back.
    expect(await loadShellPath(4000, reader)).toBe(parseShellPath(`${M}${process.env.PATH}${M}`));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(await loadShellPath(300, "/no/such/shell")).toBeNull();
  });
});

describe("the terminals' environment", () => {
  it("keeps the user's variables and drops Electron's, Vite's and VibeForge's debug switches", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      VIBEFORGE_DATA: "/data",
      VIBEFORGE_DEBUG: "1",
      VIBEFORGE_DEBUG_PORT: "9223",
      ELECTRON_RUN_AS_NODE: "1",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      CHROME_DESKTOP: "vibeforge.desktop",
      VIBEFORGE_ENV_PROBE: "1",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me", VIBEFORGE_DATA: "/data" });
  });
});
