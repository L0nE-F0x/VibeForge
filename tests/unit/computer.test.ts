import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeComputer } from "../../electron/computer.js";
import type { Engine } from "../../src/core/types.js";
import { COMPUTER_PARTS, computerText, desktopName, installLine, packageManagerOf, parseVersion } from "../../src/shared/computer.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A folder of empty executables, standing in for what is installed. */
function binDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-computer-"));
  made.push(dir);
  for (const name of names) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

describe("This computer", () => {
  it("reads the first version number a program prints", () => {
    expect(parseVersion("git version 2.47.1\n")).toBe("2.47.1");
    expect(parseVersion("v26.13.1")).toBe("26.13.1");
    expect(parseVersion("2.1.4 (Claude Code)")).toBe("2.1.4");
    expect(parseVersion("1.94.2\n  tailscale commit: abc")).toBe("1.94.2");
    expect(parseVersion("codex-cli 0.63.0-alpha.1")).toBe("0.63.0-alpha.1");
    expect(parseVersion("no version here")).toBeNull();
  });

  it("names the desktop from the session", () => {
    expect(desktopName({ HYPRLAND_INSTANCE_SIGNATURE: "x", XDG_CURRENT_DESKTOP: "Hyprland" })).toBe("Hyprland");
    expect(desktopName({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe("ubuntu");
    expect(desktopName({ XDG_SESSION_DESKTOP: "KDE" })).toBe("KDE");
    expect(desktopName({})).toBeNull();
  });

  it("finds the package manager the way the installer does", () => {
    expect(packageManagerOf((bin) => bin === "pacman" || bin === "apt-get")).toBe("pacman");
    expect(packageManagerOf((bin) => bin === "apt-get")).toBe("apt");
    expect(packageManagerOf((bin) => bin === "dnf")).toBe("dnf");
    expect(packageManagerOf((bin) => bin === "zypper")).toBe("zypper");
    expect(packageManagerOf(() => false)).toBeNull();
  });

  it("offers an install line only where there is one", () => {
    expect(installLine("git", "apt")).toBe("sudo apt-get install -y git");
    expect(installLine("git", "dnf")).toBe("sudo dnf install -y git");
    expect(installLine("git", "zypper")).toBe("sudo zypper install -y git");
    expect(installLine("git", "pacman")).toBe("sudo pacman -S --needed git");
    expect(installLine("git", null)).toBeNull();
    expect(installLine("node", null)).toBe("mise use -g node@lts");
    expect(installLine("speech", "pacman")).toBe("sudo pacman -S whisper-cpp");
    expect(installLine("speech", "apt")).toBeNull();
    expect(installLine("piper", "dnf")).toBe("uv tool install piper-tts");
    expect(installLine("pipewire", "pacman")).toBe("sudo pacman -S --needed pipewire");
    expect(installLine("pipewire", "apt")).toBeNull();
    expect(installLine("tailscale", "pacman")).toBe("sudo pacman -S tailscale");
    expect(installLine("tailscale", "apt")).toBe("curl -fsSL https://tailscale.com/install.sh | sh");
    for (const part of ["syncthing", "tray", "desktop"] as const) expect(installLine(part, "pacman")).toBeNull();
  });

  it("looks for each part, asks each found program its version, and lists them for diagnostics", async () => {
    const bins = binDir(["git", "node", "pw-record", "pacman", "claude"]);
    const syncthing = path.join(bins, "syncthing-here");
    fs.writeFileSync(syncthing, "");
    const asked: string[] = [];
    const engines: Engine[] = [
      { id: "claude", label: "Claude Code", bin: "claude", args: [], available: true, path: path.join(bins, "claude") },
      { id: "codex", label: "Codex", bin: "codex", args: [], available: false, path: null },
    ];
    const facts = await probeComputer({
      engines,
      voice: { server: null, cli: null, sherpa: "/opt/sherpa/sherpa-onnx-offline", piper: null, recorder: "pw-record" },
      trayHost: false,
      syncthing: { path: syncthing, version: "v2.0.10" },
      env: { PATH: bins, XDG_CURRENT_DESKTOP: "GNOME" },
      run: async (bin, args) => {
        asked.push(`${path.basename(bin)} ${args.join(" ")}`);
        return path.basename(bin) === "git" ? "git version 2.47.1" : path.basename(bin) === "claude" ? "2.1.4 (Claude Code)" : "v26.13.1";
      },
    });
    expect(facts.packageManager).toBe("pacman");
    expect(facts.clis).toEqual([{ id: "cli:claude", name: "Claude Code", found: true, version: "2.1.4", path: path.join(bins, "claude") }]);
    expect(facts.parts.map((item) => item.id)).toEqual([...COMPUTER_PARTS]);
    const part = (id: string) => facts.parts.find((item) => item.id === id)!;
    expect(part("git")).toMatchObject({ found: true, version: "2.47.1" });
    expect(part("node")).toMatchObject({ found: true, version: "26.13.1" });
    expect(part("speech")).toMatchObject({ found: true, name: "sherpa-onnx" });
    expect(part("piper").found).toBe(false);
    expect(part("pipewire").found).toBe(true);
    expect(part("tailscale").found).toBe(false);
    expect(part("syncthing")).toMatchObject({ found: true, version: "v2.0.10" });
    expect(part("tray").found).toBe(false);
    expect(part("desktop")).toMatchObject({ found: true, name: "GNOME" });
    // Only programs that are here are run, and none twice.
    expect(asked.sort()).toEqual(["claude --version", "git --version", "node --version"]);

    const text = computerText(facts).join("\n");
    expect(text).toContain("This computer (package manager: pacman):");
    expect(text).toContain("  Claude Code: 2.1.4 · ");
    expect(text).toContain("  Piper: not found");
    expect(text).toContain("  Tray host: not found");
    expect(computerText({ ...facts, clis: [], packageManager: null }).slice(0, 2)).toEqual(["This computer (package manager: unknown):", "  No coding CLI on PATH"]);
  });

  it("prefers whisper.cpp when both speech engines are here, and says when a version can't be read", async () => {
    const bins = binDir(["tailscale"]);
    const facts = await probeComputer({
      engines: [],
      voice: { server: "/usr/bin/whisper-server", cli: null, sherpa: "/opt/sherpa", piper: "/home/me/.local/bin/piper", recorder: null },
      trayHost: true,
      syncthing: { path: path.join(bins, "nothing-here"), version: "v2.0.10" },
      env: { PATH: bins, VIBEFORGE_NODE: "/opt/node/bin/node", HYPRLAND_INSTANCE_SIGNATURE: "abc" },
      run: async () => "",
    });
    const part = (id: string) => facts.parts.find((item) => item.id === id)!;
    expect(part("speech")).toMatchObject({ found: true, name: "whisper.cpp", path: "/usr/bin/whisper-server" });
    expect(part("node")).toMatchObject({ found: true, path: "/opt/node/bin/node", version: null });
    expect(part("tailscale")).toMatchObject({ found: true, version: null });
    expect(part("syncthing")).toMatchObject({ found: false, version: null });
    expect(part("tray").found).toBe(true);
    expect(part("desktop").name).toBe("Hyprland");
    expect(facts.packageManager).toBeNull();
  });
});
