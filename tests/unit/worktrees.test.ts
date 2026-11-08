import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyToWorkspace, copyBranch, copyPatch, createCopy, lockCopy, removeCopy, unlockCopy, type CopyOwner, type WorkingCopy } from "../../src/core/worktrees.js";

// Real git in throwaway repositories: a task's copy, changed, then applied to a workspace that has moved on.

const made: string[] = [];

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-wt-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
}

function write(root: string, name: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), body);
}

function read(root: string, name: string): string {
  return fs.readFileSync(path.join(root, name), "utf8");
}

const LINES = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

/** A repository with `files` committed, and task-1's copy of it. */
async function repoWithCopy(files: Record<string, string | Buffer>, taskId = "task-1") {
  const repo = temp();
  git(repo, "init", "-q");
  for (const [name, body] of Object.entries(files)) write(repo, name, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const dataRoot = temp();
  const owner: CopyOwner = { dataRoot, taskId };
  const copy = await createCopy(repo, path.join(dataRoot, "worktrees", taskId), copyBranch(taskId));
  return { repo, copy, owner, dataRoot };
}

async function apply(copy: WorkingCopy, owner: CopyOwner) {
  return applyToWorkspace(copy, await copyPatch(copy, owner));
}

/** What git itself holds for the workspace: staged changes and any unmerged entries. */
function indexState(repo: string): string {
  return `${git(repo, "diff", "--cached", "--binary")}\n--unmerged--\n${git(repo, "ls-files", "-u")}`;
}

describe("applying a task's copy", () => {
  it("merges into files with uncommitted edits, and leaves the index as it was", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES, "s.txt": "staged\n" });
    // The agent changes a line, committing it.
    write(copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(copy.path, "commit", "-qam", "agent");
    // Meanwhile the person edits a line two above it, and stages another file.
    write(repo, "a.txt", LINES.replace("two", "TWO"));
    write(repo, "s.txt", "staged, changed\n");
    git(repo, "add", "s.txt");
    const before = indexState(repo);

    expect(await apply(copy, owner)).toEqual({ files: ["a.txt"], conflicts: [], kept: [] });
    expect(read(repo, "a.txt")).toBe(LINES.replace("two", "TWO").replace("five", "FIVE"));
    expect(indexState(repo)).toBe(before);
    expect(git(repo, "status", "--porcelain")).toBe(" M a.txt\nM  s.txt\n");
  });

  it("sees an edit made in the same second git last wrote its index", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("six", "SIX"));
    // The edit keeps the file's size and time, as one made in the same second can; only its content tells.
    git(repo, "config", "core.trustctime", "false");
    const when = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(path.join(repo, "a.txt"), when, when);
    git(repo, "update-index", "--refresh");
    fs.utimesSync(path.join(repo, ".git", "index"), when, when);
    write(repo, "a.txt", LINES.replace("one", "ONE"));
    fs.utimesSync(path.join(repo, "a.txt"), when, when);
    // Git itself still knows to look: the index was written in the second the file last changed.
    expect(fs.statSync(path.join(repo, ".git", "index")).mtimeMs).toBe(when.getTime());

    expect(await apply(copy, owner)).toEqual({ files: ["a.txt"], conflicts: [], kept: [] });
    expect(read(repo, "a.txt")).toBe(LINES.replace("one", "ONE").replace("six", "SIX"));
  });

  it("leaves conflict markers where both sides changed the same lines, outside the index", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("four", "four from the copy"));
    write(repo, "a.txt", LINES.replace("four", "four from the workspace").replace("one", "ONE"));
    const before = indexState(repo);

    const result = await apply(copy, owner);
    expect(result).toEqual({ files: ["a.txt"], conflicts: ["a.txt"], kept: [] });
    const text = read(repo, "a.txt");
    expect(text).toContain("ONE\n");
    expect(text).toMatch(/^<<<<<<< workspace\nfour from the workspace\n(\|\|\|\|\|\|\| base\nfour\n)?=======\nfour from the copy\n>>>>>>> vibeforge\/task-1\n/m);
    expect(indexState(repo)).toBe(before);
  });

  it("brings in new, deleted, renamed, binary and mode-changed files", async () => {
    const { repo, copy, owner } = await repoWithCopy({
      "old.txt": LINES,
      "gone.txt": "bye\n",
      "run.sh": "echo hi\n",
      "logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
      "nested/deep/only.txt": "alone\n",
    });
    write(copy.path, "new.txt", "brand new\n");
    fs.rmSync(path.join(copy.path, "gone.txt"));
    fs.rmSync(path.join(copy.path, "nested"), { recursive: true });
    git(copy.path, "mv", "old.txt", "moved.txt");
    write(copy.path, "moved.txt", LINES.replace("six", "SIX"));
    fs.chmodSync(path.join(copy.path, "run.sh"), 0o755);
    write(copy.path, "logo.bin", Buffer.from([0, 9, 9, 9, 0, 255]));
    // The person edits another line of the file the copy renamed.
    write(repo, "old.txt", LINES.replace("two", "TWO"));
    const before = indexState(repo);

    const result = await apply(copy, owner);
    expect(result.conflicts).toEqual([]);
    expect(result.files.sort()).toEqual(["gone.txt", "logo.bin", "moved.txt", "nested/deep/only.txt", "new.txt", "run.sh"]);
    expect(read(repo, "new.txt")).toBe("brand new\n");
    expect(fs.existsSync(path.join(repo, "gone.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "nested"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "old.txt"))).toBe(false);
    expect(read(repo, "moved.txt")).toBe(LINES.replace("two", "TWO").replace("six", "SIX"));
    expect(fs.statSync(path.join(repo, "run.sh")).mode & 0o111).not.toBe(0);
    expect([...fs.readFileSync(path.join(repo, "logo.bin"))]).toEqual([0, 9, 9, 9, 0, 255]);
    expect(indexState(repo)).toBe(before);
  });

  it("keeps the workspace's version of a binary both sides changed, and says so", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "logo.bin": Buffer.from([0, 1, 2]), "a.txt": LINES });
    write(copy.path, "logo.bin", Buffer.from([0, 7, 7]));
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    write(repo, "logo.bin", Buffer.from([0, 5, 5]));

    expect(await apply(copy, owner)).toEqual({ files: ["a.txt", "logo.bin"], conflicts: ["logo.bin"], kept: ["logo.bin"] });
    expect([...fs.readFileSync(path.join(repo, "logo.bin"))]).toEqual([0, 5, 5]);
    expect(read(repo, "a.txt")).toBe(LINES.replace("one", "ONE"));
    expect(git(repo, "ls-files", "-u")).toBe("");
  });

  it("never deletes a file the workspace edited, nor brings back one it deleted", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "edited.txt": LINES, "removed.txt": LINES });
    fs.rmSync(path.join(copy.path, "edited.txt"));
    write(copy.path, "removed.txt", LINES.replace("one", "ONE"));
    write(repo, "edited.txt", LINES.replace("two", "my edit"));
    fs.rmSync(path.join(repo, "removed.txt"));

    const result = await apply(copy, owner);
    expect(result.conflicts.sort()).toEqual(["edited.txt", "removed.txt"]);
    expect(result.kept?.sort()).toEqual(["edited.txt", "removed.txt"]);
    expect(read(repo, "edited.txt")).toBe(LINES.replace("two", "my edit"));
    expect(fs.existsSync(path.join(repo, "removed.txt"))).toBe(false);
  });

  it("merges a new file with an untracked one of the same name, and leaves an identical one be", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "same.txt", "same\n");
    write(copy.path, "notes.txt", "from the copy\n");
    write(repo, "same.txt", "same\n");
    write(repo, "notes.txt", "my own notes\n");

    const result = await apply(copy, owner);
    expect(result).toEqual({ files: ["notes.txt", "same.txt"], conflicts: ["notes.txt"], kept: [] });
    expect(read(repo, "notes.txt")).toMatch(/^<<<<<<< workspace\nmy own notes\n=======\nfrom the copy\n>>>>>>> vibeforge\/task-1\n$/);
    expect(read(repo, "same.txt")).toBe("same\n");
    expect(git(repo, "status", "--porcelain")).toBe("?? notes.txt\n?? same.txt\n");
  });

  it("never overwrites a file the workspace ignores", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "local.env", "TOKEN=from-the-copy\n");
    write(repo, ".gitignore", "local.env\n");
    write(repo, "local.env", "TOKEN=mine\n");

    const result = await apply(copy, owner);
    expect(result.conflicts).toEqual(["local.env"]);
    expect(read(repo, "local.env")).toContain("TOKEN=mine\n");
    expect(read(repo, "local.env")).toContain("<<<<<<< workspace");
  });

  it("never writes through a symlink in the workspace, nor over an untracked folder", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    const outside = temp();
    fs.symlinkSync(outside, path.join(repo, "out"));
    write(copy.path, "out/planted.txt", "hello\n");
    write(copy.path, "build", "a file in the copy\n");
    write(repo, "build/cache.bin", "a folder here\n");

    const result = await apply(copy, owner);
    expect(result.conflicts.sort()).toEqual(["build", "out/planted.txt"]);
    expect(result.kept?.sort()).toEqual(["build", "out/planted.txt"]);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(read(repo, "build/cache.bin")).toBe("a folder here\n");
  });

  it("finds files with spaces and accents in their names", async () => {
    const name = "notes and ideas/ünïcode file.txt";
    const { repo, copy, owner } = await repoWithCopy({ [name]: LINES });
    write(copy.path, name, LINES.replace("six", "SIX"));
    write(repo, name, LINES.replace("one", "ONE"));
    expect(await apply(copy, owner)).toEqual({ files: [name], conflicts: [], kept: [] });
    expect(read(repo, name)).toBe(LINES.replace("one", "ONE").replace("six", "SIX"));
  });

  it("has nothing to do when the workspace already has the changes", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    write(repo, "a.txt", LINES.replace("one", "ONE"));
    expect(await apply(copy, owner)).toEqual({ files: ["a.txt"], conflicts: [], kept: [] });
    expect(read(repo, "a.txt")).toBe(LINES.replace("one", "ONE"));
    expect(await applyToWorkspace(copy, "")).toEqual({ files: [], conflicts: [], kept: [] });
  });

  it("says so when the patch doesn't fit the commit it names", async () => {
    const { copy } = await repoWithCopy({ "a.txt": LINES });
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-nothing like this\n+at all\n the end\n";
    await expect(applyToWorkspace(copy, patch)).rejects.toThrow(/^The changes don't apply to the workspace/);
  });
});

