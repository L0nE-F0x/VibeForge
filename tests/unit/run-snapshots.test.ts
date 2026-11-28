import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateRunDir, normalizeRun, RUN_FILES } from "../../src/core/runs.js";
import {
  applyUndoRestore,
  checkRunRestoreAvailability,
  getRunRestoreAvailability,
  hasGitMarker,
  previewRunRestore,
  removeRunSnapshots,
  restoreRunFiles,
  snapshotRef,
  takeEndSnapshot,
  takeStartSnapshot,
} from "../../src/core/snapshots.js";
import type { RunMeta } from "../../src/core/types.js";
import { commitDays, diffSince, gitHead, snapshotGit } from "../../src/core/vcs.js";
import { setup, started, until } from "./fixtures/service-harness.js";

const made: string[] = [];

function tempDir(prefix = "vf-snap-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function write(root: string, rel: string, body: string | Buffer): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function initRepo(files: Record<string, string | Buffer>, branch = "main"): string {
  const repo = tempDir("vf-snap-repo-");
  git(repo, "init", "-q", "-b", branch);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "Test");
  for (const [rel, body] of Object.entries(files)) write(repo, rel, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}

function listVibeforgeRefs(repo: string): string[] {
  const out = git(repo, "for-each-ref", "--format=%(refname)", "refs/vibeforge");
  return out ? out.split("\n").filter(Boolean) : [];
}

