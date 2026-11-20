import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inHistory, mergeSaved, prepareRepo, repoKind, rescueRepo } from "../../src/core/sync/git-rescue.js";

// Real git in throwaway repositories, left in the state Syncthing leaves a synced `.git` in when
// both machines committed while apart: the other machine's files in place, this machine's as
// "sync-conflict" copies beside them, and both machines' commits in the object store.

const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-git-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
const write = (root: string, name: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), body);
};
const read = (root: string, name: string) => fs.readFileSync(path.join(root, name), "utf8");
const STAMP = "sync-conflict-20261117-204452-MTOM47S";
const copiesLeft = (root: string) => fs.readdirSync(path.join(root, ".git"), { recursive: true, encoding: "utf8" }).filter((name) => name.includes("sync-conflict") && !name.startsWith("objects"));

function repo(): string {
  const root = temp();
  git(root, "init", "-q", "-b", "main");
  // In the repository itself: the merge under test is run by the app, with whatever git finds there.
  git(root, "config", "user.name", "T");
  git(root, "config", "user.email", "t@t.invalid");
  git(root, "config", "commit.gpgsign", "false");
  write(root, "app.txt", "one\ntwo\nthree\n");
  write(root, "notes.md", "alpha\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/**
 * Both machines commit on main while apart. This machine ("mine") commits first; the other's
 * commit is later, so its branch pointer, index and reflog win here and this machine's are left
 * as copies. The working folder holds the newest of each file from either machine.
 */
function apart(root: string, mine: () => void, theirs: () => void): { mine: string; theirs: string } {
  const base = git(root, "rev-parse", "HEAD");
  mine();
  git(root, "add", "-A");
  git(root, "commit", "-qm", "mine");
  const mineSha = git(root, "rev-parse", "HEAD");
  const mineFiles = new Map<string, string>(git(root, "diff", "--name-only", base, mineSha).split("\n").filter(Boolean).map((file) => [file, read(root, file)]));
  // This machine's .git files, set aside as Syncthing would name them.
  const dotGit = path.join(root, ".git");
  for (const file of ["index", "COMMIT_EDITMSG", "logs/HEAD", "logs/refs/heads/main"]) fs.copyFileSync(path.join(dotGit, file), path.join(dotGit, `${file}.${STAMP}`));
  fs.writeFileSync(path.join(dotGit, "refs", "heads", `main.${STAMP}`), `${mineSha}\n`);
  // The other machine's commit, made from the same base, wins the branch.
  git(root, "reset", "-q", "--hard", base);
  theirs();
  git(root, "add", "-A");
  git(root, "commit", "-qm", "theirs");
  const theirsSha = git(root, "rev-parse", "HEAD");
  const theirsFiles = new Set(git(root, "diff", "--name-only", base, theirsSha).split("\n").filter(Boolean));
  // Files only this machine changed arrive nowhere else: they are still in the folder.
  for (const [file, body] of mineFiles) if (!theirsFiles.has(file)) write(root, file, body);
  return { mine: mineSha, theirs: theirsSha };
}

describe("sync: a repository on two machines", () => {
  it("tells a repository from a branch checkout from a plain folder", () => {
    const root = repo();
    expect(repoKind(root)).toBe("repo");
    const plain = temp();
    expect(repoKind(plain)).toBe("none");
    fs.writeFileSync(path.join(plain, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    expect(repoKind(plain)).toBe("checkout");
  });

  it("stops git rewriting its index per machine, and keeps Syncthing's files out of git status", async () => {
    const root = repo();
    await prepareRepo(root);
    expect(git(root, "config", "core.checkStat")).toBe("minimal");
    expect(git(root, "config", "core.trustctime")).toBe("false");
    write(root, ".stignore", "x\n");
    fs.mkdirSync(path.join(root, ".stfolder"));
    write(root, ".stfolder/marker", "");
    expect(git(root, "status", "--porcelain")).toBe("");
    const exclude = read(root, ".git/info/exclude");
    await prepareRepo(root);
    expect(read(root, ".git/info/exclude")).toBe(exclude);
    // A plain folder is left alone.
    const plain = temp();
    await prepareRepo(plain);
    expect(fs.readdirSync(plain)).toEqual([]);
    expect(await rescueRepo(plain, "desk")).toBeNull();
  });

  it("has nothing to do when nothing is in conflict", async () => {
    expect(await rescueRepo(repo(), "desk")).toBeNull();
  });

  it("keeps this machine's commits on a branch, and puts their files back into it", async () => {
    const root = repo();
    const shas = apart(
      root,
      () => write(root, "mine.txt", "from this machine\n"),
      () => write(root, "theirs.txt", "from the other\n"),
    );
    // And something not committed anywhere, which must survive untouched.
    write(root, "scratch.txt", "not committed\n");
    const rescue = await rescueRepo(root, "desk");
    expect(rescue).toMatchObject({ branches: [{ branch: "main", saved: "main-from-desk" }], settled: ["mine.txt"], indexReset: true });
    expect(rescue!.removed).toBe(5);
    expect(copiesLeft(root)).toEqual([]);
    expect(git(root, "rev-parse", "main")).toBe(shas.theirs);
    expect(git(root, "rev-parse", "main-from-desk")).toBe(shas.mine);
    // The folder is the branch plus what was never committed.
    expect(git(root, "status", "--porcelain")).toBe("?? scratch.txt");
    expect(fs.existsSync(path.join(root, "mine.txt"))).toBe(false);
    expect(read(root, "scratch.txt")).toBe("not committed\n");
    expect(git(root, "fsck", "--no-dangling")).toBe("");

    // An ordinary merge now, and the kept branch goes once it is merged.
    expect(await mergeSaved(root, "main-from-desk")).toEqual({ merged: true, files: [], refused: null });
    expect(read(root, "mine.txt")).toBe("from this machine\n");
    expect(read(root, "theirs.txt")).toBe("from the other\n");
    expect(git(root, "branch", "--list", "main-from-desk")).toBe("");
    // A second look finds nothing.
    expect(await rescueRepo(root, "desk")).toBeNull();
  });

  it("leaves a real merge conflict for git when both changed the same lines", async () => {
    const root = repo();
    apart(
      root,
      () => write(root, "app.txt", "one\ntwo (mine)\nthree\n"),
      () => write(root, "app.txt", "one\ntwo (theirs)\nthree\n"),
    );
    // Syncthing left this machine's version of the file beside the winner's.
    const copy = path.join(root, `app.${STAMP}.txt`);
    fs.writeFileSync(copy, "one\ntwo (mine)\nthree\n");
    const rescue = await rescueRepo(root, "desk");
    expect(rescue?.branches).toEqual([{ branch: "main", saved: "main-from-desk" }]);
    expect(rescue?.settled).toEqual([]);
    expect(read(root, "app.txt")).toBe("one\ntwo (theirs)\nthree\n");
    // The copy is this machine's committed version: kept in history, so it can go.
    expect(await inHistory(root, copy, "app.txt")).toBe(true);
    fs.writeFileSync(copy, "never committed\n");
    expect(await inHistory(root, copy, "app.txt")).toBe(false);
    expect(await inHistory(temp(), copy, "app.txt")).toBe(false);
    fs.rmSync(copy);

    const merged = await mergeSaved(root, "main-from-desk");
    expect(merged).toEqual({ merged: false, files: ["app.txt"], refused: null });
    expect(read(root, "app.txt")).toContain("<<<<<<<");
    // Still there to finish the merge with.
    expect(git(root, "branch", "--list", "main-from-desk")).toContain("main-from-desk");
    // Mid-merge, the folder is git's: copies go, nothing is put back.
    fs.writeFileSync(path.join(root, ".git", `index.${STAMP}`), "x");
    expect(await rescueRepo(root, "desk")).toMatchObject({ branches: [], settled: [], indexReset: false, removed: 1 });
    expect(read(root, "app.txt")).toContain("<<<<<<<");
  });

  it("says why when git won't start a merge", async () => {
    const root = repo();
    apart(
      root,
      () => write(root, "app.txt", "one\ntwo (mine)\nthree\n"),
      () => write(root, "notes.md", "beta\n"),
    );
    await rescueRepo(root, "desk");
    // Uncommitted work on a file the merge would change.
    write(root, "app.txt", "half-done edit\n");
    const refused = await mergeSaved(root, "main-from-desk");
    expect(refused.merged).toBe(false);
    expect(refused.files).toEqual([]);
    expect(refused.refused).toMatch(/app\.txt|local changes|overwritten/i);
    expect(read(root, "app.txt")).toBe("half-done edit\n");
  });

  it("drops a copy of a branch pointer the other machine already has, and never clobbers a branch name", async () => {
    const root = repo();
    const base = git(root, "rev-parse", "HEAD");
    write(root, "next.txt", "next\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "next");
    // The copy points at an older commit of the same branch: nothing is lost by dropping it.
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", `main.${STAMP}`), `${base}\n`);
    expect(await rescueRepo(root, "desk")).toMatchObject({ branches: [], removed: 1 });
    expect(git(root, "branch", "--format=%(refname:short)")).toBe("main");

    // The name wanted is taken by something else: the kept branch gets a number.
    const shas = apart(root, () => write(root, "mine.txt", "m\n"), () => write(root, "theirs.txt", "t\n"));
    git(root, "branch", "main-from-desk", base);
    const rescue = await rescueRepo(root, "desk");
    expect(rescue?.branches).toEqual([{ branch: "main", saved: "main-from-desk-2" }]);
    expect(git(root, "rev-parse", "main-from-desk-2")).toBe(shas.mine);
    expect(git(root, "rev-parse", "main-from-desk")).toBe(base);
    // Garbage in a copy is just removed.
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", `main.${STAMP}`), "not a commit\n");
    expect(await rescueRepo(root, "desk")).toMatchObject({ branches: [], removed: 1 });
  });

  it("brings back branches from this machine's packed list, under their own names when they are free", async () => {
    const root = repo();
    const base = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-qc", "feature/x");
    write(root, "x.txt", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "x");
    const feature = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-q", "main");
    write(root, "mine.txt", "m\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "mine on main");
    const mine = git(root, "rev-parse", "HEAD");
    // This machine's packed list, as a copy; the other machine never had feature/x and moved main elsewhere.
    fs.writeFileSync(path.join(root, ".git", `packed-refs.${STAMP}`), `# pack-refs with: peeled fully-peeled sorted\n${feature} refs/heads/feature/x\n${mine} refs/heads/main\n`);
    git(root, "branch", "-qD", "feature/x");
    git(root, "reset", "-q", "--hard", base);
    write(root, "theirs.txt", "t\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "theirs on main");
    // "lap top" makes no branch name: the commits are kept all the same, under a plain one.
    const rescue = await rescueRepo(root, "lap top");
    expect(git(root, "rev-parse", "feature/x")).toBe(feature);
    expect(rescue?.branches).toEqual([{ branch: "main", saved: "main-from-other-machine" }]);
    expect(git(root, "rev-parse", "main-from-other-machine")).toBe(mine);
    expect(git(root, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["feature/x", "main", "main-from-other-machine"]);
    // With a proper name, the same commit is found kept already, and nothing new is made.
    fs.writeFileSync(path.join(root, ".git", `packed-refs.${STAMP}`), `${mine} refs/heads/main\n`);
    expect((await rescueRepo(root, "laptop"))?.branches).toEqual([{ branch: "main", saved: "main-from-laptop" }]);
    expect(git(root, "rev-parse", "main-from-laptop")).toBe(mine);
  });

  it("makes the folder match the branch when the machines were on different branches", async () => {
    const root = repo();
    // The other machine committed on main…
    write(root, "notes.md", "alpha\nfrom the other machine\n");
    git(root, "commit", "-qam", "theirs on main");
    const dotGit = path.join(root, ".git");
    // …and its index and reflog are the ones here, while this machine's lost.
    for (const file of ["index", "logs/HEAD"]) fs.copyFileSync(path.join(dotGit, file), path.join(dotGit, `${file}.keep`));
    // This machine switched to a new branch and committed there.
    git(root, "switch", "-qc", "feature/x", "HEAD~1");
    write(root, "x.txt", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "mine on feature/x");
    const feature = git(root, "rev-parse", "HEAD");
    for (const file of ["index", "logs/HEAD"]) {
      fs.renameSync(path.join(dotGit, file), path.join(dotGit, `${file}.${STAMP}`));
      fs.renameSync(path.join(dotGit, `${file}.keep`), path.join(dotGit, file));
    }
    // The other machine's change to notes.md is in the folder, as an edit on top of feature/x.
    write(root, "notes.md", "alpha\nfrom the other machine\n");
    expect(git(root, "status", "--porcelain")).not.toBe("");

    const rescue = await rescueRepo(root, "desk");
    expect(rescue).toMatchObject({ branches: [], indexReset: true, settled: ["notes.md"] });
    expect(git(root, "rev-parse", "HEAD")).toBe(feature);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(read(root, "notes.md")).toBe("alpha\n");
    // The other machine's commit is where it was made.
    expect(git(root, "show", "main:notes.md")).toBe("alpha\nfrom the other machine");
  });

  it("keeps a branch copy untouched when the winning ref points at a commit object that has not arrived yet", async () => {
    const root = repo();
    const mine = git(root, "rev-parse", "HEAD");
    const missing = "a".repeat(40);
    const mainRef = path.join(root, ".git", "refs", "heads", "main");
    const conflictRef = path.join(root, ".git", "refs", "heads", `main.${STAMP}`);
    fs.writeFileSync(mainRef, `${missing}\n`);
    fs.writeFileSync(conflictRef, `${mine}\n`);

    const rescue = await rescueRepo(root, "desk");
    expect(rescue).toMatchObject({ branches: [], removed: 0 });
    expect(fs.readFileSync(mainRef, "utf8").trim()).toBe(missing);
    expect(fs.existsSync(conflictRef)).toBe(true);
  });

  it("preserves older local stashes from a conflict copy of logs/refs/stash", async () => {
    const root = repo();
    write(root, "one.txt", "stash-1\n");
    git(root, "add", "one.txt");
    git(root, "stash", "push", "-m", "older local stash");
    const olderSha = git(root, "rev-parse", "stash@{0}");

    write(root, "two.txt", "stash-2\n");
    git(root, "add", "two.txt");
    git(root, "stash", "push", "-m", "newer local stash");
    const newerSha = git(root, "rev-parse", "stash@{0}");

    const dotGit = path.join(root, ".git");
    fs.copyFileSync(path.join(dotGit, "refs", "stash"), path.join(dotGit, "refs", `stash.${STAMP}`));
    fs.copyFileSync(path.join(dotGit, "logs", "refs", "stash"), path.join(dotGit, "logs", "refs", `stash.${STAMP}`));
    git(root, "stash", "clear");
    write(root, "remote.txt", "remote\n");
    git(root, "add", "remote.txt");
    git(root, "stash", "push", "-m", "remote stash");
    const remoteSha = git(root, "rev-parse", "stash@{0}");

    const rescue = await rescueRepo(root, "desk");
    expect(rescue?.removed).toBe(2);
    const shas = git(root, "stash", "list", "--format=%H").split("\n");
    expect(shas).toContain(olderSha);
    expect(shas).toContain(newerSha);
    expect(shas).toContain(remoteSha);

    // If a lost stash reflog entry's commit object has not arrived yet, keep the copy for retry.
    const unreadyLog = path.join(dotGit, "logs", "refs", `stash.${STAMP}`);
    fs.writeFileSync(unreadyLog, `${"0".repeat(40)} ${"b".repeat(40)} Test <t@example.com> 1700000000 +0000\tstash\n`);
    expect(await rescueRepo(root, "desk")).toMatchObject({ removed: 0 });
    expect(fs.existsSync(unreadyLog)).toBe(true);
  });

  it("never executes repo fsmonitor or clean/smudge filters during rescue or inHistory", async () => {
    const root = repo();
    const { inHistory } = await import("../../src/core/sync/git-rescue.js");
    const marker = path.join(path.dirname(root), "pwned");
    const hook = path.join(path.dirname(root), "run-hook.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    git(root, "config", "core.fsmonitor", hook);
    git(root, "config", "filter.evil.clean", hook);
    git(root, "config", "filter.evil.smudge", hook);
    write(root, ".gitattributes", "*.txt filter=evil\n");
    write(root, "notes.txt", "clean\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "with filter config");

    const base = git(root, "rev-parse", "HEAD~1");
    git(root, "checkout", "-q", base);
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", `main.${STAMP}`), `${base}\n`);
    write(root, `notes.sync-conflict-${STAMP.replace(/^sync-conflict-/, "")}.txt`, "clean\n");
    fs.rmSync(marker, { force: true });
    await rescueRepo(root, "desk");
    await inHistory(root, path.join(root, "notes.txt"), "notes.txt");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
