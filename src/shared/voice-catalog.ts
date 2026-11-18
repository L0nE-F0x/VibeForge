// Speech-to-text and text-to-speech model catalogs, language support, and selection rules.
// Pure and Node-free so the main process, the settings view, and Viby's shared plan validator
// all work from one list of pinned models and voices.

export type VoiceBackend = "whisper" | "sherpa";

/** What a downloaded file must be to be kept: its exact size and SHA-256, as Hugging Face lists them. */
export interface PinnedFile {
  bytes: number;
  sha256: string;
}

export interface ModelPart extends PinnedFile {
  /** Filename inside the model's folder (e.g. "encoder.int8.onnx"). */
  name: string;
}

export type ModelNote = "parakeet" | "parakeetEn" | "canary" | "moonshine" | "distil" | "whisperQuant";

export interface ModelChoice extends PinnedFile {
  id: string;
  /** Filename under models/ for whisper.cpp (.bin), or folder name under models/ for sherpa-onnx. */
  file: string;
  /** Rough total download size in MB, for the button. */
  mb: number;
  englishOnly: boolean;
  backend: VoiceBackend;
  repo: string;
  commit: string;
  /** Short hint key for the download picker in Settings → Voice. */
  note?: ModelNote;
  /** Explicit language codes when the model covers a fixed subset rather than 99-language Whisper. */
  languages?: readonly string[];
  /** Multi-file bundle for ONNX models; absent for single-file ggml models. */
  files?: readonly ModelPart[];
}

/**
 * Immutable Hugging Face commits models come from. A branch can move under the hashes below;
 * a commit SHA cannot.
 */
export const WHISPER_COMMIT = "5359861c739e955e79d9a303bcbc70fb988958b1";
export const DISTIL_SMALL_EN_COMMIT = "9e4a67ca4569c30be43a3fe7fba1621e504f0093";

/** The 25 European languages NVIDIA Parakeet TDT 0.6B v3 is trained on. */
export const PARAKEET_V3_LANGUAGES = [
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "ru",
  "uk",
] as const;

export const CANARY_FLASH_LANGUAGES = ["en", "de", "es", "fr"] as const;

/**
 * Local speech-to-text models offered for download: fast INT8 ONNX models (Parakeet TDT, Canary
 * Flash, Moonshine) run with sherpa-onnx for sub-second laptop CPU inference, alongside Distil-Whisper,
 * quantized Q5_1 Whisper, and standard ggml Whisper models for whisper.cpp.
 */
