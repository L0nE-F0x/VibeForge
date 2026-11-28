import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COPY_START_SCRIPT, cleanCopyFolderPath, matchesCopyPatterns, normalizeCopySetup, parseWorktreeInclude, wrapForCopy } from "../../src/core/copy-setup.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import { Store } from "../../src/core/store.js";
import { updateWorkspaceRecord } from "../../src/core/workspaces.js";
import { applyToWorkspace, copyBranch, copyPatch, leftInCopy, prepareCopy, removeCopy } from "../../src/core/worktrees.js";
import { setup as setupService, started } from "./fixtures/service-harness.js";

const dirs: string[] = [];

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-cs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe("copy setup patterns and .worktreeinclude parsing", () => {
  it("parses .worktreeinclude skipping comments, blank lines, and unescaped trailing spaces", () => {
    const parsed = parseWorktreeInclude(
      [
        "# comment",
        "",
        "  ",
        ".env*   ",
        "path\\ with\\ space\\ ",
        "\\#literal-hash",
        "\\!literal-bang",
        "secrets/",
        "!secrets/example.env",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      ".env*",
      "path\\ with\\ space\\ ",
      "\\#literal-hash",
      "\\!literal-bang",
      "secrets/",
      "!secrets/example.env",
    ]);
  });

  it("evaluates gitignore-style patterns including rooting, negation, globs, and directories", () => {
    const patterns = [".env*", "secrets/", "!secrets/example.env", "/root-only.txt", "apps/**/*.local", "**/cert.pem"];
    expect(matchesCopyPatterns(".env", patterns)).toBe(true);
    expect(matchesCopyPatterns("packages/web/.env.local", patterns)).toBe(true);
    expect(matchesCopyPatterns("secrets/api.key", patterns)).toBe(true);
    expect(matchesCopyPatterns("secrets/example.env", patterns)).toBe(false);
    expect(matchesCopyPatterns("root-only.txt", patterns)).toBe(true);
    expect(matchesCopyPatterns("nested/root-only.txt", patterns)).toBe(false);
    expect(matchesCopyPatterns("apps/web/sub/dev.local", patterns)).toBe(true);
    expect(matchesCopyPatterns("a/b/cert.pem", patterns)).toBe(true);
  });

  it("normalizes folder paths and rejects traversal or git internals", async () => {
    expect(cleanCopyFolderPath("./node_modules/")).toBe("node_modules");
    expect(cleanCopyFolderPath("packages/web/node_modules")).toBe("packages/web/node_modules");
    expect(cleanCopyFolderPath("../outside")).toBeNull();
    expect(cleanCopyFolderPath("/etc/passwd")).toBeNull();
    expect(cleanCopyFolderPath(".git")).toBeNull();
    expect(cleanCopyFolderPath(".git/hooks")).toBeNull();
    expect(cleanCopyFolderPath("a/../b")).toBeNull();

    expect(normalizeCopySetup({ files: [".env*"] })).toBeUndefined();
    expect(normalizeCopySetup({ files: [] })).toEqual({ files: [] });
    expect(normalizeCopySetup({ files: [".env*"], folders: ["./node_modules/", "../bad"], setupCommand: "  pnpm dev  " })).toEqual({
      folders: ["node_modules"],
      setupCommand: "pnpm dev",
    });

    const { otherStepKey } = await import("../../src/ui/views/orchestrator/shared.js");
    expect(otherStepKey({
      id: "s1",
      kind: "workspace",
      action: "copy-setup",
      engineId: "",
      workspaceId: "ws1",
      branch: "",
      prompt: "",
      target: "ws1",
      asked: "",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    })).toBe("orch.workspaceCopySetup");
  });

  it("wraps argv with a visible setup command keeping vibeforge-setup marker in argv[3]", () => {
    const words = { failed: "Setup failed ({code})" };
    expect(wrapForCopy(["/usr/bin/claude", "hi"], { setupCommand: "  ", words })).toEqual(["/usr/bin/claude", "hi"]);

    const wrapped = wrapForCopy(["/usr/bin/claude", "hi"], { setupCommand: "npm run build", words, userShell: "/bin/bash" });
    expect(wrapped[1]).toBe("-c");
    expect(wrapped[2]).toBe(COPY_START_SCRIPT);
    expect(wrapped[3]).toBe("vibeforge-setup");
    expect(wrapped[4]).toBe("npm run build");
    expect(wrapped[5]).toBe("/bin/bash");
    expect(wrapped[6]).toBe("Setup failed (%s)");
    expect(wrapped[7]).toBe("");
    expect(wrapped.slice(8)).toEqual(["/usr/bin/claude", "hi"]);

    // Notes alone still go through the wrapper, so the terminal shows them before the CLI starts.
    const noted = wrapForCopy(["/usr/bin/claude"], { notes: ["Left out .env\u001b[2J: x"], words });
    expect(noted[4]).toBe("");
    expect(noted[7]).toBe("Left out .env[2J: x");
  });

  it("runs the setup command, then the CLI, and stops with a plain message when the command fails", () => {
    const words = { failed: "Setup failed (exit {code}), 100% \\ sure" };
    const ok = wrapForCopy(["/bin/echo", "CLI-RAN"], { setupCommand: "echo prep", words, userShell: "/bin/sh" });
    const good = spawnSync(ok[0], ok.slice(1), { encoding: "utf8" });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("$ echo prep");
    expect(good.stdout.indexOf("prep\n")).toBeLessThan(good.stdout.indexOf("CLI-RAN"));

    const failing = wrapForCopy(["/bin/echo", "CLI-RAN"], { setupCommand: "exit 7", notes: ["Could not copy .env: EACCES"], words, userShell: "/bin/sh" });
    const bad = spawnSync(failing[0], failing.slice(1), { encoding: "utf8" });
    expect(bad.status).toBe(7);
    expect(bad.stdout).toContain("Could not copy .env: EACCES");
    expect(bad.stdout).toContain("Setup failed (exit 7), 100% \\ sure");
    expect(bad.stdout).not.toContain("CLI-RAN");
  });

});

