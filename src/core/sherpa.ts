import fs from "node:fs";
import path from "node:path";
import type { PinnedFile } from "../shared/voice-catalog.js";

// Local ONNX speech-to-text via sherpa-onnx (Apache-2.0): runs NVIDIA Parakeet TDT, NVIDIA Canary
// Flash, and Useful Sensors Moonshine on laptop CPUs in under a second. Pure helpers here; process
// spawning and downloads live in electron/voice.ts.

export interface SherpaBuild extends PinnedFile {
  file: string;
  url: string;
}

export interface SherpaPin {
  version: string;
  license: string;
  source: string;
  builds: Record<string, SherpaBuild>;
}

const SHERPA_RELEASE = "v1.13.8";
const SHERPA_RELEASES_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_RELEASE}`;

export const SHERPA_PIN: SherpaPin = {
  version: SHERPA_RELEASE,
  license: "Apache-2.0",
  source: `https://github.com/k2-fsa/sherpa-onnx/tree/${SHERPA_RELEASE}`,
  builds: {
    x64: {
      file: `sherpa-onnx-${SHERPA_RELEASE}-linux-x64-shared-no-tts.tar.bz2`,
      url: `${SHERPA_RELEASES_URL}/sherpa-onnx-${SHERPA_RELEASE}-linux-x64-shared-no-tts.tar.bz2`,
      bytes: 24_802_494,
      sha256: "d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc",
    },
    arm64: {
      file: `sherpa-onnx-${SHERPA_RELEASE}-linux-aarch64-shared-cpu.tar.bz2`,
      url: `${SHERPA_RELEASES_URL}/sherpa-onnx-${SHERPA_RELEASE}-linux-aarch64-shared-cpu.tar.bz2`,
      bytes: 28_091_778,
      sha256: "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
    },
  },
};

export function sherpaMark(arch: string): string {
  return `${SHERPA_PIN.version} ${SHERPA_PIN.builds[arch]?.sha256 ?? ""}\n`;
}

export function sherpaPresent(dir: string, arch: string): boolean {
  try {
    return (
      fs.readFileSync(path.join(dir, "PIN"), "utf8") === sherpaMark(arch) &&
      fs.statSync(path.join(dir, "bin", "sherpa-onnx-offline")).size > 10_000
    );
  } catch {
    return false;
  }
}

export function sherpaSourceNote(): string {
  return [
    `sherpa-onnx ${SHERPA_PIN.version}`,
    "",
    "This folder holds sherpa-onnx exactly as the k2-fsa/sherpa-onnx project published it; VibeForge",
    "does not modify it. VibeForge uses it locally for offline ONNX speech-to-text (Settings → Voice).",
    "",
    `Release:  https://github.com/k2-fsa/sherpa-onnx/releases/tag/${SHERPA_PIN.version}`,
    `Source:   ${SHERPA_PIN.source}`,
    "License:  Apache License 2.0, in LICENSE beside this file.",
    "",
  ].join("\n");
}

export interface SherpaRuntime {
  cli: string | null;
  libDir: string | null;
  cApiLib: string | null;
}

/** Finds VibeForge's downloaded sherpa-onnx first (pinned ABI), else sherpa-onnx-offline on PATH, or an override. */
export function findSherpa(
  resolveBin: (bin: string) => string | null,
  dataRoot: string,
  env: { cli?: string } = {},
): SherpaRuntime {
  let cli: string | null = null;
  if (env.cli?.trim()) {
    const named = env.cli.trim();
    cli = resolveBin(named) ?? (path.isAbsolute(named) && fs.existsSync(named) ? named : null);
  } else {
    const bundled = path.join(dataRoot, "sherpa-onnx", "bin", "sherpa-onnx-offline");
    if (fs.existsSync(bundled)) cli = bundled;
    else cli = resolveBin("sherpa-onnx-offline");
  }
  if (!cli) return { cli: null, libDir: null, cApiLib: null };
  const siblingLib = path.resolve(path.dirname(cli), "..", "lib");
  const libDir = fs.existsSync(siblingLib) ? siblingLib : null;
  const candidates = [
    ...(libDir ? [path.join(libDir, "libsherpa-onnx-c-api.so")] : []),
    "/usr/lib/libsherpa-onnx-c-api.so",
    "/usr/local/lib/libsherpa-onnx-c-api.so",
  ];
  const cApiLib = candidates.find((file) => fs.existsSync(file)) ?? null;
  return { cli, libDir, cApiLib };
}

