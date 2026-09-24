import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedEngines } from "./store.js";
import type { Settings } from "./types.js";

export function defaultRoots(): { configRoot: string; dataRoot: string } {
  const home = os.homedir();
  return {
    configRoot: process.env.FORGEDESK_CONFIG || path.join(home, ".config", "forgedesk"),
    dataRoot: process.env.FORGEDESK_DATA || path.join(home, ".local", "share", "forgedesk"),
  };
}

export function ensureLayout(configRoot: string, dataRoot: string): void {
  fs.mkdirSync(path.join(configRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(configRoot, "skills"), { recursive: true });
  fs.mkdirSync(path.join(configRoot, "routines"), { recursive: true });
  fs.mkdirSync(path.join(configRoot, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "runs"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "scratch"), { recursive: true });
  const enginesPath = path.join(configRoot, "engines.json");
  if (!fs.existsSync(enginesPath)) {
    fs.writeFileSync(enginesPath, JSON.stringify({ engines: seedEngines() }, null, 2));
  }
  const settingsPath = path.join(configRoot, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    const settings: Settings = {
      defaultEngine: "grok",
      defaultShell: process.env.SHELL || "/bin/bash",
      notify: true,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
  const workspacesPath = path.join(configRoot, "workspaces.json");
  if (!fs.existsSync(workspacesPath)) {
    fs.writeFileSync(
      workspacesPath,
      JSON.stringify({ workspaces: [], lastWorkspaceId: null }, null, 2),
    );
  }
}

export const MEMORY_STARTER =
  "<!-- Preferences, decisions, constraints, and lessons that should still matter next week. Dated bullets. Not secrets. Not this run's instructions. -->\n";
