import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MADE_COPY_FOLDERS, seedCopy } from "./copy-setup.js";
import { runGit, runGitBytes } from "./git.js";
import { isPathInside } from "./places.js";
import { isSafeId } from "./slug.js";
import type { WorkspaceCopySetup } from "./types.js";

/**
 * A task's own copy of its repository: a git worktree on a `vibeforge/<task>` branch, so an agent
 * can change files without touching the folder you, or another agent, are working in. When the
 * work is reviewed its changes are applied to the workspace as ordinary uncommitted edits, and the
 * copy goes. Unlike vcs.ts, these calls write: to the copy, to the workspace on Apply, and to
 * the repository's list of worktrees and branches.
 */

export interface WorkingCopy {
  /** The worktree's top folder. */
  path: string;
  branch: string;
  /** The commit the copy started from; its changes are measured against it. */
  base: string;
  /** The workspace repository's top folder. */
  repo: string;
  /** Repo-relative POSIX paths brought in by setup (`dir/` for cloned folders), omitted from leftInCopy. */
  seeded?: string[];
}

export interface ApplyResult {
  /** Files the changes touched. */
  files: string[];
  /** Files left to sort out, because the workspace had changed them too. */
  conflicts: string[];
  /**
   * The conflicts that can't carry conflict markers (a binary both sides changed, a file one side
   * deleted and the other changed), where the workspace's own version was left as it was. The
   * copy's version is still in the copy.
   */
  kept?: string[];
  /**
   * Files git ignores that the agent left in its copy (see leftInCopy): not brought in, so the copy
   * stays with them until it is discarded.
   */
  left?: { folder: string; files: string[] };
  /**
   * Set when the copy's commits were already merged on the workspace's branch or its upstream
   * (e.g. a PR merged on GitHub): the workspace was fast-forwarded instead of writing duplicate
   * uncommitted edits, or was already up to date.
   */
  pulled?: { branch: string; upstream: string; alreadyUpToDate?: boolean };
  /** Files left in the copy because only some files were ticked for Apply. */
  stayed?: number;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

function gitBytes(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  // Plain a/ b/ prefixes whatever the person's git config says, as vcs.ts does, so patches read the same.
  const pinned = ["-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
  return runGitBytes([...pinned, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
}

function git(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitRun> {
  const pinned = ["-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
  return runGit([...pinned, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
}

const chains = new Map<string, Promise<unknown>>();

/**
 * This process's git work on one repository, one job at a time, so two copies being made,
 * applied or removed together don't trip over git's index lock. A failed job doesn't hold up
 * the next one. Git run by anything else (your shell, the agent) can still take the lock.
 */
export function withRepoLock<T>(repo: string, job: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo);
  const run = (chains.get(key) ?? Promise.resolve()).then(job, job);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

function failure(what: string, run: GitRun): Error {
  const detail = run.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return new Error(detail ? `${what}: ${detail}` : what);
}

/** Which task a copy belongs to, so only that task's own worktree is ever staged or removed. */
export interface CopyOwner {
  dataRoot: string;
  taskId: string;
}

/** The only folder a task's copy may be: `<dataRoot>/worktrees/<taskId>`. */
export function expectedCopyPath(dataRoot: string, taskId: string): string | null {
  if (!isSafeId(taskId)) return null;
  const root = path.join(path.resolve(dataRoot), "worktrees");
  const expected = path.join(root, taskId);
  return path.dirname(expected) === root && isPathInside(root, expected) ? expected : null;
}

/**
 * Whether `copyPath` is this task's own worktree. Task files are YAML anyone can edit, so the path
 * in one is never trusted on its own: it has to be the expected folder by name, and once symlinks
 * are followed it still has to be. `real` is the folder on disk, or null when it is already gone
 * (enough to tidy the branch, never to delete anything).
 */
export function ownedCopyPath(owner: CopyOwner, copyPath: string): { real: string | null } | null {
  const expected = expectedCopyPath(owner.dataRoot, owner.taskId);
  if (!expected || path.resolve(copyPath) !== expected) return null;
  const realExpected = realTail(expected);
  if (!realExpected) return null;
  try {
    fs.lstatSync(expected);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { real: null } : null;
  }
  try {
    const real = fs.realpathSync(expected);
    return real === realExpected ? { real } : null;
  } catch {
    return null;
  }
}

/** `target` with its deepest existing folder resolved through symlinks and the rest joined back on. */
function realTail(target: string): string | null {
  let existing = path.dirname(target);
  const tail = [path.basename(target)];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** The branch a task's copy lives on. */
export function copyBranch(taskId: string): string {
  return `vibeforge/${taskId}`;
}

/**
 * Whether `folder` sits in a git repository, by looking for a `.git` in it or a folder above it:
 * quick, with no git to run, for checking a setting as it's saved. `repoRoot` is the real test.
 */
export function insideGitRepo(folder: string): boolean {
  let dir = path.resolve(folder);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** The repository's top folder, or null when `folder` isn't inside one. */
export async function repoRoot(folder: string): Promise<string | null> {
  const run = await git(["rev-parse", "--show-toplevel"], folder);
  return run.code === 0 && run.stdout.trim() ? path.resolve(run.stdout.trim()) : null;
}

/**
 * Make a new copy of the repository `folder` belongs to, at `target`, on a fresh branch from its
 * current commit. Committed work only: edits not yet committed in the workspace stay there.
 * `previous` is the task's last copy, when its folder has gone: its branch, commits and all, is
 * picked back up rather than started again.
 */
export async function createCopy(folder: string, target: string, branch: string, previous: WorkingCopy | null = null): Promise<WorkingCopy> {
  const repo = await repoRoot(folder);
  if (!repo) throw new Error("A separate copy needs the workspace to be a git repository.");
  return withRepoLock(repo, () => makeCopy(repo, target, branch, previous));
}

/**
 * Make a new copy of the workspace repository and apply the workspace's copy setup
 * (git-ignored files matching workspace patterns + `.worktreeinclude`, and cloned folders).
 * Shared across tasks, Viby starts, and routines.
 */
export async function prepareCopy(opts: {
  folder: string;
  target: string;
  branch: string;
  previous?: WorkingCopy | null;
  copySetup?: WorkspaceCopySetup | null;
}): Promise<{ copy: WorkingCopy; setupCommand: string | null }> {
  const made = await createCopy(opts.folder, opts.target, opts.branch, opts.previous ?? null);
  const seeded = await seedCopy({
    repo: made.repo,
    folder: opts.folder,
    copyPath: made.path,
    copySetup: opts.copySetup,
  });
  const copy: WorkingCopy = seeded.length ? { ...made, seeded } : made;
  const setupCommand = opts.copySetup?.setupCommand?.trim() || null;
  return { copy, setupCommand };
}

async function makeCopy(repo: string, target: string, branch: string, previous: WorkingCopy | null): Promise<WorkingCopy> {
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], repo);
  const base = head.stdout.trim();
  if (head.code !== 0 || !base) throw new Error("A separate copy needs at least one commit in the workspace.");
  // Trash locks nothing can undo any more: their app has gone, or this copy is taking their folder.
  await unlockOurs(repo, (entry) => samePlace(entry.path, target) || !lockerAlive(entry.locked ?? ""));
  // A copy deleted by hand leaves its entry behind, and git refuses to reuse its name.
  await git(["worktree", "prune"], repo);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tip = (await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], repo)).stdout.trim();
  const inUse = (await registered(repo)).some((entry) => entry.branch === `refs/heads/${branch}`);
  if (tip && !inUse) {
    const resume = previous && previous.branch === branch && path.resolve(previous.repo) === repo && isCommitId(previous.base) && (await isAncestor(repo, previous.base, tip));
    if (resume) {
      // Deliberately keep core.hooksPath=/dev/null from runGit: creating a copy must not run post-checkout in untrusted repos.
      const added = await git(["worktree", "add", "-q", target, branch], repo);
      if (added.code !== 0) throw failure("Could not make the copy", added);
      return { path: path.resolve(target), branch, base: previous.base, repo };
    }
    // `-B` would reset the branch; commits on it that HEAD doesn't have stay reachable under another name.
    if (!(await isAncestor(repo, tip, base))) {
      const renamed = await git(["branch", "-m", branch, await savedName(repo, branch)], repo);
      if (renamed.code !== 0) throw failure("Could not make the copy", renamed);
    }
  }
  // Deliberately keep core.hooksPath=/dev/null from runGit: creating a copy must not run post-checkout in untrusted repos.
  const added = await git(["worktree", "add", "-q", "-B", branch, target, base], repo);
  if (added.code !== 0) throw failure("Could not make the copy", added);
  return { path: path.resolve(target), branch, base, repo };
}

async function isAncestor(repo: string, older: string, newer: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", older, newer], repo)).code === 0;
}

/** A free `<branch>-saved-<date>` name for an old copy branch that is being set aside. */
async function savedName(repo: string, branch: string): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  for (let count = 1; ; count += 1) {
    const name = `${branch}-saved-${stamp}${count > 1 ? `-${count}` : ""}`;
    if ((await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`], repo)).code !== 0) return name;
  }
}

interface Registered {
  path: string;
  /** `refs/heads/…`, or null when detached. */
  branch: string | null;
  /** The lock's reason, "" for a lock without one, null when not locked. */
  locked: string | null;
}

/** The repository's worktrees, as git has them registered. */
async function registered(repo: string): Promise<Registered[]> {
  const run = await git(["worktree", "list", "--porcelain", "-z"], repo);
  if (run.code !== 0) return [];
  const found: Registered[] = [];
  for (const line of run.stdout.split("\0")) {
    if (line.startsWith("worktree ")) found.push({ path: line.slice("worktree ".length), branch: null, locked: null });
    const entry = found[found.length - 1];
    if (!entry) continue;
    if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
    else if (line === "locked" || line.startsWith("locked ")) entry.locked = line.slice("locked ".length);
  }
  return found;
}

function samePlace(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  const real = realTail(path.resolve(a));
  return real !== null && real === realTail(path.resolve(b));
}

/**
 * What builds, installs and the CLIs' own settings make in a folder: never the agent's work, so
 * never a reason to keep a copy around.
 */
const MADE_FOLDERS = MADE_COPY_FOLDERS;
const MADE_FILES = /(?:\.log|\.pyc|\.tsbuildinfo|(?:^|\/)\.DS_Store)$/;

function isMadeEntry(entry: string): boolean {
  return entry.replace(/\/$/, "").split("/").some((part) => MADE_FOLDERS.has(part)) || MADE_FILES.test(entry);
}

/**
 * Files the agent left in its copy that git ignores (notes, a `config.local`), leaving out what
 * builds, installs, the CLIs make, and anything copy setup brought in (`copy.seeded`).
 */
export async function leftInCopy(copy: WorkingCopy): Promise<string[]> {
  const run = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], copy.path);
  if (run.code !== 0) return [];
  const seededFiles = new Set<string>();
  const seededDirs: string[] = [];
  for (const item of copy.seeded ?? []) {
    const clean = item.split(path.sep).join("/").replace(/^\/+/, "");
    if (!clean) continue;
    if (clean.endsWith("/")) seededDirs.push(clean);
    else seededFiles.add(clean);
  }
  const inSeededDir = (entry: string) => seededDirs.some((dir) => entry === dir || entry.startsWith(dir));
  const out: string[] = [];
  for (const rawEntry of run.stdout.split("\0")) {
    if (!rawEntry) continue;
    const entry = rawEntry.split(path.sep).join("/");
    if (isMadeEntry(entry) || inSeededDir(entry)) continue;
    if (!entry.endsWith("/")) {
      if (!seededFiles.has(entry)) out.push(entry);
      continue;
    }
    const hasSeededChild = [...seededFiles].some((file) => file.startsWith(entry));
    if (!hasSeededChild) {
      out.push(entry);
      continue;
    }
    const expanded = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", entry.slice(0, -1)], copy.path);
    if (expanded.code !== 0) {
      out.push(entry);
      continue;
    }
    for (const rawChild of expanded.stdout.split("\0")) {
      if (!rawChild) continue;
      const child = rawChild.split(path.sep).join("/");
      if (isMadeEntry(child) || inSeededDir(child) || seededFiles.has(child)) continue;
      out.push(child);
      if (out.length >= 200) break;
    }
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

/** A commit id, never something git could read as an option. */
export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

/** How a copy waiting in the trash is locked, with the process that can still undo it. */
const TRASH_LOCK = "VibeForge: in the trash until its Undo has passed";

function lockerAlive(reason: string): boolean {
  const pid = Number(/\(process (\d+)\)$/.exec(reason)?.[1] ?? Number.NaN);
  if (!Number.isInteger(pid) || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lift VibeForge's own trash locks on the worktrees `which` picks. Anyone else's lock stays. */
async function unlockOurs(repo: string, which: (entry: Registered) => boolean): Promise<void> {
  for (const entry of await registered(repo)) {
    if (entry.locked?.startsWith(TRASH_LOCK) && which(entry)) await git(["worktree", "unlock", entry.path], repo);
  }
}

/**
 * Lock a task's copy before its folder moves to the trash, so a `git worktree prune` while Undo is
 * on screen (another task's Execute runs one) doesn't forget it. True when it was locked.
 */
export async function lockCopy(copy: WorkingCopy, owner: CopyOwner): Promise<boolean> {
  const real = ownedCopyPath(owner, copy.path)?.real;
  if (!real) return false;
  return withRepoLock(copy.repo, async () => (await git(["worktree", "lock", "--reason", `${TRASH_LOCK} (process ${process.pid})`, real], copy.repo)).code === 0);
}

/** Lift the trash lock once Undo has put the copy's folder back. */
export async function unlockCopy(copy: WorkingCopy, owner: CopyOwner): Promise<void> {
  const expected = expectedCopyPath(owner.dataRoot, owner.taskId);
  if (!expected) return;
  await withRepoLock(copy.repo, () => unlockOurs(copy.repo, (entry) => samePlace(entry.path, expected)));
}

/** Where `folder` (inside the repository) sits inside the copy. */
export function folderInCopy(copy: WorkingCopy, folder: string): string {
  const inside = path.relative(copy.repo, path.resolve(folder));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return copy.path;
  return path.join(copy.path, inside);
}

/**
 * Everything the copy changed since it was made, commits and uncommitted edits alike, new and
 * binary files included, as one patch against the base commit.
 */
export async function copyPatch(copy: WorkingCopy, owner: CopyOwner): Promise<string> {
  // `git add -A` in a folder that isn't the task's copy would stage someone's real work.
  if (!ownedCopyPath(owner, copy.path)?.real) throw new Error("This task's copy is not in VibeForge's worktrees folder, so it was left alone.");
  return withRepoLock(copy.repo, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-patch-"));
    const tempIndex = path.join(scratch, "index");
    try {
      // Stage into a throwaway index copied from the worktree's index so we never touch the live
      // copy's staging area or contend on index.lock while its CLI is running.
      try {
        const realIndex = path.resolve(copy.path, (await git(["rev-parse", "--git-path", "index"], copy.path)).stdout.trim());
        fs.copyFileSync(realIndex, tempIndex);
        const { atime, mtime } = fs.statSync(realIndex);
        fs.utimesSync(tempIndex, atime, mtime);
      } catch {
        const readTree = await git(["read-tree", "HEAD"], copy.path, { env: { GIT_INDEX_FILE: tempIndex } });
        if (readTree.code !== 0) throw failure("Could not read the copy's changes", readTree);
      }
      const env = { GIT_INDEX_FILE: tempIndex };
      const staged = await git(["add", "-A"], copy.path, { env });
      if (staged.code !== 0) throw stagingFailure(staged);
      // The staged tree is what Apply merges: the patch below is text, and text in some other
      // encoding (Latin-1, Shift-JIS) wouldn't survive being read as UTF-8 and written back.
      const tree = await git(["write-tree"], copy.path, { env });
      if (tree.code !== 0) throw failure("Could not read the copy's changes", tree);
      const diff = await git(["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", copy.base], copy.path, { env });
      if (diff.code !== 0) throw failure("Could not read the copy's changes", diff);
      stagedTrees.set(path.resolve(copy.path), { patch: diff.stdout, tree: tree.stdout.trim() });
      return diff.stdout;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}

/**
 * The tree each copy's last patch was read from, by the copy's folder. Apply takes the copy's
 * side from it, byte for byte, when it is handed that same patch.
 */
const stagedTrees = new Map<string, { patch: string; tree: string }>();

export function hasStagedTree(copyPath: string): boolean {
  return stagedTrees.has(path.resolve(copyPath));
}

/**
 * Why `git add -A` in a copy failed, in words. A git repository inside the copy that has no
 * commit yet (`git init` with nothing committed) is the usual cause, and git's own words
 * ("does not have a commit checked out") don't say what to do.
 */
function stagingFailure(run: GitRun): Error {
  const nested = /'([^']+)' does not have a commit checked out/.exec(run.stderr)?.[1];
  if (nested) {
    const folder = nested.replace(/\/$/, "");
    return new Error(`Could not read the copy's changes: ${folder} in the copy is a git repository of its own with nothing committed yet. Commit in it, or remove its .git folder, and try again.`);
  }
  return failure("Could not read the copy's changes", run);
}

function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const escaped: Record<string, string> = { t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" };
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\" || i + 1 >= inner.length) {
      bytes.push(...Buffer.from(inner[i], "utf8"));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
      continue;
    }
    i += 1;
    bytes.push(...Buffer.from(escaped[inner[i]] ?? inner[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

export function diffHeaderTarget(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const tokens: string[] = [];
    for (let i = 0; i < rest.length && tokens.length < 2; ) {
      if (rest[i] === " ") {
        i += 1;
        continue;
      }
      if (rest[i] === '"') {
        let j = i + 1;
        while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
        tokens.push(unquoteGitPath(rest.slice(i, j + 1)));
        i = j + 1;
      } else {
        const end = rest.indexOf(" ", i);
        tokens.push(rest.slice(i, end < 0 ? rest.length : end));
        i = end < 0 ? rest.length : end;
      }
    }
    return tokens.length === 2 && tokens[1].startsWith("b/") ? tokens[1].slice(2) : null;
  }
  let pos = rest.indexOf(" b/");
  let fallback: string | null = null;
  while (pos >= 0 && rest.startsWith("a/")) {
    if (rest.slice(2, pos) === rest.slice(pos + 3)) return rest.slice(pos + 3);
    fallback = rest.slice(pos + 3);
    pos = rest.indexOf(" b/", pos + 1);
  }
  return fallback;
}

/** The files a patch touches, from its `diff --git` headers (handling `" b/"` and C-quoted names). */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const file = diffHeaderTarget(line);
    if (file) files.add(file);
  }
  return [...files];
}

/**
 * Apply a copy's changes to the workspace as uncommitted edits. Each file is merged three ways, as
 * `git merge` would: the copy's version, the workspace's as it is on disk now (edits not yet
 * committed included), and the commit the copy started from. Changes to different lines both go
 * in; the same lines changed on both sides are left with conflict markers to resolve. Git's own
 * index is never touched, and nothing is committed. Throws when the changes can't go in at all.
 */
export function applyToWorkspace(copy: WorkingCopy, patch: string, options?: { files?: readonly string[] }): Promise<ApplyResult> {
  return withRepoLock(copy.repo, async () => {
    const key = path.resolve(copy.path);
    const staged = stagedTrees.get(key);
    try {
      return await applyPatch(copy, patch, staged?.patch === patch ? staged.tree : null, options?.files);
    } finally {
      if (stagedTrees.get(key) === staged) stagedTrees.delete(key);
    }
  });
}

const ZERO_OID = /^0+$/;

/** The merge is done on throwaway indexes and commits; this names who made those commits. */
const MERGE_AUTHOR = {
  GIT_AUTHOR_NAME: "VibeForge",
  GIT_AUTHOR_EMAIL: "vibeforge@localhost",
  GIT_COMMITTER_NAME: "VibeForge",
  GIT_COMMITTER_EMAIL: "vibeforge@localhost",
};

async function applyPatch(copy: WorkingCopy, patch: string, stagedTree: string | null, onlyFiles?: readonly string[]): Promise<ApplyResult> {
  if (!patch.trim()) return { files: [], conflicts: [], kept: [] };
  if (!isCommitId(copy.base)) throw new Error("The changes don't apply to the workspace");
  const repo = copy.repo;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-apply-"));
  try {
    const step = async (args: string[], index?: string, input?: string) => {
      const run = await git(args, repo, { input, env: { ...MERGE_AUTHOR, ...(index ? { GIT_INDEX_FILE: index } : {}) } });
      if (run.code !== 0) throw failure("The changes don't apply to the workspace", run);
      return run.stdout;
    };
    // The copy's side: the tree its patch was read from (a worktree keeps its objects in the
    // repository's own store), else the patch on top of its base, in an index of its own.
    let theirs = stagedTree && isCommitId(stagedTree) && (await git(["cat-file", "-e", `${stagedTree}^{tree}`], repo)).code === 0 ? stagedTree : "";
    if (!theirs) {
      const theirsIndex = path.join(scratch, "theirs");
      await step(["read-tree", copy.base], theirsIndex);
      await step(["apply", "--cached", "--whitespace=nowarn", "-"], theirsIndex, patch);
      theirs = (await step(["write-tree"], theirsIndex)).trim();
    }
    const touched = (await step(["diff-tree", "-r", "-z", "--no-renames", "--name-only", copy.base, theirs])).split("\0").filter(Boolean);
    const statusParts = (await step(["diff-tree", "-r", "-z", "-M", "--name-status", copy.base, theirs])).split("\0");
    const entries: Array<{ name: string; paths: string[] }> = [];
    for (let i = 0; i + 1 < statusParts.length && statusParts[i]; i += 2) {
      const code = statusParts[i];
      if (/^[RC]/.test(code) && i + 2 < statusParts.length) {
        const from = statusParts[i + 1];
        const to = statusParts[i + 2];
        entries.push({ name: to, paths: code.startsWith("R") ? [from, to] : [to] });
        i += 1;
      } else {
        entries.push({ name: statusParts[i + 1], paths: [statusParts[i + 1]] });
      }
    }
    let files: string[];
    let stayed = 0;
    let allowedPaths: Set<string> | null = null;
    if (onlyFiles === undefined) {
      files = entries.map((entry) => entry.name);
    } else {
      const picked = new Set(onlyFiles);
      const chosen = entries.filter((entry) => picked.has(entry.name) || entry.paths.some((p) => picked.has(p)));
      const leftOut = entries.filter((entry) => !chosen.includes(entry));
      files = chosen.map((entry) => entry.name);
      stayed = leftOut.length;
      if (stayed > 0) {
        if (chosen.length === 0) return { files: [], conflicts: [], kept: [], stayed };
        const leftNames = new Set(leftOut.map((entry) => entry.name));
        allowedPaths = new Set<string>();
        for (const entry of chosen) {
          allowedPaths.add(entry.name);
          for (const p of entry.paths) {
            if (!leftNames.has(p)) allowedPaths.add(p);
          }
        }
      }
    }
    const theirsCommit = (await step(["commit-tree", "--no-gpg-sign", "-p", copy.base, "-m", copy.branch, theirs])).trim();
    // If the copy's commits are already merged on the workspace's branch or its upstream (a PR
    // merged on GitHub), fast-forward instead of pasting the same edits back as uncommitted files.
    // Partial Apply never fast-forwards because that would pull unticked files in too.
    const pulled = stayed > 0 ? null : await tryPullMerged(copy, theirs, theirsCommit);
    if (pulled) return { files, conflicts: [], kept: [], pulled };
    // The workspace's side: git's index copied, then brought up to what is on disk now.
    const oursIndex = path.join(scratch, "ours");
    try {
      const index = path.resolve(repo, (await step(["rev-parse", "--git-path", "index"])).trim());
      fs.copyFileSync(index, oursIndex);
      // Its time too: git re-reads a file edited in the second the index was written only when the
      // index's own time says so, and a fresh copy's time would hide that edit.
      const { atime, mtime } = fs.statSync(index);
      fs.utimesSync(oursIndex, atime, mtime);
    } catch {
      await step(["read-tree", "HEAD"], oursIndex);
    }
    await step(["add", "-u"], oursIndex);
    // Untracked files where the copy has changes are part of it too, ignored ones included.
    const untracked = (allowedPaths ? touched.filter((name) => allowedPaths.has(name)) : touched).filter((name) => {
      const at = placeIn(repo, name);
      const stat = at ? lstat(at) : null;
      return Boolean(stat && (stat.isFile() || stat.isSymbolicLink()));
    });
    if (untracked.length) {
      await git(["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], repo, { input: `${untracked.join("\0")}\0`, env: { GIT_INDEX_FILE: oursIndex } });
    }
    const ours = (await step(["write-tree"], oursIndex)).trim();
    // Commits only so merge-tree can take them (older git wants commits, not trees); nothing points at them.
    const oursCommit = (await step(["commit-tree", "--no-gpg-sign", "-p", copy.base, "-m", "workspace", ours])).trim();
    const merged = await git(["merge-tree", "--write-tree", "-z", oursCommit, theirsCommit], repo);
    if (merged.code !== 0 && merged.code !== 1) throw failure("The changes don't apply to the workspace", merged);
    const [result, ...info] = merged.stdout.split("\0");
    // Per conflicted path, the workspace's (stage 2) and the copy's (stage 3) version.
    const stages = new Map<string, { ours?: string; theirs?: string }>();
    for (const line of info) {
      const entry = /^\d{6} ([0-9a-f]+) ([123])\t(.+)$/s.exec(line);
      if (!entry) break;
      const sides = stages.get(entry[3]) ?? {};
      if (entry[2] === "2") sides.ours = entry[1];
      if (entry[2] === "3") sides.theirs = entry[1];
      stages.set(entry[3], sides);
    }
    const changes = await treeChanges(repo, ours, result);
    const labels = { ours: oursCommit, theirs: theirsCommit, base: copy.base, branch: copy.branch };
    const isAllowed = (name: string) => !allowedPaths || allowedPaths.has(name) || allowedPaths.has(plainName(name, labels));
    const pickedStages = new Map<string, { ours?: string; theirs?: string }>();
    for (const [name, sides] of stages) {
      if (isAllowed(name)) pickedStages.set(name, sides);
    }
    const pickedChanges = changes.filter((change) => isAllowed(change.path));
    const failed = new Set(await writeChanges(repo, pickedChanges, pickedStages, labels));
    const marked = new Set(pickedChanges.filter((change) => withMarkers(change, pickedStages) && !failed.has(change.path)).map((change) => change.path));
    const conflicts = unique([...pickedStages.keys(), ...failed].map((name) => plainName(name, labels)));
    return { files, conflicts, kept: conflicts.filter((name) => !marked.has(name)), ...(stayed > 0 ? { stayed } : {}) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Whether `target` (a commit on the workspace's branch or its upstream) already holds every change
 * the copy made: either `copyHead` is in its history (regular merge), or merging the copy onto it
 * from `base` changes nothing (squash or rebase merge on GitHub).
 */
async function commitContainsCopy(repo: string, base: string, target: string, copyHead: string, theirsCommit: string): Promise<boolean> {
  if (!isCommitId(target) || target === base) return false;
  if (await isAncestor(repo, copyHead, target)) return true;
  if (!(await isAncestor(repo, base, target))) return false;
  const targetTree = (await git(["rev-parse", "--verify", "-q", `${target}^{tree}`], repo)).stdout.trim();
  if (!isCommitId(targetTree)) return false;
  // `theirsCommit`'s parent is `base`, which is an ancestor of `target`, so `base` is their merge-base.
  const merged = await git(["merge-tree", "--write-tree", "-z", target, theirsCommit], repo);
  return merged.code === 0 && merged.stdout.split("\0")[0].trim() === targetTree;
}

/**
 * When the copy's commits were already merged on the workspace's branch or its upstream, fast-forward
 * the workspace instead of writing duplicate uncommitted edits. Returns null whenever the copy has
 * uncommitted edits of its own, isn't merged yet, or can't fast-forward cleanly, so Apply falls back
 * to its normal three-way merge.
 */
async function tryPullMerged(copy: WorkingCopy, theirs: string, theirsCommit: string): Promise<ApplyResult["pulled"] | null> {
  const repo = copy.repo;
  // Only a copy with clean commits ahead of its base can already have been pushed and merged.
  const inCopy = fs.existsSync(copy.path);
  const copyHead = (await git(["rev-parse", "--verify", "-q", inCopy ? "HEAD" : `refs/heads/${copy.branch}^{commit}`], inCopy ? copy.path : repo)).stdout.trim();
  if (!isCommitId(copyHead) || copyHead === copy.base) return null;
  const [baseTree, copyHeadTree] = await Promise.all([
    git(["rev-parse", "--verify", "-q", `${copy.base}^{tree}`], repo),
    git(["rev-parse", "--verify", "-q", `${copyHead}^{tree}`], repo),
  ]);
  if (!isCommitId(baseTree.stdout.trim()) || theirs === baseTree.stdout.trim()) return null;
  if (copyHeadTree.stdout.trim() !== theirs) return null;

  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo)).stdout.trim();
  if (!branch) return null;
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], repo)).stdout.trim();
  if (!isCommitId(head)) return null;
  const upstreamRef = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo)).stdout.trim();

  // Already committed on this branch (e.g. merged locally or pulled before clicking Apply).
  if (await commitContainsCopy(repo, copy.base, head, copyHead, theirsCommit)) {
    return { branch, upstream: upstreamRef || branch, alreadyUpToDate: true };
  }
  if (!upstreamRef) return null;

  let upstream = (await git(["rev-parse", "--verify", "-q", "@{u}"], repo)).stdout.trim();
  let merged = await commitContainsCopy(repo, copy.base, upstream, copyHead, theirsCommit);
  if (!merged) {
    // Refresh this branch's upstream ref once (best-effort; offline or auth errors just fall back).
    const remote = (await git(["config", "--get", `branch.${branch}.remote`], repo)).stdout.trim();
    const mergeRef = (await git(["config", "--get", `branch.${branch}.merge`], repo)).stdout.trim();
    if (remote && remote !== "." && !remote.startsWith("-") && mergeRef.startsWith("refs/heads/")) {
      await git(["fetch", "--no-tags", "--quiet", "--", remote, mergeRef], repo, {
        timeoutMs: FETCH_TIMEOUT_MS,
        env: { SSH_ASKPASS_REQUIRE: "never" },
      });
      upstream = (await git(["rev-parse", "--verify", "-q", "@{u}"], repo)).stdout.trim();
      merged = await commitContainsCopy(repo, copy.base, upstream, copyHead, theirsCommit);
    }
  }
  if (!merged || !(await isAncestor(repo, head, upstream))) return null;

  // Fast-forward only: never creates a merge commit, and refuses cleanly if local edits collide.
  const ff = await git(["merge", "--ff-only", "--quiet", upstream], repo);
  if (ff.code !== 0) return null;
  return { branch, upstream: upstreamRef };
}

interface TreeChange {
  path: string;
  mode: string;
  oid: string;
  /** New on this side: anything already at its path wasn't part of the merge. */
  added: boolean;
  deleted: boolean;
}

/** What turns tree `from` into tree `to`, file by file. */
async function treeChanges(repo: string, from: string, to: string): Promise<TreeChange[]> {
  const run = await git(["diff-tree", "-r", "-z", "--no-renames", from, to], repo);
  if (run.code !== 0) throw failure("The changes don't apply to the workspace", run);
  const parts = run.stdout.split("\0");
  const changes: TreeChange[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const head = /^:\d{6} (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(parts[at]);
    if (!head) break;
    changes.push({ path: parts[at + 1], mode: head[1], oid: head[3], added: ZERO_OID.test(head[2]), deleted: ZERO_OID.test(head[3]) });
  }
  return changes;
}

/** A conflicted file whose merged version carries conflict markers: it differs from both sides. */
function withMarkers(change: TreeChange, stages: Map<string, { ours?: string; theirs?: string }>): boolean {
  const sides = stages.get(change.path);
  return Boolean(sides && !change.deleted && change.mode.startsWith("100") && change.oid !== sides.ours && change.oid !== sides.theirs);
}

interface Labels {
  ours: string;
  theirs: string;
  base: string;
  branch: string;
}

/**
 * Write the merge into the workspace: deletions first, so a file can become a folder. A conflict
 * without markers is left as the workspace has it. Returns the files that couldn't be written,
 * because something in the workspace was in the way (a folder, an untracked file, a symlink).
 */
async function writeChanges(repo: string, changes: TreeChange[], stages: Map<string, { ours?: string; theirs?: string }>, labels: Labels): Promise<string[]> {
  const failed: string[] = [];
  const ordered = [...changes.filter((change) => change.deleted), ...changes.filter((change) => !change.deleted)];
  for (const change of ordered) {
    if (stages.has(change.path) && !withMarkers(change, stages)) continue;
    // A git repository inside the copy (a clone, a submodule) is a commit, not files to write:
    // left in the copy and named, so the copy isn't removed with it still in there.
    if (change.mode === "160000") {
      failed.push(change.path);
      continue;
    }
    const target = placeIn(repo, change.path);
    if (!target || (change.added && lstat(target))) {
      failed.push(change.path);
      continue;
    }
    if (change.deleted) {
      if (!removeFile(repo, target)) failed.push(change.path);
      continue;
    }
    const link = change.mode === "120000";
    // Checkout's filters (line endings, LFS) turn the stored file back into the one on disk.
    const read = await gitBytes(link ? ["cat-file", "blob", change.oid] : ["cat-file", "--filters", `--path=${change.path}`, change.oid], repo);
    if (read.code !== 0) {
      failed.push(change.path);
      continue;
    }
    const data = withMarkers(change, stages) ? relabel(read.stdout, labels) : read.stdout;
    if (!writeFile(target, change.mode, data)) failed.push(change.path);
  }
  return failed;
}

/** Name the sides of each conflict "workspace", "base" and the copy's branch, not by commit id. */
function relabel(data: Buffer, labels: Labels): Buffer {
  const text = data
    .toString("latin1")
    .replace(new RegExp(`^(<{7,}) ${labels.ours}`, "gm"), (_all, marker: string) => `${marker} workspace`)
    .replace(new RegExp(`^(>{7,}) ${labels.theirs}`, "gm"), (_all, marker: string) => `${marker} ${labels.branch}`)
    .replace(/^(\|{7,}) ([0-9a-f]{4,64})(?=[:\r\n]|$)/gm, (all, marker: string, oid: string) => (labels.base.startsWith(oid) ? `${marker} base` : all));
  return Buffer.from(text, "latin1");
}

/** A path git renamed aside in a file/folder clash (`name~<commit>`), back to the name the person knows. */
function plainName(name: string, labels: Labels): string {
  return name.replace(new RegExp(`~(${labels.ours}|${labels.theirs})$`), "");
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * Where `name` is in the workspace, or null when writing there could land outside it: an odd path,
 * or a symlink or file where a folder on the way should be.
 */
function placeIn(repo: string, name: string): string | null {
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  let at = repo;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    const stat = lstat(at);
    if (!stat) break;
    if (!stat.isDirectory()) return null;
  }
  return path.join(repo, ...parts);
}

function lstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Write one file as checkout would: a symlink for 120000, the executable bit for 100755. */
function writeFile(target: string, mode: string, data: Buffer): boolean {
  try {
    const stat = lstat(target);
    if (stat?.isDirectory()) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat?.isSymbolicLink() || (stat && mode === "120000")) fs.rmSync(target, { force: true });
    if (mode === "120000") {
      fs.symlinkSync(data.toString("utf8"), target);
      return true;
    }
    const executable = mode === "100755";
    // A new file gets these less the umask, as checkout gives it.
    fs.writeFileSync(target, data, { mode: executable ? 0o777 : 0o666 });
    if (stat?.isFile()) {
      const bits = stat.mode & 0o777;
      const wanted = executable ? bits | ((bits & 0o444) >> 2) : bits & ~0o111;
      if (wanted !== bits) fs.chmodSync(target, wanted);
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove one file, and the folders that leaves empty, as checkout would. */
function removeFile(repo: string, target: string): boolean {
  try {
    if (lstat(target)?.isDirectory()) return false;
    fs.rmSync(target, { force: true });
    for (let dir = path.dirname(target); dir !== repo && isPathInside(repo, dir); dir = path.dirname(dir)) {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the copy and its branch. Safe to call when either is already gone. Throws, touching
 * nothing, when the copy isn't this task's own worktree. With `repoTrusted` false (the task file
 * names some other repository) only the copy's own folder goes; git is never run in that one.
 */
export async function removeCopy(copy: WorkingCopy, owner: CopyOwner, repoTrusted = true): Promise<void> {
  const owned = ownedCopyPath(owner, copy.path);
  if (!owned) throw new Error("This task's copy is not in VibeForge's worktrees folder, so it was left alone.");
  stagedTrees.delete(path.resolve(copy.path));
  if (owned.real) stagedTrees.delete(path.resolve(owned.real));
  if (!repoTrusted) {
    if (owned.real) fs.rmSync(owned.real, { recursive: true, force: true });
    return;
  }
  await withRepoLock(copy.repo, async () => {
    // Out of the trash for good: its lock goes, so git can let go of it.
    const expected = expectedCopyPath(owner.dataRoot, owner.taskId)!;
    await unlockOurs(copy.repo, (entry) => samePlace(entry.path, expected));
    if (owned.real) {
      const removed = await git(["worktree", "remove", "--force", owned.real], copy.repo);
      if (removed.code !== 0) fs.rmSync(owned.real, { recursive: true, force: true });
    }
    await retireBranch(copy, owner.taskId);
  });
}

/** Drop the copy's branch, only when it is this task's branch in the repository the copy names. */
async function retireBranch(copy: WorkingCopy, taskId: string): Promise<void> {
  if (copy.branch !== copyBranch(taskId)) return;
  if ((await repoRoot(copy.repo)) !== path.resolve(copy.repo)) return;
  await git(["worktree", "prune"], copy.repo);
  await git(["branch", "-D", copy.branch], copy.repo);
}
