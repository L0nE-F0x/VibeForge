import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerFromScreen, cleanText, Handles, messageText, reachable, resolveTarget, screenTail, SETTLE_MS, type Names } from "../../src/core/agent-talk.js";
import { parseTalkRequest } from "../../src/core/control.js";
import { LogFile } from "../../src/core/log.js";
import { listenControl } from "../../electron/control.js";
import net from "node:net";
import { grokTurn, kimiTurn, lastReplyIn } from "../../src/core/replies.js";
import type { LiveSession } from "../../src/core/types.js";
import { taskTitle } from "../../src/core/service/messages.js";
import { setup, tempDir } from "./fixtures/service-harness.js";

const AT = Date.parse("2026-10-20T09:00:00Z");

function session(over: Partial<LiveSession>): LiveSession {
  return {
    ptyId: "p",
    runId: null,
    kind: "run",
    title: "Argy",
    cwd: "/w",
    pid: 1,
    startedAt: new Date(AT).toISOString(),
    origin: "code",
    agentId: null,
    chatId: null,
    taskId: null,
    workspaceId: "w1",
    ...over,
  };
}

const names: Names = {
  agent: (id) => (id === "a1" ? "Notes" : null),
  engine: (s) => (s.title.startsWith("Codex") ? { id: "codex", label: "Codex" } : { id: "claude", label: "Claude Code" }),
};

describe("who can be reached", () => {
  it("names CLIs by agent or engine, numbering the second of a name by when it started", () => {
    const list = reachable(
      [
        session({ ptyId: "b", title: "Claude", startedAt: new Date(AT + 2000).toISOString() }),
        session({ ptyId: "a", title: "Claude" }),
        session({ ptyId: "c", title: "Codex" }),
        session({ ptyId: "d", title: "Claude", agentId: "a1" }),
        session({ ptyId: "e", kind: "shell", title: "bash" }),
      ],
      names,
    );
    expect(list.map((item) => [item.ptyId, item.handle, item.label])).toEqual([
      ["a", "claude", "Claude Code"],
      ["c", "codex", "Codex"],
      ["d", "notes", "Notes (Claude Code)"],
      ["b", "claude-2", "Claude Code"],
    ]);
  });

  it("keeps a CLI's handle while it lives and never gives it to another CLI", () => {
    const handles = new Handles();
    const first = reachable([session({ ptyId: "a", title: "Claude" }), session({ ptyId: "b", title: "Claude", startedAt: new Date(AT + 1000).toISOString() })], names, handles);
    expect(first.map((item) => item.handle)).toEqual(["claude", "claude-2"]);
    // "a" ends and "c" starts: "b" stays claude-2, and "c" doesn't take over a's address.
    const later = reachable([session({ ptyId: "b", title: "Claude", startedAt: new Date(AT + 1000).toISOString() }), session({ ptyId: "c", title: "Claude", startedAt: new Date(AT + 2000).toISOString() })], names, handles);
    expect(later.map((item) => [item.ptyId, item.handle])).toEqual([
      ["b", "claude-2"],
      ["c", "claude-3"],
    ]);
    // "claude" alone still finds the one Claude Code a sender means when there's only one.
    expect(resolveTarget("claude", "b", later)).toMatchObject({ ok: true, to: { ptyId: "c" } });
  });

  it("finds a target by handle, engine or name, preferring the sender's workspace", () => {
    const list = reachable(
      [session({ ptyId: "a", title: "Claude" }), session({ ptyId: "b", title: "Claude", workspaceId: "w2" }), session({ ptyId: "c", title: "Codex" })],
      names,
    );
    expect(resolveTarget("codex", "a", list)).toMatchObject({ ok: true, to: { ptyId: "c" } });
    expect(resolveTarget("Claude-2", "c", list)).toMatchObject({ ok: true, to: { ptyId: "b" } });
    expect(resolveTarget("claude", "a", list)).toEqual({ ok: false, reason: "self", options: [] });
    // From codex in w1, "claude" could be either, but only one is in w1.
    expect(resolveTarget("claude-code", "c", list)).toMatchObject({ ok: true, to: { ptyId: "a" } });
    expect(resolveTarget("claude-code", null, list)).toMatchObject({ ok: false, reason: "ambiguous", options: ["claude", "claude-2"] });
    expect(resolveTarget("grok", "a", list)).toMatchObject({ ok: false, reason: "none" });
  });

  it("labels a message with its sender and how to answer, and keeps keys out of it", () => {
    expect(messageText({ fromLabel: "Codex", fromHandle: "codex", text: "Look at a.ts", answer: "tell" })).toBe(
      '[Message from Codex, sent through VibeForge]\nLook at a.ts\n\n(To answer, run: vibeforge tell codex "your answer")',
    );
    expect(messageText({ fromLabel: "Codex", fromHandle: "codex", text: "x", answer: "wait" })).toContain("is waiting for your answer");
    expect(messageText({ fromLabel: "Codex", fromHandle: null, text: "x", answer: "none" })).toBe("From Codex:\nx");
    expect(cleanText("a\x1b[201~\x1b[31mred\x03\r\nnext")).toBe("a[31mred\nnext");
    expect(screenTail("one\n\n\n\ntwo   \n\n")).toBe("one\n\ntwo");
    const sent = messageText({ fromLabel: "Alpha", fromHandle: "alpha", text: "What is it?", answer: "wait" });
    // The footer wraps at 40 columns on this screen.
    const screen = `$ beta\nold stuff\n[Message from Alpha, sent through VibeForge]\nWhat is it?\n\n(Alpha is waiting for your answer: just\nreply here when you're done, it goes back\nto them.)\nthinking\nIt is 42.\n> `;
    expect(answerFromScreen(screen, sent)).toBe("thinking\nIt is 42.\n>");
    expect(answerFromScreen("just the answer\n", sent)).toBe("just the answer");
  });

  it("reads requests from vibeforge tell, who and task, and nothing else", () => {
    expect(parseTalkRequest('{"op":"tell","pty":"p1","to":"codex","text":"hi","wait":true,"timeoutMs":60000}')).toEqual({ op: "tell", pty: "p1", to: "codex", text: "hi", wait: true, timeoutMs: 60000 });
    expect(parseTalkRequest('{"op":"who"}')).toEqual({ op: "who", pty: null });
    expect(parseTalkRequest('{"op":"task","agent":"notes","text":"do it","start":false}')).toMatchObject({ op: "task", start: false, wait: false });
    expect(parseTalkRequest('{"op":"tell","to":"codex"}')).toBeNull();
    expect(parseTalkRequest('{"op":"rm"}')).toBeNull();
    expect(parseTalkRequest("voice start")).toBeNull();
  });
});

