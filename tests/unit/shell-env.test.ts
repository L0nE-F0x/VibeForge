import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadShellPath, mergePath, parseShellPath } from "../../electron/shell-env.js";

const M = "__VIBEFORGE_PATH__";

function fakeShell(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-shell-")), "fakesh");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
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
});
