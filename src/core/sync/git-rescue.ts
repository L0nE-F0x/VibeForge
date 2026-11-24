import fs from "node:fs";
import path from "node:path";
import { runGit } from "../git.js";
import { withRepoLock } from "../worktrees.js";
import { conflictName } from "./protocol.js";

// A synced workspace's `.git` travels with it, so the branch, the commits and the stash arrive on
// the other machine. That is safe while one machine works at a time. When both committed while
// apart, Syncthing keeps the later machine's branch pointer and leaves this machine's as a
// conflict copy inside `.git` (both machines' commits themselves always arrive: git stores them
// under names made from their content). This file turns that into something ordinary: this
// machine's commits get a branch of their own, `<branch>-from-<machine>`, to merge like any
// other, and the copies are removed. Nothing here ever deletes a commit or a version of a file
// that isn't also kept in a commit.

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: readonly string[], cwd: string, input?: string): Promise<GitRun> {
  // No hooks, fsmonitor, or pathspec globbing: this runs on repo data from another machine.
  return runGit(["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "color.ui=never", ...args], {
    cwd,
    input,
    timeoutMs: 60_000,
  });
}

/** "repo": the folder holds its own `.git`. "checkout": `.git` is a file pointing at a repository elsewhere (a branch opened beside it). */
export type RepoKind = "repo" | "checkout" | "none";

export function repoKind(root: string): RepoKind {
  try {
    const stat = fs.lstatSync(path.join(root, ".git"));
    return stat.isDirectory() ? "repo" : stat.isFile() ? "checkout" : "none";
  } catch {
    return "none";
  }
}

const EXCLUDES = [".stfolder/", ".stignore"];

/**
 * Makes a repository ready to be the same on two machines. Git remembers each file's inode and
 * change time, which differ per machine, so every `git status` would rewrite `.git/index` and the
 * two machines would send it back and forth for ever; told to compare only size and time, it
 * leaves the index alone. Syncthing's own two files are kept out of `git status`.
 */
export async function prepareRepo(root: string): Promise<void> {
  if (repoKind(root) !== "repo") return;
  for (const [key, value] of [
    ["core.trustctime", "false"],
    ["core.checkStat", "minimal"],
  ] as const) {
    const now = await git(["config", "--local", "--get", key], root);
    if (now.stdout.trim() !== value) await git(["config", "--local", key, value], root);
  }
  const file = path.join(root, ".git", "info", "exclude");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    /* none yet */
  }
  const missing = EXCLUDES.filter((line) => !text.split("\n").includes(line));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

export interface Rescue {
  /** Branches where both machines committed: this machine's commits are now on `saved`. */
  branches: Array<{ branch: string; saved: string }>;
  /** Files put back to the branch's own version, because the version they held is kept in a commit. */
  settled: string[];
  /** The staging area was rebuilt from the branch (both machines had changed it). */
  indexReset: boolean;
  /** Conflict copies removed from `.git`. */
  removed: number;
}

interface GitCopy {
  file: string;
  /** Path inside `.git` of the file it is a copy of, with "/". */
  of: string;
}

/** Syncthing's conflict copies inside `.git`: at its top, and under refs/ and logs/. */
function gitCopies(gitDir: string): GitCopy[] {
  const found: GitCopy[] = [];
  const visit = (dir: string, deep: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (deep) visit(full, true);
        continue;
      }
      const parsed = conflictName(entry.name);
      if (parsed) found.push({ file: full, of: path.relative(gitDir, path.join(dir, parsed.original)).split(path.sep).join("/") });
    }
  };
  visit(gitDir, false);
  visit(path.join(gitDir, "refs"), true);
  visit(path.join(gitDir, "logs"), true);
  return found;
}

const SHA = /^[0-9a-f]{40,64}$/;

/** The commit a reflog's last line moved to. */
function lastLogged(file: string): string | null {
  try {
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    const fields = (lines.at(-1) ?? "").split(" ");
    return SHA.test(fields[1] ?? "") ? fields[1] : null;
  } catch {
    return null;
  }
}

async function isCommit(root: string, sha: string): Promise<boolean> {
  return SHA.test(sha) && (await git(["cat-file", "-t", sha], root)).stdout.trim() === "commit";
}

async function reflogTargets(file: string): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const sha = line.split(" ")[1] ?? "";
      if (SHA.test(sha)) seen.add(sha);
    }
  } catch {
    /* missing reflog */
  }
  return seen;
}

/**
 * Re-stores lost stash entries from a conflicting `logs/refs/stash` copy before removing it.
 * Returns false if a referenced commit isn't local yet so the copy stays for a later retry.
 */
