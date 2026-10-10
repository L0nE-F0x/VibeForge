import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocateRunDir, normalizeRun, writeRunMeta } from "../../src/core/runs.js";
import { matchExpression, Store } from "../../src/core/store.js";
import { snippetParts } from "../../src/shared/text.js";
import { scratchName } from "../../src/core/service/chats.js";
import type { RunMeta } from "../../src/core/types.js";
import { TURN_GRACE_MS } from "../../src/core/checkout.js";
import { gitHead, snapshotGit } from "../../src/core/vcs.js";
import { agentIn, INTERVAL, setup, started, tempDir, until } from "./fixtures/service-harness.js";

describe("agents", () => {
  it("keeps an agent's voice until it is changed", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    expect(agent.voice).toBe("");
    const voiced = ctx.svc.saveAgent({ ...agent, voice: " /v/en_GB-alan-medium.onnx " });
    expect(voiced.voice).toBe("/v/en_GB-alan-medium.onnx");
    // Saving from a form that doesn't know about voices leaves it alone.
    const { voice: _voice, ...rest } = voiced;
    expect(ctx.svc.saveAgent({ ...rest, brief: "New brief." }).voice).toBe("/v/en_GB-alan-medium.onnx");
    expect(ctx.svc.getAgent(agent.id)?.voice).toBe("/v/en_GB-alan-medium.onnx");
    ctx.svc.close();
  });

  it("keeps the brief and memory when the engine changes, and validates input", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    ctx.svc.writeMemory(agent.id, "- remember this\n");
    ctx.svc.saveAgent({ ...agent, engine: "pasty" });
    expect(ctx.svc.getAgent(agent.id)).toMatchObject({ engine: "pasty", brief: "Keep notes." });
    expect(ctx.svc.readMemory(agent.id)).toBe("- remember this\n");
    expect(() => ctx.svc.saveAgent({ name: "", brief: "b", engine: "argy", places: [ctx.place] })).toThrow(/name/);
    expect(() => ctx.svc.saveAgent({ name: "x", brief: "b", engine: "gone", places: [ctx.place] })).toThrow(/not on PATH/);
    expect(() => ctx.svc.saveAgent({ name: "x", brief: "b", engine: "argy", places: ["/definitely/not/here"] })).toThrow(/does not exist/);
    expect(() => ctx.svc.deleteAgent(agent.id, "wrong")).toThrow(/Type the agent's name/);
    ctx.svc.deleteAgent(agent.id, "Notes");
    expect(ctx.svc.listAgents()).toEqual([]);
    ctx.svc.close();
  });
});

describe("chats", () => {
  it("starts with the preamble on argv, pastes follow-ups, then continues the engine's session", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const first = await ctx.svc.sendChat(chat.id, "Write the notes\nfor today");
    expect(first.started).toBe(true);
    expect(ctx.spawns).toHaveLength(1);
    const [bin, flag, prompt] = ctx.spawns[0].argv;
    expect([bin, flag]).toEqual(["/usr/bin/argy", "--flag"]);
    expect(prompt).toContain("## Brief\nKeep notes.");
    expect(prompt.trimEnd().endsWith("# This run\nWrite the notes\nfor today")).toBe(true);
    expect(ctx.spawns[0].pasteInput).toBeNull();
    expect(ctx.spawns[0].cwd).toBe(ctx.place);
    const run = ctx.svc.getRun(first.runId);
    expect(run.run.argv).toEqual(["/usr/bin/argy", "--flag", "{prompt}"]);
    expect(run.files.preamble).toBe(prompt);
    expect(ctx.svc.listChats({ agentId: agent.id })[0].title).toBe("Write the notes");

    const second = await ctx.svc.sendChat(chat.id, "and tomorrow");
    expect(second.started).toBe(false);
    expect(ctx.sent).toEqual([{ ptyId: first.ptyId, text: "and tomorrow" }]);
    expect(ctx.spawns).toHaveLength(1);

    await ctx.exit(first.ptyId);
    expect(ctx.svc.getRun(first.runId).run).toMatchObject({ status: "exited", changes: "1 file changed, 1 insertion(+)" });
    const third = await ctx.svc.sendChat(chat.id, "pick it up");
    expect(third.started).toBe(true);
    expect(third.note).toMatch(/picked it up/);
    expect(ctx.spawns[1].argv).toEqual(["/usr/bin/argy", "--flag", "--continue"]);
    expect(ctx.spawns[1].pasteInput).toBe("pick it up");
    expect(ctx.svc.getRun(third.runId).run.continuedFrom).toBe(first.runId);
    ctx.svc.close();
  });

  it("records a short prompt as its slot without hiding the rest of the command", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "argy" });
    const first = await ctx.svc.sendChat(chat.id, "a");
    expect(ctx.spawns[0].argv.slice(0, 2)).toEqual(["/usr/bin/argy", "--flag"]);
    expect(ctx.svc.getRun(first.runId).run.argv).toEqual(["/usr/bin/argy", "--flag", "{prompt}"]);
    ctx.svc.close();
  });

  it("reopens the exact session the CLI printed on exit", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "argy" });
    const first = await ctx.svc.sendChat(chat.id, "start");
    fs.writeFileSync(path.join(ctx.svc.getRun(first.runId).run.dir, "transcript.txt"), "bye\nResume with: argy --resume sess-12345678\n");
    await ctx.exit(first.ptyId);
    await ctx.svc.continueChat(chat.id);
    expect(ctx.spawns[1].argv).toEqual(["/usr/bin/argy", "--flag", "--resume", "sess-12345678"]);
    expect(ctx.spawns[1].pasteInput).toBeNull();
    ctx.svc.close();
  });

  it("starts fresh with the old transcript when the agent has switched engines", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const first = await ctx.svc.sendChat(chat.id, "start");
    fs.writeFileSync(path.join(ctx.svc.getRun(first.runId).run.dir, "transcript.txt"), "argy --resume sess-12345678\n");
    await ctx.exit(first.ptyId);
    ctx.svc.saveAgent({ ...agent, engine: "pasty" });
    await ctx.svc.sendChat(chat.id, "carry on");
    expect(ctx.spawns[1].argv).toEqual(["/usr/bin/pasty"]);
    expect(ctx.spawns[1].pasteInput).toContain("## Previous attempt");
    expect(ctx.spawns[1].pasteInput).toContain("# This run\ncarry on");
    ctx.svc.close();
  });

  it("pastes the first prompt into CLIs that take no prompt argument", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "pasty" });
    await ctx.svc.sendChat(chat.id, "hello there");
    expect(ctx.spawns[0].argv).toEqual(["/usr/bin/pasty"]);
    expect(ctx.spawns[0].pasteInput).toBe("hello there");
    expect(ctx.spawns[0].cwd).toBe(path.join(ctx.dataRoot, "scratch", chat.id));
    expect(fs.existsSync(ctx.spawns[0].cwd)).toBe(true);
    ctx.svc.close();
  });

  it("names a chat's scratch folder after its first message", async () => {
    const ctx = setup();
    const first = ctx.svc.createChat({ engine: "pasty", prompt: "Airbus X-Ray: a blueprint explorer for the A350\nwith layers" });
    expect(first.id).toBe("airbus-x-ray-a-blueprint");
    expect(first.cwd).toBe(path.join(ctx.dataRoot, "scratch", "airbus-x-ray-a-blueprint"));
    // A folder left there (a deleted chat's, say) is not reused.
    fs.mkdirSync(path.join(ctx.dataRoot, "scratch", "hello"), { recursive: true });
    expect(ctx.svc.createChat({ engine: "pasty", prompt: "hello" }).id).toBe("hello-2");
    expect(ctx.svc.createChat({ engine: "pasty", prompt: "hello" }).id).toBe("hello-3");
    expect(ctx.svc.createChat({ engine: "pasty", prompt: "こんにちは" }).id).toBe("chat");
    expect(ctx.svc.createChat({ engine: "pasty" }).id).toBe("chat-2");
    expect(scratchName("Supercalifragilisticexpialidocious-and-then-some")).toBe("supercalifragilisticexpialidocio");
    ctx.svc.close();
  });

  it("stops a live chat before deleting its scratch folder and transcripts", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "pasty" });
    const sent = await ctx.svc.sendChat(chat.id, "hi");
    const run = ctx.svc.getRun(sent.runId).run;
    fs.writeFileSync(path.join(run.dir, "transcript.txt"), "secret-ish");
    await ctx.svc.deleteChat(chat.id);
    expect(ctx.killed).toEqual([sent.ptyId]);
    expect(ctx.svc.listChats()).toEqual([]);
    expect(fs.existsSync(run.cwd)).toBe(false);
    expect(fs.existsSync(path.join(run.dir, "transcript.txt"))).toBe(false);
    expect(ctx.svc.getRun(sent.runId).run.status).toBe("stopped");
    ctx.svc.close();
  });
});