export type SherpaModelSpec =
  | { kind: "nemo_transducer"; dir: string; encoder: string; decoder: string; joiner: string; tokens: string }
  | { kind: "canary"; dir: string; encoder: string; decoder: string; tokens: string }
  | { kind: "moonshine"; dir: string; preprocessor: string; encoder: string; uncachedDecoder: string; cachedDecoder: string; tokens: string }
  | { kind: "sense_voice"; dir: string; model: string; tokens: string };

/** Inspects a directory's filenames and returns the sherpa-onnx model layout when all required files are complete. */
export function resolveSherpaModel(dir: string, fileNames: readonly string[]): SherpaModelSpec | null {
  const names = new Set(fileNames.filter((name) => !name.endsWith(".part")));
  if (!names.has("tokens.txt")) return null;
  const pick = (...candidates: string[]): string | null => {
    const found = candidates.find((name) => names.has(name));
    return found ? path.join(dir, found) : null;
  };
  const tokens = path.join(dir, "tokens.txt");

  const encoder = pick("encoder.int8.onnx", "encoder.onnx");
  const decoder = pick("decoder.int8.onnx", "decoder.onnx");
  const joiner = pick("joiner.int8.onnx", "joiner.onnx");
  if (encoder && decoder && joiner) {
    return { kind: "nemo_transducer", dir, encoder, decoder, joiner, tokens };
  }

  const preprocessor = pick("preprocess.onnx");
  const moonEncoder = pick("encode.int8.onnx", "encode.onnx");
  const uncachedDecoder = pick("uncached_decode.int8.onnx", "uncached_decode.onnx");
  const cachedDecoder = pick("cached_decode.int8.onnx", "cached_decode.onnx");
  if (preprocessor && moonEncoder && uncachedDecoder && cachedDecoder) {
    return { kind: "moonshine", dir, preprocessor, encoder: moonEncoder, uncachedDecoder, cachedDecoder, tokens };
  }

  const baseName = path.basename(dir).toLowerCase();
  if (encoder && decoder && baseName.includes("canary")) {
    return { kind: "canary", dir, encoder, decoder, tokens };
  }

  const senseModel = pick("model.int8.onnx", "model.onnx");
  if (senseModel && (baseName.includes("sense-voice") || baseName.includes("sensevoice"))) {
    return { kind: "sense_voice", dir, model: senseModel, tokens };
  }

  return null;
}

export function sherpaCliArgs(spec: SherpaModelSpec, opts: { wavFile: string; language: string; threads: number }): string[] {
  const common = [`--tokens=${spec.tokens}`, `--num-threads=${opts.threads}`];
  if (spec.kind === "nemo_transducer") {
    return [
      ...common,
      `--encoder=${spec.encoder}`,
      `--decoder=${spec.decoder}`,
      `--joiner=${spec.joiner}`,
      "--model-type=nemo_transducer",
      opts.wavFile,
    ];
  }
  if (spec.kind === "canary") {
    const lang = /^(?:en|de|es|fr)$/.test(opts.language) ? opts.language : "en";
    return [
      ...common,
      `--canary-encoder=${spec.encoder}`,
      `--canary-decoder=${spec.decoder}`,
      `--canary-src-lang=${lang}`,
      `--canary-tgt-lang=${lang}`,
      "--canary-use-pnc=1",
      opts.wavFile,
    ];
  }
  if (spec.kind === "moonshine") {
    return [
      ...common,
      `--moonshine-preprocessor=${spec.preprocessor}`,
      `--moonshine-encoder=${spec.encoder}`,
      `--moonshine-uncached-decoder=${spec.uncachedDecoder}`,
      `--moonshine-cached-decoder=${spec.cachedDecoder}`,
      opts.wavFile,
    ];
  }
  const lang = opts.language && opts.language !== "auto" ? opts.language : "auto";
  return [
    ...common,
    `--sense-voice-model=${spec.model}`,
    `--sense-voice-language=${lang}`,
    "--sense-voice-use-itn=1",
    opts.wavFile,
  ];
}

