import path from "node:path";

// Talking back: finding what an agent answered, and turning it into something worth hearing.
// A CLI's own session log says it better than its screen does: Claude Code keeps one JSONL file
// per session under ~/.claude/projects, Codex under ~/.codex/sessions, Grok Build under
// ~/.grok/sessions and Kimi Code under ~/.kimi-code/sessions. Pure; electron/replies.ts watches
// the files.

export interface Turn {
  /** A prompt was sent after the time asked about. */
  prompted: boolean;
  /** The prompt mentions the words that were dictated. */
  matched: boolean;
  /** The agent's final words for that turn, once it has finished; null while it works. */
  reply: string | null;
}

const NO_TURN: Turn = { prompted: false, matched: false, reply: null };

function parseLines(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
    } catch {
      /* a line still being written */
    }
  }
  return rows;
}

function time(row: Record<string, unknown>): number {
  return typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
}

/** Lower case letters and digits only, so "Fix the build!" matches "fix the build". */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** True when `prompt` contains the start of the dictated words (the person may have added to them). */
export function mentions(prompt: string, words: string): boolean {
  const said = squash(words).split(" ").slice(0, 8).join(" ");
  return Boolean(said) && squash(prompt).includes(said);
}

// ------------------------------------------------------------------ Claude Code

/** Claude Code's folder for a working directory: every character but letters and digits becomes "-". */
export function claudeProjectDir(home: string, cwd: string): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

function claudePromptText(row: Record<string, unknown>): string | null {
  if (row.type !== "user" || row.isMeta === true || row.isSidechain === true) return null;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    // Tool results come back as user rows too; only typed text is a prompt.
    if (content.some((block) => (block as { type?: unknown })?.type === "tool_result")) return null;
    text = content
      .filter((block) => (block as { type?: unknown })?.type === "text")
      .map((block) => String((block as { text?: unknown }).text ?? ""))
      .join("\n");
  }
  // Slash commands and their output are recorded as tagged user rows.
  if (!text.trim() || /^\s*<(command-|local-command|bash-|system-reminder)/.test(text)) return null;
  return text;
}

function textBlocks(row: Record<string, unknown>): string[] {
  const content = (row.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => (block as { type?: unknown })?.type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .filter((text) => text.trim());
}

/**
 * The turn that began with the first prompt at or after `since` in a Claude Code session log.
 * It has ended when an assistant row stops with "end_turn"; the reply is that message's text
 * (its blocks are written one row each), else the last text of the turn.
 */
export function claudeTurn(log: string, since: number, words = ""): Turn {
  const rows = parseLines(log);
  let start = -1;
  let matched = false;
  for (let i = 0; i < rows.length; i++) {
    const prompt = claudePromptText(rows[i]);
    if (prompt === null || !(time(rows[i]) >= since)) continue;
    if (start < 0 || (!matched && words && mentions(prompt, words))) {
      start = i;
      matched = Boolean(words) && mentions(prompt, words);
      if (matched || !words) break;
    }
  }
  if (start < 0) return NO_TURN;
  let lastText = "";
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (claudePromptText(row) !== null) return { prompted: true, matched, reply: null }; // a new prompt before an answer
    if (row.type !== "assistant") continue;
    const blocks = textBlocks(row);
    if (blocks.length) lastText = blocks.join("\n\n");
    const message = row.message as { stop_reason?: unknown; id?: unknown } | undefined;
    if (message?.stop_reason !== "end_turn") continue;
    const id = message.id;
    const same = rows.slice(start + 1, i + 1).filter((other) => other.type === "assistant" && (other.message as { id?: unknown } | undefined)?.id === id);
    const reply = same.flatMap(textBlocks).join("\n\n").trim() || lastText.trim();
    return { prompted: true, matched, reply: reply || "" };
  }
  return { prompted: true, matched, reply: null };
}

/** The working directory a Claude Code log was written in, from its first rows. */
export function claudeLogCwd(head: string): string | null {
  for (const row of parseLines(head)) if (typeof row.cwd === "string") return row.cwd;
  return null;
}

// ------------------------------------------------------------------ Codex

