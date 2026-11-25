import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

type Sink = { runDir: string | null; scrollFd: number | null; scrollBytes: number; scrollFile: string | null; trimAfter?: number };
type Say = (kind: string, text: string) => void;
// The terminal host's own module, plain CommonJS.
const require = createRequire(import.meta.url);
const scrollback = require(path.resolve("electron/scrollback-file.cjs")) as {
  MAX_SCROLLBACK_BYTES: number;
  limitedLog(log: (...parts: unknown[]) => void, now?: () => number): Say;
  openScrollback(sink: Sink, say: Say): void;
  appendScrollback(sink: Sink, data: string, say: Say): void;
  trimScrollback(sink: Sink, say: Say, io?: unknown): void;
  writeWhole(file: string, text: string): void;
};

let dir = "";
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function sink() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-scrollback-"));
  const made = { runDir: dir, scrollFd: null as number | null, scrollBytes: 0, scrollFile: null as string | null };
  return made;
}

/** Numbered lines, `count` of them from `from`, each 16 bytes. */
const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => `${String(from + i).padStart(15, "0")}\n`).join("");

describe("a terminal's scrollback file", () => {
  it("is cut back to its last 2 MB once it passes 2.5 MB, through a file beside it", () => {
    const said: string[] = [];
    const say = (kind: string, text: string) => said.push(`${kind}: ${text}`);
    const s = sink();
    scrollback.openScrollback(s, say);
    // 2.5 MB and a bit, in 64 KB pieces.
    for (let piece = 0; piece < 41; piece += 1) scrollback.appendScrollback(s, lines(piece * 4096, 4096), say);
    const text = fs.readFileSync(path.join(dir, "scrollback.txt"), "utf8");
    expect(said).toEqual([]);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(scrollback.MAX_SCROLLBACK_BYTES + 64 * 1024);
    expect(text.endsWith(lines(40 * 4096 + 4095, 1))).toBe(true);
    // Nothing left beside it, and it is still only the owner's.
    expect(fs.readdirSync(dir)).toEqual(["scrollback.txt"]);
    expect(fs.statSync(path.join(dir, "scrollback.txt")).mode & 0o777).toBe(0o600);
    // Appending goes on into the file that took the name.
    scrollback.appendScrollback(s, "END\n", say);
    expect(fs.readFileSync(path.join(dir, "scrollback.txt"), "utf8").endsWith("END\n")).toBe(true);
  });

  it("stays whole when the cut fails partway (a full disk), and keeps taking output", () => {
    const said: string[] = [];
    const say = (kind: string, text: string) => said.push(`${kind}: ${text}`);
    const s = sink();
    scrollback.openScrollback(s, say);
    const before = lines(0, 160_000);
    fs.writeSync(s.scrollFd!, before);
    s.scrollBytes = Buffer.byteLength(before);
    // The disk fills halfway through writing the part kept.
    const full = {
      writeFileSync: (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
        fs.writeFileSync(file, (data as Buffer).subarray(0, 1000));
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      },
      renameSync: fs.renameSync,
    };
    scrollback.trimScrollback(s, say, full as never);
    expect(fs.readFileSync(path.join(dir, "scrollback.txt"), "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["scrollback.txt"]);
    expect(said).toEqual(["scrollback: could not cut it back: ENOSPC: no space left on device, write"]);
    // Output goes on being kept, and the cut isn't tried again on every chunk.
    scrollback.appendScrollback(s, "MORE\n", say);
    expect(fs.readFileSync(path.join(dir, "scrollback.txt"), "utf8")).toBe(`${before}MORE\n`);
    expect(said).toHaveLength(1);
  });
});

describe("trouble said once a minute", () => {
  it("counts what it held back", () => {
    let now = 0;
    const logged: string[] = [];
    const say = scrollback.limitedLog((...parts: unknown[]) => logged.push(parts.join(" ")), () => now);
    say("scrollback", "ENOSPC");
    say("scrollback", "ENOSPC");
    say("artifacts", "ENOSPC");
    say("scrollback", "ENOSPC");
    now = 60_000;
    say("scrollback", "ENOSPC");
    expect(logged).toEqual(["scrollback: ENOSPC", "artifacts: ENOSPC", "scrollback: ENOSPC (and 2 more like it in the last minute)"]);
  });
});

describe("a run file written whole", () => {
  it("replaces the old one only once it is complete, owner-only, with nothing left beside it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-whole-"));
    const file = path.join(dir, "terminal.ansi");
    fs.writeFileSync(file, "old");
    scrollback.writeWhole(file, "new screen");
    expect(fs.readFileSync(file, "utf8")).toBe("new screen");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["terminal.ansi"]);
    // Into a folder that is gone: it says so, and leaves nothing.
    expect(() => scrollback.writeWhole(path.join(dir, "gone", "transcript.txt"), "x")).toThrow(/ENOENT/);
  });
});

