import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  /** Files left to sort out, because the workspace had changed them too. */
  conflicts: string[];
  /**
   * The conflicts that can't carry conflict markers (a binary both sides changed, a file one side
   * deleted and the other changed), where the workspace's own version was left as it was. The
   * copy's version is still in the copy.
   */
  kept?: string[];
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  input?: string;
  env?: Record<string, string>;
}

const TIMEOUT_MS = 60_000;

function gitBytes(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    // Plain a/ b/ prefixes whatever the person's git config says, as vcs.ts does, so patches read the same.
    const pinned = ["-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
    const child = spawn("git", [...pinned, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: Buffer.concat(chunks), stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

async function git(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitRun> {
  const run = await gitBytes(args, cwd, options);
  return { ...run, stdout: run.stdout.toString("utf8") };
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

/** A commit id, never something git could read as an option. */
function isCommitId(value: string): boolean {
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
    // Staging in the copy is the copy's own business; it makes new files part of the diff.
    const staged = await git(["add", "-A"], copy.path);
    if (staged.code !== 0) throw stagingFailure(staged);
    // The staged tree is what Apply merges: the patch below is text, and text in some other
    // encoding (Latin-1, Shift-JIS) wouldn't survive being read as UTF-8 and written back.
    const tree = await git(["write-tree"], copy.path);
    if (tree.code !== 0) throw failure("Could not read the copy's changes", tree);
    const diff = await git(["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", copy.base], copy.path);
    if (diff.code !== 0) throw failure("Could not read the copy's changes", diff);
    stagedTrees.set(path.resolve(copy.path), { patch: diff.stdout, tree: tree.stdout.trim() });
    return diff.stdout;
  });
}

/**
 * The tree each copy's last patch was read from, by the copy's folder. Apply takes the copy's
 * side from it, byte for byte, when it is handed that same patch.
 */
const stagedTrees = new Map<string, { patch: string; tree: string }>();

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

/** The files a patch touches, from its `diff --git` headers. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(match[2]);
  return [...files];
}

/**
 * Apply a copy's changes to the workspace as uncommitted edits. Each file is merged three ways, as
 * `git merge` would: the copy's version, the workspace's as it is on disk now (edits not yet
 * committed included), and the commit the copy started from. Changes to different lines both go
 * in; the same lines changed on both sides are left with conflict markers to resolve. Git's own
 * index is never touched, and nothing is committed. Throws when the changes can't go in at all.
 */
export function applyToWorkspace(copy: WorkingCopy, patch: string): Promise<ApplyResult> {
  return withRepoLock(copy.repo, async () => {
    const key = path.resolve(copy.path);
    const staged = stagedTrees.get(key);
    try {
      return await applyPatch(copy, patch, staged?.patch === patch ? staged.tree : null);
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

async function applyPatch(copy: WorkingCopy, patch: string, stagedTree: string | null): Promise<ApplyResult> {
  if (!patch.trim()) return { files: [], conflicts: [], kept: [] };
  if (!isCommitId(copy.base)) throw new Error("The changes don't apply to the workspace");
  const files = patchFiles(patch);
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
    const untracked = touched.filter((name) => {
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
    const theirsCommit = (await step(["commit-tree", "--no-gpg-sign", "-p", copy.base, "-m", copy.branch, theirs])).trim();
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
    const failed = new Set(await writeChanges(repo, changes, stages, labels));
    const marked = new Set(changes.filter((change) => withMarkers(change, stages) && !failed.has(change.path)).map((change) => change.path));
    const conflicts = unique([...stages.keys(), ...failed].map((name) => plainName(name, labels)));
    return { files, conflicts, kept: conflicts.filter((name) => !marked.has(name)) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
