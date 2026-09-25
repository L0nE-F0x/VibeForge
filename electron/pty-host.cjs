"use strict";
// VibeForge PTY host. Electron starts this with the system Node because node-pty is built
// for that Node. It owns every terminal: the process, a headless mirror of its screen, and
// the terminal files in the run folder. It speaks JSON lines on stdin and stdout.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const SCROLLBACK_SLACK_BYTES = 512 * 1024;
const MIRROR_SCROLLBACK_LINES = 10000;
const FLUSH_MS = 6;
const PASTE_QUIET_MS = 700;
const PASTE_FIRST_OUTPUT_MS = 3000;
const PASTE_MAX_WAIT_MS = 20000;
const ENTER_AFTER_PASTE_MS = 150;
const EXIT_SETTLE_MS = 120;

/** @type {Map<string, any>} */
const sessions = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(reqId, body) {
  send({ reqId, ...body });
}

function log(...parts) {
  process.stderr.write(`${parts.join(" ")}\n`);
}

function signalGroup(pid, signal) {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------ scrollback file

function openScrollback(session) {
  if (!session.runDir) return;
  const file = path.join(session.runDir, "scrollback.txt");
  try {
    session.scrollFd = fs.openSync(file, "a");
    session.scrollBytes = fs.fstatSync(session.scrollFd).size;
    session.scrollFile = file;
  } catch (error) {
    log("scrollback:", error.message);
    session.scrollFd = null;
  }
}

function appendScrollback(session, data) {
  if (session.scrollFd == null) return;
  try {
    const bytes = Buffer.from(data, "utf8");
    fs.writeSync(session.scrollFd, bytes);
    session.scrollBytes += bytes.length;
    if (session.scrollBytes > MAX_SCROLLBACK_BYTES + SCROLLBACK_SLACK_BYTES) trimScrollback(session);
  } catch (error) {
    log("scrollback:", error.message);
  }
}

/** Keep the last 2 MB. Trimming in 512 KB steps keeps the rewrite rare. */
function trimScrollback(session) {
  fs.closeSync(session.scrollFd);
  const size = fs.statSync(session.scrollFile).size;
  const keep = Math.min(size, MAX_SCROLLBACK_BYTES);
  const buffer = Buffer.alloc(keep);
  const fd = fs.openSync(session.scrollFile, "r");
  fs.readSync(fd, buffer, 0, keep, size - keep);
  fs.closeSync(fd);
  fs.writeFileSync(session.scrollFile, buffer);
  session.scrollFd = fs.openSync(session.scrollFile, "a");
  session.scrollBytes = keep;
}

// ------------------------------------------------------------------ text from the mirror

function bufferText(buffer) {
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

function transcriptOf(session) {
  const mirror = session.mirror;
  const normal = bufferText(mirror.buffer.normal);
  if (mirror.buffer.active.type !== "alternate") return normal ? `${normal}\n` : "";
  const screen = bufferText(mirror.buffer.alternate);
  return `${normal ? `${normal}\n\n` : ""}--- final screen ---\n${screen}\n`;
}

// ------------------------------------------------------------------ input

function writeInput(session, data) {
  if (session.exited) return;
  session.term.write(data);
}

/** Paste text the way a terminal does, then press Enter. */
function sendText(session, text) {
  if (session.exited) return;
  const clean = String(text).replace(/\r\n/g, "\n").replace(/\x1b\[20[01]~/g, "");
  if (session.mirror.modes.bracketedPasteMode) {
    writeInput(session, `\x1b[200~${clean}\x1b[201~`);
    setTimeout(() => writeInput(session, "\r"), ENTER_AFTER_PASTE_MS);
  } else {
    writeInput(session, `${clean.replace(/\n/g, "\r")}\r`);
  }
}

function clearPasteTimers(paste) {
  clearTimeout(paste.quietTimer);
  clearTimeout(paste.capTimer);
}

function armPaste(session, text) {
  const paste = { text, quietTimer: null, capTimer: null, done: false };
  session.paste = paste;
  const deliver = () => {
    if (paste.done || session.exited) return;
    paste.done = true;
    clearPasteTimers(paste);
    session.paste = null;
    session.mirror.write("", () => sendText(session, paste.text));
  };
  paste.deliver = deliver;
  paste.quietTimer = setTimeout(deliver, PASTE_FIRST_OUTPUT_MS);
  paste.capTimer = setTimeout(deliver, PASTE_MAX_WAIT_MS);
}

function notePasteActivity(session) {
  const paste = session.paste;
  if (!paste || paste.done) return;
  clearTimeout(paste.quietTimer);
  paste.quietTimer = setTimeout(paste.deliver, PASTE_QUIET_MS);
}

// ------------------------------------------------------------------ output batching

function flush(session) {
  clearTimeout(session.flushTimer);
  session.flushTimer = null;
  if (session.batch.length === 0) return;
  send({ event: "data", ptyId: session.id, data: session.batch.join(""), first: session.batchFirst, seq: session.seq });
  session.batch = [];
  session.batchFirst = null;
}

// ------------------------------------------------------------------ sessions

function spawnSession(msg) {
  const argv = Array.isArray(msg.argv) && msg.argv.length ? msg.argv.map(String) : [process.env.SHELL || "/bin/bash"];
  const cols = Math.max(2, Number(msg.cols) || 120);
  const rows = Math.max(2, Number(msg.rows) || 32);
  const runDir = typeof msg.runDir === "string" && msg.runDir ? msg.runDir : null;
  const id = crypto.randomUUID();
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "VibeForge" };
  if (runDir) env.VIBEFORGE_RUN_DIR = runDir;
  const term = pty.spawn(argv[0], argv.slice(1), { name: "xterm-256color", cols, rows, cwd: msg.cwd, env });
  const mirror = new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true });
  const serializer = new SerializeAddon();
  mirror.loadAddon(serializer);
  const session = {
    id,
    pid: term.pid,
    cwd: msg.cwd,
    argv,
    runDir,
    term,
    mirror,
    serializer,
    cols,
    rows,
    seq: 0,
    batch: [],
    batchFirst: null,
    flushTimer: null,
    exited: false,
    killTimers: [],
    paste: null,
    scrollFd: null,
    scrollBytes: 0,
    scrollFile: null,
  };
  openScrollback(session);
  sessions.set(id, session);

  term.onData((data) => {
    session.seq += 1;
    if (session.batchFirst === null) session.batchFirst = session.seq;
    session.batch.push(data);
    mirror.write(data);
    appendScrollback(session, data);
    notePasteActivity(session);
    if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), FLUSH_MS);
  });

  term.onExit(({ exitCode, signal }) => {
    // node-pty can report the exit before the last bytes are read; give them a moment.
    setTimeout(() => finish(session, exitCode, signal), EXIT_SETTLE_MS);
  });

  if (typeof msg.pasteInput === "string" && msg.pasteInput.trim()) armPaste(session, msg.pasteInput);
  return session;
}

