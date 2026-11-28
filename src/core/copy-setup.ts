import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git.js";
import { isPathInside } from "./places.js";
import type { WorkspaceCopySetup } from "./types.js";

/** Files brought into a new copy by default when a workspace hasn't overridden them. */
export const DEFAULT_COPY_FILES: readonly string[] = [".env*"];

/** Git-ignored build/package folders skipped when scanning for ignored files unless named explicitly. */
export const MADE_COPY_FOLDERS = new Set([
  "node_modules", "vendor", "dist", "dist-electron", "build", "out", "target", "coverage", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".vite", ".cache", ".parcel-cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".gradle", ".tox", ".claude", ".codex", ".gemini", ".grok", ".cursor", ".agy", ".antigravity", ".opencode", ".crush", ".kimi",
  ".muse", ".pi", ".hermes", ".copilot",
]);

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDE_BYTES = 256 * 1024;
const CP_TIMEOUT_MS = 120_000;

interface CompiledRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
  raw: string;
  segments: string[];
  matchFile: RegExp;
  matchDir: RegExp;
}

/** Normalize a configured folder path relative to the workspace; null when unsafe or empty. */
export function cleanCopyFolderPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\")) return null;
  let clean = trimmed;
  while (clean.startsWith("./")) clean = clean.slice(2);
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  if (!clean || clean.startsWith("/") || clean === "." || clean === "..") return null;
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  if (parts[0] === ".git") return null;
  return parts.join("/");
}

/** Normalize per-workspace copy setup; returns undefined when everything matches defaults. */
export function normalizeCopySetup(raw: unknown): WorkspaceCopySetup | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  let files: string[] | undefined;
  if (Array.isArray(record.files)) {
    const cleaned = parsePatternList(record.files.filter((item): item is string => typeof item === "string"));
    if (!(cleaned.length === DEFAULT_COPY_FILES.length && cleaned.every((p, i) => p === DEFAULT_COPY_FILES[i]))) {
      files = cleaned;
    }
  }
  let folders: string[] | undefined;
  if (Array.isArray(record.folders)) {
    const out: string[] = [];
    for (const item of record.folders) {
      if (typeof item !== "string") continue;
      const clean = cleanCopyFolderPath(item);
      if (clean && !out.includes(clean)) out.push(clean);
    }
    if (out.length) folders = out;
  }
  const command = typeof record.setupCommand === "string" ? record.setupCommand.trim() : "";
  const setupCommand = command || undefined;
  if (files === undefined && !folders && !setupCommand) return undefined;
  return {
    ...(files !== undefined ? { files } : {}),
    ...(folders ? { folders } : {}),
    ...(setupCommand ? { setupCommand } : {}),
  };
}

