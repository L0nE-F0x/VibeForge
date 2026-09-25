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

/** Create every directory the app owns. Seed files are written by the store on first read. */
export function ensureLayout(configRoot: string, dataRoot: string): void {
  for (const dir of ["agents", "skills", "routines", "tasks", "layouts"]) {
    fs.mkdirSync(path.join(configRoot, dir), { recursive: true });
  }
  for (const dir of ["runs", "scratch"]) {
    fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }
}