/** The worktrees git has registered in `repo`, as `git worktree list --porcelain` shows them. */
function worktrees(repo: string): string {
  return git(repo, "worktree", "list", "--porcelain");
}

describe("making a task's copy", () => {
  it("keeps a copy locked through a prune while it waits in the trash, and tidies it after", async () => {
    const { repo, copy, owner, dataRoot } = await repoWithCopy({ "a.txt": LINES });
    expect(await lockCopy(copy, owner)).toBe(true);
    const aside = path.join(temp(), "in-the-trash");
    fs.renameSync(copy.path, aside);
    // Another task's copy being made prunes the repository's worktrees.
    const other = await createCopy(repo, path.join(dataRoot, "worktrees", "task-2"), copyBranch("task-2"));
    git(repo, "worktree", "prune");
    expect(worktrees(repo)).toContain(`worktree ${copy.path}\n`);

    // Undo: the folder is back, unlocked, and still a working copy.
    fs.renameSync(aside, copy.path);
    await unlockCopy(copy, owner);
    expect(worktrees(repo)).not.toContain("locked");
    expect(git(copy.path, "status", "--porcelain")).toBe("");

    // Undo has passed: the trash empties, and the locked entry and the branch go with it.
    await lockCopy(copy, owner);
    fs.rmSync(copy.path, { recursive: true, force: true });
    await removeCopy(copy, owner);
    expect(worktrees(repo)).not.toContain(copy.path);
    expect(git(repo, "branch", "--list", copy.branch).trim()).toBe("");
    expect(worktrees(repo)).toContain(other.path);
  });

  it("clears a trash lock left by an app that has gone, and nobody else's", async () => {
    const { repo, copy, dataRoot } = await repoWithCopy({ "a.txt": LINES });
    const second = await createCopy(repo, path.join(dataRoot, "worktrees", "task-2"), copyBranch("task-2"));
    const gone = spawnSync("true").pid;
    git(repo, "worktree", "lock", "--reason", `VibeForge: in the trash until its Undo has passed (process ${gone})`, copy.path);
    git(repo, "worktree", "lock", "--reason", "mine, hands off", second.path);
    fs.rmSync(copy.path, { recursive: true, force: true });
    fs.rmSync(second.path, { recursive: true, force: true });

    await createCopy(repo, path.join(dataRoot, "worktrees", "task-3"), copyBranch("task-3"));
    expect(worktrees(repo)).not.toContain(copy.path);
    expect(worktrees(repo)).toContain("locked mine, hands off");
  });
});