describe("undo", () => {
  it("puts back a deleted skill, routine, task and chat, with what went with them", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const skill = ctx.svc.saveSkill({ name: "Review", body: "Read the diff first." });
    ctx.svc.setSkillAgents(skill.id, [agent.id]);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "Draft." });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Edit", body: "Change a", agentId: agent.id, workspaceId: workspace.id });
    const chat = ctx.svc.createChat({ engine: "pasty" });
    const sent = await ctx.svc.sendChat(chat.id, "hi");
    await ctx.exit(sent.ptyId);
    const run = ctx.svc.getRun(sent.runId).run;
    fs.writeFileSync(path.join(run.dir, "transcript.txt"), "what was said");

    const deleted = [
      ctx.svc.deleteSkill(skill.id),
      ctx.svc.deleteRoutine(routine.id),
      await ctx.svc.deleteTask(task.id),
      await ctx.svc.deleteChat(chat.id),
    ];
    expect(ctx.svc.store.getSkill(skill.id)).toBeNull();
    expect(ctx.svc.store.getAgent(agent.id)?.skills).toEqual([]);
    expect(ctx.svc.store.getRoutine(routine.id)).toBeNull();
    expect(ctx.svc.store.getTask(task.id)).toBeNull();
    expect(ctx.svc.listChats()).toEqual([]);
    expect(fs.existsSync(run.cwd)).toBe(false);
    expect(fs.existsSync(path.join(run.dir, "transcript.txt"))).toBe(false);

    for (const { undo } of deleted) ctx.svc.undoDelete(undo);
    expect(ctx.svc.store.getSkill(skill.id)?.body).toContain("Read the diff first.");
    expect(ctx.svc.store.getAgent(agent.id)?.skills).toEqual([skill.id]);
    expect(ctx.svc.store.getRoutine(routine.id)?.name).toBe("Notes");
    expect(ctx.svc.store.getTask(task.id)?.title).toBe("Edit");
    expect(ctx.svc.listChats().map((item) => item.id)).toEqual([chat.id]);
    expect(fs.existsSync(run.cwd)).toBe(true);
    expect(fs.readFileSync(path.join(run.dir, "transcript.txt"), "utf8")).toBe("what was said");
    expect(() => ctx.svc.undoDelete(deleted[0].undo)).toThrow(/too late/);
    ctx.svc.close();
  });

  it("keeps a delete from an earlier session deleted", async () => {
    const ctx = setup();
    const skill = ctx.svc.saveSkill({ name: "Review" });
    const { undo } = ctx.svc.deleteSkill(skill.id);
    expect(fs.readdirSync(path.join(ctx.dataRoot, "trash"))).toHaveLength(1);
    // The app closes while the Undo is still up: the delete stands.
    ctx.svc.close();
    const next = setup({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot });
    expect(fs.existsSync(path.join(ctx.dataRoot, "trash"))).toBe(false);
    expect(next.svc.store.getSkill(skill.id)).toBeNull();
    expect(() => next.svc.undoDelete(undo)).toThrow(/too late/);
    next.svc.close();
  });
});

