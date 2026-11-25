// Pure helpers shared by the Orchestrator's planner, step validator, and call announcements:
// detecting interactive TUI prompts, translating spoken key answers, checking shell safety,
// parsing workbench actions, and turning raw CLI replies into natural spoken summaries.
// No Node imports here so both the window and the main process can run them.

const APPROVAL_MENU_OPTION = /^(?:[❯>*•]\s*)?1[.)]\s*(?:yes|allow|approve|trust|proceed)\b/i;
const MENU_APPROVAL_WORDS = /\b(?:allow|approve|don't ask again|do not ask again|this command|this edit|always allow|deny|reject)\b/i;

const APPROVAL_LINE_PATTERNS: RegExp[] = [
  /do you want to (?:proceed|continue|allow|run|make this edit|create|overwrite)[^?\n]*\??/i,
  /\ballow [^\n]{1,160}\?/i,
  /[^\n]*\((?:y\/n|yes\/no)\)[^\n]*/i,
  /[^\n]*\[(?:y\/n|Y\/n|y\/N)\][^\n]*/i,
];

const TRUST_LINE_PATTERNS: RegExp[] = [
  /^(?:quick safety check:\s*)?(?:do you trust (?:the files in |the contents of )?this (?:folder|directory|workspace|project)|trust (?:the files in |the contents of )?this (?:folder|directory|workspace|project))[?.!]?$/i,
];

const LOGIN_LINE_PATTERN = /^(?:session expired\.\s*)?((?:please\s+)?(?:run \/login|sign in|log in)\b[^\n]*)$/i;

function matchPattern(line: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match) return cleanPromptLine(match[0]);
  }
  return null;
}

/**
 * Inspect the bottom of a quiet terminal's screen for an interactive TUI prompt waiting on a
 * person (folder trust, tool approval, y/n confirmation, sign-in). Null when at a normal prompt.
 */
