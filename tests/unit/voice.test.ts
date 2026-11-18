import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import {
  findSherpa,
  parseSherpaOutput,
  resolveSherpaModel,
  SHERPA_PIN,
  sherpaCliArgs,
  sherpaMark,
  sherpaPresent,
  sherpaSourceNote,
} from "../../src/core/sherpa.js";
import {
  BYTES_PER_SECOND,
  cleanTranscript,
  cliArgs,
  findWhisper,
  isEnglishOnly,
  isModelFile,
  listenLanguage,
  meterLevel,
  MODEL_CATALOG,
  modelBackend,
  modelSupportsLanguage,
  peakLoudness,
  pickModel,
  planRecorder,
  rms,
  scanPiperVoices,
  scanVoiceModels,
  serverArgs,
  SILENCE_RMS,
  wavFile,
  whisperAudioCtx,
} from "../../src/core/voice.js";
import {
  DEFAULT_DICTATE_KEYS,
  type DictateKeys,
  dictateKeysLabel,
  dictateKeysProblem,
  joinDictation,
  normalizeDictateKeys,
  sameDictateKeys,
  vocabularyPrompt,
} from "../../src/shared/dictation.js";
import { typedIn } from "../../src/shared/terminal-input.js";

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
    expect(vocabularyPrompt([])).toBe("");
    expect(vocabularyPrompt(["Atlas", "atlas", " Claude  Code ", "", "team-service.ts"])).toBe("Names that may come up: Atlas, Claude Code, team-service.ts.");
    const long = vocabularyPrompt(Array.from({ length: 200 }, (_, i) => `name${i}`), 100);
    expect(long.length).toBeLessThan(190);
    expect(long.endsWith(".")).toBe(true);
    expect(vocabularyPrompt(["x".repeat(61), "ok"])).toBe("Names that may come up: ok.");
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
  it("reads answers aloud by default, and repairs a hand-edited voice block", () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-data-"));
    const store = new Store(configRoot, dataRoot);
    expect(store.readSettings().voice).toEqual({ model: "", language: "auto", talkBack: true, speaker: "", agent: "", keys: DEFAULT_DICTATE_KEYS, mouseButton: "off", sendButton: "pointer", talkOver: "auto" });
    fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice: { model: " /m/ggml-base.bin ", language: "Klingon!", autoSend: "yes", talkBack: "loud", speaker: 3 } }));
    expect(store.readSettings().voice).toEqual({ model: "/m/ggml-base.bin", language: "auto", talkBack: true, speaker: "", agent: "", keys: DEFAULT_DICTATE_KEYS, mouseButton: "off", sendButton: "pointer", talkOver: "auto" });
    fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice: { language: "de", autoSend: true, talkBack: "off", speaker: "/v/a.onnx", agent: " atlas " } }));
    expect(store.readSettings().voice).toMatchObject({ model: "", language: "de", talkBack: false, speaker: "/v/a.onnx", agent: "atlas" });
    fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice: { talkBack: "full" } }));
    expect(store.readSettings().voice.talkBack).toBe(true);
    store.close();
  });

  it("keeps dictate keys, a mouse button and the Send choice, and drops ones that can't work", () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-voice-data-"));
    const store = new Store(configRoot, dataRoot);
    const write = (voice: unknown) => fs.writeFileSync(path.join(configRoot, "settings.json"), JSON.stringify({ voice }));
    write({ keys: { code: "F8", ctrl: false, shift: false, alt: false, meta: false }, mouseButton: "back", sendButton: "always" });
    expect(store.readSettings().voice).toMatchObject({ keys: { code: "F8", ctrl: false }, mouseButton: "back", sendButton: "always" });
    // Talking over Viby: one of its three answers, or the default.
    write({ talkOver: "always" });
    expect(store.readSettings().voice.talkOver).toBe("always");
    write({ talkOver: "sometimes" });
    expect(store.readSettings().voice.talkOver).toBe("auto");
    write({ keys: { code: "KeyV", alt: true, ctrl: "yes" }, mouseButton: "left", sendButton: "sometimes" });
    expect(store.readSettings().voice).toMatchObject({ keys: { code: "KeyV", alt: true, ctrl: false, shift: false, meta: false }, mouseButton: "off", sendButton: "pointer" });
    // A plain letter would type, Esc cancels, and a modifier on its own is no key.
    for (const keys of [{ code: "KeyA" }, { code: "KeyA", shift: true }, { code: "Escape", ctrl: true }, { code: "ShiftLeft", ctrl: true }, "Ctrl+Space"]) {
      write({ keys });
      expect(store.readSettings().voice.keys).toEqual(DEFAULT_DICTATE_KEYS);
    }
    store.close();
  });
});

