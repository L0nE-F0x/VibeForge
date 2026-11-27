import path from "node:path";
import {
  LOCAL_ENGINE_ID,
  LOCAL_HARNESSES,
  LOCAL_PRESETS,
  anthropicBaseUrl,
  cleanLocalModel,
  isLocalConfigured,
  isLoopbackLocalUrl,
  normalizeLocalUrl,
  openAiBaseUrl,
  shortLocalModel,
  type ConcreteLocalHarness,
  type LocalModelInfo,
  type LocalPreset,
  type LocalRuntimeStatus,
  type LocalServerKind,
  type LocalServerProbe,
} from "../shared/local.js";
import { extractEarlySay } from "../shared/orchestrator-repair.js";
import type { Engine, EngineRow, LocalHarness, LocalSettings } from "./types.js";

export {
  LOCAL_ENGINE_ID,
  LOCAL_HARNESSES,
  LOCAL_PRESETS,
  anthropicBaseUrl,
  cleanLocalModel,
  isLocalConfigured,
  isLoopbackLocalUrl,
  normalizeLocalUrl,
  openAiBaseUrl,
  shortLocalModel,
  type ConcreteLocalHarness,
  type LocalModelInfo,
  type LocalPreset,
  type LocalRuntimeStatus,
  type LocalServerKind,
  type LocalServerProbe,
};

export interface LocalEngineResolution {
  engine: Engine;
  binPath: string;
  harness: ConcreteLocalHarness | null;
  harnessRow: EngineRow | null;
  extraArgs: string[];
  env: Record<string, string>;
  localModel: string;
}

export interface LocalBrainImage {
  mediaType: string;
  base64: string;
}

export interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

export interface LocalBrainRequest {
  url: string;
  model: string;
  messages: LocalChatMessage[];
  schema: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  onEarlySay?: (say: string) => void;
}

export interface LocalBrainResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type LocalBrainRunner = (req: LocalBrainRequest) => Promise<LocalBrainResult>;

