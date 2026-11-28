import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import { setup, until } from "./fixtures/service-harness.js";

// CLIs a close of VibeForge cut off: which session each was in, and picking them back up after.

const A = "0f8e0a52-1c2d-4e3f-9a8b-7c6d5e4f3a2b";
const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** The harness's CLIs, plus one VibeForge reads session logs for (Claude Code, by its id). */
function withClaude(ctx: ReturnType<typeof setup>) {
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] });
  fs.writeFileSync(file, JSON.stringify(engines));
}

describe("a CLI typed into a Code shell, cut off by a quit", () => {
  it("is offered back in its pane after the restart, and Continue types its exact session into the shell", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const { ptyId } = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    ctx.svc.onPtyProgram(ptyId, ["/usr/bin/argy", "--model", "big", "fix the build"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    const [run] = ctx.svc.listRuns();
    expect(run.paneId).toBe("p1");
    // The CLI said which session it is in (the log reader would have found it too).
    fs.writeFileSync(path.join(run.dir, "transcript.txt"), "working…\nargy --resume sess-12345678\n");

    ctx.svc.prepareShutdown("quit");
    await ctx.exit(ptyId);
    await ctx.svc.whenIdle();
    expect(ctx.svc.getRun(run.id).run).toMatchObject({ status: "stopped", cutOff: "quit" });
    ctx.svc.close();

    // The next start.
    const next = setup({ configRoot: ctx.configRoot, dataRoot: ctx.dataRoot });
    await next.svc.whenSettled();
    const offered = (await next.svc.cutOffRuns());
    expect(offered).toMatchObject({ reason: "quit", runs: [{ runId: run.id, paneId: "p1", workspaceId: workspace.id, exact: true }] });

    const shell = await next.svc.startShell({ workspaceId: workspace.id, paneId: "p1", continueRun: run.id });
    // Argy's own options aren't known to be safe to repeat, so only its session goes in.
    expect(next.spawns.at(-1)?.pasteInput).toBe("argy --resume sess-12345678");
    next.svc.onPtyProgram(shell.ptyId, ["/usr/bin/argy", "--model", "big", "--resume", "sess-12345678"], next.place);
    await until(() => Boolean(next.svc.listLive()[0]?.runId));
    const again = next.svc.listRuns().find((item) => item.id !== run.id);
    expect(again).toMatchObject({ continuedFrom: run.id, paneId: "p1" });
    // Picked back up: no longer offered.
    expect((await next.svc.cutOffRuns())).toBeNull();
    next.svc.close();
  });

  it("types into a shell that is already back at its prompt, and refuses one with a CLI in it", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    ctx.svc.onPtyProgram(first.ptyId, ["argy"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    const [run] = ctx.svc.listRuns();
    ctx.svc.prepareShutdown("quit");
    await ctx.exit(first.ptyId);
    await ctx.svc.whenIdle();

    const shell = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    // Its exact session isn't known, so the CLI's own continue flag.
    await ctx.svc.reopenInShell(shell.ptyId, run.id);
    expect(ctx.sent.at(-1)).toEqual({ ptyId: shell.ptyId, text: "argy --continue" });
    ctx.svc.onPtyProgram(shell.ptyId, ["argy", "--continue"], ctx.place);
    await until(() => ctx.svc.listLive().some((item) => item.ptyId === shell.ptyId && item.runId));
    await expect(ctx.svc.reopenInShell(shell.ptyId, run.id)).rejects.toThrow(/already running/);
    ctx.svc.close();
  });
});

describe("a CLI started in a Code pane", () => {
  it("records its pane, and Continue there picks up that pane's own session, not the folder's latest", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const left = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy", paneId: "left" });
    const right = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy", paneId: "right" });
    fs.writeFileSync(path.join(ctx.svc.getRun(left.runId).run.dir, "transcript.txt"), "argy --resume left-session-1\n");
    fs.writeFileSync(path.join(ctx.svc.getRun(right.runId).run.dir, "transcript.txt"), "argy --resume right-session-1\n");
    await ctx.exit(left.ptyId);
    await ctx.exit(right.ptyId);
    await ctx.svc.whenIdle();
    // The right one ended last, but the left pane gets its own back.
    await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy", paneId: "left", continueSession: true });
    expect(ctx.spawns.at(-1)?.argv).toEqual(["/usr/bin/argy", "--flag", "--resume", "left-session-1"]);
    ctx.svc.close();
  });
});

describe("reading which session each live CLI is in", () => {
  it("shares two Claude Codes in one folder out by which one was working, and keeps it on their runs", async () => {
    const ctx = setup();
    withClaude(ctx);
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const one = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "claude", paneId: "a" });
    const two = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "claude", paneId: "b" });
    const later = Date.now() + 60_000;
    let logs: Array<{ file: string; mtimeMs: number }> = [];
    const asked: Array<{ kind: string; cwd: string }> = [];
    ctx.host.sessionLogs = async (opts) => {
      asked.push({ kind: opts.kind, cwd: opts.cwd });
      return logs;
    };

    // One works and its session's log appears.
    ctx.svc.onPtyActivity(one.ptyId, true);
    logs = [{ file: `/c/projects/app/${A}.jsonl`, mtimeMs: later }];
    await ctx.svc.lookForSessions();
    expect(asked[0]).toEqual({ kind: "claude", cwd: ctx.place });
    expect(ctx.svc.getRun(one.runId).run.resumeArgs).toEqual(["--resume", A]);
    expect(ctx.svc.getRun(two.runId).run.resumeArgs).toBeUndefined();

    // It goes quiet (a look passes), then the other works.
    ctx.svc.onPtyActivity(one.ptyId, false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.svc.lookForSessions();
    ctx.svc.onPtyActivity(two.ptyId, true);
    logs = [
      { file: `/c/projects/app/${A}.jsonl`, mtimeMs: later },
      { file: `/c/projects/app/${B}.jsonl`, mtimeMs: later + 1000 },
    ];
    await ctx.svc.lookForSessions();
    expect(ctx.svc.getRun(two.runId).run.resumeArgs).toEqual(["--resume", B]);
    expect(ctx.svc.getRun(one.runId).run.resumeArgs).toEqual(["--resume", A]);

    // Cut off by a quit: each reopens its own, exactly.
    ctx.svc.prepareShutdown("update");
    await ctx.exit(one.ptyId);
    await ctx.exit(two.ptyId);
    await ctx.svc.whenIdle();
    expect((await ctx.svc.cutOffRuns())).toMatchObject({ reason: "update", runs: [{ runId: one.runId, exact: true }, { runId: two.runId, exact: true }] });
    await ctx.svc.continueRun(two.runId);
    expect(ctx.spawns.at(-1)?.argv).toEqual(["/usr/bin/argy", "--resume", B]);
    expect((await ctx.svc.cutOffRuns())?.runs.map((item) => item.runId)).toEqual([one.runId]);
    ctx.svc.close();
  });
});

