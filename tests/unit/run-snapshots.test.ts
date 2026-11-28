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
  sweepRunSnapshots,
  takeEndSnapshot,
  takeStartSnapshot,
  type NeighbourRun,
  type RunSnapshotsRecord,
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

function recordOf(runDir: string): RunSnapshotsRecord {
  return JSON.parse(fs.readFileSync(path.join(runDir, RUN_FILES.snapshots), "utf8")) as RunSnapshotsRecord;
}

/** The refs a run's snapshots live under, as its record names them. */
function refsFor(runId: string, runDir: string): { start: string; end: string } {
  const { nonce } = recordOf(runDir);
  return { start: snapshotRef(runId, "start", nonce)!, end: snapshotRef(runId, "end", nonce)! };
}

/** Preview, then confirm everything the preview offered, as the dialog does. */
async function restoreAll(meta: RunMeta, dataRoot: string, others: NeighbourRun[] = []) {
  const preview = await previewRunRestore(meta, dataRoot, others);
  return restoreRunFiles(meta, dataRoot, preview.restorable, others);
}

function runMeta(fields: Partial<RunMeta> & { id: string; cwd: string; dir: string }): RunMeta {
  return normalizeRun({
    origin: "code",
    title: fields.id,
    status: "exited",
    startedAt: "2026-11-28T10:00:00Z",
    endedAt: "2026-11-28T10:01:00Z",
    engine: "claude",
    ...fields,
  })!;
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
    expect(listVibeforgeRefs(repo).sort()).toEqual(
      [refsFor("run-clean", cleanDir).start, refsFor("run-dirty", runDir).end, refsFor("run-dirty", runDir).start].sort(),
    );
    expect(refsFor("run-dirty", runDir).start).toMatch(/^refs\/vibeforge\/runs\/run-dirty\/[0-9a-f]{16}\/start$/);

    // commitDays ignores refs/vibeforge/* even if a snapshot commit has the same author email.
    const days = await commitDays(repo, "2020-01-01");
    expect(days.map((d) => d.hash)).toEqual([headSha]);
    const synthTree = git(repo, "rev-parse", `${refsFor("run-dirty", runDir).end}^{tree}`);
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
    expect(preview.restorable.map(({ path: file, action }) => ({ path: file, action }))).toEqual(
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

    const { result, undoData } = await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable);
    expect(result.restored.sort()).toEqual(["a.txt", "clash", "clash/inside.txt", "del.txt", "exec.sh", "only/created.txt"]);
    expect(result.deleted.sort()).toEqual(["clash/inside.txt", "only/created.txt"]);
    expect(result.leftAlone).toEqual([
      { path: "keep.txt", reason: "changed" },
      { path: "new/edited-later.txt", reason: "changed" },
    ]);

    expect(read(repo, "a.txt")).toBe("before-a\n");
    expect(read(repo, "del.txt")).toBe("before-del\n");
    expect(fs.statSync(path.join(repo, "exec.sh")).mode & 0o111).toBe(0);
    // Folders are never removed: an empty one the run made stays.
    expect(fs.existsSync(path.join(repo, "only/created.txt"))).toBe(false);
    expect(fs.statSync(path.join(repo, "only")).isDirectory()).toBe(true);
    expect(read(repo, "clash")).toBe("was-a-file\n");
    expect(read(repo, "keep.txt")).toBe("user-after-run\n");
    expect(read(repo, "new/edited-later.txt")).toBe("user-edited-new-file\n");
    expect(read(repo, "ignored.log")).toBe("ignored-2\n");

    // Undo puts the run's end state back for ONLY those restored files (and leaves post-run edits alone).
    expect(undoData).not.toBeNull();
    const undone = await applyUndoRestore(undoData!);
    expect(undone.reverted.sort()).toEqual(["a.txt", "clash", "clash/inside.txt", "del.txt", "exec.sh", "only/created.txt"]);
    expect(undone.leftAlone).toEqual([]);
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
    expect(preview.restorable).toEqual([{ path: "small.txt", action: "restore", expect: expect.stringMatching(/^100644:[0-9a-f]{40}$/) }]);
    expect(preview.leftAlone).toEqual([
      { path: "pre-big.bin", reason: "oversized" },
      { path: "run-big.bin", reason: "oversized" },
    ]);

    await restoreAll(meta, tempDir("vf-data-"));
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
    await restoreAll(meta, tempDir("vf-data-"));
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
    const startedDir = ctx.svc.store.getRun(startedRun.runId)!.dir;
    expect(listVibeforgeRefs(repo)).toEqual([refsFor(startedRun.runId, startedDir).start]);
    await expect(ctx.svc.previewRunRestore(startedRun.runId)).rejects.toThrow("Wait until this run finishes before putting files back.");

    // Simulate run editing a file and creating another, then exiting.
    write(repo, "app.txt", "by-agent\n");
    write(repo, "added.txt", "hello\n");
    await ctx.exit(startedRun.ptyId);

    const bundle = await ctx.svc.loadRun(startedRun.runId);
    expect(bundle.restore).toBe("ready");
    expect(listVibeforgeRefs(repo).sort()).toEqual([refsFor(startedRun.runId, startedDir).end, refsFor(startedRun.runId, startedDir).start]);

    const preview = await ctx.svc.previewRunRestore(startedRun.runId);
    expect(preview).toMatchObject({ overlapping: [], lateEnd: false });
    const restored = await ctx.svc.restoreRun(startedRun.runId, preview.restorable);
    expect(restored.restored.sort()).toEqual(["added.txt", "app.txt"]);
    expect(restored.undo).toEqual(expect.any(String));
    expect(read(repo, "app.txt")).toBe("initial\n");
    expect(fs.existsSync(path.join(repo, "added.txt"))).toBe(false);

    // Undo puts the run's changes back.
    expect(await ctx.svc.undoRunRestore(restored.undo!)).toEqual({ reverted: expect.arrayContaining(["added.txt", "app.txt"]), leftAlone: [] });
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
    expect(listVibeforgeRefs(repo).some((ref) => ref.includes(copyLaunched.runId))).toBe(false);
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
    expect(listVibeforgeRefs(repo)).toEqual([refsFor(blipId, ctx.svc.store.getRun(blipId)!.dir).start]);
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

    const { result, undoData } = await restoreAll(meta, dataRoot);
    expect(result.restored.sort()).toEqual(["a.txt", "sub/b.txt"]);
    // Person edits a.txt right after restoring: Undo puts back only sub/b.txt, leaves a.txt untouched, and says so.
    write(repo, "a.txt", "edited-after-restore\n");
    expect(await applyUndoRestore(undoData!)).toEqual({ reverted: ["sub/b.txt"], leftAlone: ["a.txt"] });
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
    git(repo, "update-ref", "-d", refsFor(meta.id, runDir).end);
    expect(await checkRunRestoreAvailability(meta, dataRoot)).toBe("missing");
    await expect(previewRunRestore(meta, dataRoot)).rejects.toThrow("No before-and-after snapshot");
  });
});

