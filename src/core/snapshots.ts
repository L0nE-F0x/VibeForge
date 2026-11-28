import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectory, readJson, writeJson } from "./fsx.js";
import { runGit, runGitBytes, type GitBytesResult, type GitResult } from "./git.js";
import { isPathInside } from "./places.js";
import { RUN_FILES } from "./runs.js";
import { isSafeId } from "./slug.js";
import type { RunMeta } from "./types.js";
import { isCommitId, repoRoot, withRepoLock } from "./worktrees.js";

/** New untracked files larger than this are left out of snapshots and remembered so restore leaves them alone. */
export const SNAPSHOT_NEW_FILE_LIMIT = 20 * 1024 * 1024;

const START_SNAPSHOT_TIMEOUT_MS = 5000;
const END_SNAPSHOT_TIMEOUT_MS = 10_000;
const GIT_OP_TIMEOUT_MS = 60_000;
const ZERO_OID = /^0+$/;

const SNAPSHOT_AUTHOR = {
  GIT_AUTHOR_NAME: "VibeForge",
  GIT_AUTHOR_EMAIL: "vibeforge@localhost",
  GIT_COMMITTER_NAME: "VibeForge",
  GIT_COMMITTER_EMAIL: "vibeforge@localhost",
};

export type RunRestoreAvailability = "ready" | "in-copy" | "running" | "not-repo" | "folder-gone" | "missing" | "no-changes";

export type RestoreFileAction = "restore" | "recreate" | "delete";

export type LeftAloneReason = "changed" | "oversized";

export interface RunRestorePreview {
  restorable: Array<{ path: string; action: RestoreFileAction }>;
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
}

export interface RunRestoreResult {
  restored: string[];
  deleted: string[];
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
  undo: string | null;
}

export interface RunSnapshotsRecord {
  repo: string;
  startCommit: string;
  startTree: string;
  startSkipped: string[];
  endCommit?: string | null;
  endTree?: string | null;
  endSkipped?: string[];
}

export interface SnapshotContext {
  cwd: string;
  runId: string;
  runDir: string;
  maxNewFileBytes?: number;
  onWarn?: (message: string) => void;
}

export interface RestoreUndoData {
  repo: string;
  startTree: string;
  endTree: string;
  files: string[];
}

