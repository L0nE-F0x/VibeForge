// Shared diff parsing, folding rules, light syntax tokenizing, and review notes formatting.
// Browser-safe: no Node built-ins.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

const LARGE_FILE_LINES = 300;
const LARGE_FILE_CHANGES = 250;
const AUTO_EXPAND_LINE_BUDGET = 2500;
const MAX_TOKENIZE_LINE = 500;

const LOCK_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "composer.lock",
  "go.sum",
  "podfile.lock",
  "pubspec.lock",
  "flake.lock",
  "mix.lock",
  "gradle.lockfile",
  "packages.lock.json",
]);

export type FoldReason = "lock" | "large" | "binary" | "many";
export type FileChangeStatus = "added" | "deleted" | "renamed" | "modified";

export interface PatchFile {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  binary: boolean;
  added: number;
  removed: number;
  lineCount: number;
  headerLine: number;
  raw: string;
  startFolded: boolean;
  foldReason: FoldReason | null;
}

export interface ParsedPatch {
  files: PatchFile[];
  /** Top-level `# ...` notes emitted by VibeForge's diff capture (truncation, skipped files, etc.). */
  notes: string[];
}

export type DiffRow =
  | { kind: "hunk"; text: string; oldNo: null; newNo: null }
  | { kind: "add"; code: string; oldNo: null; newNo: number }
  | { kind: "del"; code: string; oldNo: number; newNo: null }
  | { kind: "ctx"; code: string; oldNo: number; newNo: number }
  | { kind: "meta"; text: string; oldNo: null; newNo: null };

export type SyntaxLang = "js" | "py" | "rs" | "sh" | "json" | "css" | "html" | "sql" | "md" | "plain";
export type TokenKind = "kw" | "str" | "com" | "num" | "ty";

export interface DiffToken {
  kind?: TokenKind;
  text: string;
}

export interface LineNote {
  id: string;
  path: string;
  line: number;
  side: "new" | "old";
  code?: string;
  body: string;
}

/** Decode a git C-quoted path (`"..."` with octal UTF-8 escapes) into a plain path string. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const escaped: Record<string, number> = { t: 9, n: 10, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\" || i + 1 >= inner.length) {
      for (const b of utf8Encoder.encode(inner[i])) bytes.push(b);
      continue;
    }
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
      continue;
    }
    i += 1;
    const mapped = escaped[inner[i]];
    if (mapped !== undefined) bytes.push(mapped);
    else for (const b of utf8Encoder.encode(inner[i])) bytes.push(b);
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

function stripGitPrefix(token: string, prefix: "a/" | "b/"): string {
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

function readHeaderToken(rest: string, start: number): { value: string; next: number } | null {
  let i = start;
  while (i < rest.length && rest[i] === " ") i += 1;
  if (i >= rest.length) return null;
  if (rest[i] === '"') {
    let j = i + 1;
    while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
    if (j >= rest.length) return null;
    return { value: unquoteGitPath(rest.slice(i, j + 1)), next: j + 1 };
  }
  const nextQuote = rest.indexOf(' "', i);
  if (nextQuote >= 0) return { value: rest.slice(i, nextQuote), next: nextQuote + 1 };
  const space = rest.indexOf(" ", i);
  if (space < 0) return { value: rest.slice(i), next: rest.length };
  return { value: rest.slice(i, space), next: space };
}

function parseHeader(line: string, strict: boolean): { oldPath: string; path: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  if (rest.includes('"')) {
    const first = readHeaderToken(rest, 0);
    const second = first ? readHeaderToken(rest, first.next) : null;
    if (first && second && (!strict || second.value.startsWith("b/"))) {
      return { oldPath: stripGitPrefix(first.value, "a/"), path: stripGitPrefix(second.value, "b/") };
    }
    if (strict && rest.startsWith('"')) return null;
  }
  let pos = rest.indexOf(" b/");
  let fallback: { oldPath: string; path: string } | null = null;
  while (pos >= 0 && rest.startsWith("a/")) {
    const oldPath = rest.slice(2, pos);
    const nextPath = rest.slice(pos + 3);
    if (oldPath === nextPath) return { oldPath, path: nextPath };
    fallback = { oldPath, path: nextPath };
    pos = rest.indexOf(" b/", pos + 1);
  }
  if (fallback || strict) return fallback;
  return { oldPath: rest, path: rest };
}

/** Parse a `diff --git a/... b/...` header, handling spaces, `" b/"` inside names, and C-quoted paths. */
export function parseDiffGitHeader(line: string): { oldPath: string; path: string } | null {
  return parseHeader(line, false);
}