async function rescueStashLog(root: string, gitDir: string, file: string, machine: string): Promise<boolean> {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return true;
  }
  const existing = await reflogTargets(path.join(gitDir, "logs", "refs", "stash"));
  const top = await resolveRef(root, "refs/stash");
  if (top) existing.add(top);
  for (const line of text.split("\n")) {
    const match = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) [^\t]*(?:\t(.*))?$/.exec(line);
    if (!match) continue;
    const sha = match[1];
    if (existing.has(sha)) continue;
    if (!(await isCommit(root, sha))) return false;
    const message = match[2]?.trim() || `stash from ${machine || "other machine"}`;
    if ((await git(["stash", "store", "-m", message, sha], root)).code !== 0) return false;
    existing.add(sha);
  }
  return true;
}

async function resolveRef(root: string, ref: string): Promise<string | null> {
  const run = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  return run.code === 0 ? run.stdout.trim() : null;
}

type RefState = { kind: "missing" } | { kind: "commit"; sha: string } | { kind: "unready" };

/** Distinguishes a ref whose object has not synced yet from one genuinely absent. */
async function refState(root: string, ref: string): Promise<RefState> {
  const commit = await resolveRef(root, ref);
  if (commit) return { kind: "commit", sha: commit };
  const raw = await git(["rev-parse", "--verify", "--quiet", ref], root);
  if (raw.code === 0 || (ref.startsWith("refs/") && fs.existsSync(path.join(root, ".git", ref)))) {
    return { kind: "unready" };
  }
  return { kind: "missing" };
}

async function isAncestor(root: string, older: string, newer: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", older, newer], root)).code === 0;
}

/** A branch name that is free, or already points at `sha`. */
async function freeBranch(root: string, wanted: string, sha: string): Promise<string | null> {
  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    if ((await git(["check-ref-format", "--branch", name], root)).code !== 0) return null;
    const state = await refState(root, `refs/heads/${name}`);
    if (state.kind === "missing" || (state.kind === "commit" && state.sha === sha)) return name;
  }
  return null;
}