export const MODEL_CATALOG: ModelChoice[] = [
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    file: "parakeet-tdt-0.6b-v3-int8",
    mb: 640,
    englishOnly: false,
    backend: "sherpa",
    repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    commit: "ed5d745623472f97cfc2e6c2916ee248798fc5a8",
    note: "parakeet",
    languages: PARAKEET_V3_LANGUAGES,
    bytes: 670_576_784,
    sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479",
    files: [
      { name: "encoder.int8.onnx", bytes: 652_282_294, sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479" },
      { name: "decoder.int8.onnx", bytes: 11_845_274, sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5" },
      { name: "joiner.int8.onnx", bytes: 6_355_277, sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98" },
      { name: "tokens.txt", bytes: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
    ],
  },
  {
    id: "parakeet-tdt-0.6b-v2-int8",
    file: "parakeet-tdt-0.6b-v2-int8",
    mb: 631,
    englishOnly: true,
    backend: "sherpa",
    repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    commit: "84b478d541cdbf0c296a7ab5f1e20a6f8f998114",
    note: "parakeetEn",
    bytes: 661_288_526,
    sha256: "92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b",
    files: [
      { name: "encoder.int8.onnx", bytes: 652_282_309, sha256: "92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b" },
      { name: "decoder.int8.onnx", bytes: 7_257_753, sha256: "4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41" },
      { name: "joiner.int8.onnx", bytes: 1_739_080, sha256: "77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428" },
      { name: "tokens.txt", bytes: 9_384, sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" },
    ],
  },
  {
    id: "canary-180m-flash-int8",
    file: "canary-180m-flash-int8",
    mb: 198,
    englishOnly: false,
    backend: "sherpa",
    repo: "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
    commit: "9077164e0d3dd1d5353743e89ceaa1d3a770838c",
    note: "canary",
    languages: CANARY_FLASH_LANGUAGES,
    bytes: 207_170_046,
    sha256: "7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f",
    files: [
      { name: "encoder.int8.onnx", bytes: 132_678_643, sha256: "7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f" },
      { name: "decoder.int8.onnx", bytes: 74_437_848, sha256: "e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2" },
      { name: "tokens.txt", bytes: 53_555, sha256: "2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77" },
    ],
  },
  {
    id: "moonshine-base-en-int8",
    file: "moonshine-base-en-int8",
    mb: 274,
    englishOnly: true,
    backend: "sherpa",
    repo: "csukuangfj/sherpa-onnx-moonshine-base-en-int8",
    commit: "052b0798ad1bf046a140fdd4efcd9426530fa3f5",
    note: "moonshine",
    bytes: 286_929_760,
    sha256: "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2",
    files: [
      { name: "encode.int8.onnx", bytes: 50_311_494, sha256: "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2" },
      { name: "preprocess.onnx", bytes: 14_077_290, sha256: "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2" },
      { name: "uncached_decode.int8.onnx", bytes: 122_120_451, sha256: "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987" },
      { name: "cached_decode.int8.onnx", bytes: 99_983_837, sha256: "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03" },
      { name: "tokens.txt", bytes: 436_688, sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea" },
    ],
  },
  {
    id: "moonshine-tiny-en-int8",
    file: "moonshine-tiny-en-int8",
    mb: 118,
    englishOnly: true,
    backend: "sherpa",
    repo: "csukuangfj/sherpa-onnx-moonshine-tiny-en-int8",
    commit: "bf2b762c076d8ea61e2af0b3851c9564fb77552e",
    note: "moonshine",
    bytes: 123_967_539,
    sha256: "8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb",
    files: [
      { name: "encode.int8.onnx", bytes: 18_249_187, sha256: "8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb" },
      { name: "preprocess.onnx", bytes: 6_800_738, sha256: "f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e" },
      { name: "uncached_decode.int8.onnx", bytes: 53_216_096, sha256: "216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41" },
      { name: "cached_decode.int8.onnx", bytes: 45_264_830, sha256: "2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6" },
      { name: "tokens.txt", bytes: 436_688, sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea" },
    ],
  },
  {
    id: "distil-small.en",
    file: "ggml-distil-small.en.bin",
    mb: 321,
    englishOnly: true,
    backend: "whisper",
    repo: "distil-whisper/distil-small.en",
    commit: DISTIL_SMALL_EN_COMMIT,
    note: "distil",
    bytes: 336_191_657,
    sha256: "7691eb11167ab7aaf6b3e05d8266f2fd9ad89c550e433f86ac266ebdee6c970a",
  },
  {
    id: "small.en-q5_1",
    file: "ggml-small.en-q5_1.bin",
    mb: 181,
    englishOnly: true,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    note: "whisperQuant",
    bytes: 190_098_681,
    sha256: "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30",
  },
  {
    id: "small-q5_1",
    file: "ggml-small-q5_1.bin",
    mb: 181,
    englishOnly: false,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    note: "whisperQuant",
    bytes: 190_085_487,
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  },
  {
    id: "base.en",
    file: "ggml-base.en.bin",
    mb: 142,
    englishOnly: true,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    bytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  },
  {
    id: "small.en",
    file: "ggml-small.en.bin",
    mb: 466,
    englishOnly: true,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  },
  {
    id: "base",
    file: "ggml-base.bin",
    mb: 142,
    englishOnly: false,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    bytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  },
  {
    id: "small",
    file: "ggml-small.bin",
    mb: 466,
    englishOnly: false,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    bytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  {
    id: "large-v3-turbo-q5_0",
    file: "ggml-large-v3-turbo-q5_0.bin",
    mb: 547,
    englishOnly: false,
    backend: "whisper",
    repo: "ggerganov/whisper.cpp",
    commit: WHISPER_COMMIT,
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
];

export function modelUrl(choice: ModelChoice): string {
  const part = choice.files?.[0]?.name ?? choice.file;
  return `https://huggingface.co/${choice.repo}/resolve/${choice.commit}/${part}`;
}

export interface ModelDownloadPart extends PinnedFile {
  url: string;
  /** Relative path under the models folder ("ggml-base.en.bin" or "parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx"). */
  relPath: string;
}

export function modelFiles(choice: ModelChoice): ModelDownloadPart[] {
  if (!choice.files?.length) {
    return [{ url: modelUrl(choice), relPath: choice.file, bytes: choice.bytes, sha256: choice.sha256 }];
  }
  return choice.files.map((part) => ({
    url: `https://huggingface.co/${choice.repo}/resolve/${choice.commit}/${part.name}`,
    relPath: `${choice.file}/${part.name}`,
    bytes: part.bytes,
    sha256: part.sha256,
  }));
}

function fileBaseName(file: string): string {
  return file.replace(/\/+$/, "").split("/").pop() ?? file;
}

/** A whisper.cpp model file: ggml-*.bin, but not the voice-activity models that share the prefix. */
export function isModelFile(name: string): boolean {
  return /^ggml-.+\.bin$/i.test(name) && !/silero|vad/i.test(name);
}

/** Which speech-to-text runtime loads `model`: `.bin` files go to whisper.cpp, ONNX model folders to sherpa-onnx. */
export function modelBackend(model: string): VoiceBackend {
  return /\.bin$/i.test(fileBaseName(model)) ? "whisper" : "sherpa";
}

export function isEnglishOnly(model: string): boolean {
  const base = fileBaseName(model).replace(/\.bin$/i, "");
  if (/\.en([.-]|$)/i.test(base)) return true;
  if (/moonshine-(?:tiny|base)(?:-en)?\b/i.test(base)) return true;
  if (/parakeet-tdt-[\d.]+b-v2\b/i.test(base)) return true;
  return false;
}

/** Whether `model` can transcribe speech in `language` ("en", "de", "ja", or "auto"). */
export function modelSupportsLanguage(model: string, language: string): boolean {
  const code = language.trim().toLowerCase();
  if (!code || code === "auto") return true;
  if (isEnglishOnly(model)) return code === "en";
  const base = fileBaseName(model).toLowerCase();
  if (base.includes("canary-180m")) return (CANARY_FLASH_LANGUAGES as readonly string[]).includes(code);
  if (base.includes("parakeet-tdt") && base.includes("v3")) return (PARAKEET_V3_LANGUAGES as readonly string[]).includes(code);
  return true;
}

/**
 * Accuracy-and-speed score for auto-picking an installed model: Parakeet TDT 0.6B leads (top accuracy
 * and sub-second on CPU), followed by Whisper large-v3-turbo, Moonshine Base / Canary / Distil-Small /
 * Whisper Small, then Moonshine Tiny / Whisper Base / Tiny. Unknown names sort last.
 */
export function modelRank(model: string): number {
  const name = fileBaseName(model).toLowerCase();
  if (name.includes("parakeet-tdt")) return 48;
  if (name.includes("moonshine-base")) return 25;
  if (name.includes("canary-180m")) return 24;
  if (name.includes("distil-large")) return 44;
  if (name.includes("distil-medium")) return 33;
  if (name.includes("distil-small")) return 22;
  if (name.includes("moonshine-tiny")) return 12;
  if (name.includes("sense-voice") || name.includes("sensevoice")) return 23;
  const sizes = ["tiny", "base", "small", "medium", "large"];
  const index = sizes.findIndex((size) => name.includes(`-${size}`));
  return index < 0 ? -1 : index * 10 + (name.includes("turbo") ? 5 : 0) + (/q\d/.test(name) ? 0 : 1);
}

/**
 * The model to load: the one chosen in Settings when it exists and its runtime is installed, else the
 * best runnable one found. English-only models win a tie when the language is English, since they are sharper at it.
 */
export function pickModel(found: readonly string[], chosen: string, language: string, allowedBackends?: ReadonlySet<VoiceBackend>): string | null {
  const runnable = allowedBackends ? found.filter((file) => allowedBackends.has(modelBackend(file))) : [...found];
  if (!runnable.length) return null;
  if (chosen && runnable.includes(chosen)) return chosen;
  const english = language === "en";
  const usable = runnable.filter((file) => (language === "auto" ? true : modelSupportsLanguage(file, language)));
  const pool = usable.length ? usable : [...runnable];
  pool.sort((a, b) => modelRank(b) - modelRank(a) || Number(isEnglishOnly(b) === english) - Number(isEnglishOnly(a) === english) || a.localeCompare(b));
  return pool[0] ?? null;
}

/** The language the recognizer is told to listen for. English-only models always hear English; Canary needs one of its four codes. */
export function listenLanguage(model: string, setting: string): string {
  if (isEnglishOnly(model)) return "en";
  const base = fileBaseName(model).toLowerCase();
  if (base.includes("canary-180m")) {
    return (CANARY_FLASH_LANGUAGES as readonly string[]).includes(setting) ? setting : "en";
  }
  return /^[a-z]{2,3}$/.test(setting) ? setting : "auto";
}

/**
 * Encoder audio-context frames for whisper-cli (`-ac`): Whisper pads every clip to 30 s (1500 frames)
 * unless told otherwise, which wastes most CPU time on short voice commands. Keeps 2.5 s headroom,
 * aligned to 64 frames, between 256 (~5 s) and 1500 (30 s).
 */
export function whisperAudioCtx(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1500;
  const needed = Math.ceil((seconds + 2.5) * 50);
  const aligned = Math.ceil(Math.max(256, needed) / 64) * 64;
  return Math.min(1500, aligned);
}

// ------------------------------------------------------------------ Piper voices

export interface VoiceChoice {
  /** Piper's name for it, which is also the file name: en_US-lessac-medium. */
  id: string;
  /** Its folder in the rhasspy/piper-voices repository. */
  dir: string;
  mb: number;
  /** Language code, as the app's language picker uses them. */
  language: string;
  /** The .onnx file and its .onnx.json, as they are at PIPER_COMMIT. */
  model: PinnedFile;
  config: PinnedFile;
}

/** The commit of rhasspy/piper-voices on Hugging Face that voices come from, for the same reason as WHISPER_COMMIT. */
export const PIPER_COMMIT = "e7229f7d33a10e145e109b886d661984201ac3c4";

/** Voices offered for download: a few clear ones for each language VibeForge speaks. Japanese has none in Piper yet. */
export const VOICE_CATALOG: VoiceChoice[] = [
  {
    id: "en_US-lessac-medium",
    dir: "en/en_US/lessac/medium",
    mb: 63,
    language: "en",
    model: { bytes: 63_201_294, sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f" },
    config: { bytes: 4_885, sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0" },
  },
  {
    id: "en_US-ryan-high",
    dir: "en/en_US/ryan/high",
    mb: 121,
    language: "en",
    model: { bytes: 120_786_792, sha256: "b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca" },
    config: { bytes: 4_166, sha256: "c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011" },
  },
  {
    id: "en_GB-alan-medium",
    dir: "en/en_GB/alan/medium",
    mb: 63,
    language: "en",
    model: { bytes: 63_201_294, sha256: "0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330" },
    config: { bytes: 4_888, sha256: "c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e" },
  },
  {
    id: "en_GB-jenny_dioco-medium",
    dir: "en/en_GB/jenny_dioco/medium",
    mb: 63,
    language: "en",
    model: { bytes: 63_201_294, sha256: "469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01" },
    config: { bytes: 4_895, sha256: "a9a7a93a317c9a3cb6563e37eb057df9ef09c06188a8a4341b0fcb58cba54dd4" },
  },
  {
    id: "de_DE-thorsten-medium",
    dir: "de/de_DE/thorsten/medium",
    mb: 63,
    language: "de",
    model: { bytes: 63_201_294, sha256: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819" },
    config: { bytes: 4_819, sha256: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85" },
  },
  {
    id: "es_ES-davefx-medium",
    dir: "es/es_ES/davefx/medium",
    mb: 63,
    language: "es",
    model: { bytes: 63_201_294, sha256: "6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917" },
    config: { bytes: 4_817, sha256: "0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842" },
  },
  {
    id: "fr_FR-siwis-medium",
    dir: "fr/fr_FR/siwis/medium",
    mb: 63,
    language: "fr",
    model: { bytes: 63_201_294, sha256: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99" },
    config: { bytes: 4_875, sha256: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959" },
  },
  {
    id: "pt_BR-faber-medium",
    dir: "pt/pt_BR/faber/medium",
    mb: 63,
    language: "pt",
    model: { bytes: 63_201_294, sha256: "858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7" },
    config: { bytes: 4_855, sha256: "7e694de195ae3fc36dd732c445eb04fb49b649854893cb5506b978f0d50a1d6f" },
  },
  {
    id: "zh_CN-huayan-medium",
    dir: "zh/zh_CN/huayan/medium",
    mb: 63,
    language: "zh",
    model: { bytes: 63_201_294, sha256: "9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d" },
    config: { bytes: 4_822, sha256: "d521dc45504a8ccc99e325822b35946dd701840bfb07e3dbb31a40929ed6a82b" },
  },
];

export function voiceUrls(choice: VoiceChoice): { model: string; config: string } {
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_COMMIT}/${choice.dir}/${choice.id}.onnx`;
  return { model: base, config: `${base}.json` };
}

/** "en_GB-alan-medium" from its file. */
export function voiceName(file: string): string {
  return fileBaseName(file).replace(/\.onnx$/i, "");
}

/** The voice to speak with: the one asked for when it exists, else one in the app's language, else the first found. */
export function pickVoice(found: readonly string[], chosen: string, language: string): string | null {
  if (chosen && found.includes(chosen)) return chosen;
  const same = found.find((file) => voiceName(file).toLowerCase().startsWith(`${language.toLowerCase()}_`));
  return same ?? found[0] ?? null;
}