describe("put files back: only this run's folder, only what was shown", () => {
  it("puts back only files under the run's own folder, never the rest of the repository", async () => {
    const repo = initRepo({ "sub/mine.txt": "before\n", "other/theirs.txt": "before\n", "top.txt": "before\n" });
    const runDir = tempDir("vf-snap-rundir-");
    const cwd = path.join(repo, "sub");
    const meta = runMeta({ id: "run-scope", cwd, dir: runDir });
    await takeStartSnapshot({ cwd, runId: meta.id, runDir });
    write(repo, "sub/mine.txt", "run\n");
    write(repo, "sub/new.txt", "run\n");
    write(repo, "other/theirs.txt", "elsewhere\n");
    write(repo, "top.txt", "elsewhere\n");
    await takeEndSnapshot({ cwd, runId: meta.id, runDir });

    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.restorable.map((item) => item.path).sort()).toEqual(["sub/mine.txt", "sub/new.txt"]);
    expect(preview.leftAlone).toEqual([]);
    await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable);
    expect(read(repo, "sub/mine.txt")).toBe("before\n");
    expect(fs.existsSync(path.join(repo, "sub/new.txt"))).toBe(false);
    expect(read(repo, "other/theirs.txt")).toBe("elsewhere\n");
    expect(read(repo, "top.txt")).toBe("elsewhere\n");
  });

  it("names runs that overlapped in the same repository, and refuses while one is going there", async () => {
    const repo = initRepo({ "a.txt": "before\n" });
    const elsewhere = initRepo({ "b.txt": "x\n" });
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-main", cwd: repo, dir: runDir, startedAt: "2026-11-28T10:00:00Z", endedAt: "2026-11-28T11:00:00Z" });
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    write(repo, "a.txt", "after\n");
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });
    const dataRoot = tempDir("vf-data-");
    const other = (fields: Partial<NeighbourRun>): NeighbourRun => ({
      id: "x",
      title: "x",
      cwd: repo,
      dir: tempDir("vf-snap-other-"),
      status: "exited",
      startedAt: "2026-11-28T10:30:00Z",
      endedAt: "2026-11-28T10:40:00Z",
      ...fields,
    });
    const others = [
      other({ id: "overlap", title: "Codex · app" }),
      other({ id: "before", title: "Earlier", startedAt: "2026-11-28T08:00:00Z", endedAt: "2026-11-28T09:00:00Z" }),
      other({ id: "elsewhere", title: "Other repo", cwd: elsewhere }),
      other({ id: "run-main", title: "itself" }),
    ];
    const preview = await previewRunRestore(meta, dataRoot, others);
    expect(preview.overlapping).toEqual([{ id: "overlap", title: "Codex · app" }]);

    const going = [...others, other({ id: "live", title: "Claude · app", status: "running", startedAt: "2026-11-28T12:00:00Z", endedAt: null })];
    await expect(previewRunRestore(meta, dataRoot, going)).rejects.toThrow("Another run is still going in this repository: Claude · app. Put files back once it has ended.");
    await expect(restoreRunFiles(meta, dataRoot, preview.restorable, going)).rejects.toThrow("Another run is still going in this repository");
    expect(read(repo, "a.txt")).toBe("after\n");
  });

  it("applies exactly what the preview showed: anything that changed since is left alone and listed", async () => {
    const repo = initRepo({ "a.txt": "a0\n", "b.txt": "b0\n", "c.txt": "c0\n" });
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-picks", cwd: repo, dir: runDir });
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    write(repo, "a.txt", "a1\n");
    write(repo, "b.txt", "b1\n");
    write(repo, "c.txt", "c1\n");
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });
    // c.txt was edited after the run, so the preview leaves it alone.
    write(repo, "c.txt", "person\n");
    const dataRoot = tempDir("vf-data-");
    const preview = await previewRunRestore(meta, dataRoot);
    expect(preview.restorable.map((item) => item.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(preview.leftAlone).toEqual([{ path: "c.txt", reason: "changed" }]);

    // Before confirming: c.txt goes back to the run's version (never shown as restorable), and b.txt changes.
    write(repo, "c.txt", "c1\n");
    write(repo, "b.txt", "person\n");
    const { result } = await restoreRunFiles(meta, dataRoot, preview.restorable);
    expect(result.restored).toEqual(["a.txt"]);
    expect(result.leftAlone).toEqual(expect.arrayContaining([{ path: "b.txt", reason: "changed" }, { path: "c.txt", reason: "changed" }]));
    expect(read(repo, "a.txt")).toBe("a0\n");
    expect(read(repo, "b.txt")).toBe("person\n");
    expect(read(repo, "c.txt")).toBe("c1\n");
    // Nothing confirmed: nothing changes.
    write(repo, "a.txt", "a1\n");
    expect((await restoreRunFiles(meta, dataRoot, [])).result.restored).toEqual([]);
    expect(read(repo, "a.txt")).toBe("a1\n");
  });
});

