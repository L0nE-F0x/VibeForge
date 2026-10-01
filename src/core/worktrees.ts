import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "./places.js";
import { isSafeId } from "./slug.js";

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
}

export interface ApplyResult {
  /** Files the changes touched. */
  files: string[];
  /** Files left with conflict markers, when the workspace had moved on underneath. */
  conflicts: string[];
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = 60_000;

function git(args: readonly string[], cwd: string, input?: string): Promise<GitRun> {
  return new Promise((resolve) => {
    // Plain a/ b/ prefixes whatever the person's git config says, as vcs.ts does, so patches read the same.
    const pinned = ["-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
    const child = spawn("git", [...pinned, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
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

/** The repository's top folder, or null when `folder` isn't inside one. */
export async function repoRoot(folder: string): Promise<string | null> {
  const run = await git(["rev-parse", "--show-toplevel"], folder);
  return run.code === 0 && run.stdout.trim() ? path.resolve(run.stdout.trim()) : null;
}

/**
 * Make a new copy of the repository `folder` belongs to, at `target`, on a fresh branch from its
 * current commit. Committed work only: edits not yet committed in the workspace stay there.
 */
export async function createCopy(folder: string, target: string, branch: string): Promise<WorkingCopy> {
  const repo = await repoRoot(folder);
  if (!repo) throw new Error("A separate copy needs the workspace to be a git repository.");
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], repo);
  const base = head.stdout.trim();
  if (head.code !== 0 || !base) throw new Error("A separate copy needs at least one commit in the workspace.");
  // A copy deleted by hand leaves its entry behind, and git refuses to reuse its name.
  await git(["worktree", "prune"], repo);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const added = await git(["worktree", "add", "-q", "-B", branch, target, base], repo);
  if (added.code !== 0) throw failure("Could not make the copy", added);
  return { path: path.resolve(target), branch, base, repo };
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
  // Staging in the copy is the copy's own business; it makes new files part of the diff.
  const staged = await git(["add", "-A"], copy.path);
  if (staged.code !== 0) throw failure("Could not read the copy's changes", staged);
  const diff = await git(["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", copy.base], copy.path);
  if (diff.code !== 0) throw failure("Could not read the copy's changes", diff);
  return diff.stdout;
}

/** The files a patch touches, from its `diff --git` headers. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(match[2]);
  return [...files];
}

/**
 * Apply a copy's changes to the workspace as uncommitted edits. A clean apply comes first; when
 * the workspace has changed the same lines since, a three-way apply leaves conflict markers to
 * resolve, as a merge would. Nothing is committed. Throws when the changes can't go in at all.
 */
export async function applyToWorkspace(copy: WorkingCopy, patch: string): Promise<ApplyResult> {
  const files = patchFiles(patch);
  if (!patch.trim()) return { files: [], conflicts: [] };
  const clean = await git(["apply", "--whitespace=nowarn", "-"], copy.repo, patch);
  if (clean.code === 0) return { files, conflicts: [] };
  const merged = await git(["apply", "--3way", "--whitespace=nowarn", "-"], copy.repo, patch);
  const conflicts = [...merged.stderr.matchAll(/^U (.+)$/gm)].map((match) => match[1].trim());
  if (merged.code === 0 || conflicts.length) return { files, conflicts };
  throw failure("The changes don't apply to the workspace", merged.stderr.trim() ? merged : clean);
}

/**
 * Remove the copy and its branch. Safe to call when either is already gone. Throws, touching
 * nothing, when the copy isn't this task's own worktree.
 */
export async function removeCopy(copy: WorkingCopy, owner: CopyOwner): Promise<void> {
  const owned = ownedCopyPath(owner, copy.path);
  if (!owned) throw new Error("This task's copy is not in VibeForge's worktrees folder, so it was left alone.");
  if (owned.real) {
    const removed = await git(["worktree", "remove", "--force", owned.real], copy.repo);
    if (removed.code !== 0) fs.rmSync(owned.real, { recursive: true, force: true });
  }
  await retireBranch(copy, owner.taskId);
}

/** Drop the copy's branch, only when it is this task's branch in the repository the copy names. */
async function retireBranch(copy: WorkingCopy, taskId: string): Promise<void> {
  if (copy.branch !== copyBranch(taskId)) return;
  if ((await repoRoot(copy.repo)) !== path.resolve(copy.repo)) return;
  await git(["worktree", "prune"], copy.repo);
  await git(["branch", "-D", copy.branch], copy.repo);
}
