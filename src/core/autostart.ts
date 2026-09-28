import fs from "node:fs";
import path from "node:path";

// "Start at login, in the tray": a freedesktop autostart entry, the way Omarchy starts other
// tray apps. The file is the setting: present means on. It runs the same command as the app
// menu's entry, with --hidden so the window stays in the tray until you open it.

export const HIDDEN_ARG = "--hidden";

export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "vibeforge.desktop");
}

/** The command the app menu starts VibeForge with, from its desktop entry, else the usual launcher. */
export function launcherCommand(env: NodeJS.ProcessEnv, home: string, fallback: string): string {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  try {
    const entry = fs.readFileSync(path.join(dataHome, "applications", "vibeforge.desktop"), "utf8");
    const exec = /^Exec=(.+)$/m.exec(entry)?.[1]?.trim();
    if (exec) return exec.replace(/\s+%[fFuU]\b/g, "");
  } catch {
    /* no menu entry: a copy run from its folder */
  }
  const launcher = path.join(home, ".local", "bin", "vibeforge");
  return fs.existsSync(launcher) ? launcher : fallback;
}

export function autostartEntry(command: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=VibeForge",
    "Comment=Start VibeForge in the tray",
    `Exec=${command} ${HIDDEN_ARG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function readAutostart(file: string): boolean {
  try {
    const text = fs.readFileSync(file, "utf8");
    return !/^Hidden=true$/m.test(text) && !/^X-GNOME-Autostart-enabled=false$/m.test(text);
  } catch {
    return false;
  }
}

export function writeAutostart(file: string, on: boolean, command: string): void {
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartEntry(command));
}
