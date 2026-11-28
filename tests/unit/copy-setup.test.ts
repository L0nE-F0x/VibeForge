import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanCopyFolderPath, matchesCopyPatterns, normalizeCopySetup, parseWorktreeInclude, wrapWithSetupCommand } from "../../src/core/copy-setup.js";
import { resolvePlan, type PlanContext } from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import { Store } from "../../src/core/store.js";
import { updateWorkspaceRecord } from "../../src/core/workspaces.js";
import { applyToWorkspace, copyBranch, copyPatch, leftInCopy, prepareCopy, removeCopy } from "../../src/core/worktrees.js";
import { setup as setupService, started, until } from "./fixtures/service-harness.js";

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
    const plain = wrapWithSetupCommand(["/usr/bin/claude", "hi"], "  ");
    expect(plain).toEqual(["/usr/bin/claude", "hi"]);

    const wrapped = wrapWithSetupCommand(["/usr/bin/claude", "hi"], "npm run build", "/bin/bash");
    expect(wrapped[1]).toBe("-c");
    expect(wrapped[3]).toBe("vibeforge-setup");
    expect(wrapped[4]).toBe("npm run build");
    expect(wrapped[5]).toBe("/bin/bash");
    expect(wrapped.slice(6)).toEqual(["/usr/bin/claude", "hi"]);
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
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "node_modules/evil-link"));
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

    // node_modules cloned, internal bin symlink kept, outside symlink pruned:
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
    expect(ctx.spawns[0].argv.slice(0, 6)).toEqual([
      "/bin/bash",
      "-c",
      'printf "\\033[2m$ %s\\033[0m\\n" "$1"; "$2" -c "$1" && shift 2 && exec "$@"',
      "vibeforge-setup",
      "echo prep",
      expect.any(String),
    ]);
    expect(ctx.spawns[0].argv.slice(6, 9)).toEqual(["/usr/bin/argy", "--flag", expect.any(String)]);
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

  it("blocks Viby auto-run from changing a workspace setup command without Go", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const ctx = withPlanner(answers, "go");
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];

    const planCtx: PlanContext = {
      workspaces: [{ id: ws.id, name: ws.name, folder: ws.path, git: false }],
      engines: [{ id: "grok", label: "Grok Build", available: true }],
      running: [],
    };
    const resolved = resolvePlan(
      {
        say: "Set copy setup",
        steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "folders=node_modules", prompt: "pnpm prep" }],
      },
      planCtx,
    );
    expect(resolved[0]).toMatchObject({ action: "copy-setup", workspaceId: ws.id, prompt: "pnpm prep" });

    // Folders-only update runs straight away under "go" mode (wait until background auto-run settles):
    answers.push({
      say: "Done.",
      steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "folders=node_modules, files=.env*" }],
    });
    await ctx.svc.orchestratorAsk("Clone node_modules in copies");
    await until(() => Boolean(ctx.svc.listWorkspaces().workspaces[0].copySetup));
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    // Setup command waits for Go under "go" mode, and auto execution is refused too:
    answers.push({
      say: "I'll set the setup command.",
      steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "setupCommand=pnpm install" }],
    });
    await ctx.svc.orchestratorAsk("Set setup command");
    const riskyTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(riskyTurn.plan).toBe("waiting");
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    await ctx.svc.orchestrator.run(riskyTurn.id, true);
    expect(riskyTurn.steps![0]).toMatchObject({
      state: "failed",
      error: "Changing a workspace's copy setup command waits for Go.",
    });
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    // Explicit Go applies the change:
    riskyTurn.plan = "waiting";
    riskyTurn.steps![0].state = "planned";
    riskyTurn.steps![0].error = null;
    await ctx.svc.orchestratorRun(riskyTurn.id);
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"], setupCommand: "pnpm install" });
  });
});
