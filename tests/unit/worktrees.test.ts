import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyToWorkspace, copyBranch, copyPatch, createCopy, hasStagedTree, leftInCopy, lockCopy, patchFiles, removeCopy, unlockCopy, type CopyOwner, type WorkingCopy } from "../../src/core/worktrees.js";

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
  it("names the files git ignores that the agent left in its copy, but not what builds and CLIs make", async () => {
    const { copy } = await repoWithCopy({ ".gitignore": "notes/\n*.local\nnode_modules/\ndist/\n.claude/\n*.log\n", "a.txt": "a\n" });
    expect(await leftInCopy(copy)).toEqual([]);
    write(copy.path, "a.txt", "changed\n");
    write(copy.path, "notes/plan.md", "the plan\n");
    write(copy.path, "config.local", "secret=1\n");
    write(copy.path, "node_modules/x/index.js", "x\n");
    write(copy.path, "dist/app.js", "built\n");
    write(copy.path, ".claude/settings.local.json", "{}\n");
    write(copy.path, "debug.log", "noise\n");
    expect((await leftInCopy(copy)).sort()).toEqual(["config.local", "notes/"]);
  });

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

  it("reads a copy's patch through a throwaway index without staging files in the live copy", async () => {
    const { copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    write(copy.path, "scratch.tmp", "untracked\n");

    const patch = await copyPatch(copy, owner);
    expect(patch).toContain("+ONE");
    expect(patch).toContain("b/scratch.tmp");
    expect(git(copy.path, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(git(copy.path, "status", "--porcelain")).toBe(" M a.txt\n?? scratch.tmp\n");
    expect(hasStagedTree(copy.path)).toBe(true);
    await removeCopy(copy, owner);
    expect(hasStagedTree(copy.path)).toBe(false);
  });

  it("brings text in other encodings across byte for byte", async () => {
    const latin1 = (text: string) => Buffer.from(text, "latin1");
    const { repo, copy, owner } = await repoWithCopy({ "fr.properties": latin1("titre=Café\nfin=oui\n") });
    // The agent edits a Latin-1 file and adds another; neither is valid UTF-8.
    write(copy.path, "fr.properties", latin1("titre=Café crème\nfin=oui\n"));
    write(copy.path, "de.properties", latin1("grüße=Grüße\n"));
    expect(await apply(copy, owner)).toEqual({ files: ["de.properties", "fr.properties"], conflicts: [], kept: [] });
    expect(fs.readFileSync(path.join(repo, "fr.properties"))).toEqual(latin1("titre=Café crème\nfin=oui\n"));
    expect(fs.readFileSync(path.join(repo, "de.properties"))).toEqual(latin1("grüße=Grüße\n"));
  });

  it("keeps a git repository made inside the copy instead of dropping it", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    // The agent clones something into its copy.
    const vendored = path.join(copy.path, "vendor", "lib");
    fs.mkdirSync(vendored, { recursive: true });
    git(vendored, "init", "-q");
    write(vendored, "lib.js", "export {};\n");
    git(vendored, "add", "-A");
    git(vendored, "commit", "-qm", "lib");
    const result = await apply(copy, owner);
    expect(result.conflicts).toEqual(["vendor/lib"]);
    expect(result.kept).toEqual(["vendor/lib"]);
    // The rest still comes in; the repository stays in the copy, where it can be fetched by hand.
    expect(read(repo, "a.txt")).toBe(LINES.replace("one", "ONE"));
    expect(fs.existsSync(path.join(repo, "vendor"))).toBe(false);
    expect(fs.existsSync(path.join(vendored, "lib.js"))).toBe(true);
  });

  it("names a repository with nothing committed inside the copy, instead of git's error", async () => {
    const { copy, owner } = await repoWithCopy({ "a.txt": LINES });
    const nested = path.join(copy.path, "scratch");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    write(nested, "notes.md", "draft\n");
    await expect(copyPatch(copy, owner)).rejects.toThrow("scratch in the copy is a git repository of its own with nothing committed yet");
  });
});