/** Extracts the transcribed text from sherpa-onnx-offline's JSON output lines. */
export function parseSherpaOutput(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.includes("{") || !line.includes('"text"')) continue;
    const start = line.indexOf("{");
    const end = line.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(line.slice(start, end + 1)) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text;
    } catch {
      /* keep scanning earlier lines */
    }
  }
  return "";
}

/**
 * Zero-port stdio worker keeping sherpa-onnx warm in RAM via libsherpa-onnx-c-api.so (v1.13.8).
 * Reads `<uint32LE byteLength><wavBytes>` from stdin, decodes the WAV in memory without touching
 * /tmp, and writes `{"ok":true,"text":"..."}` lines on stdout. Verifies the exact C-API version
 * before constructing structs so a mismatched system library exits cleanly and falls back to CLI.
 */
export const SHERPA_WORKER_SCRIPT = `
import ctypes, json, struct, sys

cfg_in = json.loads(sys.argv[1])
lib = ctypes.CDLL(cfg_in["cApiLib"])

lib.SherpaOnnxGetVersionStr.argtypes = []
lib.SherpaOnnxGetVersionStr.restype = ctypes.c_char_p
ver_ptr = lib.SherpaOnnxGetVersionStr()
ver = ver_ptr.decode("utf-8", errors="replace") if ver_ptr else ""
if ver != ${JSON.stringify(SHERPA_RELEASE.slice(1))}:
    sys.stderr.write(f"sherpa-onnx c-api version mismatch: expected ${SHERPA_RELEASE.slice(1)}, got {ver}\\n")
    sys.exit(2)

c_str = ctypes.c_char_p
c_i32 = ctypes.c_int32
c_f32 = ctypes.c_float

class Transducer(ctypes.Structure):
    _fields_ = [("encoder", c_str), ("decoder", c_str), ("joiner", c_str)]
class SingleModel(ctypes.Structure):
    _fields_ = [("model", c_str)]
class WhisperCfg(ctypes.Structure):
    _fields_ = [("encoder", c_str), ("decoder", c_str), ("language", c_str), ("task", c_str), ("tail_paddings", c_i32), ("enable_token_timestamps", c_i32), ("enable_segment_timestamps", c_i32)]
class SenseVoiceCfg(ctypes.Structure):
    _fields_ = [("model", c_str), ("language", c_str), ("use_itn", c_i32)]
class MoonshineCfg(ctypes.Structure):
    _fields_ = [("preprocessor", c_str), ("encoder", c_str), ("uncached_decoder", c_str), ("cached_decoder", c_str), ("merged_decoder", c_str)]
class PairCfg(ctypes.Structure):
    _fields_ = [("encoder", c_str), ("decoder", c_str)]
class CanaryCfg(ctypes.Structure):
    _fields_ = [("encoder", c_str), ("decoder", c_str), ("src_lang", c_str), ("tgt_lang", c_str), ("use_pnc", c_i32)]
class FunAsrNanoCfg(ctypes.Structure):
    _fields_ = [("encoder_adaptor", c_str), ("llm", c_str), ("embedding", c_str), ("tokenizer", c_str), ("system_prompt", c_str), ("user_prompt", c_str), ("max_new_tokens", c_i32), ("temperature", c_f32), ("top_p", c_f32), ("seed", c_i32), ("language", c_str), ("itn", c_i32), ("hotwords", c_str)]
class Qwen3AsrCfg(ctypes.Structure):
    _fields_ = [("conv_frontend", c_str), ("encoder", c_str), ("decoder", c_str), ("tokenizer", c_str), ("max_total_len", c_i32), ("max_new_tokens", c_i32), ("temperature", c_f32), ("top_p", c_f32), ("seed", c_i32), ("hotwords", c_str)]
class CohereCfg(ctypes.Structure):
    _fields_ = [("encoder", c_str), ("decoder", c_str), ("language", c_str), ("use_punct", c_i32), ("use_itn", c_i32)]
class ModelConfig(ctypes.Structure):
    _fields_ = [
        ("transducer", Transducer), ("paraformer", SingleModel), ("nemo_ctc", SingleModel),
        ("whisper", WhisperCfg), ("tdnn", SingleModel), ("tokens", c_str),
        ("num_threads", c_i32), ("debug", c_i32), ("provider", c_str),
        ("model_type", c_str), ("modeling_unit", c_str), ("bpe_vocab", c_str),
        ("telespeech_ctc", c_str), ("sense_voice", SenseVoiceCfg), ("moonshine", MoonshineCfg),
        ("fire_red_asr", PairCfg), ("dolphin", SingleModel), ("zipformer_ctc", SingleModel),
        ("canary", CanaryCfg), ("wenet_ctc", SingleModel), ("omnilingual", SingleModel),
        ("medasr", SingleModel), ("funasr_nano", FunAsrNanoCfg), ("fire_red_asr_ctc", SingleModel),
        ("qwen3_asr", Qwen3AsrCfg), ("cohere_transcribe", CohereCfg),
    ]
class FeatConfig(ctypes.Structure):
    _fields_ = [("sample_rate", c_i32), ("feature_dim", c_i32)]
class HomophoneCfg(ctypes.Structure):
    _fields_ = [("dict_dir", c_str), ("lexicon", c_str), ("rule_fsts", c_str)]
class RecognizerConfig(ctypes.Structure):
    _fields_ = [
        ("feat_config", FeatConfig), ("model_config", ModelConfig), ("lm_config_model", c_str),
        ("lm_config_scale", c_f32), ("decoding_method", c_str), ("max_active_paths", c_i32),
        ("hotwords_file", c_str), ("hotwords_score", c_f32), ("rule_fsts", c_str),
        ("rule_fars", c_str), ("blank_penalty", c_f32), ("hr", HomophoneCfg),
    ]
class Wave(ctypes.Structure):
    _fields_ = [("samples", ctypes.POINTER(c_f32)), ("sample_rate", c_i32), ("num_samples", c_i32)]
class Result(ctypes.Structure):
    _fields_ = [("text", c_str)]

lib.SherpaOnnxCreateOfflineRecognizer.argtypes = [ctypes.POINTER(RecognizerConfig)]
lib.SherpaOnnxCreateOfflineRecognizer.restype = ctypes.c_void_p
lib.SherpaOnnxDestroyOfflineRecognizer.argtypes = [ctypes.c_void_p]
lib.SherpaOnnxCreateOfflineStream.argtypes = [ctypes.c_void_p]
lib.SherpaOnnxCreateOfflineStream.restype = ctypes.c_void_p
lib.SherpaOnnxDestroyOfflineStream.argtypes = [ctypes.c_void_p]
lib.SherpaOnnxAcceptWaveformOffline.argtypes = [ctypes.c_void_p, c_i32, ctypes.POINTER(c_f32), c_i32]
lib.SherpaOnnxDecodeOfflineStream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
lib.SherpaOnnxGetOfflineStreamResult.argtypes = [ctypes.c_void_p]
lib.SherpaOnnxGetOfflineStreamResult.restype = ctypes.POINTER(Result)
lib.SherpaOnnxDestroyOfflineRecognizerResult.argtypes = [ctypes.POINTER(Result)]
lib.SherpaOnnxReadWaveFromBinaryData.argtypes = [ctypes.c_char_p, c_i32]
lib.SherpaOnnxReadWaveFromBinaryData.restype = ctypes.POINTER(Wave)
lib.SherpaOnnxFreeWave.argtypes = [ctypes.POINTER(Wave)]

keep = []
def b(s):
    enc = s.encode("utf-8")
    keep.append(enc)
    return enc

cfg = RecognizerConfig()
cfg.feat_config.sample_rate = 16000
cfg.feat_config.feature_dim = 80
cfg.decoding_method = b("greedy_search")
cfg.model_config.tokens = b(cfg_in["tokens"])
cfg.model_config.num_threads = int(cfg_in["threads"])
cfg.model_config.provider = b("cpu")

kind = cfg_in["kind"]
lang = cfg_in.get("language") or "en"
if kind == "nemo_transducer":
    cfg.model_config.transducer.encoder = b(cfg_in["encoder"])
    cfg.model_config.transducer.decoder = b(cfg_in["decoder"])
    cfg.model_config.transducer.joiner = b(cfg_in["joiner"])
    cfg.model_config.model_type = b("nemo_transducer")
elif kind == "canary":
    code = lang if lang in ("en", "de", "es", "fr") else "en"
    cfg.model_config.canary.encoder = b(cfg_in["encoder"])
    cfg.model_config.canary.decoder = b(cfg_in["decoder"])
    cfg.model_config.canary.src_lang = b(code)
    cfg.model_config.canary.tgt_lang = b(code)
    cfg.model_config.canary.use_pnc = 1
elif kind == "moonshine":
    cfg.model_config.moonshine.preprocessor = b(cfg_in["preprocessor"])
    cfg.model_config.moonshine.encoder = b(cfg_in["encoder"])
    cfg.model_config.moonshine.uncached_decoder = b(cfg_in["uncachedDecoder"])
    cfg.model_config.moonshine.cached_decoder = b(cfg_in["cachedDecoder"])
elif kind == "sense_voice":
    cfg.model_config.sense_voice.model = b(cfg_in["model"])
    cfg.model_config.sense_voice.language = b(lang if lang else "auto")
    cfg.model_config.sense_voice.use_itn = 1
else:
    sys.stderr.write(f"unsupported sherpa model kind: {kind}\\n")
    sys.exit(2)

rec = lib.SherpaOnnxCreateOfflineRecognizer(ctypes.byref(cfg))
if not rec:
    sys.stderr.write("SherpaOnnxCreateOfflineRecognizer returned null\\n")
    sys.exit(1)

sys.stdout.write(json.dumps({"ready": True}) + "\\n")
sys.stdout.flush()

def read_exact(n):
    chunks = []
    got = 0
    while got < n:
        part = sys.stdin.buffer.read(n - got)
        if not part:
            return None
        chunks.append(part)
        got += len(part)
    return b"".join(chunks)

try:
    while True:
        hdr = read_exact(4)
        if hdr is None:
            break
        (length,) = struct.unpack("<I", hdr)
        wav = read_exact(length)
        if wav is None:
            break
        buf = ctypes.create_string_buffer(wav, len(wav))
        wave = lib.SherpaOnnxReadWaveFromBinaryData(ctypes.cast(buf, c_str), len(wav))
        if not wave:
            sys.stdout.write(json.dumps({"ok": False, "error": "invalid wav data"}) + "\\n")
            sys.stdout.flush()
            continue
        try:
            stream = lib.SherpaOnnxCreateOfflineStream(rec)
            try:
                lib.SherpaOnnxAcceptWaveformOffline(stream, wave.contents.sample_rate, wave.contents.samples, wave.contents.num_samples)
                lib.SherpaOnnxDecodeOfflineStream(rec, stream)
                res = lib.SherpaOnnxGetOfflineStreamResult(stream)
                try:
                    raw = res.contents.text if res and res.contents.text else b""
                    text = raw.decode("utf-8", errors="replace").strip()
                finally:
                    if res:
                        lib.SherpaOnnxDestroyOfflineRecognizerResult(res)
            finally:
                lib.SherpaOnnxDestroyOfflineStream(stream)
        finally:
            lib.SherpaOnnxFreeWave(wave)
        sys.stdout.write(json.dumps({"ok": True, "text": text}) + "\\n")
        sys.stdout.flush()
finally:
    lib.SherpaOnnxDestroyOfflineRecognizer(rec)
`;
