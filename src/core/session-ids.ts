import path from "node:path";
import { shellQuote } from "../shared/text.js";
import type { ReplyLog } from "./replies.js";

// Which exact session a CLI is in, read from its own session log while it runs, so a run cut off
// by VibeForge closing reopens that session and not just "the latest one in this folder". Two
// Claude Codes in one folder are common, and `--continue` takes whichever wrote last. Pure; the
// files are found by electron/replies.ts and matched to runs by the service.

/** A session log a CLI may be writing: its path and when it last changed. */
export interface SessionLog {
  file: string;
  mtimeMs: number;
}

/** A session id as the CLIs write them: letters, digits and dashes, at least eight long. */
const SESSION_ID = /^[0-9A-Za-z][\w-]{7,}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The session id a log file belongs to, from its name or its folder's; null when it can't be told. */
export function sessionIdOf(kind: ReplyLog, file: string): string | null {
  const base = path.basename(file);
  let id: string | null = null;
  // Claude Code: ~/.claude/projects/<folder>/<session>.jsonl
  if (kind === "claude") id = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null;
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
  else if (kind === "codex") id = base.match(UUID)?.[0] ?? null;
  // Grok Build and Copilot: one folder per session, named for it.
  else if (kind === "grok" || kind === "copilot") id = path.basename(path.dirname(file));
  return id && SESSION_ID.test(id) ? id : null;
}

/** The arguments that reopen session `id`, as each CLI prints them when it exits; null for CLIs with no known way. */
export function resumeArgsFor(kind: ReplyLog, id: string): string[] | null {
  if (!SESSION_ID.test(id)) return null;
  if (kind === "claude" || kind === "grok") return ["--resume", id];
  if (kind === "codex") return ["resume", id];
  if (kind === "copilot") return [`--resume=${id}`];
  return null;
}

/** A live run of a CLI whose session log is being looked for. */
export interface TrackedRun {
  runId: string;
  kind: ReplyLog;
  cwd: string;
  /** When it started, in ms. */
  startedMs: number;
  /** Working now, or worked since the last look. */
  active: boolean;
  /** The log it was matched to last time, if any. */
  file: string | null;
}

/** How long before a run's start a log may have changed and still be the run's (a CLI writes its first lines as it starts). */
const START_SLACK_MS = 3000;

/**
 * Which log each run is writing, given the logs in its folder and how they grew since the last
 * look (`before`: each file's mtime then). A run alone in its folder on its CLI takes the log
 * written to most recently since it started. Several in one folder share it out: a log that grew
 * while only one of them was working is that one's; a new log with one run still unmatched is
 * that run's; anything else stays as it was. No log is given to two runs. Runs whose log is
 * unchanged keep it, so a CLI switching sessions (/clear, /resume) moves only once it writes.
 */
export function matchSessionLogs(runs: readonly TrackedRun[], logs: ReadonlyMap<string, readonly SessionLog[]>, before: ReadonlyMap<string, number>): Map<string, string> {
  const result = new Map<string, string>();
  const groups = new Map<string, TrackedRun[]>();
  for (const run of runs) {
    const key = `${run.kind}\u0000${run.cwd}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const [key, group] of groups) {
    const files = (logs.get(key) ?? []).filter((log) => sessionIdOf(group[0].kind, log.file));
    const owner = new Map<string, string>();
    for (const run of group) if (run.file) owner.set(run.file, run.runId);
    const take = (run: TrackedRun, file: string) => {
      const previous = [...owner.entries()].find(([, runId]) => runId === run.runId)?.[0];
      if (previous) owner.delete(previous);
      owner.set(file, run.runId);
    };
    if (group.length === 1) {
      const [run] = group;
      const newest = files.filter((log) => log.mtimeMs >= run.startedMs - START_SLACK_MS).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (newest) take(run, newest.file);
    } else {
      const grown = files
        .filter((log) => log.mtimeMs > (before.get(log.file) ?? 0))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const log of grown) {
        if (owner.has(log.file)) continue;
        const could = group.filter((run) => run.startedMs - START_SLACK_MS <= log.mtimeMs);
        const working = could.filter((run) => run.active);
        const unmatched = could.filter((run) => ![...owner.values()].includes(run.runId));
        const isNew = !before.has(log.file);
        if (working.length === 1) take(working[0], log.file);
        else if (isNew && unmatched.length === 1 && (working.length === 0 || working.includes(unmatched[0]))) take(unmatched[0], log.file);
      }
    }
    for (const [file, runId] of owner) result.set(runId, file);
  }
  return result;
}

/** Flags that pick a session or send a prompt: the session to reopen takes their place. */
const SESSION_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--session-id", "--session", "--conversation", "--last", "--fork-session", "-p", "--print"]);
/** Flags known to take a value, kept with it. */
const VALUE_FLAGS = new Set(["--model", "-m", "--permission-mode", "--effort", "--profile", "--add-dir", "--agent", "--sandbox", "--approval-mode"]);
const INTERPRETERS = /^(node|bun|deno|python[\d.]*|env)$/;

/**
 * The command typed into a Code shell to reopen a CLI's session as the person had it: the CLI's
 * own name, the options they started it with that are safe to repeat (`--model x`,
 * `--dangerously-skip-permissions`), and the session's resume arguments. A prompt, or the
 * session they first picked, is left out.
 */
export function resumeCommand(bin: string, argv: readonly string[], resumeArgs: readonly string[]): string {
  let args = argv.slice(1);
  // `node …/cli.js --flag`: the CLI's own arguments come after its script.
  if (INTERPRETERS.test(path.basename(argv[0] ?? ""))) {
    const script = args.findIndex((arg) => !arg.startsWith("-"));
    args = script >= 0 ? args.slice(script + 1) : [];
  }
  // `codex resume <id>` is a subcommand: what follows it was that session's.
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      if (arg === "resume") break;
      continue;
    }
    const name = arg.split("=")[0];
    if (SESSION_FLAGS.has(name)) {
      // Its value goes with it.
      if (!arg.includes("=") && args[i + 1] && !args[i + 1].startsWith("-")) i += 1;
      continue;
    }
    if (VALUE_FLAGS.has(name) && !arg.includes("=")) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        i += 1;
      }
      continue;
    }
    kept.push(arg);
  }
  const subcommand = resumeArgs[0] === "resume";
  const words = subcommand ? [bin, ...resumeArgs.slice(0, 1), ...kept, ...resumeArgs.slice(1)] : [bin, ...kept, ...resumeArgs];
  return words.map(shellQuote).join(" ");
}
