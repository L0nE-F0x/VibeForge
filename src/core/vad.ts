import { SAMPLE_RATE } from "./voice.js";

// Telling speech from other sound, for a call: the Silero voice-activity model, read from the
// file whisper.cpp publishes for its own `--vad` and run here in plain JavaScript. It is small
// (a short-time spectrum, four convolutions, one LSTM cell), so a frame takes well under a
// millisecond and nothing native is needed. Pure: electron/voice.ts reads the file.
//
// The steps follow whisper.cpp's own (src/whisper.cpp, whisper_vad_build_graph), so its
// `whisper-vad-speech-segments` is what the numbers here are checked against.

/** The detector's file on Hugging Face, pinned by size and SHA-256 like the whisper models. */
export const VAD_MODEL = {
  file: "ggml-silero-v5.1.2.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
  bytes: 885_098,
  sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
} as const;

/** One frame the model looks at: 512 samples, 32 ms. */
export const VAD_FRAME = 512;
export const VAD_FRAME_MS = (VAD_FRAME * 1000) / SAMPLE_RATE;
export const VAD_FRAME_BYTES = VAD_FRAME * 2;

const PAD = 64;
const HOP = 128;

interface Conv {
  /** [out][in][kernel], flat. */
  weight: Float32Array;
  bias: Float32Array;
  inChannels: number;
  outChannels: number;
  kernel: number;
  stride: number;
}

export interface VadModel {
  /** The window's length in samples; the frames handed to `SpeechDetector` are this long. */
  window: number;
  /** The spectrum's filters: [2 × bins][kernel], cosines then sines. */
  basis: Float32Array;
  basisKernel: number;
  bins: number;
  encoder: Conv[];
  hidden: number;
  lstmIh: Float32Array;
  lstmHh: Float32Array;
  /** Both biases, added once. */
  lstmBias: Float32Array;
  outWeight: Float32Array;
  outBias: number;
}