export function detectWaitingPrompt(screen: string): string | null {
  if (!screen.trim()) return null;
  const lines = screen
    .split(/\r?\n/)
    .map((line) => cleanPromptLine(line.replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .slice(-18);
  if (!lines.length) return null;

  // Check the bottom-most numbered confirmation menu first, inspecting only the 1-2 lines
  // directly above option 1 so trust words inside an earlier command payload can't mask an approval.
  let yesOption = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (APPROVAL_MENU_OPTION.test(lines[i])) {
      yesOption = i;
      break;
    }
  }
  if (yesOption >= 0) {
    const menuHasApproval = lines.slice(yesOption, yesOption + 4).some((line) => MENU_APPROVAL_WORDS.test(line));
    const above = lines.slice(Math.max(0, yesOption - 2), yesOption);
    for (let i = above.length - 1; i >= 0; i--) {
      const approval = matchPattern(above[i], APPROVAL_LINE_PATTERNS);
      if (approval) return approval;
    }
    if (!menuHasApproval) {
      for (let i = above.length - 1; i >= 0; i--) {
        const trust = matchPattern(above[i], TRUST_LINE_PATTERNS);
        if (trust) return trust;
        if (above[i].endsWith("?") && /\b(?:allow|proceed|permission|confirm)\b/i.test(above[i])) return above[i];
      }
    }
    return lines[yesOption];
  }

  // Without a numbered menu, scan bottom-to-top for approval prompts first, then anchored trust or sign-in.
  for (let i = lines.length - 1; i >= 0; i--) {
    const approval = matchPattern(lines[i], APPROVAL_LINE_PATTERNS);
    if (approval) return approval;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const trust = matchPattern(lines[i], TRUST_LINE_PATTERNS);
    if (trust) return trust;
    const login = LOGIN_LINE_PATTERN.exec(lines[i]);
    if (login) return cleanPromptLine(login[1]);
  }

  return null;
}

function cleanPromptLine(line: string): string {
  const cleaned = line.replace(/^[│┃╭╮╰╯┌┐└┘─❯>*•═\s]+|[│┃╭╮╰╯┌┐└┘─═\s]+$/g, "").trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 139).trimEnd()}…` : cleaned;
}

const APPROVAL_WORDING = /do you want to |\ballow |\((?:y\/n|yes\/no)\)|\[(?:y\/n|Y\/n|y\/N)\]|^(?:[❯>*•]\s*)?[1-9][.)]\s*(?:yes|allow|approve|proceed)\b|\b(?:don't ask again|do not ask again|this command|this edit|always allow|overwrite)\b/i;

/** Whether a waiting prompt explicitly matches a benign folder-trust or sign-in prompt. */
export function isFreeWaitingPrompt(waiting: string | undefined): boolean {
  const text = (waiting ?? "").trim();
  if (!text) return false;
  const prompt = text.includes("\n") ? detectWaitingPrompt(text) : cleanPromptLine(text);
  if (!prompt || APPROVAL_WORDING.test(prompt)) return false;
  return TRUST_LINE_PATTERNS.some((pattern) => pattern.test(prompt)) || LOGIN_LINE_PATTERN.test(prompt);
}

/** Whether a detected waiting prompt or screen asks to approve a tool, command or edit (not folder trust or sign-in). */
export function isApprovalPrompt(waitingOrScreen: string): boolean {
  const text = waitingOrScreen.trim();
  if (!text) return false;
  const prompt = detectWaitingPrompt(text) ?? cleanPromptLine(text);
  if (!prompt || isFreeWaitingPrompt(prompt)) return false;
  return /do you want to |allow |\((?:y\/n|yes\/no)\)|\[(?:y\/n|Y\/n|y\/N)\]|(?:^|\n)\s*(?:[❯>*•]\s*)?[1-9][.)]\s*(?:yes|allow|approve|proceed)\b|\?$/i.test(
    prompt,
  );
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
function isLocalPath(token: string): boolean {
  if (!token || token.startsWith("/") || token.startsWith("~") || token.startsWith("-")) return false;
  return !token.split("/").includes("..");
}

const PKG_RUN_SCRIPT = /^(?:test|build|lint|typecheck|check)(?::[\w.-]+)?$/;
const PKG_FLAGS = new Set(["-s", "-q", "--silent", "--quiet", "--run", "--if-present", "--noEmit", "--ci", "--watch=false", "--watchAll=false", "--no-cache"]);
const CARGO_FLAGS = new Set(["-q", "--quiet", "-v", "--verbose", "--workspace", "--all-targets", "--tests", "--lib", "--bins", "--offline", "--locked", "--frozen", "--no-run", "--keep-going"]);
const GO_FLAGS = new Set(["-v", "-race", "-short", "-failfast", "-json", "-cover"]);
const PYTEST_FLAGS = new Set(["-q", "--quiet", "-v", "--verbose", "-x", "--exitfirst", "--no-header", "--collect-only", "--co", "--tb=short", "--tb=line", "--tb=no"]);
const GIT_FLAGS: Record<"status" | "log" | "diff" | "show" | "rev-parse", ReadonlySet<string>> = {
  status: new Set(["-s", "--short", "-b", "--branch", "--porcelain", "-uno", "-uall", "-u", "--untracked-files"]),
  log: new Set(["--oneline", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--graph", "--decorate", "--no-merges", "--first-parent", "--all", "--abbrev-commit", "--reverse"]),
  diff: new Set(["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--cached", "--staged", "--check", "--color=never", "--no-ext-diff"]),
  show: new Set(["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--oneline", "--no-patch", "-s", "--no-ext-diff"]),
  "rev-parse": new Set(["--short", "--abbrev-ref", "--show-toplevel", "--git-dir", "--is-inside-work-tree", "--verify", "-q", "--quiet", "--show-prefix"]),
};
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current"]);
const CAT_FLAGS = new Set(["-n", "-b", "-s", "-T", "-E", "--number"]);
const WC_FLAGS = new Set(["--lines", "--words", "--bytes", "--chars"]);
const LS_FLAGS = new Set(["--all", "--almost-all", "--directory", "--human-readable", "--classify"]);
const TREE_FLAGS = new Set(["--dirsfirst", "--noreport"]);

function isSafeGitArg(token: string, afterDashDash: boolean): boolean {
  if (!token || !/^[\w./~^@:-]+$/.test(token)) return false;
  if (afterDashDash) return isLocalPath(token);
  if (token.startsWith("-") || token.startsWith("/") || token.startsWith("~") || token.startsWith("..")) return false;
  if (token.split("/").includes("..") || /[/:]~/.test(token)) return false;
  const colon = token.indexOf(":");
  if (colon !== -1) {
    const rev = token.slice(0, colon);
    const objPath = token.slice(colon + 1);
    if (rev && !isSafeGitArg(rev, false)) return false;
    return isLocalPath(objPath);
  }
  return true;
}

function isSafeGitSub(sub: string, args: string[]): boolean {
  if (sub === "remote") return args.length === 1 && args[0] === "-v";
  if (sub === "branch") return args.every((t) => GIT_BRANCH_FLAGS.has(t));
  if (!(sub in GIT_FLAGS)) return false;
  const subKey = sub as keyof typeof GIT_FLAGS;
  const flags = GIT_FLAGS[subKey];
  let afterDashDash = false;
  for (const token of args) {
    if (!afterDashDash && token === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && token.startsWith("-")) {
      if (flags.has(token)) continue;
      if (subKey === "log" && /^(?:-\d+|-n\d+|--max-count=\d+)$/.test(token)) continue;
      if (subKey === "diff" && /^-U\d+$/.test(token)) continue;
      return false;
    }
    if (!isSafeGitArg(token, afterDashDash)) return false;
  }
  return true;
}

function isSafeShellPart(part: string): boolean {
  if (part === "pwd" || part === "git --version" || part === "node --version") return true;
  const [cmd, ...rest] = part.split(/\s+/);
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "bun") {
    const [sub, ...args] = rest;
    if (!sub) return false;
    let tail = args;
    if (sub === "run") {
      if (!args[0] || !PKG_RUN_SCRIPT.test(args[0])) return false;
      tail = args.slice(1);
    } else if (!/^(?:test|t|build|lint|typecheck|check)$/.test(sub)) {
      return false;
    }
    return tail.every((t, i) => (t === "--" && i < tail.length - 1) || PKG_FLAGS.has(t));
  }
  if (cmd === "cargo") {
    const [sub, ...args] = rest;
    return !!sub && /^(?:test|build|check|clippy)$/.test(sub) && args.every((t) => CARGO_FLAGS.has(t));
  }
  if (cmd === "go") {
    const [sub, ...args] = rest;
    return !!sub && /^(?:test|build|vet)$/.test(sub) && args.every((t) => (t.startsWith("-") ? GO_FLAGS.has(t) || /^-count=\d+$/.test(t) : isLocalPath(t)));
  }
  if (cmd === "pytest" || ((cmd === "python" || cmd === "python3") && rest[0] === "-m" && rest[1] === "pytest")) {
    const args = cmd === "pytest" ? rest : rest.slice(2);
    return args.every((t) => (t.startsWith("-") ? PYTEST_FLAGS.has(t) || /^--maxfail=\d+$/.test(t) : isLocalPath(t)));
  }
  if (cmd === "git") {
    const [sub, ...args] = rest;
    return !!sub && isSafeGitSub(sub, args);
  }
  if (cmd === "mkdir") {
    const args = rest[0] === "-p" || rest[0] === "--parents" ? rest.slice(1) : rest;
    return args.length > 0 && args.every(isLocalPath);
  }
  if (cmd === "ls" || cmd === "cat" || cmd === "wc" || cmd === "head" || cmd === "tail" || cmd === "tree") {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (!t.startsWith("-")) {
        if (!isLocalPath(t)) return false;
        continue;
      }
      if (cmd === "ls" && (LS_FLAGS.has(t) || /^-[alh1trSRdF]+$/.test(t))) continue;
      if (cmd === "cat" && CAT_FLAGS.has(t)) continue;
      if (cmd === "wc" && (WC_FLAGS.has(t) || /^-[lwcL]+$/.test(t))) continue;
      if ((cmd === "head" || cmd === "tail") && (/^-(?:\d+|n\d+|-lines=\d+|q|-quiet)$/.test(t) || (t === "-n" && /^\d+$/.test(rest[++i] ?? "")))) continue;
      if (cmd === "tree" && (TREE_FLAGS.has(t) || /^-(?:[acdfghlpqrstuDFQ]+|L\d+)$/.test(t) || (t === "-L" && /^\d+$/.test(rest[++i] ?? "")))) continue;
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Whether a `shell` step can run without asking for Go (in a call, or in "Just go"): a blank shell,
 * or commands each on the list above joined by `&&`. Anything else waits for Go: deleting, moving,
 * installing, pushing, redirecting, piping, substituting, quoting, unknown flags, and every program not named here.
 */
export function isSafeShellCommand(command: string | undefined): boolean {
  const text = (command ?? "").trim();
  if (!text) return true;
  const parts = text.split("&&").map((part) => part.trim());
  return parts.every((part) => part !== "" && !/[;|&<>`$\\(){}\n\r*?!'"]/.test(part) && isSafeShellPart(part));
}