/** The file a `diff --git` header names on its `b/` side, or null when the line isn't one git wrote. */
export function diffHeaderTarget(line: string): string | null {
  return parseHeader(line, true)?.path ?? null;
}

/** The files a patch touches, from its `diff --git` headers. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const file = diffHeaderTarget(line);
    if (file) files.add(file);
  }
  return [...files];
}

/** True for lockfiles and generated minified/sourcemap files that start folded in review. */
export function isLockFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (!base) return false;
  if (LOCK_BASENAMES.has(base)) return true;
  if (/\.lock$/i.test(base) || /-lock\.(json|ya?ml)$/i.test(base)) return true;
  return /\.(min\.(js|css)|map)$/i.test(base);
}

interface RawPatchFile {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  binary: boolean;
  added: number;
  removed: number;
  lineCount: number;
  headerLine: number;
  startOffset: number;
  endOffset: number;
  inHunks: boolean;
  inBinary: boolean;
}

/**
 * Split a unified git patch into per-file sections in one linear pass without parsing individual
 * diff lines up front, so 70+ files and multi-megabyte patches stay fast.
 */
export function splitPatch(text: string): ParsedPatch {
  if (!text) return { files: [], notes: [] };
  const rawFiles: RawPatchFile[] = [];
  const notes: string[] = [];
  let cur: RawPatchFile | null = null;
  let pos = 0;
  let lineIndex = 0;

  const finishCurrent = (endOffset: number) => {
    if (!cur) return;
    cur.endOffset = endOffset;
    rawFiles.push(cur);
    cur = null;
  };

  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const rawLine = text.slice(pos, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const nextPos = nl < 0 ? text.length : nl + 1;

    if (line.startsWith("diff --git ")) {
      finishCurrent(pos);
      const header = parseDiffGitHeader(line)!;
      const renamed = header.oldPath !== header.path;
      cur = {
        path: header.path,
        oldPath: renamed ? header.oldPath : null,
        status: renamed ? "renamed" : "modified",
        binary: false,
        added: 0,
        removed: 0,
        lineCount: 1,
        headerLine: lineIndex,
        startOffset: pos,
        endOffset: nextPos,
        inHunks: false,
        inBinary: false,
      };
    } else if (line.startsWith("# ")) {
      finishCurrent(pos);
      notes.push(line.slice(2));
    } else if (cur) {
      cur.lineCount += 1;
      cur.endOffset = nextPos;
      if (!cur.inHunks && !cur.inBinary) {
        if (line.startsWith("new file mode ")) cur.status = "added";
        else if (line.startsWith("deleted file mode ")) cur.status = "deleted";
        else if (line.startsWith("rename from ")) {
          cur.status = "renamed";
          cur.oldPath = unquoteGitPath(line.slice("rename from ".length));
        } else if (line.startsWith("rename to ")) {
          cur.status = "renamed";
          cur.path = unquoteGitPath(line.slice("rename to ".length));
          if (cur.oldPath === cur.path) cur.oldPath = null;
        } else if (line === "GIT binary patch" || /^Binary files .* differ$/.test(line)) {
          cur.binary = true;
          cur.inBinary = true;
        } else if (line.startsWith("@@ ")) {
          cur.inHunks = true;
        }
      } else if (cur.inHunks && !cur.inBinary) {
        if (line.startsWith("+")) cur.added += 1;
        else if (line.startsWith("-")) cur.removed += 1;
      }
    }

    if (nl < 0) break;
    pos = nl + 1;
    lineIndex += 1;
  }

  finishCurrent(text.length);

  let unfoldedBudget = 0;
  const files: PatchFile[] = rawFiles.map((file) => {
    let foldReason: FoldReason | null = null;
    if (file.binary) foldReason = "binary";
    else if (isLockFile(file.path)) foldReason = "lock";
    else if (file.lineCount > LARGE_FILE_LINES || file.added + file.removed > LARGE_FILE_CHANGES) foldReason = "large";
    else if (unfoldedBudget > 0 && unfoldedBudget + file.lineCount > AUTO_EXPAND_LINE_BUDGET) foldReason = "many";
    if (!foldReason) unfoldedBudget += file.lineCount;
    return {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      binary: file.binary,
      added: file.added,
      removed: file.removed,
      lineCount: file.lineCount,
      headerLine: file.headerLine,
      raw: text.slice(file.startOffset, file.endOffset),
      startFolded: foldReason !== null,
      foldReason,
    };
  });

  return { files, notes };
}

