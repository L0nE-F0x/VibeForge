import { useSyncExternalStore } from "react";
import type { LiveSession, RunOrigin } from "../shared/api.js";

// Which coding CLIs want you, one mark per terminal: one that was working and went quiet, or sat
// on its first screen asking something ("waiting"), or one that finished ("done"), while you
// weren't looking at it. Looking at that terminal, or at its chat, clears its mark and no other.
// Workspaces and chats glow when any of their terminals has a mark.

export type Attention = "waiting" | "done";

export interface AttentionMark {
  ptyId: string;
  attention: Attention;
  label: string;
  origin: RunOrigin | null;
  workspaceId: string | null;
  chatId: string | null;
  agentId: string | null;
  taskId: string | null;
  routineId: string | null;
  runId: string | null;
  /** When it was marked (ms). */
  since: number;
}

/** What you're looking at: the terminals on screen and the chat in view. Null while VibeForge is in the background. */
export interface Looking {
  ptys: ReadonlySet<string>;
  chatId: string | null;
  workspaceId: string | null;
}

/**
 * A CLI that opens straight onto a question (trust this folder? sign in?) never works first, so
 * it never goes quiet either. After this long on its first screen, it counts as waiting.
 */
export const FIRST_SCREEN_MS = 12_000;
/** A CLI flickering between busy and quiet knocks once, not every time. */
const REFLAG_QUIET_MS = 60_000;

let marks: ReadonlyMap<string, AttentionMark> = new Map();
let workspaces: ReadonlyMap<string, Attention> = new Map();
let chats: ReadonlyMap<string, { agentId: string | null; attention: Attention }> = new Map();
let workspaceInView: string | null = null;
let ptysInView: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Every terminal that wants you, by pty id. */
export function usePtyAttention(): ReadonlyMap<string, AttentionMark> {
  return useSyncExternalStore(subscribe, () => marks);
}

/** Workspaces that want you, by id: waiting when any of their terminals is. */
export function useAttention(): ReadonlyMap<string, Attention> {
  return useSyncExternalStore(subscribe, () => workspaces);
}

