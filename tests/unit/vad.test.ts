import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Segmenter } from "../../src/core/call.js";
import { floatFrame, readVadModel, SpeechDetector, VAD_FRAME, VAD_FRAME_BYTES, VAD_MODEL } from "../../src/core/vad.js";
import { BYTES_PER_SECOND, SAMPLE_RATE } from "../../src/core/voice.js";

// The speech detector, run on the model VibeForge ships and on real speech: the first 2.6 s of
// whisper.cpp's own sample (John F. Kennedy's inaugural address, in the public domain), as raw
// 16 kHz mono. The numbers were checked against whisper.cpp 1.9.5's `whisper-vad-speech-segments`
// on the same audio (2026-11-18): the same segments, to the frame.

const root = path.resolve(import.meta.dirname, "..", "..");
const modelFile = fs.readFileSync(path.join(root, "resources", "vad", VAD_MODEL.file));
const speech = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "speech.raw"));
const model = readVadModel(modelFile);

/** A seeded random number, so the made-up sounds are the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function pcm(seconds: number, sample: (index: number) => number): Buffer {
  const out = Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2);
  for (let i = 0; i < out.length / 2; i += 1) out.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample(i) * 32_767))), i * 2);
  return out;
}

const silence = (seconds: number) => pcm(seconds, () => 0);
const tone = (seconds: number) => pcm(seconds, (i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
function noise(seconds: number, loudness: number): Buffer {
  const random = seeded(7);
  return pcm(seconds, () => (random() * 2 - 1) * loudness);
}
/** Keys being typed: a short burst of noise several times a second. */
function keyboard(seconds: number): Buffer {
  const random = seeded(11);
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let at = 0.1; at < seconds - 0.1; at += 0.09 + random() * 0.13) {
    const start = Math.round(at * SAMPLE_RATE);
    for (let i = 0; i < 190; i += 1) samples[start + i] += (random() * 2 - 1) * 0.6 * Math.exp(-i / 40);
  }
  return pcm(seconds, (i) => samples[i]);
}

function likelihoods(audio: Buffer): number[] {
  const detector = new SpeechDetector(model);
  const out: number[] = [];
  for (let at = 0; at + VAD_FRAME_BYTES <= audio.length; at += VAD_FRAME_BYTES) out.push(detector.probability(floatFrame(audio.subarray(at, at + VAD_FRAME_BYTES))));
  return out;
}

describe("the speech detector's model", () => {
  it("is the file VibeForge pins, and reads as Silero's 16 kHz model", () => {
    expect(modelFile.length).toBe(VAD_MODEL.bytes);
    expect(createHash("sha256").update(modelFile).digest("hex")).toBe(VAD_MODEL.sha256);
    expect(fs.readFileSync(path.join(root, "resources", "vad", "SOURCE.txt"), "utf8")).toContain(VAD_MODEL.sha256);
    expect(model).toMatchObject({ window: VAD_FRAME, bins: 129, hidden: 128, basisKernel: 256 });
    expect(model.encoder.map((layer) => [layer.inChannels, layer.outChannels, layer.kernel, layer.stride])).toEqual([
      [129, 128, 3, 1],
      [128, 64, 3, 2],
      [64, 64, 3, 2],
      [64, 128, 3, 1],
    ]);
  });

  it("refuses a file that is cut short or isn't one", () => {
    expect(() => readVadModel(modelFile.subarray(0, 5000))).toThrow("cut short");
    expect(() => readVadModel(Buffer.from("not a model at all, just some text that is long enough"))).toThrow("not a speech detector");
    expect(() => readVadModel(Buffer.alloc(0))).toThrow("cut short");
  });
});