export type WorkbenchAction =
  | { op: "mkdir"; folder: string }
  | { op: "branch"; branch: string }
  | { op: "browser-open"; url: string }
  | { op: "browser-cmd"; command: "reload" | "back" | "forward" | "stop" }
  | { op: "side"; tab: "files" | "browser" | "close" }
  | { op: "pane"; action: "split-right" | "split-down" | "zoom" | "close" | "focus-next" | "focus-prev" }
  | { op: "diff"; target: string }
  | { op: "open-folder" }
  | { op: "check-updates" }
  | { op: "mark-reviewed" }
  | { op: "undo"; token?: string };

/**
 * Whether a page is on this computer (a dev server, say): localhost, 127.x, ::1 or 0.0.0.0, read
 * from the parsed address so `localhost.example.com` or `user@example.com` doesn't pass.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

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
  if (/^(?:focus[- ]?next|next[- ]?pane|next[- ]?terminal|switch[- ]?pane)$/.test(lower)) return { op: "pane", action: "focus-next" };
  if (/^(?:focus[- ]?prev|prev[- ]?pane|previous[- ]?pane|previous[- ]?terminal)$/.test(lower)) return { op: "pane", action: "focus-prev" };
  if (/^(?:open[- ]?folder|reveal[- ]?folder|file[- ]?manager|show[- ]?in[- ]?files|xdg[- ]?open)$/.test(lower)) return { op: "open-folder" };
  if (/^(?:check[- ]?updates|check[- ]?for[- ]?updates|updates[- ]?check)$/.test(lower)) return { op: "check-updates" };
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
