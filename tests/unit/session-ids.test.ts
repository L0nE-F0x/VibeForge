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
  const logsOf = (...list: Array<[string, number]>) => new Map([[key("/app"), list.map(([file, mtimeMs]) => ({ file: `/p/${file}.jsonl`, mtimeMs }))]]);

  it("gives a working run alone in its folder the log that grew since it started", () => {
    const logs = logsOf(["old", 10], [A, 5000], [B, 4000]);
    expect(matchSessionLogs([run("r1", { active: true })], logs, new Map())).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
    // A log last written before it started is someone else's.
    expect(matchSessionLogs([run("r1", { active: true, startedMs: 9000 })], logs, new Map())).toEqual(new Map());
  });

  it("never gives an idle run a log someone else wrote, nor moves an idle run to one", () => {
    const logs = logsOf([A, 5000]);
    expect(matchSessionLogs([run("r1")], logs, new Map())).toEqual(new Map());
    const moved = logsOf([A, 2000], [B, 6000]);
    expect(matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` })], moved, new Map([[`/p/${A}.jsonl`, 2000]]))).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
  });

  it("shares logs out between two in one folder by which one was working when each grew", () => {
    let matched = matchSessionLogs([run("r1", { active: true }), run("r2")], logsOf([A, 2000]), new Map());
    expect(matched).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
    matched = matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` }), run("r2", { active: true })], logsOf([A, 2000], [B, 3000]), new Map([[`/p/${A}.jsonl`, 2000]]), new Map([[key("/app"), 2500]]));
    expect(matched).toEqual(
      new Map([
        ["r1", `/p/${A}.jsonl`],
        ["r2", `/p/${B}.jsonl`],
      ]),
    );
  });

  it("gives a new log to nobody when nobody, or more than one, was working", () => {
    expect(matchSessionLogs([run("r1"), run("r2", { file: `/p/${B}.jsonl` })], logsOf([A, 2000]), new Map())).toEqual(new Map([["r2", `/p/${B}.jsonl`]]));
    expect(matchSessionLogs([run("r1", { active: true }), run("r2", { active: true })], logsOf([A, 2000]), new Map())).toEqual(new Map());
    // Already r1's: r2 working on it doesn't take it.
    expect(matchSessionLogs([run("r1", { file: `/p/${A}.jsonl` }), run("r2", { active: true })], logsOf([A, 2000]), new Map([[`/p/${A}.jsonl`, 1000]]))).toEqual(
      new Map([["r1", `/p/${A}.jsonl`]]),
    );
  });

  it("keeps a working run on its own log when another log grew beside it", () => {
    const logs = logsOf([A, 6000], [B, 6500]);
    expect(matchSessionLogs([run("r1", { active: true, file: `/p/${A}.jsonl` })], logs, new Map([[`/p/${A}.jsonl`, 2000]]), new Map([[key("/app"), 5000]]))).toEqual(new Map([["r1", `/p/${A}.jsonl`]]));
  });

  it("follows a CLI that moves to another session (/clear) once it writes there", () => {
    const logs = logsOf([A, 2000], [B, 6000]);
    expect(matchSessionLogs([run("r1", { active: true, file: `/p/${A}.jsonl` })], logs, new Map([[`/p/${A}.jsonl`, 2000]]), new Map([[key("/app"), 5000]]))).toEqual(new Map([["r1", `/p/${B}.jsonl`]]));
  });
});

describe("the command that reopens a session in a shell", () => {
  const cases: Array<[string, string, string[], string[], string]> = [
    // [what, bin, argv, resume, typed]
    ["keeps safe options, drops the prompt", "claude", ["/home/me/.local/share/claude/versions/2.1.283", "--dangerously-skip-permissions", "--model", "opus", "fix the build"], ["--resume", A], `claude --dangerously-skip-permissions --model opus --resume ${A}`],
    ["drops the session first picked", "claude", ["claude", "--continue", "-r", "old-session-1"], ["--resume", A], `claude --resume ${A}`],
    ["keeps a value that is a sentence", "claude", ["claude", "--append-system-prompt", "be terse", "hi"], ["--resume", A], `claude --append-system-prompt 'be terse' --resume ${A}`],
    ["keeps every file a list option names", "claude", ["claude", "--mcp-config", "a.json", "b.json", "--model", "opus"], ["--resume", A], `claude --mcp-config a.json b.json --model opus --resume ${A}`],
    ["keeps allowed tools", "claude", ["claude", "--allowedTools", "Bash(git:*)", "Edit", "--model", "opus"], ["--resume", A], `claude --allowedTools 'Bash(git:*)' Edit --model opus --resume ${A}`],
    ["drops an option it doesn't know, with its value", "claude", ["claude", "--output-style", "terse", "--model", "opus"], ["--resume", A], `claude --model opus --resume ${A}`],
    ["drops print mode", "claude", ["claude", "-p", "--model", "opus"], ["--resume", A], `claude --model opus --resume ${A}`],
    ["reads a script run by node", "claude", ["node", "/usr/lib/node_modules/claude/cli.js", "--verbose"], ["--resume", A], `claude --verbose --resume ${A}`],
    ["puts Codex's options after its subcommand", "codex", ["codex", "--yolo", "resume", "--last"], ["resume", B], `codex resume --yolo ${B}`],
    ["keeps Codex's approval, sandbox, profile and config", "codex", ["codex", "-a", "never", "-s", "workspace-write", "-p", "work", "-c", "model=o4"], ["resume", B], `codex resume -a never -s workspace-write -p work -c model=o4 ${B}`],
    ["keeps nothing for a CLI it doesn't know", "agy", ["agy", "--yolo", "--model", "x"], ["--continue"], "agy --continue"],
    ["quotes anything unusual", "/opt/my cli/claude", ["claude", "--model=a b"], ["--resume", A], `'/opt/my cli/claude' '--model=a b' --resume ${A}`],
    ["never lets a value run as a command", "claude", ["claude", "--append-system-prompt", "$(rm -rf ~)"], ["--resume", A], `claude --append-system-prompt '$(rm -rf ~)' --resume ${A}`],
  ];
  it.each(cases)("%s", (_what, bin, argv, resume, typed) => {
    const kind = bin.includes("claude") ? "claude" : bin === "codex" ? "codex" : null;
    expect(resumeCommand(bin, argv, resume, kind)).toBe(typed);
  });
});
