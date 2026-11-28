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

/** The runs that share session logs: one CLI in one folder. */
export function sessionGroup(kind: ReplyLog, cwd: string): string {
  return `${kind}\u0000${cwd}`;
}

/**
 * Which log each run is writing, given the logs in its folder and each one's mtime at the last
 * look (`before`; a log not seen before counts from when its folder was last looked at). A log changes hands only when it
 * grew while exactly one of the runs in its folder was working, that run's own log didn't grow
 * meanwhile (it is still in that session), and no other run has it. So a run that sits idle is
 * never given a log someone else wrote (Claude Code in another terminal in the same folder, a
 * script's `claude -p`), and a CLI that moves to another session (/clear, /resume) is followed
 * once it writes there.
 */
export function matchSessionLogs(
  runs: readonly TrackedRun[],
  logs: ReadonlyMap<string, readonly SessionLog[]>,
  before: ReadonlyMap<string, number>,
  /** Per folder (sessionGroup), when it was last looked at; never, 0. */
  since: ReadonlyMap<string, number> = new Map(),
): Map<string, string> {
  const result = new Map<string, string>();
  const groups = new Map<string, TrackedRun[]>();
  for (const run of runs) {
    const key = sessionGroup(run.kind, run.cwd);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const [key, group] of groups) {
    const owner = new Map<string, string>();
    for (const run of group) if (run.file) owner.set(run.file, run.runId);
    const grown = (logs.get(key) ?? [])
      .filter((log) => sessionIdOf(group[0].kind, log.file) && log.mtimeMs > (before.get(log.file) ?? since.get(key) ?? 0))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const active = group.filter((run) => run.active);
    const [run] = active;
    if (active.length === 1 && !(run.file && grown.some((log) => log.file === run.file))) {
      const pick = grown.filter((log) => (owner.get(log.file) ?? run.runId) === run.runId && log.mtimeMs >= run.startedMs - START_SLACK_MS).at(-1);
      if (pick) {
        if (run.file) owner.delete(run.file);
        owner.set(pick.file, run.runId);
      }
    }
    for (const [file, runId] of owner) result.set(runId, file);
  }
  return result;
}

/** Which of a CLI's own options a reopened session keeps: plain switches, ones with one value, and ones with a list of them. */
interface FlagRules {
  bare: readonly string[];
  valued: readonly string[];
  list: readonly string[];
}

/**
 * The options each CLI is started with that are safe to repeat on its resumed session. Anything
 * else (a prompt, the session first picked, `--print`, an option not known here) is left out,
 * with the word after it, so a value never ends up read as the next option or a prompt.
 */
const KEPT_FLAGS: Partial<Record<ReplyLog, FlagRules>> = {
  claude: {
    bare: ["--dangerously-skip-permissions", "--verbose", "--ide", "--strict-mcp-config"],
    valued: ["--model", "--permission-mode", "--fallback-model", "--append-system-prompt", "--system-prompt", "--settings", "--setting-sources", "--agent"],
    list: ["--add-dir", "--mcp-config", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools"],
  },
  codex: {
    bare: ["--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--search", "--oss"],
    valued: ["-m", "--model", "-a", "--ask-for-approval", "-s", "--sandbox", "-p", "--profile", "-c", "--config", "-C", "--cd", "--add-dir"],
    list: [],
  },
  grok: { bare: [], valued: ["-m", "--model"], list: [] },
  copilot: { bare: ["--allow-all-tools", "--allow-all-paths"], valued: ["--model"], list: ["--allow-tool", "--deny-tool", "--add-dir"] },
};

const INTERPRETERS = /^(node|bun|deno|python[\d.]*|env)$/;

/**
 * The command typed into a Code shell to reopen a CLI's session as the person had it: the CLI's
 * own name, the options they started it with that are safe to repeat (`--model x`,
 * `--dangerously-skip-permissions`), and the session's resume arguments. A prompt, or the
 * session they first picked, is left out.
 */
export function resumeCommand(bin: string, argv: readonly string[], resumeArgs: readonly string[], kind: ReplyLog | null): string {
  const rules = kind ? KEPT_FLAGS[kind] : undefined;
  let args = argv.slice(1);
  // `node …/cli.js --flag`: the CLI's own arguments come after its script.
  if (INTERPRETERS.test(path.basename(argv[0] ?? ""))) {
    const script = args.findIndex((arg) => !arg.startsWith("-"));
    args = script >= 0 ? args.slice(script + 1) : [];
  }
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      // `codex resume <id>` is a subcommand: what follows it was that session's.
      if (kind === "codex" && arg === "resume") break;
      continue;
    }
    const [name] = arg.split("=");
    const inline = arg.includes("=");
    if (rules?.bare.includes(name)) kept.push(arg);
    else if (rules?.valued.includes(name)) {
      if (inline) kept.push(arg);
      else if (i + 1 < args.length) {
        // Its value, whatever it looks like: the CLI took the next word as it, so it is kept as it.
        kept.push(arg, args[i + 1]);
        i += 1;
      }
    } else if (rules?.list.includes(name)) {
      kept.push(arg);
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) kept.push(args[++i]);
    } else if (!inline && i + 1 < args.length && !args[i + 1].startsWith("-")) {
      // Not known here: left out with the word after it, its value or a prompt.
      i += 1;
    }
  }
  const subcommand = resumeArgs[0] === "resume";
  const words = subcommand ? [bin, ...resumeArgs.slice(0, 1), ...kept, ...resumeArgs.slice(1)] : [bin, ...kept, ...resumeArgs];
  return words.map(shellQuote).join(" ");
}
