// @ts-check
"use strict";
// VibeForge PTY host. Electron starts this on its own Node (ELECTRON_RUN_AS_NODE: Electron's
// binary run as plain Node), which loads node-pty's Node-API addon like any Node does. It owns
// every terminal: the process, a headless mirror of its screen, and the terminal files in the run
// folder. It speaks JSON lines on stdin and stdout.

// The switch that made Electron's binary start as Node is the host's alone: a terminal that kept
// it would start any Electron app run there (VS Code, VibeForge itself) as plain Node instead.
delete process.env.ELECTRON_RUN_AS_NODE;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { SCROLLBACK_LINES, attachCapture, captureWrite, captureSynced, captureFinish } = require("./terminal-capture.cjs");
const { attachTail } = require("./pty-drain.cjs");
const scrollback = require("./scrollback-file.cjs");

const FLUSH_MS = 6;
const PASTE_QUIET_MS = 700;
const PASTE_FIRST_OUTPUT_MS = 3000;
const PASTE_MAX_WAIT_MS = 20000;
const ENTER_AFTER_PASTE_MS = 150;
const EXIT_SETTLE_MS = 120;
// Stop hangs up at once, then asks (SIGTERM) and insists (SIGKILL) after these.
const STOP_TERM_MS = 1500;
const STOP_KILL_MS = 4000;
const PROGRAM_POLL_MS = 1000;
// A terminal is "working" while the text on its screen keeps changing, and quiet once it has
// held still for a few seconds: a coding CLI's spinner ticks while it thinks and stops when it
// wants you. Rows are compared as text, so a CLI that redraws the same screen stays quiet.
const ACTIVITY_TICK_MS = 1000;
const WORK_ROWS = 3;
const QUIET_TICKS = 3;
// A pane that prints faster than its mirror parses or the app reads (cat of a big log) is paused
// at the pty, the way a real terminal is: the program waits on its write, and the host holds at
// most about this much per terminal instead of all of it.
const PENDING_HIGH = 8 * 1024 * 1024;
const PENDING_LOW = 2 * 1024 * 1024;
const PAUSED_LOOK_MS = 15;

// The messages are typed in pty-protocol.ts, which the window's side (supervisor.ts) uses too.
/** @import { PtyAnswer, PtyLine, PtyOp, PtyRequest } from "./pty-protocol.js" */
/** @import { Capture, CaptureState } from "./terminal-capture.cjs" */
/** @import { Tail } from "./pty-drain.cjs" */

/** @import { ScrollbackSink } from "./scrollback-file.cjs" */

/**
 * A run folder's terminal files and the mirror that writes them (scrollback-file.cjs keeps the raw output).
 * @typedef {Capture & ScrollbackSink} Sink
 */

/**
 * A prompt waiting for the program to settle before it is pasted.
 * @typedef {object} Paste
 * @property {string} text
 * @property {NodeJS.Timeout | undefined} quietTimer
 * @property {NodeJS.Timeout | undefined} capTimer
 * @property {boolean} done
 * @property {() => void} deliver
 */

/**
 * One terminal: its process, its mirror and its files.
 * @typedef {Sink & {
 *   id: string,
 *   ptyToken: string,
 *   pid: number,
 *   cwd: string,
 *   argv: string[],
 *   term: import("node-pty").IPty,
 *   tail: Tail,
 *   cols: number,
 *   rows: number,
 *   seq: number,
 *   batch: string[],
 *   batchFirst: number | null,
 *   flushTimer: NodeJS.Timeout | undefined,
 *   exited: boolean,
 *   killTimers: NodeJS.Timeout[],
 *   stopAt?: number,
 *   paste: Paste | null,
 *   rec: Sink | null,
 *   recSeq?: number,
 *   dirty: boolean,
 *   screen: { rows: string[], base: number } | null,
 *   reflowed?: boolean,
 *   changes: number,
 *   stillTicks: number,
 *   working: boolean,
 *   unsent: number,
 *   paused: boolean,
 *   holds?: number,
 *   afterHold?: () => void,
 *   pauseTimer: NodeJS.Timeout | undefined,
 *   gone: boolean,
 *   exitWaiters?: Array<() => void>,
 *   programKey?: string,
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();
/** Stopped terminals whose leader has exited, while what they left behind is still being stopped. */
/** @type {Set<Promise<void>>} */
const draining = new Set();

