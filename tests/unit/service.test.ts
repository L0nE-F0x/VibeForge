import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocateRunDir, normalizeRun, writeRunMeta } from "../../src/core/runs.js";
import { Store } from "../../src/core/store.js";
import { TeamService, type DeskHost, type SpawnRequest } from "../../src/core/team-service.js";
import type { RunMeta } from "../../src/core/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-svc-"));
}

const INTERVAL = 5 * 60 * 1000;

/** A PTY host that records what the service asks of it; tests end processes with `exit`. */
function setup(opts: { appStartedAt?: Date; configRoot?: string; dataRoot?: string } = {}) {
  const configRoot = opts.configRoot ?? tempDir();
  const dataRoot = opts.dataRoot ?? tempDir();
  const place = tempDir();
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "engines.json"),
    JSON.stringify({
      engines: [
        { id: "argy", label: "Argy", bin: "argy", args: ["--flag"], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
        { id: "pasty", label: "Pasty", bin: "pasty", args: [] },
        { id: "gone", label: "Gone", bin: "gone", args: [] },
      ],
    }),
  );
  const spawns: SpawnRequest[] = [];
  const sent: Array<{ ptyId: string; text: string }> = [];
  const killed: string[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  let n = 0;
  let svc: TeamService;
  const host: DeskHost = {
    async spawn(request) {
      n += 1;
      spawns.push(request);
      return { ptyId: `pty-${n}`, pid: 1000 + n };
    },
    async send(ptyId, text) {
      sent.push({ ptyId, text });
    },
    async kill(ptyId) {
      killed.push(ptyId);
      // A killed process reports its exit a moment later, like the real host.
      setTimeout(() => void svc.onPtyExit(ptyId, 0, 1), 5);
    },
    resolveBin: (bin) => (bin === "argy" || bin === "pasty" ? `/usr/bin/${bin}` : null),
    notify: (note) => notes.push(note),
    snapshotGit: async () => "git status --short\n M a.txt\n\ngit diff --stat\n a.txt | 1 +\n 1 file changed, 1 insertion(+)\n",
    gitHead: async () => "abc1234",
  };
  svc = new TeamService({ configRoot, dataRoot, appStartedAt: opts.appStartedAt ?? new Date(9 * INTERVAL), now: () => new Date(), host });
  const exit = (ptyId: string, code = 0) => svc.onPtyExit(ptyId, code, null);
  return { svc, host, spawns, sent, killed, notes, place, configRoot, dataRoot, exit };
}

async function agentIn(ctx: ReturnType<typeof setup>, engine = "argy") {
  return ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine, places: [ctx.place] });
}

describe("agents", () => {
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
    const launched = await ctx.svc.runRoutineNow(routine.id);
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

describe("tasks", () => {
  it("never starts on save or assign, runs on execute, and lands in review on exit", async () => {
    const ctx = setup();
    const agent = await agentIn(ctx);
    const workspaces = ctx.svc.addWorkspace(ctx.place);
    const task = ctx.svc.saveTask({ title: "Dim lamp", body: "Warm it", agentId: agent.id, workspaceId: workspaces.workspaces[0].id });
    expect(ctx.spawns).toHaveLength(0);
    expect(task.status).toBe("todo");
    expect(task.blocker).toBeNull();

    const launched = await ctx.svc.executeTask(task.id);
    expect(ctx.spawns[0].argv[2]).toContain("# This run\nTask: Dim lamp\n\nWarm it");
    expect(ctx.svc.listTasks()[0]).toMatchObject({ status: "running" });
    await expect(ctx.svc.executeTask(task.id)).rejects.toThrow(/already running/);
    await ctx.exit(launched.ptyId);
    const done = ctx.svc.listTasks()[0];
    expect(done.status).toBe("review");
    expect(done.lastRun).toMatchObject({ status: "exited", changes: "1 file changed, 1 insertion(+)" });
    expect(fs.readFileSync(path.join(done.lastRun!.dir, "git.txt"), "utf8")).toContain("git status --short");

    const again = await ctx.svc.executeTask(task.id);
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
