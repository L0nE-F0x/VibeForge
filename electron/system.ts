import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogFile } from "../src/core/log.js";
import { loadShellPath, mergePath } from "./shell-env.js";

// The desktop around VibeForge: what it's called in a bug report, the login shell's PATH, Omarchy's
// Do Not Disturb switch, and handing a file to the desktop's own app.

/** What describeOs reads; each read may throw on a system without that file. */
export interface OsFacts {
  osRelease: () => string;
  packages: () => string[];
  type: string;
  release: string;
}

/** "Omarchy 4.0.4-1 · Linux 7.2.5-3-omarchy" from pacman, os-release and the kernel, for bug reports. */
export function describeOs(facts: OsFacts): string {
  let name = facts.type;
  try {
    const release = facts.osRelease();
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    if (pretty) name = pretty;
  } catch {
    /* not every system has os-release */
  }
  try {
    // Omarchy ships as a pacman package (omarchy, or omarchy-dev on the edge channel).
    const entry = facts.packages().find((dir) => /^omarchy(-dev)?-\d/.test(dir));
    if (entry) name = `Omarchy ${entry.replace(/^omarchy(-dev)?-/, "")}`;
  } catch {
    /* not an Arch system */
  }
  return `${name} · ${facts.type} ${facts.release}`;
}

/** This machine, as describeOs puts it. */
export function osDescription(): string {
  return describeOs({
    osRelease: () => fs.readFileSync("/etc/os-release", "utf8"),
    packages: () => fs.readdirSync("/var/lib/pacman/local"),
    type: os.type(),
    release: os.release(),
  });
}

/** Puts the login shell's PATH ahead of Electron's, so CLIs installed through mise are found. */
export async function adoptShellPath(log: LogFile): Promise<void> {
  const shellPath = await loadShellPath();
  if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
  else log.warn(`Could not read PATH from the login shell (${process.env.SHELL || "/bin/bash"}); CLIs found only on that PATH will show as missing`);
}

/** Opens a file or folder in the desktop's app for it. */
export function openPath(target: string): void {
  const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** Omarchy's shell keeps its Do Not Disturb switch in this file. */
export function omarchyDoNotDisturb(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(state, "omarchy", "notifications.json"), "utf8")) as { dnd?: unknown };
    return parsed.dnd === true;
  } catch {
    return false;
  }
}
