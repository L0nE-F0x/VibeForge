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
    if (!numberedMenu) return { data: "n\r", label: "No" };
    // The menu's own "No" wherever it is (Claude Code's is 3, after two kinds of Yes). Without one,
    // Escape: "n" does nothing in such a menu and the Enter after it would take the highlighted Yes.
    const no = /(?:^|\n|\s)([1-9])[.)]\s*(?:no|deny|reject|cancel|don't|do not)\b/i.exec(tail);
    return no ? { data: `${no[1]}\r`, label: "No" } : { data: "\x1b", label: "No" };
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

/** A path argument that stays inside the folder: not a flag, not absolute, not from home, never climbing out. */
const LOCAL_PATH = String.raw`(?!/|~|-|\.\.(?:/|\s|$))(?![^\s]*/\.\.(?:/|\s|$))[^\s]+`;
/**
 * The commands a `shell` step may run without a Go, each one whole: tests, builds and checks through
 * the project's own scripts, git that only reads, and listing, reading or making folders in this one.
 */
const SAFE_SHELL = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:test|t|build|lint|typecheck|check|run\s+(?:test|build|lint|typecheck|check)(?::[\w.-]+)?)(?:\s+--?[\w=.:-]+)*$/,
  /^(?:cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)(?:\s+\.\/\.\.\.)?|pytest|python3?\s+-m\s+pytest)(?:\s+--?[\w=.:-]+)*$/,
  /^git\s+(?:status|log|diff|show|rev-parse)(?:\s+(?!--output)[\w./~^@:=-]+)*$/,
  /^git\s+(?:remote\s+-v|branch(?:\s+(?:-a|-r|-v|-vv|--list|--show-current))*)$/,
  new RegExp(String.raw`^(?:ls|cat|head|tail|wc)(?:\s+-[\w-]+)*(?:\s+${LOCAL_PATH})*$`),
  // tree -o / --output writes a file, so keep those flags off the auto-run list.
  new RegExp(String.raw`^tree(?:\s+-(?:[a-np-zA-NP-Z0-9]+|-(?!output\b)[\w=-]+))*(?:\s+${LOCAL_PATH})*$`),
  new RegExp(String.raw`^mkdir(?:\s+-p)?(?:\s+${LOCAL_PATH})+$`),
  /^(?:pwd|git\s+--version|node\s+--version)$/,
];

/**
 * Whether a `shell` step can run without asking for Go (in a call, or in "Just go"): a blank shell,
 * or commands each on the list above joined by `&&`. Anything else waits for Go: deleting, moving,
 * installing, pushing, redirecting, piping, substituting, quoting, and every program not named here.
 */
export function isSafeShellCommand(command: string | undefined): boolean {
  const text = (command ?? "").trim();
  if (!text) return true;
  const parts = text.split("&&").map((part) => part.trim());
  return parts.every((part) => part !== "" && !/[;|&<>`$\\(){}\n\r*?!'"]/.test(part) && SAFE_SHELL.some((pattern) => pattern.test(part)));
}

export type WorkbenchAction =
  | { op: "mkdir"; folder: string }
  | { op: "branch"; branch: string }
  | { op: "browser-open"; url: string }
  | { op: "browser-cmd"; command: "reload" | "back" | "forward" | "stop" }
  | { op: "side"; tab: "files" | "browser" | "close" }
  | { op: "pane"; action: "split-right" | "split-down" | "zoom" | "close" }
  | { op: "diff"; target: string }
  | { op: "mark-reviewed" }
  | { op: "undo"; token?: string };

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
export function parseWorkbenchAction(input: { action?: string; prompt?: string; target?: string; folder?: string; branch?: string }): WorkbenchAction | null {
  const action = (input.prompt || input.action || "").trim();
  const lower = action.toLowerCase().replace(/[.!]+$/g, "").trim();
  const target = (input.target ?? "").trim();
  const folder = (input.folder ?? "").trim();
  const branch = (input.branch ?? "").trim();

  if (/^(?:undo|undo[- ]?delete|undo[- ]?last|restore[- ]?deleted)$/.test(lower)) {
    return target ? { op: "undo", token: target } : { op: "undo" };
  }
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
  // Only when that is all it says ("limits", "plan limits and token usage"): "the rate limit handling"
  // or src/usage.ts is a file or a screen to look at, not the person's plan.
  const words = (text ?? "").trim().toLowerCase().split(/[\s,/&+-]+/).filter(Boolean);
  if (!words.some((word) => /^(?:limits?|quotas?|tokens?|usage)$/.test(word))) return false;
  return words.every((word) => /^(?:plan|plans|limits?|quotas?|tokens?|usage|rate|and|my|the|current|left|remaining)$/.test(word));
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
