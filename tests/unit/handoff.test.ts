import { describe, expect, it } from "vitest";
import { HANDOFF_FILES, HANDOFF_MAX, handoffBody, handoffTitle } from "../../src/core/handoff.js";

const input = {
  runId: "2026-10-01T09-00-00-fix-lamp",
  title: "Fix lamp",
  agentName: "Notes",
  engine: "Claude Code",
  workspacePath: "/home/me/frontier-halls",
  sourceCwd: "/home/me/.local/share/vibeforge/worktrees/fix-lamp-a1b2c3",
  changes: "2 files changed, 3 insertions(+)",
  files: ["src/lamp.ts", "README.md"],
  transcript: "first words\n".repeat(2000) + "\x1b[32mAll done.\x1b[0m ```",
  transcriptPath: "/runs/x/transcript.txt",
  patchPath: "/runs/x/diff.patch",
};

describe("hand off", () => {
  it("names the run, the folder Execute uses, the files and how it ended", () => {
    const body = handoffBody(input);
    expect(body).toContain("Run: 2026-10-01T09-00-00-fix-lamp");
    expect(body).toContain("By: Notes (Claude Code)");
    expect(body).toContain("Work in: /home/me/frontier-halls");
    expect(body).toMatch(/It worked in: .*worktrees.*may be gone/);
    expect(body).toContain("- src/lamp.ts");
    expect(body).toContain("Transcript: /runs/x/transcript.txt");
    // The end of the transcript, cleaned, and unable to close its own code block.
    expect(body).toContain("All done. '''");
    expect(body).not.toContain("\x1b");
    expect(body.length).toBeLessThanOrEqual(HANDOFF_MAX);
    expect(handoffTitle("x".repeat(100))).toHaveLength("Hand off: ".length + 70);
  });

  it("says when there's no workspace yet, and caps the file list", () => {
    const files = Array.from({ length: HANDOFF_FILES + 5 }, (_, index) => `f${index}.ts`);
    const body = handoffBody({ ...input, workspacePath: null, files, transcript: "" });
    expect(body).toContain("Pick one for this task before you Execute it.");
    expect(body).toContain("- and 5 more");
    expect(body).not.toContain("How it ended");
  });
});
