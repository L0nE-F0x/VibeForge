import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autostartFile, launcherCommand, readAutostart, writeAutostart } from "../../src/core/autostart.js";

const homes: string[] = [];
const scratchHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vf-autostart-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("autostart", () => {
  it("writes an entry that starts the menu's command hidden, and removes it again", () => {
    const home = scratchHome();
    fs.mkdirSync(path.join(home, ".local", "share", "applications"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "share", "applications", "vibeforge.desktop"), "[Desktop Entry]\nExec=/home/me/.local/bin/vibeforge %U\n");
    const file = autostartFile({}, home);
    expect(file).toBe(path.join(home, ".config", "autostart", "vibeforge.desktop"));
    expect(readAutostart(file)).toBe(false);

    writeAutostart(file, true, launcherCommand({}, home, "/opt/electron ."));
    expect(fs.readFileSync(file, "utf8")).toContain("Exec=/home/me/.local/bin/vibeforge --hidden\n");
    expect(readAutostart(file)).toBe(true);

    writeAutostart(file, false, "");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("follows XDG_CONFIG_HOME, falls back to the launcher, and honours an entry switched off elsewhere", () => {
    const home = scratchHome();
    expect(autostartFile({ XDG_CONFIG_HOME: "/x/config" }, home)).toBe("/x/config/autostart/vibeforge.desktop");
    expect(launcherCommand({}, home, "/opt/electron /app")).toBe("/opt/electron /app");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "bin", "vibeforge"), "");
    expect(launcherCommand({}, home, "/opt/electron /app")).toBe(path.join(home, ".local", "bin", "vibeforge"));

    const file = autostartFile({}, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[Desktop Entry]\nExec=vibeforge --hidden\nHidden=true\n");
    expect(readAutostart(file)).toBe(false);
  });
});