/** Parse one file's patch slice lazily into display rows with old/new line numbers. */
export function parseFileDiff(raw: string): DiffRow[] {
  if (!raw) return [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const rows: DiffRow[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let hasHunks = false;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "GIT binary patch") {
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      return rows;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        inHunk = true;
        hasHunks = true;
        rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
        continue;
      }
    }
    if (!inHunk) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        continue;
      }
      if (/^Binary files .* differ$/.test(line) || line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("rename ") || line.startsWith("similarity ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) {
        rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      }
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", code: line.slice(1), oldNo: null, newNo: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", code: line.slice(1), oldNo: oldLine, newNo: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", code: line.slice(1), oldNo: oldLine, newNo: newLine });
      oldLine += 1;
      newLine += 1;
    } else if (line === "") {
      rows.push({ kind: "ctx", code: "", oldNo: oldLine, newNo: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  // Once hunks are present, keep mode/rename header clutter out unless there are no hunks (e.g. mode-only or empty file).
  if (hasHunks) {
    return rows.filter(
      (row) =>
        row.kind !== "meta" ||
        row.text.startsWith("\\") ||
        row.text.startsWith("old mode ") ||
        row.text.startsWith("new mode "),
    );
  }
  return rows;
}

/** Pick a light syntax mode from a file path. */
export function syntaxLang(filePath: string): SyntaxLang {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base === "makefile" || base.endsWith(".mk")) return "sh";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
    case "pyi":
      return "py";
    case "rs":
    case "go":
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "java":
    case "kt":
    case "kts":
    case "swift":
    case "zig":
    case "cs":
      return "rs";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "yml":
    case "yaml":
    case "toml":
    case "ini":
    case "conf":
    case "env":
      return "sh";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "html";
    case "sql":
      return "sql";
    case "md":
    case "mdx":
      return "md";
    default:
      return "plain";
  }
}

const KEYWORDS: Record<Exclude<SyntaxLang, "plain" | "md" | "html">, Set<string>> = {
  js: new Set([
    "import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else",
    "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw",
    "new", "async", "await", "type", "interface", "class", "extends", "implements", "enum", "true",
    "false", "null", "undefined", "void", "typeof", "keyof", "as", "in", "of", "readonly", "override",
  ]),
  py: new Set([
    "import", "from", "as", "def", "return", "if", "elif", "else", "for", "while", "break", "continue",
    "try", "except", "finally", "raise", "with", "class", "pass", "yield", "async", "await", "lambda",
    "and", "or", "not", "in", "is", "True", "False", "None", "self",
  ]),
  rs: new Set([
    "fn", "let", "mut", "const", "pub", "use", "mod", "struct", "enum", "impl", "trait", "for", "in",
    "while", "loop", "if", "else", "match", "return", "break", "continue", "async", "await", "type",
    "where", "func", "package", "import", "var", "defer", "go", "select", "case", "switch", "default",
    "class", "interface", "extends", "static", "void", "true", "false", "nil", "null", "nullptr",
  ]),
  sh: new Set([
    "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function",
    "return", "export", "local", "readonly", "true", "false", "null", "yes", "no", "on", "off",
  ]),
  json: new Set(["true", "false", "null"]),
  css: new Set(["important", "from", "to", "and", "or", "not", "only", "none", "auto", "inherit"]),
  sql: new Set([
    "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table",
    "alter", "drop", "index", "join", "left", "right", "inner", "on", "group", "by", "order", "limit",
    "as", "and", "or", "not", "null", "is", "in", "exists", "primary", "key", "if", "begin", "commit",
  ]),
};

function pushToken(out: DiffToken[], text: string, kind?: TokenKind): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push(kind ? { kind, text } : { text });
}

function scanQuoted(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === "\\") i += 2;
    else if (code[i] === quote) return i + 1;
    else i += 1;
  }
  return code.length;
}

