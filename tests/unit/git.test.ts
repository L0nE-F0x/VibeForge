import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBranchCheckout, readBranches } from "../../src/core/branches.js";
import { hasCommit, uncommitted } from "../../src/core/service/orchestrator-utils.js";
import { diffSince, summarizeFolderGit } from "../../src/core/vcs.js";
import { createCopy, removeCopy } from "../../src/core/worktrees.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-git-test-"));
  tempDirs.push(dir);
  return dir;
}

function sysGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" }).trim();
}

describe("hardened git runner", () => {
  it("prepends hardened flags and disables external diff and textconv for diff, show, and log -p", async () => {
    const { HARDENED_GIT_ARGS, hardenGitArgs, runGit } = await import("../../src/core/git.js");

    expect(hardenGitArgs(["status", "--short"])).toEqual([
      "--no-pager",
      ...HARDENED_GIT_ARGS,
      "status",
      "--short",
    ]);

    expect(hardenGitArgs(["diff", "--stat", "HEAD"])).toEqual([
      "--no-pager",
      ...HARDENED_GIT_ARGS,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      "HEAD",
    ]);

    expect(hardenGitArgs(["-c", "color.ui=never", "--literal-pathspecs", "show", "HEAD"])).toEqual([
      "--no-pager",
      ...HARDENED_GIT_ARGS,
      "-c",
      "color.ui=never",
      "--literal-pathspecs",
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ]);

    expect(hardenGitArgs(["log", "-p", "-n", "2", "--", "a.txt"])).toEqual([
      "--no-pager",
      ...HARDENED_GIT_ARGS,
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "-p",
      "-n",
      "2",
      "--",
      "a.txt",
    ]);

    // Non-patch log and explicit -- -p file arguments don't need diff suppression injected into paths.
    expect(hardenGitArgs(["log", "--oneline", "--", "-p"])).toEqual([
      "--no-pager",
      ...HARDENED_GIT_ARGS,
      "log",
      "--oneline",
      "--",
      "-p",
    ]);

    // Missing git binary reports ENOENT cleanly.
    const missing = await runGit(["--version"], { env: { PATH: "/nonexistent-vibeforge-bin" } });
    expect(missing.missing).toBe(true);
    expect(missing.code).toBe(127);

    // Timeout and maxBuffer truncation are tracked.
    const root = makeTempDir();
    sysGit(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "big.txt"), `${"x".repeat(4096)}\n`);
    sysGit(root, "add", "big.txt");
    sysGit(root, "commit", "-qm", "init");
    const capped = await runGit(["diff", "HEAD~0", "--", "big.txt"], { cwd: root });
    expect(capped.code).toBe(0);
    const bigShow = await runGit(["show", "HEAD:big.txt"], { cwd: root, maxBuffer: 64 });
    expect(bigShow.truncated).toBe(true);
    expect(bigShow.stdout.length).toBeLessThanOrEqual(64);
  });

  it("never executes repo core.fsmonitor, post-checkout hooks, or diff.external across VibeForge callers", async () => {
    const base = makeTempDir();
    const repo = path.join(base, "repo");
    const dataRoot = path.join(base, "data");
    const hookDir = path.join(base, "hooks");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(hookDir, { recursive: true });

    sysGit(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    sysGit(repo, "add", "a.txt");
    sysGit(repo, "commit", "-qm", "initial");
    sysGit(repo, "branch", "feature");

    const pwnFsMonitor = path.join(base, "pwned-fsmonitor");
    const pwnHook = path.join(base, "pwned-hook");
    const pwnExtDiff = path.join(base, "pwned-extdiff");

    const fsmonitorScript = path.join(base, "fsmonitor.sh");
    fs.writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch "${pwnFsMonitor}"\nexit 1\n`, { mode: 0o755 });
    const postCheckout = path.join(hookDir, "post-checkout");
    fs.writeFileSync(postCheckout, `#!/bin/sh\ntouch "${pwnHook}"\n`, { mode: 0o755 });
    const extDiff = path.join(base, "extdiff.sh");
    fs.writeFileSync(extDiff, `#!/bin/sh\ntouch "${pwnExtDiff}"\n`, { mode: 0o755 });

    sysGit(repo, "config", "core.fsmonitor", fsmonitorScript);
    sysGit(repo, "config", "core.hooksPath", hookDir);
    sysGit(repo, "config", "diff.external", extDiff);

    // Dirty the working tree so status and diffs have real changes to inspect.
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");

    expect(await hasCommit(repo)).toBe(true);
    expect(await uncommitted(repo)).toBe(1);
    expect((await summarizeFolderGit(repo)).dirty).toBe(1);
    expect(await diffSince(repo, null)).toContain("+changed");

    const copyTarget = path.join(dataRoot, "worktrees", "task-1");
    const copy = await createCopy(repo, copyTarget, "vibeforge/task-1");
    await removeCopy(copy, { dataRoot, taskId: "task-1" });

    expect((await readBranches(repo)).branches.map((b) => b.name)).toContain("feature");
    const opened = await openBranchCheckout(repo, "feature");
    expect(fs.existsSync(opened.path)).toBe(true);

    expect(fs.existsSync(pwnFsMonitor)).toBe(false);
    expect(fs.existsSync(pwnHook)).toBe(false);
    expect(fs.existsSync(pwnExtDiff)).toBe(false);
  });
});

describe("which refs count as history", () => {
  // Run snapshots under refs/vibeforge hold uncommitted work. Every walk of "all refs" goes through
  // HISTORY_REVS, and every `for-each-ref --contains` through HOLDING_REFS, so none treats them as kept.
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  const root = path.resolve(__dirname, "../../src");
  // Viby's list of read-only flags it may pass to git for the person (a list, not a call), and git.ts, which defines the helper.
  const allowed = new Set([path.join(root, "shared", "orchestrator-intel.ts"), path.join(root, "core", "git.ts")]);

  it("has no git call in src that walks every ref without leaving VibeForge's own out", () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      if (allowed.has(file)) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const where = `${path.relative(root, file)}:${index + 1}`;
        if (/["'`]--all["'`]/.test(line) && !line.includes("HISTORY_REVS")) offenders.push(where);
        if (/["'`]for-each-ref["'`]/.test(line) && line.includes("--contains") && !line.includes("HOLDING_REFS")) offenders.push(where);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("leaves nested refs/vibeforge refs out of HISTORY_REVS", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vf-history-"));
    tempDirs.push(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    run("add", "-A");
    run("commit", "-qm", "a");
    const tree = run("write-tree");
    const hidden = run("commit-tree", "-m", "snapshot", tree);
    run("update-ref", "refs/vibeforge/runs/2026-11-28T100000Z_x/abc/start", hidden);
    const { HISTORY_REVS } = await import("../../src/core/git.js");
    expect(run("rev-list", ...HISTORY_REVS)).toBe(run("rev-parse", "HEAD"));
    expect(run("rev-list", "--all").split("\n")).toContain(hidden);
  });
});