/**
 * @param {PtyLine} message
 * @param {(error?: Error | null) => void} [written]
 */
function send(message, written) {
  process.stdout.write(`${JSON.stringify(message)}\n`, written);
}

/**
 * Answer a request with what its op promises.
 * @template {PtyOp} Op
 * @param {{ reqId: string, op: Op }} msg
 * @param {PtyAnswer<Op>} body
 */
function reply(msg, body) {
  send({ reqId: msg.reqId, ...body });
}

/** @param {...unknown} parts */
function log(...parts) {
  process.stderr.write(`${parts.join(" ")}\n`);
}

/** Trouble that repeats with every chunk (a full disk) goes in the log once a minute. */
const say = scrollback.limitedLog(log);

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
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

// A session's own run folder and a recording inside a shell (below) both keep these files; each
// is a "sink": { runDir, mirror, serializer, scrollFd, scrollBytes, scrollFile }.

/**
 * The final screen and a text transcript, once the mirror has caught up; then the scrollback closes.
 * @param {Sink} sink
 * @param {() => void} done
 */
function closeSink(sink, done) {
  captureFinish(sink)
    .then((captured) => {
      if (sink.runDir) {
        // Each whole or not at all: a screen cut short would hide the scrollback the run falls back to.
        for (const [name, text] of [
          ["terminal.ansi", captured.ansi],
          ["transcript.txt", captured.transcript],
        ]) {
          try {
            scrollback.writeWhole(path.join(sink.runDir, name), text);
          } catch (error) {
            say("artifacts", messageOf(error));
          }
        }
      }
    })
    .catch((error) => {
      say("artifacts", messageOf(error));
    })
    .finally(() => {
      if (sink.scrollFd != null) {
        try {
          fs.closeSync(sink.scrollFd);
        } catch {
          /* closed */
        }
        sink.scrollFd = null;
      }
      done();
    });
}

// ------------------------------------------------------------------ recording a shell

// `claude` typed into a shell is recorded like a launched run: from the moment it takes the
// foreground until the prompt comes back, into its own run folder, through a second mirror
// that starts from what the screen showed then.

/**
 * @param {Session} session
 * @param {string} runDir
 * @returns {Promise<void>}
 */