describe("the control socket", () => {
  it("tells the service when a CLI hangs up before its answer", async () => {
    const dir = tempDir();
    const socketPath = path.join(dir, "c.sock");
    let hungUp: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (hungUp = resolve));
    const stop = listenControl(socketPath, new LogFile(path.join(dir, "log.txt")), () => undefined, (_request, gone) => {
      gone.addEventListener("abort", () => hungUp());
      return new Promise(() => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const client = net.connect(socketPath);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write(`${JSON.stringify({ op: "tell", pty: "p", to: "x", text: "hi", wait: true })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();
    await done;
    stop();
  });
});

describe("answers from Grok Build and Kimi Code logs", () => {
  it("reads a Grok turn from its history and events", () => {
    const history = [
      { type: "system", content: "sys" },
      { type: "user", content: [{ type: "text", text: "Old question" }] },
      { type: "assistant", content: "Old answer", tool_calls: [] },
      { type: "user", content: [{ type: "text", text: "[Message from Codex, sent through VibeForge]\nReview this" }] },
      { type: "assistant", content: "Looking.", tool_calls: [{}] },
      { type: "user", content: [{ type: "text", text: "tool output" }], synthetic_reason: "tool" },
      { type: "assistant", content: "Two bugs: a and b.", tool_calls: [] },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    const events = (ended: boolean) =>
      [
        { ts: new Date(AT - 60_000).toISOString(), type: "turn_started" },
        { ts: new Date(AT - 50_000).toISOString(), type: "turn_ended" },
        { ts: new Date(AT + 1000).toISOString(), type: "turn_started" },
        ...(ended ? [{ ts: new Date(AT + 9000).toISOString(), type: "turn_ended" }] : []),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
    expect(grokTurn(history, events(false), AT, "[Message from Codex")).toEqual({ prompted: true, matched: true, reply: null });
    expect(grokTurn(history, events(true), AT, "[Message from Codex")).toEqual({ prompted: true, matched: true, reply: "Two bugs: a and b." });
    expect(lastReplyIn("grok", history, events(true))).toBe("Two bugs: a and b.");
  });

  it("reads a Kimi turn from wire.jsonl", () => {
    const rows = [
      { type: "turn.prompt", turnId: 0, input: [{ type: "text", text: "First" }], time: AT - 10_000 },
      { type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } } },
      { type: "turn.ended", turnId: 0, time: AT - 9000 },
      { type: "turn.prompt", turnId: 1, input: [{ type: "text", text: "Second" }], time: AT + 1000 },
      { type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "think", think: "hm" }, { type: "text", text: "Let me look." }] } } },
      { type: "agent.message.appended", message: { message: { role: "tool", content: [{ type: "text", text: "output" }] } } },
      { type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text: "Done: it works." }] } } },
    ];
    const log = rows.map((row) => JSON.stringify(row)).join("\n");
    expect(kimiTurn(log, AT, "Second")).toEqual({ prompted: true, matched: true, reply: null });
    expect(lastReplyIn("kimi", log)).toBe("First answer");
    const ended = `${log}\n${JSON.stringify({ type: "turn.ended", turnId: 1, time: AT + 5000 })}`;
    expect(kimiTurn(ended, AT, "Second").reply).toBe("Done: it works.");
    expect(lastReplyIn("kimi", ended)).toBe("Done: it works.");
  });
});

/** A clock the test moves by hand, and two CLIs open in one workspace. */
async function twoClis() {
  let at = AT;
  const ctx = setup({ now: () => new Date(at) });
  const pass = (ms: number) => (at += ms);
  const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
  const a = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
  const b = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  pass(5000);
  return { ctx, pass, workspace, a, b };
}

describe("CLIs talking through VibeForge", () => {
  it("delivers a labelled message once the other CLI is free, and says when it is queued", async () => {
    const { ctx, pass, a, b } = await twoClis();
    expect(ctx.svc.whoIsHere(a.ptyId)).toMatchObject({ you: "argy", clis: [{ handle: "argy", you: true }, { handle: "pasty", you: false }] });

    expect(await ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "Hello" })).toEqual({ ok: true, to: "pasty", delivered: "sent", note: undefined });
    expect(ctx.sent).toEqual([{ ptyId: b.ptyId, text: '[Message from Argy, sent through VibeForge]\nHello\n\n(To answer, run: vibeforge tell argy "your answer")' }]);
    expect(ctx.svc.liveForView().find((item) => item.ptyId === b.ptyId)?.talk).toMatchObject({ with: ["Argy"], messages: 1, max: 8, held: false });

    // Busy: told at once that it's queued, delivered once it has been quiet a moment.
    ctx.svc.onPtyActivity(b.ptyId, true);
    expect(await ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "Second" })).toMatchObject({ ok: true, delivered: "queued" });
    ctx.svc.onPtyActivity(b.ptyId, false);
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toHaveLength(1);
    pass(4000);
    await ctx.svc.pumpMessages();
    expect(ctx.sent[1].text).toContain("Second");

    expect(await ctx.svc.tell({ fromPty: a.ptyId, to: "argy", text: "me" })).toEqual({ ok: false, error: "That's you." });
    expect(await ctx.svc.tell({ fromPty: a.ptyId, to: "grok", text: "hi" })).toMatchObject({ ok: false, error: expect.stringMatching(/No CLI called "grok".*Running now: pasty/) });
    ctx.svc.close();
  });

  it("waits for the answer and reads it from the screen when the CLI keeps no log VibeForge reads", async () => {
    const { ctx, pass, a, b } = await twoClis();
    ctx.host.screen = async () => "pasty> [Message from Argy]\n\nThe answer is 42.\n\npasty> ";
    const asked = ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "What is it?", wait: true });
    await ctx.svc.pumpMessages();
    expect(ctx.sent[0].text).toContain("Argy is waiting for your answer");
    ctx.svc.onPtyActivity(b.ptyId, true);
    pass(2000);
    ctx.svc.onPtyActivity(b.ptyId, false);
    await ctx.svc.pumpMessages();
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(await asked).toMatchObject({ ok: true, delivered: "sent", fromScreen: true, reply: expect.stringContaining("The answer is 42.") });
    ctx.svc.close();
  });

  it("uses the CLI's own log when it has one, and forwards a late answer as a message", async () => {
    const { ctx, pass, a, b } = await twoClis();
    let answer: (reply: string) => void = () => undefined;
    const watched: Array<{ kind: string; words: string }> = [];
    ctx.host.watchReply = (opts) =>
      new Promise((resolve) => {
        watched.push({ kind: opts.kind, words: opts.words });
        answer = resolve;
      });
    // Make the target a Codex CLI, whose log VibeForge reads.
    const rows = JSON.parse(fs.readFileSync(path.join(ctx.configRoot, "engines.json"), "utf8"));
    rows.engines.push({ id: "codex", label: "Codex", bin: "argy", args: [] });
    fs.writeFileSync(path.join(ctx.configRoot, "engines.json"), JSON.stringify(rows));
    const workspace = ctx.svc.listWorkspaces().workspaces[0];
    const codex = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "codex" });
    pass(5000);
    const asked = ctx.svc.tell({ fromPty: a.ptyId, to: "codex", text: "Review it", wait: true, timeoutMs: 10_000 });
    await ctx.svc.pumpMessages();
    expect(watched).toEqual([{ kind: "codex", words: "[Message from Argy, sent through VibeForge]" }]);
    pass(11_000);
    await ctx.svc.pumpMessages();
    expect(await asked).toMatchObject({ ok: true, timedOut: true, reply: null });
    // The answer comes later: it goes to Argy as a message.
    answer("Looks fine.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pass(4000);
    await ctx.svc.pumpMessages();
    expect(ctx.sent.at(-1)).toEqual({ ptyId: a.ptyId, text: expect.stringContaining("[Message from Codex, sent through VibeForge]\nLooks fine.") });
    expect(b.ptyId).not.toBe(codex.ptyId);
    ctx.svc.close();
  });

  it("sends the answer as a message when the asking CLI stops waiting early", async () => {
    const { ctx, pass, a, b } = await twoClis();
    ctx.host.screen = async () => "pasty> [Message from Argy]\n\nIt is 42.\n\npasty> ";
    const gone = new AbortController();
    void ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "What is it?", wait: true, gone: gone.signal });
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toHaveLength(1);
    // Its own tool gave up after two minutes and hung up.
    pass(120_000);
    gone.abort();
    ctx.svc.onPtyActivity(b.ptyId, true);
    pass(2000);
    ctx.svc.onPtyActivity(b.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    pass(4000);
    await ctx.svc.pumpMessages();
    expect(ctx.sent.at(-1)).toEqual({ ptyId: a.ptyId, text: expect.stringMatching(/^\[Message from Pasty, sent through VibeForge\][\s\S]*It is 42\./) });
    ctx.svc.close();
  });

  it("leaves the message past the limit as a draft, starts again when a person types, and stops on Stop", async () => {
    const { ctx, pass, a, b } = await twoClis();
    ctx.svc.saveSettings({ agentTalk: { on: true, maxMessages: 2, reviewRounds: 1 } });
    for (const text of ["one", "two"]) {
      await ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text });
      pass(4000);
    }
    const third = await ctx.svc.tell({ fromPty: b.ptyId, to: "argy", text: "three" });
    expect(third).toMatchObject({ ok: true, delivered: "draft", note: expect.stringContaining("2 messages") });
    expect(ctx.sent.at(-1)).toMatchObject({ ptyId: a.ptyId, enter: false });
    expect(ctx.svc.liveForView().find((item) => item.ptyId === a.ptyId)?.talk).toMatchObject({ held: true });

    // Clicking the pane (a focus report) or moving the mouse over it isn't.
    ctx.svc.onHumanInput(a.ptyId, "\x1b[I");
    ctx.svc.onHumanInput(a.ptyId, "\x1b[<35;10;4M\x1b[O");
    expect(ctx.svc.liveForView().find((item) => item.ptyId === a.ptyId)?.talk).toMatchObject({ held: true });
    // Pressing Enter on it is a person stepping in.
    ctx.svc.onHumanInput(a.ptyId, "\r");
    pass(4000);
    expect(await ctx.svc.tell({ fromPty: b.ptyId, to: "argy", text: "four" })).toMatchObject({ delivered: "sent" });

    ctx.svc.stopTalk(a.ptyId);
    expect(ctx.svc.liveForView().map((item) => item.talk ?? null)).toEqual([null, null]);
    expect(await ctx.svc.tell({ fromPty: b.ptyId, to: "argy", text: "five" })).toMatchObject({ ok: false, error: expect.stringContaining("stopped") });
    ctx.svc.onHumanInput(a.ptyId, "x");
    pass(4000);
    // Typing without Enter holds messages back for a while, so they don't land in a half-written prompt.
    expect(await ctx.svc.tell({ fromPty: b.ptyId, to: "argy", text: "six" })).toMatchObject({ delivered: "queued" });
    pass(15_000);
    await ctx.svc.pumpMessages();
    expect(ctx.sent.at(-1)?.text).toContain("six");

    ctx.svc.saveSettings({ agentTalk: { on: false, maxMessages: 2, reviewRounds: 1 } });
    expect(await ctx.svc.tell({ fromPty: b.ptyId, to: "argy", text: "seven" })).toMatchObject({ ok: false, error: expect.stringContaining("turned off") });
    ctx.svc.close();
  });

  it("doesn't paste into a CLI that has only just started and hasn't settled yet", async () => {
    let at = AT;
    const ctx = setup({ now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const a = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    at += 10_000;
    const b = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    at += 2000;
    expect(await ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "Hi" })).toMatchObject({ delivered: "queued" });
    expect(ctx.sent).toEqual([]);
    // It drew its screen and went quiet: now it's ready.
    ctx.svc.onPtyActivity(b.ptyId, true);
    ctx.svc.onPtyActivity(b.ptyId, false);
    at += 2000;
    await ctx.svc.pumpMessages();
    expect(ctx.sent.map((item) => item.ptyId)).toEqual([b.ptyId]);
    ctx.svc.close();
  });

  it("keeps the rest of the queue when a person presses Stop while a message is going in", async () => {
    const { ctx, pass, workspace, a, b } = await twoClis();
    const c = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    pass(6000);
    for (const busy of [a, b, c]) ctx.svc.onPtyActivity(busy.ptyId, true);
    await ctx.svc.tell({ fromPty: a.ptyId, to: "pasty", text: "for b" });
    await ctx.svc.tell({ fromPty: a.ptyId, to: "argy-2", text: "for c" });
    await ctx.svc.tell({ fromPty: c.ptyId, to: "argy", text: "for a" });
    for (const busy of [a, b, c]) ctx.svc.onPtyActivity(busy.ptyId, false);
    pass(4000);
    // While the message to b goes in, a person stops c.
    const send = ctx.host.send;
    ctx.host.send = async (ptyId, text, enter) => {
      if (ptyId === b.ptyId) ctx.svc.stopTalk(c.ptyId);
      return send(ptyId, text, enter);
    };
    await ctx.svc.pumpMessages();
    expect(ctx.sent.map((item) => item.ptyId)).toEqual([b.ptyId]);
    ctx.svc.close();
  });

  it("counts a message typed into a chat as a person stepping in", async () => {
    let at = AT;
    const ctx = setup({ now: () => new Date(at) });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    ctx.svc.saveSettings({ agentTalk: { on: true, maxMessages: 1, reviewRounds: 1 } });
    const other = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    const chat = ctx.svc.createChat({ engine: "argy" });
    const first = await ctx.svc.sendChat(chat.id, "hello");
    at += 6000;
    expect(await ctx.svc.tell({ fromPty: other.ptyId, to: "argy", text: "one" })).toMatchObject({ delivered: "sent" });
    at += 4000;
    expect(await ctx.svc.tell({ fromPty: other.ptyId, to: "argy", text: "two" })).toMatchObject({ delivered: "draft" });
    // The person writes in the chat: the count starts again.
    expect(await ctx.svc.sendChat(chat.id, "go on")).toMatchObject({ started: false, ptyId: first.ptyId });
    at += 16_000;
    expect(await ctx.svc.tell({ fromPty: other.ptyId, to: "argy", text: "three" })).toMatchObject({ delivered: "sent" });
    ctx.svc.close();
  });

  it("sends a selection to another pane as a draft for a person to send", async () => {
    const { ctx, a, b } = await twoClis();
    expect(await ctx.svc.sendDraft({ fromPty: a.ptyId, toPty: b.ptyId, what: "selection", selection: "  the bit I picked\x1b[0m " })).toEqual({ sent: true });
    expect(ctx.sent).toEqual([{ ptyId: b.ptyId, text: "From Argy:\nthe bit I picked[0m", enter: false }]);
    expect(await ctx.svc.sendDraft({ fromPty: a.ptyId, toPty: b.ptyId, what: "selection", selection: " " })).toEqual({ sent: false });
    ctx.svc.close();
  });
});

function gitRepo(): string {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  return repo;
}

describe("a review loop and handing out tasks", () => {
  it("has the reviewer read the author's changes when its turn ends, and brings the review back", async () => {
    let at = AT;
    const repo = gitRepo();
    const ctx = setup({ now: () => new Date(at) });
    const pass = (ms: number) => (at += ms);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const author = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const reviewer = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    ctx.host.screen = async (ptyId) => (ptyId === reviewer.ptyId ? "Findings: a.txt lost its newline." : "");
    pass(5000);

    // The author is mid-turn: the review waits for it.
    ctx.svc.onPtyActivity(author.ptyId, true);
    await ctx.svc.startReview(author.ptyId, reviewer.ptyId);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo");
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.svc.liveForView().find((item) => item.ptyId === author.ptyId)?.talk?.review).toMatchObject({ role: "author", phase: "author", other: "Pasty" });
    ctx.svc.onPtyActivity(author.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].ptyId).toBe(reviewer.ptyId);
    const patchPath = /changes are in (\S+?\.patch)/.exec(ctx.sent[0].text)?.[1] ?? "";
    expect(fs.readFileSync(patchPath, "utf8")).toContain("+two");
    expect(ctx.sent[0].text).toContain("Don't change any files");

    // The reviewer works, goes quiet: its findings go to the author, and one round is the end.
    ctx.svc.onPtyActivity(reviewer.ptyId, true);
    pass(1000);
    ctx.svc.onPtyActivity(reviewer.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    pass(4000);
    await ctx.svc.pumpMessages();
    expect(ctx.sent[1]).toEqual({ ptyId: author.ptyId, text: expect.stringContaining("[Review of your changes from Pasty, sent through VibeForge]\nFindings: a.txt lost its newline.") });
    ctx.svc.onPtyActivity(author.ptyId, true);
    pass(1000);
    ctx.svc.onPtyActivity(author.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(ctx.svc.liveForView().find((item) => item.ptyId === author.ptyId)?.talk ?? null).toBeNull();
    expect(ctx.sent).toHaveLength(2);
    ctx.svc.close();
  });

  it("waits for the author's next turn when asked before it has changed anything", async () => {
    let at = AT;
    const repo = gitRepo();
    const ctx = setup({ now: () => new Date(at) });
    const pass = (ms: number) => (at += ms);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const author = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const reviewer = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    pass(10_000);
    await ctx.svc.startReview(author.ptyId, reviewer.ptyId);
    await ctx.svc.pumpMessages();
    expect(ctx.svc.liveForView().find((item) => item.ptyId === author.ptyId)?.talk?.review).toMatchObject({ phase: "author" });
    // Its turn: it edits, goes quiet, and the review goes out.
    pass(1000);
    ctx.svc.onPtyActivity(author.ptyId, true);
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    pass(1000);
    ctx.svc.onPtyActivity(author.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(ctx.sent.map((item) => item.ptyId)).toEqual([reviewer.ptyId]);
    ctx.svc.close();

    // A turn that ends with nothing changed ends it.
    const other = setup({ now: () => new Date(at) });
    const space = other.svc.addWorkspace(gitRepo()).workspaces[0];
    const quiet = await other.svc.startEngine({ workspaceId: space.id, engineId: "argy" });
    const second = await other.svc.startEngine({ workspaceId: space.id, engineId: "pasty" });
    pass(10_000);
    await other.svc.startReview(quiet.ptyId, second.ptyId);
    await other.svc.pumpMessages();
    pass(1000);
    other.svc.onPtyActivity(quiet.ptyId, true);
    pass(1000);
    other.svc.onPtyActivity(quiet.ptyId, false);
    pass(SETTLE_MS + 100);
    await other.svc.pumpMessages();
    expect(other.svc.liveForView().find((item) => item.ptyId === quiet.ptyId)?.talk ?? null).toBeNull();
    expect(other.sent).toEqual([]);
    other.svc.close();
  });

  it("reviews only what the author changed, not files that were already changed when it started", async () => {
    let at = AT;
    const repo = gitRepo();
    // Someone's work in progress, there before the author starts.
    fs.mkdirSync(path.join(repo, "promo"));
    fs.writeFileSync(path.join(repo, "promo", "POST.md"), "draft\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nmine\n");
    const ctx = setup({ now: () => new Date(at) });
    const pass = (ms: number) => (at += ms);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const author = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
    const reviewer = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    pass(10_000);
    // Nothing of its own yet: the review says so and waits for its next turn.
    expect(await ctx.svc.startReview(author.ptyId, reviewer.ptyId)).toEqual({ changes: false });
    await ctx.svc.pumpMessages();
    expect(ctx.sent).toEqual([]);
    expect(await ctx.svc.sendDraft({ fromPty: author.ptyId, toPty: reviewer.ptyId, what: "changes" })).toEqual({ sent: false });
    // It writes one new file and goes quiet: only that is sent.
    ctx.svc.onPtyActivity(author.ptyId, true);
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    pass(1000);
    ctx.svc.onPtyActivity(author.ptyId, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(ctx.sent.map((item) => item.ptyId)).toEqual([reviewer.ptyId]);
    expect(ctx.sent[0].text).toContain("(b.txt)");
    const patch = fs.readFileSync(/changes are in (\S+?\.patch)/.exec(ctx.sent[0].text)?.[1] ?? "", "utf8");
    expect(patch).toContain("+new");
    expect(patch).not.toContain("POST.md");
    expect(patch).not.toContain("mine");
    ctx.svc.close();
  });

  it("hands a task to an agent in its own copy, never the sender's folder, and only one level deep", async () => {
    const repo = gitRepo();
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    await ctx.svc.saveAgent({ name: "Helper", brief: "Help.", engine: "argy", places: [repo] });
    const sender = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });

    const result = await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "helper", text: "Write the tests for a.txt\nKeep them small." });
    expect(result).toMatchObject({ ok: true, title: "Write the tests for a.txt", started: true });
    const task = ctx.svc.listTasks()[0];
    expect(task).toMatchObject({ askedBy: "Pasty", isolated: true, status: "running", workspaceId: workspace.id });
    expect(task.body).toContain("Asked by Pasty.");
    const run = ctx.spawns.at(-1)!;
    expect(run.cwd).toBe(path.join(ctx.dataRoot, "worktrees", task.id));

    // The task's own CLI can't hand out more.
    const taskPty = ctx.svc.listLive().find((item) => item.taskId === task.id)!.ptyId;
    expect(await ctx.svc.handTask({ fromPty: taskPty, agent: "helper", text: "More" })).toMatchObject({ ok: false, error: expect.stringContaining("can't hand out tasks") });
    expect(await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "nobody", text: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("Agents: helper") });
    expect(await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "helper", text: "Later", start: false })).toMatchObject({ ok: true, started: false });

    // Not a repository: no copy, so it waits in To do for a person.
    const plain = tempDir();
    const plainSpace = ctx.svc.addWorkspace(plain).workspaces.find((item) => item.path === plain)!;
    await ctx.svc.saveAgent({ name: "Plain", brief: "b", engine: "argy", places: [plain] });
    const there = await ctx.svc.startEngine({ workspaceId: plainSpace.id, engineId: "pasty" });
    expect(await ctx.svc.handTask({ fromPty: there.ptyId, agent: "plain", text: "Tidy" })).toMatchObject({ ok: true, started: false, note: expect.stringContaining("isn't a git repository") });
    ctx.svc.close();
  });

  it("titles a handed-out task by its first line, cut at a word", () => {
    expect(taskTitle("Fix the  login\tbug")).toBe("Fix the login bug");
    // Claude Code sent this one; a cut at 80 characters dropped the "hi".
    expect(taskTitle("Create a file named hello.txt in the workspace root containing the single word: hi")).toBe("Create a file named hello.txt in the workspace root containing the single word…");
    expect(taskTitle("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
  });

  it("names agents in who by what task takes, and still takes the names who printed before", async () => {
    const repo = gitRepo();
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    await ctx.svc.saveAgent({ name: "VibeForge GitHub repo manager", brief: "b", engine: "argy", places: [repo] });
    const sender = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    expect(ctx.svc.whoIsHere(sender.ptyId).agents).toEqual([{ name: "VibeForge GitHub repo manager", handle: "vibeforge-github-repo-manager" }]);
    for (const name of ["vibeforge-github-repo-manager", "VibeForge GitHub repo manager", "vibeforge-github-repo-ma"]) {
      expect(await ctx.svc.handTask({ fromPty: sender.ptyId, agent: name, text: "Tidy", start: false })).toMatchObject({ ok: true });
    }
    expect(await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "nobody", text: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("Agents: vibeforge-github-repo-manager.") });
    ctx.svc.close();
  });

  it("tells a CLI started in a Code pane about the others, where it takes instructions", async () => {
    const ctx = setup();
    const rows = JSON.parse(fs.readFileSync(path.join(ctx.configRoot, "engines.json"), "utf8"));
    rows.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [] });
    fs.writeFileSync(path.join(ctx.configRoot, "engines.json"), JSON.stringify(rows));
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const started = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "claude" });
    const argv = ctx.spawns.at(-1)!.argv;
    expect(argv[1]).toBe("--append-system-prompt");
    expect(argv[2]).toMatch(/^You are running in a terminal in VibeForge.*`vibeforge who`.*`vibeforge task <agent>/s);
    expect(ctx.svc.getRun(started.runId).run.argv).toEqual(["/usr/bin/argy", "--append-system-prompt", "{VibeForge note}"]);
    // A CLI with no such option starts as before, and so does every CLI with talking turned off.
    await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    expect(ctx.spawns.at(-1)!.argv).toEqual(["/usr/bin/pasty"]);
    ctx.svc.saveSettings({ agentTalk: { ...ctx.svc.getSettings().agentTalk, on: false } });
    await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "claude" });
    expect(ctx.spawns.at(-1)!.argv).toEqual(["/usr/bin/argy"]);
    ctx.svc.close();
  });

  it("reports a handed-out task back to the CLI that handed it out: its answer, its changes, or that it ended", async () => {
    let at = AT;
    const repo = gitRepo();
    const ctx = setup({ now: () => new Date(at) });
    const pass = (ms: number) => (at += ms);
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    await ctx.svc.saveAgent({ name: "Helper", brief: "Help.", engine: "argy", places: [repo] });
    const sender = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
    pass(5000);
    const reports = () => ctx.sent.filter((item) => item.ptyId === sender.ptyId && item.text.startsWith("[Task report"));
    /** Pumps until a report is in: writing it reads the copy's changes with git, which takes real time. */
    const nextReport = async (count: number) => {
      for (let i = 0; i < 100 && reports().length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pass(1000);
        await ctx.svc.pumpMessages();
      }
      return reports()[count - 1];
    };

    expect(await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "helper", text: "Add b.txt" })).toMatchObject({ ok: true, started: true, note: expect.stringContaining("comes back to you as a message") });
    const task = ctx.svc.listTasks()[0];
    const taskPty = ctx.svc.listLive().find((item) => item.taskId === task.id)!.ptyId;
    await ctx.svc.pumpMessages();
    expect(ctx.svc.liveForView().find((item) => item.ptyId === taskPty)?.talk).toMatchObject({ reportsTo: "Pasty" });

    // It works in its copy and goes quiet: the sender hears what it said and what it changed.
    ctx.svc.onPtyActivity(taskPty, true);
    fs.writeFileSync(path.join(ctx.spawns.at(-1)!.cwd, "b.txt"), "new\n");
    pass(2000);
    ctx.svc.onPtyActivity(taskPty, false);
    ctx.host.screen = async () => "Added b.txt with one line.\n> ";
    pass(SETTLE_MS + 100);
    const report = await nextReport(1);
    expect(report.text).toContain('[Task report from Helper (Argy), sent through VibeForge]\nHelper (Argy) finished its turn on the task you handed it: "Add b.txt".');
    expect(report.text).toContain("Its answer:\nAdded b.txt with one line.");
    expect(report.text).toMatch(/Its changes are in \S+\.patch \(b\.txt\), made in its own copy at \S+/);
    expect(report.text).toContain("(To ask it more, run: vibeforge tell helper");
    expect(fs.readFileSync(/changes are in (\S+?\.patch)/.exec(report.text)![1], "utf8")).toContain("+new");
    expect(ctx.svc.liveForView().find((item) => item.ptyId === taskPty)?.talk?.reportsTo ?? null).toBeNull();

    // One that ends before it answers says so.
    await ctx.svc.handTask({ fromPty: sender.ptyId, agent: "helper", text: "Never mind" });
    const second = ctx.svc.listLive().find((item) => item.taskId && item.taskId !== task.id)!.ptyId;
    await ctx.svc.pumpMessages();
    await ctx.exit(second);
    expect((await nextReport(2)).text).toContain('The task you handed out, "Never mind", ended before Helper answered.\nIt changed no files.');

    // Waiting for it gets the answer there and then, and no report after.
    const waited = ctx.svc.handTask({ fromPty: sender.ptyId, agent: "helper", text: "Quick one", wait: true, timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = ctx.svc.listLive().find((item) => item.taskId && ![task.id].includes(item.taskId) && item.ptyId !== taskPty)!.ptyId;
    ctx.host.screen = async () => "Done quickly.\n> ";
    ctx.svc.onPtyActivity(third, true);
    pass(1000);
    ctx.svc.onPtyActivity(third, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(await waited).toMatchObject({ ok: true, started: true, reply: expect.stringContaining("Done quickly.") });
    await nextReport(3);
    expect(reports()).toHaveLength(2);

    // From a terminal outside VibeForge there's nobody to report to, so nothing is watched.
    const before = new Set(ctx.svc.listLive().map((item) => item.ptyId));
    expect(await ctx.svc.handTask({ fromPty: null, agent: "helper", text: "From outside" })).toMatchObject({ ok: true, started: true });
    const outside = ctx.svc.listLive().find((item) => !before.has(item.ptyId))!.ptyId;
    expect(ctx.svc.liveForView().find((item) => item.ptyId === outside)?.talk ?? null).toBeNull();
    ctx.svc.close();
  });
});
