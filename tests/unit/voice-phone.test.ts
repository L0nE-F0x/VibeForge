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
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-phone-"));
}

/** Speech from the phone as it arrives: 16 kHz mono s16le. */
function tone(seconds: number, amplitude: number): Buffer {
  const samples = Math.round(16_000 * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin((i / 16_000) * 2 * Math.PI * 220) * amplitude * 32_767), i * 2);
  return pcm;
}

/** A Voice with a stand-in whisper-cli that prints a sentence and keeps its command line and audio. */
function voice(opts: { model?: boolean; whisper?: boolean } = {}) {
  const home = tempDir();
  const dataRoot = tempDir();
  const bin = tempDir();
  const seen = path.join(bin, "seen");
  const cli = path.join(bin, "whisper-cli");
  fs.writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$@" > "${seen}.args"
while [ "$#" -gt 0 ]; do [ "$1" = "-f" ] && cp "$2" "${seen}.wav"; shift; done
echo " Start Claude in Star Ledger on a new branch."
echo " [BLANK_AUDIO]"
`,
    { mode: 0o755 },
  );
  if (opts.model !== false) {
    fs.mkdirSync(path.join(dataRoot, "models"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "models", "ggml-base.en.bin"), Buffer.alloc(1_000_001));
  }
  const states: string[] = [];
  const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "" };
  const log = { info: () => undefined, warn: () => undefined } as unknown as LogFile;
  const instance = new Voice({
    log,
    home,
    dataRoot,
    settings: () => settings,
    resolveBin: (name) => (name === "whisper-cli" && opts.whisper !== false ? cli : null),
    state: (state) => states.push(state.phase),
    changed: () => undefined,
    speaking: () => undefined,
    language: () => "en",
    controlSocket: path.join(dataRoot, "control.sock"),
    launcher: () => "vibeforge",
  });
  return { instance, seen, states };
}

describe("hearing the phone on the computer", () => {
  it("turns the phone's speech into words with the computer's whisper and the names it is told", async () => {
    const { instance, seen, states } = voice();
    expect(instance.canTranscribe()).toBe(true);
    const heard = await instance.transcribe(tone(1.2, 0.3), "Names that may come up: VibeForge, Star Ledger.");
    expect(heard).toMatchObject({ text: "Start Claude in Star Ledger on a new branch.", empty: null });
    expect(heard.seconds).toBeCloseTo(1.2, 2);
    const args = fs.readFileSync(`${seen}.args`, "utf8").split("\n");
    expect(args[args.indexOf("--prompt") + 1]).toBe("Names that may come up: VibeForge, Star Ledger.");
    expect(args[args.indexOf("-l") + 1]).toBe("en");
    // What whisper read is a WAV around the phone's samples, as for a recording made here.
    const wav = fs.readFileSync(`${seen}.wav`);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.length).toBe(44 + tone(1.2, 0.3).length);
    // The window's own listening bar isn't involved.
    expect(states).toEqual([]);
  });

  it("doesn't send a stray tap or silence to whisper, and says when it can't hear at all", async () => {
    const { instance, seen } = voice();
    expect(await instance.transcribe(tone(0.2, 0.3))).toMatchObject({ text: "", empty: "short" });
    expect(await instance.transcribe(tone(1, 0))).toMatchObject({ text: "", empty: "silent" });
    // An odd byte at the end is half a sample, dropped.
    expect((await instance.transcribe(Buffer.concat([tone(1, 0), Buffer.alloc(1)]))).seconds).toBe(1);
    expect(fs.existsSync(`${seen}.args`)).toBe(false);
    // A machine with whisper models installed system-wide always has one.
    if (!["/usr/share/whisper.cpp/models", "/usr/share/whisper-cpp/models"].some((dir) => fs.existsSync(dir))) expect(voice({ model: false }).instance.canTranscribe()).toBe(false);
    expect(voice({ whisper: false }).instance.canTranscribe()).toBe(false);
    await expect(voice({ whisper: false }).instance.transcribe(tone(1, 0.3))).rejects.toThrow("whisper.cpp is not installed. Settings → Voice shows how to add it.");
  });
});
