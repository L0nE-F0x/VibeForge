import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeOs, omarchyDoNotDisturb } from "../../electron/system.js";

const missing = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

describe("the machine, for bug reports", () => {
  it("names Omarchy by its pacman package, edge channel included", () => {
    const osRelease = () => 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\n';
    expect(describeOs({ osRelease, packages: () => ["bash-5.2-1", "omarchy-4.0.4-1"], type: "Linux", release: "7.2.5-3-omarchy" })).toBe("Omarchy 4.0.4-1 · Linux 7.2.5-3-omarchy");
    expect(describeOs({ osRelease, packages: () => ["omarchy-dev-4.1.0-2"], type: "Linux", release: "7.2.5" })).toBe("Omarchy 4.1.0-2 · Linux 7.2.5");
  });

  it("falls back to os-release, then to the kernel's own name", () => {
    expect(describeOs({ osRelease: () => "PRETTY_NAME=Fedora Linux 43\n", packages: missing, type: "Linux", release: "6.9" })).toBe("Fedora Linux 43 · Linux 6.9");
    expect(describeOs({ osRelease: missing, packages: () => ["omarchy-themes-1.0"], type: "Linux", release: "6.9" })).toBe("Linux · Linux 6.9");
  });
});

describe("Omarchy's Do Not Disturb", () => {
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function state(text: string | null): NodeJS.ProcessEnv {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-dnd-"));
    if (text !== null) {
      fs.mkdirSync(path.join(dir, "omarchy"));
      fs.writeFileSync(path.join(dir, "omarchy", "notifications.json"), text);
    }
    return { XDG_STATE_HOME: dir };
  }

  it("reads the switch from the shell's state file", () => {
    expect(omarchyDoNotDisturb(state('{"dnd":true}'))).toBe(true);
    expect(omarchyDoNotDisturb(state('{"dnd":false}'))).toBe(false);
    expect(omarchyDoNotDisturb(state('{"dnd":"yes"}'))).toBe(false);
  });

  it("is off without the file or with a broken one", () => {
    expect(omarchyDoNotDisturb(state(null))).toBe(false);
    expect(omarchyDoNotDisturb(state("{nope"))).toBe(false);
  });

  it("looks under ~/.local/state when XDG_STATE_HOME is unset", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-dnd-"));
    fs.mkdirSync(path.join(dir, ".local", "state", "omarchy"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".local", "state", "omarchy", "notifications.json"), '{"dnd":true}');
    expect(omarchyDoNotDisturb({}, dir)).toBe(true);
  });
});