function parsePatternList(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const parsed = parsePatternLine(raw);
    if (!parsed || seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

/** Strip trailing unescaped whitespace, skip blank/comment lines, and return a clean pattern line. */
function parsePatternLine(rawLine: string): string | null {
  const noCr = rawLine.replace(/\r$/, "");
  // Trim trailing whitespace that isn't backslash-escaped (`foo\ ` keeps its space).
  let end = noCr.length;
  while (end > 0 && (noCr[end - 1] === " " || noCr[end - 1] === "\t")) {
    let slashes = 0;
    for (let i = end - 2; i >= 0 && noCr[i] === "\\"; i -= 1) slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  const line = noCr.slice(0, end);
  if (!line.trim()) return null;
  if (line.startsWith("#")) return null;
  return line;
}

/** Parse a `.worktreeinclude` file (gitignore-style lines) into rule strings. */
export function parseWorktreeInclude(text: string): string[] {
  return parsePatternList(text.split("\n"));
}

/** Read `<repo>/.worktreeinclude` if it is a regular file (or internal symlink) inside `repo`. */
export function readWorktreeInclude(repo: string): string[] {
  const file = path.join(repo, WORKTREE_INCLUDE_FILE);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(file);
  } catch {
    return [];
  }
  try {
    const repoReal = fs.realpathSync(repo);
    if (lstat.isSymbolicLink()) {
      const targetReal = fs.realpathSync(file);
      if (!isPathInside(repoReal, targetReal)) return [];
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_INCLUDE_BYTES) return [];
    return parseWorktreeInclude(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate a gitignore glob into regex source matching POSIX relative paths. */
function globToRegexSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      const prevSlash = i === 0 || glob[i - 1] === "/";
      const nextSlash = glob[i + 2] === "/";
      const atEnd = i + 2 === glob.length;
      if (prevSlash && nextSlash) {
        out += "(?:.+/)?";
        i += 3;
        continue;
      }
      if (prevSlash && atEnd) {
        out += ".*";
        i += 2;
        continue;
      }
      out += ".*";
      i += 2;
      continue;
    }
    if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (glob[i] === "\\") {
      if (i + 1 < glob.length) {
        out += escapeRegex(glob[i + 1]);
        i += 2;
      } else {
        out += "\\\\";
        i += 1;
      }
      continue;
    }
    if (glob[i] === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!") || body.startsWith("^")) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = close + 1;
        continue;
      }
      out += "\\[";
      i += 1;
      continue;
    }
    out += escapeRegex(glob[i]);
    i += 1;
  }
  return out;
}

function unescapeTrailingSpaces(text: string): string {
  return text.replace(/\\([ \t])/g, "$1");
}

function compileRule(rawLine: string): CompiledRule | null {
  let pat = parsePatternLine(rawLine);
  if (!pat) return null;
  let negated = false;
  if (pat.startsWith("!")) {
    negated = true;
    pat = pat.slice(1);
  } else if (pat.startsWith("\\!") || pat.startsWith("\\#")) {
    pat = pat.slice(1);
  }
  pat = unescapeTrailingSpaces(pat);
  if (!pat) return null;

  let dirOnly = false;
  if (pat.endsWith("/") && !pat.endsWith("\\/")) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }
  let anchored = false;
  if (pat.startsWith("/")) {
    anchored = true;
    pat = pat.slice(1);
  }
  if (!pat) return null;

  const hasSlash = pat.includes("/");
  const source = globToRegexSource(pat);
  const fileSource =
    !anchored && !hasSlash
      ? dirOnly
        ? `(?:^|/)${source}/.+`
        : `(?:^|/)${source}(?:$|/.+)`
      : dirOnly
        ? `^${source}/.+`
        : `^${source}(?:$|/.+)`;
  const dirSource =
    !anchored && !hasSlash ? `(?:^|/)${source}(?:$|/.+)` : `^${source}(?:$|/.+)`;

  return {
    negated,
    dirOnly,
    anchored,
    hasSlash,
    raw: pat,
    segments: pat.split("/").filter(Boolean),
    matchFile: new RegExp(fileSource),
    matchDir: new RegExp(dirSource),
  };
}

function compileRules(patterns: readonly string[]): CompiledRule[] {
  return patterns.map(compileRule).filter((rule): rule is CompiledRule => rule !== null);
}

/** Evaluate gitignore-style patterns on a repo-relative POSIX path (last match wins). */
export function matchesCopyPatterns(relPosixPath: string, patterns: readonly string[], isDir = false): boolean {
  const clean = relPosixPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return false;
  const rules = compileRules(patterns);
  return matchesCompiledRules(clean, rules, isDir);
}

function matchesCompiledRules(cleanPath: string, rules: readonly CompiledRule[], isDir: boolean): boolean {
  let matched = false;
  for (const rule of rules) {
    const ok = isDir ? rule.matchDir.test(cleanPath) : rule.matchFile.test(cleanPath);
    if (ok) matched = !rule.negated;
  }
  return matched;
}

/** Whether any positive rule explicitly mentions `part` so a build/cache dir in MADE_COPY_FOLDERS should still be checked. */
function explicitMadeFolderMatch(dirRel: string, positiveRules: readonly CompiledRule[]): boolean {
  const parts = dirRel.replace(/\/+$/, "").split("/").filter(Boolean);
  const made = parts.filter((part) => MADE_COPY_FOLDERS.has(part));
  if (!made.length) return true;
  return positiveRules.some((rule) => made.every((part) => rule.segments.includes(part)));
}

