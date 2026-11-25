import { typedIn } from "../shared/terminal-input.js";
import { shellQuote } from "../shared/text.js";

// The first ten minutes: what Home's first steps, Code's hint above a fresh shell and the short
// tour's last step work out. Pure, so they can be tested without a window.

/** What a person types at a shell prompt to start this CLI: its program and fixed arguments. */
export function cliCommand(engine: { bin: string; args?: readonly string[] }): string {
  return [engine.bin, ...(engine.args ?? [])].map(shellQuote).join(" ");
}

/**
 * Whether input sent to a terminal was the person typing. A terminal also reports focus, the
 * mouse and the arrow keys as escape sequences; none of those hide the hint above a fresh shell.
 */
export function isTyping(data: string): boolean {
  return typedIn(data).length > 0;
}

export type FirstStep = "folder" | "cli" | "review";

export interface FirstStepState {
  key: FirstStep;
  done: boolean;
}

/**
 * Home's three steps to a first result, each done from what is on disk rather than a flag: a
 * workspace exists, a run was recorded, and a finished run was opened.
 */
export function firstSteps(state: { workspaces: number; runs: ReadonlyArray<{ openedAt: string | null }> }): FirstStepState[] {
  return [
    { key: "folder", done: state.workspaces > 0 },
    { key: "cli", done: state.runs.length > 0 },
    { key: "review", done: state.runs.some((run) => Boolean(run.openedAt)) },
  ];
}

/** The steps stay on Home until all three are done. */
export function firstStepsDone(steps: FirstStepState[]): boolean {
  return steps.every((step) => step.done);
}

/** The hint above a shell pane shows while it is a fresh shell nobody has typed into, with no CLI in its foreground. */
export function showShellHint(pane: { shell: boolean; fresh: boolean; live: boolean; program: string | null }): boolean {
  return pane.shell && pane.fresh && pane.live && !pane.program;
}

// ------------------------------------------------------------------ starting a CLI in Code from elsewhere

export const START_CLI_EVENT = "vibeforge:start-cli";

export interface StartCliDetail {
  workspaceId: string;
  /** The CLI to type into the new shell, or null for a plain shell. */
  engineId: string | null;
  /** Called with the new terminal's id once it started, or null when it didn't. */
  done: (ptyId: string | null) => void;
}

/**
 * Asks Code to open a shell in the workspace and type the CLI's command there, pressing Enter
 * because the person clicked to start it. Resolves with the terminal's id, or null.
 */
export function startCliIn(workspaceId: string, engineId: string | null, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ptyId: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ptyId);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.dispatchEvent(new CustomEvent<StartCliDetail>(START_CLI_EVENT, { detail: { workspaceId, engineId, done: finish } }));
  });
}
