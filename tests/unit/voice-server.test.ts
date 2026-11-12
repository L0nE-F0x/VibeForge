import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LogFile } from "../../src/core/log.js";
import type { VoiceSettings } from "../../src/core/types.js";

// Downloads go through Electron's network stack, which isn't here; nothing in these tests downloads.
vi.mock("electron", () => ({ net: {} }));

const { Voice } = await import("../../electron/voice.js");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-server-"));
}

/** Two seconds of a loud tone: speech, as far as the silence check goes. */
function speech(): Buffer {
  const pcm = Buffer.alloc(16_000 * 2 * 2);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 0.5 * 32_767), i * 2);
  return pcm;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Voice whose whisper-server is a stand-in that answers after `answerMs` and writes its pid down. */
function voice(opts: { idleMs: number; answerMs: number; cliOnly?: string }) {
  const dataRoot = tempDir();
  const bin = tempDir();
  const pidFile = path.join(bin, "pid");
  const server = path.join(bin, "whisper-server");
  fs.writeFileSync(
    server,
    `#!/usr/bin/env node
const http = require("node:http");
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  req.resume();
  req.on("end", () => setTimeout(() => res.end(JSON.stringify({ text: "hello there" })), ${opts.answerMs}));
}).listen(port, "127.0.0.1");
`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(dataRoot, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "models", "ggml-base.en.bin"), Buffer.alloc(1_000_001));
  const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "" };
  const log = { info: () => undefined, warn: () => undefined } as unknown as LogFile;
  const instance = new Voice({
    log,
    home: tempDir(),
    dataRoot,
    settings: () => settings,
    resolveBin: (name) => (opts.cliOnly ? (name === "whisper-cli" ? opts.cliOnly : null) : name === "whisper-server" ? server : null),
    state: () => undefined,
    changed: () => undefined,
    speaking: () => undefined,
    language: () => "en",
    controlSocket: path.join(dataRoot, "control.sock"),
    launcher: () => "vibeforge",
    serverIdleMs: opts.idleMs,
  });
  return { instance, pid: () => Number(fs.readFileSync(pidFile, "utf8")) };
}

describe("whisper-server's lifetime", () => {
  it("is stopped once it has gone unused for the idle time", async () => {
    const { instance, pid } = voice({ idleMs: 400, answerMs: 0 });
    try {
      expect((await instance.transcribe(speech())).text).toBe("hello there");
      const server = pid();
      expect(alive(server)).toBe(true);
      await sleep(1200);
      expect(alive(server)).toBe(false);
    } finally {
      instance.dispose();
    }
  });

  it("isn't stopped while it is still answering", async () => {
    const { instance, pid } = voice({ idleMs: 300, answerMs: 1200 });
    try {
      expect((await instance.transcribe(speech())).text).toBe("hello there");
      expect(alive(pid())).toBe(true);
    } finally {
      instance.dispose();
    }
  });
});

describe("whisper-cli, when there is no whisper-server", () => {
  it("takes the recording out of /tmp when VibeForge quits mid-transcription", async () => {
    const bin = tempDir();
    const saw = path.join(bin, "audio-path");
    const cli = path.join(bin, "whisper-cli");
    // Writes down where its audio is, then takes its time.
    fs.writeFileSync(cli, `#!/bin/sh\nwhile [ "$1" != "-f" ]; do shift; done\nprintf '%s' "$2" > ${JSON.stringify(saw)}\nexec sleep 30\n`, { mode: 0o755 });
    const { instance } = voice({ idleMs: 400, answerMs: 0, cliOnly: cli });
    const words = instance.transcribe(speech()).catch(() => null);
    for (let tries = 0; tries < 100 && !fs.existsSync(saw); tries += 1) await sleep(20);
    const audio = fs.readFileSync(saw, "utf8");
    expect(fs.existsSync(audio)).toBe(true);
    instance.dispose();
    expect(fs.existsSync(path.dirname(audio))).toBe(false);
    await words;
  });
});
