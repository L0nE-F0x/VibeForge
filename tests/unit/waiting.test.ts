import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TURN_GRACE_MS } from "../../src/core/checkout.js";
import { agentIn, INTERVAL, setup, tempDir } from "./fixtures/service-harness.js";

// A task's Execute or a routine's Run now that waits for its folder outlives a restart.

const clock = () => {
  let at = Date.parse("2026-10-01T09:00:00Z");
  return { now: () => new Date(at), pass: (ms: number) => (at += ms) };
};

const saved = (dataRoot: string) => JSON.parse(fs.readFileSync(path.join(dataRoot, "waiting.json"), "utf8")).waiting;

describe("waiting for a folder across a restart", () => {
  it("keeps a waiting task and Run now, and starts them once the folder is free after the restart", async () => {
    const time = clock();
    const ctx = setup({ now: time.now, appStartedAt: new Date(time.now().getTime() - INTERVAL) });
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const busy = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    ctx.svc.onPtyActivity(busy.ptyId, true);
    const task = ctx.svc.saveTask({ title: "Dim lamp", agentId: agent.id, workspaceId: workspace.id });
    expect(await ctx.svc.executeTask(task.id)).toMatchObject({ queued: true });
    const since = ctx.svc.listTasks()[0].waiting!.since;
    time.pass(1000);
    const clicked = ctx.svc.saveRoutine({ name: "Tidy", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    expect(await ctx.svc.runRoutineNow(clicked.id)).toMatchObject({ queued: true });
    // A due slot waits too, but isn't kept: after the restart it's missed, like any slot due before VibeForge started.
    const due = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(due.id)!, lastFiredAt: new Date(time.now().getTime() - 2 * INTERVAL).toISOString() });
    await ctx.svc.tick(time.now());
    expect(ctx.svc.listRoutines().find((item) => item.id === due.id)?.waiting).not.toBeNull();
    expect(saved(ctx.dataRoot)).toEqual([
      { kind: "task", id: task.id, folder: ctx.place, since },
      { kind: "routine", id: clicked.id, folder: ctx.place, since: time.now().toISOString() },
    ]);

    // Quitting ends the CLI, which frees the folder: nothing starts while VibeForge closes.
    ctx.svc.prepareShutdown();
    await ctx.exit(busy.ptyId);
    await ctx.svc.checkWaiting();
    expect(ctx.spawns).toHaveLength(1);
    ctx.svc.close();
    expect(saved(ctx.dataRoot)).toHaveLength(2);

    time.pass(60_000);
    const next = setup({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot, now: time.now, appStartedAt: time.now() });
    expect(next.svc.listTasks()[0].waiting).toEqual({ since, behind: [] });
    expect(next.svc.listRoutines().find((item) => item.id === clicked.id)?.waiting).not.toBeNull();
    expect(next.svc.listRoutines().find((item) => item.id === due.id)?.waiting).toBeNull();
    // Not at once: the CLIs the window opens again come first.
    await next.svc.checkWaiting();
    expect(next.spawns).toEqual([]);
    time.pass(TURN_GRACE_MS);
    // The task was first in line: it starts, and the routine waits for it now.
    await next.svc.checkWaiting();
    expect(next.spawns.map((spawn) => spawn.cwd)).toEqual([ctx.place]);
    expect(next.svc.listTasks()[0]).toMatchObject({ status: "running", waiting: null });
    expect(saved(ctx.dataRoot)).toEqual([expect.objectContaining({ kind: "routine", id: clicked.id })]);
    await next.exit(next.svc.listTasks()[0].lastRun!.ptyId!);
    await next.svc.checkWaiting();
    expect(next.spawns).toHaveLength(2);
    expect(saved(ctx.dataRoot)).toEqual([]);
    next.svc.close();
  });

  it("lets go of waits that are too old, or whose task, routine or folder is gone", async () => {
    const time = clock();
    const first = setup({ now: time.now });
    const agent = await agentIn(first);
    const workspace = first.svc.addWorkspace(first.place).workspaces[0];
    const task = first.svc.saveTask({ title: "Kept", agentId: agent.id, workspaceId: workspace.id });
    const old = first.svc.saveTask({ title: "Old", agentId: agent.id, workspaceId: workspace.id });
    const routine = first.svc.saveRoutine({ name: "Tidy", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    first.svc.close();
    const now = time.now().getTime();
    const at = (ms: number) => new Date(now - ms).toISOString();
    const gone = path.join(tempDir(), "gone");
    fs.writeFileSync(
      path.join(first.dataRoot, "waiting.json"),
      JSON.stringify({
        waiting: [
          { kind: "task", id: task.id, folder: first.place, since: at(60_000) },
          { kind: "task", id: old.id, folder: first.place, since: at(25 * 60 * 60 * 1000) },
          { kind: "task", id: "deleted", folder: first.place, since: at(1000) },
          { kind: "routine", id: routine.id, folder: gone, since: at(1000) },
          { kind: "routine", id: "deleted", folder: first.place, since: at(1000) },
          { kind: "chat", id: task.id, folder: first.place, since: at(1000) },
          { kind: "task", id: task.id, folder: "relative", since: "yesterday" },
          null,
        ],
      }),
    );

    const ctx = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot, now: time.now });
    expect(ctx.svc.listTasks().map((item) => [item.title, item.waiting?.since ?? null])).toEqual(
      expect.arrayContaining([
        ["Kept", at(60_000)],
        ["Old", null],
      ]),
    );
    expect(ctx.svc.listRoutines()[0].waiting).toBeNull();
    expect(saved(ctx.dataRoot)).toEqual([{ kind: "task", id: task.id, folder: first.place, since: at(60_000) }]);
    // Cancelling the wait is kept too.
    ctx.svc.cancelTaskWait(task.id);
    expect(saved(ctx.dataRoot)).toEqual([]);
    ctx.svc.close();
  });

  it("starts fine without the file, or with one that doesn't parse", () => {
    const empty = setup();
    expect(empty.svc.listTasks()).toEqual([]);
    // Nothing was waiting: no file is made for it.
    expect(fs.existsSync(path.join(empty.dataRoot, "waiting.json"))).toBe(false);
    empty.svc.close();
    fs.writeFileSync(path.join(empty.dataRoot, "waiting.json"), "{ half");
    const broken = setup({ configRoot: empty.configRoot, dataRoot: empty.dataRoot });
    expect(broken.svc.listTasks()).toEqual([]);
    broken.svc.close();
  });
});