function startRecording(session, runDir) {
  // stopRecording counts every start and stop: one that comes after this, even while the last
  // recording is still being written, leaves this one unpublished.
  const stopped = stopRecording(session);
  const seq = session.recSeq;
  return stopped
    .then(() => captureSynced(session))
    .then(
      () =>
        new Promise((resolve) => {
          if (session.exited || sessions.get(session.id) !== session || session.recSeq !== seq) {
            resolve();
            return;
          }
          const mirror = new Terminal({ cols: session.cols, rows: session.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
          const serializer = new SerializeAddon();
          mirror.loadAddon(serializer);
          /** @type {Omit<Sink, keyof CaptureState>} */
          const files = { runDir, mirror, serializer, scrollFd: null, scrollBytes: 0, scrollFile: null };
          // attachCapture adds the rest.
          const rec = /** @type {Sink} */ (files);
          attachCapture(rec);
          rec.onDrain = () => relieve(session);
          // Seed with the screen as it is now, then publish the recording so later output lands in it.
          mirror.write(session.serializer.serialize({ scrollback: 0 }), () => {
            if (session.exited || sessions.get(session.id) !== session || session.recSeq !== seq) {
              try {
                rec.mirror.dispose();
              } catch {
                /* disposed */
              }
              resolve();
              return;
            }
            scrollback.openScrollback(rec, say);
            session.rec = rec;
            resolve();
          });
        }),
    );
}

/**
 * @param {Session} session
 * @returns {Promise<void>}
 */
function stopRecording(session) {
  session.recSeq = (session.recSeq || 0) + 1;
  const rec = session.rec;
  if (!rec) return Promise.resolve();
  session.rec = null;
  return new Promise((resolve) =>
    closeSink(rec, () => {
      rec.mirror.dispose();
      resolve();
    }),
  );
}

// ------------------------------------------------------------------ input

/**
 * @param {Session} session
 * @param {string} data
 */
function writeInput(session, data) {
  if (session.exited) return;
  session.term.write(data);
}

/**
 * Text that can only be read as text once pasted: line breaks become "\n", and every other control
 * byte goes, ESC and DEL included. With ESC gone no paste marker can survive, however it is nested
 * (`\x1b[20\x1b[201~1~` would collapse into a live end-of-paste with a one-pass strip), so
 * nothing after it can arrive as keystrokes: no Ctrl+C, no Enter that sends a draft.
 * @param {unknown} text
 */
function pasteSafe(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Paste text the way a person would, then press Enter, unless `enter` is false (a draft to read first).
 * @param {Session} session
 * @param {string} text
 * @param {boolean} [enter]
 * @param {boolean} [fromSpawn]
 */
function sendText(session, text, enter = true, fromSpawn = false) {
  if (session.exited) return;
  const clean = pasteSafe(text);
  if (session.mirror.modes.bracketedPasteMode) {
    writeInput(session, `\x1b[200~${clean}\x1b[201~`);
    if (enter) setTimeout(() => writeInput(session, "\r"), ENTER_AFTER_PASTE_MS);
  } else {
    // Without bracketed paste, a multi-line send becomes several Enters; collapse newlines to spaces so an early line can't exit a CLI into bash.
    const flat = fromSpawn ? clean.replace(/\n/g, "\r") : clean.replace(/\s*\n+\s*/g, " ");
    writeInput(session, enter ? `${flat}\r` : flat);
  }
}

/** @param {Paste} paste */
function clearPasteTimers(paste) {
  clearTimeout(paste.quietTimer);
  clearTimeout(paste.capTimer);
}

/**
 * @param {Session} session
 * @param {string} text
 */
function armPaste(session, text) {
  const deliver = () => {
    if (paste.done || session.exited) return;
    paste.done = true;
    clearPasteTimers(paste);
    session.paste = null;
    session.mirror.write("", () => sendText(session, paste.text, true, true));
  };
  /** @type {Paste} */
  const paste = { text, quietTimer: undefined, capTimer: undefined, done: false, deliver };
  session.paste = paste;
  paste.quietTimer = setTimeout(deliver, PASTE_FIRST_OUTPUT_MS);
  paste.capTimer = setTimeout(deliver, PASTE_MAX_WAIT_MS);
}

/** @param {Session} session */
function notePasteActivity(session) {
  const paste = session.paste;
  if (!paste || paste.done) return;
  clearTimeout(paste.quietTimer);
  paste.quietTimer = setTimeout(paste.deliver, PASTE_QUIET_MS);
}

// ------------------------------------------------------------------ output batching

/** @param {Session} session */
function flush(session) {
  clearTimeout(session.flushTimer);
  session.flushTimer = undefined;
  // A batch always has its first chunk's number; the second test is for the checker.
  if (session.batch.length === 0 || session.batchFirst === null) return;
  const data = session.batch.join("");
  send({ event: "data", ptyId: session.id, data, first: session.batchFirst, seq: session.seq }, () => {
    session.unsent -= data.length;
    relieve(session);
  });
  session.batch = [];
  session.batchFirst = null;
}

// ------------------------------------------------------------------ flow control

/**
 * Output this terminal holds: not yet read by the app, or not yet parsed by a mirror.
 * @param {Session} session
 */
function pendingOf(session) {
  return session.unsent + session.pending + (session.rec ? session.rec.pending : 0);
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/** @param {Session} session */
function throttle(session) {
  if (session.paused || session.gone || pendingOf(session) <= PENDING_HIGH) return;
  if (session.tail.closing() || !alive(session.pid)) {
    session.gone = true;
    return;
  }
  session.paused = true;
  session.term.pause();
  // node-pty drops what is still unread 200 ms after the program exits. The tail hands that over
  // when node-pty hears the exit; this also catches a program reaped before node-pty heard it.
  session.pauseTimer = setInterval(() => {
    if (!session.tail.closing() && alive(session.pid)) return;
    session.gone = true;
    session.tail.drain();
    release(session);
  }, PAUSED_LOOK_MS);
}

/** @param {Session} session */
function relieve(session) {
  if (session.paused && pendingOf(session) < PENDING_LOW) release(session);
}

/** @param {Session} session */
function release(session) {
  clearInterval(session.pauseTimer);
  session.pauseTimer = undefined;
  if (!session.paused) return;
  session.paused = false;
  // A snapshot holding the output resumes it when it is done.
  if (session.holds) return;
  try {
    session.term.resume();
  } catch {
    /* the pty closed underneath us */
  }
}

/**
 * Stop reading a terminal's output for a moment, so nothing new reaches its mirror while a
 * snapshot is taken. Holds nest; flow control's own pause is left as it is.
 * @param {Session} session
 */
function hold(session) {
  session.holds = (session.holds || 0) + 1;
  if (session.holds > 1) return;
  // What the tail reads while held (the program ended) waits for the hold to end.
  session.tail.hold();
  if (session.paused) return;
  try {
    session.term.pause();
  } catch {
    /* the pty closed underneath us */
  }
}

/** @param {Session} session */
function unhold(session) {
  session.holds = Math.max(0, (session.holds || 0) - 1);
  if (session.holds > 0) return;
  session.tail.letGo();
  if (!session.paused) {
    try {
      session.term.resume();
    } catch {
      /* the pty closed underneath us */
    }
  }
  // An exit heard during the hold is finished now, after what it left.
  const finishing = session.afterHold;
  session.afterHold = undefined;
  if (finishing) finishing();
}

// ------------------------------------------------------------------ sessions

/** @param {Extract<PtyRequest, { op: "spawn" }>} msg */
function spawnSession(msg) {
  const argv = Array.isArray(msg.argv) && msg.argv.length ? msg.argv.map(String) : [process.env.SHELL || "/bin/bash"];
  const cols = Math.max(2, Number(msg.cols) || 120);
  const rows = Math.max(2, Number(msg.rows) || 32);
  const runDir = typeof msg.runDir === "string" && msg.runDir ? msg.runDir : null;
  const id = crypto.randomUUID();
  const ptyToken = crypto.randomBytes(24).toString("hex");
  // VIBEFORGE_PTY tells `vibeforge tell` which terminal it was typed in; VIBEFORGE_PTY_TOKEN authenticates it.
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "VibeForge", VIBEFORGE_PTY: id, VIBEFORGE_PTY_TOKEN: ptyToken };
  if (runDir) env.VIBEFORGE_RUN_DIR = runDir;
  const term = pty.spawn(argv[0], argv.slice(1), { name: "xterm-256color", cols, rows, cwd: msg.cwd, env });
  // The tail reads the output, the end included, into onData below; node-pty emits nothing before
  // this turn is over.
  const tail = attachTail(term, (data) => onData(data), {
    onClosing: () => {
      session.gone = true;
      release(session);
    },
    log,
  });
  const mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const serializer = new SerializeAddon();
  mirror.loadAddon(serializer);
  /** @type {Omit<Session, keyof CaptureState>} */
  const fields = {
    id,
    ptyToken,
    pid: term.pid,
    cwd: msg.cwd,
    argv,
    runDir,
    term,
    tail,
    mirror,
    serializer,
    cols,
    rows,
    seq: 0,
    batch: [],
    batchFirst: null,
    flushTimer: undefined,
    exited: false,
    killTimers: [],
    paste: null,
    scrollFd: null,
    scrollBytes: 0,
    scrollFile: null,
    rec: null,
    dirty: false,
    screen: null,
    changes: 0,
    stillTicks: 0,
    working: false,
    unsent: 0,
    paused: false,
    pauseTimer: undefined,
    gone: false,
  };
  // attachCapture adds the rest.
  const session = /** @type {Session} */ (fields);
  attachCapture(session);
  session.onDrain = () => relieve(session);
  scrollback.openScrollback(session, say);
  sessions.set(id, session);

  /** @param {string} data */
  const onData = (data) => {
    session.seq += 1;
    if (session.batchFirst === null) session.batchFirst = session.seq;
    session.batch.push(data);
    session.unsent += data.length;
    captureWrite(session, data);
    scrollback.appendScrollback(session, data, say);
    if (session.rec) {
      captureWrite(session.rec, data);
      scrollback.appendScrollback(session.rec, data, say);
    }
    notePasteActivity(session);
    session.dirty = true;
    if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), FLUSH_MS);
    throttle(session);
  };
  term.onExit(({ exitCode, signal }) => {
    // node-pty can report the exit before the last bytes are read; give them a moment.
    setTimeout(() => finish(session, exitCode, signal), EXIT_SETTLE_MS);
  });

  if (typeof msg.pasteInput === "string" && msg.pasteInput.trim()) armPaste(session, msg.pasteInput);
  return session;
}

/**
 * @param {Session} session
 * @param {number} exitCode
 * @param {number | undefined} signal
 */
function finish(session, exitCode, signal) {
  if (session.exited) return;
  // A snapshot holding the output has what the program left; the exit waits for it to be let go.
  if (session.holds) {
    session.afterHold = () => finish(session, exitCode, signal);
    return;
  }
  session.tail.drain();
  session.exited = true;
  session.gone = true;
  release(session);
  // A stopped terminal's leader is gone, but what it left in its session still gets the rest of
  // the steps until nothing is left. A terminal that ended on its own leaves its leftovers be, as
  // a closed terminal window does.
  if (!session.stopAt) for (const timer of session.killTimers) clearTimeout(timer);
  else {
    const left = waitForEmpty(session);
    draining.add(left);
    void left.then(() => draining.delete(left));
  }
  if (session.paste) clearPasteTimers(session.paste);
  flush(session);
  // A recording in progress is written before the exit is reported, so its run finds its files.
  stopRecording(session)
    .then(() => /** @type {Promise<void>} */ (new Promise((resolve) => closeSink(session, resolve))))
    .then(() => {
      send({ event: "exit", ptyId: session.id, exitCode: exitCode ?? null, signal: signal || null });
      sessions.delete(session.id);
      session.mirror.dispose();
      const waiters = session.exitWaiters || [];
      for (const wake of waiters) wake();
    });
}

/** @param {Session} session */
function killSession(session) {
  if (session.exited || session.stopAt) return;
  session.stopAt = Date.now();
  // What closing a terminal window does: hang up, then ask, then insist. The asking and insisting
  // reach every process still in the terminal, so one that ignores the hang-up (a nohup'd server,
  // a background job in a group of its own) doesn't outlive Stop.
  signalGroup(session.pid, "SIGHUP");
  session.killTimers.push(setTimeout(() => signalSession(session, "SIGTERM"), STOP_TERM_MS));
  session.killTimers.push(setTimeout(() => signalSession(session, "SIGKILL"), STOP_KILL_MS));
}

/**
 * The processes still in a terminal's session, zombies aside. node-pty starts each terminal as a
 * session of its own, so this is everything started in it, background jobs included, but not a
 * program that left with setsid on purpose. Linux only (/proc); empty elsewhere.
 * @param {number} sid
 * @returns {number[]}
 */
function sessionMembers(sid) {
  /** @type {number[]} */
  const members = [];
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return members;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // Fields after the command name: state ppid pgrp session ...
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] !== "Z" && Number(fields[3]) === sid) members.push(Number(name));
    } catch {
      /* gone already */
    }
  }
  return members;
}

