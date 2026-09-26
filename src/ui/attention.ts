import { useSyncExternalStore } from "react";
import type { LiveSession } from "../shared/api.js";

// Which workspaces have a coding CLI that wants you: one that was working and went quiet
// ("waiting"), or one that finished ("done"), while that workspace was out of sight. Looking at
// the workspace clears it.

export type Attention = "waiting" | "done";

let state: ReadonlyMap<string, Attention> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAttention(): ReadonlyMap<string, Attention> {
  return useSyncExternalStore(subscribe, () => state);
}

interface Seen {
  cli: boolean;
  working: boolean;
  workspaceId: string | null;
  label: string;
}

const seen = new Map<string, Seen>();

const isCli = (session: LiveSession) => session.kind === "run" || Boolean(session.programEngineId);

/**
 * Compare the live sessions with the last look. `onScreen` is the workspace in view, if any;
 * returns what was newly flagged, for a notification.
 */
export function trackLive(live: readonly LiveSession[], onScreen: string | null): Array<{ workspaceId: string; label: string; attention: Attention }> {
  let next: Map<string, Attention> | null = null;
  const flagged: Array<{ workspaceId: string; label: string; attention: Attention }> = [];
  const flag = (was: Seen, attention: Attention) => {
    const workspaceId = was.workspaceId;
    if (!workspaceId || workspaceId === onScreen || (next ?? state).get(workspaceId) === "waiting") return;
    (next ??= new Map(state)).set(workspaceId, attention);
    flagged.push({ workspaceId, label: was.label, attention });
  };
  const present = new Set<string>();
  for (const session of live) {
    present.add(session.ptyId);
    const was = seen.get(session.ptyId);
    const cli = isCli(session);
    if (was?.cli && cli && was.working && !session.working) flag(was, "waiting");
    else if (was?.cli && !cli) flag(was, "done");
    seen.set(session.ptyId, { cli, working: Boolean(session.working), workspaceId: session.workspaceId, label: session.program || session.title });
  }
  for (const [ptyId, was] of seen) {
    if (present.has(ptyId)) continue;
    if (was.cli) flag(was, "done");
    seen.delete(ptyId);
  }
  if (onScreen && (next ?? state).has(onScreen)) (next ??= new Map(state)).delete(onScreen);
  if (next) {
    state = next;
    for (const listener of listeners) listener();
  }
  return flagged;
}
