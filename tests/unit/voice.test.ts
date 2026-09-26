import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import {
  BYTES_PER_SECOND,
  cleanTranscript,
  cliArgs,
  findWhisper,
  isEnglishOnly,
  isModelFile,
  listenLanguage,
  meterLevel,
  peakLoudness,
  pickModel,
  planRecorder,
  rms,
  serverArgs,
  SILENCE_RMS,
  wavFile,
} from "../../src/core/voice.js";
import { joinDictation, vocabularyPrompt } from "../../src/shared/dictation.js";

/** s16le mono PCM: `seconds` of a sine at `amplitude` (0–1), or silence at 0. */
function tone(seconds: number, amplitude: number): Buffer {
  const samples = Math.round(seconds * (BYTES_PER_SECOND / 2));
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * amplitude * 32767), i * 2);
  return pcm;
}

describe("voice: programs", () => {
  const has = (...bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/bin/${bin}` : null);

  it("records raw 16 kHz mono with PipeWire first, then Pulse, then ALSA, or a command for tests", () => {
    expect(planRecorder(has("pw-record", "parec"))).toEqual({
      label: "pw-record",
      argv: ["/usr/bin/pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", "--raw", "-"],
    });
    expect(planRecorder(has("parec", "arecord"))?.label).toBe("parec");
    expect(planRecorder(has("arecord"))?.argv).toContain("S16_LE");
    expect(planRecorder(has())).toBeNull();
    expect(planRecorder(has(), "cat speech.raw")).toEqual({ label: "custom", argv: ["/bin/sh", "-c", "cat speech.raw"] });
  });

  it("finds whisper-server and whisper-cli, honouring overrides", () => {
    expect(findWhisper(has("whisper-server", "whisper-cli"))).toEqual({ server: "/usr/bin/whisper-server", cli: "/usr/bin/whisper-cli" });
    expect(findWhisper(has("whisper-cpp"))).toEqual({ server: null, cli: "/usr/bin/whisper-cpp" });
    expect(findWhisper(has("whisper-server", "mine"), { server: "mine" }).server).toBe("/usr/bin/mine");
    expect(findWhisper(has("whisper-server"), { server: "missing" }).server).toBeNull();
  });

  it("keeps the server on loopback and the CLI quiet, with the prompt only when there is one", () => {
    const server = serverArgs({ model: "/m/ggml-base.en.bin", language: "en", port: 4321, threads: 4 });
    expect(server).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "4321", "-m", "/m/ggml-base.en.bin"]));
    const cli = cliArgs({ model: "/m.bin", file: "/tmp/a.wav", language: "auto", prompt: "", threads: 2 });
    expect(cli).toEqual(expect.arrayContaining(["-nt", "-np", "-l", "auto", "-f", "/tmp/a.wav"]));
    expect(cli).not.toContain("--prompt");
    expect(cliArgs({ model: "/m.bin", file: "/a.wav", language: "en", prompt: "Names: Atlas.", threads: 2 }).slice(-2)).toEqual(["--prompt", "Names: Atlas."]);
  });
});

describe("voice: models", () => {
  it("tells model files from voice-activity files and English-only models from multilingual ones", () => {
    expect(isModelFile("ggml-base.en.bin")).toBe(true);
    expect(isModelFile("ggml-large-v3-turbo-q5_0.bin")).toBe(true);
    expect(isModelFile("ggml-silero-v5.1.2.bin")).toBe(false);
    expect(isModelFile("ggml-base.en.bin.part")).toBe(false);
    expect(isModelFile("notes.txt")).toBe(false);
    expect(isEnglishOnly("/x/ggml-base.en.bin")).toBe(true);
    expect(isEnglishOnly("/x/ggml-small.en-q5_1.bin")).toBe(true);
    expect(isEnglishOnly("/x/ggml-base.bin")).toBe(false);
    expect(isEnglishOnly("/x/ggml-large-v3-turbo.bin")).toBe(false);
  });

  it("keeps the chosen model, else takes the biggest, preferring English-only for English", () => {
    const found = ["/a/ggml-base.en.bin", "/a/ggml-small.bin", "/a/ggml-small.en.bin", "/a/ggml-tiny.bin"];
    expect(pickModel(found, "/a/ggml-tiny.bin", "auto")).toBe("/a/ggml-tiny.bin");
    expect(pickModel(found, "/gone/ggml-huge.bin", "en")).toBe("/a/ggml-small.en.bin");
    expect(pickModel(found, "", "auto")).toBe("/a/ggml-small.bin");
    expect(pickModel(found, "", "de")).toBe("/a/ggml-small.bin");
    expect(pickModel(["/a/ggml-base.en.bin"], "", "de")).toBe("/a/ggml-base.en.bin");
    expect(pickModel(["/a/ggml-small.bin", "/a/ggml-large-v3-turbo-q5_0.bin"], "", "en")).toBe("/a/ggml-large-v3-turbo-q5_0.bin");
    expect(pickModel([], "", "en")).toBeNull();
  });

  it("listens for English with an English-only model whatever the setting", () => {
    expect(listenLanguage("/a/ggml-base.en.bin", "de")).toBe("en");
    expect(listenLanguage("/a/ggml-base.bin", "de")).toBe("de");
    expect(listenLanguage("/a/ggml-base.bin", "auto")).toBe("auto");
    expect(listenLanguage("/a/ggml-base.bin", "nonsense!")).toBe("auto");
  });
});

describe("voice: audio", () => {
  it("measures loudness and maps it onto the meter", () => {
    expect(rms(tone(0.1, 0))).toBe(0);
    expect(rms(tone(0.1, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(rms(Buffer.alloc(1))).toBe(0);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.001)).toBe(0);
    expect(meterLevel(0.1)).toBeCloseTo(2 / 3, 2);
  });

  it("finds the loudest 50 ms, so a short word in a long silence still counts as speech", () => {
    const quiet = tone(2, 0.001);
    expect(peakLoudness(quiet)).toBeLessThan(SILENCE_RMS);
    const word = Buffer.concat([tone(1, 0), tone(0.1, 0.2), tone(1, 0)]);
    expect(peakLoudness(word)).toBeGreaterThan(SILENCE_RMS);
  });

  it("wraps PCM in a 16 kHz mono 16-bit WAV header", () => {
    const pcm = tone(0.5, 0.1);
    const wav = wavFile(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });
});

describe("voice: words", () => {
  it("drops whisper's non-speech markers and joins the lines", () => {
    expect(cleanTranscript(" Refactor the scheduler.\n And add tests.\n")).toBe("Refactor the scheduler. And add tests.");
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript(" (music) ♪♪ ")).toBe("");
    expect(cleanTranscript(" *coughs* Run the build. [inaudible]")).toBe("Run the build.");
    expect(cleanTranscript(" . ")).toBe("");
  });

  it("writes a prompt sentence of distinct names that fits", () => {
    const commands = "Forge, new task: fix the bug. Forge, send.";
    expect(vocabularyPrompt([])).toBe(commands);
    expect(vocabularyPrompt(["Atlas", "atlas", " Claude  Code ", "", "team-service.ts"])).toBe(`Names that may come up: Atlas, Claude Code, team-service.ts. ${commands}`);
    const long = vocabularyPrompt(Array.from({ length: 200 }, (_, i) => `name${i}`), 100);
    expect(long.length).toBeLessThan(190);
    expect(long.endsWith(".")).toBe(true);
    expect(vocabularyPrompt(["x".repeat(61), "ok"])).toBe(`Names that may come up: ok. ${commands}`);
  });

  it("adds dictated words to what is already in a box with one space", () => {
    expect(joinDictation("", "Hello.")).toBe("Hello.");
    expect(joinDictation("  ", "Hello.")).toBe("Hello.");
    expect(joinDictation("Fix", "the build.")).toBe("Fix the build.");
    expect(joinDictation("Fix ", "the build.")).toBe("Fix the build.");
    expect(joinDictation("Line one\n", "two")).toBe("Line one\ntwo");
  });
});

describe("voice: settings", () => {
  it("defaults to review before sending, and repairs a hand-edited voice block", () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-data-"));
    const store = new Store(configRoot, dataRoot);
    expect(store.readSettings().voice).toEqual({ model: "", language: "auto", autoSend: false, talkBack: "summary", speaker: "" });
    fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice: { model: " /m/ggml-base.bin ", language: "Klingon!", autoSend: "yes", talkBack: "loud", speaker: 3 } }));
    expect(store.readSettings().voice).toEqual({ model: "/m/ggml-base.bin", language: "auto", autoSend: false, talkBack: "summary", speaker: "" });
    fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice: { language: "de", autoSend: true, talkBack: "full", speaker: "/v/a.onnx" } }));
    expect(store.readSettings().voice).toEqual({ model: "", language: "de", autoSend: true, talkBack: "full", speaker: "/v/a.onnx" });
    store.close();
  });
});