describe("telling speech from other sound", () => {
  it("hears speech where whisper.cpp's own detector does", () => {
    const likely = likelihoods(speech);
    // whisper.cpp: speech from 0.29 s to 2.21 s, which is frames 10 to 67 with its 30 ms of padding off.
    expect(likely.findIndex((value) => value >= 0.5)).toBe(10);
    expect(likely.findIndex((value, index) => index > 10 && value < 0.35)).toBe(68);
    expect(likely.slice(11, 60).every((value) => value > 0.8)).toBe(true);
    expect(Math.max(...likely.slice(0, 10))).toBeLessThan(0.2);
  });

  it("doesn't take a keyboard, a tone, hiss or silence for speech, however loud", () => {
    const [quiet, hiss, keys, beep, roar] = [silence(1), noise(2, 0.004), keyboard(3), tone(2), noise(2, 0.3)].map((sound) => Math.max(...likelihoods(sound)));
    // Speech is 0.5 and up. A loud sound starting from nothing gets nearest, and stays well short.
    for (const likely of [quiet, hiss, keys]) expect(likely).toBeLessThan(0.1);
    for (const likely of [beep, roar]) expect(likely).toBeLessThan(0.4);
  });

  it("starts afresh on reset, and remembers what came before otherwise", () => {
    const detector = new SpeechDetector(model);
    const frames = Array.from({ length: 30 }, (_item, index) => floatFrame(speech.subarray(index * VAD_FRAME_BYTES, (index + 1) * VAD_FRAME_BYTES)));
    const first = frames.map((frame) => detector.probability(frame));
    const carried = detector.probability(frames[0]);
    detector.reset();
    expect(frames.map((frame) => detector.probability(frame))).toEqual(first);
    // The same quiet frame, after speech and from nothing: the model's memory makes them differ.
    expect(carried).not.toBe(first[0]);
  });
});

describe("a call's microphone, listening for speech itself", () => {
  const chunks = (audio: Buffer, bytes = 3200) => Array.from({ length: Math.ceil(audio.length / bytes) }, (_item, index) => audio.subarray(index * bytes, (index + 1) * bytes));

  it("cuts out what was said, and nothing for typing or a loud tone", () => {
    const segmenter = new Segmenter({ detector: new SpeechDetector(model) });
    expect(segmenter.detects).toBe(true);
    const heard: Buffer[] = [];
    let hearingDuringNoise = false;
    for (const chunk of chunks(Buffer.concat([silence(0.5), keyboard(3), tone(1.5), silence(1.2)]))) {
      const result = segmenter.push(chunk);
      heard.push(...result.utterances);
      hearingDuringNoise ||= result.hearing;
    }
    expect(heard).toEqual([]);
    expect(hearingDuringNoise).toBe(false);

    let speechMs = 0;
    let heardWhileSpeaking = false;
    for (const chunk of chunks(Buffer.concat([speech, silence(1.2)]))) {
      const result = segmenter.push(chunk);
      heard.push(...result.utterances);
      heardWhileSpeaking ||= result.hearing;
      speechMs = Math.max(speechMs, result.speechMs);
    }
    expect(heard).toHaveLength(1);
    expect(heardWhileSpeaking).toBe(true);
    // 1.9 s of speech, with a little from before it and 0.3 s of the pause after.
    expect(speechMs).toBeGreaterThan(1500);
    const seconds = heard[0].length / BYTES_PER_SECOND;
    expect(seconds).toBeGreaterThan(2.2);
    expect(seconds).toBeLessThan(2.9);
    // Nothing more is being said.
    expect(segmenter.push(silence(0.5))).toMatchObject({ utterances: [], hearing: false, speechMs: 0 });
  });

  it("forgets half of something said when it is reset", () => {
    const segmenter = new Segmenter({ detector: new SpeechDetector(model) });
    for (const chunk of chunks(speech.subarray(0, BYTES_PER_SECOND))) segmenter.push(chunk);
    expect(segmenter.push(Buffer.alloc(0)).hearing).toBe(true);
    segmenter.reset();
    expect(segmenter.push(silence(1.5))).toMatchObject({ utterances: [], hearing: false });
  });

  it("goes by loudness without a detector", () => {
    const segmenter = new Segmenter();
    expect(segmenter.detects).toBe(false);
    const heard: Buffer[] = [];
    for (const chunk of chunks(Buffer.concat([silence(0.5), tone(1), silence(1.2)]))) heard.push(...segmenter.push(chunk).utterances);
    expect(heard).toHaveLength(1);
  });
});