describe("snapshot cost and tidying", () => {
  it("skips the snapshot when the folder has too many new files, too much new content, or no time left", async () => {
    const repo = initRepo({ "a.txt": "a\n" });
    for (let i = 0; i < 6; i += 1) write(repo, `new-${i}.txt`, "x".repeat(100));
    const warnings: string[] = [];
    const onWarn = (message: string) => warnings.push(message);
    expect(await takeStartSnapshot({ cwd: repo, runId: "run-many", runDir: tempDir(), maxNewFiles: 5, onWarn })).toBeNull();
    expect(warnings.at(-1)).toMatch(/so it has no undo: there are 6 new files, more than 5/);
    write(repo, "a.txt", "y".repeat(2 * 1024 * 1024));
    expect(await takeStartSnapshot({ cwd: repo, runId: "run-big", runDir: tempDir(), maxNewBytes: 1024 * 1024, onWarn })).toBeNull();
    expect(warnings.at(-1)).toMatch(/there are 3 MB of new or changed files, more than 1 MB/);
    expect(await takeStartSnapshot({ cwd: repo, runId: "run-slow", runDir: tempDir(), budgetMs: 1, onWarn })).toBeNull();
    expect(warnings.at(-1)).toMatch(/it took too long/);
    expect(listVibeforgeRefs(repo)).toEqual([]);
    // Within limits it is saved, and quickly.
    const began = Date.now();
    expect(await takeStartSnapshot({ cwd: repo, runId: "run-ok", runDir: tempDir(), onWarn })).not.toBeNull();
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("removes refs whose run is gone or older than 30 days, keeping live runs and other machines' recent ones", async () => {
    const repo = initRepo({ "a.txt": "a\n" });
    const dataRoot = tempDir("vf-data-");
    const runs = new Map<string, RunMeta>();
    const make = async (id: string, fields: Partial<RunMeta> = {}) => {
      const dir = path.join(dataRoot, "runs", id);
      fs.mkdirSync(dir, { recursive: true });
      await takeStartSnapshot({ cwd: repo, runId: id, runDir: dir, dataRoot });
      const meta = runMeta({ id, cwd: repo, dir, startedAt: "2026-11-27T10:00:00Z", ...fields });
      runs.set(id, meta);
      return meta;
    };
    const kept = await make("2026-11-27T100000Z_kept");
    const live = await make("2025-01-01T000000Z_live", { status: "running", startedAt: "2025-01-01T00:00:00Z" });
    const old = await make("2026-10-01T000000Z_old", { startedAt: "2026-10-01T00:00:00Z" });
    const gone = await make("2026-11-27T110000Z_gone");
    runs.delete(gone.id);
    fs.rmSync(gone.dir, { recursive: true, force: true });
    // A run folder that is still being set up (no index row yet) keeps its ref.
    const settingUp = await make("2026-11-27T120000Z_setting-up");
    runs.delete(settingUp.id);
    // Another machine's refs (Sync shares .git): kept while recent, removed once old.
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/vibeforge/runs/2026-11-27T100000Z_theirs/ffffffff00000000/start", head);
    git(repo, "update-ref", "refs/vibeforge/runs/2026-09-01T100000Z_theirs-old/ffffffff00000000/start", head);
    expect(listVibeforgeRefs(repo)).toHaveLength(7);

    const removed = await sweepRunSnapshots({ dataRoot, getRun: (id) => runs.get(id) ?? null, now: new Date("2026-11-28T12:00:00Z") });
    expect(removed).toBe(3);
    expect(listVibeforgeRefs(repo).sort()).toEqual(
      [
        refsFor(kept.id, kept.dir).start,
        refsFor(live.id, live.dir).start,
        refsFor(settingUp.id, settingUp.dir).start,
        "refs/vibeforge/runs/2026-11-27T100000Z_theirs/ffffffff00000000/start",
      ].sort(),
    );
    expect(listVibeforgeRefs(repo).some((ref) => ref.includes(old.id))).toBe(false);
    // Each VibeForge marks its own nonces; two runs never share one.
    expect(recordOf(kept.dir).nonce!.slice(0, 8)).toBe(recordOf(settingUp.dir).nonce!.slice(0, 8));
    expect(recordOf(kept.dir).nonce).not.toBe(recordOf(settingUp.dir).nonce);
    // A repository with nothing left drops off the list.
    for (const ref of listVibeforgeRefs(repo)) git(repo, "update-ref", "-d", ref);
    await sweepRunSnapshots({ dataRoot, getRun: () => null, now: new Date("2026-11-28T12:00:00Z") });
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, "run-snapshots.json"), "utf8")).repos).toEqual([]);
  });

  it("never runs clean or smudge filters, stores raw bytes, and leaves files under a filter alone", async () => {
    const marker = path.join(tempDir("vf-snap-marker-"), "ran");
    const repo = initRepo({ ".gitattributes": "*.lfs filter=boom\n", "big.lfs": "pointer\n", "crlf.txt": "one\r\ntwo\r\n" });
    git(repo, "config", "filter.boom.clean", `sh -c 'ps -o args= $PPID >> ${marker}; cat'`);
    git(repo, "config", "filter.boom.smudge", `sh -c 'touch ${marker}; cat'`);
    fs.rmSync(marker, { force: true });
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-raw", cwd: repo, dir: runDir });
    write(repo, "new.lfs", "fresh\n");
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    write(repo, "big.lfs", "changed by run\n");
    write(repo, "crlf.txt", "one\r\ntwo\r\nthree\r\n");
    fs.rmSync(path.join(repo, "new.lfs"));
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });
    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.restorable.map((item) => item.path)).toEqual(["crlf.txt"]);
    expect(preview.leftAlone).toEqual(expect.arrayContaining([{ path: "big.lfs", reason: "filtered" }, { path: "new.lfs", reason: "filtered" }]));
    await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable);
    expect(fs.readFileSync(path.join(repo, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
    expect(read(repo, "big.lfs")).toBe("changed by run\n");
    expect(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "").toBe("");

    // .git/info/attributes can't be switched off, so such a repository gets no snapshot.
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "*.txt filter=boom\n");
    const warnings: string[] = [];
    expect(await takeStartSnapshot({ cwd: repo, runId: "run-info", runDir: tempDir(), onWarn: (w) => warnings.push(w) })).toBeNull();
    expect(warnings[0]).toMatch(/info\/attributes/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("put files back: odd shapes", () => {
  it("puts a folder back that the run swapped for a link, without writing through the link", async () => {
    const repo = initRepo({ "d/a.txt": "inside\n" });
    const target = tempDir("vf-snap-target-");
    write(target, "a.txt", "outside, must stay\n");
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-link", cwd: repo, dir: runDir });
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    fs.rmSync(path.join(repo, "d"), { recursive: true });
    fs.symlinkSync(target, path.join(repo, "d"));
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });

    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.restorable.map(({ path: file, action }) => ({ path: file, action })).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "d", action: "delete" },
      { path: "d/a.txt", action: "recreate" },
    ]);
    const { result, undoData } = await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable);
    expect(result.leftAlone).toEqual([]);
    expect(fs.lstatSync(path.join(repo, "d")).isDirectory()).toBe(true);
    expect(read(repo, "d/a.txt")).toBe("inside\n");
    expect(read(target, "a.txt")).toBe("outside, must stay\n");
    // And Undo makes it the link again.
    expect((await applyUndoRestore(undoData!)).leftAlone).toEqual([]);
    expect(fs.lstatSync(path.join(repo, "d")).isSymbolicLink()).toBe(true);
    expect(read(target, "a.txt")).toBe("outside, must stay\n");
  });

  it("never writes through a link when the link itself can't go first", async () => {
    const repo = initRepo({ "d/a.txt": "inside\n" });
    const target = tempDir("vf-snap-target-");
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-link-2", cwd: repo, dir: runDir });
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir });
    fs.rmSync(path.join(repo, "d"), { recursive: true });
    fs.symlinkSync(target, path.join(repo, "d"));
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir });
    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    // Only the file is confirmed; the link stays, so the file can't come back.
    const { result } = await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable.filter((item) => item.path === "d/a.txt"));
    expect(result.restored).toEqual([]);
    expect(fs.existsSync(path.join(target, "a.txt"))).toBe(false);
  });

  it("labels submodule changes as not supported, keeps folders that were there, and lists oversized files it can't bring back", async () => {
    const sub = initRepo({ "s.txt": "s\n" });
    const repo = initRepo({ "a.txt": "a\n" });
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
    git(repo, "commit", "-qm", "add submodule");
    fs.mkdirSync(path.join(repo, "empty-before"));
    write(repo, "huge.bin", Buffer.alloc(200, 1));
    const runDir = tempDir("vf-snap-rundir-");
    const meta = runMeta({ id: "run-odd", cwd: repo, dir: runDir });
    await takeStartSnapshot({ cwd: repo, runId: meta.id, runDir, maxNewFileBytes: 50 });
    write(path.join(repo, "mod"), "s.txt", "moved\n");
    git(path.join(repo, "mod"), "commit", "-qam", "move");
    write(repo, "empty-before/new.txt", "run\n");
    fs.rmSync(path.join(repo, "huge.bin"));
    await takeEndSnapshot({ cwd: repo, runId: meta.id, runDir, maxNewFileBytes: 50 });

    const preview = await previewRunRestore(meta, tempDir("vf-data-"));
    expect(preview.leftAlone).toEqual(expect.arrayContaining([{ path: "mod", reason: "submodule" }, { path: "huge.bin", reason: "oversized" }]));
    expect(preview.restorable.map((item) => item.path)).toEqual(["empty-before/new.txt"]);
    await restoreRunFiles(meta, tempDir("vf-data-"), preview.restorable);
    expect(fs.existsSync(path.join(repo, "empty-before/new.txt"))).toBe(false);
    expect(fs.statSync(path.join(repo, "empty-before")).isDirectory()).toBe(true);
  });
});

