import type { LocalSettings } from "../core/types.js";

/** Virtual engine id for VibeForge's configured Local AI server. */
export const LOCAL_ENGINE_ID = "local";

/** Coding CLIs VibeForge knows how to aim at an OpenAI/Anthropic-compatible local server per spawn. */
export const LOCAL_HARNESSES = ["opencode", "claude", "codex"] as const;
export type ConcreteLocalHarness = (typeof LOCAL_HARNESSES)[number];

/** Environment variable names allowed in per-spawn PTY overrides (mirrors `electron/pty-host.cjs`). */
export const LOCAL_SPAWN_ENV_KEYS = [
  "OPENCODE_CONFIG_CONTENT",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export interface LocalPreset {
  id: "llamacpp" | "ollama" | "lmstudio";
  label: string;
  url: string;
}

export const LOCAL_PRESETS: readonly LocalPreset[] = [
  { id: "llamacpp", label: "llama.cpp", url: "http://127.0.0.1:8080" },
  { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434" },
  { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234" },
] as const;

export type LocalServerKind = "ollama" | "llamacpp" | "lmstudio" | "openai";

export interface LocalModelInfo {
  id: string;
  loaded?: boolean;
  contextLength?: number | null;
  sizeBytes?: number | null;
}

export interface LocalServerProbe {
  url: string;
  reachable: boolean;
  kind: LocalServerKind | null;
  isLoopback: boolean;
  models: LocalModelInfo[];
  contextLength: number | null;
  error: string | null;
}

export interface LocalRuntimeStatus {
  servers: LocalServerProbe[];
  configured: LocalServerProbe | null;
  binaries: {
    llamaServer: string | null;
    ollama: string | null;
    lms: string | null;
  };
  harnesses: Array<{
    id: ConcreteLocalHarness;
    label: string;
    available: boolean;
    path: string | null;
  }>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Normalize a user-typed local or home-network server address; returns "" when invalid. */
export function normalizeLocalUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || /[\r\n\0\s]/.test(trimmed)) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password || !parsed.hostname) return "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

/** OpenAI-compatible base URL ending in `/v1`. */
export function openAiBaseUrl(raw: string | undefined): string {
  const base = normalizeLocalUrl(raw);
  if (!base) return "";
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/** Anthropic-compatible root URL without trailing `/v1` (Anthropic clients append `/v1/messages`). */
export function anthropicBaseUrl(raw: string | undefined): string {
  const base = normalizeLocalUrl(raw);
  if (!base) return "";
  return base.replace(/\/v1$/i, "");
}

/** Whether a server URL targets this computer (`localhost` / `127.0.0.1` / `::1`). */
export function isLoopbackLocalUrl(raw: string | undefined): boolean {
  const base = normalizeLocalUrl(raw);
  if (!base) return false;
  try {
    const host = new URL(base).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
  } catch {
    return false;
  }
}

/** Sanitize a model id from a local server so it stays single-line and never becomes a CLI flag. */
export function cleanLocalModel(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length > 160 || /[\r\n\0]/.test(trimmed) || trimmed.startsWith("-")) return "";
  return trimmed;
}

/** Whether Local AI has a valid server address and selected model. */
export function isLocalConfigured(local: Pick<LocalSettings, "url" | "model">): boolean {
  return Boolean(normalizeLocalUrl(local.url) && cleanLocalModel(local.model));
}

/** Compact model label for UI pills and engine titles. */
export function shortLocalModel(model: string): string {
  const clean = cleanLocalModel(model);
  if (!clean) return "";
  const base = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
  const trimmed = base.replace(/\.gguf$/i, "");
  return trimmed.length > 28 ? `${trimmed.slice(0, 27)}…` : trimmed;
}
