import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { repairBlankCapture } from "../../src/core/restore-screen.js";
import type { RunFiles } from "../../src/core/runs.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as {
  Terminal: new (opts: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => { loadAddon(addon: object): void };
};
const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: new () => object };
const capture = require(path.resolve("electron/terminal-capture.cjs")) as {
  attachCapture(sink: object): void;
  captureWrite(sink: object, data: string): void;
  captureFinish(sink: object): Promise<{ ansi: string; transcript: string }>;
  restoreScrollback(scrollback: string): Promise<{ ansi: string; transcript: string } | null>;
  plainText(text: string): string;
};

function openSink() {
  const mirror = new Terminal({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true });
  const serializer = new SerializeAddon();
  mirror.loadAddon(serializer);
  const sink = { mirror, serializer };
  capture.attachCapture(sink);
  return sink;
}

const blank = (): RunFiles => ({ preamble: "", prompts: "", screen: "", scrollback: "", transcript: "", git: "" });

describe("terminal capture", () => {
  it("keeps the alt screen when the program clears on the way out", async () => {
    const sink = openSink();
    capture.captureWrite(sink, "\x1b[?1049h\x1b[HKEEP-SCREEN\r\n");
    capture.captureWrite(sink, "\x1b[?1049l\x1b[2J");
    const done = await capture.captureFinish(sink);
    expect(done.transcript).toContain("KEEP-SCREEN");
    expect(done.ansi).toContain("KEEP-SCREEN");
  });

  it("joins a leave-alternate sequence split across two writes", async () => {
    const sink = openSink();
    capture.captureWrite(sink, "\x1b[?1049h\x1b[HKEEP-SCREEN\r\n\x1b[?104");
    capture.captureWrite(sink, "9l\x1b[2J");
    const done = await capture.captureFinish(sink);
    expect(done.transcript).toContain("KEEP-SCREEN");
  });

  it("prefers a longer note printed after the program leaves the alt screen", async () => {
    const sink = openSink();
    capture.captureWrite(sink, "\x1b[?1049h\x1b[HKEEP-SCREEN\r\n\x1b[?1049l\x1b[2JFAREWELL-9 the session printed this on the way out\r\n");
    const done = await capture.captureFinish(sink);
    expect(done.transcript).toContain("FAREWELL-9");
    expect(done.transcript).not.toContain("KEEP-SCREEN");
  });

  it("rebuilds a blank saved frame from scrollback, including one trimmed mid-session", async () => {
    const full = await capture.restoreScrollback("\x1b[?1049h\x1b[HKEEP-SCREEN\r\n\x1b[?1049l\x1b[2J");
    expect(full?.transcript).toContain("KEEP-SCREEN");
    const trimmed = await capture.restoreScrollback("0;20;20mX\x1b[1;1HKEEP-SCREEN\x1b[2;1Hsecond line\x1b[?1049l\x1b[2J");
    expect(trimmed?.transcript).toContain("KEEP-SCREEN");
    expect(trimmed?.transcript).toContain("second line");
    expect(trimmed?.transcript).not.toContain("0;20;20m");
    expect(capture.plainText("\x1b[5B")).toBe("");
  });

  it("writes the rebuilt frame back and leaves a real transcript alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-restore-"));
    fs.writeFileSync(path.join(dir, "terminal.ansi"), "\x1b[5B");
    fs.writeFileSync(path.join(dir, "transcript.txt"), "");
    fs.writeFileSync(path.join(dir, "scrollback.txt"), "\x1b[?1049h\x1b[HKEEP-SCREEN\r\n\x1b[?1049l\x1b[2J");
    const repaired = await repairBlankCapture(dir, { ...blank(), screen: "\x1b[5B" });
    expect(repaired.transcript).toContain("KEEP-SCREEN");
    expect(fs.readFileSync(path.join(dir, "transcript.txt"), "utf8")).toContain("KEEP-SCREEN");
    expect(fs.readFileSync(path.join(dir, "terminal.ansi"), "utf8")).toContain("KEEP-SCREEN");

    fs.writeFileSync(path.join(dir, "transcript.txt"), "already here\n");
    fs.writeFileSync(path.join(dir, "terminal.ansi"), "already here\n");
    const kept = await repairBlankCapture(dir, { ...blank(), screen: "already here\n", transcript: "already here\n" });
    expect(kept.transcript).toBe("already here\n");
  });
});