describe("what was typed into a terminal", () => {
  it("leaves out what the terminal reports by itself, so focus and the mouse don't send or drop dictated words", () => {
    // Focus out (pressing Send), any-motion and X10 mouse reports, an arrow key, bracketed paste.
    for (const report of ["\x1b[O", "\x1b[I", "\x1b[<35;12;4M", "\x1b[M #!", "\x1b[D", "\x1bOA"]) expect(typedIn(report)).toBe("");
    expect(typedIn("\x1b[200~fix the build\x1b[201~")).toBe("fix the build");
    expect(typedIn("\r")).toBe("\r");
    expect(typedIn("\x1b[O\x03")).toBe("\x03");
  });
});

describe("dictate keys", () => {
  it("names keys the way the shortcut sheet writes them", () => {
    expect(dictateKeysLabel(DEFAULT_DICTATE_KEYS)).toBe("Ctrl+Shift+Space");
    expect(dictateKeysLabel({ code: "KeyD", ctrl: false, shift: false, alt: true, meta: true })).toBe("Alt+Super+D");
    expect(dictateKeysLabel({ code: "Digit5", ctrl: true, shift: false, alt: false, meta: false })).toBe("Ctrl+5");
    expect(dictateKeysLabel({ code: "Backquote", ctrl: true, shift: false, alt: false, meta: false })).toBe("Ctrl+Backtick");
    expect(dictateKeysLabel({ code: "F9", ctrl: false, shift: false, alt: false, meta: false })).toBe("F9");
  });

  it("only takes keys that leave typing alone", () => {
    const keys = (code: string, mods: Partial<DictateKeys> = {}): DictateKeys => ({ code, ctrl: false, shift: false, alt: false, meta: false, ...mods });
    expect(dictateKeysProblem(keys("F12"))).toBeNull();
    expect(dictateKeysProblem(keys("KeyQ", { meta: true }))).toBeNull();
    expect(dictateKeysProblem(keys("Space", { shift: true }))).toBe("needsModifier");
    expect(dictateKeysProblem(keys("Escape", { alt: true }))).toBe("escape");
    expect(dictateKeysProblem(keys("ControlLeft", { ctrl: true }))).toBe("modifier");
    expect(sameDictateKeys(normalizeDictateKeys(undefined), DEFAULT_DICTATE_KEYS)).toBe(true);
  });
});

describe("the mic button", () => {
  it("keeps listening after a click, and stops on a hold's release or the next click", async () => {
    const { micRelease, MIC_TAP_MS } = await import("../../src/ui/mic.js");
    expect(micRelease({ at: 1000, started: true }, 1000 + 120)).toBe("latch");
    expect(micRelease({ at: 1000, started: true }, 1000 + MIC_TAP_MS + 1)).toBe("finish");
    // The click that ends a latched recording didn't start one: it finishes, however quick.
    expect(micRelease({ at: 1000, started: false }, 1000 + 80)).toBe("finish");
  });
});

