"use strict";
// The headless mirror's final frame. xterm.js drops the alternate screen when a program
// leaves it, and a full-screen CLI then clears the normal screen, so a snapshot taken at
// exit is blank. The last frame that still had text is kept and used when the exit frame
// has less of it.

const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const SCROLLBACK_LINES = 10000;
/** Leave-alternate: 1049 (xterm), 1047, or 47. */
const ALT_EXIT = /\x1b\[\?(?:\d+;)*(?:1049|1047|47)l/;

function log(...parts) {
  process.stderr.write(`${parts.join(" ")}\n`);
}

function attachCapture(sink) {
  sink.chain = null;
  sink.kept = null;
  sink.hold = "";
}

function writeParsed(term, data) {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => term.write(data, resolve));
}

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

function transcriptOf(mirror) {
  const normal = bufferText(mirror.buffer.normal);
  if (mirror.buffer.active.type !== "alternate") return normal ? `${normal}\n` : "";
  const screen = bufferText(mirror.buffer.alternate);
  return `${normal ? `${normal}\n\n` : ""}--- final screen ---\n${screen}\n`;
}

/** Text a person would read: no color codes, no cursor moves, no the alt-screen marker. */
function plainText(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/--- final screen ---/g, "")
    .trim();
}

function hasSessionText(mirror) {
  return bufferText(mirror.buffer.active).trim().length > 0;
}

function keepFrame(sink) {
  if (!hasSessionText(sink.mirror)) return;
  try {
    sink.kept = {
      ansi: sink.serializer.serialize({ scrollback: SCROLLBACK_LINES }),
      transcript: transcriptOf(sink.mirror),
    };
  } catch (error) {
    log("frame:", error.message);
  }
}

/** A CSI or OSC cut off at the end of a chunk, so the next chunk can finish it. */
function trailingPartial(text) {
  const esc = text.lastIndexOf("\x1b");
  if (esc < 0 || text.length - esc > 32) return "";
  const tail = text.slice(esc);
  if (/^\x1b\[[0-9;?]*$/.test(tail)) return tail;
  if (/^\x1b\][^\x07]*$/.test(tail)) return tail;
  return "";
}

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

function captureWrite(sink, data) {
  const run = () => {
    const pending = `${sink.hold || ""}${data}`;
    sink.hold = "";
    return writeSegments(sink, pending).catch((error) => log("mirror:", error.message));
  };
  sink.chain = sink.chain ? sink.chain.then(run, run) : run();
}

function flushHold(sink) {
  if (!sink.hold) return Promise.resolve();
  const data = sink.hold;
  sink.hold = "";
  return writeParsed(sink.mirror, data);
}

/** Wait until everything written so far has been parsed. */
function captureSynced(sink) {
  const pending = sink.chain || Promise.resolve();
  return pending.then(() => flushHold(sink), () => flushHold(sink)).then(
    () => new Promise((resolve) => sink.mirror.write("", resolve)),
  );
}

function artifacts(sink) {
  let ansi = sink.serializer.serialize({ scrollback: SCROLLBACK_LINES });
  let transcript = transcriptOf(sink.mirror);
  const keptPlain = sink.kept ? plainText(sink.kept.transcript) : "";
  if (keptPlain.length > plainText(transcript).length) {
    ansi = sink.kept.ansi;
    transcript = sink.kept.transcript;
  }
  return { ansi, transcript };
}

function captureFinish(sink) {
  const pending = sink.chain || Promise.resolve();
  return pending.then(() => flushHold(sink), () => flushHold(sink)).then(
    () => new Promise((resolve) => sink.mirror.write("", () => resolve(artifacts(sink)))),
  );
}

function terminalSize(data) {
  let cols = 80;
  let rows = 24;
  for (const match of data.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    rows = Math.max(rows, Number(match[1]));
    cols = Math.max(cols, Number(match[2]));
  }
  return { cols: Math.min(Math.max(cols, 2), 500), rows: Math.min(Math.max(rows, 2), 200) };
}

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
 * Rebuild a finished run's screen from its raw scrollback when the saved frame is blank.
 * Replay stops at the first leave-alternate, which is where the CLI wipes the screen.
 */
/** A trimmed scrollback can start in the middle of a color code. Drop that fragment. */
function alignStart(data) {
  if (data.charCodeAt(0) === 0x1b) return data;
  const esc = data.indexOf("\x1b");
  if (esc > 0 && esc <= 80) return data.slice(esc);
  return data;
}

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