/** Chats that want you, by chat id, with the agent they belong to. */
export function useChatAttention(): ReadonlyMap<string, { agentId: string | null; attention: Attention }> {
  return useSyncExternalStore(subscribe, () => chats);
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

/**
 * A view says which terminal it shows with focus (Code's focused pane, a task's or a run's live
 * terminal), or null when it stops. `owner` names the view, so two views can't clear each other.
 */
export function setPtyInView(owner: string, ptyId: string | null): void {
  if ((ptysInView.get(owner) ?? null) === ptyId) return;
  const next = new Map(ptysInView);
  if (ptyId) next.set(owner, ptyId);
  else next.delete(owner);
  ptysInView = next;
  changed();
}

export function usePtysInView(): ReadonlySet<string> {
  return new Set(useSyncExternalStore(subscribe, () => ptysInView).values());
}

interface Seen {
  cli: boolean;
  working: boolean;
  /** It has been busy at least once, so its first screen wasn't a question. */
  worked: boolean;
  /** When it became a coding CLI (ms). */
  cliSince: number;
  /** Its first screen has been looked at already. */
  firstChecked: boolean;
  /** When it last made a sound (ms). */
  knockedAt: number;
  mark: Omit<AttentionMark, "attention" | "since">;
}

const seen = new Map<string, Seen>();

const isCli = (session: LiveSession) => session.kind === "run" || Boolean(session.programEngineId);

function details(session: LiveSession): Seen["mark"] {
  return {
    ptyId: session.ptyId,
    label: session.program || session.title,
    origin: session.origin,
    workspaceId: session.workspaceId,
    chatId: session.chatId,
    agentId: session.agentId,
    taskId: session.taskId,
    routineId: session.routineId ?? null,
    runId: session.runId,
  };
}

/**
 * Compare the live sessions with the last look and update the marks. Returns what was newly
 * marked and should be heard about (a knock, and a notification when in the background).
 */
export function trackLive(live: readonly LiveSession[], looking: Looking | null, now: number = Date.now()): AttentionMark[] {
  const next = new Map(marks);
  const fresh: AttentionMark[] = [];
  const watched = (mark: Seen["mark"]) => Boolean(looking && (looking.ptys.has(mark.ptyId) || (mark.chatId && mark.chatId === looking.chatId)));
  const flag = (was: Seen, attention: Attention) => {
    if (watched(was.mark)) return;
    const existing = next.get(was.mark.ptyId);
    if (existing?.attention === "waiting" && attention === "waiting") return;
    const mark: AttentionMark = { ...was.mark, attention, since: now };
    next.set(mark.ptyId, mark);
    // A waiting CLI that ended is only "done" now; it was already heard about.
    if (existing?.attention === "waiting") return;
    if (attention === "waiting" && now - was.knockedAt < REFLAG_QUIET_MS) return;
    was.knockedAt = now;
    fresh.push(mark);
  };

  const present = new Set<string>();
  for (const session of live) {
    present.add(session.ptyId);
    const cli = isCli(session);
    const working = Boolean(session.working);
    const before = seen.get(session.ptyId);
    const was: Seen = before
      ? { ...before, mark: details(session) }
      : { cli: false, working: false, worked: false, cliSince: now, firstChecked: false, knockedAt: -Infinity, mark: details(session) };
    if (cli && !was.cli) Object.assign(was, { worked: working, cliSince: now, firstChecked: false });
    // Seen by you: its next quiet spell is news again.
    if (watched(was.mark)) was.knockedAt = -Infinity;
    if (before?.cli && cli && before.working && !working) flag(was, "waiting");
    else if (before?.cli && !cli) flag(was, "done");
    else if (cli && !working && !was.worked && !was.firstChecked && now - was.cliSince >= FIRST_SCREEN_MS) {
      was.firstChecked = true;
      flag(was, "waiting");
    }
    // Busy again: whatever it was waiting for was answered.
    if (cli && working && next.get(session.ptyId)?.attention === "waiting") next.delete(session.ptyId);
    seen.set(session.ptyId, { ...was, cli, working, worked: was.worked || (cli && working) });
  }
  for (const [ptyId, was] of seen) {
    if (present.has(ptyId)) continue;
    if (was.cli) flag(was, "done");
    seen.delete(ptyId);
  }

  // Looking clears: the terminal itself, its chat, and the finished ones of the workspace on screen.
  if (looking) {
    for (const mark of next.values()) {
      const ended = !present.has(mark.ptyId);
      if (watched(mark) || (ended && mark.workspaceId && !mark.chatId && mark.workspaceId === looking.workspaceId)) next.delete(mark.ptyId);
    }
  }
  if (!sameMarks(marks, next)) {
    marks = next;
    workspaces = byWorkspace(next);
    chats = byChat(next);
    changed();
  }
  return fresh;
}

function sameMarks(a: ReadonlyMap<string, AttentionMark>, b: ReadonlyMap<string, AttentionMark>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, mark] of a) {
    const other = b.get(key);
    if (!other || other.attention !== mark.attention || other.since !== mark.since) return false;
  }
  return true;
}

const louder = (a: Attention | undefined, b: Attention): Attention => (a === "waiting" || b === "waiting" ? "waiting" : "done");

function byWorkspace(all: ReadonlyMap<string, AttentionMark>): Map<string, Attention> {
  const out = new Map<string, Attention>();
  for (const mark of all.values()) if (mark.workspaceId && !mark.chatId) out.set(mark.workspaceId, louder(out.get(mark.workspaceId), mark.attention));
  return out;
}

function byChat(all: ReadonlyMap<string, AttentionMark>): Map<string, { agentId: string | null; attention: Attention }> {
  const out = new Map<string, { agentId: string | null; attention: Attention }>();
  for (const mark of all.values()) {
    if (!mark.chatId) continue;
    out.set(mark.chatId, { agentId: mark.agentId, attention: louder(out.get(mark.chatId)?.attention, mark.attention) });
  }
  return out;
}

/** Forget everything (tests). */
export function resetAttention(): void {
  seen.clear();
  marks = new Map();
  workspaces = new Map();
  chats = new Map();
  ptysInView = new Map();
  workspaceInView = null;
  changed();
}
