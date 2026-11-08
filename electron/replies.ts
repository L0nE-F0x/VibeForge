import fs from "node:fs";
import path from "node:path";
import { claudeLogCwd, claudeProjectDir, claudeTurn, codexDayDir, codexLogCwd, codexTurn, grokSessionsDir, grokTurn, kimiStateCwd, kimiTurn, lastReplyIn, type ReplyLog, type Turn } from "../src/core/replies.js";

// These run in Electron's main process, which relays every terminal byte, for as long as an
// answer is awaited: up to half an hour, several at once. So logs are read with fs.promises, each
// from where the last poll stopped; a log that hasn't grown keeps the turn made of it; and a
// folder is listed again only once it has changed.

const POLL_MS = 700;
const TIMEOUT_MS = 30 * 60 * 1000;
/** A log changed this long before the prompt may still be the session it lands in. */
const RECENT_MS = 10 * 60 * 1000;
/** Existing logs are read from this far before their end, which covers a prompt written just before watching began. */
const LOOKBACK_BYTES = 256 * 1024;
const KEEP_BYTES = 4 * 1024 * 1024;
/** The start of a log, where the CLIs write the folder the session runs in. */
const HEAD_BYTES = 32 * 1024;
/**
 * A folder changed this recently is listed again on every look: an entry added within the same
 * tick of the file system's clock would leave its modified time as it was.
 */
const SETTLE_MS = 2000;
/** The most folder listings kept; past that they are all let go. */
const MAX_LISTINGS = 4000;

const listings = new Map<string, { mtimeMs: number; entries: fs.Dirent[] }>();

/** A folder's entries, read again only when the folder has changed since the last look. */
async function list(dir: string): Promise<fs.Dirent[]> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
  } catch {
    listings.delete(dir);
    return [];
  }
  const kept = listings.get(dir);
  if (kept && kept.mtimeMs === mtimeMs) return kept.entries;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (Date.now() - mtimeMs > SETTLE_MS) {
    if (listings.size >= MAX_LISTINGS) listings.clear();
    listings.set(dir, { mtimeMs, entries });
  } else {
    listings.delete(dir);
  }
  return entries;
}

