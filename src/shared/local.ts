import type { EngineRow, LocalServerLaunch, LocalServerSettings, LocalSettings, OrchestratorSettings, VibyRoute } from "../core/types.js";
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

// ------------------------------------------------------------------ running a server from VibeForge

/** Where each kind VibeForge starts answers unless the server address names another port on this computer. */
export const LOCAL_SERVER_PORTS: Record<LocalServerLaunch, number> = {
  llamacpp: 8080,
  ollama: 11434,
  lmstudio: 1234,
  command: 8080,
};

export const LOCAL_SERVER_KINDS: readonly LocalServerLaunch[] = ["llamacpp", "ollama", "lmstudio", "command"] as const;

export function defaultLocalServer(): LocalServerSettings {
  return { kind: "", program: "", models: "", presets: "", extraArgs: "", command: "", withLocalMode: false };
}

/** One line of at most `max` characters, or "". */
function oneLine(value: unknown, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return !s || s.length > max || /[\r\n\0]/.test(s) ? "" : s;
}

/** settings.json's `local.server`, whatever was saved there. */
export function normalizeLocalServer(raw: Partial<LocalServerSettings> | null | undefined): LocalServerSettings {
  const value = raw && typeof raw === "object" ? raw : {};
  const kind = LOCAL_SERVER_KINDS.includes(value.kind as LocalServerLaunch) ? (value.kind as LocalServerLaunch) : "";
  return {
    kind,
    program: oneLine(value.program, 1000),
    models: oneLine(value.models, 1000),
    presets: oneLine(value.presets, 1000),
    extraArgs: oneLine(value.extraArgs, 2000),
    command: oneLine(value.command, 2000),
    withLocalMode: value.withLocalMode === true,
  };
}

/**
 * A line of options split the way a shell would split it into words, honouring '…', "…" and
 * backslashes, with nothing expanded. Null when a quote is left open.
 */
export function splitArgs(line: string): string[] | null {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) word += line[++i];
      else word += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\" && i + 1 < line.length) word += line[++i];
    else word += ch;
  }
  if (quote) return null;
  if (inWord) out.push(word);
  return out;
}

/** `~` and `~/…` as the home folder; anything else as typed. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${value.slice(2)}`;
  return value;
}

/** A word as a shell would need it typed, for showing a command line. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** What starting a server runs, worked out from the settings. */
export interface LocalServerPlan {
  kind: LocalServerLaunch;
  bin: string;
  args: string[];
  /** Added to VibeForge's own environment for it. */
  env: Record<string, string>;
  /** Where it answers once started. */
  url: string;
  /** The start command ends once the server runs on its own (LM Studio's `lms server start`). */
  oneShot: boolean;
  /** What stops it, when ending the process VibeForge started is not how. */
  stop: { bin: string; args: string[] } | null;
  /** The command line, for the card. */
  shown: string;
}

/** Why a server can't be started from these settings. */
export type LocalServerProblem = "noKind" | "noProgram" | "noModels" | "noCommand" | "badArgs";

/**
 * The command VibeForge runs to start the server Settings describe, bound to this computer only
 * (127.0.0.1) unless the extra options say otherwise. The port comes from the server address when
 * that names this computer and a port, and is otherwise the kind's usual one.
 */
export function localServerPlan(
  server: LocalServerSettings,
  url: string,
  resolveBin: (bin: string) => string | null,
  home: string,
): { plan: LocalServerPlan; problem: null } | { plan: null; problem: LocalServerProblem } {
  const kind = server.kind;
  if (!kind) return { plan: null, problem: "noKind" };
  const base = normalizeLocalUrl(url);
  let port = LOCAL_SERVER_PORTS[kind];
  if (base && isLoopbackLocalUrl(base)) {
    const named = Number(new URL(base).port);
    if (Number.isInteger(named) && named > 0) port = named;
  }
  const at = kind === "command" && base && isLoopbackLocalUrl(base) ? base : `http://127.0.0.1:${port}`;
  const done = (plan: Omit<LocalServerPlan, "kind" | "url" | "shown"> & { shown?: string }) => ({
    plan: { kind, url: at, shown: plan.shown ?? [plan.bin, ...plan.args].map(shellWord).join(" "), ...plan },
    problem: null,
  });

  if (kind === "command") {
    const command = server.command.trim();
    if (!command) return { plan: null, problem: "noCommand" };
    return done({ bin: "/bin/sh", args: ["-c", command], env: {}, oneShot: false, stop: null, shown: command });
  }
  if (kind === "ollama") {
    const bin = resolveBin("ollama");
    if (!bin) return { plan: null, problem: "noProgram" };
    return done({ bin, args: ["serve"], env: { OLLAMA_HOST: `127.0.0.1:${port}` }, oneShot: false, stop: null, shown: `OLLAMA_HOST=127.0.0.1:${port} ${shellWord(bin)} serve` });
  }
  if (kind === "lmstudio") {
    const bin = resolveBin("lms") ?? resolveBin(`${home.replace(/\/+$/, "")}/.lmstudio/bin/lms`);
    if (!bin) return { plan: null, problem: "noProgram" };
    return done({ bin, args: ["server", "start", "--port", String(port)], env: {}, oneShot: true, stop: { bin, args: ["server", "stop"] } });
  }

  const program = server.program ? expandHome(server.program, home) : "";
  const bin = resolveBin(program || "llama-server");
  if (!bin) return { plan: null, problem: "noProgram" };
  const models = expandHome(server.models, home);
  if (!models) return { plan: null, problem: "noModels" };
  const extra = splitArgs(server.extraArgs);
  if (!extra) return { plan: null, problem: "badArgs" };
  const presets = server.presets ? expandHome(server.presets, home) : "";
  const modelArgs = /\.gguf$/i.test(models)
    ? ["-m", models]
    : ["--models-dir", models, ...(presets ? ["--models-preset", presets] : []), "--models-max", "1"];
  return done({ bin, args: [...modelArgs, "--host", "127.0.0.1", "--port", String(port), ...extra], env: {}, oneShot: false, stop: null });
}

export type LocalServerStatus = "stopped" | "starting" | "running" | "stopping" | "failed";

/** The server VibeForge started (or last tried to), for Settings and the Cloud / Local switch. */
export interface LocalServerState {
  status: LocalServerStatus;
  /** Where it answers (or will). */
  url: string | null;
  /** The command it ran. */
  shown: string | null;
  pid: number | null;
  /** When it started, ISO. */
  since: string | null;
  /** Why it is not running: a problem with the settings, or what went wrong running it. */
  problem: LocalServerProblem | "busy" | "exited" | "timeout" | "spawn" | null;
  /** The exit code or the error's words, with `problem`. */
  detail: string | null;
  /** The last lines it printed. */
  log: string[];
}

/** The Run a server card: what VibeForge would run now, and how the last start went. */
export interface LocalServerView {
  state: LocalServerState;
  plan: LocalServerPlan | null;
  problem: LocalServerProblem | null;
  /** What could be started here, to suggest a kind. */
  found: Record<Exclude<LocalServerLaunch, "command">, boolean>;
}

/**
 * Whether Local mode wants the server VibeForge starts: Local AI on and in Local mode, or on with
 * Viby planning on Local by its own choice (which needs the server in Cloud mode too).
 */
export function localServerWanted(local: Pick<LocalSettings, "enabled" | "active">, vibyPlansLocal: boolean): boolean {
  return local.enabled && (local.active || vibyPlansLocal);
}
