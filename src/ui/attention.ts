import { useSyncExternalStore } from "react";
import type { LiveSession } from "../shared/api.js";

// Which workspaces and chats have a coding CLI that wants you: one that was working and went
// quiet ("waiting"), or one that finished ("done"), while it was out of sight. Looking at the
// workspace, or at the chat, clears it. Agent and plain chats count by chat; everything else by
// the workspace it runs in.

export type Attention = "waiting" | "done";

export type Flagged =
  | { workspaceId: string; label: string; attention: Attention }
  | { chatId: string; agentId: string | null; label: string; attention: Attention };

let state: ReadonlyMap<string, Attention> = new Map();
let chatState: ReadonlyMap<string, { agentId: string | null; attention: Attention }> = new Map();
let workspaceInView: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Workspaces that want you, by id. */
export function useAttention(): ReadonlyMap<string, Attention> {
  return useSyncExternalStore(subscribe, () => state);
}

/** Chats that want you, by chat id, with the agent they belong to. */
export function useChatAttention(): ReadonlyMap<string, { agentId: string | null; attention: Attention }> {
  return useSyncExternalStore(subscribe, () => chatState);
}

/** Code says which workspace it shows while it is the open view; null otherwise. */
export function setWorkspaceInView(id: string | null): void {
  if (workspaceInView === id) return;
  workspaceInView = id;
  changed();
}

export function useWorkspaceInView(): string | null {
  return useSyncExternalStore(subscribe, () => workspaceInView);
}

interface Seen {
  cli: boolean;
  working: boolean;
  workspaceId: string | null;
  chatId: string | null;
  agentId: string | null;
  label: string;
}

const seen = new Map<string, Seen>();

const isCli = (session: LiveSession) => session.kind === "run" || Boolean(session.programEngineId);

/**
 * Compare the live sessions with the last look. `onScreen` is the workspace in view and
 * `chatOnScreen` the chat in view, if any; returns what was newly flagged, for a notification.
 */
export function trackLive(live: readonly LiveSession[], onScreen: string | null, chatOnScreen: string | null = null): Flagged[] {
  let next: Map<string, Attention> | null = null;
  let nextChats: Map<string, { agentId: string | null; attention: Attention }> | null = null;
  const flagged: Flagged[] = [];
  const flag = (was: Seen, attention: Attention) => {
    if (was.chatId) {
      const chatId = was.chatId;
      if (chatId === chatOnScreen || (nextChats ?? chatState).get(chatId)?.attention === "waiting") return;
      (nextChats ??= new Map(chatState)).set(chatId, { agentId: was.agentId, attention });
      flagged.push({ chatId, agentId: was.agentId, label: was.label, attention });
      return;
    }
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
    seen.set(session.ptyId, {
      cli,
      working: Boolean(session.working),
      workspaceId: session.workspaceId,
      chatId: session.chatId,
      agentId: session.agentId,
      label: session.program || session.title,
    });
  }
  for (const [ptyId, was] of seen) {
    if (present.has(ptyId)) continue;
    if (was.cli) flag(was, "done");
    seen.delete(ptyId);
  }
  if (onScreen && (next ?? state).has(onScreen)) (next ??= new Map(state)).delete(onScreen);
  if (chatOnScreen && (nextChats ?? chatState).has(chatOnScreen)) (nextChats ??= new Map(chatState)).delete(chatOnScreen);
  if (next) state = next;
  if (nextChats) chatState = nextChats;
  if (next || nextChats) changed();
  return flagged;
}