const HARNESS_FALLBACKS: Record<ConcreteLocalHarness, EngineRow> = {
  opencode: { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
  claude: { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
  codex: { id: "codex", label: "Codex", bin: "codex", args: [], promptArgs: ["{prompt}"], continueArgs: ["resume", "--last"] },
};

/** Strip `<think>...</think>` blocks (including pre-opened lone closing tags and unclosed tails) from model output. */
export function stripThinkTags(text: string): string {
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const closeIdx = clean.toLowerCase().lastIndexOf("</think>");
  if (closeIdx >= 0) clean = clean.slice(closeIdx + "</think>".length);
  return clean.replace(/<think>[\s\S]*$/gi, "").trim();
}

function readyEarlySay(rawContent: string): string | null {
  const clean = stripThinkTags(rawContent).replace(/^```(?:json)?\s*/i, "").trimStart();
  if (!clean.startsWith("{")) return null;
  return extractEarlySay(clean);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** The --ctx-size (or -c) in a router-mode model's options, when it has a positive one. */
function routedContext(args: unknown): number | null {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--ctx-size" || args[i] === "-c") {
      const n = Number(args[i + 1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

async function fetchJsonSafe(
  targetUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; status: number; data: unknown; serverHeader: string; error: string | null }> {
  try {
    const res = await fetchFn(targetUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const serverHeader = res.headers.get("server") ?? "";
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, serverHeader, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    try {
      return { ok: true, status: res.status, data: text ? JSON.parse(text) : null, serverHeader, error: null };
    } catch {
      return { ok: false, status: res.status, data: null, serverHeader, error: "Invalid JSON response" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      status: 0,
      data: null,
      serverHeader: "",
      error: timeout ? "Timed out connecting to server" : msg || "Could not connect",
    };
  }
}

/** Probe an OpenAI-compatible local or home-network AI server for models, runtime kind, and context size. */
export async function probeLocalServer(
  rawUrl: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<LocalServerProbe> {
  const url = normalizeLocalUrl(rawUrl);
  if (!url) {
    return {
      url: (rawUrl ?? "").trim(),
      reachable: false,
      kind: null,
      isLoopback: false,
      models: [],
      contextLength: null,
      error: "Enter a valid http:// or https:// server address.",
    };
  }
  const isLoopback = isLoopbackLocalUrl(url);
  const timeoutMs = opts.timeoutMs ?? (isLoopback ? 1200 : 2500);
  const fetchFn = opts.fetchFn ?? fetch;
  const root = anthropicBaseUrl(url);
  const v1 = openAiBaseUrl(url);

  const [modelsRes, propsRes] = await Promise.all([
    fetchJsonSafe(`${v1}/models`, timeoutMs, fetchFn),
    fetchJsonSafe(`${root}/props`, timeoutMs, fetchFn),
  ]);

  const v1Data = modelsRes.ok && modelsRes.data && typeof modelsRes.data === "object" ? (modelsRes.data as { data?: unknown }) : null;
  const v1List = Array.isArray(v1Data?.data) ? (v1Data.data as Array<Record<string, unknown>>) : [];
  const propsObj = propsRes.ok && propsRes.data && typeof propsRes.data === "object" ? (propsRes.data as Record<string, unknown>) : null;
  const parsedPort = (() => {
    try {
      return new URL(url).port;
    } catch {
      return "";
    }
  })();
  const looksOllama =
    parsedPort === "11434" ||
    /ollama/i.test(modelsRes.serverHeader) ||
    v1List.some((item) => item?.owned_by === "library") ||
    (!modelsRes.ok && !propsRes.ok);

  const [tagsRes, psRes] = looksOllama
    ? await Promise.all([
        fetchJsonSafe(`${root}/api/tags`, timeoutMs, fetchFn),
        fetchJsonSafe(`${root}/api/ps`, timeoutMs, fetchFn),
      ])
    : [null, null];

  const byId = new Map<string, LocalModelInfo>();
  const upsert = (entry: LocalModelInfo) => {
    if (!entry.id) return;
    const prev = byId.get(entry.id);
    if (!prev) {
      byId.set(entry.id, entry);
      return;
    }
    byId.set(entry.id, {
      id: entry.id,
      loaded: prev.loaded || entry.loaded,
      contextLength: entry.contextLength ?? prev.contextLength ?? null,
      sizeBytes: entry.sizeBytes ?? prev.sizeBytes ?? null,
    });
  };

  // Ollama running models (/api/ps) carry loaded state + active context_length.
  const psObj = psRes?.ok && psRes.data && typeof psRes.data === "object" ? (psRes.data as { models?: unknown }) : null;
  const psModels = Array.isArray(psObj?.models) ? (psObj.models as Array<Record<string, unknown>>) : [];
  for (const m of psModels) {
    const id = cleanLocalModel(typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "");
    if (!id) continue;
    upsert({
      id,
      loaded: true,
      contextLength: positiveInt(m.context_length),
      sizeBytes: positiveInt(m.size),
    });
  }

  // Ollama installed models (/api/tags).
  const tagsObj = tagsRes?.ok && tagsRes.data && typeof tagsRes.data === "object" ? (tagsRes.data as { models?: unknown }) : null;
  const tagModels = Array.isArray(tagsObj?.models) ? (tagsObj.models as Array<Record<string, unknown>>) : [];
  for (const m of tagModels) {
    const id = cleanLocalModel(typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "");
    if (!id) continue;
    upsert({
      id,
      sizeBytes: positiveInt(m.size),
    });
  }

  // Standard OpenAI /v1/models (llama-server, LM Studio, Ollama, vLLM, MLX).
  for (const m of v1List) {
    const id = cleanLocalModel(typeof m.id === "string" ? m.id : "");
    if (!id) continue;
    const meta = m.meta && typeof m.meta === "object" ? (m.meta as Record<string, unknown>) : null;
    // llama-server's router mode (--models-dir) says per model whether it is loaded, and the
    // options it runs it with: its --ctx-size is the window in use, not the model's largest.
    const routed = m.status && typeof m.status === "object" ? (m.status as { value?: unknown; args?: unknown }) : null;
    const ctx =
      routedContext(routed?.args) ??
      positiveInt(m.context_length) ??
      positiveInt(m.max_context_length) ??
      positiveInt(meta?.n_ctx_train) ??
      null;
    upsert({
      id,
      ...(routed?.value === "loaded" ? { loaded: true } : {}),
      contextLength: ctx,
    });
  }

  // llama-server /props provides active n_ctx and fallback model alias.
  const defaultGen =
    propsObj?.default_generation_settings && typeof propsObj.default_generation_settings === "object"
      ? (propsObj.default_generation_settings as Record<string, unknown>)
      : null;
  const propsCtx = positiveInt(defaultGen?.n_ctx);
  const propsAlias = cleanLocalModel(
    typeof propsObj?.model_alias === "string"
      ? propsObj.model_alias
      : typeof propsObj?.model_path === "string"
        ? path.basename(propsObj.model_path)
        : "",
  );
  // A router's /props names no model of its own ("llama-server"): its models are the list above.
  if (propsObj?.role === "router") {
    /* nothing to add */
  } else if (propsAlias && byId.size === 0) {
    upsert({ id: propsAlias, loaded: true, contextLength: propsCtx });
  } else if (propsCtx && byId.size === 1) {
    const [only] = [...byId.values()];
    upsert({ id: only.id, loaded: true, contextLength: only.contextLength ?? propsCtx });
  }

  const reachable = Boolean(modelsRes.ok || propsRes.ok || tagsRes?.ok || psRes?.ok);
  let kind: LocalServerKind | null = null;
  if (reachable) {
    if (propsObj && (defaultGen !== null || typeof propsObj.model_alias === "string" || typeof propsObj.model_path === "string")) {
      kind = "llamacpp";
    } else if (/llama\.cpp/i.test(modelsRes.serverHeader)) {
      kind = "llamacpp";
    } else if (tagsRes?.ok || psRes?.ok || v1List.some((item) => item?.owned_by === "library") || /ollama/i.test(modelsRes.serverHeader)) {
      kind = "ollama";
    } else if (parsedPort === "1234" || v1List.some((item) => typeof item?.publisher === "string" || typeof item?.arch === "string")) {
      kind = "lmstudio";
    } else {
      kind = "openai";
    }
  }

  const models = [...byId.values()].sort((a, b) => Number(Boolean(b.loaded)) - Number(Boolean(a.loaded)));
  const contextLength =
    models.find((m) => m.loaded && m.contextLength)?.contextLength ??
    propsCtx ??
    models.find((m) => m.contextLength)?.contextLength ??
    null;

  const error = reachable ? null : (modelsRes.error || tagsRes?.error || propsRes.error || "Could not connect to server");
  return { url, reachable, kind, isLoopback, models, contextLength, error };
}

/** Detect installed local runtimes, local harness CLIs, and running loopback/configured servers. */
export async function detectLocalRuntimes(
  local: Pick<LocalSettings, "url">,
  rows: readonly EngineRow[],
  resolveBin: (bin: string) => string | null,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<LocalRuntimeStatus> {
  const binaries = {
    llamaServer: resolveBin("llama-server") ?? resolveBin("llama-cli"),
    ollama: resolveBin("ollama"),
    lms: resolveBin("lms"),
  };
  const harnesses = LOCAL_HARNESSES.map((id) => {
    const row = rows.find((item) => item.id === id) ?? HARNESS_FALLBACKS[id];
    const resolved = resolveBin(row.bin);
    return { id, label: row.label, available: Boolean(resolved), path: resolved };
  });

  const presetTimeout = opts.timeoutMs ?? 800;
  const presetProbes = await Promise.all(
    LOCAL_PRESETS.map((preset) => probeLocalServer(preset.url, { timeoutMs: presetTimeout, fetchFn: opts.fetchFn })),
  );

  const normalizedUrl = normalizeLocalUrl(local.url);
  let configured: LocalServerProbe | null = null;
  if (normalizedUrl) {
    const matched = presetProbes.find((p) => p.url === normalizedUrl);
    configured = matched ?? (await probeLocalServer(normalizedUrl, { timeoutMs: opts.timeoutMs ?? 2500, fetchFn: opts.fetchFn }));
  } else if (local.url.trim()) {
    configured = await probeLocalServer(local.url, { timeoutMs: opts.timeoutMs ?? 2500, fetchFn: opts.fetchFn });
  }

  return {
    servers: presetProbes,
    configured,
    binaries,
    harnesses,
  };
}

/** Pick the concrete installed coding CLI harness to drive local coding sessions. */
export function resolveLocalHarness(
  preferred: LocalHarness,
  rows: readonly EngineRow[],
  resolveBin: (bin: string) => string | null,
): { kind: ConcreteLocalHarness; row: EngineRow; binPath: string } | null {
  const order: readonly ConcreteLocalHarness[] = preferred === "auto" ? LOCAL_HARNESSES : [preferred];
  for (const kind of order) {
    const row = rows.find((item) => item.id === kind) ?? HARNESS_FALLBACKS[kind];
    const binPath = resolveBin(row.bin);
    if (binPath) return { kind, row, binPath };
  }
  return null;
}

/**
 * Resolve the virtual `local` Engine plus the ephemeral CLI args and environment variables
 * that point the chosen harness at the local server without editing the user's cloud configs.
 */
export function localEngineSpec(
  local: LocalSettings,
  rows: readonly EngineRow[],
  resolveBin: (bin: string) => string | null,
  overrideModel?: string,
): LocalEngineResolution {
  const resolved = resolveLocalHarness(local.harness, rows, resolveBin);
  const url = normalizeLocalUrl(local.url);
  const model = cleanLocalModel(overrideModel || local.model);
  const available = Boolean(resolved && url && model);
  const label = model ? `Local · ${shortLocalModel(model)}` : "Local AI";

  const engine: Engine = {
    id: LOCAL_ENGINE_ID,
    label,
    bin: resolved?.row.bin ?? "local",
    args: resolved?.row.args ?? [],
    ...(resolved?.row.promptArgs?.length ? { promptArgs: resolved.row.promptArgs } : {}),
    ...(resolved?.row.continueArgs?.length ? { continueArgs: resolved.row.continueArgs } : {}),
    available,
    path: resolved?.binPath ?? null,
    local: true,
  };

  if (!resolved || !url || !model) {
    return {
      engine,
      binPath: resolved?.binPath ?? "",
      harness: resolved?.kind ?? null,
      harnessRow: resolved?.row ?? null,
      extraArgs: [],
      env: {},
      localModel: model,
    };
  }

  if (resolved.kind === "opencode") {
    const modelRef = `vibeforge-local/${model}`;
    const configContent = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: modelRef,
      small_model: modelRef,
      provider: {
        "vibeforge-local": {
          npm: "@ai-sdk/openai-compatible",
          name: "VibeForge Local",
          options: { baseURL: openAiBaseUrl(url), apiKey: "local" },
          models: { [model]: { name: model } },
        },
      },
    });
    return {
      engine,
      binPath: resolved.binPath,
      harness: "opencode",
      harnessRow: resolved.row,
      extraArgs: [],
      env: { OPENCODE_CONFIG_CONTENT: configContent },
      localModel: model,
    };
  }

  if (resolved.kind === "claude") {
    const claudeEnv = {
      ANTHROPIC_BASE_URL: anthropicBaseUrl(url),
      ANTHROPIC_AUTH_TOKEN: "local",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
    };
    return {
      engine,
      binPath: resolved.binPath,
      harness: "claude",
      harnessRow: resolved.row,
      extraArgs: ["--settings", JSON.stringify({ env: claudeEnv }), "--model", model],
      env: claudeEnv,
      localModel: model,
    };
  }

  // Codex: inline `-c` overrides targeting the OpenAI Responses wire API on the configured server.
  return {
    engine,
    binPath: resolved.binPath,
    harness: "codex",
    harnessRow: resolved.row,
    extraArgs: [
      "-c",
      'model_provider="vibeforge_local"',
      "-c",
      'model_providers.vibeforge_local.name="VibeForge Local"',
      "-c",
      `model_providers.vibeforge_local.base_url=${JSON.stringify(openAiBaseUrl(url))}`,
      "-c",
      'model_providers.vibeforge_local.wire_api="responses"',
      "-c",
      "model_providers.vibeforge_local.requires_openai_auth=false",
      "-m",
      model,
    ],
    env: {},
    localModel: model,
  };
}

export interface LocalHistoryStep {
  kind: string;
  action?: string;
  engineId?: string;
  workspaceId?: string;
  branch?: string;
  target?: string;
  prompt?: string;
  asked?: string;
}

export interface LocalHistoryTurn {
  from: "you" | "vibeforge";
  text: string;
  note?: unknown;
  problem?: unknown;
  steps?: ReadonlyArray<LocalHistoryStep>;
}

const MAX_LOCAL_HISTORY_TURNS = 12;

/** Assemble chat messages for stateless OpenAI-compatible Viby calls, keeping `rules` stable first. */
export function buildLocalBrainMessages(
  rules: string,
  history: readonly LocalHistoryTurn[],
  extraMessages: readonly LocalChatMessage[],
  userText: string,
  images: readonly LocalBrainImage[] = [],
): LocalChatMessage[] {
  const messages: LocalChatMessage[] = [{ role: "system", content: rules }];
  const recent = history
    .filter((turn) => !turn.note && !turn.problem && (turn.text.trim() || turn.steps?.length))
    .slice(-MAX_LOCAL_HISTORY_TURNS);

  for (const turn of recent) {
    if (turn.from === "you") {
      if (turn.text.trim()) messages.push({ role: "user", content: turn.text.trim() });
      continue;
    }
    const summarySteps = (turn.steps ?? []).map((step) => ({
      kind: step.kind,
      ...(step.action ? { action: step.action } : {}),
      ...(step.engineId ? { engine: step.engineId } : {}),
      ...(step.workspaceId ? { workspace: step.workspaceId } : {}),
      ...(step.branch ? { branch: step.branch } : {}),
      ...(step.target ? { target: step.target } : {}),
      ...(step.prompt ? { prompt: step.prompt.slice(0, 120) } : {}),
    }));
    messages.push({
      role: "assistant",
      content: JSON.stringify({ say: turn.text, steps: summarySteps }),
    });
  }

  for (const extra of extraMessages) messages.push(extra);

  if (images.length > 0) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: userText },
        ...images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        })),
      ],
    });
  } else {
    messages.push({ role: "user", content: userText });
  }
  return messages;
}

function stripMessageImages(messages: readonly LocalChatMessage[]): LocalChatMessage[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const text = msg.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return {
      role: msg.role,
      content: `${text}\n(Note: images could not be sent because this local model/server does not accept image inputs.)`.trim(),
    };
  });
}

function hasImages(messages: readonly LocalChatMessage[]): boolean {
  return messages.some((msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === "image_url"));
}

async function readSseContent(
  body: ReadableStream<Uint8Array>,
  onEarlySay?: (say: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let earlySaySent = false;
  let doneSeen = false;

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      doneSeen = true;
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const choices = Array.isArray(parsed.choices) ? (parsed.choices as Array<Record<string, unknown>>) : [];
    const delta = choices[0]?.delta && typeof choices[0].delta === "object" ? (choices[0].delta as Record<string, unknown>) : null;
    const msg = choices[0]?.message && typeof choices[0].message === "object" ? (choices[0].message as Record<string, unknown>) : null;
    const piece = typeof delta?.content === "string" ? delta.content : typeof msg?.content === "string" ? msg.content : "";
    if (!piece) return;
    content += piece;
    if (!earlySaySent && onEarlySay) {
      const early = readyEarlySay(content);
      if (early) {
        earlySaySent = true;
        onEarlySay(early);
      }
    }
  };

  try {
    while (!doneSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        processLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (doneSeen) break;
        nl = buf.indexOf("\n");
      }
    }
    if (!doneSeen) {
      buf += decoder.decode();
      if (buf.trim()) processLine(buf);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return content;
}

function isImageError(error: string): boolean {
  return /image|vision|multimodal|mmproj|content.*array|expected.*string/i.test(error);
}

function isFormatError(error: string): boolean {
  return /response_format|json_schema|json_object|grammar|structured|unsupported|invalid.*format/i.test(error);
}

function canFallbackStatus(status: number, error: string): boolean {
  if (status === 400 || status === 422) return true;
  return status === 500 && (isImageError(error) || isFormatError(error));
}

/**
 * Call an OpenAI-compatible local or home-network server directly for one Viby planning turn.
 * Requests `json_schema` output with automatic graceful fallback (`json_object` -> plain)
 * and strips reasoning `<think>` tags while streaming early `"say"` for voice calls.
 */
export async function runLocalBrain(req: LocalBrainRequest, fetchFn: typeof fetch = fetch): Promise<LocalBrainResult> {
  const endpoint = `${openAiBaseUrl(req.url)}/chat/completions`;
  if (!openAiBaseUrl(req.url)) {
    return { code: 1, stdout: "", stderr: "Local AI server address is not valid.", timedOut: false };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (req.signal.aborted) controller.abort();
  else req.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  timer.unref?.();

  const postTurn = async (
    messages: readonly LocalChatMessage[],
    formatMode: "json_schema" | "json_object" | "none",
  ): Promise<{ ok: boolean; status: number; content: string; error: string }> => {
    const payload: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      temperature: 0.2,
    };
    if (formatMode === "json_schema") {
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: "viby_plan", strict: false, schema: req.schema },
      };
    } else if (formatMode === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream, application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      let detail = errBody.trim();
      try {
        const parsed = JSON.parse(errBody) as { error?: { message?: unknown } | string; message?: unknown };
        if (typeof parsed.error === "string") detail = parsed.error;
        else if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") detail = parsed.error.message;
        else if (typeof parsed.message === "string") detail = parsed.message;
      } catch {
        /* keep raw body */
      }
      return { ok: false, status: res.status, content: "", error: detail ? `HTTP ${res.status}: ${detail.slice(0, 300)}` : `HTTP ${res.status}` };
    }

    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("text/event-stream") && res.body) {
      const content = await readSseContent(res.body, req.onEarlySay);
      return { ok: true, status: res.status, content, error: "" };
    }

    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
      const msgContent = parsed.choices?.[0]?.message?.content;
      const content =
        typeof msgContent === "string"
          ? msgContent
          : typeof parsed.choices?.[0]?.text === "string"
            ? (parsed.choices[0].text as string)
            : "";
      if (content && req.onEarlySay) {
        const early = readyEarlySay(content);
        if (early) req.onEarlySay(early);
      }
      return { ok: true, status: res.status, content, error: "" };
    } catch {
      return { ok: false, status: res.status, content: "", error: "Local server returned non-JSON response." };
    }
  };

  try {
    let activeMessages = req.messages;
    let attempt = await postTurn(activeMessages, "json_schema");
    if (!attempt.ok && canFallbackStatus(attempt.status, attempt.error)) {
      if (hasImages(activeMessages) && isImageError(attempt.error)) {
        activeMessages = stripMessageImages(activeMessages);
        attempt = await postTurn(activeMessages, "json_schema");
      }
      if (!attempt.ok && canFallbackStatus(attempt.status, attempt.error)) {
        attempt = await postTurn(activeMessages, "json_object");
      }
      if (!attempt.ok && canFallbackStatus(attempt.status, attempt.error)) {
        attempt = await postTurn(activeMessages, "none");
      }
    }
    if (!attempt.ok) {
      return { code: 1, stdout: "", stderr: attempt.error, timedOut: false };
    }
    const clean = stripThinkTags(attempt.content);
    return { code: 0, stdout: clean, stderr: "", timedOut: false };
  } catch (err) {
    if (timedOut) return { code: null, stdout: "", stderr: "Timed out waiting for local server.", timedOut: true };
    if (req.signal.aborted) return { code: null, stdout: "", stderr: "", timedOut: false };
    return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onParentAbort);
  }
}
