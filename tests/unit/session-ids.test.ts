import { describe, expect, it } from "vitest";
import { matchSessionLogs, resumeArgsFor, resumeCommand, sessionIdOf, type TrackedRun } from "../../src/core/session-ids.js";

const A = "0f8e0a52-1c2d-4e3f-9a8b-7c6d5e4f3a2b";
const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("session ids from session logs", () => {
  it("reads each CLI's session id from where it keeps its log", () => {
    expect(sessionIdOf("claude", `/h/.claude/projects/-home-me-app/${A}.jsonl`)).toBe(A);
    expect(sessionIdOf("codex", `/h/.codex/sessions/2026/11/28/rollout-2026-11-28T10-20-30-${B}.jsonl`)).toBe(B);
    expect(sessionIdOf("grok", "/h/.grok/sessions/app/sess-9f8e7d6c/events.jsonl")).toBe("sess-9f8e7d6c");
    expect(sessionIdOf("copilot", "/h/.copilot/session-state/abcdef0123/events.jsonl")).toBe("abcdef0123");
    // No way to tell, or not an id at all.
    expect(sessionIdOf("kimi", "/h/.kimi/sessions/x/y/agents/main/wire.jsonl")).toBeNull();
    expect(sessionIdOf("claude", "/h/.claude/projects/app/notes.txt")).toBeNull();
    expect(sessionIdOf("claude", "/h/.claude/projects/app/a b.jsonl")).toBeNull();
  });

  it("reopens a session the way each CLI says to", () => {
    expect(resumeArgsFor("claude", A)).toEqual(["--resume", A]);
    expect(resumeArgsFor("grok", "sess-9f8e7d6c")).toEqual(["--resume", "sess-9f8e7d6c"]);
    expect(resumeArgsFor("codex", B)).toEqual(["resume", B]);
    expect(resumeArgsFor("copilot", "abcdef0123")).toEqual(["--resume=abcdef0123"]);
    expect(resumeArgsFor("kimi", "abcdef0123")).toBeNull();
    expect(resumeArgsFor("claude", "-rf")).toBeNull();
  });
});

describe("matching live runs to their session logs", () => {
  const key = (cwd: string) => `claude\u0000${cwd}`;
  const run = (runId: string, extra: Partial<TrackedRun> = {}): TrackedRun => ({ runId, kind: "claude", cwd: "/app", startedMs: 1000, active: false, file: null, ...extra });

  it("gives a run alone in its folder the log written to most recently since it started", () => {
    const logs = new Map([
      [
        key("/app"),
        [
          { file: "/p/old.jsonl", mtimeMs: 10 },
          { file: `/p/${A}.jsonl`, mtimeMs: 5000 },
          { file: `/p/${B}.jsonl`, mtimeMs: 4000 },
        ],
      ],
    ]);
    expect(matchSessionLogs([run("r1")], logs, new Map())).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
    // A log last written long before it started is someone else's.
    expect(matchSessionLogs([run("r1", { startedMs: 9000 })], logs, new Map())).toEqual(new Map());
  });

  it("shares logs out between two in one folder by which one was working when each grew", () => {
    const first = new Map([[key("/app"), [{ file: `/p/${A}.jsonl`, mtimeMs: 2000 }]]]);
    // Only r1 was working: the new log is r1's, though r2 is still unmatched too.
    let matched = matchSessionLogs([run("r1", { active: true }), run("r2")], first, new Map());
    expect(matched).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
    const second = new Map([
      [
        key("/app"),
        [
          { file: `/p/${A}.jsonl`, mtimeMs: 2000 },
          { file: `/p/${B}.jsonl`, mtimeMs: 3000 },
        ],
      ],
    ]);
    // Next look: r2 worked, and a new log appeared.
    matched = matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` }), run("r2", { active: true })], second, new Map([[`/p/${A}.jsonl`, 2000]]));
    expect(matched).toEqual(
      new Map([
        ["r1", `/p/${A}.jsonl`],
        ["r2", `/p/${B}.jsonl`],
      ]),
    );
  });

  it("leaves a log unmatched when it can't tell whose it is, and never gives one log to two runs", () => {
    const logs = new Map([[key("/app"), [{ file: `/p/${A}.jsonl`, mtimeMs: 2000 }]]]);
    // Both working: nobody gets it yet.
    expect(matchSessionLogs([run("r1", { active: true }), run("r2", { active: true })], logs, new Map())).toEqual(new Map());
    // Already r1's: r2 working on it doesn't take it.
    expect(matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` }), run("r2", { active: true })], logs, new Map([[`/p/${A}.jsonl`, 1000]]))).toEqual(
      new Map([["r1", `/p/${A}.jsonl`]]),
    );
  });

  it("follows a CLI that moves to another session (/clear) once it writes there", () => {
    const logs = new Map([
      [
        key("/app"),
        [
          { file: `/p/${A}.jsonl`, mtimeMs: 2000 },
          { file: `/p/${B}.jsonl`, mtimeMs: 6000 },
        ],
      ],
    ]);
    expect(matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` })], logs, new Map())).toEqual(new Map([["r1", `/p/${B}.jsonl`]]));
  });
});

describe("the command that reopens a session in a shell", () => {
  it("keeps the options it was started with, drops its prompt and old session, and adds the session", () => {
    expect(resumeCommand("claude", ["/home/me/.local/share/claude/versions/2.1.283", "--dangerously-skip-permissions", "--model", "opus", "fix the build"], ["--resume", A])).toBe(
      `claude --dangerously-skip-permissions --model opus --resume ${A}`,
    );
    expect(resumeCommand("claude", ["claude", "--continue", "-r", "old-session-1"], ["--resume", A])).toBe(`claude --resume ${A}`);
    // A script run by node: its own arguments come after the script.
    expect(resumeCommand("claude", ["node", "/usr/lib/node_modules/claude/cli.js", "--verbose"], ["--resume", A])).toBe(`claude --verbose --resume ${A}`);
    // Codex: the session goes after its subcommand, with the options between.
    expect(resumeCommand("codex", ["codex", "--yolo", "resume", "--last"], ["resume", B])).toBe(`codex resume --yolo ${B}`);
    // Anything unusual is quoted.
    expect(resumeCommand("/opt/my cli/claude", ["claude", "--name=a b"], ["--resume", A])).toBe(`'/opt/my cli/claude' '--name=a b' --resume ${A}`);
  });
});