function finish(session, exitCode, signal) {
  if (session.exited) return;
  session.exited = true;
  for (const timer of session.killTimers) clearTimeout(timer);
  if (session.paste) clearPasteTimers(session.paste);
  flush(session);
  session.mirror.write("", () => {
    if (session.runDir) {
      try {
        fs.writeFileSync(path.join(session.runDir, "terminal.ansi"), session.serializer.serialize({ scrollback: MIRROR_SCROLLBACK_LINES }));
        fs.writeFileSync(path.join(session.runDir, "transcript.txt"), transcriptOf(session));
      } catch (error) {
        log("artifacts:", error.message);
      }
    }
    if (session.scrollFd != null) {
      try {
        fs.closeSync(session.scrollFd);
      } catch {
        /* closed */
      }
    }
    send({ event: "exit", ptyId: session.id, exitCode: exitCode ?? null, signal: signal || null });
    sessions.delete(session.id);
    session.mirror.dispose();
    const waiters = session.exitWaiters || [];
    for (const wake of waiters) wake();
  });
}

function killSession(session) {
  if (session.exited || session.killTimers.length) return;
  // What closing a terminal window does: hang up, then ask, then insist.
  signalGroup(session.pid, "SIGHUP");
  session.killTimers.push(setTimeout(() => signalGroup(session.pid, "SIGTERM"), 1500));
  session.killTimers.push(setTimeout(() => signalGroup(session.pid, "SIGKILL"), 4000));
}