describe("fast laptop speech-to-text models and sherpa-onnx", () => {
  it("offers Parakeet, Canary, Moonshine, Distil-Whisper and quantized Whisper models alongside classic ggml models", () => {
    const ids = MODEL_CATALOG.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "parakeet-tdt-0.6b-v3-int8",
        "parakeet-tdt-0.6b-v2-int8",
        "canary-180m-flash-int8",
        "moonshine-base-en-int8",
        "moonshine-tiny-en-int8",
        "distil-small.en",
        "small.en-q5_1",
        "small-q5_1",
        "base.en",
        "small.en",
        "base",
        "small",
        "large-v3-turbo-q5_0",
      ]),
    );
    expect(modelBackend("/m/parakeet-tdt-0.6b-v3-int8")).toBe("sherpa");
    expect(modelBackend("/m/ggml-distil-small.en.bin")).toBe("whisper");
    expect(isEnglishOnly("/m/parakeet-tdt-0.6b-v2-int8")).toBe(true);
    expect(isEnglishOnly("/m/parakeet-tdt-0.6b-v3-int8")).toBe(false);
    expect(isEnglishOnly("/m/moonshine-tiny-en-int8")).toBe(true);
    expect(isEnglishOnly("/m/canary-180m-flash-int8")).toBe(false);
  });

  it("knows each model family's language coverage and filters pickModel by available backends", () => {
    expect(modelSupportsLanguage("/m/parakeet-tdt-0.6b-v3-int8", "de")).toBe(true);
    expect(modelSupportsLanguage("/m/parakeet-tdt-0.6b-v3-int8", "pt")).toBe(true);
    expect(modelSupportsLanguage("/m/parakeet-tdt-0.6b-v3-int8", "ja")).toBe(false);
    expect(modelSupportsLanguage("/m/canary-180m-flash-int8", "fr")).toBe(true);
    expect(modelSupportsLanguage("/m/canary-180m-flash-int8", "pt")).toBe(false);
    expect(listenLanguage("/m/canary-180m-flash-int8", "auto")).toBe("en");
    expect(listenLanguage("/m/canary-180m-flash-int8", "es")).toBe("es");

    const both = ["/m/parakeet-tdt-0.6b-v3-int8", "/m/ggml-small-q5_1.bin"];
    expect(pickModel(both, "", "en", new Set(["whisper", "sherpa"]))).toBe("/m/parakeet-tdt-0.6b-v3-int8");
    expect(pickModel(both, "", "en", new Set(["whisper"]))).toBe("/m/ggml-small-q5_1.bin");
    // Japanese falls back from European-only Parakeet v3 to multilingual Whisper.
    expect(pickModel(both, "", "ja", new Set(["whisper", "sherpa"]))).toBe("/m/ggml-small-q5_1.bin");
    expect(pickModel(both, "", "en", new Set())).toBeNull();
  });

  it("sizes whisper-cli's encoder context (-ac) to short utterances while keeping --prompt last", () => {
    expect(whisperAudioCtx(0)).toBe(1500);
    expect(whisperAudioCtx(2.5)).toBe(256);
    expect(whisperAudioCtx(7.6)).toBe(512);
    expect(whisperAudioCtx(28)).toBe(1500);
    const shortArgs = cliArgs({ model: "/m.bin", file: "/a.wav", language: "en", prompt: "Names: Viby.", threads: 4, seconds: 3.2 });
    expect(shortArgs).toEqual(expect.arrayContaining(["-ac", "320"]));
    expect(shortArgs.slice(-2)).toEqual(["--prompt", "Names: Viby."]);
    const longArgs = cliArgs({ model: "/m.bin", file: "/a.wav", language: "en", prompt: "", threads: 4, seconds: 29 });
    expect(longArgs).not.toContain("-ac");
  });

  it("detects sherpa-onnx model directories, builds CLI flags, and parses JSON output", () => {
    const parakeet = resolveSherpaModel("/models/parakeet-tdt-0.6b-v3-int8", ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
    expect(parakeet).toMatchObject({ kind: "nemo_transducer", encoder: "/models/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx" });
    expect(sherpaCliArgs(parakeet!, { wavFile: "/tmp/s.wav", language: "en", threads: 4 })).toEqual(
      expect.arrayContaining(["--model-type=nemo_transducer", "--num-threads=4", "/tmp/s.wav"]),
    );

    const canary = resolveSherpaModel("/models/canary-180m-flash-int8", ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]);
    expect(canary?.kind).toBe("canary");
    expect(sherpaCliArgs(canary!, { wavFile: "/tmp/s.wav", language: "de", threads: 4 })).toEqual(
      expect.arrayContaining(["--canary-src-lang=de", "--canary-tgt-lang=de", "--canary-use-pnc=1"]),
    );

    const moonshine = resolveSherpaModel("/models/moonshine-tiny-en-int8", ["preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt"]);
    expect(moonshine?.kind).toBe("moonshine");
    expect(sherpaCliArgs(moonshine!, { wavFile: "/tmp/s.wav", language: "en", threads: 2 })).toContain("--moonshine-encoder=/models/moonshine-tiny-en-int8/encode.int8.onnx");

    const sense = resolveSherpaModel("/models/sense-voice-small", ["model.int8.onnx", "tokens.txt"]);
    expect(sense?.kind).toBe("sense_voice");
    expect(sherpaCliArgs(sense!, { wavFile: "/tmp/s.wav", language: "auto", threads: 2 })).toContain("--sense-voice-use-itn=1");

    // Incomplete or still-downloading (.part) directories are ignored.
    expect(resolveSherpaModel("/models/parakeet-tdt-0.6b-v3-int8", ["encoder.int8.onnx.part", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"])).toBeNull();
    expect(resolveSherpaModel("/models/empty", ["notes.txt"])).toBeNull();

    expect(parseSherpaOutput('info line\n{"lang": "", "text": "Switch to VibeForge."}\ndone\n')).toBe("Switch to VibeForge.");
    expect(parseSherpaOutput("no json here")).toBe("");
  });

  it("scans models & voices on disk and locates VibeForge's pinned sherpa-onnx runtime", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sherpa-home-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sherpa-data-"));
    const runtimeDir = path.join(dataRoot, "sherpa-onnx");
    fs.mkdirSync(path.join(runtimeDir, "bin"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "bin", "sherpa-onnx-offline"), Buffer.alloc(20_000), { mode: 0o755 });
    fs.writeFileSync(path.join(runtimeDir, "lib", "libsherpa-onnx-c-api.so"), "so");
    fs.writeFileSync(path.join(runtimeDir, "PIN"), sherpaMark("x64"));

    expect(sherpaPresent(runtimeDir, "x64")).toBe(true);
    expect(sherpaPresent(runtimeDir, "arm64")).toBe(false);
    expect(sherpaSourceNote()).toContain(SHERPA_PIN.version);
    expect(findSherpa(() => null, dataRoot)).toEqual({
      cli: path.join(runtimeDir, "bin", "sherpa-onnx-offline"),
      libDir: path.join(runtimeDir, "lib"),
      cApiLib: path.join(runtimeDir, "lib", "libsherpa-onnx-c-api.so"),
    });

    const parakeetDir = path.join(dataRoot, "models", "parakeet-tdt-0.6b-v3-int8");
    fs.mkdirSync(parakeetDir, { recursive: true });
    fs.writeFileSync(path.join(parakeetDir, "encoder.int8.onnx"), Buffer.alloc(150_000));
    fs.writeFileSync(path.join(parakeetDir, "decoder.int8.onnx"), "d");
    fs.writeFileSync(path.join(parakeetDir, "joiner.int8.onnx"), "j");
    fs.writeFileSync(path.join(parakeetDir, "tokens.txt"), "t");
    fs.writeFileSync(path.join(dataRoot, "models", "ggml-base.en.bin"), Buffer.alloc(1_000_001));

    const models = scanVoiceModels(home, dataRoot);
    expect(models).toEqual([parakeetDir, path.join(dataRoot, "models", "ggml-base.en.bin")]);

    const voicesDir = path.join(dataRoot, "voices");
    fs.mkdirSync(voicesDir, { recursive: true });
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx"), "m");
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx.json"), "{}");
    expect(scanPiperVoices(home, dataRoot)).toEqual([path.join(voicesDir, "en_US-lessac-medium.onnx")]);
  });
});
