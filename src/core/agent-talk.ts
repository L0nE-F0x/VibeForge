import { slugify } from "./slug.js";
import { isCodingCli, sessionFolder } from "./checkout.js";
import type { LiveSession } from "./types.js";

// Agents talking to each other: who can be reached, what to call them, and the words a message
// arrives with. Pure; the MessageDesk (service/messages.ts) does the sending and the waiting.

/** Longer than this, a message is saved to a file and the CLI is handed the path. */
export const MESSAGE_INLINE_MAX = 8000;
/** Messages between two CLIs, either way, before a person has to press Enter on the next one. */
export const DEFAULT_MAX_MESSAGES = 8;
/** How long `--wait` waits for an answer, unless asked otherwise. A CLI's own tool timeout is often 10 minutes. */
export const DEFAULT_WAIT_MS = 9 * 60 * 1000;
/** A CLI that has been quiet this long has finished what it was doing. */
export const SETTLE_MS = 4000;
/** Typing a person hasn't sent yet (no Enter) holds messages to that terminal back this long. */
export const HUMAN_DRAFT_MS = 15_000;

export interface Reachable {
  /** What to type after `vibeforge tell`: "claude", "codex-2", or an agent's name ("notes"). */
  handle: string;
  ptyId: string;
  /** "Claude Code", or "Notes (Claude Code)" for an agent. */
  label: string;
  engineId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  cwd: string;
  working: boolean;
}

export interface Names {
  agent(id: string): string | null;
  /** The engine a live session runs, with its label. */
  engine(session: LiveSession): { id: string; label: string } | null;
}

/**
 * Handles given out while VibeForge runs. A CLI keeps its handle while it lives, and a handle is
 * never given to another CLI, so "vibeforge tell claude-2" in an earlier message can't reach a
 * CLI that started after the one it meant.
 */
export class Handles {
  private readonly byPty = new Map<string, string>();
  private readonly given = new Set<string>();

  for(ptyId: string, base: string): string {
    const had = this.byPty.get(ptyId);
    // Kept unless the terminal now runs something else (another CLI typed into the same shell).
    if (had !== undefined && (had === base || (had.startsWith(`${base}-`) && /^\d+$/.test(had.slice(base.length + 1))))) return had;
    let handle = base;
    for (let n = 2; this.given.has(handle); n += 1) handle = `${base}-${n}`;
    this.given.add(handle);
    this.byPty.set(ptyId, handle);
    return handle;
  }

  /** Lets go of the CLIs that have gone; their handles stay used. */
  keepOnly(ptyIds: ReadonlySet<string>): void {
    for (const ptyId of [...this.byPty.keys()]) if (!ptyIds.has(ptyId)) this.byPty.delete(ptyId);
  }
}

/**
 * Every live coding CLI, with a handle. An agent goes by its name, a bare CLI by its engine's id;
 * a second one with the same name gets "-2", in the order they started (or as `handles` gave them out).
 */
export function reachable(live: readonly LiveSession[], names: Names, handles?: Handles): Reachable[] {
  const sessions = live.filter(isCodingCli).sort((a, b) => since(a).localeCompare(since(b)) || a.ptyId.localeCompare(b.ptyId));
  handles?.keepOnly(new Set(sessions.map((session) => session.ptyId)));
  const taken = new Map<string, number>();
  return sessions.map((session) => {
    const engine = names.engine(session);
    const agent = session.agentId ? names.agent(session.agentId) : null;
    const base = agent ? slugify(agent, 24) : engine ? slugify(engine.id, 24) : "cli";
    const seen = (taken.get(base) ?? 0) + 1;
    taken.set(base, seen);
    const engineLabel = engine?.label ?? session.program ?? "CLI";
    return {
      handle: handles ? handles.for(session.ptyId, base) : seen === 1 ? base : `${base}-${seen}`,
      ptyId: session.ptyId,
      label: agent ? `${agent} (${engineLabel})` : engineLabel,
      engineId: engine?.id ?? session.programEngineId ?? null,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
      cwd: sessionFolder(session),
      working: Boolean(session.working),
    };
  });
}

function since(session: LiveSession): string {
  return session.cliSince ?? session.startedAt;
}

export type Resolved = { ok: true; to: Reachable } | { ok: false; reason: "none" | "self" | "ambiguous"; options: string[] };

/**
 * The CLI `name` means, as seen from `fromPty`. A handle matches exactly; an engine id, agent name
 * or label matches when only one such CLI is in the sender's workspace, or only one at all.
 */
export function resolveTarget(name: string, fromPty: string | null, list: readonly Reachable[]): Resolved {
  const wanted = slugify(name.trim(), 48);
  const exact = list.find((item) => item.handle === wanted);
  if (exact) return exact.ptyId === fromPty ? { ok: false, reason: "self", options: [] } : { ok: true, to: exact };
  const others = list.filter((item) => item.ptyId !== fromPty);
  const matches = others.filter((item) => item.engineId === wanted || slugify(item.label, 48) === wanted || item.handle.replace(/-\d+$/, "") === wanted);
  if (matches.length === 1) return { ok: true, to: matches[0] };
  const from = list.find((item) => item.ptyId === fromPty);
  const near = from ? matches.filter((item) => item.workspaceId === from.workspaceId) : [];
  if (near.length === 1) return { ok: true, to: near[0] };
  if (!matches.length) return { ok: false, reason: "none", options: others.map((item) => item.handle) };
  return { ok: false, reason: "ambiguous", options: matches.map((item) => item.handle) };
}

