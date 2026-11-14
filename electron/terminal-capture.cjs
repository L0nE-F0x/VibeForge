// @ts-check
"use strict";
// The headless mirror's final frame. xterm.js drops the alternate screen when a program
// leaves it, and a full-screen CLI then clears the normal screen, so a snapshot taken at
// exit is blank. The last frame that still had text is kept and used when the exit frame
// has less of it.

const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const SCROLLBACK_LINES = 10000;
/** The most output parsed in one go, so one busy pane doesn't hold up the others for long. */
const BATCH_CHARS = 256 * 1024;
/** Leave-alternate: 1049 (xterm), 1047, or 47. */
const ALT_EXIT = /\x1b\[\?(?:\d+;)*(?:1049|1047|47)l/;

/** @typedef {import("@xterm/headless").Terminal} Mirror */
/** @typedef {import("@xterm/headless").IBuffer} ScreenBuffer */

/**
 * A screen saved for a run: the frame to paint it again, and its text.
 * @typedef {{ ansi: string, transcript: string }} Frame
 */

/**
 * What attachCapture adds to a sink.
 * @typedef {object} CaptureState
 * @property {Promise<void> | null} chain  The parses still to come, one after another.
 * @property {Frame | null} kept  The last frame with text, from just before a program left the alternate screen.
 * @property {string} hold  An escape sequence cut off at the end of the last chunk.
 * @property {number} pending
 * @property {(() => void) | null} onDrain
 * @property {{ parts: string[], size: number } | null} waiting  Output to join the next parse.
 */

/**
 * A mirror that keeps a run's final frame: the sink's mirror and serializer, and the state above.
 * @typedef {{ mirror: Mirror, serializer: import("@xterm/addon-serialize").SerializeAddon } & CaptureState} Capture
 */

/** @param {...unknown} parts */
function log(...parts) {
  process.stderr.write(`${parts.join(" ")}\n`);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {Capture} sink */
function attachCapture(sink) {
  sink.chain = null;
  sink.kept = null;
  sink.hold = "";
  // Characters written but not parsed yet, so the host can hold back a pane that floods output.
  // `onDrain` hears each time some of them are done.
  sink.pending = 0;
  sink.onDrain = null;
  sink.waiting = null;
}

/**
 * @param {Mirror} term
 * @param {string} data
 * @returns {Promise<void>}
 */
function writeParsed(term, data) {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => term.write(data, resolve));
}

/** @param {ScreenBuffer} buffer */
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

/** @param {Mirror} mirror */
function transcriptOf(mirror) {
  const normal = bufferText(mirror.buffer.normal);
  if (mirror.buffer.active.type !== "alternate") return normal ? `${normal}\n` : "";
  const screen = bufferText(mirror.buffer.alternate);
  return `${normal ? `${normal}\n\n` : ""}--- final screen ---\n${screen}\n`;
}

/**
 * Text a person would read: no color codes, no cursor moves, no the alt-screen marker.
 * @param {string} text
 */
function plainText(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/--- final screen ---/g, "")
    .trim();
}

/** @param {Mirror} mirror */
function hasSessionText(mirror) {
  return bufferText(mirror.buffer.active).trim().length > 0;
}

/** @param {Capture} sink */
function keepFrame(sink) {
  if (!hasSessionText(sink.mirror)) return;
  try {
    sink.kept = {
      ansi: sink.serializer.serialize({ scrollback: SCROLLBACK_LINES }),
      transcript: transcriptOf(sink.mirror),
    };
  } catch (error) {
    log("frame:", messageOf(error));
  }
}

/**
 * A CSI or OSC cut off at the end of a chunk, so the next chunk can finish it.
 * @param {string} text
 */
function trailingPartial(text) {
  const esc = text.lastIndexOf("\x1b");
  if (esc < 0 || text.length - esc > 32) return "";
  const tail = text.slice(esc);
  if (tail === "\x1b") return tail;
  if (/^\x1b\[[0-9;?]*$/.test(tail)) return tail;
  if (/^\x1b\][^\x07]*$/.test(tail)) return tail;
  return "";
}

/**
 * @param {Capture} sink
 * @param {string} data
 * @returns {Promise<void>}
 */
function writeSegments(sink, data) {
  const match = ALT_EXIT.exec(data);
  if (!match) {
    const partial = trailingPartial(data);
    const body = partial ? data.slice(0, -partial.length) : data;
    sink.hold = partial;
    return writeParsed(sink.mirror, body);
  }
  const head = data.slice(0, match.index);
  const exitSeq = match[0];
  const after = data.slice(match.index + exitSeq.length);
  return writeParsed(sink.mirror, head)
    .then(() => {
      keepFrame(sink);
      return writeParsed(sink.mirror, exitSeq);
    })
    .then(() => writeSegments(sink, after));
}

