import type { CutOff, CutOffRun } from "../shared/api.js";
import { call, on } from "./api.js";

// The CLIs VibeForge's last close cut off, read once per window: Code's panes offer to pick each
// back up where it ran, the start-up notice offers Continue all, and after an update they reopen
// by themselves. Each one is offered until it is continued or let go.

export interface CutOffNote {
  reason: CutOff;
  runs: CutOffRun[];
}

let note: Promise<CutOffNote | null> | null = null;
let left: CutOffNote | null = null;
const listeners = new Set<() => void>();
/** Runs whose pane Code should start again, picking the session up (Continue all, or after an update). */
const toContinue = new Set<string>();
const continueListeners = new Set<() => void>();

/** What the last close cut off: asked once per window, then kept up to date as runs change. */
export function cutOffNote(): Promise<CutOffNote | null> {
  if (!note) {
    note = ask();
    listen();
  }
  return note;
}

function ask(): Promise<CutOffNote | null> {
  return call("runs.cutOff")
    .then((found) => {
      left = found ? { reason: found.reason, runs: found.runs } : null;
      return left;
    })
    .catch(() => left);
}

// A run continued from anywhere (Runs, a chat, the notice) stops being offered here too.
let asking: ReturnType<typeof setTimeout> | null = null;
function listen(): void {
  on("changed", (topics) => {
    if (!left?.runs.length || !topics.includes("runs") || asking) return;
    asking = setTimeout(() => {
      asking = null;
      void ask().then(() => {
        for (const listener of listeners) listener();
      });
    }, 300);
  });
}

/** The cut-off run that last ran in this pane, while it is still offered. */
export function cutOffInPane(workspaceId: string, paneId: string): CutOffRun | null {
  return left?.runs.find((run) => run.workspaceId === workspaceId && run.paneId === paneId) ?? null;
}

/** A cut-off run still offered, by its id. */
export function cutOffRun(runId: string): CutOffRun | null {
  return left?.runs.find((run) => run.runId === runId) ?? null;
}

/** These were picked back up or let go: no longer offered, here or after the next start. */
export function settleCutOff(runIds: readonly string[]): void {
  if (!runIds.length) return;
  if (left) left = { ...left, runs: left.runs.filter((run) => !runIds.includes(run.runId)) };
  for (const id of runIds) toContinue.delete(id);
  void call("runs.cutOffSettle", [...runIds]).catch(() => undefined);
  for (const listener of listeners) listener();
}

export function onCutOffChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask Code to start these runs' panes again with their sessions. */
export function continueInPanes(runIds: readonly string[]): void {
  for (const id of runIds) toContinue.add(id);
  for (const listener of continueListeners) listener();
}

/** The runs waiting for Code to continue them in their panes; each is handed out once. */
export function takePaneContinues(): string[] {
  const ids = [...toContinue];
  toContinue.clear();
  return ids;
}

export function onPaneContinue(listener: () => void): () => void {
  continueListeners.add(listener);
  return () => continueListeners.delete(listener);
}

/** Whether this run reopens in a Code pane (else it continues in its chat, task, or a new pane). */
export function inPane(run: CutOffRun): boolean {
  return Boolean(run.paneId && run.workspaceId && !run.chatId && !run.taskId);
}
