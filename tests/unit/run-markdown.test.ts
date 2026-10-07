import { describe, expect, it } from "vitest";
import { fence, MARKDOWN_PATCH, MARKDOWN_TAIL, runMarkdown, type RunMarkdownInput } from "../../src/core/run-markdown.js";

const base = (over: Partial<RunMarkdownInput> = {}, run: Partial<RunMarkdownInput["run"]> = {}): RunMarkdownInput => ({
  run: {
    id: "20261007-140000-abcd",
    title: "Notes · Fix the parser",
    engine: "claude",
    cwd: "/home/fox/Projects/app",
    prompt: "Fix the parser",
    startedAt: "2026-10-07T12:00:00.000Z",
    endedAt: "2026-10-07T12:12:30.000Z",
    status: "exited",
    exitCode: 0,
    changes: "1 file changed, 2 insertions(+)",
    error: null,
    ...run,
  },
  engineLabel: "Claude Code",
  agentName: "Notes",
  typedPrompts: "",
  transcript: "\x1b[32m● Done.\x1b[0m   \n\n\n\nAll tests pass.",
  patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n x\n+y\n",
  gitSummary: "",
  home: "/home/fox",
  ...over,
});

describe("a run as Markdown", () => {
  it("says who ran what where, how it ended, and what it changed", () => {
    const text = runMarkdown(base());
    expect(text).toContain("## Notes · Fix the parser");
    expect(text).toContain("- **CLI:** Claude Code (`claude`) · **Agent:** Notes");
    expect(text).toContain("- **Folder:** `~/Projects/app`");
    expect(text).toContain("**Took:** 13 min");
    expect(text).toContain("- **Result:** finished");
    expect(text).toContain("### Prompt\n\n```text\nFix the parser\n```");
    // Terminal colours, trailing spaces and runs of blank lines are gone.
    expect(text).toContain("### How it ended\n\n```text\n● Done.\n\nAll tests pass.\n```");
    expect(text).toContain("```diff\ndiff --git a/a.ts b/a.ts");
    expect(text).toContain("`20261007-140000-abcd`");
  });

  it("uses what was typed for a CLI started by hand, and says why a run failed", () => {
    const text = runMarkdown(base({ typedPrompts: "add a test", agentName: null, engineLabel: null }, { prompt: "", status: "failed", error: "claude is not on PATH." }));
    expect(text).toContain("- **CLI:** `claude`\n");
    expect(text).toContain("```text\nadd a test\n```");
    expect(text).toContain("- **Result:** failed: claude is not on PATH.");
    expect(runMarkdown(base({}, { exitCode: 2 }))).toContain("exited with code 2");
  });

  it("falls back to git's summary when no patch was saved, and leaves out what is empty", () => {
    const text = runMarkdown(base({ patch: "", gitSummary: "git status --short\n M a.ts\n", transcript: "" }, { prompt: "", changes: null }));
    expect(text).toContain("### Changes\n\n```text\ngit status --short\n M a.ts\n```");
    expect(text).not.toContain("### Prompt");
    expect(text).not.toContain("### How it ended");
    expect(text).not.toContain("**Changes:**");
  });

  it("keeps the end of a long transcript, and cuts a long patch after a whole file", () => {
    const transcript = `start\n${"x".repeat(MARKDOWN_TAIL * 2)}\nthe end`;
    const file = (name: string) => `diff --git a/${name} b/${name}\n${"+line\n".repeat(MARKDOWN_PATCH / 12)}`;
    const text = runMarkdown(base({ transcript, patch: [file("a"), file("b"), file("c")].join("") }));
    expect(text).toContain("the end");
    expect(text).not.toContain("start");
    expect(text).toContain("diff --git a/a b/a");
    expect(text).not.toContain("diff --git a/c b/c");
    expect(text).toMatch(/_The patch is cut here: [12] more files? changed/);
  });

  it("fences text so nothing inside can close the block", () => {
    expect(fence("plain", "text")).toBe("```text\nplain\n```");
    expect(fence("a ``` b ```` c", "text")).toBe("`````text\na ``` b ```` c\n`````");
    const text = runMarkdown(base({ transcript: "```\nescaped?\n```" }));
    expect(text).toContain("````text\n```\nescaped?\n```\n````");
  });
});