describe("routines", () => {
  it("fires one fresh run per slot, never overlaps, and records slots missed while closed", async () => {
    const ctx = setup({ appStartedAt: new Date(9 * INTERVAL) });
    const agent = await agentIn(ctx);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "Draft. Do not publish." });
    // A new routine never fires a slot from before it was saved.
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(routine.id)!, lastFiredAt: null });

    await ctx.svc.tick(new Date(8 * INTERVAL + 1000));
    expect(ctx.spawns).toHaveLength(0);
    expect(ctx.svc.listRoutines()[0].lastMissedAt).toBe(new Date(8 * INTERVAL).toISOString());

    await ctx.svc.tick(new Date(10 * INTERVAL + 1000));
    expect(ctx.spawns).toHaveLength(1);
    expect(ctx.spawns[0].argv[2]).toContain("# This run\nDraft. Do not publish.");
    await ctx.svc.tick(new Date(10 * INTERVAL + 31_000));
    expect(ctx.spawns).toHaveLength(1);

    const decisions = await ctx.svc.tick(new Date(11 * INTERVAL + 1000));
    expect(decisions[0].decision).toEqual({ action: "skip", reason: "still-running" });
    expect(ctx.svc.listRoutines()[0].stillRunning).toBe(true);

    await ctx.exit("pty-1");
    await ctx.svc.tick(new Date(12 * INTERVAL + 1000));
    expect(ctx.spawns).toHaveLength(2);
    expect(ctx.notes).toHaveLength(1);
    expect(ctx.notes[0].title).toBe("Notes · Notes");
    expect(ctx.ended).toEqual([{ runId: expect.any(String), origin: "routine", outcome: "ok" }]);
    ctx.svc.close();
  });

  it("records a routine that cannot start, once per slot, instead of passing silently", async () => {
    const ctx = setup({ appStartedAt: new Date(9 * INTERVAL) });
    const agent = await agentIn(ctx);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "Draft." });
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(routine.id)!, lastFiredAt: new Date(9 * INTERVAL).toISOString() });
    fs.rmSync(agent.places[0], { recursive: true, force: true });

    const [result] = await ctx.svc.tick(new Date(10 * INTERVAL + 1000));
    expect(result.error).toMatch(/allowed folders exist/);
    await ctx.svc.tick(new Date(10 * INTERVAL + 31_000));
    expect(ctx.spawns).toHaveLength(0);
    const failed = ctx.svc.listRuns().filter((run) => run.routineId === routine.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", origin: "routine" });
    expect(failed[0].error).toMatch(/allowed folders exist/);
    ctx.svc.close();
  });

  it("lights a routine whose last runs failed in a row, and says so once", async () => {
    const ctx = setup();
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "b", engine: "argy", places: [ctx.place], allowRoutines: true });
    const routine = ctx.svc.saveRoutine({ name: "Lint", agentId: agent.id, schedule: { kind: "every", minutes: 60 }, prompt: "p" });
    const runOnce = async (code: number) => {
      const run = started(await ctx.svc.runRoutineNow(routine.id));
      await ctx.exit(run.ptyId, code);
    };
    await runOnce(1);
    await runOnce(2);
    expect(ctx.svc.listRoutines()[0]).toMatchObject({ failStreak: 2, failing: false });
    await runOnce(1);
    expect(ctx.svc.listRoutines()[0]).toMatchObject({ failStreak: 3, failing: true });
    await runOnce(1);
    expect(ctx.notes.map((note) => note.body.includes("failed 3 times in a row"))).toEqual([false, false, true, false]);
    // One good run puts it out.
    await runOnce(0);
    expect(ctx.svc.listRoutines()[0]).toMatchObject({ failStreak: 0, failing: false });
    ctx.svc.close();
  });

  it("does not fire a slot that passed before the routine was saved", async () => {
    const ctx = setup({ appStartedAt: new Date(0) });
    const agent = await agentIn(ctx);
    ctx.svc.saveRoutine({ name: "Now", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    await ctx.svc.tick(new Date());
    expect(ctx.spawns).toHaveLength(0);
    ctx.svc.close();
  });

  it("runs now while paused without swallowing the next slot, and refuses when it cannot", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const routine = ctx.svc.saveRoutine({ name: "R", agentId: agent.id, schedule: { kind: "cron", expr: "0 9 * * 1-5" }, prompt: "p", enabled: false });
    const before = ctx.svc.store.getRoutine(routine.id)!.lastFiredAt;
    const launched = started(await ctx.svc.runRoutineNow(routine.id));
    expect(ctx.svc.store.getRoutine(routine.id)!.lastFiredAt).toBe(before);
    await expect(ctx.svc.runRoutineNow(routine.id)).rejects.toThrow(/still going/);
    await ctx.exit(launched.ptyId);
    ctx.svc.saveAgent({ ...agent, allowRoutines: false });
    await expect(ctx.svc.runRoutineNow(routine.id)).rejects.toThrow(/does not allow routines/);
    expect(ctx.svc.listRoutines()[0].issues.join(" ")).toMatch(/does not allow routines/);
    expect(() => ctx.svc.saveRoutine({ name: "Bad", agentId: agent.id, schedule: { kind: "every", minutes: 2 }, prompt: "p" })).toThrow(/at least 5/);
    ctx.svc.close();
  });
});