async function subdirs(dir: string): Promise<string[]> {
  return (await list(dir)).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

async function mtime(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function recentFile(file: string, since: number): Promise<boolean> {
  const changed = await mtime(file);
  return changed > 0 && changed >= since - RECENT_MS;
}

/** Up to `length` bytes of a file from its start, as text; null when it can't be read. */
async function readStart(file: string, length: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(Math.min(length, (await handle.stat()).size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A log read as it grows: its whole lines (the last KEEP_BYTES of them), then what follows the last one. */
interface Tail {
  /** The size at the last read; -1 until a read succeeds. */
  size: number;
  /** Where the next read starts: the end of the last whole line. */
  offset: number;
  lines: string;
  rest: string;
  /** What was made of the text at the last read, kept while the log doesn't grow. */
  turn: Turn | null;
}

const newTail = (): Tail => ({ size: -1, offset: 0, lines: "", rest: "", turn: null });

const textOf = (tail: Tail): string => tail.lines + tail.rest;

/**
 * Reads what a log gained since the last call; true when there was any. A first read starts
 * `back` bytes before the end, and so does one of a log cut shorter than before.
 */
async function follow(file: string, tail: Tail, back: number): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const size = (await handle.stat()).size;
    if (size === tail.size) return false;
    if (tail.size < 0 || size < tail.offset) Object.assign(tail, { offset: Math.max(0, size - back), lines: "", rest: "" });
    tail.size = size;
    const buffer = Buffer.alloc(size - tail.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset);
    const bytes = buffer.subarray(0, bytesRead);
    // Split as bytes at the last newline, so a character a write in progress cut in two is read whole next time.
    const end = bytes.lastIndexOf(10) + 1;
    tail.lines = (tail.lines + bytes.subarray(0, end).toString("utf8")).slice(-KEEP_BYTES);
    tail.rest = bytes.subarray(end).toString("utf8");
    tail.offset += end;
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `.jsonl` files in `dir` changed lately, in listing order; `skip` leaves out files already known not to matter. */
async function recentJsonl(dir: string, since: number, prefix = "", skip: (file: string) => boolean = () => false): Promise<string[]> {
  const files = (await list(dir))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".jsonl") && name.startsWith(prefix))
    .map((name) => path.join(dir, name))
    .filter((file) => !skip(file));
  const recent = await Promise.all(files.map((file) => recentFile(file, since)));
  return files.filter((_, index) => recent[index]);
}

/** The files written in `cwd`, by the folder each one's first lines name; `cwdOk` remembers each answer. */
async function inCwd(files: string[], cwd: string, cwdOf: (head: string) => string | null, cwdOk: Map<string, boolean>): Promise<string[]> {
  for (const file of files) if (!cwdOk.has(file)) cwdOk.set(file, cwdOf((await readStart(file, HEAD_BYTES)) ?? "") === cwd);
  return files.filter((file) => cwdOk.get(file));
}

/** The session logs `kind` may have written in `cwd` since `since`; `cwdOk` remembers which files were checked. */
async function logFiles(opts: { kind: ReplyLog; home: string; cwd: string; since: number }, cwdOk: Map<string, boolean>): Promise<string[]> {
  const elsewhere = (file: string) => cwdOk.get(file) === false;
  if (opts.kind === "kimi") {
    const root = path.join(process.env.KIMI_CODE_HOME || path.join(opts.home, ".kimi-code"), "sessions");
    const files: string[] = [];
    for (const folder of await subdirs(root)) {
      for (const session of await subdirs(folder)) {
        if (!cwdOk.has(session)) cwdOk.set(session, kimiStateCwd((await readStart(path.join(session, "state.json"), KEEP_BYTES)) ?? "") === opts.cwd);
        if (!cwdOk.get(session)) continue;
        for (const agent of await subdirs(path.join(session, "agents"))) {
          const file = path.join(agent, "wire.jsonl");
          if (await recentFile(file, opts.since)) files.push(file);
        }
      }
    }
    return files;
  }
  if (opts.kind === "claude") {
    const dir = claudeProjectDir(opts.home, opts.cwd);
    if ((await mtime(dir)) > 0) return recentJsonl(dir, opts.since);
    // A folder name Claude Code spells differently: find its logs by the cwd written inside them.
    const root = path.join(opts.home, ".claude", "projects");
    const files: string[] = [];
    for (const entry of await list(root)) files.push(...(await recentJsonl(path.join(root, entry.name), opts.since, "", elsewhere)));
    return inCwd(files, opts.cwd, claudeLogCwd, cwdOk);
  }
  const now = new Date();
  const days = [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)].map((date) => codexDayDir(opts.home, date));
  const files: string[] = [];
  for (const dir of new Set(days)) files.push(...(await recentJsonl(dir, opts.since, "rollout-", elsewhere)));
  return inCwd(files, opts.cwd, codexLogCwd, cwdOk);
}

/** Grok Build sessions in `cwd` whose events changed lately, each with when, in listing order. */
async function grokSessions(home: string, cwd: string, since: number): Promise<Array<{ session: string; at: number }>> {
  const sessions = await subdirs(grokSessionsDir(home, cwd));
  const changed = await Promise.all(sessions.map((session) => mtime(path.join(session, "events.jsonl"))));
  return sessions.map((session, index) => ({ session, at: changed[index] })).filter(({ at }) => at > 0 && at >= since - RECENT_MS);
}

/**
 * The CLI's latest finished answer in `cwd`, from the session log written to most recently since
 * `since`. Null when there is none yet.
 */
export async function lastReply(opts: { kind: ReplyLog; home: string; cwd: string; since: number }): Promise<string | null> {
  if (opts.kind === "grok") {
    const newest = (await grokSessions(opts.home, opts.cwd, opts.since)).sort((a, b) => b.at - a.at)[0];
    if (!newest) return null;
    const [history, events] = [newTail(), newTail()];
    await follow(path.join(newest.session, "chat_history.jsonl"), history, KEEP_BYTES);
    await follow(path.join(newest.session, "events.jsonl"), events, KEEP_BYTES);
    return lastReplyIn("grok", textOf(history), textOf(events));
  }
  const files = await logFiles(opts, new Map());
  const times = await Promise.all(files.map(mtime));
  const newest = files.map((file, index) => ({ file, at: times[index] })).sort((a, b) => b.at - a.at)[0];
  if (!newest) return null;
  const tail = newTail();
  await follow(newest.file, tail, KEEP_BYTES);
  return lastReplyIn(opts.kind, textOf(tail));
}

/**
 * Waits for the answer to a prompt sent from `cwd` at or after `since`, reading the CLI's own
 * session logs as they grow. Resolves with the reply's text, or null on timeout or abort.
 */
export function watchReply(opts: { kind: ReplyLog; home: string; cwd: string; since: number; words: string; signal: AbortSignal }): Promise<string | null> {
  const tails = new Map<string, Tail>();
  const tailOf = (file: string): Tail => {
    const tail = tails.get(file) ?? newTail();
    tails.set(file, tail);
    return tail;
  };
  const cwdOk = new Map<string, boolean>();
  const started = Date.now();
  const parse = (text: string): Turn =>
    opts.kind === "claude" ? claudeTurn(text, opts.since, opts.words) : opts.kind === "kimi" ? kimiTurn(text, opts.since, opts.words) : codexTurn(text, opts.since, opts.words);

  const turnsNow = async (): Promise<Turn[]> => {
    const turns: Turn[] = [];
    if (opts.kind === "grok") {
      // Grok Build keeps the messages and the turns in two files, so each recent session reads both.
      for (const { session } of await grokSessions(opts.home, opts.cwd, opts.since)) {
        const history = tailOf(path.join(session, "chat_history.jsonl"));
        const events = tailOf(path.join(session, "events.jsonl"));
        const grew = [await follow(path.join(session, "chat_history.jsonl"), history, KEEP_BYTES), await follow(path.join(session, "events.jsonl"), events, KEEP_BYTES)];
        if (grew.includes(true) || !events.turn) events.turn = grokTurn(textOf(history), textOf(events), opts.since, opts.words);
        turns.push(events.turn);
      }
      return turns;
    }
    for (const file of await logFiles(opts, cwdOk)) {
      const tail = tailOf(file);
      if (await follow(file, tail, LOOKBACK_BYTES)) tail.turn = parse(textOf(tail));
      if (tail.turn) turns.push(tail.turn);
    }
    return turns;
  };

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let done = false;
    const finish = (reply: string | null) => {
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(reply);
    };
    const onAbort = () => finish(null);
    opts.signal.addEventListener("abort", onAbort);

    const poll = async () => {
      if (done || opts.signal.aborted) return;
      let turns: Turn[] = [];
      try {
        turns = await turnsNow();
      } catch {
        /* a log moved mid-read; the next poll looks again */
      }
      if (done) return;
      // The session whose prompt holds the dictated words wins; after a few seconds any prompted one will do.
      const matched = turns.find((turn) => turn.matched && turn.reply !== null);
      const prompted = turns.filter((turn) => turn.prompted);
      if (matched) return finish(matched.reply);
      const patient = !opts.words || Date.now() - started > 8000;
      if (patient && !turns.some((turn) => turn.matched) && prompted.length === 1 && prompted[0].reply !== null) return finish(prompted[0].reply);
      if (Date.now() - started > TIMEOUT_MS) return finish(null);
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
  });
}