function waitForExit(session, timeoutMs) {
  if (session.exited) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    session.exitWaiters = session.exitWaiters || [];
    session.exitWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ------------------------------------------------------------------ requests

function need(msg) {
  const session = sessions.get(msg.ptyId);
  if (!session || session.exited) throw new Error("That session has ended.");
  return session;
}

async function handle(msg) {
  switch (msg.op) {
    case "spawn": {
      const session = spawnSession(msg);
      reply(msg.reqId, { ok: true, ptyId: session.id, pid: session.pid });
      return;
    }
    case "write":
      writeInput(need(msg), String(msg.data ?? ""));
      reply(msg.reqId, { ok: true });
      return;
    case "send":
      sendText(need(msg), String(msg.text ?? ""));
      reply(msg.reqId, { ok: true });
      return;
    case "resize": {
      const session = sessions.get(msg.ptyId);
      if (session && !session.exited) {
        const cols = Math.max(2, Number(msg.cols) | 0);
        const rows = Math.max(2, Number(msg.rows) | 0);
        if (cols !== session.cols || rows !== session.rows) {
          session.cols = cols;
          session.rows = rows;
          try {
            session.term.resize(cols, rows);
            session.mirror.resize(cols, rows);
          } catch {
            /* the pty closed underneath us */
          }
        }
      }
      reply(msg.reqId, { ok: true });
      return;
    }
    case "kill": {
      const session = sessions.get(msg.ptyId);
      if (session) killSession(session);
      reply(msg.reqId, { ok: true });
      return;
    }
    case "snapshot": {
      const session = sessions.get(msg.ptyId);
      if (!session || session.exited) {
        reply(msg.reqId, { ok: true, ansi: "", seq: 0, cols: 0, rows: 0, alive: false });
        return;
      }
      flush(session);
      const seq = session.seq;
      session.mirror.write("", () => {
        reply(msg.reqId, {
          ok: true,
          ansi: session.serializer.serialize({ scrollback: MIRROR_SCROLLBACK_LINES }),
          seq,
          cols: session.cols,
          rows: session.rows,
          alive: true,
        });
      });
      return;
    }
    case "list":
      reply(msg.reqId, {
        ok: true,
        ptys: [...sessions.values()].map((session) => ({ ptyId: session.id, pid: session.pid, cwd: session.cwd, argv: session.argv })),
      });
      return;
    case "shutdown":
      await shutdown();
      reply(msg.reqId, { ok: true });
      return;
    default:
      throw new Error(`Unknown op ${msg.op}`);
  }
}

let shuttingDown = null;

function shutdown() {
  if (shuttingDown) return shuttingDown;
  const live = [...sessions.values()];
  for (const session of live) killSession(session);
  shuttingDown = Promise.all(live.map((session) => waitForExit(session, 6000)));
  return shuttingDown;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve()
    .then(() => handle(msg))
    .catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      if (msg && msg.reqId) reply(msg.reqId, { ok: false, error: text });
      else log("pty-host:", text);
    });
});

function exitAfterShutdown() {
  shutdown().finally(() => setTimeout(() => process.exit(0), 50));
}

process.stdin.on("end", exitAfterShutdown);
process.on("SIGTERM", exitAfterShutdown);
process.on("SIGINT", () => {
  /* Ctrl-C in the parent's terminal must not kill every session; the parent decides. */
});
process.on("uncaughtException", (error) => log("pty-host uncaught:", error && error.stack ? error.stack : String(error)));

send({ event: "ready", pid: process.pid });