describe("taking turns in a folder", () => {
  /** A clock the test moves on by hand. */
  const clock = () => {
    let at = Date.parse("2026-10-01T09:00:00Z");
    return { now: () => new Date(at), pass: (ms: number) => (at += ms) };
  };

  it("lets a task wait while another coding CLI is busy in its workspace, then starts it", async () => {
    const time = clock();
    const ctx = setup({ now: time.now });
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    // A coding CLI typed into a Code terminal in the same folder, working.
    const shell = await ctx.svc.startShell({ workspaceId: workspace.id });
    ctx.svc.onPtyProgram(shell.ptyId, ["argy"], ctx.place);
    ctx.svc.onPtyActivity(shell.ptyId, true);
    await ctx.svc.writersIn(ctx.place);
    const task = ctx.svc.saveTask({ title: "Dim lamp", agentId: agent.id, workspaceId: workspace.id });
    expect(ctx.svc.listTasks()[0].writers.map((writer) => [writer.label, writer.busy])).toEqual([["Argy", true]]);

    const result = await ctx.svc.executeTask(task.id);
    expect(result).toEqual({ queued: true, behind: ["Argy"] });
    expect(ctx.spawns).toHaveLength(1);
    expect(ctx.svc.listTasks()[0]).toMatchObject({ status: "todo", waiting: { behind: [{ label: "Argy" }] } });
    // Executing again keeps its place in line.
    expect(await ctx.svc.executeTask(task.id)).toMatchObject({ queued: true });

    // It went quiet, but a short pause doesn't hand the folder over.
    ctx.svc.onPtyActivity(shell.ptyId, false);
    await ctx.svc.checkWaiting();
    expect(ctx.spawns).toHaveLength(1);
    time.pass(TURN_GRACE_MS + 1000);
    await ctx.svc.checkWaiting();
    expect(ctx.spawns).toHaveLength(2);
    expect(ctx.spawns[1].cwd).toBe(ctx.place);
    expect(ctx.svc.listTasks()[0]).toMatchObject({ status: "running", waiting: null });
    ctx.svc.close();
  });

  it("starts at once when asked to, or when the task shares its folder", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const first = ctx.svc.saveTask({ title: "One", agentId: agent.id, workspaceId: workspace.id });
    expect(await ctx.svc.executeTask(first.id)).toMatchObject({ queued: true });
    // "Start anyway".
    expect(await ctx.svc.executeTask(first.id, {}, true)).toMatchObject({ runId: expect.any(String) });
    expect(ctx.svc.listTasks().find((task) => task.id === first.id)!.waiting).toBeNull();
    const shared = ctx.svc.saveTask({ title: "Two", agentId: agent.id, workspaceId: workspace.id, shareCheckout: true });
    expect(await ctx.svc.executeTask(shared.id)).toMatchObject({ runId: expect.any(String) });
    // The CLI only just started, so it still has its turn.
    const third = ctx.svc.saveTask({ title: "Three", agentId: agent.id, workspaceId: workspace.id });
    expect(await ctx.svc.executeTask(third.id)).toMatchObject({ queued: true });
    ctx.svc.cancelTaskWait(third.id);
    expect(ctx.svc.listTasks().find((task) => task.id === third.id)!.waiting).toBeNull();
    ctx.svc.close();
  });

  it("keeps a due routine's slot while it waits, and lets Code and chats in", async () => {
    const time = clock();
    const ctx = setup({ now: time.now, appStartedAt: new Date(time.now().getTime() - INTERVAL) });
    const agent = await agentIn(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const busy = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    ctx.svc.onPtyActivity(busy.ptyId, true);
    const routine = ctx.svc.saveRoutine({ name: "Notes", agentId: agent.id, schedule: { kind: "every", minutes: 5 }, prompt: "p" });
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(routine.id)!, lastFiredAt: new Date(time.now().getTime() - 2 * INTERVAL).toISOString() });
    const lastFired = ctx.svc.store.getRoutine(routine.id)!.lastFiredAt;

    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(1);
    expect(ctx.svc.store.getRoutine(routine.id)!.lastFiredAt).toBe(lastFired);
    expect(ctx.svc.listRoutines()[0].waiting?.behind).toHaveLength(1);
    await ctx.svc.tick(new Date(time.now().getTime() + 30_000));
    expect(ctx.spawns).toHaveLength(1);
    // A person in Code is never made to wait.
    await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    expect(ctx.spawns).toHaveLength(2);

    await ctx.exit(busy.ptyId);
    await ctx.exit("pty-2");
    await ctx.svc.checkWaiting();
    expect(ctx.spawns).toHaveLength(3);
    expect(ctx.svc.store.getRoutine(routine.id)!.lastFiredAt).not.toBe(lastFired);
    expect(ctx.svc.listRoutines()[0].waiting).toBeNull();
    ctx.svc.close();
  });

  it("starts a routine once after a wait that ran past its next slot", async () => {
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
    // Two more slots open while it is in line.
    for (let step = 0; step < 2; step += 1) {
      time.pass(INTERVAL);
      await ctx.svc.tick(time.now());
    }
    expect(ctx.spawns).toHaveLength(1);

    await ctx.exit(busy.ptyId);
    await ctx.svc.checkWaiting();
    expect(ctx.spawns).toHaveLength(2);
    expect(ctx.svc.store.getRoutine(routine.id)!.lastFiredAt).toBe(new Date(Math.floor(time.now().getTime() / INTERVAL) * INTERVAL).toISOString());
    await ctx.exit("pty-2");
    time.pass(30_000);
    await ctx.svc.tick(time.now());
    expect(ctx.spawns).toHaveLength(2);
    ctx.svc.close();
  });
});

describe("hand off", () => {
  it("makes a To do task for another agent from a finished run, and starts nothing", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const other = await ctx.svc.saveAgent({ name: "Reviewer", brief: "Review.", engine: "argy", places: [ctx.place] });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Dim lamp", agentId: agent.id, workspaceId: workspace.id });
    const launched = started(await ctx.svc.executeTask(task.id));
    await ctx.exit(launched.ptyId);
    const spawned = ctx.spawns.length;

    const handed = ctx.svc.handOff(launched.runId, other.id);
    expect(handed).toMatchObject({ status: "todo", agentId: other.id, workspaceId: workspace.id, sourceRunId: launched.runId, title: "Hand off: Dim lamp" });
    expect(handed.body).toContain(`Run: ${launched.runId}`);
    expect(handed.body).toContain(`Work in: ${ctx.place}`);
    expect(ctx.spawns).toHaveLength(spawned);
    // It survives a later edit.
    ctx.svc.saveTask({ id: handed.id, title: "Hand off: Dim lamp, check it" });
    expect(ctx.svc.listTasks().find((item) => item.id === handed.id)!.sourceRunId).toBe(launched.runId);
    expect(() => ctx.svc.handOff(launched.runId, "nobody")).toThrow(/agent no longer exists/);
    ctx.svc.close();
  });
});

describe("tasks", () => {
  it("never starts on save or assign, runs on execute, and lands in review on exit", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspaces = ctx.svc.addWorkspace(ctx.place);
    const task = ctx.svc.saveTask({ title: "Dim lamp", body: "Warm it", agentId: agent.id, workspaceId: workspaces.workspaces[0].id });
    expect(ctx.spawns).toHaveLength(0);
    expect(task.status).toBe("todo");
    expect(task.blocker).toBeNull();

    const launched = started(await ctx.svc.executeTask(task.id));
    expect(ctx.spawns[0].argv[2]).toContain("# This run\nTask: Dim lamp\n\nWarm it");
    expect(ctx.svc.listTasks()[0]).toMatchObject({ status: "running" });
    await expect(ctx.svc.executeTask(task.id)).rejects.toThrow(/already running/);
    await ctx.exit(launched.ptyId);
    const done = ctx.svc.listTasks()[0];
    expect(done.status).toBe("review");
    expect(done.lastRun).toMatchObject({ status: "exited", changes: "1 file changed, 1 insertion(+)" });
    expect(fs.readFileSync(path.join(done.lastRun!.dir, "git.txt"), "utf8")).toContain("git status --short");

    const again = started(await ctx.svc.executeTask(task.id));
    await ctx.svc.stopTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.svc.getRun(again.runId).run.status).toBe("stopped");
    expect(ctx.svc.listTasks()[0].status).toBe("review");
    ctx.svc.close();
  });

  it("explains why a task cannot run", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const elsewhere = tempDir();
    const file = ctx.svc.addWorkspace(elsewhere);
    const task = ctx.svc.saveTask({ title: "T", agentId: agent.id, workspaceId: file.workspaces[0].id });
    expect(task.blocker).toBe("outside-places");
    await expect(ctx.svc.executeTask(task.id)).rejects.toThrow(/allowed folders/);
    expect(ctx.svc.saveTask({ title: "No agent" }).blocker).toBe("missing-agent");
    ctx.svc.close();
  });
});