/** A half-precision float, as ggml stores the convolutions' weights. */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Reads the model: a name and version, the window, the layers' sizes, then each tensor by name.
 * Throws when the file is not that (cut short, another model, a layout this code doesn't know).
 */
export function readVadModel(file: Uint8Array): VadModel {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 0;
  const need = (bytes: number) => {
    if (at + bytes > file.byteLength) throw new Error("The speech detector's file is cut short.");
  };
  const int = () => {
    need(4);
    const value = view.getInt32(at, true);
    at += 4;
    return value;
  };
  const text = (length: number) => {
    if (length < 0 || length > 256) throw new Error("This is not a speech detector's file.");
    need(length);
    const value = Buffer.from(file.subarray(at, at + length)).toString("utf8");
    at += length;
    return value;
  };
  // "ggml" as whisper.cpp's loader reads it, then the model's name.
  if (int() !== 0x67676d6c) throw new Error("This is not a speech detector's file.");
  const type = text(int());
  if (!/silero/i.test(type)) throw new Error("This is not a speech detector's file.");
  at += 12; // its version: major, minor, patch
  need(0);
  const window = int();
  int(); // context samples, which whisper.cpp's steps don't use either
  const layers = int();
  if (window !== VAD_FRAME || layers !== 4) throw new Error("This speech detector has a layout VibeForge doesn't know.");
  const sizes = Array.from({ length: layers }, () => ({ inChannels: int(), outChannels: int(), kernel: int() }));
  const lstmInput = int();
  const hidden = int();
  int(); // the last convolution's sizes, which its tensor says again
  int();

  const tensors = new Map<string, { dims: number[]; data: Float32Array }>();
  while (at + 12 <= file.byteLength) {
    const dimCount = int();
    const nameLength = int();
    const kind = int();
    if (dimCount < 0 || dimCount > 4 || (kind !== 0 && kind !== 1)) throw new Error("This speech detector has a layout VibeForge doesn't know.");
    const dims = Array.from({ length: dimCount }, int);
    const name = text(nameLength);
    const count = dims.reduce((total, size) => total * size, 1);
    const data = new Float32Array(count);
    need(count * (kind === 0 ? 4 : 2));
    for (let i = 0; i < count; i += 1) data[i] = kind === 0 ? view.getFloat32(at + i * 4, true) : half(view.getUint16(at + i * 2, true));
    at += count * (kind === 0 ? 4 : 2);
    tensors.set(name, { dims, data });
  }
  const tensor = (name: string, count: number): Float32Array => {
    const found = tensors.get(name);
    if (!found || found.data.length !== count) throw new Error("This speech detector has a layout VibeForge doesn't know.");
    return found.data;
  };
  // ggml writes sizes innermost first: a convolution's are [kernel, in, out].
  const basisDims = tensors.get("_model.stft.forward_basis_buffer")?.dims ?? [];
  const basisKernel = basisDims[0] ?? 0;
  const filters = basisDims[2] ?? 0;
  if (basisKernel !== 256 || filters % 2 !== 0 || filters / 2 !== sizes[0].inChannels || lstmInput !== HOP) throw new Error("This speech detector has a layout VibeForge doesn't know.");
  const strides = [1, 2, 2, 1];
  const encoder = sizes.map((size, index): Conv => {
    const base = `_model.encoder.${index}.reparam_conv`;
    return { ...size, stride: strides[index], weight: tensor(`${base}.weight`, size.outChannels * size.inChannels * size.kernel), bias: tensor(`${base}.bias`, size.outChannels) };
  });
  if (encoder[3].outChannels !== hidden) throw new Error("This speech detector has a layout VibeForge doesn't know.");
  const ihBias = tensor("_model.decoder.rnn.bias_ih", 4 * hidden);
  const hhBias = tensor("_model.decoder.rnn.bias_hh", 4 * hidden);
  return {
    window,
    basis: tensor("_model.stft.forward_basis_buffer", filters * basisKernel),
    basisKernel,
    bins: filters / 2,
    encoder,
    hidden,
    lstmIh: tensor("_model.decoder.rnn.weight_ih", 4 * hidden * hidden),
    lstmHh: tensor("_model.decoder.rnn.weight_hh", 4 * hidden * hidden),
    lstmBias: ihBias.map((value, index) => value + hhBias[index]),
    outWeight: tensor("_model.decoder.decoder.2.weight", hidden),
    outBias: tensor("_model.decoder.decoder.2.bias", 1)[0],
  };
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** One convolution over [channels][length], zero-padded by one at each end, then ReLU. */
function convolve(layer: Conv, input: Float32Array, length: number): { out: Float32Array; length: number } {
  const { inChannels, outChannels, kernel, stride, weight, bias } = layer;
  const outLength = Math.floor((length + 2 - kernel) / stride) + 1;
  const out = new Float32Array(outChannels * outLength);
  for (let o = 0; o < outChannels; o += 1) {
    for (let t = 0; t < outLength; t += 1) {
      let sum = bias[o];
      for (let k = 0; k < kernel; k += 1) {
        const from = t * stride + k - 1;
        if (from < 0 || from >= length) continue;
        let w = (o * inChannels) * kernel + k;
        for (let c = 0; c < inChannels; c += 1, w += kernel) sum += weight[w] * input[c * length + from];
      }
      out[o * outLength + t] = sum > 0 ? sum : 0;
    }
  }
  return { out, length: outLength };
}

/**
 * How likely each 32 ms frame is to be speech, one frame after another: it remembers what came
 * before (the LSTM's state), so frames go in in order, and `reset` starts it afresh.
 */
export class SpeechDetector {
  private h: Float32Array;
  private c: Float32Array;
  private readonly padded: Float32Array;

  constructor(private readonly model: VadModel) {
    this.h = new Float32Array(model.hidden);
    this.c = new Float32Array(model.hidden);
    this.padded = new Float32Array(model.window + 2 * PAD);
  }

  reset(): void {
    this.h.fill(0);
    this.c.fill(0);
  }

  /** `frame`: VAD_FRAME samples, -1 to 1. Returns 0–1. */
  probability(frame: Float32Array): number {
    const { model, padded } = this;
    const n = model.window;
    // Mirrored at both ends, so the spectrum's first and last windows are whole.
    for (let i = 0; i < PAD; i += 1) {
      padded[i] = frame[PAD - i];
      padded[PAD + n + i] = frame[n - 2 - i];
    }
    padded.set(frame.subarray(0, n), PAD);

    // The spectrum's size at each of four moments: [bins][4].
    const steps = Math.floor((padded.length - model.basisKernel) / HOP) + 1;
    let length = steps;
    let cur: Float32Array = new Float32Array(model.bins * steps);
    for (let bin = 0; bin < model.bins; bin += 1) {
      const real = bin * model.basisKernel;
      const imaginary = (bin + model.bins) * model.basisKernel;
      for (let t = 0; t < steps; t += 1) {
        let re = 0;
        let im = 0;
        const start = t * HOP;
        for (let k = 0; k < model.basisKernel; k += 1) {
          const sample = padded[start + k];
          re += model.basis[real + k] * sample;
          im += model.basis[imaginary + k] * sample;
        }
        cur[bin * steps + t] = Math.sqrt(re * re + im * im);
      }
    }
    for (const layer of model.encoder) {
      const next = convolve(layer, cur, length);
      cur = next.out;
      length = next.length;
    }

    // One LSTM step on the first (by now the only) moment. Gates in PyTorch's order: in, forget, cell, out.
    const hidden = model.hidden;
    const gates = new Float32Array(4 * hidden);
    for (let g = 0; g < 4 * hidden; g += 1) {
      let sum = model.lstmBias[g];
      const row = g * hidden;
      for (let j = 0; j < hidden; j += 1) sum += model.lstmIh[row + j] * cur[j * length] + model.lstmHh[row + j] * this.h[j];
      gates[g] = sum;
    }
    let out = model.outBias;
    for (let j = 0; j < hidden; j += 1) {
      const cell = sigmoid(gates[hidden + j]) * this.c[j] + sigmoid(gates[j]) * Math.tanh(gates[2 * hidden + j]);
      const state = sigmoid(gates[3 * hidden + j]) * Math.tanh(cell);
      this.c[j] = cell;
      this.h[j] = state;
      if (state > 0) out += model.outWeight[j] * state;
    }
    return sigmoid(out);
  }
}

/** 16-bit samples as the model takes them. */
export function floatFrame(pcm: Uint8Array, into: Float32Array = new Float32Array(pcm.length >> 1)): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < into.length; i += 1) into[i] = view.getInt16(i * 2, true) / 32_768;
  return into;
}
