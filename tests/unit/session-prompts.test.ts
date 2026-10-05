import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readGrokPrompts, readMusePrompts } from "../../src/core/session-prompts.js";

describe("Grok prompts for a typed run", () => {
  it("reads the user queries from the session that started with the run", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-grok-"));
    const cwd = "/tmp/workspace";
    const dir = path.join(home, "sessions", encodeURIComponent(cwd), "session-a");
    fs.mkdirSync(dir, { recursive: true });
    const started = "2026-09-27T15:21:59.196Z";
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ created_at: "2026-09-27T15:21:59.376Z" }));
    const line = (type: string, text: string) => JSON.stringify({ type, content: [{ type: "text", text }] });
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      [
        line("user", "<user_info>secret</user_info>\n<user_query>\nFix the layout\n</user_query>"),
        line("user", "<system-reminder>skills</system-reminder>"),
        line("assistant", "<user_query>not this</user_query>"),
        line("user", "<user_query>Second</user_query>"),
      ].join("\n") + "\n",
    );
    expect(readGrokPrompts(home, cwd, started)).toBe("Fix the layout\n\nSecond");

    const other = path.join(home, "sessions", encodeURIComponent(cwd), "session-b");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "summary.json"), JSON.stringify({ created_at: "2026-09-27T15:00:00.000Z" }));
    fs.writeFileSync(path.join(other, "chat_history.jsonl"), `${line("user", "<user_query>Old</user_query>")}\n`);
    expect(readGrokPrompts(home, cwd, started)).toBe("Fix the layout\n\nSecond");
    expect(readGrokPrompts(home, cwd, "2026-09-27T18:00:00.000Z")).toBe("");
  });
});

describe("Muse prompts for a typed run", () => {
  it("reads what was typed in the session that opened with the run", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-muse-"));
    const cwd = "/tmp/workspace";
    const started = "2026-10-03T04:10:40.857Z";
    const opened = Date.parse(started) * 1000;
    const dir = path.join(home, "sessions", "2026", "10", "03", "session-a");
    fs.mkdirSync(dir, { recursive: true });
    const line = (recordedAt: number, payload: unknown) => JSON.stringify({ recorded_at: recordedAt, payload });
    fs.writeFileSync(
      path.join(dir, "session.jsonl"),
      [
        line(opened, { kind: "metadata", record: { workspace_root: cwd } }),
        line(opened + 1000, { event: { kind: "started", prompt: "You are the planner" } }),
        line(opened + 2000, { event: { kind: "started", prompt: "You watch the build" } }),
        line(opened + 3000, { event: { kind: "started", prompt: "{\"tool\":true}" } }),
        line(opened + 4000, { event: { kind: "started", prompt: "Fix the layout" } }),
        line(opened + 5000, { event: { kind: "started", prompt: "Second" } }),
      ].join("\n") + "\n",
    );
    const child = path.join(dir, "subagent", "child");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, "session.jsonl"), `${line(opened, { event: { kind: "started", prompt: "Ignore this child" } })}\n`);
    expect(readMusePrompts(home, cwd, started)).toBe("Fix the layout\n\nSecond");

    const other = path.join(home, "sessions", "2026", "10", "03", "session-b");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, "session.jsonl"),
      `${line(opened - 60_000_000, { kind: "metadata", record: { workspace_root: cwd } })}\n${line(opened, { event: { kind: "started", prompt: "Old" } })}\n`,
    );
    expect(readMusePrompts(home, cwd, started)).toBe("Fix the layout\n\nSecond");
    expect(readMusePrompts(home, "/tmp/elsewhere", started)).toBe("");
    expect(readMusePrompts(home, cwd, "2026-10-03T18:00:00.000Z")).toBe("");
  });
});
