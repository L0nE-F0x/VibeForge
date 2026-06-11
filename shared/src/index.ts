/* ============================================================================
 * @vibeforge/shared — the v3 contract.
 * Vibe Forge is a BYOK idea & spec studio: ideation + spec generation only.
 * Cloud providers are relayed through a serverless function; local models are
 * called directly from the browser.
 * ==========================================================================*/

export type ProviderId =
  | "anthropic" | "openai" | "gemini" | "xai" | "openrouter"
  | "ollama" | "lmstudio" | "custom";

/** How calls to this provider travel.
 *  proxy  — browser → /api/complete (serverless) → provider (cloud APIs)
 *  direct — browser → provider endpoint (local/self-hosted, user's own CORS) */
export type Transport = "proxy" | "direct";

export type Ambition = "S" | "M" | "L";
export type Depth = "S" | "M" | "L" | "mixed" | "game";

export const DEPTHS: { id: Depth; label: string; hint: string }[] = [
  { id: "mixed", label: "Mixed", hint: "let the model vary the scope" },
  { id: "S", label: "Focused tool", hint: "sharp, single-purpose utility" },
  { id: "M", label: "Real app", hint: "multi-feature, multiple views" },
  { id: "L", label: "Ambitious", hint: "deep, serious product" },
  { id: "game", label: "Games", hint: "graphics-rich browser games — Three.js, WebGL & custom shaders" },
];

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Short name for pills/chips. */
  short: string;
  transport: Transport;
  /** Seed models — shown as suggestions; the model field always accepts any id. */
  models: ModelInfo[];
  /** No API key required. */
  keyless?: boolean;
  /** Supports live-search grounding. */
  grounding?: boolean;
  /** Default endpoint for direct providers (editable in Settings). */
  defaultBaseUrl?: string;
  baseUrlEditable?: boolean;
  /** One-line setup hint shown in Settings. */
  hint?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic", label: "Anthropic (Claude)", short: "Claude", transport: "proxy", grounding: true,
    models: [
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
  {
    id: "openai", label: "OpenAI (GPT)", short: "GPT", transport: "proxy", grounding: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano" },
    ],
  },
  {
    id: "gemini", label: "Google (Gemini)", short: "Gemini", transport: "proxy", grounding: true,
    models: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
    ],
  },
  {
    id: "xai", label: "xAI (Grok)", short: "Grok", transport: "proxy", grounding: true,
    models: [
      { id: "grok-4.3", label: "Grok 4.3" },
      { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 (reasoning)" },
      { id: "grok-build-0.1", label: "Grok Build 0.1" },
    ],
  },
  {
    id: "openrouter", label: "OpenRouter (open-weight catalog)", short: "OpenRouter", transport: "proxy", grounding: true,
    hint: "One key, hundreds of models — any openrouter.ai model id works here.",
    models: [
      { id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "moonshotai/kimi-k2", label: "Kimi K2" },
    ],
  },
  {
    id: "ollama", label: "Ollama (local)", short: "Ollama", transport: "direct", keyless: true,
    defaultBaseUrl: "http://localhost:11434/v1", baseUrlEditable: true,
    hint: "Run `ollama serve` with OLLAMA_ORIGINS set to this site's origin (or *).",
    models: [{ id: "llama3.3", label: "llama3.3 (type any pulled model)" }],
  },
  {
    id: "lmstudio", label: "LM Studio (local)", short: "LM Studio", transport: "direct", keyless: true,
    defaultBaseUrl: "http://localhost:1234/v1", baseUrlEditable: true,
    hint: "Start the LM Studio local server and enable CORS in its server settings.",
    models: [{ id: "local-model", label: "(type the loaded model id)" }],
  },
  {
    id: "custom", label: "Custom (OpenAI-compatible)", short: "Custom", transport: "direct", keyless: true,
    defaultBaseUrl: "", baseUrlEditable: true,
    hint: "Any OpenAI-compatible endpoint: vLLM, LiteLLM, Groq, Together, your own proxy…",
    models: [{ id: "", label: "(type the model id)" }],
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

/** Providers the serverless relay will forward to (fixed canonical hosts — no open proxy). */
export const PROXY_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "gemini", "xai", "openrouter"]);

/* ---------------- pipeline state ---------------- */

export type Status = "idea" | "specing" | "spec" | "exported" | "error";

export interface Idea {
  title: string;
  pitch: string;
  tags: string[];
  lens: string;
  ambition: Ambition;
  /** Set to "game" when generated in Games depth — drives a game-flavored spec (Three.js/WebGL/shaders). */
  kind?: "app" | "game";
}

export interface Project extends Idea {
  id: string;
  slug: string;
  status: Status;
  spec: string;
  /** Previous spec kept for one-step undo after an AI refine. */
  prevSpec?: string;
  /** URLs surfaced by live-search grounding. */
  sources?: string[];
  providerUsed?: ProviderId;
  error?: string;
  statusMsg?: string;
  createdAt: number;
  updatedAt: number;
  exportedAt?: number;
}

export interface ProviderConfig {
  key: string;
  model: string;
  baseUrl?: string;
}

export interface Settings {
  providers: Record<ProviderId, ProviderConfig>;
  ideationProvider: ProviderId;
  specProvider: ProviderId;
  grounding: { ideation: boolean; spec: boolean };
  steer: string;
  batch: number;
  depth: Depth;
}

export function defaultSettings(): Settings {
  const providers = {} as Settings["providers"];
  for (const p of PROVIDERS) {
    providers[p.id] = { key: "", model: p.models[0]?.id ?? "", baseUrl: p.defaultBaseUrl };
  }
  return {
    providers,
    ideationProvider: "anthropic",
    specProvider: "anthropic",
    grounding: { ideation: true, spec: false },
    steer: "",
    batch: 4,
    depth: "M",
  };
}

/* ---------------- completion wire format ---------------- */

export interface CompleteRequest {
  provider: ProviderId;
  apiKey?: string;
  model: string;
  /** Honored only for direct (local/custom) providers; the relay enforces canonical hosts. */
  baseUrl?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Request provider-native live web search grounding. */
  search?: boolean;
}

export interface CompleteResponse {
  text: string;
  citations?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}
