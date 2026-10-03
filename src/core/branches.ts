import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDirectory } from "./fsx.js";
import { isPathInside } from "./places.js";
import { withRepoLock } from "./worktrees.js";

/**
 * A second checkout of a branch, as its own folder next to the repository's main worktree.
 * The folder you already have stays on whatever branch it is on. Git keeps one branch per
 * folder, so the only way to have both is a second folder.
 */

export interface BranchInfo {
  name: string;
  /** Short commit id, so two branches are easy to tell apart. */
  commit: string;
  /** Folder this branch is checked out in, when that folder is still on disk. */
  checkout: string | null;
  /** The folder we were asked about is already on this branch. */
  current: boolean;
}

export interface BranchList {
  /** Repository top folder, or null when `folder` is not a git repository. */
  repo: string | null;
  /** The branch `folder` is on, or null when it is detached or not a repository. */
  current: string | null;
  branches: BranchInfo[];
}

export interface OpenedCheckout {
  path: string;
  branch: string;
  /** The main worktree's folder name, for the workspace title. */
  repoName: string;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorktreeRow {
  path: string;
  branch: string | null;
}

const TIMEOUT_MS = 60_000;
const PREFERRED = ["main", "master", "trunk"];

function git(args: readonly string[], cwd: string): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "color.ui=never", ...args], {
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
    child.stdin.end();
  });
}

function detail(run: GitRun): string {
  return run.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `git exited ${run.code}`;
}

function openFailure(branch: string, run: GitRun): Error {
  return new Error(`Could not open ${branch}: ${detail(run)}`);
}

function readFailure(run: GitRun): Error {
  return new Error(`Could not read this folder's branches: ${detail(run)}`);
}

/** `git worktree list` puts the main worktree first. A missing git is code 127. */
async function worktrees(cwd: string): Promise<WorktreeRow[]> {
  const run = await git(["worktree", "list", "--porcelain"], cwd);
  if (run.code === 127) throw new Error("git was not found on PATH.");
  if (run.code !== 0) throw readFailure(run);
  const rows: WorktreeRow[] = [];
  let current: WorktreeRow | null = null;
  for (const line of run.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) rows.push(current);
      current = { path: path.resolve(line.slice("worktree ".length)), branch: null };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (current) rows.push(current);
  return rows;
}

/**
 * Where a new checkout goes: `<parent>/<repo>.worktrees/<branch>`. A slash in the branch name
 * becomes a folder, and the result has to stay inside that directory.
 */
function checkoutDir(main: string, branch: string): string {
  const root = path.join(path.dirname(main), `${path.basename(main)}.worktrees`);
  const parts = branch.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("That branch name is not valid.");
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, ...parts);
  if (target === realRoot || !isPathInside(realRoot, target)) throw new Error("That branch name is not valid.");
  return target;
}

async function canonicalBranch(cwd: string, name: string): Promise<string> {
  const check = await git(["check-ref-format", "--branch", name], cwd);
  if (check.code === 127) throw new Error("git was not found on PATH.");
  if (check.code !== 0 || check.stdout.trim() !== name) throw new Error("That branch name is not valid.");
  const verify = await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd);
  if (verify.code !== 0) throw new Error(`There is no branch named ${name}.`);
  return name;
}

/** Local branches of the repository `folder` is in. A folder that is not a repository lists nothing. */
export async function readBranches(folder: string): Promise<BranchList> {
  const top = await git(["rev-parse", "--show-toplevel"], folder);
  if (top.code === 127) throw new Error("git was not found on PATH.");
  if (top.code !== 0 || !top.stdout.trim()) return { repo: null, current: null, branches: [] };
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], folder);
  const current = head.code === 0 && head.stdout.trim() && head.stdout.trim() !== "HEAD" ? head.stdout.trim() : null;
  const refs = await git(["for-each-ref", "--format=%(refname:short)\t%(objectname:short)", "refs/heads"], folder);
  if (refs.code !== 0) throw readFailure(refs);
  const trees = await worktrees(folder);
  const checkedOut = new Map(trees.flatMap((row) => (row.branch ? [[row.branch, row.path] as const] : [])));
  const branches: BranchInfo[] = [];
  for (const line of refs.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, commit = ""] = line.split("\t");
    if (!name) continue;
    const checkout = checkedOut.get(name) ?? null;
    branches.push({ name, commit, checkout: checkout && isDirectory(checkout) ? checkout : null, current: name === current });
  }
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const preferredA = PREFERRED.indexOf(a.name);
    const preferredB = PREFERRED.indexOf(b.name);
    if (preferredA !== -1 || preferredB !== -1) {
      if (preferredA === -1) return 1;
      if (preferredB === -1) return -1;
      return preferredA - preferredB;
    }
    return a.name.localeCompare(b.name);
  });
  return { repo: path.resolve(top.stdout.trim()), current, branches };
}

/**
 * Check `branch` out in its own folder. When some folder already has it, that folder is reused.
 * The branch `folder` itself is on is refused: a second checkout of the same branch is impossible,
 * and this folder is already that branch.
 */
export async function openBranchCheckout(folder: string, branch: string): Promise<OpenedCheckout> {
  const name = branch.trim();
  const top = await git(["rev-parse", "--show-toplevel"], folder);
  if (top.code === 127) throw new Error("git was not found on PATH.");
  if (top.code !== 0 || !top.stdout.trim()) throw new Error("This folder is not a git repository.");
  const canonical = await canonicalBranch(folder, name);
  const trees = await worktrees(folder);
  const main = trees[0]?.path;
  if (!main) throw new Error("This folder is not a git repository.");
  return withRepoLock(main, () => addCheckout(folder, main, canonical));
}

async function addCheckout(folder: string, main: string, branch: string): Promise<OpenedCheckout> {
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], folder);
  if (head.code === 0 && head.stdout.trim() === branch) throw new Error(`This folder is already on ${branch}.`);
  let trees = await worktrees(folder);
  let found = trees.find((row) => row.branch === branch);
  if (found && !isDirectory(found.path)) {
    // A checkout deleted by hand leaves its registration, and git then refuses the branch.
    await git(["worktree", "prune"], folder);
    trees = await worktrees(folder);
    found = trees.find((row) => row.branch === branch);
  }
  if (found && isDirectory(found.path)) return { path: path.resolve(found.path), branch, repoName: path.basename(main) };
  const target = checkoutDir(main, branch);
  const added = await git(["worktree", "add", "-q", target, branch], folder);
  if (added.code !== 0) throw openFailure(branch, added);
  return { path: path.resolve(target), branch, repoName: path.basename(main) };
}
