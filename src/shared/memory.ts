// Lines an agent proposes for its own memory (`vibeforge remember`). A proposal waits beside
// memory.md, in proposed.json, until the person keeps or drops it; only kept lines go into
// memory.md, and so into prompts. The checks here run on the proposal, never on the person's own lines.

/** Maximum length of one remembered line (not counting its `- YYYY-MM-DD: ` prefix). */
export const MEMORY_LINE_MAX = 500;
/** How many lines one run may propose. */
export const PROPOSALS_PER_RUN = 10;
/** How many proposals may wait for the person, per agent. */
export const PROPOSALS_WAITING_MAX = 50;

export type MemoryFlag = "command" | "url" | "instruction";

/** A line an agent proposed for its memory, waiting for the person to keep or drop it. */
export interface MemoryProposal {
  id: string;
  note: string;
  flags: MemoryFlag[];
  /** When it was proposed (ISO). */
  at: string;
  runId: string | null;
}

export type PreparedMemoryLine = { ok: true; note: string; flags: MemoryFlag[] } | { ok: false; error: string };

const CONTROL_CHARS = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
// Unicode line and paragraph separators, U+0085 and the other C1 controls, and format characters:
// zero-width ones (which slip past every word check) and bidi overrides (which show text backwards).
const HIDDEN_CHARS = /[\u0080-\u009f\p{Zl}\p{Zp}\p{Cf}]/u;
// An HTML comment hides a line from the person in a rendered view while the agent still reads it.
const COMMENT_MARKS = /<!--|-->/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b(?:hf_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:password|passwd|pwd|token|api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*(?:["'][^"']+["']|\S+)/i,
  /\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?:["'][^"']+["']|\S+)/,
  // "the staging password is hunter2": said in words, with a value that has a digit or a symbol in it.
  /\b(?:password|passphrase|passwd|pwd|api[ _-]?key|token|secret)\s+(?:is|was)\s+["'`]?(?=[^\s"'`]*[0-9!@#$%^&*])[^\s"'`]{4,}/i,
];

const COMMAND_PATTERNS: readonly RegExp[] = [
  /\$\([^)\n]+\)/,
  /\|\s*(?:ba|z|da)?sh\b|[;&|]{1,2}\s*(?:curl|wget|rm|chmod|chown|sudo|bash|sh|zsh|eval|exec|python\d?|node|nc|ncat|socat)\b/i,
  /\b(?:curl|wget|sudo|chmod|chown|nohup|setsid|nc|ncat|socat)\s+\S+/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\b(?:ba|z|da)?sh\s+-[a-z]*c\b/i,
  /\b(?:npm\s+(?:run|exec|install|ci)|npx\s+\S+|pnpm\s+(?:run|exec|dlx|add)|yarn\s+(?:dlx|add)|pip3?\s+install|cargo\s+install)\b/i,
  /`\s*(?:sudo|curl|wget|rm|chmod|chown|bash|sh|eval|exec|[a-z0-9._/-]+\s+(?:-[a-z0-9-]+|\||&&|;|>\S*))[^`]*`/i,
];

const URL_PATTERN = /\b(?:https?|ssh|ftp|wss?|file):\/\/\S+|\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/i;

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\balways\s+(?:run|execute|call|invoke|eval|fetch|curl|send|include|append|pass|trust|allow|approve|bypass|skip)\b/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|system|brief|safety|rules?|instructions?)\b/i,
  /\b(?:system\s+prompt|new\s+instructions?|override\s+instructions?|(?:before|on|at\s+the\s+start\s+of)\s+(?:every|each)\s+(?:run|turn|task|session)|without\s+asking(?:\s+the\s+(?:person|user))?|(?:do\s+not|don't|never)\s+(?:tell|ask|warn|mention)\s+(?:the\s+)?(?:person|user|human)|you\s+must\s+always)\b/i,
];

/** True when `text` looks like an API key, token, private key, credentialed URL, or secret assignment. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Flags a remembered line when it contains shell commands, URLs, or prompt-injection-style
 * instructions so the person is alerted to review it.
 */
export function memoryLineFlags(text: string): MemoryFlag[] {
  const body = text.replace(/^\s*[-*]\s+(?:\d{4}-\d{2}-\d{2}:\s*)?/, "");
  const flags: MemoryFlag[] = [];
  if (COMMAND_PATTERNS.some((pattern) => pattern.test(body))) flags.push("command");
  if (URL_PATTERN.test(body)) flags.push("url");
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(body))) flags.push("instruction");
  return flags;
}

/** Validate and clean one line an agent proposes for its memory. */
export function prepareMemoryLine(raw: string): PreparedMemoryLine {
  const outer = raw.trim();
  if (!outer) return { ok: false, error: "Nothing to remember: pass a non-empty line." };
  if (CONTROL_CHARS.test(outer)) return { ok: false, error: "Pass a single line to remember, not multiple lines." };
  if (HIDDEN_CHARS.test(outer)) {
    return { ok: false, error: "Refused to remember that: it has invisible or direction-changing characters (zero-width, bidi or Unicode line separators). Write it in plain characters." };
  }
  if (COMMENT_MARKS.test(outer)) return { ok: false, error: "Refused to remember that: it has an HTML comment mark (<!-- or -->), which can hide text." };
  const note = outer.replace(/^[-*]\s+(?:\d{4}-\d{2}-\d{2}:(?:\s+|$))?/, "").trim();
  if (!note) return { ok: false, error: "Nothing to remember: pass a non-empty line." };
  if (note.length > MEMORY_LINE_MAX) {
    return { ok: false, error: `Keep each memory to ${MEMORY_LINE_MAX} characters or fewer (got ${note.length}).` };
  }
  if (looksLikeSecret(note)) {
    return { ok: false, error: "Refused to remember that: it looks like a secret (a key, token or password). Memory is stored as plain text." };
  }
  return { ok: true, note, flags: memoryLineFlags(note) };
}

/** The dated bullet a kept proposal becomes in memory.md: `- YYYY-MM-DD: note`, dated the day it was proposed. */
export function memoryBullet(day: string, note: string): string {
  return `- ${day}: ${note}`;
}

/** Append bullets to `memory.md`, keeping `starter` at the top when the file is empty. Lines already there are not added twice. */
export function appendMemoryBullets(existing: string, bullets: readonly string[], starter: string): string {
  const have = new Set(existing.replace(/\r\n?/g, "\n").split("\n"));
  const fresh = bullets.filter((bullet, index) => !have.has(bullet) && bullets.indexOf(bullet) === index);
  if (!fresh.length) return existing;
  const head = existing.trimEnd() || starter.trimEnd();
  return `${head ? `${head}\n` : ""}${fresh.join("\n")}\n`;
}

/**
 * The memory editor holds unsaved edits (`draft`) while memory.md changed on disk from `before` to
 * `after`. When the change only added lines at the end (a kept proposal, a note Viby appended), the
 * draft gets those lines too, so saving it doesn't drop them. Any other change leaves the draft as is.
 */
export function withAppendedLines(before: string, after: string, draft: string): string {
  const norm = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();
  const was = norm(before);
  const now = norm(after);
  if (now === was || (was && !now.startsWith(`${was}\n`))) return draft;
  const added = (was ? now.slice(was.length + 1) : now).split("\n").filter((line) => line.trim());
  return appendMemoryBullets(draft, added, "");
}
