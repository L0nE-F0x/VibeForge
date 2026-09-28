import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readGrokPrompts } from "../../src/core/session-prompts.js";

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
