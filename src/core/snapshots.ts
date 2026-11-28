import { createHash, randomBytes } from "node:crypto";
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

// Each real-folder run gets two snapshots of the working tree, at its start and its end, kept as
// hidden git objects under refs/vibeforge/runs/<run>/<tag>/{start,end} in the person's repository.
// They let "Put files back as before this run" bring back what the run changed. They never touch
// the person's index, HEAD or history, and they hold raw bytes: no clean or smudge filter (Git
// LFS and the like) ever runs, so nothing is downloaded and nothing else is started.

/** New untracked files larger than this are left out of snapshots and remembered so restore leaves them alone. */
export const SNAPSHOT_NEW_FILE_LIMIT = 20 * 1024 * 1024;
/** More untracked files than this and the run has no undo: saving them would take too long and fill `.git`. */
export const SNAPSHOT_MAX_NEW_FILES = 5000;
/** More new content than this (untracked files plus changed tracked files) and the run has no undo. */
export const SNAPSHOT_MAX_NEW_BYTES = 200 * 1024 * 1024;
/** Snapshots older than this are removed, whether or not the run is still kept. */
export const SNAPSHOT_KEEP_DAYS = 30;
/** The most a run's start waits on its snapshot, every git step included. */
export const START_SNAPSHOT_BUDGET_MS = 1500;

const END_SNAPSHOT_BUDGET_MS = 10_000;
const GIT_OP_TIMEOUT_MS = 60_000;
/** A git step with less time than this left isn't started. */
const MIN_STEP_MS = 25;
const ZERO_OID = /^0+$/;
const NONCE = /^[0-9a-f]{16}$/;
const OWNER = /^[0-9a-f]{8}$/;
const RUN_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z/;
const SNAPSHOT_INDEX = "run-snapshots.json";
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

const SNAPSHOT_AUTHOR = {
  GIT_AUTHOR_NAME: "VibeForge",
  GIT_AUTHOR_EMAIL: "vibeforge@localhost",
  GIT_COMMITTER_NAME: "VibeForge",
  GIT_COMMITTER_EMAIL: "vibeforge@localhost",
};

export type RunRestoreAvailability = "ready" | "in-copy" | "running" | "not-repo" | "folder-gone" | "missing" | "no-changes";

export type RestoreFileAction = "restore" | "recreate" | "delete";

/**
 * Why a file is left alone: "changed" since the run (or since the preview), "oversized" (too big
 * to snapshot), "submodule" (submodules aren't supported), "filtered" (a git filter such as LFS, or
 * line-ending rules, apply to it, so its saved bytes may not be what was on disk).
 */
export type LeftAloneReason = "changed" | "oversized" | "submodule" | "filtered";

export interface RestoreItem {
  path: string;
  action: RestoreFileAction;
  /** What was on disk when the preview was made. Confirm sends it back; a file that differs by then is left alone. */
  expect: string;
}

export interface RunRestorePreview {
  restorable: RestoreItem[];
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
  /** Other runs that were going in the same repository while this one ran: their changes in these files go back too. */
  overlapping: Array<{ id: string; title: string }>;
  /** The run was cut off by a close, and its after-snapshot was taken when VibeForge started again. */
  lateEnd: boolean;
}

/** One file from the preview that the person confirmed: its path and what was on disk then. */
export interface RestorePick {
  path: string;
  expect: string;
}

export interface RunRestoreResult {
  restored: string[];
  deleted: string[];
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
  undo: string | null;
}

export interface RunRestoreUndoResult {
  /** Files put back to how the run left them. */
  reverted: string[];
  /** Files that changed again after the restore, so Undo left them as they are. */
  leftAlone: string[];
}

export interface RunSnapshotsRecord {
  repo: string;
  /** The random part of this run's ref names: `refs/vibeforge/runs/<run>/<nonce>/{start,end}`. */
  nonce?: string;
  startCommit: string;
  startTree: string;
  startSkipped: string[];
  endCommit?: string | null;
  endTree?: string | null;
  endSkipped?: string[];
  /** The end snapshot was taken on the next start, because a close cut the run off. */
  endLate?: boolean;
}

export interface SnapshotContext {
  cwd: string;
  runId: string;
  runDir: string;
  /** VibeForge's data folder: where it keeps which repositories hold snapshots, so they can be tidied. */
  dataRoot?: string;
  maxNewFileBytes?: number;
  maxNewFiles?: number;
  maxNewBytes?: number;
  /** The most the whole snapshot may take. */
  budgetMs?: number;
  onWarn?: (message: string) => void;
}

export interface RestoreUndoData {
  repo: string;
  format: string;
  startTree: string;
  endTree: string;
  files: string[];
}

/** The other runs a restore looks at, to warn about ones that overlapped and refuse while one is going. */
export type NeighbourRun = Pick<RunMeta, "id" | "title" | "cwd" | "dir" | "status" | "startedAt" | "endedAt">;