/**
 * @param {Capture} sink
 * @param {string} data
 */
function captureWrite(sink, data) {
  sink.pending += data.length;
  // Output waiting behind a write still being parsed joins one batch: a pty hands over a few
  // KB at a time, and a parse per piece left a flood ever further behind.
  const waiting = sink.waiting;
  if (waiting && waiting.size < BATCH_CHARS) {
    waiting.parts.push(data);
    waiting.size += data.length;
    return;
  }
  const batch = { parts: [data], size: data.length };
  sink.waiting = batch;
  const run = () => {
    if (sink.waiting === batch) sink.waiting = null;
    const pending = `${sink.hold || ""}${batch.parts.join("")}`;
    sink.hold = "";
    return writeSegments(sink, pending)
      .catch((error) => log("mirror:", messageOf(error)))
      .then(() => {
        sink.pending -= batch.size;
        if (sink.onDrain) sink.onDrain();
      });
  };
  sink.chain = sink.chain ? sink.chain.then(run, run) : run();
}

/** @param {Capture} sink */
function flushHold(sink) {
  if (!sink.hold) return Promise.resolve();
  const data = sink.hold;
  sink.hold = "";
  return writeParsed(sink.mirror, data);
}

/**
 * Wait until everything written so far has been parsed.
 * @param {Capture} sink
 * @returns {Promise<void>}
 */
function captureSynced(sink) {
  const pending = sink.chain || Promise.resolve();
  const next = pending.then(() => flushHold(sink), () => flushHold(sink)).then(
    () => /** @type {Promise<void>} */ (new Promise((resolve) => sink.mirror.write("", () => resolve(undefined)))),
  );
  sink.chain = next;
  return next;
}

/**
 * @param {Capture} sink
 * @returns {Frame}
 */
function artifacts(sink) {
  let ansi = sink.serializer.serialize({ scrollback: SCROLLBACK_LINES });
  let transcript = transcriptOf(sink.mirror);
  const kept = sink.kept;
  const keptPlain = kept ? plainText(kept.transcript) : "";
  if (kept && keptPlain.length > plainText(transcript).length) {
    ansi = kept.ansi;
    transcript = kept.transcript;
  }
  return { ansi, transcript };
}

/**
 * @param {Capture} sink
 * @returns {Promise<Frame>}
 */
function captureFinish(sink) {
  const pending = sink.chain || Promise.resolve();
  return pending.then(() => flushHold(sink), () => flushHold(sink)).then(
    () => new Promise((resolve) => sink.mirror.write("", () => resolve(artifacts(sink)))),
  );
}

/** @param {string} data */
function terminalSize(data) {
  let cols = 80;
  let rows = 24;
  for (const match of data.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    rows = Math.max(rows, Number(match[1]));
    cols = Math.max(cols, Number(match[2]));
  }
  return { cols: Math.min(Math.max(cols, 2), 500), rows: Math.min(Math.max(rows, 2), 200) };
}

/** @param {Mirror} term */
function viewportText(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let index = 0; index < term.rows; index += 1) {
    const line = buffer.getLine(buffer.baseY + index);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/**
 * A trimmed scrollback can start in the middle of a color code. Drop that fragment.
 * @param {string} data
 */
function alignStart(data) {
  if (data.charCodeAt(0) === 0x1b) return data;
  const esc = data.indexOf("\x1b");
  if (esc > 0 && esc <= 80) return data.slice(esc);
  return data;
}

/**
 * Rebuild a finished run's screen from its raw scrollback when the saved frame is blank.
 * Replay stops at the first leave-alternate, which is where the CLI wipes the screen.
 * @param {string} scrollback
 * @returns {Promise<Frame | null>}
 */
function restoreScrollback(scrollback) {
  const match = ALT_EXIT.exec(scrollback);
  if (!match) return Promise.resolve(null);
  const cut = alignStart(scrollback.slice(0, match.index));
  if (!plainText(cut)) return Promise.resolve(null);
  const { cols, rows } = terminalSize(cut);
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return writeParsed(term, cut).then(() => {
    const transcript = viewportText(term);
    if (!plainText(transcript)) return null;
    return {
      ansi: serializer.serialize({ scrollback: 0 }),
      transcript: transcript.endsWith("\n") ? transcript : `${transcript}\n`,
    };
  });
}

module.exports = {
  SCROLLBACK_LINES,
  attachCapture,
  captureWrite,
  captureSynced,
  captureFinish,
  restoreScrollback,
  plainText,
};
