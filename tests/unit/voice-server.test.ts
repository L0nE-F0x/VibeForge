import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LogFile } from "../../src/core/log.js";
import type { VoiceSettings } from "../../src/core/types.js";
import { DEFAULT_DICTATE_KEYS } from "../../src/shared/dictation.js";

// Downloads go through Electron's network stack, which isn't here; nothing in these tests downloads.
vi.mock("electron", () => ({ net: {} }));

const { pidOwnsLoopbackPort, sherpaWorkerArgs, unpackSherpaArchive, Voice } = await import("../../electron/voice.js");

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
  const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "", keys: { ...DEFAULT_DICTATE_KEYS }, mouseButton: "off", sendButton: "pointer", talkOver: "auto" };
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
      // Gone a little after the idle time; a busy machine may take longer to end and reap it.
      for (const end = Date.now() + 10_000; alive(server) && Date.now() < end; ) await sleep(50);
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

describe("sherpa-onnx backend in Voice", () => {
  it("transcribes ONNX models via sherpa-onnx-offline without whisper.cpp installed", async () => {
    const dataRoot = tempDir();
    const bin = tempDir();
    const sherpaCli = path.join(bin, "sherpa-onnx-offline");
    fs.writeFileSync(
      sherpaCli,
      `#!/usr/bin/env node
process.stderr.write('{"lang": "", "text": "Switch to VibeForge now."}\\n');
`,
      { mode: 0o755 },
    );
    const parakeetDir = path.join(dataRoot, "models", "parakeet-tdt-0.6b-v3-int8");
    fs.mkdirSync(parakeetDir, { recursive: true });
    fs.writeFileSync(path.join(parakeetDir, "encoder.int8.onnx"), Buffer.alloc(150_000));
    fs.writeFileSync(path.join(parakeetDir, "decoder.int8.onnx"), "d");
    fs.writeFileSync(path.join(parakeetDir, "joiner.int8.onnx"), "j");
    fs.writeFileSync(path.join(parakeetDir, "tokens.txt"), "t");

    const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "", keys: { ...DEFAULT_DICTATE_KEYS }, mouseButton: "off", sendButton: "pointer", talkOver: "auto" };
    const log = { info: () => undefined, warn: () => undefined } as unknown as LogFile;
    const instance = new Voice({
      log,
      home: tempDir(),
      dataRoot,
      settings: () => settings,
      resolveBin: (name) => (name === "sherpa-onnx-offline" ? sherpaCli : name === "pw-record" ? "/usr/bin/pw-record" : null),
      state: () => undefined,
      changed: () => undefined,
      speaking: () => undefined,
      language: () => "en",
      controlSocket: path.join(dataRoot, "control.sock"),
      launcher: () => "vibeforge",
    });
    try {
      const status = instance.status();
      expect(status.ready).toBe(true);
      expect(status.sherpa).toBe(sherpaCli);
      expect(status.model).toBe(parakeetDir);
      expect(instance.canTranscribe()).toBe(true);
      const heard = await instance.transcribe(speech());
      expect(heard.text).toBe("Switch to VibeForge now.");
    } finally {
      instance.dispose();
    }
  });

  it("keeps the warm sherpa stdio worker loaded and stops it after the idle timeout", async () => {
    const dataRoot = tempDir();
    const bin = tempDir();
    const pidFile = path.join(bin, "sherpa-pid");
    const argvFile = path.join(bin, "sherpa-argv.json");
    const fakePython = path.join(bin, "python3");
    fs.writeFileSync(
      fakePython,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const wav = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    const riff = wav.toString("ascii", 0, 4);
    process.stdout.write(JSON.stringify({ ok: riff === "RIFF", text: "Warm Parakeet heard you." }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );
    const runtimeDir = path.join(dataRoot, "sherpa-onnx");
    fs.mkdirSync(path.join(runtimeDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "bin", "sherpa-onnx-offline"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(runtimeDir, "lib", "libsherpa-onnx-c-api.so"), "so");

    const parakeetDir = path.join(dataRoot, "models", "parakeet-tdt-0.6b-v3-int8");
    fs.mkdirSync(parakeetDir, { recursive: true });
    fs.writeFileSync(path.join(parakeetDir, "encoder.int8.onnx"), Buffer.alloc(150_000));
    fs.writeFileSync(path.join(parakeetDir, "decoder.int8.onnx"), "d");
    fs.writeFileSync(path.join(parakeetDir, "joiner.int8.onnx"), "j");
    fs.writeFileSync(path.join(parakeetDir, "tokens.txt"), "t");

    const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "", keys: { ...DEFAULT_DICTATE_KEYS }, mouseButton: "off", sendButton: "pointer", talkOver: "auto" };
    const log = { info: () => undefined, warn: () => undefined } as unknown as LogFile;
    const instance = new Voice({
      log,
      home: tempDir(),
      dataRoot,
      settings: () => settings,
      resolveBin: (name) => (name === "python3" ? fakePython : null),
      state: () => undefined,
      changed: () => undefined,
      speaking: () => undefined,
      language: () => "en",
      controlSocket: path.join(dataRoot, "control.sock"),
      launcher: () => "vibeforge",
      serverIdleMs: 350,
    });
    try {
      expect((await instance.transcribe(speech())).text).toBe("Warm Parakeet heard you.");
      expect(JSON.parse(fs.readFileSync(argvFile, "utf8")).slice(0, 3)).toEqual(["-I", "-u", "-c"]);
      const workerPid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(alive(workerPid)).toBe(true);
      expect((await instance.transcribe(speech())).text).toBe("Warm Parakeet heard you.");
      expect(Number(fs.readFileSync(pidFile, "utf8"))).toBe(workerPid);
      for (const end = Date.now() + 10_000; alive(workerPid) && Date.now() < end; ) await sleep(50);
      expect(alive(workerPid)).toBe(false);
    } finally {
      instance.dispose();
    }
  });

  it("unpacks a sherpa-onnx release archive atomically with its PIN and SOURCE.txt", async () => {
    const work = tempDir();
    const pkgDir = path.join(work, "sherpa-onnx-v1.13.8-linux-x64");
    fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "bin", "sherpa-onnx-offline"), Buffer.alloc(20_000, 1), { mode: 0o755 });
    fs.writeFileSync(path.join(pkgDir, "lib", "libsherpa-onnx-c-api.so"), "so");
    fs.writeFileSync(path.join(pkgDir, "LICENSE"), "Apache-2.0");
    const archive = path.join(work, "sherpa.tar.bz2");
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["-cjf", archive, "-C", work, "sherpa-onnx-v1.13.8-linux-x64"]);

    const dest = path.join(work, "installed");
    await unpackSherpaArchive(archive, dest, "x64");
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.existsSync(path.join(dest, "bin", "sherpa-onnx-offline"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "lib", "libsherpa-onnx-c-api.so"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "PIN"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "SOURCE.txt"))).toBe(true);
  });

  it("builds sherpa worker python arguments with -I isolation", () => {
    expect(sherpaWorkerArgs('{"ok":true}').slice(0, 3)).toEqual(["-I", "-u", "-c"]);
    expect(sherpaWorkerArgs('{"ok":true}').at(-1)).toBe('{"ok":true}');
  });

  it("verifies via /proc whether a loopback listening port belongs to a child pid subtree", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const decoy = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      if (process.platform === "linux") {
        expect(pidOwnsLoopbackPort(process.pid, port)).toBe(true);
        expect(pidOwnsLoopbackPort(decoy.pid!, port)).toBe(false);
      }
      const proc = tempDir();
      fs.mkdirSync(path.join(proc, "net"));
      const hexPort = (41234).toString(16).toUpperCase().padStart(4, "0");
      fs.writeFileSync(
        path.join(proc, "net", "tcp"),
        [
          "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
          `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555666 1 00000000 100 0 0 10 0`,
        ].join("\n"),
      );
      fs.mkdirSync(path.join(proc, "100", "task", "100"), { recursive: true });
      fs.writeFileSync(path.join(proc, "100", "task", "100", "children"), "101");
      fs.mkdirSync(path.join(proc, "101", "fd"), { recursive: true });
      fs.symlinkSync("socket:[555666]", path.join(proc, "101", "fd", "7"));
      fs.mkdirSync(path.join(proc, "200", "fd"), { recursive: true });
      fs.symlinkSync("socket:[111111]", path.join(proc, "200", "fd", "3"));

      expect(pidOwnsLoopbackPort(100, 41234, proc)).toBe(true);
      expect(pidOwnsLoopbackPort(200, 41234, proc)).toBe(false);
    } finally {
      decoy.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
