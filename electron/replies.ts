import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  claudeConfigRoots,
  claudeLogCwd,
  claudeProjectDir,
  claudeTurn,
  codexDayDir,
  codexLogCwd,
  codexTurn,
  copilotLogCwd,
  copilotRoots,
  copilotTurn,
  grokSessionsDir,
  grokTurn,
  kimiHomeDirs,
  kimiStateCwd,
  kimiTurn,
  lastReplyIn,
  logRows,
  opencodeTurn,
  startsTurn,
  type LogRow,
  type ReplyLog,
  type Turn,
} from "../src/core/replies.js";

// These run in Electron's main process, which relays every terminal byte, for as long as an
// answer is awaited: up to half an hour, several at once. So logs are read with fs.promises, each
// from where the last poll stopped; a log that hasn't grown keeps the turn made of it; and a
// folder is listed again only once it has changed. Each line is parsed once, as it arrives, and
// the rows a turn starts with are kept however much a long turn writes after them.

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

/**
 * A log read as it grows: its whole lines as rows (the last KEEP_BYTES of them, and every row a turn
 * starts with that the caller asked to keep), then what follows the last one.
 */
interface Tail {
  /** The size at the last read; -1 until a read succeeds. */
  size: number;
  /** Where the next read starts: the end of the last whole line. */
  offset: number;
  rows: LogRow[];
  /** Each row's length, beside it; 0 for a row kept past the window. */
  sizes: number[];
  /** The rows' length, those kept past the window left out. */
  bytes: number;
  rest: string;
  /** What was made of the rows at the last read, kept while the log doesn't grow. */
  turn: Turn | null;
}

const newTail = (): Tail => ({ size: -1, offset: 0, rows: [], sizes: [], bytes: 0, rest: "", turn: null });

/** The rows read so far, with the line still being written if it already reads as one. */
const rowsIn = (tail: Tail): LogRow[] => (tail.rest.trim() ? [...tail.rows, ...logRows(tail.rest)] : tail.rows);

/** Let the oldest rows go past KEEP_BYTES, except those `keep` holds on to (a turn's prompt). */
function trim(tail: Tail, keep: (row: LogRow) => boolean): void {
  if (tail.bytes <= KEEP_BYTES) return;
  const held: LogRow[] = [];
  let at = 0;
  for (; at < tail.rows.length && tail.bytes > KEEP_BYTES; at += 1) {
    const size = tail.sizes[at];
    if (size === 0 || keep(tail.rows[at])) held.push(tail.rows[at]);
    tail.bytes -= size;
  }
  tail.rows = [...held, ...tail.rows.slice(at)];
  tail.sizes = [...held.map(() => 0), ...tail.sizes.slice(at)];
}

/**
 * Reads what a log gained since the last call; true when there was any. A first read starts
 * `back` bytes before the end, and so does one of a log cut shorter than before. `keep` names rows
 * to hold on to when older ones are let go.
 */