describe("runs cut off by a close keep their undo", () => {
  it("takes the end snapshot at the next start for a run a quit or a crash cut off", async () => {
    const repo = initRepo({ "app.txt": "initial\n" });
    const first = setup({ now: () => new Date("2026-11-28T12:00:00Z") });
    first.host.gitHead = (cwd) => gitHead(cwd);
    first.host.snapshotGit = (cwd, startHead) => snapshotGit(cwd, 5000, startHead);
    const ws = first.svc.addWorkspace(repo).workspaces[0];
    const quit = await first.svc.startEngine({ workspaceId: ws.id, engineId: "argy" });
    write(repo, "app.txt", "by-agent\n");
    // A quit whose terminals never reported their exit: recorded as stopped, no end snapshot yet.
    first.svc.prepareShutdown("quit");
    first.svc.shutdown();
    expect(first.svc.store.getRun(quit.runId)?.cutOff).toBe("quit");
    first.svc.close();

    const next = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot, now: () => new Date("2026-11-28T12:05:00Z") });
    next.host.gitHead = (cwd) => gitHead(cwd);
    next.host.snapshotGit = (cwd, startHead) => snapshotGit(cwd, 5000, startHead);
    await next.svc.whenSettled();
    await next.svc.lateSnapshots;
    expect((await next.svc.loadRun(quit.runId)).restore).toBe("ready");
    const preview = await next.svc.previewRunRestore(quit.runId);
    expect(preview.lateEnd).toBe(true);
    expect(preview.restorable.map((item) => item.path)).toEqual(["app.txt"]);

    // A crash: the run is still "running" in the index at the next start.
    const crashed = await next.svc.startEngine({ workspaceId: ws.id, engineId: "argy" });
    write(repo, "app.txt", "by-second-agent\n");
    next.svc.close();
    const third = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot, now: () => new Date("2026-11-28T12:10:00Z") });
    third.host.gitHead = (cwd) => gitHead(cwd);
    third.host.snapshotGit = (cwd, startHead) => snapshotGit(cwd, 5000, startHead);
    await third.svc.whenSettled();
    await third.svc.lateSnapshots;
    const run = third.svc.store.getRun(crashed.runId)!;
    expect(run).toMatchObject({ status: "stopped", cutOff: "crash" });
    expect(listVibeforgeRefs(repo).filter((ref) => ref.includes(crashed.runId))).toHaveLength(2);
    const crashPreview = await third.svc.previewRunRestore(crashed.runId);
    expect(crashPreview).toMatchObject({ lateEnd: true, overlapping: [] });
    const { restored } = await third.svc.restoreRun(crashed.runId, crashPreview.restorable);
    expect(restored).toEqual(["app.txt"]);
    expect(read(repo, "app.txt")).toBe("by-agent\n");
    third.svc.close();
  });
});