/** The worktrees git has registered in `repo`, as `git worktree list --porcelain` shows them. */
function worktrees(repo: string): string {
  return git(repo, "worktree", "list", "--porcelain");
}

describe("making a task's copy", () => {
  it("picks the copy's branch back up when its folder went, commits and all", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    git(copy.path, "commit", "-qam", "agent");
    const commit = git(copy.path, "rev-parse", "HEAD").trim();
    fs.rmSync(copy.path, { recursive: true, force: true });
    git(repo, "commit", "--allow-empty", "-qm", "the workspace moves on");

    const again = await createCopy(repo, copy.path, copy.branch, copy);
    expect(again).toEqual(copy);
    expect(git(again.path, "rev-parse", "HEAD").trim()).toBe(commit);
    expect(await copyPatch(again, owner)).toContain("+ONE");
  });

  it("sets an old copy branch with commits of its own aside, rather than resetting it", async () => {
    const { repo, copy } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("one", "ONE"));
    git(copy.path, "commit", "-qam", "agent");
    const commit = git(copy.path, "rev-parse", "HEAD").trim();
    fs.rmSync(copy.path, { recursive: true, force: true });
    const saved = () => git(repo, "branch", "--list", "vibeforge/task-1-saved-*", "--format=%(refname:short)").trim().split("\n").filter(Boolean);

    // No record of that copy (another task of the same name, long gone): a fresh branch from HEAD.
    const fresh = await createCopy(repo, copy.path, copy.branch);
    const head = git(repo, "rev-parse", "HEAD").trim();
    expect(fresh.base).toBe(head);
    expect(git(fresh.path, "rev-parse", "HEAD").trim()).toBe(head);
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatch(/^vibeforge\/task-1-saved-\d{8}-\d{6}$/);
    expect(git(repo, "rev-parse", saved()[0]).trim()).toBe(commit);

    // A branch with nothing of its own is simply started again.
    fs.rmSync(fresh.path, { recursive: true, force: true });
    await createCopy(repo, copy.path, copy.branch);
    expect(saved()).toHaveLength(1);
  });

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

  it("reports exact filenames from diff-tree and quoted patch headers when names contain ' b/' or quotes", async () => {
    const { copy, owner } = await repoWithCopy({ "a.txt": LINES });
    write(copy.path, "dir b/weird.txt", "from copy\n");
    write(copy.path, 'quote "name".txt', "quoted\n");
    const patch = await copyPatch(copy, owner);
    const applied = await applyToWorkspace(copy, patch);
    expect(applied.conflicts).toEqual([]);
    expect(applied.files).toEqual(["dir b/weird.txt", 'quote "name".txt']);
    const quotedPatch = [
      'diff --git "a/dir b/file \\"one\\".txt" "b/dir b/file \\"one\\".txt"',
      "--- a/x",
      "+++ b/y",
      "diff --git a/plain b/keep.txt b/plain b/keep.txt",
    ].join("\n");
    expect(patchFiles(quotedPatch)).toEqual(['dir b/file "one".txt', "plain b/keep.txt"]);
  });
});

