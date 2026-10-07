import { describe, expect, it } from "vitest";
import { agentIn, INTERVAL, setup, started, tempDir, until } from "./fixtures/service-harness.js";

// The service calls the window and the phone page make that service.test.ts doesn't reach.

const clock = () => {
  let at = Date.parse("2026-10-01T09:00:00Z");
  return { now: () => new Date(at), pass: (ms: number) => (at += ms) };
};

describe("workspaces", () => {
  it("reorders, renames and selects workspaces", () => {
    const ctx = setup();
    const second = tempDir();
    ctx.svc.addWorkspace(ctx.place);
    const [first, other] = ctx.svc.addWorkspace(second).workspaces;
    expect(ctx.svc.moveWorkspace(other.id, 0).workspaces.map((item) => item.id)).toEqual([other.id, first.id]);
    const renamed = ctx.svc.updateWorkspace(first.id, { name: "  Notes  ", dockUrl: "http://localhost:5173" }).workspaces.find((item) => item.id === first.id);
    expect(renamed).toMatchObject({ name: "Notes", dockUrl: "http://localhost:5173" });
    ctx.svc.selectWorkspace(first.id);
    expect(ctx.svc.listWorkspaces().lastWorkspaceId).toBe(first.id);
    ctx.svc.close();
  });

  it("stops its Code terminals and forgets its layout when a workspace is removed", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const code = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    ctx.svc.saveLayout(workspace.id, { kind: "pane", id: "a", launch: { type: "shell" } });
    expect(ctx.svc.getLayout(workspace.id)).not.toBeNull();
    const left = await ctx.svc.removeWorkspace(workspace.id);
    expect(left.workspaces).toEqual([]);
    expect(ctx.killed).toContain(code.ptyId);
    expect(ctx.svc.getLayout(workspace.id)).toBeNull();
    await until(() => ctx.ended.length === 1);
    ctx.svc.close();
  });
});

describe("chats", () => {
  it("renames a chat, keeps the title for a blank name, and changes a plain chat's engine", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "argy" });
    expect(ctx.svc.renameChat(chat.id, "  Release notes ").title).toBe("Release notes");
    expect(ctx.svc.renameChat(chat.id, "   ").title).toBe("Release notes");
    expect(ctx.svc.setChatEngine(chat.id, "pasty").engine).toBe("pasty");
    expect(() => ctx.svc.setChatEngine(chat.id, "gone")).toThrow(/not on PATH/);
    const agent = await agentIn(ctx);
    const agentChat = ctx.svc.createChat({ agentId: agent.id });
    expect(() => ctx.svc.setChatEngine(agentChat.id, "pasty")).toThrow(/agent's engine/);
    ctx.svc.close();
  });

  it("stops a chat's live run", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const first = await ctx.svc.sendChat(chat.id, "hello");
    await ctx.svc.stopChat(chat.id);
    expect(ctx.killed).toContain(first.ptyId);
    await until(() => ctx.ended.length === 1);
    ctx.svc.close();
  });

  it("starts an agent in a workspace it may use, once, and nowhere else", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const outside = ctx.svc.addWorkspace(tempDir()).workspaces[1];
    const launched = await ctx.svc.launchAgent(workspace.id, agent.id, "Tidy the notes");
    expect(launched.started).toBe(true);
    expect(ctx.spawns[0].cwd).toBe(ctx.place);
    expect(ctx.spawns[0].argv.join(" ")).toContain("Tidy the notes");
    await expect(ctx.svc.launchAgent(workspace.id, agent.id, null)).rejects.toThrow(/already running/);
    await expect(ctx.svc.launchAgent(outside.id, agent.id, null)).rejects.toThrow(/not allowed/);
    expect(ctx.spawns).toHaveLength(1);
    ctx.svc.close();
  });
});