describe("runs", () => {
  it("lists finished agent, routine and task runs for review until they are opened", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const sent = await ctx.svc.sendChat(chat.id, "go");
    const plain = ctx.svc.createChat({ engine: "pasty" });
    const other = await ctx.svc.sendChat(plain.id, "go");
    expect(ctx.svc.inbox()).toEqual([]);
    await ctx.exit(sent.ptyId);
    await ctx.exit(other.ptyId);
    expect(ctx.svc.inbox().map((run) => run.id)).toEqual([sent.runId]);
    ctx.svc.markRunOpened(sent.runId);
    expect(ctx.svc.inbox()).toEqual([]);
    ctx.svc.markRunOpened(sent.runId, false);
    expect(ctx.svc.inbox()).toHaveLength(1);
    ctx.svc.close();
  });

  it("marks runs left running by a crashed session as stopped and snapshots git", async () => {
    const configRoot = tempDir();
    const dataRoot = tempDir();
    const store = new Store(configRoot, dataRoot);
    const { id, dir } = allocateRunDir(dataRoot, new Date(), "orphan");
    const meta = normalizeRun({ id, dir, origin: "task", status: "running", startedAt: new Date().toISOString(), cwd: dataRoot, title: "Orphan" }) as RunMeta;
    writeRunMeta(meta);
    store.saveRun(meta);
    store.close();
    const ctx = setup({ configRoot, dataRoot });
    await ctx.svc.whenSettled();
    const run = ctx.svc.getRun(id).run;
    expect(run.status).toBe("stopped");
    expect(run.error).toMatch(/closed while this run was going/);
    expect(fs.existsSync(path.join(dir, "git.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "diff.patch"), "utf8")).toMatch(/next opened/);
    ctx.svc.close();
  });

  it("tidies runs: compresses them, and removes old ones Settings don't keep, but not a chat's latest", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const sent = await ctx.svc.sendChat(chat.id, "hello");
    await ctx.exit(sent.ptyId);
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const chatRun = ctx.svc.getRun(sent.runId).run;
    ctx.svc.store.saveRun({ ...chatRun, startedAt: longAgo, endedAt: longAgo, openedAt: longAgo });
    fs.writeFileSync(path.join(chatRun.dir, "scrollback.txt"), "x".repeat(64 * 1024));
    const old = (name: string, extra: Partial<RunMeta> = {}) => {
      const { id, dir } = allocateRunDir(ctx.dataRoot, new Date(longAgo), name);
      ctx.svc.store.saveRun(normalizeRun({ id, dir, origin: "code", status: "exited", startedAt: longAgo, endedAt: longAgo, openedAt: longAgo, title: name, ...extra }) as RunMeta);
      return { id, dir };
    };
    const gone = old("gone");
    const fresh = old("fresh", { startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });

    // Nothing is removed until Settings say so; the scrollback is compressed either way.
    expect(await ctx.svc.maintainRuns()).toMatchObject({ compressed: 1, removed: 0 });
    expect(fs.existsSync(path.join(chatRun.dir, "scrollback.txt.gz"))).toBe(true);
    // No screen was saved, so the scrollback is what opens, read back from the .gz.
    expect(ctx.svc.getRun(chatRun.id).files.scrollback).toBe("x".repeat(64 * 1024));

    ctx.svc.saveSettings({ keepRuns: { days: 30, maxMb: 0 } });
    expect(await ctx.svc.maintainRuns()).toMatchObject({ removed: 1 });
    expect(fs.existsSync(gone.dir)).toBe(false);
    expect(() => ctx.svc.getRun(gone.id)).toThrow(/no longer exists/);
    expect(ctx.svc.getRun(fresh.id).run.id).toBe(fresh.id);
    expect(ctx.svc.getRun(chatRun.id).run.id).toBe(chatRun.id);
    expect(ctx.svc.storageSummary()).toMatchObject({ runCount: 2, dataRoot: ctx.dataRoot });
    ctx.svc.close();
  });

  it("finds runs by the words in their transcript, including runs from before search", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const sent = await ctx.svc.sendChat(chat.id, "Look at the sign-in page");
    const dir = ctx.svc.getRun(sent.runId).run.dir;
    fs.writeFileSync(path.join(dir, "transcript.txt"), "Reading login.ts…\nFixed the authentication bug: the token was never refreshed.\n");
    await ctx.exit(sent.ptyId);

    // A run the index has never seen, as after an update.
    const { id: oldId, dir: oldDir } = allocateRunDir(ctx.dataRoot, new Date(Date.now() - 86_400_000), "older");
    fs.writeFileSync(path.join(oldDir, "transcript.txt"), "Moved the settings page to Svelte.\n");
    ctx.svc.store.saveRun(normalizeRun({ id: oldId, dir: oldDir, origin: "code", status: "exited", startedAt: new Date().toISOString(), title: "Older", cwd: "/work/site" }) as RunMeta);

    const hits = ctx.svc.searchRuns("auth refresh");
    expect(hits.map((hit) => hit.id)).toEqual([sent.runId]);
    const marked = snippetParts(hits[0].snippet).filter((part) => part.hit).map((part) => part.text.toLowerCase());
    expect(marked).toEqual(expect.arrayContaining(["authentication", "refreshed"]));
    expect(ctx.svc.searchRuns("svelte").map((hit) => hit.id)).toEqual([oldId]);
    // Folders match as typed.
    expect(ctx.svc.searchRuns("/work/site").map((hit) => hit.id)).toEqual([oldId]);
    expect(ctx.svc.searchRuns("nothing like this")).toEqual([]);
    expect(ctx.svc.searchRuns("  \"*  ")).toEqual([]);
    ctx.svc.store.deleteRun(ctx.svc.store.getRun(oldId)!);
    expect(ctx.svc.searchRuns("svelte")).toEqual([]);
    ctx.svc.close();
  });

  it("turns typed words into a safe full-text query", () => {
    expect(matchExpression("auth  bug")).toBe('"auth"* "bug"*');
    expect(matchExpression('he said "NEAR(" OR x')).toBe('"he"* "said"* "NEAR"* "OR"* "x"*');
    expect(matchExpression("löschen 設定")).toBe('"löschen"* "設定"*');
    expect(matchExpression("--- ...")).toBeNull();
  });

  it("runs an isolated task in its own worktree, then applies its changes to the workspace", async () => {
    const repo = tempDir();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "init");

    const ctx = setup();
    ctx.host.gitHead = (cwd) => gitHead(cwd);
    ctx.host.snapshotGit = (cwd, start) => snapshotGit(cwd, 5000, start);
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [repo] });
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Edit", body: "Change a", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    expect(task.isolated).toBe(true);

    const launched = started(await ctx.svc.executeTask(task.id));
    const copy = ctx.svc.listTasks().find((item) => item.id === task.id)!.copy!;
    expect(copy.path).toBe(path.join(ctx.dataRoot, "worktrees", task.id));
    expect(ctx.spawns[0].cwd).toBe(copy.path);
    const preamble = ctx.spawns[0].argv.slice(2).join(" ");
    expect(preamble).toContain(`own git worktree of ${repo}`);
    // The agent edits, commits one change and leaves another uncommitted, and adds a file.
    fs.writeFileSync(path.join(copy.path, "a.txt"), "one\nTWO\n");
    git(copy.path, "commit", "-qam", "agent commit");
    fs.writeFileSync(path.join(copy.path, "b.txt"), "new file\n");
    await ctx.exit(launched.ptyId);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await ctx.svc.runDiff(launched.runId)).toContain("+TWO");

    const applied = await ctx.svc.applyTaskCopy(task.id);
    expect(applied).toEqual({ files: ["a.txt", "b.txt"], conflicts: [] });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\nTWO\n");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("new file\n");
    // Uncommitted in the workspace, for you to review and commit.
    expect(git(repo, "log", "--oneline").trim().split("\n")).toHaveLength(1);
    expect(fs.existsSync(copy.path)).toBe(false);
    expect(git(repo, "branch", "--list", "vibeforge/*").trim()).toBe("");
    const done = ctx.svc.listTasks().find((item) => item.id === task.id)!;
    expect(done).toMatchObject({ status: "done", copy: null });

    // Another copy, while the workspace changes the same line: a conflict to resolve, copy kept.
    git(repo, "commit", "-qam", "took the change");
    const second = ctx.svc.saveTask({ title: "Again", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    const again = started(await ctx.svc.executeTask(second.id));
    const secondCopy = ctx.svc.listTasks().find((item) => item.id === second.id)!.copy!;
    fs.writeFileSync(path.join(secondCopy.path, "a.txt"), "one\nfrom the copy\n");
    await ctx.exit(again.ptyId);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nfrom the workspace\n");
    git(repo, "commit", "-qam", "meanwhile");
    const clash = await ctx.svc.applyTaskCopy(second.id);
    expect(clash.conflicts).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toContain("<<<<<<<");
    expect(fs.existsSync(secondCopy.path)).toBe(true);
    await ctx.svc.discardTaskCopy(second.id);
    expect(fs.existsSync(secondCopy.path)).toBe(false);
    expect(ctx.svc.listTasks().find((item) => item.id === second.id)!.copy).toBeNull();

    // A folder that isn't a repository can't have a copy.
    const plain = tempDir();
    const plainAgent = await ctx.svc.saveAgent({ name: "Plain", brief: "b", engine: "argy", places: [plain] });
    const plainSpace = ctx.svc.addWorkspace(plain).workspaces.find((item) => item.path === plain)!;
    const third = ctx.svc.saveTask({ title: "Nope", agentId: plainAgent.id, workspaceId: plainSpace.id, isolated: true });
    await expect(ctx.svc.executeTask(third.id)).rejects.toThrow(/git repository/);
    ctx.svc.close();
  });

  it("never stages, applies or deletes a copy path that isn't the task's own worktree", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
    const repo = tempDir();
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "init");
    git(repo, "branch", "vibeforge/keep");
    // Someone's real work, uncommitted.
    fs.writeFileSync(path.join(repo, "work.txt"), "precious\n");

    const ctx = setup();
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "b", engine: "argy", places: [repo] });
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const file = (id: string) => path.join(ctx.configRoot, "tasks", `${id}.yaml`);
    // As if someone, or an agent, edited the task file by hand.
    const pointAt = (id: string, copyPath: string, branch = `vibeforge/${id}`) => {
      const yaml = fs.readFileSync(file(id), "utf8").replace(/^copy:.*\n(?:  .*\n)*/m, "");
      fs.writeFileSync(file(id), `${yaml}copy:\n  path: ${copyPath}\n  branch: ${branch}\n  base: ${git(repo, "rev-parse", "HEAD").trim()}\n  repo: ${repo}\n`);
    };

    // The task file points its copy at the real checkout.
    const task = ctx.svc.saveTask({ title: "Hostile", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    pointAt(task.id, repo, "vibeforge/keep");
    const view = ctx.svc.listTasks().find((item) => item.id === task.id)!;
    expect(view.copy?.path).toBe(repo);
    expect(view.copyOwned).toBe(false);
    await expect(ctx.svc.applyTaskCopy(task.id)).rejects.toThrow(/left alone/);
    expect(git(repo, "status", "--porcelain")).toBe("?? work.txt\n");
    await expect(ctx.svc.executeTask(task.id)).rejects.toThrow(/left alone/);
    expect(ctx.spawns).toHaveLength(0);
    // Discard only forgets the record.
    await ctx.svc.discardTaskCopy(task.id);
    expect(ctx.svc.listTasks().find((item) => item.id === task.id)!.copy).toBeNull();
    expect(fs.readFileSync(path.join(repo, "work.txt"), "utf8")).toBe("precious\n");
    expect(git(repo, "branch", "--list", "vibeforge/keep").trim()).not.toBe("");

    // Delete takes the task file and leaves the folder it pointed at.
    pointAt(task.id, repo, "vibeforge/keep");
    const deleted = await ctx.svc.deleteTask(task.id);
    expect(deleted.copyLeft).toBe(true);
    expect(fs.existsSync(file(task.id))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "work.txt"), "utf8")).toBe("precious\n");
    ctx.svc.undoDelete(deleted.undo);
    expect(fs.existsSync(file(task.id))).toBe(true);

    // A symlink where the worktree should be, pointing at the real checkout, isn't the copy either.
    const second = ctx.svc.saveTask({ title: "Linked", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    const linked = path.join(ctx.dataRoot, "worktrees", second.id);
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(repo, linked);
    pointAt(second.id, linked);
    expect(ctx.svc.listTasks().find((item) => item.id === second.id)!.copyOwned).toBe(false);
    await expect(ctx.svc.applyTaskCopy(second.id)).rejects.toThrow(/left alone/);
    const gone = await ctx.svc.deleteTask(second.id);
    expect(gone.copyLeft).toBe(true);
    expect(fs.readFileSync(path.join(repo, "work.txt"), "utf8")).toBe("precious\n");
    expect(git(repo, "status", "--porcelain")).toBe("?? work.txt\n");

    // The right path, already gone: discarding tidies the task's own branch and nothing else.
    const third = ctx.svc.saveTask({ title: "Gone", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    git(repo, "branch", `vibeforge/${third.id}`);
    pointAt(third.id, path.join(ctx.dataRoot, "worktrees", third.id));
    expect(ctx.svc.listTasks().find((item) => item.id === third.id)!.copyOwned).toBe(true);
    await ctx.svc.discardTaskCopy(third.id);
    expect(git(repo, "branch", "--list", `vibeforge/${third.id}`).trim()).toBe("");
    expect(git(repo, "branch", "--list", "vibeforge/keep").trim()).not.toBe("");
    expect(fs.readFileSync(path.join(repo, "work.txt"), "utf8")).toBe("precious\n");

    // The task's own worktree, with `repo` naming some other repository: git is never run there.
    const other = tempDir();
    git(other, "init", "-q");
    fs.writeFileSync(path.join(other, "a.txt"), "theirs\n");
    git(other, "add", "a.txt");
    git(other, "commit", "-qm", "init");
    const fourth = ctx.svc.saveTask({ title: "Elsewhere", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    git(other, "branch", `vibeforge/${fourth.id}`);
    const own = path.join(ctx.dataRoot, "worktrees", fourth.id);
    git(repo, "worktree", "add", "-q", "-b", `vibeforge/${fourth.id}`, own);
    fs.writeFileSync(path.join(own, "a.txt"), "changed\n");
    const base = git(repo, "rev-parse", "HEAD").trim();
    const yaml = fs.readFileSync(file(fourth.id), "utf8").replace(/^copy:.*\n(?:  .*\n)*/m, "");
    fs.writeFileSync(file(fourth.id), `${yaml}copy:\n  path: ${own}\n  branch: vibeforge/${fourth.id}\n  base: ${base}\n  repo: ${other}\n`);
    expect(ctx.svc.listTasks().find((item) => item.id === fourth.id)!.copyOwned).toBe(true);
    await expect(ctx.svc.applyTaskCopy(fourth.id)).rejects.toThrow(/another repository/);
    await expect(ctx.svc.executeTask(fourth.id)).rejects.toThrow(/another repository/);
    await ctx.svc.discardTaskCopy(fourth.id);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.readFileSync(path.join(other, "a.txt"), "utf8")).toBe("theirs\n");
    expect(git(other, "status", "--porcelain")).toBe("");
    expect(git(other, "branch", "--list", `vibeforge/${fourth.id}`).trim()).not.toBe("");
    ctx.svc.close();
  });

  it("freezes the patch when a run ends, and keeps it after the folder changes", async () => {
    const repo = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");

    const ctx = setup();
    ctx.host.gitHead = (cwd) => gitHead(cwd);
    ctx.host.snapshotGit = (cwd, start) => snapshotGit(cwd, 5000, start);
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [repo] });
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Edit", body: "Change a", agentId: agent.id, workspaceId: workspace.id });
    const launched = started(await ctx.svc.executeTask(task.id));
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nsession-line-two\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "brand-new-file\n");

    const mid = ctx.svc.getRun(launched.runId);
    expect(mid.files.patchSaved).toBe(false);
    expect(await ctx.svc.runDiff(launched.runId)).toContain("+brand-new-file");

    await ctx.exit(launched.ptyId);
    const done = ctx.svc.getRun(launched.runId);
    expect(done.files.patchSaved).toBe(true);
    expect(done.run.status).toBe("exited");
    const saved = fs.readFileSync(path.join(done.run.dir, "diff.patch"), "utf8");
    expect(saved).toContain("diff --git a/a.txt b/a.txt");
    expect(saved).toContain("+session-line-two");
    expect(saved).toContain("diff --git a/new.txt b/new.txt");
    expect(saved).toContain("+brand-new-file");
    expect(saved).not.toContain("session-line-three");
    expect(saved).not.toMatch(/next opened/);

    fs.writeFileSync(path.join(repo, "a.txt"), "one\nsession-line-two\nsession-line-three\n");
    expect(await ctx.svc.runDiff(launched.runId)).toBe(saved);
    expect(await ctx.svc.runDiff(launched.runId, "now")).toContain("+session-line-three");
    expect(await ctx.svc.runDiff(launched.runId)).not.toContain("session-line-three");
    ctx.svc.close();
  });

  it("sends a crashed task to review only while the orphan is still its run", async () => {
    const configRoot = tempDir();
    const dataRoot = tempDir();
    const store = new Store(configRoot, dataRoot);
    const orphan = (label: string) => {
      const { id, dir } = allocateRunDir(dataRoot, new Date(), label);
      const meta = normalizeRun({ id, dir, origin: "task", status: "running", startedAt: new Date().toISOString(), cwd: dataRoot, title: label, taskId: label }) as RunMeta;
      writeRunMeta(meta);
      store.saveRun(meta);
      return id;
    };
    const stamp = new Date().toISOString();
    const task = (id: string, runIds: string[]) =>
      store.writeTask({ id, title: id, body: "", status: "running", agentId: null, workspaceId: null, runIds, isolated: false, copy: null, shareCheckout: false, sourceRunId: null, createdAt: stamp, updatedAt: stamp });
    task("crashed", [orphan("crashed")]);
    // Its latest run is a newer one, as after an Execute that raced the settling.
    task("restarted", [orphan("restarted"), "a-newer-run"]);
    store.close();
    const ctx = setup({ configRoot, dataRoot });
    await ctx.svc.whenSettled();
    const status = (id: string) => ctx.svc.listTasks().find((item) => item.id === id)?.status;
    expect(status("crashed")).toBe("review");
    expect(status("restarted")).toBe("running");
    ctx.svc.close();
  });

  it("records runs that were live at shutdown as stopped", async () => {
    const ctx = setup();
    const chat = ctx.svc.createChat({ engine: "pasty" });
    const sent = await ctx.svc.sendChat(chat.id, "long job");
    ctx.svc.prepareShutdown();
    await ctx.exit(sent.ptyId);
    await ctx.svc.whenIdle();
    expect(ctx.svc.getRun(sent.runId).run.status).toBe("stopped");
    ctx.svc.close();
  });

  it("records a CLI typed into a workspace shell as a Code run, from start to prompt", async () => {
    const ctx = setup();
    const file = ctx.svc.addWorkspace(ctx.place);
    const { ptyId } = await ctx.svc.startShell({ workspaceId: file.workspaces[0].id });
    const edited = ctx.host.snapshotGit;
    ctx.host.snapshotGit = async () => "git status --short\n\n\ngit diff --stat\n";
    ctx.svc.onPtyProgram(ptyId, ["vim", "notes.md"], ctx.place);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.svc.listRuns()).toEqual([]);

    ctx.svc.onPtyProgram(ptyId, ["/usr/bin/argy", "--model", "big"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    const [run] = ctx.svc.listRuns();
    expect(run).toMatchObject({ origin: "code", engine: "argy", status: "running", live: true, ptyId, workspaceId: file.workspaces[0].id, gitStart: "abc1234" });
    expect(run.argv).toEqual(["/usr/bin/argy", "--model", "big"]);
    expect(ctx.recorded).toEqual([{ ptyId, runDir: run.dir }]);

    ctx.host.snapshotGit = edited;
    ctx.svc.onPtyProgram(ptyId, null);
    await until(() => ctx.svc.getRun(run.id).run.status === "exited");
    expect(ctx.recorded.at(-1)).toEqual({ ptyId, runDir: null });
    expect(ctx.svc.listLive()[0]).toMatchObject({ ptyId, runId: null });
    expect(ctx.svc.getRun(run.id).run).toMatchObject({ live: false, changes: "1 file changed, 1 insertion(+)" });
    // It changed something, so it waits for review.
    expect(ctx.svc.inbox().map((item) => item.id)).toEqual([run.id]);
    ctx.svc.close();
  });

  it("forgets a CLI that came and went without changing anything, and finishes one whose shell closed", async () => {
    const ctx = setup();
    const file = ctx.svc.addWorkspace(ctx.place);
    const { ptyId } = await ctx.svc.startShell({ workspaceId: file.workspaces[0].id });
    // The tree was already dirty before it started; the same snapshot after means it changed nothing.
    ctx.host.snapshotGit = async () => "git status --short\n M old.txt\n\ngit diff --stat\n old.txt | 2 +-\n";
    ctx.svc.onPtyProgram(ptyId, ["argy", "--version"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    const blip = ctx.svc.listRuns()[0];
    ctx.svc.onPtyProgram(ptyId, null);
    await until(() => ctx.svc.listRuns().length === 0);
    expect(fs.existsSync(blip.dir)).toBe(false);

    ctx.svc.onPtyProgram(ptyId, ["pasty"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0]?.runId));
    const run = ctx.svc.listRuns()[0];
    await ctx.exit(ptyId);
    expect(ctx.svc.getRun(run.id).run.status).toBe("exited");
    // Watched as it happened and changed nothing: not for review.
    expect(ctx.svc.inbox()).toEqual([]);
    ctx.svc.close();
  });

  it("counts only a coding CLI as working", async () => {
    const ctx = setup();
    const file = ctx.svc.addWorkspace(ctx.place);
    const { ptyId } = await ctx.svc.startShell({ workspaceId: file.workspaces[0].id });
    ctx.svc.onPtyActivity(ptyId, true);
    expect(ctx.svc.listLive()[0].working).toBeFalsy();
    ctx.svc.onPtyProgram(ptyId, ["argy"], ctx.place);
    ctx.svc.onPtyActivity(ptyId, true);
    expect(ctx.svc.listLive()[0].working).toBe(true);
    ctx.svc.onPtyActivity(ptyId, false);
    expect(ctx.svc.listLive()[0].working).toBe(false);
    ctx.svc.onPtyActivity(ptyId, true);
    ctx.svc.onPtyProgram(ptyId, null);
    expect(ctx.svc.listLive()[0].working).toBe(false);
    ctx.svc.close();
  });

  it("keeps a CLI working when it starts while the shell is already busy", async () => {
    // `argy "fix the tests"` typed at the prompt: the host marks the pty working while the line
    // is typed and never says so again, because the CLI carries on with no quiet gap.
    const ctx = setup();
    const file = ctx.svc.addWorkspace(ctx.place);
    const { ptyId } = await ctx.svc.startShell({ workspaceId: file.workspaces[0].id });
    ctx.svc.onPtyActivity(ptyId, true);
    ctx.svc.onPtyProgram(ptyId, ["argy", "fix the tests"], ctx.place);
    expect(ctx.svc.listLive()[0].working).toBe(true);
    ctx.svc.onPtyActivity(ptyId, false);
    expect(ctx.svc.listLive()[0].working).toBe(false);
    ctx.svc.close();
  });

  it("fails a run cleanly when the process cannot start", async () => {
    const ctx = setup();
    ctx.host.spawn = async () => {
      throw new Error("ENOENT");
    };
    const chat = ctx.svc.createChat({ engine: "pasty" });
    await expect(ctx.svc.sendChat(chat.id, "hi")).rejects.toThrow(/Could not start Pasty: ENOENT/);
    const [run] = ctx.svc.listRuns();
    expect(run).toMatchObject({ status: "failed", error: "ENOENT" });
    ctx.svc.close();
  });
});

describe("change events", () => {
  it("batches topics per tick for the renderer", async () => {
    const ctx = setup();
    const seen: string[][] = [];
    ctx.svc.onChange((topics) => seen.push([...topics].sort()));
    ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    ctx.svc.addWorkspace(ctx.place);
    await Promise.resolve();
    expect(seen).toEqual([["agents", "routines", "tasks", "workspaces"]]);
    ctx.svc.close();
  });
});