/**
 * Signal everything left in a terminal. Once its leader has exited only processes found in its
 * session are signalled, never the leader's pid on its own, which may belong to someone else by then.
 * @param {Session} session
 * @param {NodeJS.Signals} signal
 */
function signalSession(session, signal) {
  const members = sessionMembers(session.pid);
  if (members.length === 0) {
    if (!session.exited) signalGroup(session.pid, signal);
    return;
  }
  for (const pid of members) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Resolves once a stopped terminal has nothing left in it, or once its last step has had time to
 * land; the steps that are still to come are then dropped.
 * @param {Session} session
 * @returns {Promise<void>}
 */
function waitForEmpty(session) {
  return new Promise((resolve) => {
    const look = () => {
      const over = !session.stopAt || Date.now() > session.stopAt + STOP_KILL_MS + 500;
      if (over || sessionMembers(session.pid).length === 0) {
        for (const timer of session.killTimers) clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(look, 100);
    };
    look();
  });
}

/**
 * @param {Session} session
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
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

/** @param {{ ptyId: string }} msg */
function need(msg) {
  const session = sessions.get(msg.ptyId);
  if (!session || session.exited) throw new Error("That session has ended.");
  return session;
}

/** @param {PtyRequest} msg */
async function handle(msg) {
  switch (msg.op) {
    case "spawn": {
      const session = spawnSession(msg);
      reply(msg, { ok: true, ptyId: session.id, pid: session.pid, ptyToken: session.ptyToken });
      return;
    }
    case "write":
      writeInput(need(msg), String(msg.data ?? ""));
      reply(msg, { ok: true });
      return;
    case "send":
      sendText(need(msg), String(msg.text ?? ""), msg.enter !== false);
      reply(msg, { ok: true });
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
            if (session.rec) session.rec.mirror.resize(cols, rows);
            session.reflowed = true;
          } catch {
            /* the pty closed underneath us */
          }
        }
      }
      reply(msg, { ok: true });
      return;
    }
    case "kill": {
      const session = sessions.get(msg.ptyId);
      if (session) killSession(session);
      reply(msg, { ok: true });
      return;
    }
    case "record": {
      const session = need(msg);
      if (typeof msg.runDir === "string" && msg.runDir) await startRecording(session, msg.runDir);
      else await stopRecording(session);
      reply(msg, { ok: true });
      return;
    }
    case "snapshot": {
      const session = sessions.get(msg.ptyId);
      if (!session || session.exited) {
        reply(msg, { ok: true, ansi: "", seq: 0, cols: 0, rows: 0, alive: false });
        return;
      }
      // The screen and the number it is sent with must agree: output that reached the mirror
      // after `seq` was read would be in the screen and then replayed on top of it by the pane. So
      // the output is held while the mirror catches up and the screen is read in the same turn.
      hold(session);
      flush(session);
      const seq = session.seq;
      captureSynced(session)
        .then(
          () => {
            reply(msg, {
              ok: true,
              ansi: session.serializer.serialize({ scrollback: SCROLLBACK_LINES }),
              plain: recentText(session, 160),
              seq,
              cols: session.cols,
              rows: session.rows,
              alive: true,
            });
          },
          (error) => reply(msg, { ok: false, error: messageOf(error) }),
        )
        .finally(() => unhold(session));
      return;
    }
    case "screen": {
      // The last lines as text, for the phone and for reading a CLI's answer: no colours and no
      // scrollback, so none of the cost of serializing the whole buffer.
      const session = sessions.get(msg.ptyId);
      if (!session || session.exited) {
        reply(msg, { ok: true, plain: "", alive: false });
        return;
      }
      captureSynced(session).then(
        () => reply(msg, { ok: true, plain: recentText(session, 160), alive: true }),
        (error) => reply(msg, { ok: false, error: messageOf(error) }),
      );
      return;
    }
    case "list":
      reply(msg, {
        ok: true,
        ptys: [...sessions.values()].map((session) => ({ ptyId: session.id, pid: session.pid, cwd: session.cwd, argv: session.argv })),
      });
      return;
    case "foreground": {
      const session = sessions.get(msg.ptyId);
      if (!session || session.exited) {
        reply(msg, { ok: true, known: false, argv: null, cwd: null });
        return;
      }
      try {
        const found = readForeground(session);
        reply(msg, { ok: true, known: true, argv: found ? found.argv : null, cwd: found ? found.cwd : null });
      } catch {
        reply(msg, { ok: true, known: false, argv: null, cwd: null });
      }
      return;
    }
    case "shutdown":
      await shutdown();
      reply(msg, { ok: true });
      return;
    default:
      // Not one the window sends: whatever came down the line.
      throw new Error(`Unknown op ${/** @type {{ op?: unknown }} */ (msg).op}`);
  }
}