describe("prepareCopy, symlink safety, folder cloning, and leftInCopy exclusion", () => {
  it("copies default .env* and .worktreeinclude ignored files, skips non-ignored files, clones node_modules, and keeps Apply tidy", async () => {
    const repo = temp();
    const outside = temp();
    write(outside, "secret.txt", "outside secret\n");
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".env*\nsecrets/\nnode_modules/\nnotes/\n");
    write(repo, ".worktreeinclude", "# Secrets for local runs\nsecrets/\n!secrets/skip.txt\ntracked.txt\n");
    write(repo, "tracked.txt", "hello\n");
    write(repo, "packages/app/tracked.js", "export const x = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    // Ignored files matching defaults and .worktreeinclude:
    write(repo, ".env", "API_KEY=root\n");
    write(repo, "packages/app/.env.local", "PORT=3000\n");
    write(repo, "secrets/token.key", "tok\n");
    write(repo, "secrets/skip.txt", "do not copy\n");
    // Untracked but NOT git-ignored file (even if named in .worktreeinclude? Wait: untracked non-ignored must not be copied):
    write(repo, "untracked-unignored.env", "nope\n");
    // Uncommitted change in tracked file must not leak:
    write(repo, "tracked.txt", "dirty workspace edit\n");

    // node_modules with real file, internal relative bin symlink, and an outside symlink:
    write(repo, "node_modules/pkg/bin.js", "console.log('ok');\n");
    fs.mkdirSync(path.join(repo, "node_modules/.bin"), { recursive: true });
    fs.symlinkSync("../pkg/bin.js", path.join(repo, "node_modules/.bin/pkg"));
    // A link back into the main folder: an agent in the copy would be editing the workspace itself.
    fs.symlinkSync(path.join(repo, "tracked.txt"), path.join(repo, "node_modules/evil-link"));
    // File symlink pointing outside project folder:
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, ".env.outside"));
    // File symlink staying inside project folder:
    fs.symlinkSync(".env", path.join(repo, ".env.link"));

    const dataRoot = temp();
    const target = path.join(dataRoot, "worktrees", "task-1");
    const { copy, setupCommand } = await prepareCopy({
      folder: repo,
      target,
      branch: copyBranch("task-1"),
      copySetup: { folders: ["node_modules", "../outside-attempt", "missing-folder"], setupCommand: "pnpm test:prep" },
    });

    expect(setupCommand).toBe("pnpm test:prep");
    expect(fs.readFileSync(path.join(copy.path, ".env"), "utf8")).toBe("API_KEY=root\n");
    expect(fs.readFileSync(path.join(copy.path, "packages/app/.env.local"), "utf8")).toBe("PORT=3000\n");
    expect(fs.readFileSync(path.join(copy.path, "secrets/token.key"), "utf8")).toBe("tok\n");
    expect(fs.existsSync(path.join(copy.path, "secrets/skip.txt"))).toBe(false);
    expect(fs.existsSync(path.join(copy.path, "untracked-unignored.env"))).toBe(false);
    expect(fs.existsSync(path.join(copy.path, ".env.outside"))).toBe(false);
    expect(fs.lstatSync(path.join(copy.path, ".env.link")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(copy.path, ".env.link"), "utf8")).toBe("API_KEY=root\n");
    expect(fs.readFileSync(path.join(copy.path, "tracked.txt"), "utf8")).toBe("hello\n");

    // node_modules cloned, internal bin symlink kept, the link into the main folder pruned:
    expect(fs.readFileSync(path.join(copy.path, "node_modules/pkg/bin.js"), "utf8")).toContain("ok");
    expect(fs.lstatSync(path.join(copy.path, "node_modules/.bin/pkg")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(copy.path, "node_modules/evil-link"))).toBe(false);

    // None of what setup brought in shows up in leftInCopy:
    expect(copy.seeded).toEqual(expect.arrayContaining([".env", "packages/app/.env.local", "secrets/token.key", "node_modules/"]));
    expect(await leftInCopy(copy)).toEqual([]);

    // A new ignored file created by the agent inside `secrets/` or `notes/` IS still caught:
    write(copy.path, "secrets/agent-made.key", "new secret\n");
    write(copy.path, "notes/todo.md", "notes\n");
    expect((await leftInCopy(copy)).sort()).toEqual(["notes/", "secrets/agent-made.key"]);

    // Removing the extra agent-created ignored files leaves leftInCopy empty so Apply + removeCopy tidy cleanly:
    fs.rmSync(path.join(copy.path, "secrets/agent-made.key"));
    fs.rmSync(path.join(copy.path, "notes"), { recursive: true });
    write(copy.path, "packages/app/tracked.js", "export const x = 2;\n");
    const owner = { dataRoot, taskId: "task-1" };
    const patch = await copyPatch(copy, owner);
    const applied = await applyToWorkspace(copy, patch);
    expect(applied.conflicts).toEqual([]);
    expect(applied.files).toEqual(["packages/app/tracked.js"]);
    expect(await leftInCopy(copy)).toEqual([]);
    expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe("API_KEY=root\n");
    await removeCopy(copy, owner);
    expect(fs.existsSync(copy.path)).toBe(false);
  });

  it("skips a symlink directory matching .worktreeinclude when it points outside the repo", async () => {
    const repo = temp();
    const outside = temp();
    write(outside, "leak.txt", "secret\n");
    git(repo, "init", "-q");
    write(repo, ".gitignore", "secrets/\n");
    write(repo, ".worktreeinclude", "secrets/\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    fs.symlinkSync(outside, path.join(repo, "secrets"));
    const dataRoot = temp();
    const { copy } = await prepareCopy({
      folder: repo,
      target: path.join(dataRoot, "worktrees", "task-sym"),
      branch: copyBranch("task-sym"),
    });
    expect(fs.existsSync(path.join(copy.path, "secrets"))).toBe(false);
    expect(copy.seeded).toBeUndefined();
  });

  it("respects explicit files: [] by skipping default .env* while still copying .worktreeinclude entries", async () => {
    const repo = temp();
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".env*\nlocal.conf\n");
    write(repo, ".worktreeinclude", "local.conf\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write(repo, ".env", "SKIP=1\n");
    write(repo, "local.conf", "KEEP=1\n");

    const dataRoot = temp();
    const { copy } = await prepareCopy({
      folder: repo,
      target: path.join(dataRoot, "worktrees", "task-empty-files"),
      branch: copyBranch("task-empty-files"),
      copySetup: { files: [] },
    });
    expect(fs.existsSync(path.join(copy.path, ".env"))).toBe(false);
    expect(fs.readFileSync(path.join(copy.path, "local.conf"), "utf8")).toBe("KEEP=1\n");
  });

  it("keeps the copy and goes on when a file or folder can't be brought in, saying what was left out", async () => {
    const repo = temp();
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".env*\nnode_modules/\nvendor/\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write(repo, ".env", "LOCKED=1\n");
    write(repo, ".env.local", "OPEN=1\n");
    write(repo, "vendor/ok.txt", "ok\n");
    write(repo, "node_modules/pkg/locked.js", "x\n");
    fs.chmodSync(path.join(repo, ".env"), 0o000);
    fs.chmodSync(path.join(repo, "node_modules/pkg/locked.js"), 0o000);
    try {
      const dataRoot = temp();
      const recorded: Array<{ seeded?: string[] }> = [];
      const { copy, warnings } = await prepareCopy({
        folder: repo,
        target: path.join(dataRoot, "worktrees", "task-locked"),
        branch: copyBranch("task-locked"),
        copySetup: { folders: ["node_modules", "vendor"] },
        record: (made) => recorded.push({ ...made }),
      });
      // Recorded before anything was brought in, then again with what was.
      expect(recorded).toHaveLength(2);
      expect(recorded[0].seeded).toBeUndefined();
      expect(recorded[1].seeded).toEqual(copy.seeded);
      expect(fs.readFileSync(path.join(copy.path, ".env.local"), "utf8")).toBe("OPEN=1\n");
      expect(fs.readFileSync(path.join(copy.path, "vendor/ok.txt"), "utf8")).toBe("ok\n");
      expect(fs.existsSync(path.join(copy.path, ".env"))).toBe(false);
      // A half-made clone is taken away again.
      expect(fs.existsSync(path.join(copy.path, "node_modules"))).toBe(false);
      expect(copy.seeded).toEqual(expect.arrayContaining(["vendor/", ".env.local"]));
      expect(copy.seeded).not.toContain(".env");
      expect(warnings).toContain("Could not copy .env: EACCES");
      expect(warnings.some((line) => line.startsWith("Could not copy folder node_modules: "))).toBe(true);
    } finally {
      fs.chmodSync(path.join(repo, ".env"), 0o644);
      fs.chmodSync(path.join(repo, "node_modules/pkg/locked.js"), 0o644);
    }
  });

  it("leaves out what the copy's own .gitignore doesn't ignore, so it never reaches the diff", async () => {
    const repo = temp();
    git(repo, "init", "-q");
    write(repo, ".gitignore", "dist/\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    // Ignored in the main folder only: the rules aren't committed.
    write(repo, ".gitignore", "dist/\n.env\nlocal/\n");
    write(repo, ".env", "SECRET=1\n");
    write(repo, "local/cache.txt", "c\n");

    const dataRoot = temp();
    const owner = { dataRoot, taskId: "task-ign" };
    const { copy, warnings } = await prepareCopy({
      folder: repo,
      target: path.join(dataRoot, "worktrees", "task-ign"),
      branch: copyBranch("task-ign"),
      copySetup: { folders: ["local"] },
    });
    expect(fs.existsSync(path.join(copy.path, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(copy.path, "local"))).toBe(false);
    expect(copy.seeded).toBeUndefined();
    expect(warnings).toEqual([
      "Left out local/: git doesn't ignore it in the copy, so it would show up in the changes.",
      "Left out .env: git doesn't ignore it in the copy, so it would show up in the changes.",
    ]);
    write(copy.path, "a.txt", "b\n");
    expect(await copyPatch(copy, owner)).not.toContain("SECRET=1");
  });

  it("keeps a cloned virtualenv's links to system paths, and drops links into the project or home", async () => {
    const repo = temp();
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".venv/\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const bin = path.join(repo, ".venv/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync("/usr/bin/env", path.join(bin, "python"));
    fs.symlinkSync("python", path.join(bin, "python3"));
    fs.symlinkSync(path.join(repo, "a.txt"), path.join(bin, "into-project"));
    fs.symlinkSync(path.join(os.homedir(), ".ssh"), path.join(bin, "into-home"));
    fs.symlinkSync("/", path.join(bin, "root"));

    const dataRoot = temp();
    const { copy, warnings } = await prepareCopy({
      folder: repo,
      target: path.join(dataRoot, "worktrees", "task-venv"),
      branch: copyBranch("task-venv"),
      copySetup: { folders: [".venv"] },
    });
    expect(warnings).toEqual([]);
    const copied = path.join(copy.path, ".venv/bin");
    expect(fs.readlinkSync(path.join(copied, "python"))).toBe("/usr/bin/env");
    expect(fs.readlinkSync(path.join(copied, "python3"))).toBe("python");
    for (const gone of ["into-project", "into-home", "root"]) expect(fs.existsSync(path.join(copied, gone)) || isLink(path.join(copied, gone))).toBe(false);
  });

  it("brings .env* files, not a folder called .env, and leaves .worktreeinclude out when told to", async () => {
    const repo = temp();
    git(repo, "init", "-q");
    write(repo, ".gitignore", ".env*\nlocal.conf\n");
    write(repo, ".worktreeinclude", "local.conf\n");
    write(repo, "a.txt", "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write(repo, ".env.local", "KEEP=1\n");
    write(repo, ".env/lib/site.py", "venv\n");
    write(repo, "local.conf", "KEEP=1\n");

    const dataRoot = temp();
    const { copy } = await prepareCopy({
      folder: repo,
      target: path.join(dataRoot, "worktrees", "task-envdir"),
      branch: copyBranch("task-envdir"),
      copySetup: { worktreeInclude: false },
    });
    expect(fs.existsSync(path.join(copy.path, ".env.local"))).toBe(true);
    expect(fs.existsSync(path.join(copy.path, ".env/lib/site.py"))).toBe(false);
    expect(fs.existsSync(path.join(copy.path, "local.conf"))).toBe(false);
    expect(normalizeCopySetup({ worktreeInclude: false })).toEqual({ worktreeInclude: false });
    expect(normalizeCopySetup({ worktreeInclude: true })).toBeUndefined();
  });

  it("persists workspace copySetup and task WorkingCopy.seeded across Store restarts", async () => {
    const config = temp();
    const data = temp();
    const folder = temp();
    const store1 = new Store(config, data);
    store1.writeWorkspaces(
      updateWorkspaceRecord(
        { workspaces: [{ id: "ws1", name: "App", path: folder, dockUrl: "" }], lastWorkspaceId: "ws1" },
        "ws1",
        { copySetup: { files: [".env*", "config/*.local"], folders: ["node_modules"], setupCommand: "pnpm setup" } },
      ),
    );
    store1.writeTask({
      id: "t1",
      title: "T1",
      body: "",
      status: "todo",
      agentId: null,
      workspaceId: "ws1",
      runIds: [],
      isolated: true,
      copy: { path: path.join(data, "worktrees", "t1"), branch: "vibeforge/t1", base: "abcdef1", repo: folder, seeded: [".env", "node_modules/"] },
      shareCheckout: false,
      sourceRunId: null,
      askedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store1.close();

    const store2 = new Store(config, data);
    expect(store2.readWorkspaces().workspaces[0].copySetup).toEqual({
      files: [".env*", "config/*.local"],
      folders: ["node_modules"],
      setupCommand: "pnpm setup",
    });
    expect(store2.getTask("t1")?.copy?.seeded).toEqual([".env", "node_modules/"]);
    store2.close();
  });
});

function withPlanner(answers: Array<Record<string, unknown>>, mode: "plan" | "go" | "never" = "plan") {
  const ctx = setupService();
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { ...ctx.svc.getSettings().orchestrator, engine: "grok", mode, model: "", projectsFolder: "" } });
  ctx.svc.orchestrator.runner = async (): Promise<BrainRun> => ({
    code: 0,
    stdout: JSON.stringify({ text: "", structuredOutput: answers.shift() ?? { say: "", steps: [] } }),
    stderr: "",
    timedOut: false,
  });
  return ctx;
}

describe("service integration for tasks and Viby copies", () => {
  it("seeds a task copy, runs setup command visibly once on initial execute, and tidies cleanly on apply", async () => {
    const ctx = setupService();
    git(ctx.place, "init", "-q");
    write(ctx.place, ".gitignore", ".env*\nnode_modules/\n");
    write(ctx.place, "a.txt", "one\n");
    git(ctx.place, "add", "-A");
    git(ctx.place, "commit", "-qm", "init");
    write(ctx.place, ".env", "TOKEN=abc\n");
    write(ctx.place, "node_modules/x/index.js", "module.exports = 1;\n");

    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    ctx.svc.updateWorkspace(ws.id, {
      copySetup: { folders: ["node_modules"], setupCommand: "echo prep" },
    });
    const agent = ctx.svc.saveAgent({ name: "Builder", brief: "Build", engine: "argy", places: [ctx.place] });
    const task = ctx.svc.saveTask({ title: "Fix it", body: "Edit a.txt", agentId: agent.id, workspaceId: ws.id, isolated: true });

    const run1 = started(await ctx.svc.executeTask(task.id));
    expect(ctx.spawns[0].argv.slice(0, 8)).toEqual([
      "/bin/bash",
      "-c",
      COPY_START_SCRIPT,
      "vibeforge-setup",
      "echo prep",
      expect.any(String),
      "The setup command failed (exit %s), so the CLI was not started.",
      "",
    ]);
    expect(ctx.spawns[0].argv.slice(8, 11)).toEqual(["/usr/bin/argy", "--flag", expect.any(String)]);
    const saved = ctx.svc.listTasks().find((item) => item.id === task.id)!;
    expect(fs.readFileSync(path.join(saved.copy!.path, ".env"), "utf8")).toBe("TOKEN=abc\n");
    expect(fs.readFileSync(path.join(saved.copy!.path, "node_modules/x/index.js"), "utf8")).toBe("module.exports = 1;\n");

    await ctx.exit(run1.ptyId);
    // Continuing an existing copy does not re-run setupCommand:
    const run2 = started(await ctx.svc.continueTask(task.id));
    expect(ctx.spawns[1].argv[0]).toBe("/usr/bin/argy");
    await ctx.exit(run2.ptyId);

    write(saved.copy!.path, "a.txt", "two\n");
    const applied = await ctx.svc.applyTaskCopy(task.id);
    expect(applied.files).toEqual(["a.txt"]);
    expect(applied.left).toBeUndefined();
    expect(fs.existsSync(saved.copy!.path)).toBe(false);
    expect(ctx.svc.listTasks().find((item) => item.id === task.id)?.status).toBe("done");

    // Clearing copySetup returns it to defaults (omitted on disk):
    ctx.svc.updateWorkspace(ws.id, { copySetup: null });
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toBeUndefined();
  });

  it("uses the same copy setup helper for Viby copies, preserves seeded across restart, and tidies cleanly on apply", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const ctx = withPlanner(answers, "plan");
    git(ctx.place, "init", "-q");
    write(ctx.place, ".gitignore", ".env*\nnode_modules/\n");
    write(ctx.place, "a.txt", "one\n");
    git(ctx.place, "add", "-A");
    git(ctx.place, "commit", "-qm", "init");
    write(ctx.place, ".env", "SECRET=42\n");
    write(ctx.place, "node_modules/mod/index.js", "export default 42;\n");

    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    ctx.svc.updateWorkspace(ws.id, {
      copySetup: { folders: ["node_modules"], setupCommand: "pnpm install" },
    });

    answers.push({
      say: "I'll start Argy in a copy.",
      steps: [{ kind: "start", engine: "argy", workspace: ws.name, branch: "feat-setup", prompt: "Update a.txt" }],
    });
    await ctx.svc.orchestratorAsk("Start Argy in a copy");
    const turn = ctx.svc.orchestratorView().turns.at(-1)!;
    await ctx.svc.orchestratorRun(turn.id);
    const copy = ctx.svc.orchestratorView().copies![0];
    expect(fs.readFileSync(path.join(copy.path, ".env"), "utf8")).toBe("SECRET=42\n");
    expect(fs.readFileSync(path.join(copy.path, "node_modules/mod/index.js"), "utf8")).toBe("export default 42;\n");
    expect(copy.seeded).toEqual(expect.arrayContaining([".env", "node_modules/"]));
    expect(ctx.spawns[0].argv[3]).toBe("vibeforge-setup");
    expect(ctx.spawns[0].argv[4]).toBe("pnpm install");

    // Reloading OrchestratorDesk from copies.json preserves `seeded`:
    const restarted = setupService({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot });
    expect(restarted.svc.orchestratorView().copies![0].seeded).toEqual(copy.seeded);
    restarted.svc.close();

    write(copy.path, "a.txt", "updated\n");
    const applied = await ctx.svc.orchestratorApplyCopy(copy.id);
    expect(applied.files).toEqual(["a.txt"]);
    expect(applied.left).toBeUndefined();
    expect(fs.existsSync(copy.path)).toBe(false);
  });

  it("keeps a task's copy when a file can't be brought in, starts the CLI, and shows why in its terminal", async () => {
    const ctx = setupService();
    git(ctx.place, "init", "-q");
    write(ctx.place, ".gitignore", ".env*\n");
    write(ctx.place, "a.txt", "one\n");
    git(ctx.place, "add", "-A");
    git(ctx.place, "commit", "-qm", "init");
    write(ctx.place, ".env", "TOKEN=abc\n");
    fs.chmodSync(path.join(ctx.place, ".env"), 0o000);
    try {
      const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];
      const agent = ctx.svc.saveAgent({ name: "Builder", brief: "Build", engine: "argy", places: [ctx.place] });
      const task = ctx.svc.saveTask({ title: "Fix it", body: "Edit a.txt", agentId: agent.id, workspaceId: ws.id, isolated: true });
      const run = started(await ctx.svc.executeTask(task.id));
      expect(ctx.spawns[0].argv[3]).toBe("vibeforge-setup");
      expect(ctx.spawns[0].argv[4]).toBe("");
      expect(ctx.spawns[0].argv[7]).toBe("Could not copy .env: EACCES");
      const saved = ctx.svc.listTasks().find((item) => item.id === task.id)!;
      expect(saved.copy && fs.existsSync(saved.copy.path)).toBe(true);
      await ctx.exit(run.ptyId);
      // The next Execute uses the same copy instead of failing on a branch already in use.
      started(await ctx.svc.executeTask(task.id));
      expect(ctx.spawns[1].argv[0]).toBe("/usr/bin/argy");
    } finally {
      fs.chmodSync(path.join(ctx.place, ".env"), 0o644);
    }
  });

});
