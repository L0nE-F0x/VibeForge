import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { describe, expect, it } from "vitest";

// The end of a terminal's output (electron/pty-drain.cjs), against real node-pty and bash: what a
// program prints just before it ends arrives whole and in order, whatever the reader was doing.

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");
const { attachTail } = require(path.resolve("electron/pty-drain.cjs")) as {
  attachTail(term: IPty, deliver: (data: string) => void, options?: { onClosing?: () => void; log?: (...parts: unknown[]) => void }): {
    drain(): void;
    closing(): boolean;
    hold(): void;
    letGo(): void;
  };
};

function spawn(script: string): IPty {
  return pty.spawn("/bin/bash", ["--norc", "--noprofile", "-c", script], { cols: 80, rows: 24 });
}

function exited(term: IPty): Promise<void> {
  return new Promise((resolve) => term.onExit(() => resolve()));
}

/** The numbers of `seq`'s lines, as they arrived. */
function numbers(text: string): number[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => Number(line));
}

function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index + 1);
}

describe("a terminal's last output", () => {
  it("all reaches a reader that is behind when the program ends", async () => {
    // A busy reader leaves the kernel's pty buffer full when the program exits. libuv 1.51
    // (Node 22.23) then read one piece and ended the stream: about 7.5 KB of this never arrived.
    const size = 200_000;
    const term = spawn(`head -c ${size} /dev/zero | tr '\\0' x`);
    let got = 0;
    attachTail(term, (data) => {
      got += data.length;
      const until = Date.now() + 3;
      while (Date.now() < until);
    });
    await exited(term);
    expect(got).toBe(size);
  });

  it("arrives in order from a pane held back when the program ends", async () => {
    // Flow control pauses a pane; the program's last lines then sit in the kernel behind one piece
    // already in the stream. That piece came out after them: …1999, 2000, then 1, 2, 3.
    const term = spawn("seq 1 2000");
    let text = "";
    let closedWhilePaused = false;
    let paused = true;
    const resume = () => {
      paused = false;
      term.resume();
    };
    attachTail(term, (data) => (text += data), {
      onClosing: () => {
        closedWhilePaused = paused;
        resume();
      },
    });
    term.pause();
    // In case the kernel can't take the whole output and the program waits to print it.
    const fallback = setTimeout(resume, 3000);
    await exited(term);
    clearTimeout(fallback);
    expect(closedWhilePaused).toBe(true);
    expect(numbers(text)).toEqual(oneTo(2000));
  });

  it("is kept while a snapshot holds the pane, past node-pty closing it, and let go in order", async () => {
    // node-pty destroys the stream 200 ms after the exit, with what is still in it.
    const term = spawn("seq 1 1500");
    let text = "";
    const tail = attachTail(term, (data) => (text += data));
    tail.hold();
    term.pause();
    await exited(term);
    expect(tail.closing()).toBe(true);
    expect(text).toBe("");
    tail.letGo();
    expect(numbers(text)).toEqual(oneTo(1500));
  });

  it("reads nothing once the terminal has closed, when its number may be another file's", async () => {
    const term = spawn("echo DONE");
    let text = "";
    const tail = attachTail(term, (data) => (text += data));
    await exited(term);
    const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-drain-")), "other.txt");
    fs.writeFileSync(other, "NOT-THE-TERMINAL");
    const fd = fs.openSync(other, "r");
    try {
      tail.drain();
    } finally {
      fs.closeSync(fd);
    }
    expect(text).toContain("DONE");
    expect(text).not.toContain("NOT-THE-TERMINAL");
  });
});
