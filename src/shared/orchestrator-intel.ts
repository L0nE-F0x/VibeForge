// Pure helpers shared by the Orchestrator's planner, step validator, and call announcements:
// detecting interactive TUI prompts, translating spoken key answers, checking shell safety,
// parsing workbench actions, and turning raw CLI replies into natural spoken summaries.
// No Node imports here so both the window and the main process can run them.

/**
 * Inspect the bottom of a quiet terminal's screen for an interactive TUI prompt waiting on a
 * person (folder trust, tool approval, y/n confirmation, sign-in). Null when at a normal prompt.
 */
export function detectWaitingPrompt(screen: string): string | null {
  if (!screen.trim()) return null;
  const lines = screen
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-18);
  if (!lines.length) return null;
  const tail = lines.join("\n");

  const patterns: RegExp[] = [
    /do you trust the files in this folder\??/i,
    /trust this (?:folder|directory|workspace|project)\??/i,
    /do you want to (?:proceed|continue|allow|run|make this edit|create|overwrite)[^?\n]*\??/i,
    /allow [^\n?]{1,80}\?/i,
    /[^\n]*\((?:y\/n|yes\/no)\)[^\n]*/i,
    /[^\n]*\[(?:y\/n|Y\/n|y\/N)\][^\n]*/i,
    /(?:please )?(?:run \/login|sign in|log in)[^\n]*/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(tail);
    if (match) return cleanPromptLine(match[0]);
  }

  // Numbered confirmation menu (e.g. Claude Code / Grok Build: "❯ 1. Yes, proceed").
  const yesOption = lines.findIndex((line) => /^(?:[❯>*•]\s*)?1[.)]\s*(?:yes|allow|approve|trust|proceed)\b/i.test(line));
  if (yesOption >= 0) {
    const question = [...lines.slice(0, yesOption)].reverse().find((line) => line.endsWith("?") || /trust|allow|proceed|permission|confirm/i.test(line));
    return cleanPromptLine(question ?? lines[yesOption]);
  }

  return null;
}

function cleanPromptLine(line: string): string {
  const cleaned = line.replace(/^[│╭╰─❯>*•\s]+|[│╭╰─\s]+$/g, "").trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 139).trimEnd()}…` : cleaned;
}

export interface KeyAction {
  data: string;
  label: string;
  interrupts?: boolean;
}

/**
 * Turn a `key` step's `prompt` into the exact bytes to write to the PTY. On numbered TUI menus
 * where option 1 is already highlighted ("❯ 1. Yes"), "yes" presses Enter; on y/n prompts, "y\r".
 */
export function keySequenceFor(said: string | undefined, screen = ""): KeyAction | null {
  const raw = (said ?? "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[.!]+$/g, "").trim();
  const tail = screen.split(/\r?\n/).slice(-18).join("\n");
  const numberedMenu = /(?:[❯>*]\s*)?1[.)]\s*(?:yes|allow|approve|trust|proceed)\b/i.test(tail);

  if (/^(?:y|yes|yep|yeah|ok|okay|approve|allow|confirm|trust|proceed|accept)$/.test(key)) {
    return { data: numberedMenu ? "\r" : "y\r", label: "Yes" };
  }
  if (/^(?:n|no|nope|deny|reject|decline|dont|don't)$/.test(key)) {
    const hasOptionTwo = /\b2[.)]\s*(?:no|deny|reject|cancel|don't|do not)\b/i.test(tail);
    return { data: numberedMenu && hasOptionTwo ? "2\r" : "n\r", label: "No" };
  }
  if (/^(?:enter|return)$/.test(key)) return { data: "\r", label: "Enter" };
  if (/^(?:esc|escape)$/.test(key)) return { data: "\x1b", label: "Escape" };
  if (/^(?:ctrl\+c|ctrl-c|control\+c|interrupt|sigint)$/.test(key)) return { data: "\x03", label: "Ctrl+C", interrupts: true };
  if (/^tab$/.test(key)) return { data: "\t", label: "Tab" };
  if (/^up$/.test(key)) return { data: "\x1b[A", label: "Up" };
  if (/^down$/.test(key)) return { data: "\x1b[B", label: "Down" };
  if (/^[1-9]$/.test(key)) return { data: `${key}\r`, label: `Option ${key}` };
  return null;
}

const DESTRUCTIVE_SHELL =
  /(?:^|[;&|]\s*|\s)(?:sudo|su|rm|rmdir|mkfs|dd|kill|pkill|killall|shutdown|reboot|poweroff)\b|\bgit\s+(?:reset\s+--hard|clean\b|push\s+(?:--force|-f)\b|branch\s+-D\b|checkout\s+--\s*\.|restore\s+\.)/;

/**
 * Whether a `shell` step can run at once during a voice call without asking for Go: opening a
 * blank shell, creating folders, running tests/builds, or checking git is safe; deleting files,
 * force-pushing, hard-resetting, or sudo waits for Go.
 */
export function isSafeShellCommand(command: string | undefined): boolean {
  const text = (command ?? "").trim();
  if (!text) return true;
  return !DESTRUCTIVE_SHELL.test(text);
}

export type WorkbenchAction =
  | { op: "mkdir"; folder: string }
  | { op: "branch"; branch: string }
  | { op: "browser-open"; url: string }
  | { op: "browser-cmd"; command: "reload" | "back" | "forward" | "stop" }
  | { op: "side"; tab: "files" | "browser" | "close" }
  | { op: "pane"; action: "split-right" | "split-down" | "zoom" | "close" }
  | { op: "diff"; target: string }
  | { op: "mark-reviewed" };

export function normalizePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/\S*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^:\d{2,5}(?:\/\S*)?$/.test(trimmed)) return `http://localhost${trimmed}`;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

