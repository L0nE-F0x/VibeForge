import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanCopyFolderPath, DEFAULT_COPY_FILES } from "../shared/copy-setup.js";
import { runGit } from "./git.js";
import { isPathInside } from "./places.js";
import type { WorkspaceCopySetup } from "./types.js";

export { cleanCopyFolderPath, DEFAULT_COPY_FILES };

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
  // Only "off" is kept: using the project's .worktreeinclude is the default.
  const worktreeInclude = record.worktreeInclude === false ? false : undefined;
  if (files === undefined && !folders && !setupCommand && worktreeInclude === undefined) return undefined;
  return {
    ...(files !== undefined ? { files } : {}),
    ...(folders ? { folders } : {}),
    ...(setupCommand ? { setupCommand } : {}),
    ...(worktreeInclude === false ? { worktreeInclude } : {}),
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

async function walkIgnoredDirectory(
  repo: string,
  repoReal: string,
  dirRel: string,
  rules: readonly CompiledRule[],
  positiveRules: readonly CompiledRule[],
  skipDirs: ReadonlySet<string>,
  add: (rel: string) => void,
): Promise<void> {
  if (skipDirs.has(`${dirRel}/`) || !explicitMadeFolderMatch(dirRel, positiveRules)) return;
  const absDir = path.join(repo, ...dirRel.split("/"));
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.lstat(absDir);
    if (!stat.isDirectory()) return;
    if (!isPathInside(repoReal, await fs.promises.realpath(absDir))) return;
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = `${dirRel}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walkIgnoredDirectory(repo, repoReal, rel, rules, positiveRules, skipDirs, add);
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

/**
 * The rules a copy's file patterns stand for. `.env*` names files only: a folder called `.env`
 * (a virtualenv, say) is not brought along file by file.
 */
function expandFilePatterns(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => (pattern === ".env*" ? [pattern, "!.env*/"] : [pattern]));
}

/** Find git-ignored files inside `repo` matching `patterns`, skipping `skipDirs` and symlinks leaving `repo`. */
export async function selectIgnoredFiles(repo: string, patterns: readonly string[], skipDirs: ReadonlySet<string>): Promise<string[]> {
  const rules = compileRules(expandFilePatterns(patterns));
  const positiveRules = rules.filter((rule) => !rule.negated);
  if (!positiveRules.length) return [];

  const repoReal = await fs.promises.realpath(repo);
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
      await walkIgnoredDirectory(repo, repoReal, dirRel, rules, positiveRules, skipDirs, add);
      continue;
    }
    if (!parentSegmentsSafe(repo, repoReal, entry, true)) continue;
    const abs = path.join(repo, ...entry.split("/"));
    try {
      const stat = await fs.promises.lstat(abs);
      if (stat.isSymbolicLink() && !symlinkStaysInside(abs, repoReal)) continue;
    } catch {
      continue;
    }
    if (matchesCompiledRules(entry, rules, false)) add(entry);
  }
  return found;
}

/**
 * Of `paths` (repo-relative, a folder ending in `/`), those git ignores in the copy itself. The copy
 * checks out the committed `.gitignore`: a file ignored only by an uncommitted rule in the main
 * folder would show up in the copy's changes, and so in its diff and Apply.
 */
async function ignoredInCopy(copyPath: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const run = await runGit(["-c", "core.quotePath=false", "check-ignore", "-z", "--stdin"], { cwd: copyPath, input: `${paths.join("\0")}\0` });
  // 1: none of them is ignored. Anything else that isn't 0 is an error: nothing counts as ignored.
  if (run.code !== 0) return new Set();
  return new Set(run.stdout.split("\0").filter(Boolean));
}

/**
 * Whether a link in a cloned folder may stay: it points inside the copy (a link it points to is
 * judged on its own), or it is an absolute link to a system path such as a virtualenv's
 * `/usr/bin/python3`. Links into the main repository, into the person's home outside the copy, or
 * to a folder holding either are dropped.
 */
function clonedLinkMayStay(linkPath: string, copyReal: string, repoReal: string, homeReal: string | null): boolean {
  let raw: string;
  let lexical: string;
  try {
    raw = fs.readlinkSync(linkPath);
    lexical = path.resolve(fs.realpathSync(path.dirname(linkPath)), raw);
  } catch {
    return false;
  }
  if (isPathInside(copyReal, lexical) && realTailInside(copyReal, path.dirname(lexical))) return true;
  if (!path.isAbsolute(raw)) return false;
  const targets = [lexical];
  try {
    targets.push(fs.realpathSync(linkPath));
  } catch {
    /* a dangling link: only where it says it points */
  }
  const guarded = [repoReal, ...(homeReal ? [homeReal] : [])];
  return targets.every((target) => guarded.every((place) => !isPathInside(place, target) && !isPathInside(target, place)));
}

function realHome(): string | null {
  try {
    return fs.realpathSync(os.homedir());
  } catch {
    return null;
  }
}

async function pruneClonedLinks(dir: string, copyReal: string, repoReal: string, homeReal: string | null): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await pruneClonedLinks(abs, copyReal, repoReal, homeReal);
      continue;
    }
    if (entry.isSymbolicLink() && !clonedLinkMayStay(abs, copyReal, repoReal, homeReal)) {
      await fs.promises.unlink(abs).catch(() => undefined);
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
      stderr = `cp took longer than ${CP_TIMEOUT_MS / 60_000} minutes`;
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

/** Clone a folder with `cp -a --reflink=auto`; the reason it failed, or null. */
async function cloneFolder(srcDir: string, dstDir: string): Promise<string | null> {
  const reflink = await runCp(["-a", "--reflink=auto", "--", srcDir, dstDir]);
  if (reflink.code === 0) return null;
  if (/unrecognized option|illegal option|invalid option/i.test(reflink.stderr)) {
    const fallback = await runCp(["-a", "--", srcDir, dstDir]);
    if (fallback.code === 0) return null;
    return fallback.stderr.trim() || "cp failed";
  }
  return reflink.stderr.trim() || "cp failed";
}

function pathOccupied(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

export interface SeedResult {
  /** Repo-relative POSIX paths brought in (`folder/` for a cloned folder). */
  seeded: string[];
  /** What could not be brought in, in plain words, for the copy's terminal. */
  warnings: string[];
}

/**
 * Populate a newly created worktree (`copyPath`) with git-ignored files matching workspace settings +
 * `.worktreeinclude` and cloned folders from `folder`/`repo`. Never copies anything outside `repo`,
 * and nothing git doesn't ignore in the copy too. Best effort: it never throws. A file that can't
 * be copied is skipped and a folder that can't be cloned is left out, each with a warning.
 */
export async function seedCopy(opts: {
  repo: string;
  folder: string;
  copyPath: string;
  copySetup?: WorkspaceCopySetup | null;
}): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], warnings: [] };
  try {
    await seedInto(opts, result);
  } catch (error) {
    result.warnings.push(`Could not finish setting up the copy: ${reasonOf(error)}`);
  }
  return result;
}

async function seedInto(opts: { repo: string; folder: string; copyPath: string; copySetup?: WorkspaceCopySetup | null }, result: SeedResult): Promise<void> {
  const repo = path.resolve(opts.repo);
  const copyPath = path.resolve(opts.copyPath);
  const repoReal = fs.realpathSync(repo);
  const copyReal = fs.realpathSync(copyPath);
  const homeReal = realHome();
  const { seeded, warnings } = result;
  const clonedDirs = new Set<string>();

  // 1. Clone configured folders first so the file scanner doesn't walk inside them.
  const folders: Array<{ repoRel: string; srcDir: string; dstDir: string }> = [];
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
    folders.push({ repoRel, srcDir, dstDir });
  }
  const foldersIgnored = await ignoredInCopy(copyPath, folders.map((item) => `${item.repoRel}/`));
  for (const { repoRel, srcDir, dstDir } of folders) {
    if (!foldersIgnored.has(`${repoRel}/`)) {
      warnings.push(`Left out ${repoRel}/: git doesn't ignore it in the copy, so it would show up in the changes.`);
      continue;
    }
    // Skipped by the file scan even if the clone fails: a half-made folder isn't filled file by file.
    clonedDirs.add(`${repoRel}/`);
    fs.mkdirSync(path.dirname(dstDir), { recursive: true });
    const failed = await cloneFolder(srcDir, dstDir);
    if (failed) {
      await fs.promises.rm(dstDir, { recursive: true, force: true }).catch(() => undefined);
      warnings.push(`Could not copy folder ${repoRel}: ${failed}`);
      continue;
    }
    await pruneClonedLinks(dstDir, copyReal, repoReal, homeReal);
    seeded.push(`${repoRel}/`);
  }

  // 2. Copy matching git-ignored files (the workspace's patterns, and .worktreeinclude unless turned off).
  const basePatterns = opts.copySetup?.files ?? DEFAULT_COPY_FILES;
  const includePatterns = opts.copySetup?.worktreeInclude === false ? [] : readWorktreeInclude(repo);
  const patterns = [...basePatterns, ...includePatterns];
  const files = (await selectIgnoredFiles(repo, patterns, clonedDirs)).filter((rel) => ![...clonedDirs].some((dir) => rel.startsWith(dir)));
  const filesIgnored = await ignoredInCopy(copyPath, files);

  for (const rel of files) {
    if (!parentSegmentsSafe(repo, repoReal, rel, true)) continue;
    if (!parentSegmentsSafe(copyPath, copyReal, rel, false)) continue;
    const src = path.join(repo, ...rel.split("/"));
    const dst = path.join(copyPath, ...rel.split("/"));
    if (pathOccupied(dst)) continue;
    if (!filesIgnored.has(rel)) {
      warnings.push(`Left out ${rel}: git doesn't ignore it in the copy, so it would show up in the changes.`);
      continue;
    }
    try {
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) {
        const target = symlinkStaysInside(src, repoReal);
        if (!target) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(target, dst);
        seeded.push(rel);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
        seeded.push(rel);
      }
    } catch (error) {
      warnings.push(`Could not copy ${rel}: ${reasonOf(error)}`);
    }
  }
}

