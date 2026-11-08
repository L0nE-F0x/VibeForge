import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setup, tempDir } from "./fixtures/service-harness.js";

// Tasks one CLI hands out (`vibeforge task`, `vibeforge apply`): the cases agent-talk.test.ts doesn't reach.

function gitRepo(): string {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  return repo;
}

/** A repository with a Helper agent allowed in it, and a pane there that hands tasks out. */
async function team() {
  const repo = gitRepo();
  const ctx = setup();
  const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
  ctx.svc.saveAgent({ name: "Helper", brief: "Help.", engine: "argy", places: [repo] });
  const sender = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  const talk = (ptyId: string) => ctx.svc.liveForView().find((item) => item.ptyId === ptyId)?.talk ?? null;
  const goAhead = (over: Partial<ReturnType<typeof ctx.svc.getSettings>["agentTalk"]> = {}) =>
    ctx.svc.saveSettings({ agentTalk: { ...ctx.svc.getSettings().agentTalk, handOff: "go", ...over } });
  return { repo, ctx, workspace, sender: sender.ptyId, talk, goAhead };
}

/** Waits for work the service does on its own time (making a task's git copy). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe("handed-out tasks", () => {
  it("says a person stopped the conversation, not that the task ended, when Stop comes during task --wait", async () => {
    const { ctx, sender, talk, goAhead } = await team();
    goAhead();
    const waited = ctx.svc.handTask({ fromPty: sender, agent: "helper", text: "Quick one", wait: true, timeoutMs: 60_000 });
    const taskPty = () => ctx.svc.listLive().find((item) => item.taskId)?.ptyId ?? "";
    await until(() => talk(taskPty())?.reportsTo === "Pasty");
    ctx.svc.stopTalk(sender);
    const result = await waited;
    expect(result).toMatchObject({ ok: true, started: true, reply: null, note: expect.stringContaining("A person stopped this conversation") });
    expect(result.ok && result.note).not.toContain("ended before");
    // The task itself goes on.
    expect(ctx.svc.listLive().some((item) => item.ptyId === taskPty())).toBe(true);
    ctx.svc.close();
  });

  it("keeps a held task to start when its Start fails, so it can be started once fixed", async () => {
    const { ctx, sender, talk } = await team();
    const held = await ctx.svc.handTask({ fromPty: sender, agent: "helper", text: "Add b.txt" });
    const id = held.ok ? held.taskId : "";
    // Its agent's CLI isn't on PATH for now: Start fails, and the task still waits for it.
    const resolveBin = ctx.host.resolveBin;
    ctx.host.resolveBin = () => null;
    const failed = await ctx.svc.startHeldTasks(sender);
    expect(failed).toMatchObject({ started: 0, failed: [expect.stringContaining("couldn't start")] });
    expect(talk(sender)?.toStart).toEqual([{ taskId: id, title: "Add b.txt", agent: "Helper" }]);
    ctx.host.resolveBin = resolveBin;
    expect(await ctx.svc.startHeldTasks(sender)).toEqual({ started: 1, failed: [] });
    expect(talk(sender)?.toStart ?? []).toEqual([]);
    ctx.svc.close();
  });

  it("applies by title the task this CLI handed out, when another CLI handed out one of the same title", async () => {
    const { repo, ctx, workspace, sender, goAhead } = await team();
    goAhead({ leadApplies: true });
    const other = (await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" })).ptyId;
    for (const [from, file] of [
      [other, "c.txt"],
      [sender, "d.txt"],
    ]) {
      expect(await ctx.svc.handTask({ fromPty: from, agent: "helper", text: "Add a file" })).toMatchObject({ ok: true, started: true });
      fs.writeFileSync(path.join(ctx.spawns.at(-1)!.cwd, file), "new\n");
    }
    expect(await ctx.svc.applyHandedTask({ fromPty: sender, task: "Add a file" })).toMatchObject({ ok: true, files: ["d.txt"] });
    expect(await ctx.svc.applyHandedTask({ fromPty: other, task: "Add a file" })).toMatchObject({ ok: true, files: ["c.txt"] });
    expect(fs.readdirSync(repo).sort()).toEqual([".git", "a.txt", "c.txt", "d.txt"]);
    ctx.svc.close();
  });
});