interface GitOptions {
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const PINNED = ["--no-optional-locks", "-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"];

function snapGit(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitResult> {
  return runGit([...PINNED, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? GIT_OP_TIMEOUT_MS });
}

function snapGitBytes(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<GitBytesResult> {
  return runGitBytes([...PINNED, ...args], { cwd, input: options.input, env: options.env, timeoutMs: options.timeoutMs ?? GIT_OP_TIMEOUT_MS });
}

/**
 * Git options that make `git add` store a file's bytes exactly as they are: no attributes are read
 * (so no clean filter, LFS included, and no line-ending change), and no system attributes either.
 * `.git/info/attributes` can't be switched off this way, so a repository with one gets no snapshot.
 */
function rawArgs(emptyTree: string): string[] {
  return [`--attr-source=${emptyTree}`, "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
}

const RAW_ENV = { GIT_ATTR_NOSYSTEM: "1" };

const OUT_OF_TIME: GitResult = { code: 124, stdout: "", stderr: "", timedOut: true, missing: false, truncated: false };

type TimedGit = (args: readonly string[], cwd: string, options?: Omit<GitOptions, "timeoutMs">) => Promise<GitResult>;

/** Git steps that share one deadline: each gets the time that is left, and none starts once it has run out. */
function withinDeadline(deadline: number): TimedGit {
  return (args, cwd, options = {}) => {
    const left = deadline - Date.now();
    if (left < MIN_STEP_MS) return Promise.resolve(OUT_OF_TIME);
    return snapGit(args, cwd, { ...options, timeoutMs: left });
  };
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

/**
 * Ref name for a run's snapshot, safe for git ref formatting and never pushed by default:
 * `refs/vibeforge/runs/<runId>/<nonce>/<point>`. The random nonce keeps two machines that share
 * a `.git` (through Sync) from ever picking the same name. Without one, the older name.
 */
export function snapshotRef(runId: string, point: "start" | "end", nonce?: string): string | null {
  if (!isSafeId(runId)) return null;
  const safe = runId.replace(/\.lock$/i, "_lock").replace(/\.+$/, "_");
  if (nonce === undefined) return `refs/vibeforge/runs/${safe}/${point}`;
  if (!NONCE.test(nonce)) return null;
  return `refs/vibeforge/runs/${safe}/${nonce}/${point}`;
}

function refsOf(runId: string, record: RunSnapshotsRecord): { start: string; end: string } | null {
  const start = snapshotRef(runId, "start", record.nonce);
  const end = snapshotRef(runId, "end", record.nonce);
  return start && end ? { start, end } : null;
}

function readSnapshotsRecord(runDir: string): RunSnapshotsRecord | null {
  if (!runDir) return null;
  const raw = readJson<unknown>(path.join(runDir, RUN_FILES.snapshots), null);
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const repo = typeof rec.repo === "string" && rec.repo.trim() ? rec.repo : "";
  const nonce = typeof rec.nonce === "string" && NONCE.test(rec.nonce) ? rec.nonce : undefined;
  const startCommit = typeof rec.startCommit === "string" && isCommitId(rec.startCommit) ? rec.startCommit : "";
  const startTree = typeof rec.startTree === "string" && isCommitId(rec.startTree) ? rec.startTree : "";
  const startSkipped = Array.isArray(rec.startSkipped) ? rec.startSkipped.filter((p): p is string => typeof p === "string") : [];
  const endCommit = typeof rec.endCommit === "string" && isCommitId(rec.endCommit) ? rec.endCommit : null;
  const endTree = typeof rec.endTree === "string" && isCommitId(rec.endTree) ? rec.endTree : null;
  const endSkipped = Array.isArray(rec.endSkipped) ? rec.endSkipped.filter((p): p is string => typeof p === "string") : [];
  if (!repo || !startCommit || !startTree) return null;
  return { repo, ...(nonce ? { nonce } : {}), startCommit, startTree, startSkipped, endCommit, endTree, endSkipped, ...(rec.endLate === true ? { endLate: true } : {}) };
}

// ---------------------------------------------------------------- which repositories hold snapshots

interface SnapshotIndex {
  /** This VibeForge's own mark, the start of every nonce it makes. */
  owner: string;
  /** Repositories it has written snapshot refs into, so they can be tidied after their runs are gone. */
  repos: string[];
}

function readIndex(dataRoot: string): SnapshotIndex {
  const raw = readJson<Partial<SnapshotIndex> | null>(path.join(dataRoot, SNAPSHOT_INDEX), null);
  const owner = typeof raw?.owner === "string" && OWNER.test(raw.owner) ? raw.owner : "";
  const repos = Array.isArray(raw?.repos) ? raw.repos.filter((repo): repo is string => typeof repo === "string" && path.isAbsolute(repo)) : [];
  return { owner, repos: [...new Set(repos)] };
}

function writeIndex(dataRoot: string, index: SnapshotIndex): void {
  try {
    writeJson(path.join(dataRoot, SNAPSHOT_INDEX), index);
  } catch {
    /* tidying is best-effort: a run's own folder still knows its refs */
  }
}

function ownerOf(dataRoot: string | undefined): string {
  if (!dataRoot || !isDirectory(dataRoot)) return randomBytes(4).toString("hex");
  const index = readIndex(dataRoot);
  if (index.owner) return index.owner;
  const owner = randomBytes(4).toString("hex");
  writeIndex(dataRoot, { ...index, owner });
  return owner;
}

function noteRepo(dataRoot: string | undefined, repo: string): void {
  if (!dataRoot || !isDirectory(dataRoot)) return;
  const index = readIndex(dataRoot);
  const resolved = path.resolve(repo);
  if (index.repos.includes(resolved)) return;
  writeIndex(dataRoot, { owner: index.owner || randomBytes(4).toString("hex"), repos: [...index.repos, resolved] });
}

// ---------------------------------------------------------------- the disk

function lstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function validRel(rel: string): string[] | null {
  if (!rel || /[\0\n\r]/.test(rel) || path.isAbsolute(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  return parts;
}

/**
 * Where `rel` is inside `repo`, and what is in the way: "ok" when every folder above it is a real
 * folder, "absent" when one is missing (or is a file or link in `cleared`, which goes first), and
 * "blocked" when a file or a link stands where a folder should be. Links are never followed.
 */
function locate(repo: string, rel: string, cleared?: ReadonlySet<string>): { full: string; parents: "ok" | "absent" | "blocked" } | null {
  const parts = validRel(rel);
  if (!parts) return null;
  const full = path.join(repo, ...parts);
  if (!isPathInside(repo, full)) return null;
  let at = repo;
  let prefix = "";
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    const stat = lstat(at);
    if (!stat) return { full, parents: "absent" };
    if (stat.isDirectory()) continue;
    return { full, parents: cleared?.has(prefix) ? "absent" : "blocked" };
  }
  return { full, parents: "ok" };
}

/** Git's id for a blob holding `size` bytes read from `chunks`, computed here so no filter can run. */
async function hashBlob(format: string, size: number, chunks: AsyncIterable<Buffer> | Buffer[]): Promise<string | null> {
  const hash = createHash(format === "sha256" ? "sha256" : "sha1");
  hash.update(`blob ${size}\0`);
  let read = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    read += chunk.length;
  }
  return read === size ? hash.digest("hex") : null;
}

/**
 * What is at `rel` on disk right now, in the terms a tree uses: "absent", "dir", "blocked", or
 * `<mode>:<blob id>` for a file or link. `cleared` names files and links that go first.
 */
async function diskState(repo: string, format: string, rel: string, cleared?: ReadonlySet<string>): Promise<string> {
  const place = locate(repo, rel, cleared);
  if (!place) return "blocked";
  if (place.parents !== "ok") return place.parents;
  const stat = lstat(place.full);
  if (!stat) return "absent";
  if (stat.isDirectory()) return "dir";
  try {
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(place.full, { encoding: "buffer" });
      return `120000:${await hashBlob(format, target.length, [target])}`;
    }
    if (!stat.isFile()) return "blocked";
    const oid = await hashBlob(format, stat.size, fs.createReadStream(place.full));
    return oid ? `${stat.mode & 0o100 ? "100755" : "100644"}:${oid}` : "changing";
  } catch {
    return "blocked";
  }
}

function treeState(mode: string, oid: string): string {
  return ZERO_OID.test(oid) ? "absent" : `${mode}:${oid}`;
}

function gitErrorDetail(run: GitResult, fallback: string): string {
  const detail = run.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
  if (run.timedOut) return "it took too long";
  if (run.missing) return "git was not found on PATH";
  return detail || fallback;
}

// ---------------------------------------------------------------- taking snapshots

interface CapturedTree {
  repo: string;
  tree: string;
  skipped: string[];
  headCommit: string | null;
  headTree: string | null;
}

type CaptureResult = { ok: true; data: CapturedTree | null } | { ok: false; error: string };

interface Limits {
  maxNewFileBytes: number;
  maxNewFiles: number;
  maxNewBytes: number;
}

function limitsOf(ctx: SnapshotContext): Limits {
  return {
    maxNewFileBytes: ctx.maxNewFileBytes ?? SNAPSHOT_NEW_FILE_LIMIT,
    maxNewFiles: ctx.maxNewFiles ?? SNAPSHOT_MAX_NEW_FILES,
    maxNewBytes: ctx.maxNewBytes ?? SNAPSHOT_MAX_NEW_BYTES,
  };
}

function hasAttributeLines(file: string): boolean {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((line) => line.trim() && !line.trim().startsWith("#"));
  } catch {
    return false;
  }
}

/** Capture tracked and non-ignored untracked files, as raw bytes, into git's object store using a throwaway index. */
async function captureWorkingTree(cwd: string, limits: Limits, git: TimedGit): Promise<CaptureResult> {
  if (!cwd || !isDirectory(cwd) || !hasGitMarker(cwd)) return { ok: true, data: null };
  const topRes = await git(["rev-parse", "--show-toplevel", "--show-object-format", "--git-path", "index", "--git-path", "info/attributes"], cwd);
  if (topRes.code !== 0) {
    if (!topRes.missing && !topRes.timedOut && /not a git repository/i.test(topRes.stderr)) return { ok: true, data: null };
    return { ok: false, error: gitErrorDetail(topRes, "git rev-parse failed") };
  }
  const [top = "", format = "", indexRel = "", attributesRel = ""] = topRes.stdout.split("\n").map((line) => line.trim());
  const repo = top ? path.resolve(top) : "";
  if (!repo) return { ok: true, data: null };
  const emptyTree = EMPTY_TREE[format];
  if (!emptyTree) return { ok: false, error: `git object format ${format || "unknown"} is not supported` };
  if (attributesRel && hasAttributeLines(path.resolve(cwd, attributesRel))) {
    return { ok: false, error: "the repository has .git/info/attributes, which could run git filters" };
  }
  const raw = rawArgs(emptyTree);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-snap-"));
  const tempIndex = path.join(scratch, "index");
  try {
    // Seed from the real index (preserving timestamps) so unchanged files hit the stat cache and racy-clean edits still hash.
    const realIndex = indexRel ? path.resolve(cwd, indexRel) : "";
    if (realIndex && fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tempIndex);
      const { atime, mtime } = fs.statSync(realIndex);
      fs.utimesSync(tempIndex, atime, mtime);
    }
    const seeded = fs.existsSync(tempIndex);
    const env = { ...RAW_ENV, GIT_INDEX_FILE: tempIndex };

    // What would be new in .git: every untracked file, and every tracked file whose stat changed.
    const [others, dirty] = await Promise.all([
      git([...raw, "ls-files", "--others", "--exclude-standard", "-z"], repo, { env }),
      seeded ? git([...raw, "diff-files", "--name-only", "-z"], repo, { env }) : Promise.resolve({ ...OUT_OF_TIME, code: 0, timedOut: false }),
    ]);
    if (others.code !== 0) return { ok: false, error: gitErrorDetail(others, "git ls-files failed") };
    if (dirty.code !== 0) return { ok: false, error: gitErrorDetail(dirty, "git diff-files failed") };

    const toStage: string[] = [];
    const skipped: string[] = [];
    let newBytes = 0;
    for (const rel of others.stdout.split("\0")) {
      if (!rel || rel.endsWith("/")) continue;
      const place = locate(repo, rel);
      if (!place || place.parents !== "ok") continue;
      const stat = lstat(place.full);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        toStage.push(rel);
      } else if (stat.isFile()) {
        if (stat.size > limits.maxNewFileBytes) {
          skipped.push(rel);
        } else {
          toStage.push(rel);
          newBytes += stat.size;
        }
      }
    }
    if (toStage.length + skipped.length > limits.maxNewFiles) {
      return { ok: false, error: `there are ${toStage.length + skipped.length} new files, more than ${limits.maxNewFiles}` };
    }
    for (const rel of dirty.stdout.split("\0")) {
      const place = rel ? locate(repo, rel) : null;
      const stat = place?.parents === "ok" ? lstat(place.full) : null;
      if (stat?.isFile()) newBytes += stat.size;
    }
    if (newBytes > limits.maxNewBytes) {
      return { ok: false, error: `there are ${Math.ceil(newBytes / 1024 / 1024)} MB of new or changed files, more than ${Math.round(limits.maxNewBytes / 1024 / 1024)} MB` };
    }

    if (seeded) {
      const updated = await git([...raw, "add", "-u"], repo, { env });
      if (updated.code !== 0) return { ok: false, error: gitErrorDetail(updated, "git add -u failed") };
    }
    if (toStage.length > 0) {
      const staged = await git([...raw, "--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], repo, {
        env,
        input: `${toStage.join("\0")}\0`,
      });
      if (staged.code !== 0) return { ok: false, error: gitErrorDetail(staged, "git add failed") };
    }

    // Raw here too: writing the index can compare a racily clean file's content, which reads attributes.
    const treeRes = await git([...raw, "write-tree"], repo, { env });
    const tree = treeRes.stdout.trim();
    if (treeRes.code !== 0 || !isCommitId(tree)) return { ok: false, error: gitErrorDetail(treeRes, "git write-tree failed") };

    // An unborn HEAD (no commits yet) fails here, which is fine: there is nothing to reuse.
    const headRes = await git(["rev-parse", "HEAD", "HEAD^{tree}"], repo);
    const [headLine = "", headTreeLine = ""] = headRes.code === 0 ? headRes.stdout.trim().split("\n") : [];
    const headCommit = isCommitId(headLine) ? headLine : null;
    const headTree = headCommit && isCommitId(headTreeLine) ? headTreeLine : null;

    return { ok: true, data: { repo, tree, skipped: skipped.sort(), headCommit, headTree } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function resolveSnapshotCommit(
  repo: string,
  tree: string,
  candidates: Array<{ commit: string | null | undefined; tree: string | null | undefined }>,
  git: TimedGit,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  // Reusing HEAD (or startCommit) avoids cluttering `git log --all` with identical snapshot commits.
  for (const item of candidates) {
    if (item.commit && item.tree === tree && isCommitId(item.commit)) return { ok: true, commit: item.commit };
  }
  const commitRes = await git(["commit-tree", "--no-gpg-sign", "-m", "VibeForge run snapshot", tree], repo, { env: SNAPSHOT_AUTHOR });
  const sha = commitRes.stdout.trim();
  if (commitRes.code !== 0 || !isCommitId(sha)) return { ok: false, error: gitErrorDetail(commitRes, "git commit-tree failed") };
  return { ok: true, commit: sha };
}

async function writeSnapshotRef(repo: string, ref: string, commit: string, git: TimedGit): Promise<string | null> {
  const res = await git(["-c", "core.logAllRefUpdates=false", "update-ref", "--no-deref", ref, commit], repo);
  return res.code === 0 ? null : gitErrorDetail(res, "git update-ref failed");
}

/**
 * Snapshot the working tree before a real-folder run starts, without touching the folder, real
 * index, or HEAD, within `budgetMs` (1.5 s) in all. Never throws: when it can't, or the folder has
 * too much new in it, it says why through `onWarn` and the run carries on without undo.
 */
export async function takeStartSnapshot(ctx: SnapshotContext): Promise<RunSnapshotsRecord | null> {
  if (!isSafeId(ctx.runId) || !ctx.runDir || !isDirectory(ctx.runDir)) return null;
  const warn = (detail: string) => ctx.onWarn?.(`Could not save start snapshot for run ${ctx.runId}, so it has no undo: ${detail}`);
  const git = withinDeadline(Date.now() + (ctx.budgetMs ?? START_SNAPSHOT_BUDGET_MS));
  try {
    const capture = await captureWorkingTree(ctx.cwd, limitsOf(ctx), git);
    if (!capture.ok) {
      warn(capture.error);
      return null;
    }
    if (!capture.data) return null;
    const nonce = `${ownerOf(ctx.dataRoot)}${randomBytes(4).toString("hex")}`;
    const ref = snapshotRef(ctx.runId, "start", nonce);
    if (!ref) return null;
    const resolved = await resolveSnapshotCommit(capture.data.repo, capture.data.tree, [{ commit: capture.data.headCommit, tree: capture.data.headTree }], git);
    if (!resolved.ok) {
      warn(resolved.error);
      return null;
    }
    const refErr = await writeSnapshotRef(capture.data.repo, ref, resolved.commit, git);
    if (refErr) {
      warn(refErr);
      return null;
    }
    noteRepo(ctx.dataRoot, capture.data.repo);
    const record: RunSnapshotsRecord = {
      repo: capture.data.repo,
      nonce,
      startCommit: resolved.commit,
      startTree: capture.data.tree,
      startSkipped: capture.data.skipped,
    };
    writeJson(path.join(ctx.runDir, RUN_FILES.snapshots), record);
    return record;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Snapshot the working tree right after a real-folder run ends, reusing `start` when recorded.
 * `late` marks one taken on the next start, for a run a close cut off. The first end snapshot
 * stays. Never throws: on error, logs via `onWarn` and leaves the run without end snapshot.
 */
export async function takeEndSnapshot(ctx: SnapshotContext & { late?: boolean }): Promise<RunSnapshotsRecord | null> {
  if (!ctx.runDir || !isDirectory(ctx.runDir)) return null;
  const existing = readSnapshotsRecord(ctx.runDir);
  if (!existing) return null;
  if (existing.endTree) return existing;
  const refs = refsOf(ctx.runId, existing);
  if (!refs) return null;
  const warn = (detail: string) => ctx.onWarn?.(`Could not save end snapshot for run ${ctx.runId}, so it has no undo: ${detail}`);
  const git = withinDeadline(Date.now() + (ctx.budgetMs ?? END_SNAPSHOT_BUDGET_MS));
  try {
    const startAlive = await git(["rev-parse", "--verify", "-q", `${refs.start}^{tree}`], existing.repo);
    if (startAlive.code !== 0) return null;
    const capture = await captureWorkingTree(ctx.cwd, limitsOf(ctx), git);
    if (!capture.ok) {
      warn(capture.error);
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
      git,
    );
    if (!resolved.ok) {
      warn(resolved.error);
      return null;
    }
    const refErr = await writeSnapshotRef(capture.data.repo, refs.end, resolved.commit, git);
    if (refErr) {
      warn(refErr);
      return null;
    }
    const updated: RunSnapshotsRecord = {
      ...existing,
      endCommit: resolved.commit,
      endTree: capture.data.tree,
      endSkipped: capture.data.skipped,
      ...(ctx.late ? { endLate: true } : {}),
    };
    writeJson(path.join(ctx.runDir, RUN_FILES.snapshots), updated);
    return updated;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** True when the run saved a start snapshot but no end one (a close cut it off first), and none was tried late yet. */
export function needsLateEndSnapshot(run: Pick<RunMeta, "dir">): boolean {
  const record = readSnapshotsRecord(run.dir);
  return Boolean(record && !record.endTree && !record.endLate);
}

/** A late end snapshot was tried and couldn't be saved: the run stays without undo, and it isn't tried again. */
export function markLateEndTried(run: Pick<RunMeta, "dir">): void {
  const record = readSnapshotsRecord(run.dir);
  if (!record || record.endTree) return;
  try {
    writeJson(path.join(run.dir, RUN_FILES.snapshots), { ...record, endLate: true });
  } catch {
    /* tried again at the next start */
  }
}

async function deleteRefs(repo: string, refs: readonly string[]): Promise<boolean> {
  if (!refs.length) return true;
  const input = refs.map((ref) => `delete ${ref}\n`).join("");
  const res = await snapGit(["-c", "core.logAllRefUpdates=false", "update-ref", "--no-deref", "--stdin"], repo, { input, timeoutMs: 10_000 });
  return res.code === 0;
}

/** Remove the run's snapshot refs from its repository when a run is deleted/tidied. */
export async function removeRunSnapshots(run: Pick<RunMeta, "id" | "cwd" | "dir">): Promise<void> {
  const record = readSnapshotsRecord(run.dir);
  const refs = record ? refsOf(run.id, record) : { start: snapshotRef(run.id, "start"), end: snapshotRef(run.id, "end") };
  if (!refs?.start || !refs.end) return;
  const candidate = record?.repo || run.cwd;
  if (!candidate || !isDirectory(candidate) || !hasGitMarker(candidate)) return;
  try {
    const repo = record?.repo ? path.resolve(record.repo) : await repoRoot(candidate);
    if (!repo || !isDirectory(repo)) return;
    const doomed = [refs.start, refs.end];
    await withRepoLock(repo, async () => {
      // One at a time: deleting a ref that was never written fails a batch.
      for (const ref of doomed) await deleteRefs(repo, [ref]).catch(() => false);
    });
  } catch {
    /* ref cleanup is best-effort when tidying or deleting runs */
  }
}

function stampOf(runId: string): number | null {
  const match = RUN_STAMP.exec(runId);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isFinite(at) ? at : null;
}

/**
 * Tidy snapshot refs in every repository VibeForge wrote some into: ones whose run no longer exists
 * here, and ones older than `keepDays` (30). Refs another machine made (Sync shares `.git`) go only
 * once they are that old. Returns how many refs went.
 */
export async function sweepRunSnapshots(options: {
  dataRoot: string;
  getRun: (id: string) => RunMeta | null;
  now: Date;
  keepDays?: number;
}): Promise<number> {
  const { dataRoot, getRun } = options;
  if (!isDirectory(dataRoot)) return 0;
  const index = readIndex(dataRoot);
  if (!index.repos.length) return 0;
  const cutoff = options.now.getTime() - (options.keepDays ?? SNAPSHOT_KEEP_DAYS) * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  let removed = 0;
  for (const repo of index.repos) {
    if (!isDirectory(repo) || !hasGitMarker(repo)) continue;
    try {
      const left = await withRepoLock(repo, async () => {
        const listed = await snapGit(["for-each-ref", "--format=%(refname)", "refs/vibeforge/runs/"], repo, { timeoutMs: 10_000 });
        if (listed.code !== 0) return 1;
        const refs = listed.stdout.split("\n").filter(Boolean);
        const doomed: string[] = [];
        for (const ref of refs) {
          const parts = ref.split("/");
          // refs/vibeforge/runs/<run>/<nonce>/<point>, or the older refs/vibeforge/runs/<run>/<point>.
          if (parts.length !== 5 && parts.length !== 6) continue;
          const runId = parts[3];
          const nonce = parts.length === 6 ? parts[4] : null;
          const run = getRun(runId);
          if (run?.status === "running") continue;
          const startedAt = run ? Date.parse(run.startedAt) : stampOf(runId);
          const old = startedAt !== null && Number.isFinite(startedAt) && startedAt < cutoff;
          const ours = nonce === null || nonce.startsWith(index.owner);
          if (old) {
            doomed.push(ref);
          } else if (ours) {
            const record = run ? readSnapshotsRecord(run.dir) : null;
            // Gone: no run, and no run folder either (a run being set up has its folder first).
            if (!run && !fs.existsSync(path.join(dataRoot, "runs", runId))) doomed.push(ref);
            // A ref of this run's that its record doesn't name: left from a start that failed halfway.
            else if (record && record.nonce !== (nonce ?? undefined)) doomed.push(ref);
          }
        }
        for (let at = 0; at < doomed.length; at += 200) {
          const batch = doomed.slice(at, at + 200);
          if (await deleteRefs(repo, batch)) removed += batch.length;
          else for (const ref of batch) if (await deleteRefs(repo, [ref])) removed += 1;
        }
        return refs.length - doomed.length;
      });
      if (left > 0) kept.push(repo);
    } catch {
      kept.push(repo);
    }
  }
  const latest = readIndex(dataRoot);
  // A repository noted while this pass ran stays listed.
  writeIndex(dataRoot, { owner: latest.owner || index.owner, repos: latest.repos.filter((repo) => kept.includes(repo) || !index.repos.includes(repo)) });
  return removed;
}

// ---------------------------------------------------------------- availability

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
  const endSkipped = new Set(record.endSkipped ?? []);
  const oversizedChange = [...endSkipped].some((file) => !startSkipped.has(file)) || [...startSkipped].some((file) => !endSkipped.has(file));
  if (record.startTree === record.endTree && !oversizedChange) return "no-changes";
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
  const refs = record ? refsOf(run.id, record) : null;
  if (!record || !refs) return "missing";
  const repo = await repoRoot(run.cwd).catch(() => null);
  if (!repo || path.resolve(repo) !== path.resolve(record.repo)) return "missing";
  const [startOk, endOk] = await Promise.all([
    snapGit(["rev-parse", "--verify", "-q", `${refs.start}^{tree}`], repo, { timeoutMs: 3000 }),
    snapGit(["rev-parse", "--verify", "-q", `${refs.end}^{tree}`], repo, { timeoutMs: 3000 }),
  ]);
  if (startOk.code !== 0 || endOk.code !== 0) return "missing";
  return "ready";
}

// ---------------------------------------------------------------- restoring

interface ValidatedSnapshots {
  repo: string;
  format: string;
  startTree: string;
  endTree: string;
  record: RunSnapshotsRecord;
  /** The run's folder inside the repository, "" for its top: only files under it are put back. */
  scope: string;
  overlapping: Array<{ id: string; title: string }>;
}

function timeOf(value: string | null | undefined, fallback: number): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : fallback;
}

/** Other runs in the same repository: the ones going now, and the ones that were going while `run` was. */
async function neighbours(run: RunMeta, repo: string, others: readonly NeighbourRun[], dataRoot: string): Promise<{ live: NeighbourRun[]; overlapping: NeighbourRun[] }> {
  const now = Date.now();
  const from = timeOf(run.startedAt, 0);
  const to = timeOf(run.endedAt, now);
  const live: NeighbourRun[] = [];
  const overlapping: NeighbourRun[] = [];
  const repoOf = new Map<string, string | null>();
  for (const other of others) {
    if (other.id === run.id || !other.cwd || isRunInCopy(other.cwd, dataRoot)) continue;
    const going = other.status === "running";
    const overlapped = timeOf(other.startedAt, Number.POSITIVE_INFINITY) < to && timeOf(other.endedAt, now) > from;
    if (!going && !overlapped) continue;
    let theirs = readSnapshotsRecord(other.dir)?.repo ?? null;
    if (!theirs) {
      if (!repoOf.has(other.cwd)) {
        repoOf.set(other.cwd, isDirectory(other.cwd) && hasGitMarker(other.cwd) ? await repoRoot(other.cwd).catch(() => null) : null);
      }
      theirs = repoOf.get(other.cwd) ?? null;
    }
    if (!theirs || path.resolve(theirs) !== path.resolve(repo)) continue;
    if (going) live.push(other);
    if (overlapped) overlapping.push(other);
  }
  return { live, overlapping };
}

async function validateRestoreContext(run: RunMeta | null, dataRoot: string, others: readonly NeighbourRun[]): Promise<ValidatedSnapshots> {
  if (!run) throw new Error("That run no longer exists.");
  if (isRunInCopy(run.cwd, dataRoot)) throw new Error("This run worked in a separate copy; use Discard on the copy instead.");
  if (run.status === "running") throw new Error("Wait until this run finishes before putting files back.");
  if (!run.cwd || !isDirectory(run.cwd)) throw new Error("That folder does not exist any more.");
  const repo = await repoRoot(run.cwd);
  if (!repo) throw new Error("This folder is not a git repository.");
  const record = readSnapshotsRecord(run.dir);
  const refs = record ? refsOf(run.id, record) : null;
  if (!record?.endCommit || !record.endTree || !refs) {
    throw new Error("No before-and-after snapshot was saved for this run.");
  }
  if (path.resolve(repo) !== path.resolve(record.repo)) {
    throw new Error("This run's snapshot points at another repository, so nothing was changed.");
  }
  let real: string;
  try {
    real = fs.realpathSync(run.cwd);
  } catch {
    throw new Error("That folder does not exist any more.");
  }
  const inside = path.relative(repo, real);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error("This run's snapshot points at another repository, so nothing was changed.");
  }
  const [startTreeRes, endTreeRes, formatRes] = await Promise.all([
    snapGit(["rev-parse", "--verify", "-q", `${refs.start}^{tree}`], repo, { timeoutMs: 5000 }),
    snapGit(["rev-parse", "--verify", "-q", `${refs.end}^{tree}`], repo, { timeoutMs: 5000 }),
    snapGit(["rev-parse", "--show-object-format"], repo, { timeoutMs: 5000 }),
  ]);
  const startTree = startTreeRes.stdout.trim();
  const endTree = endTreeRes.stdout.trim();
  const format = formatRes.stdout.trim();
  if (startTreeRes.code !== 0 || endTreeRes.code !== 0 || !isCommitId(startTree) || !isCommitId(endTree)) {
    throw new Error("No before-and-after snapshot was saved for this run.");
  }
  if (formatRes.code !== 0 || !EMPTY_TREE[format]) {
    throw new Error(`Could not read this run's snapshot: ${gitErrorDetail(formatRes, "unknown object format")}`);
  }
  const { live, overlapping } = await neighbours(run, repo, others, dataRoot);
  if (live.length) {
    throw new Error(`Another run is still going in this repository: ${live[0].title}. Put files back once it has ended.`);
  }
  return {
    repo,
    format,
    startTree,
    endTree,
    record,
    scope: inside.split(path.sep).join("/"),
    overlapping: overlapping.map((other) => ({ id: other.id, title: other.title })),
  };
}

interface TreeDiffEntry {
  path: string;
  startMode: string;
  endMode: string;
  startOid: string;
  endOid: string;
}

function inScope(scope: string, rel: string): boolean {
  return !scope || rel === scope || rel.startsWith(`${scope}/`);
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

/**
 * Paths whose saved bytes may not be what was on disk: a filter (LFS and the like), `ident` or a
 * working-tree encoding applies to them, or line-ending rules that change files on checkout. Their
 * snapshot can hold git's stored form, so they are never written back. Read from the attributes
 * `tree` held, plus this repository's and this user's own.
 */
async function filteredPaths(repo: string, tree: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!paths.length) return out;
  const [config, attrs] = await Promise.all([
    snapGit(["config", "--get-regexp", "^core\\.(autocrlf|eol)$"], repo, { timeoutMs: 5000 }),
    snapGit(["check-attr", "-z", "--stdin", `--source=${tree}`, "filter", "ident", "working-tree-encoding", "eol", "text"], repo, {
      input: `${paths.join("\0")}\0`,
    }),
  ]);
  if (attrs.code !== 0) throw new Error(`Could not read this run's snapshot: ${gitErrorDetail(attrs, "git check-attr failed")}`);
  const settings = new Map<string, string>();
  for (const line of config.stdout.split("\n")) {
    const [key, value = ""] = line.trim().split(/\s+/, 2);
    if (key) settings.set(key.toLowerCase(), value.toLowerCase());
  }
  const autocrlf = settings.get("core.autocrlf") === "true";
  const crlf = settings.get("core.eol") === "crlf";
  const fields = attrs.stdout.split("\0");
  const seen = new Map<string, Map<string, string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const map = seen.get(fields[i]) ?? new Map<string, string>();
    map.set(fields[i + 1], fields[i + 2]);
    seen.set(fields[i], map);
  }
  const given = (value: string | undefined) => value !== undefined && value !== "unspecified" && value !== "unset";
  for (const rel of paths) {
    const attr = seen.get(rel);
    if (!attr) {
      out.add(rel);
      continue;
    }
    const text = attr.get("text") ?? "unspecified";
    if (
      given(attr.get("filter")) ||
      attr.get("ident") === "set" ||
      given(attr.get("working-tree-encoding")) ||
      attr.get("eol") === "crlf" ||
      (text !== "unset" && autocrlf) ||
      (crlf && (text === "set" || text === "auto"))
    ) {
      out.add(rel);
    }
  }
  return out;
}

/** True when `dirPath` holds nothing but folders and the files/links in `willDelete`. */
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

interface PlanItem extends RestoreItem {
  mode: string;
  oid: string;
}

interface ComputedRestorePlan {
  restorable: PlanItem[];
  leftAlone: Array<{ path: string; reason: LeftAloneReason }>;
}

async function computeRestorePlan(validated: ValidatedSnapshots): Promise<ComputedRestorePlan> {
  const { repo, format, startTree, endTree, record, scope } = validated;
  const entries = (await diffTrees(repo, startTree, endTree)).filter((entry) => inScope(scope, entry.path));
  const startSkipped = new Set(record.startSkipped.filter((rel) => inScope(scope, rel)));
  const endSkipped = new Set((record.endSkipped ?? []).filter((rel) => inScope(scope, rel)));

  const restorable: PlanItem[] = [];
  const leftAlone: ComputedRestorePlan["leftAlone"] = [];
  const leftPaths = new Set<string>();
  const addLeft = (rel: string, reason: LeftAloneReason) => {
    if (leftPaths.has(rel)) return;
    leftPaths.add(rel);
    leftAlone.push({ path: rel, reason });
  };

  const candidates: TreeDiffEntry[] = [];
  for (const entry of entries) {
    if (startSkipped.has(entry.path) || endSkipped.has(entry.path)) {
      addLeft(entry.path, "oversized");
    } else if (entry.startMode === "160000" || entry.endMode === "160000") {
      addLeft(entry.path, "submodule");
    } else {
      candidates.push(entry);
    }
  }
  const inDiff = new Set(entries.map((entry) => entry.path));
  // An oversized new file the run made leaves both trees alone; list it if it still sits on disk.
  for (const rel of endSkipped) {
    if (!startSkipped.has(rel) && !leftPaths.has(rel) && (await diskState(repo, format, rel)) !== "absent") addLeft(rel, "oversized");
  }
  // An oversized file that was there before and that the run removed: it was never saved, so it can't come back.
  for (const rel of startSkipped) {
    if (!endSkipped.has(rel) && !inDiff.has(rel) && !leftPaths.has(rel) && (await diskState(repo, format, rel)) === "absent") addLeft(rel, "oversized");
  }

  const filtered = await filteredPaths(
    repo,
    startTree,
    candidates.filter((entry) => !ZERO_OID.test(entry.startOid)).map((entry) => entry.path),
  );

  const now = new Map<string, string>();
  for (const entry of candidates) now.set(entry.path, await diskState(repo, format, entry.path));

  // Files the run made that are still as it left them go first, which can clear the way for others.
  const willDelete = new Set<string>();
  for (const entry of candidates) {
    if (ZERO_OID.test(entry.startOid) && !ZERO_OID.test(entry.endOid) && now.get(entry.path) === treeState(entry.endMode, entry.endOid)) {
      willDelete.add(entry.path);
    }
  }

  for (const entry of candidates) {
    const start = treeState(entry.startMode, entry.startOid);
    const end = treeState(entry.endMode, entry.endOid);
    const current = now.get(entry.path) ?? "blocked";
    const put = { mode: entry.startMode, oid: entry.startOid, expect: current };

    if (start === "absent") {
      if (willDelete.has(entry.path)) restorable.push({ path: entry.path, action: "delete", ...put, mode: entry.endMode, oid: entry.endOid });
      else if (current !== "absent") addLeft(entry.path, "changed");
      continue;
    }
    if (current === start) continue; // already as before this run
    if (end !== "absent") {
      if (current !== end) addLeft(entry.path, "changed");
      else if (filtered.has(entry.path)) addLeft(entry.path, "filtered");
      else restorable.push({ path: entry.path, action: "restore", ...put });
      continue;
    }
    // The run removed it: it comes back where nothing (or only what the run made) is in the way.
    const target = await diskState(repo, format, entry.path, willDelete);
    const place = locate(repo, entry.path);
    const clear = target === "absent" || (target === "dir" && place !== null && dirClearedByDeletes(repo, place.full, willDelete));
    if (!clear) addLeft(entry.path, "changed");
    else if (filtered.has(entry.path)) addLeft(entry.path, "filtered");
    else restorable.push({ path: entry.path, action: "recreate", ...put });
  }

  return { restorable, leftAlone };
}

/** Preview which files a run restore will put back or leave alone. Read-only. */
export async function previewRunRestore(run: RunMeta | null, dataRoot: string, others: readonly NeighbourRun[] = []): Promise<RunRestorePreview> {
  const validated = await validateRestoreContext(run, dataRoot, others);
  const plan = await computeRestorePlan(validated);
  return {
    restorable: plan.restorable.map(({ path: file, action, expect }) => ({ path: file, action, expect })),
    leftAlone: plan.leftAlone,
    overlapping: validated.overlapping,
    lateEnd: validated.record.endLate === true,
  };
}

/** Remove a folder that holds nothing but empty folders, so a file can take its place. */
function removeEmptyTree(dir: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !removeEmptyTree(path.join(dir, entry.name))) return false;
    }
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Remove one file or link. Folders, empty or not, are never removed. */
function removeEntry(repo: string, rel: string): boolean {
  const place = locate(repo, rel);
  if (!place || place.parents !== "ok") return false;
  try {
    const stat = lstat(place.full);
    if (!stat || stat.isDirectory()) return false;
    fs.rmSync(place.full, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a snapshot's blob to `rel` as raw bytes. A folder standing there is removed only when it
 * holds nothing but empty folders: the snapshot says a file belongs there, so the folder wasn't.
 */
async function writeTreeBlob(repo: string, rel: string, mode: string, oid: string): Promise<boolean> {
  const place = locate(repo, rel);
  if (!place || place.parents === "blocked") return false;
  const target = place.full;
  const link = mode === "120000";
  const read = await snapGitBytes(["cat-file", "blob", oid], repo);
  if (read.code !== 0) return false;
  try {
    let stat = lstat(target);
    if (stat?.isDirectory()) {
      if (!removeEmptyTree(target)) return false;
      stat = null;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat?.isSymbolicLink() || (stat && link)) fs.rmSync(target, { force: true });
    if (link) {
      fs.symlinkSync(read.stdout, target);
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

/**
 * Put files back as they were before `run`, only under the run's own folder, and only the files
 * the person confirmed in the preview (`picks`) that are still exactly as the preview found them.
 * Anything else, changed since the preview or never shown, is left alone and listed. Returns what
 * changed along with `undoData` so Undo can put the end state back for those exact files.
 */
export async function restoreRunFiles(
  run: RunMeta | null,
  dataRoot: string,
  picks: readonly RestorePick[],
  others: readonly NeighbourRun[] = [],
): Promise<{ result: Omit<RunRestoreResult, "undo">; undoData: RestoreUndoData | null }> {
  const validated = await validateRestoreContext(run, dataRoot, others);
  const { repo } = validated;
  return withRepoLock(repo, async () => {
    const plan = await computeRestorePlan(validated);
    const confirmed = new Map(picks.map((pick) => [pick.path, pick.expect]));
    const restored: string[] = [];
    const deleted: string[] = [];
    const leftAlone = [...plan.leftAlone];
    const go: PlanItem[] = [];
    for (const item of plan.restorable) {
      if (confirmed.get(item.path) === item.expect) go.push(item);
      else leftAlone.push({ path: item.path, reason: "changed" });
    }

    for (const item of go.filter((entry) => entry.action === "delete")) {
      if (removeEntry(repo, item.path)) {
        restored.push(item.path);
        deleted.push(item.path);
      } else {
        leftAlone.push({ path: item.path, reason: "changed" });
      }
    }
    for (const item of go.filter((entry) => entry.action !== "delete")) {
      if (await writeTreeBlob(repo, item.path, item.mode, item.oid)) restored.push(item.path);
      else leftAlone.push({ path: item.path, reason: "changed" });
    }

    const undoData: RestoreUndoData | null =
      restored.length > 0 ? { repo, format: validated.format, startTree: validated.startTree, endTree: validated.endTree, files: restored } : null;
    return { result: { restored, deleted, leftAlone }, undoData };
  });
}

/**
 * Put the run's end state back for **only** the files previously restored by `restoreRunFiles`,
 * skipping any file whose working-tree state changed again after the restore, and saying which.
 */
export async function applyUndoRestore(data: RestoreUndoData): Promise<RunRestoreUndoResult> {
  if (!data.files.length) return { reverted: [], leftAlone: [] };
  if (!isDirectory(data.repo)) return { reverted: [], leftAlone: [...data.files] };
  return withRepoLock(data.repo, async () => {
    const wanted = new Set(data.files);
    const relevant = (await diffTrees(data.repo, data.startTree, data.endTree)).filter((entry) => wanted.has(entry.path));
    const now = new Map<string, string>();
    for (const entry of relevant) now.set(entry.path, await diskState(data.repo, data.format, entry.path));

    // Files the restore brought back that are still as it left them go first: that can clear the way for the rest.
    const deletes: TreeDiffEntry[] = [];
    const willDelete = new Set<string>();
    for (const entry of relevant) {
      if (ZERO_OID.test(entry.startOid) || !ZERO_OID.test(entry.endOid)) continue;
      if (now.get(entry.path) === treeState(entry.startMode, entry.startOid)) {
        deletes.push(entry);
        willDelete.add(entry.path);
      }
    }
    const writes: TreeDiffEntry[] = [];
    for (const entry of relevant) {
      if (ZERO_OID.test(entry.endOid)) continue;
      if (ZERO_OID.test(entry.startOid)) {
        const target = await diskState(data.repo, data.format, entry.path, willDelete);
        const place = locate(data.repo, entry.path);
        if (target === "absent" || (target === "dir" && place && dirClearedByDeletes(data.repo, place.full, willDelete))) writes.push(entry);
      } else if (now.get(entry.path) === treeState(entry.startMode, entry.startOid)) {
        writes.push(entry);
      }
    }

    const reverted: string[] = [];
    for (const entry of deletes) if (removeEntry(data.repo, entry.path)) reverted.push(entry.path);
    for (const entry of writes) if (await writeTreeBlob(data.repo, entry.path, entry.endMode, entry.endOid)) reverted.push(entry.path);
    const done = new Set(reverted);
    return { reverted, leftAlone: data.files.filter((file) => !done.has(file)) };
  });
}
