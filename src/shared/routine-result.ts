import type { CutOff, RoutineRunResult, RunOrigin, RunStatus } from "../core/types.js";

/**
 * Whether a routine's run was cut off (VibeForge closed, quit, or lost the terminal host while it
 * ran). Read from what the run recorded, never from its error text: a run from before results
 * were recorded, or a task's or chat's run, isn't called cut off here.
 */
export function isCutOffRun(run: {
  status: RunStatus | string;
  result?: RoutineRunResult | string | null;
  origin?: RunOrigin | string | null;
  cutOff?: CutOff | string | null;
}): boolean {
  if (run.status === "running") return false;
  return run.result === "cutoff" || (run.origin === "routine" && Boolean(run.cutOff) && !run.result);
}