interface GitOptions {
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

function snapGit(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitResult> {
  const pinned = ["--no-optional-locks", "-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
  return runGit([...pinned, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? GIT_OP_TIMEOUT_MS });
}

function snapGitBytes(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitBytesResult> {
  const pinned = ["--no-optional-locks", "-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];
  return runGitBytes([...pinned, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? GIT_OP_TIMEOUT_MS });
}

/** True when `cwd` sits inside VibeForge's managed worktrees folder (tasks and Viby copies have Discard instead). */
export function isRunInCopy(cwd: string, dataRoot: string): boolean {
  if (!cwd) return false;
  return isPathInside(path.join(path.resolve(dataRoot), "worktrees"), path.resolve(cwd));
}

/** Fast in-process check for a `.git` folder or file on or above `cwd` before spawning git. */
export function hasGitMarker(cwd: string): boolean {
  if (!cwd) return false;
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Ref name under `refs/vibeforge/runs/<runId>/<point>`, safe for git ref formatting and never pushed by default. */
export function snapshotRef(runId: string, point: "start" | "end"): string | null {
  if (!isSafeId(runId)) return null;
  const safe = runId.replace(/\.lock$/i, "_lock").replace(/\.+$/, "_");
  return `refs/vibeforge/runs/${safe}/${point}`;
}

function readSnapshotsRecord(runDir: string): RunSnapshotsRecord | null {
  if (!runDir) return null;
  const raw = readJson<unknown>(path.join(runDir, RUN_FILES.snapshots), null);
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const repo = typeof rec.repo === "string" && rec.repo.trim() ? rec.repo : "";
  const startCommit = typeof rec.startCommit === "string" && isCommitId(rec.startCommit) ? rec.startCommit : "";
  const startTree = typeof rec.startTree === "string" && isCommitId(rec.startTree) ? rec.startTree : "";
  const startSkipped = Array.isArray(rec.startSkipped) ? rec.startSkipped.filter((p): p is string => typeof p === "string") : [];
  const endCommit = typeof rec.endCommit === "string" && isCommitId(rec.endCommit) ? rec.endCommit : null;
  const endTree = typeof rec.endTree === "string" && isCommitId(rec.endTree) ? rec.endTree : null;
  const endSkipped = Array.isArray(rec.endSkipped) ? rec.endSkipped.filter((p): p is string => typeof p === "string") : [];
  if (!repo || !startCommit || !startTree) return null;
  return { repo, startCommit, startTree, startSkipped, endCommit, endTree, endSkipped };
}

function lstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Resolve `rel` inside `repo`, returning null when escaping `repo` or traversing a symlink directory. */
function placeIn(repo: string, rel: string, clearedFiles?: ReadonlySet<string>): string | null {
  if (!rel || /[\0\n\r]/.test(rel) || path.isAbsolute(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  let at = repo;
  let prefix = "";
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    const stat = lstat(at);
    if (!stat) break;
    if (!stat.isDirectory()) {
      if (!stat.isSymbolicLink() && clearedFiles?.has(prefix)) continue;
      return null;
    }
  }
  const full = path.join(repo, ...parts);
  return isPathInside(repo, full) ? full : null;
}

function gitErrorDetail(run: GitResult, fallback: string): string {
  const detail = run.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
  if (run.timedOut) return "git timed out";
  if (run.missing) return "git was not found on PATH";
  return detail || fallback;
}

interface CapturedTree {
  repo: string;
  tree: string;
  skipped: string[];
  headCommit: string | null;
  headTree: string | null;
}

type CaptureResult =
  | { ok: true; data: CapturedTree | null }
  | { ok: false; error: string };

/** Capture tracked and non-ignored untracked files into git's object store using a throwaway index. */
async function captureWorkingTree(cwd: string, maxNewFileBytes: number, timeoutMs: number): Promise<CaptureResult> {
  if (!cwd || !isDirectory(cwd) || !hasGitMarker(cwd)) return { ok: true, data: null };
  const started = Date.now();
  const budget = () => Math.max(250, timeoutMs - (Date.now() - started));
  const topRes = await snapGit(["rev-parse", "--show-toplevel"], cwd, { timeoutMs: budget() });
  if (topRes.code !== 0) {
    if (!topRes.missing && !topRes.timedOut && /not a git repository/i.test(topRes.stderr)) return { ok: true, data: null };
    return { ok: false, error: gitErrorDetail(topRes, "git rev-parse failed") };
  }
  const repo = topRes.stdout.trim() ? path.resolve(topRes.stdout.trim()) : "";
  if (!repo) return { ok: true, data: null };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-snap-"));
  const tempIndex = path.join(scratch, "index");
  try {
    // Seed from the real index (preserving timestamps) so unchanged files hit the stat cache and racy-clean edits still hash.
    const indexPathRes = await snapGit(["rev-parse", "--git-path", "index"], repo, { timeoutMs: budget() });
    if (indexPathRes.code === 0 && indexPathRes.stdout.trim()) {
      const realIndex = path.resolve(repo, indexPathRes.stdout.trim());
      if (fs.existsSync(realIndex)) {
        fs.copyFileSync(realIndex, tempIndex);
        const { atime, mtime } = fs.statSync(realIndex);
        fs.utimesSync(tempIndex, atime, mtime);
      }
    }

    const env = { GIT_INDEX_FILE: tempIndex };
    if (fs.existsSync(tempIndex)) {
      const updated = await snapGit(["add", "-u"], repo, { env, timeoutMs: budget() });
      if (updated.code !== 0) return { ok: false, error: gitErrorDetail(updated, "git add -u failed") };
    }

    const others = await snapGit(["ls-files", "--others", "--exclude-standard", "-z"], repo, { env, timeoutMs: budget() });
    if (others.code !== 0) return { ok: false, error: gitErrorDetail(others, "git ls-files failed") };

    const toStage: string[] = [];
    const skipped: string[] = [];
    for (const rel of others.stdout.split("\0")) {
      if (!rel || rel.endsWith("/")) continue;
      const full = placeIn(repo, rel);
      if (!full) continue;
      const stat = lstat(full);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        toStage.push(rel);
      } else if (stat.isFile()) {
        if (stat.size > maxNewFileBytes) skipped.push(rel);
        else toStage.push(rel);
      }
    }

    if (toStage.length > 0) {
      const staged = await snapGit(["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], repo, {
        env,
        input: `${toStage.join("\0")}\0`,
        timeoutMs: budget(),
      });
      if (staged.code !== 0) return { ok: false, error: gitErrorDetail(staged, "git add failed") };
    }

    const treeRes = await snapGit(["write-tree"], repo, { env, timeoutMs: budget() });
    const tree = treeRes.stdout.trim();
    if (treeRes.code !== 0 || !isCommitId(tree)) return { ok: false, error: gitErrorDetail(treeRes, "git write-tree failed") };

    const headRes = await snapGit(["rev-parse", "--verify", "-q", "HEAD"], repo, { timeoutMs: budget() });
    const headCommit = headRes.code === 0 && isCommitId(headRes.stdout.trim()) ? headRes.stdout.trim() : null;
    let headTree: string | null = null;
    if (headCommit) {
      const htRes = await snapGit(["rev-parse", "--verify", "-q", `${headCommit}^{tree}`], repo, { timeoutMs: budget() });
      if (htRes.code === 0 && isCommitId(htRes.stdout.trim())) headTree = htRes.stdout.trim();
    }

    return { ok: true, data: { repo, tree, skipped: skipped.sort(), headCommit, headTree } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function resolveSnapshotCommit(
  repo: string,
  tree: string,
  candidates: Array<{ commit: string | null | undefined; tree: string | null | undefined }>,
  timeoutMs: number,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  // Reusing HEAD (or startCommit) avoids cluttering `git log --all` with identical snapshot commits.
  for (const item of candidates) {
    if (item.commit && item.tree === tree && isCommitId(item.commit)) return { ok: true, commit: item.commit };
  }
  const commitRes = await snapGit(["commit-tree", "--no-gpg-sign", "-m", "VibeForge run snapshot", tree], repo, {
    env: SNAPSHOT_AUTHOR,
    timeoutMs,
  });
  const sha = commitRes.stdout.trim();
  if (commitRes.code !== 0 || !isCommitId(sha)) return { ok: false, error: gitErrorDetail(commitRes, "git commit-tree failed") };
  return { ok: true, commit: sha };
}

async function writeSnapshotRef(repo: string, ref: string, commit: string, timeoutMs: number): Promise<string | null> {
  const res = await snapGit(["-c", "core.logAllRefUpdates=false", "update-ref", "--no-deref", ref, commit], repo, { timeoutMs });
  return res.code === 0 ? null : gitErrorDetail(res, "git update-ref failed");
}

/**
 * Snapshot the working tree before a real-folder run starts, without touching the folder, real index, or HEAD.
 * Never throws: on error, logs via `onWarn` and lets the run carry on without undo.
 */
export async function takeStartSnapshot(ctx: SnapshotContext): Promise<RunSnapshotsRecord | null> {
  const ref = snapshotRef(ctx.runId, "start");
  if (!ref || !ctx.runDir || !isDirectory(ctx.runDir)) return null;
  try {
    const capture = await captureWorkingTree(ctx.cwd, ctx.maxNewFileBytes ?? SNAPSHOT_NEW_FILE_LIMIT, START_SNAPSHOT_TIMEOUT_MS);
    if (!capture.ok) {
      ctx.onWarn?.(`Could not save start snapshot for run ${ctx.runId}: ${capture.error}`);
      return null;
    }
    if (!capture.data) return null;
    const resolved = await resolveSnapshotCommit(
      capture.data.repo,
      capture.data.tree,
      [{ commit: capture.data.headCommit, tree: capture.data.headTree }],
      START_SNAPSHOT_TIMEOUT_MS,
    );
    if (!resolved.ok) {
      ctx.onWarn?.(`Could not save start snapshot for run ${ctx.runId}: ${resolved.error}`);
      return null;
    }
    const refErr = await writeSnapshotRef(capture.data.repo, ref, resolved.commit, START_SNAPSHOT_TIMEOUT_MS);
    if (refErr) {
      ctx.onWarn?.(`Could not save start snapshot for run ${ctx.runId}: ${refErr}`);
      return null;
    }
    const record: RunSnapshotsRecord = {
      repo: capture.data.repo,
      startCommit: resolved.commit,
      startTree: capture.data.tree,
      startSkipped: capture.data.skipped,
    };
    writeJson(path.join(ctx.runDir, RUN_FILES.snapshots), record);
    return record;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.onWarn?.(`Could not save start snapshot for run ${ctx.runId}: ${detail}`);
    return null;
  }
}

/**
 * Snapshot the working tree right after a real-folder run ends, reusing `start` when recorded.
 * Never throws: on error, logs via `onWarn` and leaves the run without end snapshot.
 */
export async function takeEndSnapshot(ctx: SnapshotContext): Promise<RunSnapshotsRecord | null> {
  const startRef = snapshotRef(ctx.runId, "start");
  const endRef = snapshotRef(ctx.runId, "end");
  if (!startRef || !endRef || !ctx.runDir || !isDirectory(ctx.runDir)) return null;
  const existing = readSnapshotsRecord(ctx.runDir);
  if (!existing) return null;
  try {
    const startAlive = await snapGit(["rev-parse", "--verify", "-q", `${startRef}^{tree}`], existing.repo, { timeoutMs: 3000 });
    if (startAlive.code !== 0) return null;
    const capture = await captureWorkingTree(ctx.cwd, ctx.maxNewFileBytes ?? SNAPSHOT_NEW_FILE_LIMIT, END_SNAPSHOT_TIMEOUT_MS);
    if (!capture.ok) {
      ctx.onWarn?.(`Could not save end snapshot for run ${ctx.runId}: ${capture.error}`);
      return null;
    }
    if (!capture.data || path.resolve(capture.data.repo) !== path.resolve(existing.repo)) return null;
    const resolved = await resolveSnapshotCommit(
      capture.data.repo,
      capture.data.tree,
      [
        { commit: capture.data.headCommit, tree: capture.data.headTree },
        { commit: existing.startCommit, tree: existing.startTree },
      ],
      END_SNAPSHOT_TIMEOUT_MS,
    );
    if (!resolved.ok) {
      ctx.onWarn?.(`Could not save end snapshot for run ${ctx.runId}: ${resolved.error}`);
      return null;
    }
    const refErr = await writeSnapshotRef(capture.data.repo, endRef, resolved.commit, END_SNAPSHOT_TIMEOUT_MS);
    if (refErr) {
      ctx.onWarn?.(`Could not save end snapshot for run ${ctx.runId}: ${refErr}`);
      return null;
    }
    const updated: RunSnapshotsRecord = {
      ...existing,
      endCommit: resolved.commit,
      endTree: capture.data.tree,
      endSkipped: capture.data.skipped,
    };
    writeJson(path.join(ctx.runDir, RUN_FILES.snapshots), updated);
    return updated;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.onWarn?.(`Could not save end snapshot for run ${ctx.runId}: ${detail}`);
    return null;
  }
}

/** Remove `refs/vibeforge/runs/<runId>/{start,end}` from the run's repository when a run is deleted/tidied. */
export async function removeRunSnapshots(run: Pick<RunMeta, "id" | "cwd" | "dir">): Promise<void> {
  const startRef = snapshotRef(run.id, "start");
  const endRef = snapshotRef(run.id, "end");
  if (!startRef || !endRef) return;
  const record = readSnapshotsRecord(run.dir);
  const candidate = record?.repo || run.cwd;
  if (!candidate || !isDirectory(candidate) || !hasGitMarker(candidate)) return;
  try {
    const repo = record?.repo ? path.resolve(record.repo) : await repoRoot(candidate);
    if (!repo || !isDirectory(repo)) return;
    await withRepoLock(repo, async () => {
      for (const ref of [startRef, endRef]) {
        await snapGit(["update-ref", "--no-deref", "-d", ref], repo, { timeoutMs: 5000 }).catch(() => undefined);
      }
    });
  } catch {
    /* ref cleanup is best-effort when tidying or deleting runs */
  }
}

/** Fast synchronous check of whether a run can offer "Put files back as before this run". */
export function getRunRestoreAvailability(run: Pick<RunMeta, "id" | "cwd" | "dir" | "status">, dataRoot: string, gitSnapshot = ""): RunRestoreAvailability {
  if (isRunInCopy(run.cwd, dataRoot)) return "in-copy";
  if (run.status === "running") return "running";
  if (!run.cwd || !isDirectory(run.cwd)) return "folder-gone";
  const record = readSnapshotsRecord(run.dir);
  if (!record?.endCommit || !record.endTree) {
    if (gitSnapshot.startsWith("not a git repo") || !hasGitMarker(run.cwd)) return "not-repo";
    return "missing";
  }
  const startSkipped = new Set(record.startSkipped);
  const newOversized = (record.endSkipped ?? []).some((file) => !startSkipped.has(file));
  if (record.startTree === record.endTree && !newOversized) return "no-changes";
  return "ready";
}

/** Authoritative check for `loadRun`, confirming the git refs still exist in the repository. */
export async function checkRunRestoreAvailability(
  run: Pick<RunMeta, "id" | "cwd" | "dir" | "status">,
  dataRoot: string,
  gitSnapshot = "",
): Promise<RunRestoreAvailability> {
  const quick = getRunRestoreAvailability(run, dataRoot, gitSnapshot);
  if (quick !== "ready") return quick;
  const record = readSnapshotsRecord(run.dir);
  const startRef = snapshotRef(run.id, "start");
  const endRef = snapshotRef(run.id, "end");
  if (!record || !startRef || !endRef) return "missing";
  const repo = await repoRoot(run.cwd).catch(() => null);
  if (!repo || path.resolve(repo) !== path.resolve(record.repo)) return "missing";
  const [startOk, endOk] = await Promise.all([
    snapGit(["rev-parse", "--verify", "-q", `${startRef}^{tree}`], repo, { timeoutMs: 3000 }),
    snapGit(["rev-parse", "--verify", "-q", `${endRef}^{tree}`], repo, { timeoutMs: 3000 }),
  ]);
  if (startOk.code !== 0 || endOk.code !== 0) return "missing";
  return "ready";
}

interface ValidatedSnapshots {
  repo: string;
  startTree: string;
  endTree: string;
  record: RunSnapshotsRecord;
}

async function validateRestoreContext(run: RunMeta | null, dataRoot: string): Promise<ValidatedSnapshots> {
  if (!run) throw new Error("That run no longer exists.");
  if (isRunInCopy(run.cwd, dataRoot)) throw new Error("This run worked in a separate copy; use Discard on the copy instead.");
  if (run.status === "running") throw new Error("Wait until this run finishes before putting files back.");
  if (!run.cwd || !isDirectory(run.cwd)) throw new Error("That folder does not exist any more.");
  const repo = await repoRoot(run.cwd);
  if (!repo) throw new Error("This folder is not a git repository.");
  const record = readSnapshotsRecord(run.dir);
  const startRef = snapshotRef(run.id, "start");
  const endRef = snapshotRef(run.id, "end");
  if (!record?.endCommit || !record.endTree || !startRef || !endRef) {
    throw new Error("No before-and-after snapshot was saved for this run.");
  }
  if (path.resolve(repo) !== path.resolve(record.repo)) {
    throw new Error("This run's snapshot points at another repository, so nothing was changed.");
  }
  const [startTreeRes, endTreeRes] = await Promise.all([
    snapGit(["rev-parse", "--verify", "-q", `${startRef}^{tree}`], repo, { timeoutMs: 5000 }),
    snapGit(["rev-parse", "--verify", "-q", `${endRef}^{tree}`], repo, { timeoutMs: 5000 }),
  ]);
  const startTree = startTreeRes.stdout.trim();
  const endTree = endTreeRes.stdout.trim();
  if (startTreeRes.code !== 0 || endTreeRes.code !== 0 || !isCommitId(startTree) || !isCommitId(endTree)) {
    throw new Error("No before-and-after snapshot was saved for this run.");
  }
  return { repo, startTree, endTree, record };
}

interface TreeDiffEntry {
  path: string;
  startMode: string;
  endMode: string;
  startOid: string;
  endOid: string;
}

async function diffTrees(repo: string, fromTree: string, toTree: string): Promise<TreeDiffEntry[]> {
  if (fromTree === toTree) return [];
  const run = await snapGit(["diff-tree", "-r", "-z", "--no-renames", fromTree, toTree], repo);
  if (run.code !== 0) throw new Error(`Could not read this run's snapshot: ${gitErrorDetail(run, "git diff-tree failed")}`);
  const parts = run.stdout.split("\0");
  const out: TreeDiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]$/.exec(parts[i]);
    if (!match) break;
    out.push({
      path: parts[i + 1],
      startMode: match[1],
      endMode: match[2],
      startOid: match[3],
      endOid: match[4],
    });
  }
  return out;
}

interface DiskEntry {
  mode: string;
  oid: string;
}

/** Hash specific repo-relative paths on disk in an isolated empty index without touching `.git/index`. */
async function inspectPathsOnDisk(repo: string, paths: readonly string[]): Promise<Map<string, DiskEntry>> {
  const result = new Map<string, DiskEntry>();
  const present: string[] = [];
  for (const rel of paths) {
    const full = placeIn(repo, rel);
    if (!full) continue;
    const stat = lstat(full);
    if (stat && (stat.isFile() || stat.isSymbolicLink())) present.push(rel);
  }
  if (!present.length) return result;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-check-"));
  const tempIndex = path.join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    const added = await snapGit(["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], repo, {
      env,
      input: `${present.join("\0")}\0`,
    });
    if (added.code !== 0) throw new Error(`Could not read this run's snapshot: ${gitErrorDetail(added, "git add failed")}`);
    const staged = await snapGit(["ls-files", "--stage", "-z"], repo, { env });
    if (staged.code !== 0) throw new Error(`Could not read this run's snapshot: ${gitErrorDetail(staged, "git ls-files failed")}`);
    for (const line of staged.stdout.split("\0")) {
      if (!line) continue;
      const match = /^(\d{6}) ([0-9a-f]+) \d+\t(.+)$/s.exec(line);
      if (match) result.set(match[3], { mode: match[1], oid: match[2] });
    }
    return result;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** True when `dirPath` holds nothing except files/symlinks already scheduled to be deleted during restore. */
function dirClearedByDeletes(repo: string, dirPath: string, willDelete: ReadonlySet<string>): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!dirClearedByDeletes(repo, full, willDelete)) return false;
    } else {
      const rel = path.relative(repo, full).split(path.sep).join("/");
      if (!willDelete.has(rel)) return false;
    }
  }
  return true;
}

interface ComputedRestorePlan {
  restorable: Array<{ path: string; action: RestoreFileAction; mode: string; oid: string }>;
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
}

async function computeRestorePlan(validated: ValidatedSnapshots): Promise<ComputedRestorePlan> {
  const { repo, startTree, endTree, record } = validated;
  const entries = await diffTrees(repo, startTree, endTree);
  const skippedSet = new Set([...record.startSkipped, ...(record.endSkipped ?? [])]);
  const startSkippedSet = new Set(record.startSkipped);

  const restorable: ComputedRestorePlan["restorable"] = [];
  const leftAlone: ComputedRestorePlan["leftAlone"] = [];
  const leftPaths = new Set<string>();
  const addLeft = (rel: string, reason: LeftAloneReason) => {
    if (leftPaths.has(rel)) return;
    leftPaths.add(rel);
    leftAlone.push({ path: rel, reason });
  };

  const candidates: TreeDiffEntry[] = [];
  for (const entry of entries) {
    if (skippedSet.has(entry.path)) {
      addLeft(entry.path, "oversized");
      continue;
    }
    if (entry.startMode === "160000" || entry.endMode === "160000") {
      addLeft(entry.path, "changed");
      continue;
    }
    candidates.push(entry);
  }

  // An oversized new file created by the run leaves `startTree === endTree`; list it if it still sits on disk.
  for (const rel of record.endSkipped ?? []) {
    if (startSkippedSet.has(rel) || leftPaths.has(rel)) continue;
    const full = placeIn(repo, rel);
    if (full && lstat(full)) addLeft(rel, "oversized");
  }

  const onDisk = await inspectPathsOnDisk(
    repo,
    candidates.map((entry) => entry.path),
  );

  // First pass: which run-created files will be deleted (needed to tell if a blocking parent dir/file clears cleanly).
  const willDelete = new Set<string>();
  for (const entry of candidates) {
    if (!ZERO_OID.test(entry.startOid) || ZERO_OID.test(entry.endOid)) continue;
    const now = onDisk.get(entry.path);
    if (now && now.mode === entry.endMode && now.oid === entry.endOid) willDelete.add(entry.path);
  }

  for (const entry of candidates) {
    const startAbsent = ZERO_OID.test(entry.startOid);
    const endAbsent = ZERO_OID.test(entry.endOid);
    const now = onDisk.get(entry.path);
    const full = placeIn(repo, entry.path);
    const stat = full ? lstat(full) : null;

    if (startAbsent && !endAbsent) {
      if (now && now.mode === entry.endMode && now.oid === entry.endOid) {
        restorable.push({ path: entry.path, action: "delete", mode: entry.endMode, oid: entry.endOid });
      } else if (!stat) {
        /* already deleted since the run ended */
      } else {
        addLeft(entry.path, "changed");
      }
      continue;
    }

    if (!startAbsent && !endAbsent) {
      if (now && now.mode === entry.endMode && now.oid === entry.endOid) {
        restorable.push({ path: entry.path, action: "restore", mode: entry.startMode, oid: entry.startOid });
      } else if (now && now.mode === entry.startMode && now.oid === entry.startOid) {
        /* already matches the pre-run state */
      } else {
        addLeft(entry.path, "changed");
      }
      continue;
    }

    if (!startAbsent && endAbsent) {
      const target = placeIn(repo, entry.path, willDelete);
      const targetStat = target ? lstat(target) : null;
      if (now && now.mode === entry.startMode && now.oid === entry.startOid) {
        /* already back at its pre-run state */
      } else if (!targetStat && target !== null) {
        restorable.push({ path: entry.path, action: "recreate", mode: entry.startMode, oid: entry.startOid });
      } else if (targetStat?.isDirectory() && target && dirClearedByDeletes(repo, target, willDelete)) {
        restorable.push({ path: entry.path, action: "recreate", mode: entry.startMode, oid: entry.startOid });
      } else if (targetStat && willDelete.has(entry.path)) {
        restorable.push({ path: entry.path, action: "recreate", mode: entry.startMode, oid: entry.startOid });
      } else {
        addLeft(entry.path, "changed");
      }
    }
  }

  return { restorable, leftAlone };
}

/** Preview which files a run restore will put back or leave alone. Read-only. */
export async function previewRunRestore(run: RunMeta | null, dataRoot: string): Promise<RunRestorePreview> {
  const validated = await validateRestoreContext(run, dataRoot);
  const plan = await computeRestorePlan(validated);
  return {
    restorable: plan.restorable.map(({ path: file, action }) => ({ path: file, action })),
    leftAlone: plan.leftAlone,
  };
}

/**
 * Put files back as they were before `run`: restores files that still match the end snapshot, deletes
 * files the run created (if still unchanged), and leaves alone anything edited since or skipped over the
 * size cap. Returns what changed along with `undoData` so Undo can put the end state back for those exact files.
 */
export async function restoreRunFiles(
  run: RunMeta | null,
  dataRoot: string,
): Promise<{ result: Omit<RunRestoreResult, "undo">; undoData: RestoreUndoData | null }> {
  const validated = await validateRestoreContext(run, dataRoot);
  return withRepoLock(validated.repo, async () => {
    const plan = await computeRestorePlan(validated);
    const restored: string[] = [];
    const deleted: string[] = [];
    const leftAlone = [...plan.leftAlone];

    const deletions = plan.restorable.filter((item) => item.action === "delete");
    const writes = plan.restorable.filter((item) => item.action !== "delete");

    for (const item of deletions) {
      const target = placeIn(validated.repo, item.path);
      if (target && removeEntry(validated.repo, target)) {
        restored.push(item.path);
        deleted.push(item.path);
      } else {
        leftAlone.push({ path: item.path, reason: "changed" });
      }
    }

    for (const item of writes) {
      const target = placeIn(validated.repo, item.path);
      if (target && (await writeTreeBlob(validated.repo, target, item.path, item.mode, item.oid))) {
        restored.push(item.path);
      } else {
        leftAlone.push({ path: item.path, reason: "changed" });
      }
    }

    const undoData: RestoreUndoData | null =
      restored.length > 0
        ? {
            repo: validated.repo,
            startTree: validated.startTree,
            endTree: validated.endTree,
            files: restored,
          }
        : null;

    return {
      result: { restored, deleted, leftAlone },
      undoData,
    };
  });
}

/**
 * Put the run's end state back for **only** the files previously restored by `restoreRunFiles`,
 * skipping any file whose working-tree state changed again after the restore.
 */
export async function applyUndoRestore(data: RestoreUndoData): Promise<string[]> {
  if (!data.files.length || !isDirectory(data.repo)) return [];
  return withRepoLock(data.repo, async () => {
    const entries = await diffTrees(data.repo, data.startTree, data.endTree);
    const wanted = new Set(data.files);
    const relevant = entries.filter((entry) => wanted.has(entry.path));
    if (!relevant.length) return [];

    const onDisk = await inspectPathsOnDisk(
      data.repo,
      relevant.map((entry) => entry.path),
    );

    // Only revert files that still match the restored `start` state on disk.
    // Pass 1: deletions (files absent at `end`, currently matching `start`), so pass 2 knows which blocking files will clear.
    const deletes: TreeDiffEntry[] = [];
    const willDelete = new Set<string>();
    for (const entry of relevant) {
      const startAbsent = ZERO_OID.test(entry.startOid);
      const endAbsent = ZERO_OID.test(entry.endOid);
      if (startAbsent || !endAbsent) continue;
      const now = onDisk.get(entry.path);
      if (now && now.mode === entry.startMode && now.oid === entry.startOid) {
        deletes.push(entry);
        willDelete.add(entry.path);
      }
    }

    // Pass 2: writes (files present at `end`, currently matching `start` or absent when created by the run).
    const writes: TreeDiffEntry[] = [];
    for (const entry of relevant) {
      const startAbsent = ZERO_OID.test(entry.startOid);
      const endAbsent = ZERO_OID.test(entry.endOid);
      if (endAbsent) continue;
      const now = onDisk.get(entry.path);
      const full = placeIn(data.repo, entry.path, willDelete);
      const stat = full ? lstat(full) : null;
      if (startAbsent) {
        if (!stat && full !== null) writes.push(entry);
      } else if (now && now.mode === entry.startMode && now.oid === entry.startOid) {
        writes.push(entry);
      }
    }

    const reverted: string[] = [];
    for (const entry of deletes) {
      const target = placeIn(data.repo, entry.path);
      if (target && removeEntry(data.repo, target)) reverted.push(entry.path);
    }
    for (const entry of writes) {
      const target = placeIn(data.repo, entry.path);
      const stat = target ? lstat(target) : null;
      if (stat?.isDirectory() && target && !dirClearedByDeletes(data.repo, target, willDelete)) continue;
      if (target && (await writeTreeBlob(data.repo, target, entry.path, entry.endMode, entry.endOid))) {
        reverted.push(entry.path);
      }
    }
    return reverted;
  });
}

async function writeTreeBlob(repo: string, target: string, rel: string, mode: string, oid: string): Promise<boolean> {
  const link = mode === "120000";
  const read = await snapGitBytes(link ? ["cat-file", "blob", oid] : ["cat-file", "--filters", `--path=${rel}`, oid], repo);
  if (read.code !== 0) return false;
  try {
    const stat = lstat(target);
    if (stat?.isDirectory()) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat?.isSymbolicLink() || (stat && link)) fs.rmSync(target, { force: true });
    if (link) {
      fs.symlinkSync(read.stdout.toString("utf8"), target);
      return true;
    }
    const executable = mode === "100755";
    fs.writeFileSync(target, read.stdout, { mode: executable ? 0o777 : 0o666 });
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

function removeEntry(repo: string, target: string): boolean {
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
