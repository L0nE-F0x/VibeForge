// @ts-check
"use strict";
// The end of a terminal's output. node-pty reads the pty through a Node stream, and when the
// program ends, three things could leave its last output unread or out of order:
// - libuv 1.51 (Node 22.23) ends the stream when the pty hangs up right after a short read, with
//   the kernel's last bytes still unread. libuv 1.52 (Node 24 and 26) fixed it. The terminal host
//   now runs on Electron's own Node (24), but VIBEFORGE_NODE can still put it on another.
// - node-pty destroys the stream 200 ms after the program exits, with whatever is still in it, so
//   a pane that was held back at that moment (flow control, or a snapshot) lost its tail.
// - Reading the pty before the piece already waiting in the stream put the tail ahead of it.
// So at the stream's end and at the program's exit, what the stream holds is read first and then
// the pty itself, until the kernel has nothing left. While a snapshot holds the output, what is
// read waits here and is handed over when the hold ends.
// Every use of node-pty's private fields (_socket, _fd, _boundClose) is in this file.

const fs = require("fs");

/**
 * The parts of node-pty's UnixTerminal used here.
 * @typedef {{
 *   _socket?: import("net").Socket & { _readableState?: { decoder?: { write(chunk: Buffer): string, end(): string } } },
 *   _fd?: number,
 *   _boundClose?: boolean,
 * }} PtyInternals
 */

/**
 * @typedef {object} Tail
 * @property {() => void} drain  Hand over everything left now: the stream's buffer, then the pty's.
 * @property {() => boolean} closing  Whether node-pty has seen the program exit and is closing the pty.
 * @property {() => void} hold  Keep output from now on instead of handing it over.
 * @property {() => void} letGo  Hand over what was kept, in order, and stop keeping.
 */

/**
 * Read a terminal's output through `deliver`, all of it and in order (see above).
 * @param {import("node-pty").IPty} term
 * @param {(data: string) => void} deliver
 * @param {{ onClosing?: () => void, log?: (...parts: unknown[]) => void }} [options]
 *   onClosing: the program has exited and what it left has been handed over (or kept, when held).
 * @returns {Tail}
 */
function attachTail(term, deliver, options = {}) {
  const internal = /** @type {PtyInternals} */ (/** @type {unknown} */ (term));
  const socket = internal._socket;
  const fd = typeof internal._fd === "number" ? internal._fd : -1;
  let holding = false;
  /** @type {string[]} */
  const kept = [];

  /** @param {string} data */
  const receive = (data) => {
    if (holding) kept.push(data);
    else deliver(data);
  };
  term.onData(receive);

  function drain() {
    // Once the stream is destroyed its fd is closed, and the number may belong to another file.
    if (!socket || socket.destroyed) return;
    // The older piece first: a paused stream holds one. read() hands it to node-pty's data event.
    while (socket.readableLength > 0 && socket.read() !== null);
    if (fd < 0) return;
    const decoder = socket._readableState?.decoder;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      let read = 0;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        // EIO: every program in the terminal has closed it and nothing is left. EAGAIN: one still
        // has it open and hasn't printed anything more; the stream reads that as usual.
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "EIO" && decoder) {
          const rest = decoder.end();
          if (rest) receive(rest);
        }
        return;
      }
      if (read <= 0) return;
      const piece = buffer.subarray(0, read);
      const text = decoder ? decoder.write(piece) : piece.toString("utf8");
      if (text) receive(text);
    }
  }

  if (socket) {
    // At 'end' the fd is still open: the stream is destroyed only after its 'end' listeners ran.
    socket.prependListener("end", drain);
    socket.on("close", () => {
      if (socket.readableLength > 0) options.log?.(`pty: ${socket.readableLength} characters were still unread when a terminal closed`);
    });
  }

  // node-pty sets _boundClose when it hears the exit before the stream has ended, and destroys the
  // stream 200 ms later.
  let boundClose = Boolean(internal._boundClose);
  Object.defineProperty(term, "_boundClose", {
    configurable: true,
    enumerable: true,
    get: () => boundClose,
    set: (value) => {
      boundClose = Boolean(value);
      if (!boundClose) return;
      drain();
      options.onClosing?.();
    },
  });

  return {
    drain,
    closing: () => boundClose,
    hold: () => {
      holding = true;
    },
    letGo: () => {
      holding = false;
      for (const data of kept.splice(0)) deliver(data);
    },
  };
}

module.exports = { attachTail };
