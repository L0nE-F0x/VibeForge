import type { RunMetaFile } from "./runfiles.js";

export interface RunDb {
  prepare(sql: string): { run(args: Record<string, unknown>): unknown };
  exec(sql: string): void;
}

export function openRunIndex(dataRoot: string): RunDb | null;
export function mirrorRun(db: RunDb | null, meta: RunMetaFile | null): void;