describe("run snapshots and restore", () => {
  it("captures start and end working-tree snapshots without touching index or HEAD, and avoids git log/push noise", async () => {
    const repo = initRepo({
      ".gitignore": "*.log\n",
      "a.txt": "before\n",
      "staged.txt": "committed\n",
    });
    const bare = tempDir("vf-snap-bare-");
    git(bare, "init", "--bare", "-q");
    git(repo, "remote", "add", "origin", bare);

    // Clean repo: start snapshot reuses HEAD (no extra commit in `git log --all`).
    const cleanDir = tempDir("vf-snap-rundir-clean-");
    const cleanStart = await takeStartSnapshot({ cwd: repo, runId: "run-clean", runDir: cleanDir });
    const headSha = git(repo, "rev-parse", "HEAD");
    expect(cleanStart?.startCommit).toBe(headSha);
    expect(git(repo, "log", "--all", "--oneline")).toHaveLength(git(repo, "log", "--oneline").length);

    // Dirty tree with staged change and ignored file: index stays untouched.
    write(repo, "staged.txt", "in-index\n");
    git(repo, "add", "staged.txt");
    write(repo, "staged.txt", "in-worktree\n");
    write(repo, "ignored.log", "keep me\n");
    const indexBefore = git(repo, "diff", "--cached", "--binary");

    const runDir = tempDir("vf-snap-rundir-");
    const start = await takeStartSnapshot({ cwd: repo, runId: "run-dirty", runDir });
    expect(start).not.toBeNull();
    expect(start?.startCommit).not.toBe(headSha);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headSha);
    expect(git(repo, "diff", "--cached", "--binary")).toBe(indexBefore);

    // Run modifies tracked file and creates a new file.
    write(repo, "a.txt", "after\n");
    write(repo, "created.txt", "new\n");
    const end = await takeEndSnapshot({ cwd: repo, runId: "run-dirty", runDir });
    expect(end?.endCommit).toBeTruthy();
    expect(git(repo, "diff", "--cached", "--binary")).toBe(indexBefore);
    expect(listVibeforgeRefs(repo)).toEqual([
      "refs/vibeforge/runs/run-clean/start",
      "refs/vibeforge/runs/run-dirty/end",
      "refs/vibeforge/runs/run-dirty/start",
    ]);

    // commitDays ignores refs/vibeforge/* even if a snapshot commit has the same author email.
    const days = await commitDays(repo, "2020-01-01");
    expect(days.map((d) => d.hash)).toEqual([headSha]);
    const synthTree = git(repo, "rev-parse", "refs/vibeforge/runs/run-dirty/end^{tree}");
    const sameAuthorCommit = git(repo, "commit-tree", "--no-gpg-sign", "-m", "snap", synthTree);
    git(repo, "update-ref", "--no-deref", "refs/vibeforge/runs/same-author/end", sameAuthorCommit);
    expect((await commitDays(repo, "2020-01-01")).map((d) => d.hash)).toEqual([headSha]);

    // Pushing (--all / --tags / default) never pushes refs/vibeforge/*.
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "push", "-q", "--all", "origin");
    git(repo, "push", "-q", "--tags", "origin");
    expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");

    await removeRunSnapshots({ id: "run-clean", cwd: repo, dir: cleanDir });
    await removeRunSnapshots({ id: "run-dirty", cwd: repo, dir: runDir });
    await removeRunSnapshots({ id: "same-author", cwd: repo, dir: "" });
    expect(listVibeforgeRefs(repo)).toEqual([]);
  });

  it("restores untouched files, removes untouched created files, leaves post-run edits alone, and supports Undo", async () => {
    const repo = initRepo({
      ".gitignore": "*.log\n",
      "a.txt": "before-a\n",
      "keep.txt": "before-keep\n",
      "del.txt": "before-del\n",
      "exec.sh": "echo hi\n",
      "clash": "was-a-file\n",
    });
    const runDir = tempDir("vf-snap-rundir-");
    const runId = "2026-11-28_run-1";
    const meta: RunMeta = normalizeRun({
      id: runId,
      origin: "code",
      title: "Run 1",
      cwd: repo,
      dir: runDir,
      status: "exited",
      startedAt: "2026-11-28T10:00:00Z",
      endedAt: "2026-11-28T10:01:00Z",
      engine: "claude",
    })!;

    write(repo, "ignored.log", "ignored-1\n");
    await takeStartSnapshot({ cwd: repo, runId, runDir });

    // Run makes changes.
    write(repo, "a.txt", "run-a\n");
    write(repo, "keep.txt", "run-keep\n");
    fs.rmSync(path.join(repo, "del.txt"));
    fs.chmodSync(path.join(repo, "exec.sh"), 0o755);
    write(repo, "only/created.txt", "created-by-run\n");
    write(repo, "new/edited-later.txt", "created-by-run\n");
    fs.rmSync(path.join(repo, "clash"));
    write(repo, "clash/inside.txt", "dir-entry\n");
    write(repo, "ignored.log", "ignored-2\n");
    await takeEndSnapshot({ cwd: repo, runId, runDir });

    // Post-run edits by the person or another CLI.
    write(repo, "keep.txt", "user-after-run\n");
    write(repo, "new/edited-later.txt", "user-edited-new-file\n");

    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.restorable).toEqual(
      expect.arrayContaining([
        { path: "a.txt", action: "restore" },
        { path: "del.txt", action: "recreate" },
        { path: "exec.sh", action: "restore" },
        { path: "only/created.txt", action: "delete" },
        { path: "clash/inside.txt", action: "delete" },
        { path: "clash", action: "recreate" },
      ]),
    );
    expect(preview.leftAlone).toEqual([
      { path: "keep.txt", reason: "changed" },
      { path: "new/edited-later.txt", reason: "changed" },
    ]);

    const { result, undoData } = await restoreRunFiles(meta, tempDir("vf-data-"));
    expect(result.restored.sort()).toEqual(["a.txt", "clash", "clash/inside.txt", "del.txt", "exec.sh", "only/created.txt"]);
    expect(result.deleted.sort()).toEqual(["clash/inside.txt", "only/created.txt"]);
    expect(result.leftAlone).toEqual([
      { path: "keep.txt", reason: "changed" },
      { path: "new/edited-later.txt", reason: "changed" },
    ]);

    expect(read(repo, "a.txt")).toBe("before-a\n");
    expect(read(repo, "del.txt")).toBe("before-del\n");
    expect(fs.statSync(path.join(repo, "exec.sh")).mode & 0o111).toBe(0);
    expect(fs.existsSync(path.join(repo, "only"))).toBe(false);
    expect(read(repo, "clash")).toBe("was-a-file\n");
    expect(read(repo, "keep.txt")).toBe("user-after-run\n");
    expect(read(repo, "new/edited-later.txt")).toBe("user-edited-new-file\n");
    expect(read(repo, "ignored.log")).toBe("ignored-2\n");

    // Undo puts the run's end state back for ONLY those restored files (and leaves post-run edits alone).
    expect(undoData).not.toBeNull();
    const reverted = await applyUndoRestore(undoData!);
    expect(reverted.sort()).toEqual(["a.txt", "clash", "clash/inside.txt", "del.txt", "exec.sh", "only/created.txt"]);
    expect(read(repo, "a.txt")).toBe("run-a\n");
    expect(fs.existsSync(path.join(repo, "del.txt"))).toBe(false);
    expect(fs.statSync(path.join(repo, "exec.sh")).mode & 0o111).not.toBe(0);
    expect(read(repo, "only/created.txt")).toBe("created-by-run\n");
    expect(read(repo, "clash/inside.txt")).toBe("dir-entry\n");
    expect(read(repo, "keep.txt")).toBe("user-after-run\n");
    expect(read(repo, "new/edited-later.txt")).toBe("user-edited-new-file\n");
  });

  it("skips oversized new files, remembers them so restore never deletes them, and skips nested git repos", async () => {
    const repo = initRepo({ "small.txt": "1\n" });
    git(repo, "init", "-q", "nested-sub");
    write(repo, "nested-sub/a.txt", "nested\n");
    write(repo, "pre-big.bin", Buffer.alloc(200, 1));
    const runDir = tempDir("vf-snap-rundir-");
    const runId = "run-big";
    const meta: RunMeta = normalizeRun({
      id: runId,
      origin: "code",
      title: "Big",
      cwd: repo,
      dir: runDir,
      status: "exited",
      startedAt: "2026-11-28T10:00:00Z",
      endedAt: "2026-11-28T10:01:00Z",
      engine: "claude",
    })!;

    const start = await takeStartSnapshot({ cwd: repo, runId, runDir, maxNewFileBytes: 50 });
    expect(start?.startSkipped).toEqual(["pre-big.bin"]);

    // Run shrinks pre-big.bin below the cap and creates another oversized file run-big.bin + edits small.txt.
    write(repo, "pre-big.bin", "shrunk\n");
    write(repo, "run-big.bin", Buffer.alloc(200, 2));
    write(repo, "small.txt", "2\n");
    const end = await takeEndSnapshot({ cwd: repo, runId, runDir, maxNewFileBytes: 50 });
    expect(end?.endSkipped).toEqual(["run-big.bin"]);

    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.restorable).toEqual([{ path: "small.txt", action: "restore" }]);
    expect(preview.leftAlone).toEqual([
      { path: "pre-big.bin", reason: "oversized" },
      { path: "run-big.bin", reason: "oversized" },
    ]);

    await restoreRunFiles(meta, tempDir("vf-data-"));
    expect(read(repo, "small.txt")).toBe("1\n");
    expect(read(repo, "pre-big.bin")).toBe("shrunk\n");
    expect(fs.existsSync(path.join(repo, "run-big.bin"))).toBe(true);
  });

  it("handles empty git repos without commits, symlinks, and never fails a run on snapshot errors", async () => {
    const empty = tempDir("vf-snap-empty-");
    git(empty, "init", "-q");
    const runDir = tempDir("vf-snap-rundir-");
    const warnings: string[] = [];
    const start = await takeStartSnapshot({ cwd: empty, runId: "run-empty", runDir, onWarn: (w) => warnings.push(w) });
    expect(start).not.toBeNull();
    write(empty, "first.txt", "hi\n");
    fs.symlinkSync("first.txt", path.join(empty, "link.txt"));
    const end = await takeEndSnapshot({ cwd: empty, runId: "run-empty", runDir, onWarn: (w) => warnings.push(w) });
    expect(end).not.toBeNull();
    expect(warnings).toEqual([]);

    const meta = normalizeRun({
      id: "run-empty",
      origin: "code",
      title: "Empty",
      cwd: empty,
      dir: runDir,
      status: "exited",
      startedAt: "2026-11-28T10:00:00Z",
      endedAt: "2026-11-28T10:01:00Z",
      engine: "claude",
    })!;
    await restoreRunFiles(meta, tempDir("vf-data-"));
    expect(fs.existsSync(path.join(empty, "first.txt"))).toBe(false);
    expect(fs.existsSync(path.join(empty, "link.txt"))).toBe(false);

    // Non-git folder returns null fast without spawning git.
    const plain = tempDir("vf-snap-plain-");
    expect(hasGitMarker(plain)).toBe(false);
    expect(await takeStartSnapshot({ cwd: plain, runId: "run-plain", runDir })).toBeNull();

    // Missing/broken git binary logs via onWarn and carries on without throwing.
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-vibeforge-bin";
    try {
      const brokenWarnings: string[] = [];
      const brokenDir = tempDir("vf-snap-broken-");
      expect(await takeStartSnapshot({ cwd: empty, runId: "run-broken", runDir: brokenDir, onWarn: (w) => brokenWarnings.push(w) })).toBeNull();
      expect(brokenWarnings[0]).toContain("Could not save start snapshot");
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("integrates with TeamService: snapshots real-folder runs, skips copies, reports states, supports Undo, and cleans refs on tidy", async () => {
    const repo = initRepo({ "app.txt": "initial\n" });
    const ctx = setup({
      now: () => new Date("2026-11-28T12:00:00Z"),
    });
    // Use real git helpers in host so TeamService records gitStart/snapshotGit accurately.
    ctx.host.gitHead = (cwd) => gitHead(cwd);
    ctx.host.snapshotGit = (cwd, startHead) => snapshotGit(cwd, 5000, startHead);

    const ws = ctx.svc.addWorkspace(repo).workspaces[0];
    const startedRun = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "argy" });
    expect(ctx.svc.getRun(startedRun.runId).restore).toBe("running");
    expect(listVibeforgeRefs(repo)).toEqual([snapshotRef(startedRun.runId, "start")!]);
    await expect(ctx.svc.previewRunRestore(startedRun.runId)).rejects.toThrow("Wait until this run finishes before putting files back.");

    // Simulate run editing a file and creating another, then exiting.
    write(repo, "app.txt", "by-agent\n");
    write(repo, "added.txt", "hello\n");
    await ctx.exit(startedRun.ptyId);

    const bundle = await ctx.svc.loadRun(startedRun.runId);
    expect(bundle.restore).toBe("ready");
    expect(listVibeforgeRefs(repo).sort()).toEqual([
      snapshotRef(startedRun.runId, "end")!,
      snapshotRef(startedRun.runId, "start")!,
    ]);

    const restored = await ctx.svc.restoreRun(startedRun.runId);
    expect(restored.restored.sort()).toEqual(["added.txt", "app.txt"]);
    expect(restored.undo).toEqual(expect.any(String));
    expect(read(repo, "app.txt")).toBe("initial\n");
    expect(fs.existsSync(path.join(repo, "added.txt"))).toBe(false);

    // Undo puts the run's changes back.
    await ctx.svc.undoRunRestore(restored.undo!);
    expect(read(repo, "app.txt")).toBe("by-agent\n");
    expect(read(repo, "added.txt")).toBe("hello\n");
    await expect(ctx.svc.undoRunRestore(restored.undo!)).rejects.toThrow("It is too late to undo that.");

    // Older run without snapshots.json -> "missing".
    const oldTime = new Date("2025-01-01T00:00:00Z");
    const oldAlloc = allocateRunDir(ctx.dataRoot, oldTime, "old-run");
    const oldMeta = normalizeRun({
      id: oldAlloc.id,
      origin: "code",
      title: "Old run",
      cwd: repo,
      dir: oldAlloc.dir,
      status: "exited",
      startedAt: oldTime.toISOString(),
      endedAt: oldTime.toISOString(),
      openedAt: oldTime.toISOString(),
      engine: "argy",
    })!;
    ctx.svc.store.saveRun(oldMeta);
    expect((await ctx.svc.loadRun(oldMeta.id)).restore).toBe("missing");
    await expect(ctx.svc.previewRunRestore(oldMeta.id)).rejects.toThrow("No before-and-after snapshot was saved for this run.");

    // Isolated task copy -> "in-copy" and no snapshot refs created for that run.
    const agent = ctx.svc.saveAgent({ name: "Copier", brief: "Work in copy.", engine: "argy", places: [repo] });
    const task = ctx.svc.saveTask({ title: "Copy task", agentId: agent.id, workspaceId: ws.id, isolated: true });
    const copyLaunched = started(await ctx.svc.executeTask(task.id));
    await ctx.exit(copyLaunched.ptyId);
    expect((await ctx.svc.loadRun(copyLaunched.runId)).restore).toBe("in-copy");
    expect(listVibeforgeRefs(repo)).not.toContain(snapshotRef(copyLaunched.runId, "start")!);
    await expect(ctx.svc.previewRunRestore(copyLaunched.runId)).rejects.toThrow("This run worked in a separate copy; use Discard on the copy instead.");

    // Tidying old runs removes their snapshot refs from the repository.
    const runMeta = ctx.svc.store.getRun(startedRun.runId)!;
    const ancient = new Date("2025-06-01T00:00:00Z").toISOString();
    ctx.svc.store.saveRun({ ...runMeta, startedAt: ancient, endedAt: ancient, openedAt: ancient });
    fs.utimesSync(runMeta.dir, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    ctx.svc.saveSettings({ keepRuns: { days: 30, maxMb: 0 } });
    const upkeep = await ctx.svc.maintainRuns();
    expect(upkeep.removed).toBeGreaterThanOrEqual(1);
    expect(listVibeforgeRefs(repo)).toEqual([]);

    // Sanity check: diffSince didn't break and availability helpers handle deleted folders.
    expect(await diffSince(repo, null)).toContain("by-agent");
    const goneDir = path.join(tempDir(), "does-not-exist");
    expect(getRunRestoreAvailability({ ...runMeta, cwd: goneDir }, ctx.dataRoot)).toBe("folder-gone");
    expect(await checkRunRestoreAvailability({ ...runMeta, cwd: goneDir }, ctx.dataRoot)).toBe("folder-gone");

    ctx.svc.close();
  });

  it("cleans up start refs when spawn fails or when a shell-typed blip run is dropped", async () => {
    const repo = initRepo({ "a.txt": "hello\n" });
    let failSpawn = true;
    const ctx = setup();
    const origSpawn = ctx.host.spawn;
    ctx.host.spawn = async (req) => {
      if (failSpawn) throw new Error("spawn failed");
      return origSpawn(req);
    };
    const ws = ctx.svc.addWorkspace(repo).workspaces[0];

    await expect(ctx.svc.startEngine({ workspaceId: ws.id, engineId: "argy" })).rejects.toThrow("Could not start");
    expect(listVibeforgeRefs(repo)).toEqual([]);

    // Shell-typed blip run (<5s, no changes) drops itself and deletes its refs.
    failSpawn = false;
    const shell = await ctx.svc.startShell({ workspaceId: ws.id });
    ctx.svc.onPtyProgram(shell.ptyId, ["argy", "--version"], repo);
    await until(() => ctx.svc.listRuns().some((r) => r.status === "running"));
    const blipId = ctx.svc.listRuns().find((r) => r.status === "running")!.id;
    expect(listVibeforgeRefs(repo)).toEqual([snapshotRef(blipId, "start")!]);
    ctx.svc.onPtyProgram(shell.ptyId, ["bash"], repo);
    await until(() => !ctx.svc.listRuns().some((r) => r.id === blipId));
    expect(listVibeforgeRefs(repo)).toEqual([]);

    // Verify RUN_FILES.snapshots is defined cleanly.
    expect(RUN_FILES.snapshots).toBe("snapshots.json");
    ctx.svc.close();
  });

  it("handles restore edge cases: edited-after-restore skipped by Undo, missing refs, wrong repo, and non-repo folders", async () => {
    const repo = initRepo({ "a.txt": "start\n", "sub/b.txt": "b\n" });
    const otherRepo = initRepo({ "a.txt": "other\n" });
    const runDir = tempDir("vf-snap-rundir-");
    const dataRoot = tempDir("vf-snap-data-");
    const meta = normalizeRun({
      id: "run-edge",
      origin: "code",
      title: "Edge",
      cwd: repo,
      dir: runDir,
      status: "exited",
      startedAt: "2026-11-28T10:00:00Z",
      endedAt: "2026-11-28T10:01:00Z",
      engine: "claude",
    })!;

    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    write(repo, "a.txt", "end\n");
    write(repo, "sub/b.txt", "b-end\n");
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });

    const { result, undoData } = await restoreRunFiles(meta, dataRoot);
    expect(result.restored.sort()).toEqual(["a.txt", "sub/b.txt"]);
    // Person edits a.txt right after restoring: Undo puts back only sub/b.txt and leaves a.txt untouched.
    write(repo, "a.txt", "edited-after-restore\n");
    const reverted = await applyUndoRestore(undoData!);
    expect(reverted).toEqual(["sub/b.txt"]);
    expect(read(repo, "a.txt")).toBe("edited-after-restore\n");
    expect(read(repo, "sub/b.txt")).toBe("b-end\n");

    // Wrong repo pointed to by run.cwd.
    await expect(previewRunRestore({ ...meta, cwd: otherRepo }, dataRoot)).rejects.toThrow("another repository");
    // Missing run / non-repo folder / missing ref.
    await expect(previewRunRestore(null, dataRoot)).rejects.toThrow("That run no longer exists.");
    const plain = tempDir("vf-snap-plain-");
    await expect(previewRunRestore({ ...meta, cwd: plain }, dataRoot)).rejects.toThrow("not a git repository");
    expect(getRunRestoreAvailability({ ...meta, cwd: plain, dir: tempDir() }, dataRoot)).toBe("not-repo");

    // Deleted git ref marks availability as "missing".
    git(repo, "update-ref", "-d", snapshotRef(meta.id, "end")!);
    expect(await checkRunRestoreAvailability(meta, dataRoot)).toBe("missing");
    await expect(previewRunRestore(meta, dataRoot)).rejects.toThrow("No before-and-after snapshot");
  });
});