/** Resolve a real tail path for existing or missing nested targets inside a root. */
function realTailInside(rootReal: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  if (!isPathInside(rootReal, resolved)) return false;
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      const joined = tail.length ? path.join(real, ...tail) : real;
      return isPathInside(rootReal, joined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when any ancestor segment between `root` and `relPosixPath` is a symlink (or escapes `rootReal`). */
function parentSegmentsSafe(root: string, rootReal: string, relPosixPath: string, allowInternalSymlinks: boolean): boolean {
  const parts = relPosixPath.split("/").filter(Boolean);
  let cur = path.resolve(root);
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = path.join(cur, parts[i]);
    try {
      const stat = fs.lstatSync(cur);
      if (stat.isSymbolicLink()) {
        if (!allowInternalSymlinks) return false;
        const target = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        if (!realTailInside(rootReal, target)) return false;
      } else if (!stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

function symlinkStaysInside(linkPath: string, rootReal: string): string | null {
  try {
    const rawTarget = fs.readlinkSync(linkPath);
    const lexical = path.resolve(path.dirname(linkPath), rawTarget);
    if (!realTailInside(rootReal, lexical)) return null;
    try {
      const targetReal = fs.realpathSync(linkPath);
      if (!isPathInside(rootReal, targetReal)) return null;
      return path.relative(path.dirname(linkPath), targetReal) || ".";
    } catch {
      return path.relative(path.dirname(linkPath), lexical) || ".";
    }
  } catch {
    return null;
  }
}

function walkIgnoredDirectory(
  repo: string,
  repoReal: string,
  dirRel: string,
  rules: readonly CompiledRule[],
  positiveRules: readonly CompiledRule[],
  skipDirs: ReadonlySet<string>,
  add: (rel: string) => void,
): void {
  if (skipDirs.has(`${dirRel}/`) || !explicitMadeFolderMatch(dirRel, positiveRules)) return;
  const absDir = path.join(repo, ...dirRel.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absDir);
    if (!stat.isDirectory()) return;
    if (!isPathInside(repoReal, fs.realpathSync(absDir))) return;
  } catch {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = `${dirRel}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkIgnoredDirectory(repo, repoReal, rel, rules, positiveRules, skipDirs, add);
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (!symlinkStaysInside(abs, repoReal)) continue;
      if (matchesCompiledRules(rel, rules, false)) add(rel);
      continue;
    }
    if (entry.isFile() && matchesCompiledRules(rel, rules, false)) {
      add(rel);
    }
  }
}

/** Find git-ignored files inside `repo` matching `patterns`, skipping `skipDirs` and symlinks leaving `repo`. */
export async function selectIgnoredFiles(repo: string, patterns: readonly string[], skipDirs: ReadonlySet<string>): Promise<string[]> {
  const rules = compileRules(patterns);
  const positiveRules = rules.filter((rule) => !rule.negated);
  if (!positiveRules.length) return [];

  const repoReal = fs.realpathSync(repo);
  const listed = await runGit(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], { cwd: repo });
  if (listed.code !== 0) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (!seen.has(rel)) {
      seen.add(rel);
      found.push(rel);
    }
  };

  for (const rawEntry of listed.stdout.split("\0")) {
    if (!rawEntry) continue;
    const entry = rawEntry.split(path.sep).join("/");
    if (entry.startsWith("/") || entry === ".." || entry.startsWith("../") || entry.includes("/../")) continue;
    if (entry === ".git" || entry.startsWith(".git/")) continue;

    if (entry.endsWith("/")) {
      const dirRel = entry.slice(0, -1);
      walkIgnoredDirectory(repo, repoReal, dirRel, rules, positiveRules, skipDirs, add);
      continue;
    }
    if (!parentSegmentsSafe(repo, repoReal, entry, true)) continue;
    const abs = path.join(repo, ...entry.split("/"));
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() && !symlinkStaysInside(abs, repoReal)) continue;
    } catch {
      continue;
    }
    if (matchesCompiledRules(entry, rules, false)) add(entry);
  }
  return found;
}

function pruneOutsideSymlinks(dir: string, rootReal: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneOutsideSymlinks(abs, rootReal);
      continue;
    }
    if (entry.isSymbolicLink() && !symlinkStaysInside(abs, rootReal)) {
      try {
        fs.unlinkSync(abs);
      } catch {
        /* ignore */
      }
    }
  }
}

function runCp(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, CP_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

async function cloneFolder(srcDir: string, dstDir: string): Promise<void> {
  const reflink = await runCp(["-a", "--reflink=auto", "--", srcDir, dstDir]);
  if (reflink.code === 0) return;
  if (/unrecognized option|illegal option|invalid option/i.test(reflink.stderr)) {
    const fallback = await runCp(["-a", "--", srcDir, dstDir]);
    if (fallback.code === 0) return;
    throw new Error(`Could not copy folder ${path.basename(srcDir)}: ${fallback.stderr.trim() || "cp failed"}`);
  }
  throw new Error(`Could not copy folder ${path.basename(srcDir)}: ${reflink.stderr.trim() || "cp failed"}`);
}

function pathOccupied(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Populate a newly created worktree (`copyPath`) with git-ignored files matching workspace settings +
 * `.worktreeinclude` and cloned folders from `folder`/`repo`. Never copies anything outside `repo`
 * and skips symlinks pointing outside it. Returns repo-relative POSIX paths brought in (`folder/` for dirs).
 */
export async function seedCopy(opts: {
  repo: string;
  folder: string;
  copyPath: string;
  copySetup?: WorkspaceCopySetup | null;
}): Promise<string[]> {
  const repo = path.resolve(opts.repo);
  const copyPath = path.resolve(opts.copyPath);
  const repoReal = fs.realpathSync(repo);
  const copyReal = fs.realpathSync(copyPath);
  const seeded: string[] = [];
  const clonedDirs = new Set<string>();

  // 1. Clone configured folders first so the file scanner doesn't walk inside them.
  for (const rawFolder of opts.copySetup?.folders ?? []) {
    const clean = cleanCopyFolderPath(rawFolder);
    if (!clean) continue;
    const srcDir = path.resolve(opts.folder, ...clean.split("/"));
    if (!isPathInside(repo, srcDir) || srcDir === repo) continue;
    const repoRel = path.relative(repo, srcDir).split(path.sep).join("/");
    if (!repoRel || repoRel === "." || repoRel === ".git" || repoRel.startsWith(".git/")) continue;
    if (!parentSegmentsSafe(repo, repoReal, repoRel, false)) continue;
    let srcStat: fs.Stats;
    try {
      srcStat = fs.lstatSync(srcDir);
    } catch {
      continue;
    }
    if (!srcStat.isDirectory()) continue;

    const dstDir = path.join(copyPath, ...repoRel.split("/"));
    if (!parentSegmentsSafe(copyPath, copyReal, repoRel, false) || pathOccupied(dstDir)) continue;
    fs.mkdirSync(path.dirname(dstDir), { recursive: true });
    await cloneFolder(srcDir, dstDir);
    pruneOutsideSymlinks(dstDir, copyReal);
    clonedDirs.add(`${repoRel}/`);
    seeded.push(`${repoRel}/`);
  }

  // 2. Copy matching git-ignored files (defaults + .worktreeinclude).
  const basePatterns = opts.copySetup?.files ?? DEFAULT_COPY_FILES;
  const includePatterns = readWorktreeInclude(repo);
  const patterns = [...basePatterns, ...includePatterns];
  const files = await selectIgnoredFiles(repo, patterns, clonedDirs);

  for (const rel of files) {
    if ([...clonedDirs].some((dir) => rel.startsWith(dir))) continue;
    if (!parentSegmentsSafe(repo, repoReal, rel, true)) continue;
    if (!parentSegmentsSafe(copyPath, copyReal, rel, false)) continue;
    const src = path.join(repo, ...rel.split("/"));
    const dst = path.join(copyPath, ...rel.split("/"));
    if (pathOccupied(dst)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (stat.isSymbolicLink()) {
      const target = symlinkStaysInside(src, repoReal);
      if (!target) continue;
      fs.symlinkSync(target, dst);
      seeded.push(rel);
      continue;
    }
    if (stat.isFile()) {
      fs.copyFileSync(src, dst);
      seeded.push(rel);
    }
  }

  return seeded;
}

/**
 * Wrap CLI launch arguments with a visible pre-CLI setup command in the copy terminal.
 * `vibeforge-setup` sits in argv[3] so pty-host delays spawn pasteInput until `exec "$@"` starts the CLI.
 */
export function wrapWithSetupCommand(argv: readonly string[], setupCommand: string | null | undefined, userShell?: string): string[] {
  const command = setupCommand?.trim();
  if (!command || !argv.length) return [...argv];
  const runner = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const shellBin = userShell?.trim() || process.env.SHELL || runner;
  return [
    runner,
    "-c",
    'printf "\\033[2m$ %s\\033[0m\\n" "$1"; "$2" -c "$1" && shift 2 && exec "$@"',
    "vibeforge-setup",
    command,
    shellBin,
    ...argv,
  ];
}