/** A bare remote ("GitHub"), a local clone on `main` tracking `origin/main`, a second clone for remote merges, and a copy. */
async function remoteRepoWithCopy(files: Record<string, string | Buffer>, taskId = "task-1") {
  const remote = temp();
  git(remote, "init", "--bare", "-q", "-b", "main");
  const repo = temp();
  git(repo, "clone", "-q", remote, ".");
  for (const [name, body] of Object.entries(files)) write(repo, name, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  const github = temp();
  git(github, "clone", "-q", remote, ".");
  const dataRoot = temp();
  const owner: CopyOwner = { dataRoot, taskId };
  const copy = await createCopy(repo, path.join(dataRoot, "worktrees", taskId), copyBranch(taskId));
  return { remote, repo, github, copy, owner, dataRoot };
}

describe("applying a copy that was already merged", () => {
  it("fetches and fast-forwards main cleanly when the copy was squash-merged on the remote", async () => {
    const { repo, github, copy, owner } = await remoteRepoWithCopy({ "a.txt": LINES, "b.txt": "keep\n" });
    write(copy.path, "a.txt", LINES.replace("five", "FIVE"));
    write(copy.path, "new.txt", "hello\n");
    git(copy.path, "add", "-A");
    git(copy.path, "commit", "-qm", "feat: update a");
    git(copy.path, "push", "-q", "origin", copy.branch);

    // GitHub squash-merges the PR onto origin/main as a brand-new commit; local main hasn't fetched yet.
    git(github, "fetch", "-q", "origin", copy.branch);
    git(github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(github, "commit", "-qm", "feat: update a (#1)");
    git(github, "push", "-q", "origin", "main");
    const mergedSha = git(github, "rev-parse", "HEAD").trim();

    const result = await apply(copy, owner);
    expect(result).toEqual({
      files: ["a.txt", "new.txt"],
      conflicts: [],
      kept: [],
      pulled: { branch: "main", upstream: "origin/main" },
    });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(mergedSha);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read(repo, "a.txt")).toBe(LINES.replace("five", "FIVE"));
    expect(read(repo, "new.txt")).toBe("hello\n");
  });

  it("fast-forwards cleanly after a regular merge commit even when another PR landed on top", async () => {
    const { repo, github, copy, owner } = await remoteRepoWithCopy({ "a.txt": LINES, "other.txt": "before\n" });
    write(copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(copy.path, "commit", "-qam", "agent change");
    git(copy.path, "push", "-q", "origin", copy.branch);

    // PR merged with a merge commit, then a second PR edits another file and another line of a.txt.
    git(github, "fetch", "-q", "origin", copy.branch);
    git(github, "merge", "--no-ff", "-qm", "Merge PR #1", "FETCH_HEAD");
    write(github, "other.txt", "after\n");
    write(github, "a.txt", LINES.replace("one", "ONE").replace("five", "FIVE"));
    git(github, "commit", "-qam", "PR #2");
    git(github, "push", "-q", "origin", "main");
    const tip = git(github, "rev-parse", "HEAD").trim();

    const result = await apply(copy, owner);
    expect(result).toEqual({
      files: ["a.txt"],
      conflicts: [],
      kept: [],
      pulled: { branch: "main", upstream: "origin/main" },
    });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read(repo, "other.txt")).toBe("after\n");
    expect(read(repo, "a.txt")).toBe(LINES.replace("one", "ONE").replace("five", "FIVE"));
  });

  it("fast-forwards cleanly after a rebase-merge on the remote", async () => {
    const { repo, github, copy, owner } = await remoteRepoWithCopy({ "a.txt": LINES, "other.txt": "base\n" });
    write(github, "other.txt", "upstream first\n");
    git(github, "commit", "-qam", "upstream commit");
    git(github, "push", "-q", "origin", "main");

    write(copy.path, "a.txt", LINES.replace("six", "SIX"));
    git(copy.path, "commit", "-qam", "agent change");
    git(copy.path, "push", "-q", "origin", copy.branch);

    // GitHub replays the commit onto the newer origin/main (new SHA, no merge commit).
    git(github, "fetch", "-q", "origin", copy.branch);
    git(github, "cherry-pick", "FETCH_HEAD");
    git(github, "push", "-q", "origin", "main");
    const tip = git(github, "rev-parse", "HEAD").trim();

    const result = await apply(copy, owner);
    expect(result.pulled).toEqual({ branch: "main", upstream: "origin/main" });
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("recognises when main was already pulled before clicking Apply", async () => {
    const { repo, github, copy, owner } = await remoteRepoWithCopy({ "a.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("three", "THREE"));
    git(copy.path, "commit", "-qam", "agent");
    git(copy.path, "push", "-q", "origin", copy.branch);

    git(github, "fetch", "-q", "origin", copy.branch);
    git(github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(github, "commit", "-qm", "squash");
    git(github, "push", "-q", "origin", "main");
    git(repo, "pull", "--ff-only", "-q");

    const result = await apply(copy, owner);
    expect(result).toEqual({
      files: ["a.txt"],
      conflicts: [],
      kept: [],
      pulled: { branch: "main", upstream: "origin/main", alreadyUpToDate: true },
    });
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("keeps unrelated local edits on fast-forward, and falls back to three-way merge when local edits collide", async () => {
    const first = await remoteRepoWithCopy({ "a.txt": LINES, "notes.txt": "mine\n" });
    write(first.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(first.copy.path, "commit", "-qam", "agent");
    git(first.copy.path, "push", "-q", "origin", first.copy.branch);
    git(first.github, "fetch", "-q", "origin", first.copy.branch);
    git(first.github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(first.github, "commit", "-qm", "squash");
    git(first.github, "push", "-q", "origin", "main");
    // Unrelated local edit in the workspace stays intact across the fast-forward.
    write(first.repo, "notes.txt", "mine, edited\n");
    const pulled = await apply(first.copy, first.owner);
    expect(pulled.pulled).toEqual({ branch: "main", upstream: "origin/main" });
    expect(read(first.repo, "notes.txt")).toBe("mine, edited\n");
    expect(git(first.repo, "status", "--porcelain")).toBe(" M notes.txt\n");

    // When a local edit touches the same file, fast-forward refuses and Apply falls back to three-way merge.
    const second = await remoteRepoWithCopy({ "a.txt": LINES }, "task-2");
    write(second.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(second.copy.path, "commit", "-qam", "agent");
    git(second.copy.path, "push", "-q", "origin", second.copy.branch);
    git(second.github, "fetch", "-q", "origin", second.copy.branch);
    git(second.github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(second.github, "commit", "-qm", "squash");
    git(second.github, "push", "-q", "origin", "main");
    write(second.repo, "a.txt", LINES.replace("two", "TWO"));

    const fallback = await apply(second.copy, second.owner);
    expect(fallback).toEqual({ files: ["a.txt"], conflicts: [], kept: [] });
    expect(read(second.repo, "a.txt")).toBe(LINES.replace("two", "TWO").replace("five", "FIVE"));
  });

  it("falls back to uncommitted edits when the copy has extra unmerged work, local main diverged, or the remote is unreachable", async () => {
    // 1. Copy has an extra uncommitted edit beyond what was merged on origin/main.
    const extra = await remoteRepoWithCopy({ "a.txt": LINES });
    write(extra.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(extra.copy.path, "commit", "-qam", "merged part");
    git(extra.copy.path, "push", "-q", "origin", extra.copy.branch);
    git(extra.github, "fetch", "-q", "origin", extra.copy.branch);
    git(extra.github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(extra.github, "commit", "-qm", "squash");
    git(extra.github, "push", "-q", "origin", "main");
    write(extra.copy.path, "extra.txt", "not pushed\n");

    const extraRes = await apply(extra.copy, extra.owner);
    expect(extraRes.pulled).toBeUndefined();
    expect(read(extra.repo, "extra.txt")).toBe("not pushed\n");

    // 2. Local main has an unpushed commit (diverged from origin/main), so it cannot fast-forward.
    const diverged = await remoteRepoWithCopy({ "a.txt": LINES, "local.txt": "0\n" }, "task-div");
    write(diverged.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(diverged.copy.path, "commit", "-qam", "agent");
    git(diverged.copy.path, "push", "-q", "origin", diverged.copy.branch);
    git(diverged.github, "fetch", "-q", "origin", diverged.copy.branch);
    git(diverged.github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(diverged.github, "commit", "-qm", "squash");
    git(diverged.github, "push", "-q", "origin", "main");
    write(diverged.repo, "local.txt", "local commit\n");
    git(diverged.repo, "commit", "-qam", "local only");

    const divRes = await apply(diverged.copy, diverged.owner);
    expect(divRes.pulled).toBeUndefined();
    expect(read(diverged.repo, "a.txt")).toBe(LINES.replace("five", "FIVE"));
    expect(read(diverged.repo, "local.txt")).toBe("local commit\n");

    // 3. Remote is unreachable (offline): Apply does not fail and applies locally as uncommitted edits.
    const offline = await remoteRepoWithCopy({ "a.txt": LINES }, "task-off");
    write(offline.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    git(offline.copy.path, "commit", "-qam", "agent");
    fs.rmSync(offline.remote, { recursive: true, force: true });

    const offRes = await apply(offline.copy, offline.owner);
    expect(offRes).toEqual({ files: ["a.txt"], conflicts: [], kept: [] });
    expect(read(offline.repo, "a.txt")).toBe(LINES.replace("five", "FIVE"));
  });

  it("applies only ticked files, keeps unticked ones untouched in workspace, and skips fast-forward when partial", async () => {
    const { repo, copy, owner } = await repoWithCopy({ "a.txt": LINES, "b.txt": LINES, "gone.txt": "bye\n", "old.txt": LINES });
    write(copy.path, "a.txt", LINES.replace("five", "FIVE"));
    write(copy.path, "b.txt", LINES.replace("two", "TWO"));
    write(copy.path, "new.txt", "fresh\n");
    fs.rmSync(path.join(copy.path, "gone.txt"));
    git(copy.path, "mv", "old.txt", "moved.txt");
    // Workspace has a conflicting edit on b.txt, which isn't ticked.
    write(repo, "b.txt", LINES.replace("two", "MINE"));

    const patch = await copyPatch(copy, owner);
    const partial = await applyToWorkspace(copy, patch, { files: ["a.txt", "moved.txt"] });
    expect(partial).toEqual({ files: ["a.txt", "moved.txt"], conflicts: [], kept: [], stayed: 3 });
    expect(read(repo, "a.txt")).toBe(LINES.replace("five", "FIVE"));
    expect(read(repo, "moved.txt")).toBe(LINES);
    expect(fs.existsSync(path.join(repo, "old.txt"))).toBe(false);
    // Unticked files weren't touched or conflicted.
    expect(read(repo, "b.txt")).toBe(LINES.replace("two", "MINE"));
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
    expect(read(repo, "gone.txt")).toBe("bye\n");

    // Empty file selection leaves everything in the copy untouched.
    expect(await applyToWorkspace(copy, patch, { files: [] })).toEqual({ files: [], conflicts: [], kept: [], stayed: 5 });

    // Partial Apply never fast-forwards even when the branch's commits were merged upstream.
    const merged = await remoteRepoWithCopy({ "a.txt": LINES, "b.txt": LINES }, "task-partial-ff");
    write(merged.copy.path, "a.txt", LINES.replace("five", "FIVE"));
    write(merged.copy.path, "b.txt", LINES.replace("two", "TWO"));
    git(merged.copy.path, "commit", "-qam", "agent");
    git(merged.copy.path, "push", "-q", "origin", merged.copy.branch);
    git(merged.github, "fetch", "-q", "origin", merged.copy.branch);
    git(merged.github, "merge", "--squash", "-q", "FETCH_HEAD");
    git(merged.github, "commit", "-qm", "squash");
    git(merged.github, "push", "-q", "origin", "main");

    const mergedPartial = await applyToWorkspace(merged.copy, await copyPatch(merged.copy, merged.owner), { files: ["a.txt"] });
    expect(mergedPartial).toEqual({ files: ["a.txt"], conflicts: [], kept: [], stayed: 1 });
    expect(mergedPartial.pulled).toBeUndefined();
    expect(read(merged.repo, "a.txt")).toBe(LINES.replace("five", "FIVE"));
    expect(read(merged.repo, "b.txt")).toBe(LINES);
  });
});

