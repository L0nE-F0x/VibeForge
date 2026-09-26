import fs from "node:fs";
import path from "node:path";
import { claudeLogCwd, claudeProjectDir, claudeTurn, codexDayDir, codexLogCwd, codexTurn, type ReplyLog, type Turn } from "../src/core/replies.js";

const POLL_MS = 700;
const TIMEOUT_MS = 30 * 60 * 1000;
/** A log changed this long before the prompt may still be the session it lands in. */
const RECENT_MS = 10 * 60 * 1000;
/** Existing logs are read from this far before their end, which covers a prompt written just before watching began. */
const LOOKBACK_BYTES = 256 * 1024;
const KEEP_BYTES = 4 * 1024 * 1024;

interface Tail {
  offset: number;
  text: string;
}

function readFrom(file: string, offset: number): { text: string; size: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: "", size };
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString("utf8"), size };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function head(file: string): string {
  return readFrom(file, 0)?.text.slice(0, 32 * 1024) ?? "";
}

function recentJsonl(dir: string, since: number, prefix = ""): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl") && name.startsWith(prefix))
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).mtimeMs >= since - RECENT_MS;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Waits for the answer to a prompt sent from `cwd` at or after `since`, reading the CLI's own
 * session logs as they grow. Resolves with the reply's text, or null on timeout or abort.
 */
export function watchReply(opts: { kind: ReplyLog; home: string; cwd: string; since: number; words: string; signal: AbortSignal }): Promise<string | null> {
  const tails = new Map<string, Tail>();
  const cwdOk = new Map<string, boolean>();
  const started = Date.now();
  const parse = (text: string): Turn => (opts.kind === "claude" ? claudeTurn(text, opts.since, opts.words) : codexTurn(text, opts.since, opts.words));

  const candidates = (): string[] => {
    if (opts.kind === "claude") {
      const dir = claudeProjectDir(opts.home, opts.cwd);
      if (fs.existsSync(dir)) return recentJsonl(dir, opts.since);
      // A folder name Claude Code spells differently: find its logs by the cwd written inside them.
      const root = path.join(opts.home, ".claude", "projects");
      let dirs: string[] = [];
      try {
        dirs = fs.readdirSync(root).map((name) => path.join(root, name));
      } catch {
        return [];
      }
      return dirs.flatMap((folder) => recentJsonl(folder, opts.since)).filter((file) => {
        if (!cwdOk.has(file)) cwdOk.set(file, claudeLogCwd(head(file)) === opts.cwd);
        return cwdOk.get(file);
      });
    }
    const now = new Date();
    const days = [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)].map((date) => codexDayDir(opts.home, date));
    return [...new Set(days)].flatMap((dir) => recentJsonl(dir, opts.since, "rollout-")).filter((file) => {
      if (!cwdOk.has(file)) cwdOk.set(file, codexLogCwd(head(file)) === opts.cwd);
      return cwdOk.get(file);
    });
  };

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const finish = (reply: string | null) => {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(reply);
    };
    const onAbort = () => finish(null);
    opts.signal.addEventListener("abort", onAbort);

    const poll = () => {
      if (opts.signal.aborted) return;
      const turns: Turn[] = [];
      for (const file of candidates()) {
        let tail = tails.get(file);
        if (!tail) {
          let size = 0;
          try {
            size = fs.statSync(file).size;
          } catch {
            continue;
          }
          tail = { offset: Math.max(0, size - LOOKBACK_BYTES), text: "" };
          tails.set(file, tail);
        }
        const more = readFrom(file, tail.offset);
        if (!more) continue;
        tail.offset = more.size;
        tail.text = (tail.text + more.text).slice(-KEEP_BYTES);
        turns.push(parse(tail.text));
      }
      // The session whose prompt holds the dictated words wins; after a few seconds any prompted one will do.
      const matched = turns.find((turn) => turn.matched && turn.reply !== null);
      const prompted = turns.filter((turn) => turn.prompted);
      if (matched) return finish(matched.reply);
      const patient = !opts.words || Date.now() - started > 8000;
      if (patient && !turns.some((turn) => turn.matched) && prompted.length === 1 && prompted[0].reply !== null) return finish(prompted[0].reply);
      if (Date.now() - started > TIMEOUT_MS) return finish(null);
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
  });
}
