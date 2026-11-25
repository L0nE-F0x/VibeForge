// @ts-check
"use strict";
// A terminal's raw output, kept in its run folder as scrollback.txt: appended as it comes, and cut
// back to its last 2 MB whenever it passes 2.5 MB. It is the screen a run falls back to when its
// final frame was never written, so the cut never touches the file in place: the part kept is
// written to a file beside it, which then takes its name. A crash or a full disk partway through
// leaves the file as it was, only longer than the cap.

const fs = require("fs");
const path = require("path");

const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const SCROLLBACK_SLACK_BYTES = 512 * 1024;

/**
 * A run folder's scrollback file, open for appending.
 * @typedef {{
 *   runDir: string | null,
 *   scrollFd: number | null,
 *   scrollBytes: number,
 *   scrollFile: string | null,
 *   trimAfter?: number,
 * }} ScrollbackSink
 */

/**
 * The file system calls a cut makes, so a test can make one fail partway.
 * @typedef {{ writeFileSync: typeof fs.writeFileSync, renameSync: typeof fs.renameSync }} TrimFs
 */

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Say each kind of trouble at most once a minute, with how many more there were: a full disk fails
 * every write of every terminal, many times a second.
 * @param {(...parts: unknown[]) => void} log
 * @param {() => number} [now]
 */
function limitedLog(log, now = Date.now) {
  /** @type {Map<string, { at: number, quiet: number }>} */
  const said = new Map();
  /**
   * @param {string} kind
   * @param {string} text
   */
  return (kind, text) => {
    const at = now();
    const last = said.get(kind);
    if (last && at - last.at < 60_000) {
      last.quiet += 1;
      return;
    }
    log(`${kind}: ${text}${last?.quiet ? ` (and ${last.quiet} more like it in the last minute)` : ""}`);
    said.set(kind, { at, quiet: 0 });
  };
}

/**
 * @param {ScrollbackSink} sink
 * @param {(kind: string, text: string) => void} say
 */
function openScrollback(sink, say) {
  if (!sink.runDir) return;
  const file = path.join(sink.runDir, "scrollback.txt");
  try {
    sink.scrollFd = fs.openSync(file, "a", 0o600);
    fs.fchmodSync(sink.scrollFd, 0o600);
    sink.scrollBytes = fs.fstatSync(sink.scrollFd).size;
    sink.scrollFile = file;
  } catch (error) {
    say("scrollback", messageOf(error));
    sink.scrollFd = null;
  }
}

/**
 * @param {ScrollbackSink} sink
 * @param {string} data
 * @param {(kind: string, text: string) => void} say
 */
function appendScrollback(sink, data, say) {
  if (sink.scrollFd == null) return;
  try {
    const bytes = Buffer.from(data, "utf8");
    fs.writeSync(sink.scrollFd, bytes);
    sink.scrollBytes += bytes.length;
  } catch (error) {
    say("scrollback", messageOf(error));
    return;
  }
  if (sink.scrollBytes > (sink.trimAfter ?? MAX_SCROLLBACK_BYTES + SCROLLBACK_SLACK_BYTES)) trimScrollback(sink, say);
}

/**
 * Keep the last 2 MB: written beside the file, which then takes its name. Trimming in 512 KB
 * steps keeps the rewrite rare. A cut that fails leaves the file whole and is tried again only
 * after another 512 KB.
 * @param {ScrollbackSink} sink
 * @param {(kind: string, text: string) => void} say
 * @param {TrimFs} [io]
 */
function trimScrollback(sink, say, io = fs) {
  const writing = sink.scrollFd;
  const file = sink.scrollFile;
  if (writing == null || file == null) return;
  const temp = path.join(path.dirname(file), `.scrollback.txt.${process.pid}.tmp`);
  let size = sink.scrollBytes;
  try {
    size = fs.fstatSync(writing).size;
    const keep = Math.min(size, MAX_SCROLLBACK_BYTES);
    const buffer = Buffer.alloc(keep);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, keep, size - keep);
    } finally {
      fs.closeSync(fd);
    }
    io.writeFileSync(temp, buffer, { mode: 0o600 });
    io.renameSync(temp, file);
    // The open descriptor still writes to the file that was replaced: the new one takes over.
    sink.scrollFd = fs.openSync(file, "a", 0o600);
    sink.scrollBytes = keep;
    sink.trimAfter = undefined;
    try {
      fs.closeSync(writing);
    } catch {
      /* closed */
    }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing was written */
    }
    say("scrollback", `could not cut it back: ${messageOf(error)}`);
    sink.scrollBytes = size;
    sink.trimAfter = size + SCROLLBACK_SLACK_BYTES;
  }
}

/**
 * A run file written whole (the final screen, the transcript): through a file beside it that is on
 * disk before it takes the name, so a crash or a full disk leaves no half of one. Throws on failure,
 * with nothing left beside it.
 * @param {string} file
 * @param {string} text
 */
function writeWhole(file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

module.exports = { MAX_SCROLLBACK_BYTES, SCROLLBACK_SLACK_BYTES, limitedLog, openScrollback, appendScrollback, trimScrollback, writeWhole };
