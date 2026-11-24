import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Roots {
  configRoot: string;
  dataRoot: string;
}

export function defaultRoots(env: NodeJS.ProcessEnv = process.env): Roots {
  const home = os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return {
    configRoot: env.VIBEFORGE_CONFIG || path.join(configHome, "vibeforge"),
    dataRoot: env.VIBEFORGE_DATA || path.join(dataHome, "vibeforge"),
  };
}

/** Create every directory the app owns and keep its permissions owner-only. */
export function ensureLayout(configRoot: string, dataRoot: string): void {
  const dirs = [
    configRoot,
    dataRoot,
    ...["agents", "skills", "routines", "tasks", "layouts"].map((dir) => path.join(configRoot, dir)),
    ...["runs", "scratch", "logs"].map((dir) => path.join(dataRoot, dir)),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}