/** What a ref is called when it is kept as a branch: `main`, `feature/x`, `stash`, `tag-v1`. */
function branchBase(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return `tag-${ref.slice("refs/tags/".length)}`;
  return ref.replace(/^refs\//, "").replace(/\//g, "-");
}

/**
 * Sorts out a repository after both machines changed it while apart. Null when there is nothing
 * to sort out. `machine` names this machine in the branch its commits are kept on.
 */
export function rescueRepo(root: string, machine: string): Promise<Rescue | null> {
  return withRepoLock(root, () => rescue(root, machine));
}

async function rescue(root: string, machine: string): Promise<Rescue | null> {
  if (repoKind(root) !== "repo") return null;
  const gitDir = path.join(root, ".git");
  const copies = gitCopies(gitDir);
  if (!copies.length) return null;
  const result: Rescue = { branches: [], settled: [], indexReset: false, removed: 0 };
  /** Commits whose files may be lying in the working folder as leftovers. */
  const candidates = new Set<string>();

  // This machine's last HEAD is the last line of its reflog, which lost to the other machine's.
  for (const copy of copies.filter((item) => item.of === "logs/HEAD")) {
    const sha = lastLogged(copy.file);
    if (sha && (await isCommit(root, sha))) candidates.add(sha);
  }
  const theirs = lastLogged(path.join(gitDir, "logs", "HEAD"));
  if (theirs && (await isCommit(root, theirs))) candidates.add(theirs);

  /** Keeps `sha` reachable as `ref` or a branch beside it. False when it could not: then the copy holding it stays. */
  const keep = async (ref: string, sha: string): Promise<boolean> => {
    // Not a commit this repository has: nothing to keep.
    if (!(await isCommit(root, sha))) return true;
    const state = await refState(root, ref);
    // The ref file already points at an object still transferring: leave it and keep the copy for retry.
    if (state.kind === "unready") return false;
    if (state.kind === "missing") {
      // The branch exists only here: put it back under its own name.
      if ((await git(["update-ref", ref, sha], root)).code !== 0) return false;
      candidates.add(sha);
      return true;
    }
    const current = state.sha;
    if (current === sha || (await isAncestor(root, sha, current))) return true;
    // A machine name that makes no branch name still gets its commits kept.
    const saved = (await freeBranch(root, `${branchBase(ref)}-from-${machine}`, sha)) ?? (await freeBranch(root, `${branchBase(ref)}-from-other-machine`, sha));
    if (!saved || (await git(["update-ref", `refs/heads/${saved}`, sha], root)).code !== 0) return false;
    candidates.add(sha);
    if (ref.startsWith("refs/heads/")) result.branches.push({ branch: branchBase(ref), saved });
    return true;
  };

  const keepDetached = async (sha: string): Promise<boolean> => {
    if (!SHA.test(sha) || !(await isCommit(root, sha))) return true;
    const held = await git(["for-each-ref", "--count=1", "--contains", sha, "--format=%(refname)"], root);
    if (held.code !== 0) return false;
    if (held.stdout.trim()) return true;
    return keep("refs/heads/detached-head", sha);
  };

  /** Copies that still hold the only pointer to a commit. */
  const stay = new Set<string>();
  for (const copy of copies) {
    if (copy.of.startsWith("refs/")) {
      let sha = "";
      try {
        sha = fs.readFileSync(copy.file, "utf8").trim();
      } catch {
        /* unreadable: nothing to keep */
      }
      if (!(await keep(copy.of, sha))) stay.add(copy.file);
    } else if (copy.of === "HEAD") {
      let raw = "";
      try {
        raw = fs.readFileSync(copy.file, "utf8").trim();
      } catch {
        /* unreadable: nothing to keep */
      }
      if (SHA.test(raw) && !(await keepDetached(raw))) stay.add(copy.file);
    } else if (copy.of === "logs/HEAD") {
      const sha = lastLogged(copy.file);
      if (sha && !(await keepDetached(sha))) stay.add(copy.file);
    } else if (copy.of === "packed-refs") {
      let text = "";
      try {
        text = fs.readFileSync(copy.file, "utf8");
      } catch {
        /* unreadable */
      }
      for (const line of text.split("\n")) {
        const found = /^([0-9a-f]{40,64}) (refs\/\S+)$/.exec(line);
        if (found && !(await keep(found[2], found[1]))) stay.add(copy.file);
      }
    } else if (copy.of === "logs/refs/stash") {
      if (!(await rescueStashLog(root, gitDir, copy.file, machine))) stay.add(copy.file);
    }
  }

  // Every commit kept is safe on a branch now; those copies have nothing more to say.
  const hadIndexCopy = copies.some((copy) => copy.of === "index");
  for (const copy of copies) {
    if (stay.has(copy.file)) continue;
    try {
      fs.rmSync(copy.file, { force: true });
      result.removed += 1;
    } catch {
      /* left for the next look */
    }
  }

  // In the middle of a merge or a rebase the working folder is git's; leave it be.
  const busy = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((name) => fs.existsSync(path.join(gitDir, name)));
  const head = await resolveRef(root, "HEAD");
  if (busy || !head) return result;

  if (hadIndexCopy) {
    // Both machines staged things; the index that won doesn't describe this branch for certain.
    // Rebuilt from the branch, with every file left as it is: what was staged shows as changed.
    result.indexReset = (await git(["reset", "--quiet"], root)).code === 0;
  }
  for (const sha of candidates) {
    if (sha === head) continue;
    result.settled.push(...(await settle(root, sha)));
  }
  result.settled = [...new Set(result.settled)].sort();
  return result;
}

/** path → blob id, for the paths named, in one tree. */
async function blobsAt(root: string, treeish: string, paths: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let at = 0; at < paths.length; at += 400) {
    const run = await git(["ls-tree", "-r", "-z", treeish, "--", ...paths.slice(at, at + 400)], root);
    for (const row of run.stdout.split("\0")) {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
      // Links are left alone: only plain files are compared.
      if (match && match[1] !== "120000") found.set(match[3], match[2]);
    }
  }
  return found;
}

/**
 * After both machines changed a repository, the working folder holds the newest version of each
 * file from either machine. Files that are byte for byte what `commit` holds, and differ from the
 * branch, are only that commit's files lying around: they go back to the branch's version, so the
 * folder matches the branch and merging `commit` later is clean. A file with anything else in it
 * (work that isn't committed) is never touched.
 */
