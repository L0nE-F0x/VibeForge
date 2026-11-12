import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lastReply, watchReply } from "../../electron/replies.js";
import { claudeProjectDir, grokSessionsDir } from "../../src/core/replies.js";

// Temp folders stand in for the CLIs' own log folders; nothing reads the real ones.

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-replies-"));
const jsonl = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
const iso = (ms: number) => new Date(ms).toISOString();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Back-date a file or folder by an hour: older than any watch looks for, and settled. */
function age(target: string): void {
  const then = Date.now() / 1000 - 3600;
  fs.utimesSync(target, then, then);
}

const claudePrompt = (at: number, text: string, cwd: string) => ({ type: "user", timestamp: iso(at), cwd, message: { role: "user", content: text } });
const claudeAnswer = (at: number, text: string) => ({ type: "assistant", timestamp: iso(at), message: { id: "m1", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });

/** Every read through fs.promises, per file: where it started and how much it asked for. */
function countReads() {
  const reads = new Map<string, Array<{ position: number; length: number }>>();
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const file = String(args[0]);
    const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
    Object.assign(handle, {
      read: (buffer: Buffer, offset: number, length: number, position: number) => {
        reads.set(file, [...(reads.get(file) ?? []), { position, length }]);
        return read(buffer, offset, length, position);
      },
    });
    return handle;
  });
  return reads;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reply watchers", () => {
  it("follows a Claude Code log from where each poll stopped", async () => {
    const home = tempHome();
    const cwd = "/work/proj";
    const log = path.join(claudeProjectDir(home, cwd), "s1.jsonl");
    const since = Date.now() - 1000;
    write(log, jsonl([{ type: "permission-mode", timestamp: iso(since - 60_000), filler: "x".repeat(50_000) }, claudePrompt(since + 10, "Fix the build", cwd)]));
    const reads = countReads();
    const controller = new AbortController();
    const reply = watchReply({ kind: "claude", home, cwd, since, words: "fix the build", signal: controller.signal });
    await wait(1600);
    const before = fs.statSync(log).size;
    fs.appendFileSync(log, jsonl([claudeAnswer(since + 20, "Fixed: a missing import.")]));
    expect(await reply).toBe("Fixed: a missing import.");
    const positions = (reads.get(log) ?? []).map((read) => read.position);
    // The first look reads the log; later polls read only what it gained.
    expect(positions[0]).toBe(0);
    expect(positions.slice(1).every((position) => position >= before)).toBe(true);
    expect((reads.get(log) ?? []).reduce((sum, read) => sum + read.length, 0)).toBe(fs.statSync(log).size);
  });

  it("still finds the answer when a turn writes more than the window after its prompt", async () => {
    const home = tempHome();
    const cwd = "/work/long";
    const log = path.join(claudeProjectDir(home, cwd), "s1.jsonl");
    const since = Date.now() - 1000;
    write(log, jsonl([claudePrompt(since + 10, "Refactor the parser", cwd)]));
    const controller = new AbortController();
    const reply = watchReply({ kind: "claude", home, cwd, since, words: "refactor the parser", signal: controller.signal });
    await wait(300);
    // Tool results, 6 MB of them, between the prompt and the answer.
    const result = (n: number) => ({ type: "user", timestamp: iso(since + 20 + n), message: { role: "user", content: [{ type: "tool_result", content: "y".repeat(200_000) }] } });
    for (let chunk = 0; chunk < 3; chunk += 1) {
      fs.appendFileSync(log, jsonl(Array.from({ length: 10 }, (_, n) => result(chunk * 10 + n))));
      await wait(800);
    }
    fs.appendFileSync(log, jsonl([claudeAnswer(since + 100, "Done: the parser is split in two.")]));
    const timer = setTimeout(() => controller.abort(), 5000);
    expect(await reply).toBe("Done: the parser is split in two.");
    clearTimeout(timer);
  }, 15_000);

  it("reads Grok Build's history and events once, then only what they gain", async () => {
    const home = tempHome();
    const cwd = "/work/grok";
    const session = path.join(grokSessionsDir(home, cwd), "s1");
    const since = Date.now() - 1000;
    const history = path.join(session, "chat_history.jsonl");
    const events = path.join(session, "events.jsonl");
    // A long history from earlier turns, which a poll used to read whole every 700 ms.
    const earlier = Array.from({ length: 200 }, (_, index) => ({ type: "assistant", content: `older answer ${index} ${"y".repeat(2000)}` }));
    write(history, jsonl([...earlier, { type: "user", content: [{ type: "text", text: "Review the parser" }] }]));
    write(events, jsonl([{ ts: iso(since + 10), type: "turn_started" }]));
    const reads = countReads();
    const controller = new AbortController();
    const reply = watchReply({ kind: "grok", home, cwd, since, words: "review the parser", signal: controller.signal });
    await wait(1600);
    fs.appendFileSync(history, jsonl([{ type: "assistant", content: "The parser drops the last line." }]));
    fs.appendFileSync(events, jsonl([{ ts: iso(since + 30), type: "turn_ended" }]));
    expect(await reply).toBe("The parser drops the last line.");
    const total = (file: string) => (reads.get(file) ?? []).reduce((sum, read) => sum + read.length, 0);
    expect(total(history)).toBe(fs.statSync(history).size);
    expect(total(events)).toBe(fs.statSync(events).size);
    expect(await lastReply({ kind: "grok", home, cwd, since })).toBe("The parser drops the last line.");
  });

  it("finds a new worktree's Claude Code log by the cwd inside it, listing each unchanged folder once", async () => {
    const home = tempHome();
    const cwd = "/work/new-tree";
    const projects = path.join(home, ".claude", "projects");
    // Other projects' old logs, all of them settled.
    for (let index = 0; index < 20; index += 1) {
      const folder = path.join(projects, `-work-other-${index}`);
      write(path.join(folder, "old.jsonl"), jsonl([claudePrompt(Date.now() - 7_200_000, "old", `/work/other-${index}`)]));
      age(path.join(folder, "old.jsonl"));
      age(folder);
    }
    age(projects);
    const listed = new Map<string, number>();
    const readdir = fs.promises.readdir;
    vi.spyOn(fs.promises, "readdir").mockImplementation(((dir: string, options: never) => {
      listed.set(String(dir), (listed.get(String(dir)) ?? 0) + 1);
      return readdir(dir, options);
    }) as typeof readdir);
    const since = Date.now() - 1000;
    const controller = new AbortController();
    const reply = watchReply({ kind: "claude", home, cwd, since, words: "", signal: controller.signal });
    await wait(1600);
    // Claude Code spells this folder its own way, and writes the session there.
    const spelled = path.join(projects, "-work-new-tree-x");
    write(path.join(spelled, "s.jsonl"), jsonl([claudePrompt(since + 10, "Set it up", cwd), claudeAnswer(since + 20, "Set up.")]));
    expect(await reply).toBe("Set up.");
    for (let index = 0; index < 20; index += 1) expect(listed.get(path.join(projects, `-work-other-${index}`))).toBe(1);
    expect(listed.get(spelled)).toBeGreaterThanOrEqual(1);
    expect(await lastReply({ kind: "claude", home, cwd, since })).toBe("Set up.");
  });

  it("stops looking once the wait is called off", async () => {
    const home = tempHome();
    const cwd = "/work/quiet";
    write(path.join(claudeProjectDir(home, cwd), "s.jsonl"), jsonl([claudePrompt(Date.now(), "Anything", cwd)]));
    const opened = vi.spyOn(fs.promises, "open");
    const controller = new AbortController();
    const reply = watchReply({ kind: "claude", home, cwd, since: Date.now() - 1000, words: "", signal: controller.signal });
    await wait(800);
    controller.abort();
    expect(await reply).toBeNull();
    const calls = opened.mock.calls.length;
    await wait(1600);
    expect(opened.mock.calls.length).toBe(calls);
  });
});