// ------------------------------------------------------------------ working or quiet

/**
 * The last lines a person would read, including a little of what scrolled off the screen.
 * @param {Session} session
 * @param {number} maxLines
 */
function recentText(session, maxLines) {
  const buffer = session.mirror.buffer.active;
  const end = buffer.baseY + session.rows;
  const start = Math.max(0, end - maxLines);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    // A row that wraps onto the next keeps its trailing blanks, or the words either side of the wrap run together.
    const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/** @param {Session} session */
function screenRows(session) {
  const buffer = session.mirror.buffer.active;
  const rows = [];
  for (let index = 0; index < session.rows; index += 1) rows.push(buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "");
  return { rows, base: buffer.baseY };
}

/**
 * Rows whose text differs from the last look, allowing for lines that scrolled up since.
 * @param {Session} session
 */
function changedRows(session) {
  if (!session.dirty) return 0;
  session.dirty = false;
  const now = screenRows(session);
  const before = session.screen;
  session.screen = now;
  // The first look, or the first since a resize reflowed everything, is only a baseline.
  if (!before || before.rows.length !== now.rows.length || session.reflowed) {
    session.reflowed = false;
    return 0;
  }
  const shift = now.base - before.base;
  let changed = 0;
  for (let index = 0; index < now.rows.length; index += 1) if (now.rows[index] !== before.rows[index + shift]) changed += 1;
  return changed;
}

setInterval(() => {
  for (const session of sessions.values()) {
    if (session.exited) continue;
    const changed = changedRows(session);
    if (changed > 0) {
      session.stillTicks = 0;
      session.changes += changed;
      if (!session.working && session.changes >= WORK_ROWS) {
        session.working = true;
        send({ event: "activity", ptyId: session.id, working: true });
      }
      continue;
    }
    session.stillTicks += 1;
    if (session.stillTicks < QUIET_TICKS) continue;
    session.changes = 0;
    if (session.working) {
      session.working = false;
      send({ event: "activity", ptyId: session.id, working: false });
    }
  }
}, ACTIVITY_TICK_MS).unref();

// ------------------------------------------------------------------ foreground program

/**
 * The command line of whatever holds the terminal's foreground, when that isn't the process
 * VibeForge started: `claude` typed into a shell, say. Linux only (/proc); null elsewhere.
 * @param {Session} session
 * @returns {{ argv: string[], cwd: string | null } | null}
 */
function readForeground(session) {
  const stat = fs.readFileSync(`/proc/${session.pid}/stat`, "utf8");
  // Fields after the command name: state ppid pgrp session tty_nr tpgid ...
  const tpgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
  if (!(tpgid > 0) || tpgid === session.pid) return null;
  const argv = fs.readFileSync(`/proc/${tpgid}/cmdline`, "utf8").split("\0").filter(Boolean);
  if (!argv.length) return null;
  /** @type {string | null} */
  let cwd = null;
  try {
    cwd = fs.readlinkSync(`/proc/${tpgid}/cwd`);
  } catch {
    /* gone already */
  }
  return { argv, cwd };
}

/** @param {Session} session */
function foreground(session) {
  try {
    return readForeground(session);
  } catch {
    return null;
  }
}

setInterval(() => {
  for (const session of sessions.values()) {
    if (session.exited) continue;
    const found = foreground(session);
    const key = found ? found.argv.join("\0") : "";
    if (key === (session.programKey || "")) continue;
    session.programKey = key;
    send({ event: "program", ptyId: session.id, argv: found ? found.argv : null, cwd: found ? found.cwd : null });
  }
}, PROGRAM_POLL_MS).unref();

/** @type {Promise<void[]> | null} */
let shuttingDown = null;

function shutdown() {
  if (shuttingDown) return shuttingDown;
  const live = [...sessions.values()];
  for (const session of live) killSession(session);
  // Quitting waits for what each terminal left behind too: the host's timers end with it.
  shuttingDown = Promise.all([...live.map((session) => waitForExit(session, 6000).then(() => waitForEmpty(session))), ...draining]);
  return shuttingDown;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  /** @type {PtyRequest} What the window sends; anything else is refused in handle. */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve()
    .then(() => handle(msg))
    .catch((error) => {
      const text = messageOf(error);
      if (msg && msg.reqId) send({ reqId: msg.reqId, ok: false, error: text });
      else log("pty-host:", text);
    });
});

function exitAfterShutdown() {
  shutdown().finally(() => setTimeout(() => process.exit(0), 50));
}

process.stdin.on("end", exitAfterShutdown);
process.on("SIGTERM", exitAfterShutdown);
// The terminal VibeForge was started from closing: end the sessions properly (their run files
// written) rather than dying mid-write.
process.on("SIGHUP", exitAfterShutdown);
process.on("SIGINT", () => {
  /* Ctrl-C in the parent's terminal must not kill every session; the parent decides. */
});
process.on("uncaughtException", (error) => log("pty-host uncaught:", error && error.stack ? error.stack : String(error)));

// Which Node and libuv the host runs on, for the log: libuv 1.51 (Node 22) loses a program's last output.
send({ event: "ready", pid: process.pid, node: process.versions.node, uv: process.versions.uv });
