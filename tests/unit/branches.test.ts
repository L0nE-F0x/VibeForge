import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBranchCheckout, readBranches } from "../../src/core/branches.js";
import { TeamService, type DeskHost } from "../../src/core/team-service.js";

const kept: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** A repository on `feat/phone-companion`, with `main` one commit behind it. */
function repoOnFeature(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-br-"));
  kept.push(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "main\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  git(dir, "checkout", "-q", "-b", "feat/phone-companion");
  fs.writeFileSync(path.join(dir, "a.txt"), "feature\n");
  git(dir, "commit", "-qam", "feature");
  return dir;
}

function service() {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-br-cfg-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-br-data-"));
  kept.push(configRoot, dataRoot);
  const host: DeskHost = {
    spawn: async () => ({ ptyId: "pty", pid: 1 }),
    send: async () => undefined,
    kill: async () => undefined,
    record: async () => undefined,
    resolveBin: () => null,
    notify: () => undefined,
    snapshotGit: async () => "",
    gitHead: async () => null,
  };
  return new TeamService({ configRoot, dataRoot, appStartedAt: new Date(0), now: () => new Date(0), host });
}

afterEach(() => {
  for (const dir of kept.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.worktrees`, { recursive: true, force: true });
  }
});

describe("a second checkout", () => {
  it("opens main beside a folder that stays on its branch", async () => {
    const dir = repoOnFeature();
    const opened = await openBranchCheckout(dir, "main");
    expect(git(dir, "branch", "--show-current").trim()).toBe("feat/phone-companion");
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("feature\n");
    expect(git(dir, "status", "--short").trim()).toBe("");
    expect(opened.path).toBe(path.join(path.dirname(dir), `${path.basename(dir)}.worktrees`, "main"));
    expect(git(opened.path, "branch", "--show-current").trim()).toBe("main");
    expect(fs.readFileSync(path.join(opened.path, "a.txt"), "utf8")).toBe("main\n");
  });

  it("reuses a checkout that already exists, including the original folder", async () => {
    const dir = repoOnFeature();
    const main = await openBranchCheckout(dir, "main");
    const again = await openBranchCheckout(dir, "main");
    expect(again.path).toBe(main.path);
    expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
    const back = await openBranchCheckout(main.path, "feat/phone-companion");
    expect(back.path).toBe(dir);
    expect(git(main.path, "branch", "--show-current").trim()).toBe("main");
  });

  it("refuses the branch the folder is already on, and a name that is not a branch", async () => {
    const dir = repoOnFeature();
    await expect(openBranchCheckout(dir, "feat/phone-companion")).rejects.toThrow("This folder is already on feat/phone-companion.");
    await expect(openBranchCheckout(dir, "nope")).rejects.toThrow("There is no branch named nope.");
    await expect(openBranchCheckout(dir, "../nope")).rejects.toThrow("That branch name is not valid.");
    expect(fs.existsSync(`${dir}.worktrees`)).toBe(false);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-br-plain-"));
    kept.push(plain);
    await expect(openBranchCheckout(plain, "main")).rejects.toThrow("This folder is not a git repository.");
  });

  it("lists the folder's branch first and main next", async () => {
    const dir = repoOnFeature();
    git(dir, "branch", "side");
    const list = await readBranches(dir);
    expect(list.repo).toBe(dir);
    expect(list.current).toBe("feat/phone-companion");
    expect(list.branches.map((branch) => [branch.name, branch.current])).toEqual([
      ["feat/phone-companion", true],
      ["main", false],
      ["side", false],
    ]);
    expect(list.branches[0].checkout).toBe(dir);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-br-plain-"));
    kept.push(plain);
    expect(await readBranches(plain)).toEqual({ repo: null, current: null, branches: [] });
  });

  it("adds the checkout as its own workspace and leaves the first folder's branch", async () => {
    const dir = repoOnFeature();
    const svc = service();
    const first = svc.addWorkspace(dir);
    const opened = await svc.openBranch(first.workspaces[0].id, "main");
    expect(opened.workspaces).toHaveLength(2);
    expect(opened.workspaces[1]).toMatchObject({ name: `${path.basename(dir)} · main` });
    expect(opened.lastWorkspaceId).toBe(opened.workspaces[1].id);
    expect(git(dir, "branch", "--show-current").trim()).toBe("feat/phone-companion");
    const again = await svc.openBranch(first.workspaces[0].id, "main");
    expect(again.workspaces).toHaveLength(2);
    expect(again.lastWorkspaceId).toBe(opened.workspaces[1].id);
    expect(again.workspaces[1].name).toBe(`${path.basename(dir)} · main`);
    const listed = await svc.listBranches(first.workspaces[0].id);
    expect(listed.current).toBe("feat/phone-companion");
    expect(listed.branches.find((branch) => branch.name === "main")?.checkout).toBe(opened.workspaces[1].path);
    svc.close();
  });
});