async function follow(file: string, tail: Tail, back: number, keep: (row: LogRow) => boolean = () => false): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const size = (await handle.stat()).size;
    if (size === tail.size) return false;
    if (tail.size < 0 || size < tail.offset) Object.assign(tail, { offset: Math.max(0, size - back), rows: [], sizes: [], bytes: 0, rest: "" });
    tail.size = size;
    const buffer = Buffer.alloc(size - tail.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset);
    const bytes = buffer.subarray(0, bytesRead);
    // Split as bytes at the last newline, so a character a write in progress cut in two is read whole next time.
    const end = bytes.lastIndexOf(10) + 1;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const [row] = logRows(line);
      if (!row) continue;
      tail.rows.push(row);
      tail.sizes.push(line.length + 1);
      tail.bytes += line.length + 1;
    }
    trim(tail, keep);
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
    const files: string[] = [];
    for (const base of kimiHomeDirs(opts.home)) {
      const root = path.join(base, "sessions");
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
    }
    return files;
  }
  if (opts.kind === "copilot") {
    const files: string[] = [];
    for (const root of copilotRoots(opts.home)) {
      for (const session of await subdirs(root)) {
        const file = path.join(session, "events.jsonl");
        if (!(await recentFile(file, opts.since))) continue;
        if (!cwdOk.has(session)) {
          const yaml = await readStart(path.join(session, "workspace.yaml"), 2048);
          const yamlCwd = yaml?.match(/^cwd:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
          cwdOk.set(session, (yamlCwd ?? copilotLogCwd((await readStart(file, HEAD_BYTES)) ?? "")) === opts.cwd);
        }
        if (cwdOk.get(session)) files.push(file);
      }
    }
    return files;
  }
  if (opts.kind === "claude") {
    const dir = claudeProjectDir(opts.home, opts.cwd);
    if ((await mtime(dir)) > 0) return recentJsonl(dir, opts.since);
    // A folder name Claude Code spells differently: find its logs by the cwd written inside them.
    const files: string[] = [];
    for (const base of claudeConfigRoots(opts.home)) {
      const root = path.join(base, "projects");
      for (const entry of await list(root)) files.push(...(await recentJsonl(path.join(root, entry.name), opts.since, "", elsewhere)));
    }
    return inCwd(files, opts.cwd, claudeLogCwd, cwdOk);
  }
  const now = new Date();
  const days = [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)].map((date) => codexDayDir(opts.home, date));
  const files: string[] = [];
  for (const dir of new Set(days)) files.push(...(await recentJsonl(dir, opts.since, "rollout-", elsewhere)));
  return inCwd(files, opts.cwd, codexLogCwd, cwdOk);
}

