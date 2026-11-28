import type { RoutineRunResult, RunStatus } from "../core/types.js";

const LEGACY_CUTOFF_ERRORS = [
  "VibeForge closed while this run was going.",
  "Stopped when VibeForge quit.",
  "The terminal host stopped,",
];

/** Whether a run was cut off (VibeForge closed, quit, or lost the terminal host while running). */
export function isCutOffRun(run: { status: RunStatus | string; result?: RoutineRunResult | string | null; error?: string | null }): boolean {
  if (run.result === "cutoff") return true;
  if (run.status === "running" || !run.error) return false;
  return LEGACY_CUTOFF_ERRORS.some((prefix) => run.error!.startsWith(prefix));
}