/** Light, single-line tokenizer mapped onto theme tokens; skips lines over 500 chars. */
export function tokenizeLine(code: string, lang: SyntaxLang): DiffToken[] {
  if (!code) return [];
  if (lang === "plain" || code.length > MAX_TOKENIZE_LINE) return [{ text: code }];
  const out: DiffToken[] = [];

  if (lang === "md") {
    if (/^\s*#{1,6}\s/.test(code)) return [{ kind: "kw", text: code }];
    if (/^\s*>/.test(code)) return [{ kind: "com", text: code }];
    let i = 0;
    while (i < code.length) {
      if (code[i] === "`") {
        const end = code.indexOf("`", i + 1);
        if (end > i) {
          pushToken(out, code.slice(i, end + 1), "str");
          i = end + 1;
          continue;
        }
      }
      pushToken(out, code[i]);
      i += 1;
    }
    return out;
  }

  if (lang === "html") {
    let i = 0;
    while (i < code.length) {
      if (code.startsWith("<!--", i)) {
        const end = code.indexOf("-->", i + 4);
        const stop = end < 0 ? code.length : end + 3;
        pushToken(out, code.slice(i, stop), "com");
        i = stop;
      } else if (code[i] === '"' || code[i] === "'") {
        const stop = scanQuoted(code, i, code[i]);
        pushToken(out, code.slice(i, stop), "str");
        i = stop;
      } else if (code[i] === "<") {
        const tag = /^<\/?[A-Za-z][A-Za-z0-9:_-]*/.exec(code.slice(i));
        if (tag) {
          pushToken(out, tag[0], "kw");
          i += tag[0].length;
        } else {
          pushToken(out, code[i]);
          i += 1;
        }
      } else {
        pushToken(out, code[i]);
        i += 1;
      }
    }
    return out;
  }

  const kw = KEYWORDS[lang];
  const lineHashComment = lang === "py" || lang === "sh";
  const lineSlashComment = lang === "js" || lang === "rs" || lang === "css";
  const lineDashComment = lang === "sql";
  const blockSlashComment = lang === "js" || lang === "rs" || lang === "css" || lang === "sql";
  const allowBacktick = lang === "js" || lang === "sh" || lang === "sql";
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    if (lineHashComment && ch === "#") {
      pushToken(out, code.slice(i), "com");
      break;
    }
    if (lineSlashComment && ch === "/" && code[i + 1] === "/") {
      pushToken(out, code.slice(i), "com");
      break;
    }
    if (lineDashComment && ch === "-" && code[i + 1] === "-") {
      pushToken(out, code.slice(i), "com");
      break;
    }
    if (blockSlashComment && ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      pushToken(out, code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || (allowBacktick && ch === "`")) {
      const stop = scanQuoted(code, i, ch);
      if (lang === "json" && ch === '"' && /^\s*:/.test(code.slice(stop))) {
        pushToken(out, code.slice(i, stop), "ty");
      } else {
        pushToken(out, code.slice(i, stop), "str");
      }
      i = stop;
      continue;
    }
    if (lang === "css" && ch === "@") {
      const rule = /^@[A-Za-z-]+/.exec(code.slice(i));
      if (rule) {
        pushToken(out, rule[0], "kw");
        i += rule[0].length;
        continue;
      }
    }
    if (lang === "css" && ch === "#") {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(code.slice(i));
      if (hex) {
        pushToken(out, hex[0], "num");
        i += hex[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(ch)) {
      const num = /^(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:px|rem|em|vh|vw|ms|s|%)?/.exec(code.slice(i));
      if (num) {
        pushToken(out, num[0], "num");
        i += num[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(i));
      if (ident) {
        const word = ident[0];
        const lookup = lang === "sql" ? word.toLowerCase() : word;
        if (kw.has(lookup)) pushToken(out, word, "kw");
        else if (lang === "css" && /^\s*:/.test(code.slice(i + word.length))) pushToken(out, word, "ty");
        else if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && !/^[A-Z0-9_]+$/.test(word)) pushToken(out, word, "ty");
        else pushToken(out, word);
        i += word.length;
        continue;
      }
    }
    pushToken(out, ch);
    i += 1;
  }

  return out;
}

/** Gather line notes into one plain-text message naming file and line for a coding CLI. */
export function formatReviewNotes(notes: readonly LineNote[], fileOrder?: readonly string[]): string {
  const valid = notes.filter((note) => note.body.trim().length > 0);
  if (!valid.length) return "";
  const order = new Map<string, number>();
  if (fileOrder) {
    for (let index = 0; index < fileOrder.length; index += 1) order.set(fileOrder[index], index);
  }
  const sorted = [...valid].sort((a, b) => {
    const orderA = order.get(a.path) ?? Number.MAX_SAFE_INTEGER;
    const orderB = order.get(b.path) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    if (a.line !== b.line) return a.line - b.line;
    return (a.side === "old" ? 0 : 1) - (b.side === "old" ? 0 : 1);
  });

  const blocks = sorted.map((note) => {
    const snippet = note.code?.trim().replace(/\s+/g, " ").slice(0, 80);
    const context = note.side === "old" ? (snippet ? `removed, \`${snippet}\`` : "removed") : snippet ? `\`${snippet}\`` : "";
    const head = `- ${note.path}:${note.line}${context ? ` (${context})` : ""}`;
    const body = note.body
      .trim()
      .split("\n")
      .map((line) => `  ${line.trimEnd()}`)
      .join("\n");
    return `${head}\n${body}`;
  });
  return `Review notes:\n\n${blocks.join("\n")}`;
}