/** The words a copy's terminal shows before its CLI starts (src/core/service/core.ts translates them). */
export interface CopyStartWords {
  /** Printed when the setup command fails; `{code}` is its exit status. */
  failed: string;
}

/**
 * Wrap CLI launch arguments so the copy's terminal first shows what copy setup couldn't bring
 * along (`notes`), then runs the setup command visibly, and starts the CLI only if it succeeded.
 * `vibeforge-setup` sits in argv[3] so pty-host holds the first prompt until `exec "$@"` starts the CLI.
 */
export function wrapForCopy(
  argv: readonly string[],
  opts: { setupCommand?: string | null; notes?: readonly string[]; words: CopyStartWords; userShell?: string },
): string[] {
  const command = opts.setupCommand?.trim() ?? "";
  const notes = (opts.notes ?? []).map((note) => note.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()).filter(Boolean);
  if ((!command && !notes.length) || !argv.length) return [...argv];
  const runner = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const shellBin = opts.userShell?.trim() || process.env.SHELL || runner;
  // printf's own format: a % or backslash in the words is printed as is, and {code} becomes the exit status.
  const failed = opts.words.failed.replace(/\\/g, "\\\\").replace(/%/g, "%%").replace("{code}", "%s");
  return [runner, "-c", COPY_START_SCRIPT, "vibeforge-setup", command, shellBin, failed, notes.join("\n"), ...argv];
}

/** $1 setup command (may be empty), $2 the shell to run it in, $3 the failure words, $4 notes; then the CLI. */
export const COPY_START_SCRIPT = [
  'if [ -n "$4" ]; then printf "\\033[33m%s\\033[0m\\n" "$4"; fi',
  'if [ -n "$1" ]; then',
  '  printf "\\033[2m$ %s\\033[0m\\n" "$1"',
  '  "$2" -c "$1"',
  "  status=$?",
  '  if [ "$status" -ne 0 ]; then printf "\\033[31m$3\\033[0m\\n" "$status"; exit "$status"; fi',
  "fi",
  "shift 4",
  'exec "$@"',
].join("\n");