/** OpenCode SQLite databases in `$XDG_DATA_HOME/opencode` (or `~/.local/share/opencode`). */
async function opencodeRowsForCwd(home: string, cwd: string, since: number): Promise<LogRow[]> {
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dir = path.join(dataHome, "opencode");
  const entries = (await list(dir)).filter((entry) => entry.isFile() && /^opencode(-[\w.-]+)?\.db$/.test(entry.name));
  const out: LogRow[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    let db: DatabaseSync | null = null;
    try {
      const conn = new DatabaseSync(file, { readOnly: true });
      db = conn;
      const tables = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
      const colsOf = (table: string) => new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
      const sessionTable = tables.has("session_v2") ? "session_v2" : tables.has("session") ? "session" : null;
      const sessionCols = sessionTable ? colsOf(sessionTable) : new Set<string>();
      const dirCol = sessionCols.has("directory") ? "directory" : sessionCols.has("cwd") ? "cwd" : null;
      const sessionIds = new Set<string>();
      if (sessionTable && dirCol) {
        const orderCol = sessionCols.has("time_updated") ? "time_updated" : sessionCols.has("time_created") ? "time_created" : null;
        const rows = db
          .prepare(`SELECT id FROM ${sessionTable} WHERE ${dirCol} = ?${orderCol ? ` ORDER BY ${orderCol} DESC` : ""} LIMIT 12`)
          .all(cwd) as Array<{ id?: unknown }>;
        for (const r of rows) if (typeof r.id === "string") sessionIds.add(r.id);
      }
      const msgTable = tables.has("session_message") ? "session_message" : tables.has("message") ? "message" : null;
      if (!msgTable) continue;
      if (sessionTable && dirCol && !sessionIds.size) continue;
      const msgCols = colsOf(msgTable);
      const timeCol = msgCols.has("time_created") ? "time_created" : "created_at";
      const minAt = since - RECENT_MS;
      const msgRows = db
        .prepare(
          `SELECT id, session_id, ${timeCol} AS at, ${msgCols.has("type") ? "type" : "json_extract(data, '$.role')"} AS role, data FROM ${msgTable} WHERE ${timeCol} >= ? ORDER BY ${timeCol} ASC`,
        )
        .all(minAt) as Array<{ id?: unknown; session_id?: unknown; at?: unknown; role?: unknown; data?: unknown }>;
      const filtered = msgRows.filter((row) => !sessionIds.size || (typeof row.session_id === "string" && sessionIds.has(row.session_id)));
      const partTable = tables.has("session_part") ? "session_part" : tables.has("part") ? "part" : null;
      const partsByMsg = new Map<string, string[]>();
      if (partTable && filtered.length) {
        const partCols = colsOf(partTable);
        const partRows = db
          .prepare(`SELECT message_id, data FROM ${partTable}${partCols.has("time_created") ? " ORDER BY time_created ASC" : ""}`)
          .all() as Array<{ message_id?: unknown; data?: unknown }>;
        for (const pr of partRows) {
          if (typeof pr.message_id !== "string" || typeof pr.data !== "string") continue;
          try {
            const parsed = JSON.parse(pr.data) as { type?: unknown; text?: unknown; content?: unknown };
            if (parsed.type === "reasoning" || parsed.type === "tool") continue;
            const piece = typeof parsed.text === "string" ? parsed.text : typeof parsed.content === "string" ? parsed.content : "";
            if (piece.trim()) {
              const bucket = partsByMsg.get(pr.message_id) ?? [];
              bucket.push(piece.trim());
              partsByMsg.set(pr.message_id, bucket);
            }
          } catch {
            /* skip unreadable part */
          }
        }
      }
      for (const row of filtered) {
        const id = typeof row.id === "string" ? row.id : "";
        const role = row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : "";
        if (!role) continue;
        let dataObj: Record<string, unknown> = {};
        if (typeof row.data === "string") {
          try {
            dataObj = JSON.parse(row.data) as Record<string, unknown>;
          } catch {
            dataObj = {};
          }
        }
        const fromParts = id ? (partsByMsg.get(id) ?? []).join("\n\n") : "";
        const fallbackText =
          typeof dataObj.content === "string"
            ? dataObj.content
            : typeof dataObj.text === "string"
              ? dataObj.text
              : typeof (dataObj.summary as { body?: unknown } | undefined)?.body === "string"
                ? String((dataObj.summary as { body?: unknown }).body)
                : "";
        const text = (fromParts || fallbackText).trim();
        if (!text) continue;
        const rawTime = Number(row.at);
        const timeMs = rawTime > 0 && rawTime < 1e12 ? rawTime * 1000 : rawTime;
        const done = Boolean((dataObj.time as { completed?: unknown } | undefined)?.completed || dataObj.finish);
        out.push({ type: role, time: timeMs, text, done });
      }
    } catch {
      /* SQLite locked or missing */
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** Grok Build sessions in `cwd` whose events changed lately, each with when, in listing order. */
async function grokSessions(home: string, cwd: string, since: number): Promise<Array<{ session: string; at: number }>> {
  const sessions = await subdirs(grokSessionsDir(home, cwd));
  const changed = await Promise.all(sessions.map((session) => mtime(path.join(session, "events.jsonl"))));
  return sessions.map((session, index) => ({ session, at: changed[index] })).filter(({ at }) => at > 0 && at >= since - RECENT_MS);
}

/**
 * The CLI's latest finished answer in `cwd`, from the session log written to most recently since
 * `since` (preferring one matching `words` when multiple sessions run in `cwd`). Null when there is none yet.
 */
export async function lastReply(opts: { kind: ReplyLog; home: string; cwd: string; since: number; words?: string }): Promise<string | null> {
  if (opts.kind === "opencode") {
    const rows = await opencodeRowsForCwd(opts.home, opts.cwd, opts.since);
    return lastReplyIn("opencode", rows, "", opts.words ?? "");
  }
  if (opts.kind === "grok") {
    const sorted = (await grokSessions(opts.home, opts.cwd, opts.since)).sort((a, b) => b.at - a.at);
    if (!sorted.length) return null;
    for (const item of sorted.slice(0, opts.words ? 4 : 1)) {
      const [history, events] = [newTail(), newTail()];
      await follow(path.join(item.session, "chat_history.jsonl"), history, KEEP_BYTES);
      await follow(path.join(item.session, "events.jsonl"), events, KEEP_BYTES);
      const hRows = rowsIn(history);
      const eRows = rowsIn(events);
      if (opts.words && grokTurn(hRows, eRows, opts.since, opts.words).matched) {
        return lastReplyIn("grok", hRows, eRows, opts.words);
      }
      if (!opts.words) return lastReplyIn("grok", hRows, eRows);
    }
    const [history, events] = [newTail(), newTail()];
    await follow(path.join(sorted[0].session, "chat_history.jsonl"), history, KEEP_BYTES);
    await follow(path.join(sorted[0].session, "events.jsonl"), events, KEEP_BYTES);
    return lastReplyIn("grok", rowsIn(history), rowsIn(events));
  }
  const files = await logFiles(opts, new Map());
  const times = await Promise.all(files.map(mtime));
  const sorted = files.map((file, index) => ({ file, at: times[index] })).sort((a, b) => b.at - a.at);
  if (!sorted.length) return null;
  if (opts.words) {
    for (const item of sorted.slice(0, 4)) {
      const tail = newTail();
      await follow(item.file, tail, KEEP_BYTES);
      const rows = rowsIn(tail);
      const turn =
        opts.kind === "claude"
          ? claudeTurn(rows, opts.since, opts.words)
          : opts.kind === "kimi"
            ? kimiTurn(rows, opts.since, opts.words)
            : opts.kind === "copilot"
              ? copilotTurn(rows, opts.since, opts.words)
              : codexTurn(rows, opts.since, opts.words);
      if (turn.matched && turn.reply?.trim()) return turn.reply.trim();
    }
  }
  const tail = newTail();
  await follow(sorted[0].file, tail, KEEP_BYTES);
  return lastReplyIn(opts.kind, rowsIn(tail), "", opts.words ?? "");
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
  const parse = (rows: LogRow[]): Turn =>
    opts.kind === "claude"
      ? claudeTurn(rows, opts.since, opts.words)
      : opts.kind === "kimi"
        ? kimiTurn(rows, opts.since, opts.words)
        : opts.kind === "copilot"
          ? copilotTurn(rows, opts.since, opts.words)
          : codexTurn(rows, opts.since, opts.words);
  // A turn's own prompt stays however long the turn runs: past KEEP_BYTES of tool output after it,
  // the turn could no longer be found and the wait ran to its half hour.
  const keep = (row: LogRow) => startsTurn(opts.kind, row);

  const turnsNow = async (): Promise<Turn[]> => {
    const turns: Turn[] = [];
    if (opts.kind === "opencode") {
      const rows = await opencodeRowsForCwd(opts.home, opts.cwd, opts.since);
      if (rows.length) turns.push(opencodeTurn(rows, opts.since, opts.words));
      return turns;
    }
    if (opts.kind === "grok") {
      // Grok Build keeps the messages and the turns in two files, so each recent session reads both.
      for (const { session } of await grokSessions(opts.home, opts.cwd, opts.since)) {
        const history = tailOf(path.join(session, "chat_history.jsonl"));
        const events = tailOf(path.join(session, "events.jsonl"));
        const grew = [await follow(path.join(session, "chat_history.jsonl"), history, KEEP_BYTES, keep), await follow(path.join(session, "events.jsonl"), events, KEEP_BYTES, keep)];
        if (grew.includes(true) || !events.turn) events.turn = grokTurn(rowsIn(history), rowsIn(events), opts.since, opts.words);
        turns.push(events.turn);
      }
      return turns;
    }
    for (const file of await logFiles(opts, cwdOk)) {
      const tail = tailOf(file);
      if (await follow(file, tail, LOOKBACK_BYTES, keep)) tail.turn = parse(rowsIn(tail));
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