describe("a run left going when VibeForge went down", () => {
  it("is offered back at the next start as cut off by a crash", async () => {
    const first = setup();
    const chat = first.svc.createChat({ engine: "argy" });
    const sent = await first.svc.sendChat(chat.id, "long job");
    // No quit: the process just went.
    const { configRoot, dataRoot } = first;
    const store = new Store(configRoot, dataRoot);
    expect(store.getRun(sent.runId)?.status).toBe("running");
    store.close();
    const next = setup({ configRoot, dataRoot });
    await next.svc.whenSettled();
    expect(next.svc.getRun(sent.runId).run).toMatchObject({ status: "stopped", cutOff: "crash" });
    expect((await next.svc.cutOffRuns())).toMatchObject({ reason: "crash", runs: [{ runId: sent.runId, chatId: chat.id }] });
    next.svc.settleCutOff([sent.runId]);
    expect((await next.svc.cutOffRuns())).toBeNull();
    next.svc.close();
    first.svc.close();
  });
});

describe("offers that stay right", () => {
  it("is ready the moment the window asks after a crash, before the leftover runs are settled", async () => {
    const first = setup();
    const chat = first.svc.createChat({ engine: "argy" });
    const sent = await first.svc.sendChat(chat.id, "long job");
    const next = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot });
    // No whenSettled first: the window asks as soon as it opens.
    expect(await next.svc.cutOffRuns()).toMatchObject({ reason: "crash", runs: [{ runId: sent.runId }] });
    next.svc.close();
    first.svc.close();
  });

  it("keeps an update's reason and all its runs when one of them wasn't recorded before VibeForge went", async () => {
    const first = setup();
    const a = await first.svc.sendChat(first.svc.createChat({ engine: "argy" }).id, "one");
    const b = await first.svc.sendChat(first.svc.createChat({ engine: "argy" }).id, "two");
    first.svc.prepareShutdown("update");
    await first.exit(a.ptyId);
    await first.svc.whenIdle();
    // b's exit never arrives: it is still "running" at the next start.
    const next = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot });
    const offered = await next.svc.cutOffRuns();
    expect(offered?.reason).toBe("update");
    expect(offered?.runs.map((run) => run.runId).sort()).toEqual([a.runId, b.runId].sort());
    next.svc.close();
    first.svc.close();
  });

  it("offers a close's runs at the next start only, not again after one where they were ignored", async () => {
    const first = setup();
    const sent = await first.svc.sendChat(first.svc.createChat({ engine: "argy" }).id, "job");
    first.svc.prepareShutdown("quit");
    await first.exit(sent.ptyId);
    await first.svc.whenIdle();
    first.svc.close();
    const second = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot });
    expect((await second.svc.cutOffRuns())?.runs).toHaveLength(1);
    // Ignored, then VibeForge went down with nothing running.
    second.svc.close();
    const third = setup({ configRoot: first.configRoot, dataRoot: first.dataRoot });
    expect(await third.svc.cutOffRuns()).toBeNull();
    third.svc.close();
  });

  it("types the command once however many times Continue is pressed, and starts a session once", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    ctx.svc.onPtyProgram(first.ptyId, ["argy"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    const [run] = ctx.svc.listRuns();
    ctx.svc.prepareShutdown("quit");
    await ctx.exit(first.ptyId);
    await ctx.svc.whenIdle();

    const shell = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    await Promise.all([ctx.svc.reopenInShell(shell.ptyId, run.id), ctx.svc.reopenInShell(shell.ptyId, run.id)]);
    expect(ctx.sent.filter((item) => item.ptyId === shell.ptyId)).toHaveLength(1);

    // Continue on a run another Continue already picked up goes to that one.
    const chat = ctx.svc.createChat({ engine: "argy" });
    const job = await ctx.svc.sendChat(chat.id, "job");
    await ctx.exit(job.ptyId);
    await ctx.svc.whenIdle();
    const spawned = ctx.spawns.length;
    const one = await ctx.svc.continueRun(job.runId);
    const two = await ctx.svc.continueRun(job.runId);
    expect(two.ptyId).toBe(one.ptyId);
    expect(ctx.spawns.length).toBe(spawned + 1);
    ctx.svc.close();
  });

  it("lets a pane's offer go once the person starts a CLI of their own there", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    ctx.svc.onPtyProgram(first.ptyId, ["argy"], ctx.place);
    await until(() => Boolean(ctx.svc.listLive()[0].runId));
    ctx.svc.prepareShutdown("quit");
    await ctx.exit(first.ptyId);
    await ctx.svc.whenIdle();
    expect(await ctx.svc.cutOffRuns()).not.toBeNull();
    const shell = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1" });
    ctx.svc.onPtyProgram(shell.ptyId, ["pasty"], ctx.place);
    await until(() => ctx.svc.listLive().some((item) => item.ptyId === shell.ptyId && item.runId));
    expect(await ctx.svc.cutOffRuns()).toBeNull();
    ctx.svc.close();
  });

  it("still brings a pane's shell back when its session can't be reopened", async () => {
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const started = await ctx.svc.startShell({ workspaceId: workspace.id, paneId: "p1", continueRun: "no-such-run" });
    expect(started).toMatchObject({ ptyId: expect.any(String), reopenFailed: "That run no longer exists." });
    expect(ctx.spawns.at(-1)?.pasteInput).toBeNull();
    ctx.svc.close();
  });
});