/** Codex's day folder for a date: ~/.codex/sessions/YYYY/MM/DD. */
export function codexDayDir(home: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return path.join(home, ".codex", "sessions", String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
}

export function codexLogCwd(head: string): string | null {
  for (const row of parseLines(head)) {
    const payload = row.payload as { cwd?: unknown } | undefined;
    if (row.type === "session_meta" && typeof payload?.cwd === "string") return payload.cwd;
  }
  return null;
}

/**
 * The same for a Codex rollout log: the prompt is an event_msg "user_message", the turn ends with
 * "task_complete", and its last_agent_message (else the last "agent_message") is the reply.
 */
export function codexTurn(log: string, since: number, words = ""): Turn {
  const rows = parseLines(log);
  let start = -1;
  let matched = false;
  const payload = (row: Record<string, unknown>) => (row.type === "event_msg" ? (row.payload as Record<string, unknown> | undefined) : undefined);
  for (let i = 0; i < rows.length; i++) {
    const event = payload(rows[i]);
    if (event?.type !== "user_message" || typeof event.message !== "string" || !(time(rows[i]) >= since)) continue;
    if (start < 0 || (!matched && words && mentions(event.message, words))) {
      start = i;
      matched = Boolean(words) && mentions(event.message, words);
      if (matched || !words) break;
    }
  }
  if (start < 0) return NO_TURN;
  let lastText = "";
  for (let i = start + 1; i < rows.length; i++) {
    const event = payload(rows[i]);
    if (!event) continue;
    if (event.type === "user_message") return { prompted: true, matched, reply: null };
    if (event.type === "agent_message" && typeof event.message === "string") lastText = event.message;
    if (event.type === "task_complete") {
      const last = typeof event.last_agent_message === "string" ? event.last_agent_message : "";
      return { prompted: true, matched, reply: (last || lastText).trim() };
    }
  }
  return { prompted: true, matched, reply: null };
}

// ------------------------------------------------------------------ Grok Build

/** Grok Build's folder of sessions for a working directory: the directory, percent-encoded. */
export function grokSessionsDir(home: string, cwd: string): string {
  return path.join(home, ".grok", "sessions", encodeURIComponent(cwd));
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : typeof (block as { text?: unknown })?.text === "string" ? String((block as { text: string }).text) : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * A Grok Build session: `chat_history.jsonl` holds the messages without times, `events.jsonl` the
 * turns with them. The turn that started at or after `since` has ended once a "turn_ended" follows
 * it; the reply is the last assistant text after the prompt (the one mentioning `words`, else the
 * last typed one). Rows Grok adds itself carry a `synthetic_reason` and are not prompts.
 */
export function grokTurn(history: string, events: string, since: number, words = ""): Turn {
  const turns = parseLines(events);
  const started = turns.findIndex((row) => row.type === "turn_started" && Date.parse(String(row.ts ?? "")) >= since);
  if (started < 0) return NO_TURN;
  const ended = turns.slice(started + 1).some((row) => row.type === "turn_ended");
  const rows = parseLines(history);
  const prompts = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.type === "user" && !row.synthetic_reason && plainText(row.content).trim());
  const hit = words ? [...prompts].reverse().find(({ row }) => mentions(plainText(row.content), words)) : undefined;
  const prompt = hit ?? prompts[prompts.length - 1];
  const matched = Boolean(hit);
  if (!prompt || !ended) return { prompted: true, matched, reply: null };
  let reply = "";
  for (const row of rows.slice(prompt.index + 1)) if (row.type === "assistant" && plainText(row.content).trim()) reply = plainText(row.content);
  return { prompted: true, matched, reply: reply.trim() };
}

// ------------------------------------------------------------------ Kimi Code

/** The working directory a Kimi Code session ran in, from the session's state.json. */
export function kimiStateCwd(state: string): string | null {
  try {
    const cwd = (JSON.parse(state) as { cwd?: unknown }).cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * A Kimi Code `wire.jsonl`: a "turn.prompt" (time in milliseconds) opens a turn, and its
 * "turn.ended" closes it; the reply is the last assistant text appended in between.
 */
export function kimiTurn(log: string, since: number, words = ""): Turn {
  const rows = parseLines(log);
  let start = -1;
  let matched = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type !== "turn.prompt" || !(Number(row.time) >= since)) continue;
    const text = plainText(row.input);
    if (start < 0 || (!matched && words && mentions(text, words))) {
      start = i;
      matched = Boolean(words) && mentions(text, words);
      if (matched || !words) break;
    }
  }
  if (start < 0) return NO_TURN;
  const turnId = rows[start].turnId;
  let lastText = "";
  for (const row of rows.slice(start + 1)) {
    if (row.type === "turn.prompt") return { prompted: true, matched, reply: null };
    const message = (row.message as { message?: { role?: unknown; content?: unknown } } | undefined)?.message;
    if (row.type === "agent.message.appended" && message?.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => (block as { type?: unknown })?.type === "text")
        .map((block) => String((block as { text?: unknown }).text ?? ""))
        .join("\n")
        .trim();
      if (text) lastText = text;
    }
    if (row.type === "turn.ended" && row.turnId === turnId) return { prompted: true, matched, reply: lastText };
  }
  return { prompted: true, matched, reply: null };
}

