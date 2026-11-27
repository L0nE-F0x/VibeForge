import type { EngineRow, LocalSettings, OrchestratorSettings, VibyRoute } from "../core/types.js";
import { plannerFor } from "./orchestrator.js";

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

// ------------------------------------------------------------------ Viby's own route

/** "cloud" or "local" when `value` names one; null otherwise. */
export function normalizeVibyRoute(value: unknown): VibyRoute | null {
  return value === "cloud" || value === "local" ? value : null;
}

/**
 * settings.json's `local.viby`, read from what is saved. Files from before it existed (3.12.0)
 * only had `useForViby`, which was set back to true on every switch to Local: so `false` there is
 * a choice someone made (Cloud), and Local is kept only for someone in Local mode right now, whose
 * Viby already planned locally. Everyone else starts on Cloud: a Viby planner, model and effort
 * picked in the Viby settings keep working when coding moves to Local.
 */
export function migrateVibyRoute(raw: { viby?: unknown; useForViby?: unknown; enabled?: unknown; active?: unknown } | null | undefined): VibyRoute {
  const saved = normalizeVibyRoute(raw?.viby);
  if (saved) return saved;
  if (raw?.useForViby === false) return "cloud";
  if (raw?.useForViby === true && raw.enabled === true && raw.active === true) return "local";
  return "cloud";
}

/** Local mode is on and sends Viby to the Local AI server too (it plans there once the server is ready). */
export function localModeRoutesViby(local: Pick<LocalSettings, "enabled" | "active" | "viby">): boolean {
  return local.enabled && local.active && local.viby === "local";
}

/** The local model Viby plans with: its own pick, or the coding model. */
export function vibyLocalModel(local: Pick<LocalSettings, "model" | "vibyModel">): string {
  return local.vibyModel || local.model;
}

type PlannerRow = Pick<EngineRow, "id" | "bin"> & { available: boolean };

/**
 * The planner Viby uses right now. Local mode with Viby set to Local plans on the Local AI server;
 * anything else is the planner from the Viby settings, untouched by Local mode (until one is picked,
 * the first one here that can plan, Local only when nothing else can). That planner may itself be
 * Local: that is how Viby plans locally while coding stays on the cloud.
 */
export function vibyPlanner(input: {
  local: Pick<LocalSettings, "enabled" | "active" | "viby">;
  localReady: boolean;
  picked: string;
  engines: readonly PlannerRow[];
}): string {
  const { local, localReady, picked } = input;
  if (localModeRoutesViby(local) && localReady) return LOCAL_ENGINE_ID;
  const rows: PlannerRow[] = input.engines.filter((row) => row.id !== LOCAL_ENGINE_ID);
  if (local.enabled) rows.push({ id: LOCAL_ENGINE_ID, bin: LOCAL_ENGINE_ID, available: localReady });
  return plannerFor(picked, rows);
}

/**
 * The settings change for picking `engineId` in a Viby planner picker. While Local mode is on,
 * Local only sends Viby to the server, so the planner, model and effort saved for Cloud stay as
 * they are, and any other planner sends Viby back to Cloud. With Local mode off it is the Viby
 * settings' planner (Local there keeps coding on the cloud). Picking the planner already saved
 * keeps its model and effort.
 */
export function vibyPlannerPatch(
  engineId: string,
  local: Pick<LocalSettings, "enabled" | "active" | "viby">,
  orchestrator: OrchestratorSettings,
): { orchestrator?: OrchestratorSettings; local?: { viby: VibyRoute } } {
  const localMode = local.enabled && local.active;
  if (localMode && engineId === LOCAL_ENGINE_ID) return local.viby === "local" ? {} : { local: { viby: "local" } };
  const nextOrchestrator = engineId === orchestrator.engine ? orchestrator : { ...orchestrator, engine: engineId, model: "", effort: "" };
  const patch: { orchestrator?: OrchestratorSettings; local?: { viby: VibyRoute } } =
    nextOrchestrator === orchestrator ? {} : { orchestrator: nextOrchestrator };
  if (localMode && local.viby !== "cloud") patch.local = { viby: "cloud" };
  return patch;
}