/**
 * Parse a `workbench` step into a concrete VibeForge UI/workspace operation, or null when unclear.
 */
export function parseWorkbenchAction(input: { prompt?: string; target?: string; folder?: string; branch?: string }): WorkbenchAction | null {
  const action = (input.prompt ?? "").trim();
  const lower = action.toLowerCase().replace(/[.!]+$/g, "").trim();
  const target = (input.target ?? "").trim();
  const folder = (input.folder ?? "").trim();
  const branch = (input.branch ?? "").trim();

  if (/^(?:mark[- ]?reviewed|mark all reviewed|clear inbox|review all)$/.test(lower)) {
    return { op: "mark-reviewed" };
  }
  if (/^(?:mkdir|make[- ]?folder|create[- ]?folder|new[- ]?folder|folder)$/.test(lower) || (!lower && folder)) {
    const dir = folder || target;
    return dir ? { op: "mkdir", folder: dir } : null;
  }
  if (lower.startsWith("mkdir ")) {
    const dir = folder || action.slice(6).trim();
    return dir ? { op: "mkdir", folder: dir } : null;
  }
  if (/^(?:branch|open[- ]?branch|checkout|switch[- ]?branch)$/.test(lower) || (!lower && branch)) {
    const name = branch || target;
    return name ? { op: "branch", branch: name } : null;
  }
  if (/^(?:reload|refresh|reload[- ]?browser|refresh[- ]?browser|refresh[- ]?preview|reload[- ]?preview)$/.test(lower)) {
    return { op: "browser-cmd", command: "reload" };
  }
  if (/^(?:browser[- ]?back|back)$/.test(lower)) return { op: "browser-cmd", command: "back" };
  if (/^(?:browser[- ]?forward|forward)$/.test(lower)) return { op: "browser-cmd", command: "forward" };
  if (/^(?:browser[- ]?stop|stop[- ]?loading)$/.test(lower)) return { op: "browser-cmd", command: "stop" };
  if (/^(?:files|open[- ]?files|show[- ]?files|side[- ]?files)$/.test(lower)) return { op: "side", tab: "files" };
  if (/^(?:close[- ]?side|hide[- ]?side|close[- ]?panel|hide[- ]?panel|close[- ]?browser|hide[- ]?browser)$/.test(lower)) {
    return { op: "side", tab: "close" };
  }
  if (/^(?:split|split[- ]?right|split[- ]?row|new[- ]?pane)$/.test(lower)) return { op: "pane", action: "split-right" };
  if (/^(?:split[- ]?down|split[- ]?col|split[- ]?below)$/.test(lower)) return { op: "pane", action: "split-down" };
  if (/^(?:zoom|unzoom|maximize|restore|toggle[- ]?zoom)$/.test(lower)) return { op: "pane", action: "zoom" };
  if (/^(?:close[- ]?pane|close[- ]?terminal)$/.test(lower)) return { op: "pane", action: "close" };
  if (/^(?:diff|open[- ]?diff|show[- ]?diff|review)$/.test(lower)) {
    return target ? { op: "diff", target } : null;
  }
  if (/^(?:browser|preview|dock|open[- ]?url|open[- ]?browser|open[- ]?preview)$/.test(lower)) {
    const url = normalizePreviewUrl(target || folder);
    return url ? { op: "browser-open", url } : { op: "side", tab: "browser" };
  }
  if (lower.startsWith("browser ") || lower.startsWith("preview ") || lower.startsWith("open ")) {
    const rest = action.replace(/^(?:browser|preview|open)\s+/i, "").trim();
    const url = normalizePreviewUrl(rest);
    if (url) return { op: "browser-open", url };
  }
  const directUrl = normalizePreviewUrl(action) ?? normalizePreviewUrl(target);
  if (directUrl && (!lower || /^(?:url|http|https|localhost)/.test(lower) || directUrl === normalizePreviewUrl(action))) {
    return { op: "browser-open", url: directUrl };
  }
  return null;
}

/** Whether an `inspect` step asks for plan limits or token usage rather than a workspace, CLI, or copy. */
export function inspectsQuotas(text: string | undefined): boolean {
  return /\b(?:plan[- ]?limits?|limits?|quotas?|token[- ]?usage|tokens?|usage)\b/i.test((text ?? "").trim());
}

/**
 * Distill a CLI's raw first-paragraph summary into natural teammate phrasing for spoken call notes:
 * strips stiff AI self-narration openers ("I have examined…", "Done! I updated…") while keeping
 * concrete outcomes and any question the CLI ended with.
 */
export function teammateSummary(reply: string | null | undefined): string {
  const raw = (reply ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const trimmed = raw
    .replace(/^(?:done[.!]?\s+|summary:\s*|changes(?: made)?:\s*)/i, "")
    .replace(/^(?:i have|i've|i just)\s+(?:completed|finished|updated|implemented|fixed|checked|examined|investigated)\b/i, (match) => {
      const verb = match.split(/\s+/).pop() ?? "";
      return verb ? `${verb[0].toUpperCase()}${verb.slice(1)}` : match;
    })
    .trim();
  return trimmed;
}