/** Which engines leave a log VibeForge can read replies from. */
export type ReplyLog = "claude" | "codex" | "grok" | "kimi";

export function replyLogFor(engineId: string, bin: string): ReplyLog | null {
  const name = `${engineId} ${path.basename(bin)}`.toLowerCase();
  if (/\bclaude\b/.test(name)) return "claude";
  if (/\bcodex\b/.test(name)) return "codex";
  if (/\bgrok\b/.test(name)) return "grok";
  if (/\bkimi\b/.test(name)) return "kimi";
  return null;
}

// ------------------------------------------------------------------ the latest answer

/** When each prompt in a log was sent (for Grok Build, when each turn started), oldest first. */
function promptTimes(kind: ReplyLog, log: string): number[] {
  const rows = parseLines(log);
  const times =
    kind === "claude"
      ? rows.filter((row) => claudePromptText(row) !== null).map(time)
      : kind === "codex"
        ? rows.filter((row) => row.type === "event_msg" && (row.payload as { type?: unknown } | undefined)?.type === "user_message").map(time)
        : kind === "kimi"
          ? rows.filter((row) => row.type === "turn.prompt").map((row) => Number(row.time))
          : rows.filter((row) => row.type === "turn_started").map((row) => Date.parse(String(row.ts ?? "")));
  return times.filter((at) => Number.isFinite(at));
}

/** The answer of the last turn that has finished in one CLI's log (`events` is Grok Build's second file). */
export function lastReplyIn(kind: ReplyLog, log: string, events = ""): string | null {
  const starts = promptTimes(kind, kind === "grok" ? events : log);
  // The newest turn may still be going; then the one before it is the latest answer.
  for (const since of starts.slice(-2).reverse()) {
    const turn = kind === "claude" ? claudeTurn(log, since) : kind === "codex" ? codexTurn(log, since) : kind === "kimi" ? kimiTurn(log, since) : grokTurn(log, events, since);
    if (turn.reply?.trim()) return turn.reply.trim();
  }
  return null;
}

// ------------------------------------------------------------------ what gets said

export type TalkBack = "off" | "summary" | "full";

/** Markdown as it would be read aloud: no markers, links by their text, tables and code left out. */
function plain(markdown: string, describeCode: boolean): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCode = false;
  let codeLines = 0;
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      if (inCode) {
        inCode = false;
        if (describeCode) paragraphs.push(`A code block, ${codeLines} line${codeLines === 1 ? "" : "s"}.`);
      } else {
        flush();
        inCode = true;
        codeLines = 0;
      }
      continue;
    }
    if (inCode) {
      codeLines += 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line)) {
      flush();
      continue;
    }
    let text = line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "a link")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/<[^>]+>/g, " ");
    // A heading or list item reads as its own sentence.
    if (/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line)) {
      text = text.replace(/^\s*\d+[.)]\s+/, "");
      if (!/[.!?:]$/.test(text.trim())) text = `${text.trim()}.`;
    }
    current.push(text);
  }
  flush();
  return paragraphs;
}

/** Cut at the last sentence end before `max` characters, or at a word if there is none. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > max * 0.4) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).trim()}…`;
}

/** What to say for a reply: its first paragraph for a summary, all of it (within reason) otherwise. */
export function speakable(markdown: string, mode: TalkBack): string {
  if (mode === "off") return "";
  const paragraphs = plain(markdown, mode === "full");
  if (mode === "summary") return clip(paragraphs.find((paragraph) => !/^A code block/.test(paragraph)) ?? "", 360);
  return clip(paragraphs.join(" "), 4000);
}