describe("continuing", () => {
  it("continues a Code run with the CLI's own continue, and the next instruction after it", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    await ctx.exit(first.ptyId);
    const next = await ctx.svc.continueRun(first.runId, {}, "Now the tests");
    expect(next.runId).not.toBe(first.runId);
    expect(ctx.spawns[1].argv).toContain("--continue");
    expect(ctx.spawns[1].cwd).toBe(ctx.place);
    expect(JSON.stringify(ctx.spawns[1])).toContain("Now the tests");
    expect(ctx.svc.getRun(next.runId).run.continuedFrom).toBe(first.runId);
    // A live run is the one to type into, so there is nothing new to start.
    expect((await ctx.svc.continueRun(next.runId)).ptyId).toBe(next.ptyId);
    expect(ctx.spawns).toHaveLength(2);
    ctx.svc.close();
  });

  it("continues a CLI without a continue flag from its transcript", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    await ctx.exit(first.ptyId);
    await ctx.svc.continueRun(first.runId, {}, "Pick it up");
    expect(ctx.spawns[1].argv).not.toContain("--continue");
    expect(JSON.stringify(ctx.spawns[1])).toContain("Pick it up");
    ctx.svc.close();
  });

  it("continues a task as its agent with the next instruction, through the run or the task", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Write notes", agentId: agent.id, workspaceId: workspace.id });
    const run = started(await ctx.svc.executeTask(task.id));
    await ctx.exit(run.ptyId);
    const again = await ctx.svc.continueRun(run.runId, {}, "Add a summary");
    expect(again.taskId).toBe(task.id);
    expect(ctx.spawns[1].argv).toContain("--continue");
    expect(JSON.stringify(ctx.spawns[1])).toContain("Add a summary");
    await ctx.exit(again.ptyId);
    await ctx.svc.continueTask(task.id, {}, "And a title");
    expect(JSON.stringify(ctx.spawns[2])).toContain("And a title");
    expect(ctx.svc.listTasks()[0].status).toBe("running");
    ctx.svc.close();
  });
});

describe("tasks", () => {
  it("moves a task between columns, but never into or out of a live run", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Write notes", agentId: agent.id, workspaceId: workspace.id });
    expect(ctx.svc.setTaskStatus(task.id, "done").status).toBe("done");
    expect(() => ctx.svc.setTaskStatus(task.id, "running")).toThrow(/Execute/);
    const run = started(await ctx.svc.executeTask(task.id));
    expect(() => ctx.svc.setTaskStatus(task.id, "todo")).toThrow(/Stop the task/);
    await ctx.exit(run.ptyId);
    expect(ctx.svc.setTaskStatus(task.id, "todo").status).toBe("todo");
    expect(() => ctx.svc.setTaskStatus("nope", "done")).toThrow(/no longer exists/);
    ctx.svc.close();
  });
});

describe("routines", () => {
  it("doesn't replay the slots that passed while a routine was paused", async () => {
    const time = clock();
    const ctx = setup({ now: time.now, appStartedAt: new Date(time.now().getTime() - INTERVAL) });
    const agent = await agentIn(ctx);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    ctx.svc.setRoutineEnabled(routine.id, false);
    time.pass(3 * INTERVAL);
    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(0);
    expect(ctx.svc.setRoutineEnabled(routine.id, true).lastFiredAt).toBe(time.now().toISOString());
    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(0);
    time.pass(INTERVAL);
    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(1);
    ctx.svc.close();
  });

  it("lets a waiting routine's slot go when its wait is cancelled", async () => {
    const time = clock();
    const ctx = setup({ now: time.now, appStartedAt: new Date(time.now().getTime() - INTERVAL) });
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const busy = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    ctx.svc.onPtyActivity(busy.ptyId, true);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(routine.id)!, lastFiredAt: new Date(time.now().getTime() - 2 * INTERVAL).toISOString() });
    await ctx.svc.tick(time.now());
    expect(ctx.svc.listRoutines()[0].waiting).not.toBeNull();

    ctx.svc.cancelRoutineWait(routine.id);
    expect(ctx.svc.listRoutines()[0].waiting).toBeNull();
    await ctx.exit(busy.ptyId);
    await ctx.svc.checkWaiting();
    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(1);
    ctx.svc.close();
  });

  it("previews the next times of a schedule, and says when one isn't valid", () => {
    const ctx = setup();
    const preview = ctx.svc.previewSchedule({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(preview.valid).toBe(true);
    expect(preview.next).toHaveLength(3);
    expect(ctx.svc.previewSchedule({ kind: "cron", expr: "not cron" }).valid).toBe(false);
    ctx.svc.close();
  });
});