async function settle(root: string, commit: string): Promise<string[]> {
  // Only when the commit is held by a branch or tag: then putting a file back loses nothing.
  const held = await git(["for-each-ref", "--count=1", "--contains", commit, "--format=%(refname)"], root);
  if (held.code !== 0 || !held.stdout.trim()) return [];
  const diff = await git(["diff", "--name-only", "-z", "--no-renames", "HEAD", commit], root);
  if (diff.code !== 0) return [];
  const paths = diff.stdout.split("\0").filter(Boolean).slice(0, 5000);
  if (!paths.length) return [];
  const [ours, theirs] = await Promise.all([blobsAt(root, "HEAD", paths), blobsAt(root, commit, paths)]);

  const present: string[] = [];
  const missing = new Set<string>();
  for (const file of paths) {
    try {
      const stat = fs.lstatSync(path.join(root, file));
      if (stat.isFile()) present.push(file);
    } catch {
      missing.add(file);
    }
  }
  const work = new Map<string, string>();
  if (present.length) {
    const hashed = await git(["hash-object", "--no-filters", "--stdin-paths"], root, `${present.join("\n")}\n`);
    const ids = hashed.stdout.trim().split("\n");
    if (hashed.code === 0 && ids.length === present.length) {
      for (const [index, file] of present.entries()) work.set(file, ids[index]);
    }
  }

  const settled: string[] = [];
  for (const file of paths) {
    const inWork = missing.has(file) ? "none" : work.get(file);
    if (!inWork) continue;
    const inTheirs = theirs.get(file) ?? "none";
    const inOurs = ours.get(file) ?? "none";
    let matchesTheirs = inWork === inTheirs && inWork !== inOurs;
    if (!matchesTheirs && inWork !== "none" && inTheirs !== "none") {
      const norm = await normalizedHash(root, path.join(root, file));
      if (norm && norm === inTheirs && norm !== inOurs) matchesTheirs = true;
    }
    if (!matchesTheirs) continue;
    if (inOurs === "none") {
      fs.rmSync(path.join(root, file), { force: true });
      settled.push(file);
    } else if ((await git(["restore", "--source=HEAD", "--worktree", "--", file], root)).code === 0) {
      settled.push(file);
    }
  }
  return settled;
}

const MAX_NORMALIZE_BYTES = 16 * 1024 * 1024;

/** LF-normalized blob SHA computed in-memory via `--no-filters` so repo clean/smudge filters never run. */
async function normalizedHash(root: string, file: string): Promise<string | null> {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_NORMALIZE_BYTES) return null;
    const raw = fs.readFileSync(file);
    if (raw.includes(0) || !raw.includes("\r\n")) return null;
    const text = raw.toString("utf8").replace(/\r\n/g, "\n");
    const hashed = await git(["hash-object", "--no-filters", "--stdin"], root, text);
    const blob = hashed.stdout.trim();
    return hashed.code === 0 && SHA.test(blob) ? blob : null;
  } catch {
    return null;
  }
}

/**
 * Whether a file's exact content is kept in some commit under the name `relative`: then a conflict
 * copy of it is only that commit's file again, and can go.
 */
export async function inHistory(root: string, file: string, relative: string): Promise<boolean> {
  if (repoKind(root) !== "repo") return false;
  const hashed = await git(["hash-object", "--no-filters", "--", file], root);
  const blob = hashed.stdout.trim();
  if (hashed.code !== 0 || !SHA.test(blob)) return false;
  const found = await git(["log", "--all", "-1", "--format=%H", `--find-object=${blob}`, "--", relative], root);
  if (found.code === 0 && SHA.test(found.stdout.trim())) return true;
  const norm = await normalizedHash(root, file);
  if (!norm || norm === blob) return false;
  const normFound = await git(["log", "--all", "-1", "--format=%H", `--find-object=${norm}`, "--", relative], root);
  return normFound.code === 0 && SHA.test(normFound.stdout.trim());
}

export interface MergeResult {
  merged: boolean;
  /** Files git could not merge by itself, when it stopped. */
  files: string[];
  /** Why git would not start (uncommitted changes in the way, a merge already under way). */
  refused: string | null;
}

/** Merges a kept branch into the one checked out. A clean merge also removes the kept branch. */
export function mergeSaved(root: string, saved: string): Promise<MergeResult> {
  return withRepoLock(root, async () => {
    const email = (await git(["config", "--get", "user.email"], root)).stdout.trim();
    const ident = email ? [] : ["-c", "user.name=VibeForge Sync", "-c", "user.email=sync@vibeforge.local"];
    const run = await git([...ident, "-c", "commit.gpgsign=false", "merge", "--no-edit", saved], root);
    if (run.code === 0) {
      await git(["branch", "-d", saved], root);
      return { merged: true, files: [], refused: null };
    }
    const unmerged = await git(["diff", "--name-only", "--diff-filter=U", "-z"], root);
    const files = unmerged.stdout.split("\0").filter(Boolean);
    if (files.length) return { merged: false, files, refused: null };
    const why = run.stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" ") || run.stdout.trim().split("\n").slice(-1)[0] || "";
    return { merged: false, files: [], refused: why };
  });
}
