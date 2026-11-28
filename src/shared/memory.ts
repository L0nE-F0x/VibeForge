/** Maximum length of one remembered line (not counting its `- YYYY-MM-DD: ` prefix). */
export const MEMORY_LINE_MAX = 500;

export type MemoryFlag = "command" | "url" | "instruction";

export interface FlaggedMemoryLine {
  index: number;
  line: string;
  flags: MemoryFlag[];
}

export type PreparedMemoryLine = { ok: true; note: string; flags: MemoryFlag[] } | { ok: false; error: string };

const CONTROL_CHARS = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

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

/** Validate and clean one line before appending it to an agent's `memory.md`. */
export function prepareMemoryLine(raw: string): PreparedMemoryLine {
  const outer = raw.trim();
  if (!outer) return { ok: false, error: "Nothing to remember: pass a non-empty line." };
  if (CONTROL_CHARS.test(outer)) return { ok: false, error: "Pass a single line to remember, not multiple lines." };
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

/** Append one bullet to `memory.md`, keeping `starter` at the top when the file is empty. */
export function appendMemoryBullet(existing: string, bullet: string, starter: string): string {
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n${bullet}\n` : `${starter.trimEnd()}\n${bullet}\n`;
}

/** Remove the last exact line matching `bullet`, leaving every other line intact. */
export function removeMemoryLine(existing: string, bullet: string): string {
  const lines = existing.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.lastIndexOf(bullet);
  if (at < 0) return existing;
  lines.splice(at, 1);
  const joined = lines.join("\n").trimEnd();
  return joined ? `${joined}\n` : "";
}

/** Remove the line at 0-based `index` from `memory.md`, leaving every other line intact. */
export function removeMemoryLineAt(existing: string, index: number): string {
  const lines = existing.replace(/\r\n?/g, "\n").split("\n");
  if (index < 0 || index >= lines.length) return existing;
  lines.splice(index, 1);
  const joined = lines.join("\n").trimEnd();
  return joined ? `${joined}\n` : "";
}

/** Scan `memory.md` for lines that contain commands, URLs, or instruction-like wording. */
export function flaggedMemoryLines(content: string): FlaggedMemoryLine[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  // Blank HTML comments (such as the starter note) while keeping line indices exact.
  const masked = normalized.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  const rawLines = normalized.split("\n");
  const maskedLines = masked.split("\n");
  const out: FlaggedMemoryLine[] = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const trimmed = maskedLines[index].trim();
    if (!trimmed) continue;
    const flags = memoryLineFlags(trimmed);
    if (flags.length > 0) out.push({ index, line: rawLines[index].trim(), flags });
  }
  return out;
}