/** Escapes and bracketed-paste markers can't ride along: they would type keys of their own. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x1b]/g, "")
    .trim();
}

export type Answer = "tell" | "wait" | "none";

/**
 * What a message from one CLI to another says: who sent it, what they said, and how to answer.
 * `answer` is "tell" when the reply should come back as a message, "wait" when the sender is
 * waiting for this turn's answer, "none" for a person's draft.
 */
export function messageText(input: { fromLabel: string; fromHandle: string | null; text: string; answer: Answer; savedAt?: string | null }): string {
  const body = input.savedAt ? `The message is long, so it is saved at ${input.savedAt}. Read it first.` : input.text;
  const head = input.answer === "none" ? `From ${input.fromLabel}:` : `[Message from ${input.fromLabel}, sent through VibeForge]`;
  const foot =
    input.answer === "tell" && input.fromHandle
      ? `(To answer, run: vibeforge tell ${input.fromHandle} "your answer")`
      : input.answer === "wait"
        ? `(${input.fromLabel} is waiting for your answer: just reply here when you're done, it goes back to them.)`
        : null;
  return [head, body, ...(foot ? ["", foot] : [])].join("\n");
}

/** A review request: the changes are in a file, so a long diff never goes through a paste. */
export function reviewRequestText(input: { authorLabel: string; cwd: string; patchPath: string; files: readonly string[]; round: number; rounds: number }): string {
  const files = input.files.length > 12 ? `${input.files.slice(0, 12).join(", ")} and ${input.files.length - 12} more` : input.files.join(", ");
  return [
    `[Review request from VibeForge${input.rounds > 1 ? `, round ${input.round} of ${input.rounds}` : ""}]`,
    `${input.authorLabel} just finished working in ${input.cwd}. Its changes are in ${input.patchPath}${files ? ` (${files})` : ""}.`,
    "Review them: bugs, risks, missing pieces, anything you would push back on. Don't change any files: read only.",
    `Put your findings in your reply. It goes back to ${input.authorLabel} when you're done.`,
  ].join("\n");
}

/** A reviewer's answer, on its way back to the CLI that wrote the changes. */
export function reviewReplyText(input: { reviewerLabel: string; reply: string; savedAt?: string | null }): string {
  return [
    `[Review of your changes from ${input.reviewerLabel}, sent through VibeForge]`,
    input.savedAt ? `The review is long, so it is saved at ${input.savedAt}. Read it first.` : input.reply,
    "",
    "Fix what you agree with, and say in a line or two what you left as it is and why.",
  ].join("\n");
}

/** What a handed-out task did, on its way back to the CLI that handed it out. */
export function taskReportText(input: {
  agentLabel: string;
  handle: string | null;
  title: string;
  /** Its CLI closed before it answered. */
  ended: boolean;
  reply: string | null;
  savedAt?: string | null;
  patchPath: string | null;
  files: readonly string[];
  copyPath: string | null;
}): string {
  const files = input.files.length > 12 ? `${input.files.slice(0, 12).join(", ")} and ${input.files.length - 12} more` : input.files.join(", ");
  const said = input.savedAt ? `Its answer is long, so it is saved at ${input.savedAt}. Read it first.` : input.reply?.trim() ? `Its answer:\n${input.reply.trim()}` : null;
  return [
    `[Task report from ${input.agentLabel}, sent through VibeForge]`,
    input.ended ? `The task you handed out, "${input.title}", ended before ${input.agentLabel} answered.` : `${input.agentLabel} finished its turn on the task you handed it: "${input.title}".`,
    ...(said ? [said] : []),
    input.patchPath
      ? `Its changes are in ${input.patchPath}${files ? ` (${files})` : ""}, made in its own copy${input.copyPath ? ` at ${input.copyPath}` : ""}. A person applies them from the task in VibeForge.`
      : "It changed no files.",
    ...(input.handle && !input.ended ? ["", `(To ask it more, run: vibeforge tell ${input.handle} "…")`] : []),
  ].join("\n");
}

/** The pair two terminals' messages are counted under, whichever way they go. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * What a CLI wrote after `sent`, on a screen that still shows it: whatever follows the message's
 * last line. A long line may be wrapped on screen, so it is found by its start and skipped by its
 * length. Without the message on screen, the end of the screen.
 */
export function answerFromScreen(screen: string, sent: string): string {
  const plain = screen.replace(/\r/g, "");
  const last = sent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const probe = last?.slice(0, 24) ?? "";
  const at = probe ? plain.lastIndexOf(probe) : -1;
  if (at < 0) return screenTail(plain);
  // Wrapping adds line breaks and may drop spaces, so only the rest of the line's other characters are counted.
  let left = (last ?? "").slice(probe.length).replace(/\s/g, "").length;
  let index = at + probe.length;
  while (index < plain.length && left > 0) {
    if (!/\s/.test(plain[index])) left -= 1;
    index += 1;
  }
  const newline = plain.indexOf("\n", index);
  return screenTail(newline >= 0 ? plain.slice(newline + 1) : "") || screenTail(plain);
}

/** The end of a screen, for a CLI whose own log VibeForge can't read: blank runs folded, at most `lines`. */
export function screenTail(screen: string, lines = 60): string {
  const kept = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  const folded: string[] = [];
  for (const line of kept.slice(-lines * 2)) if (line || folded[folded.length - 1]) folded.push(line);
  return folded.slice(-lines).join("\n").trim();
}
