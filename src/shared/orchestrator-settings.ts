// Viby's awareness of its own settings and VibeForge's configuration, plus parsing and validation
// for `settings` steps so Viby can read and change any VibeForge setting on the person's behalf.
// Pure and Node-free so the main process, the desktop plan card, and the phone view share one check.

import type { EngineRow, OrchestratorMode } from "../core/types.js";
import { cleanModel, effortLevels } from "./launch-options.js";
import { describeComputerGrants, type ComputerUseGrants } from "./computer-use.js";
import { parseOptions } from "./orchestrator-actions.js";
import { cleanQuery, fuzzyMatchName } from "./orchestrator-fuzzy.js";
import { splitArgs } from "./text.js";
import { MODEL_CATALOG, VOICE_CATALOG, type ModelChoice, type VoiceBackend, type VoiceChoice } from "./voice-catalog.js";

export interface PlanSettingsContext {
  viby: {
    /** Active planning CLI id (resolved via plannerFor). */
    planner: string;
    /** Explicit planner id in settings ("" when automatic). */
    pickedEngine: string;
    mode: OrchestratorMode;
    /** Whether spoken/status replies stay terse on auto-running steps. */
    terse?: boolean;
    model: string;
    /** Explicit reasoning effort in settings ("" when using the fast "low" default). */
    effort: string;
    projectsFolder: string;
    /** What the person lets Viby see and do on the screen (Settings → Computer use). */
    computer?: ComputerUseGrants;
    availablePlanners: Array<{
      id: string;
      label: string;
      available: boolean;
      models: string[];
      efforts: string[];
    }>;
  };
  local?: {
    enabled: boolean;
    active: boolean;
    overrideAgents: boolean;
    url: string;
    model: string;
    vibyModel: string;
    harness: string;
  };
  voice: {
    ready: boolean;
    activeModel: string;
    pickedModel: string;
    installedModels: Array<{ name: string; path: string; backend: VoiceBackend; englishOnly: boolean }>;
    runtimes: {
      whisperServer: boolean;
      whisperCli: boolean;
      sherpa: boolean;
      recorder: string | null;
      piper: boolean;
    };
    language: string;
    talkBack: boolean;
    talkOver: "auto" | "always" | "never";
    activeSpeaker: string;
    pickedSpeaker: string;
    installedVoices: Array<{ name: string; path: string }>;
    mouseButton: string;
    sendButton: string;
    agent: string;
  };
  app: {
    defaultEngine: string;
    defaultShell: string;
    theme: string;
    availableThemes?: string[];
    language: string;
    terminalFontSize: number;
    terminalFontFamily: string;
    notify: boolean;
    sounds: {
      on: boolean;
      volume: number;
      voice: boolean;
      attention: boolean;
      finished: boolean;
      routines: boolean;
      inFront: boolean;
    };
    tray: boolean;
    closeToTray: boolean;
    autostart?: boolean;
    usage: boolean;
    planLimits: boolean;
    quotaAlerts: boolean;
    activity: "off" | "git" | "github";
    checkUpdates: boolean;
    companion: { enabled: boolean; port: number };
    sync: { enabled: boolean; name: string };
    agentTalk: {
      on: boolean;
      lead: string;
      handOff: "ask" | "go";
      reviewRounds: number;
      maxMessages: number;
      maxWorking: number;
      maxHandOffs: number;
      leadApplies: boolean;
    };
    keepRuns: { days: number; maxMb: number };
    terminalPassthrough?: boolean;
  };
}

/** Whether an `inspect` step asks for Viby / VibeForge settings, voice status, available models, or themes. */
export function inspectsSettings(text: string | undefined): boolean {
  return /\b(?:settings?|preferences?|config(?:uration)?|viby[- ]?(?:settings?|config|model|planner|effort)|voice(?:\s+(?:settings?|models?|status|catalog))?|stt|speech[- ]to[- ]text|themes?)\b/i.test(
    (text ?? "").trim(),
  );
}

function modelLanguageTag(choice: ModelChoice): string {
  if (choice.englishOnly) return "EN";
  if (choice.languages && choice.languages.length <= 6) return choice.languages.map((c) => c.toUpperCase()).join("/");
  if (choice.note === "parakeet") return "25 European langs";
  return "multilingual";
}

/** Renders the current Viby, Voice/STT, and VibeForge settings block for `orchestratorRules`. */
export function formatSettingsRules(settings: PlanSettingsContext, options?: { slim?: boolean }): string[] {
  const { viby, voice, app, local } = settings;
  const slim = Boolean(options?.slim);
  const planners = viby.availablePlanners
    .filter((item) => item.available)
    .map((item) => {
      const details = [
        item.models.length ? `models: ${item.models.slice(0, 8).join(", ")}` : "",
        item.efforts.length ? `effort: ${item.efforts.join(", ")}` : "",
      ].filter(Boolean);
      return `${item.id} (${item.label}${details.length ? `; ${details.join("; ")}` : ""})`;
    })
    .join(", ");

  const installedModelSet = new Set(voice.installedModels.map((item) => item.name));
  const catalogList = MODEL_CATALOG.map((choice) => {
    const mark = installedModelSet.has(choice.file) ? " [installed]" : "";
    return slim ? `${choice.id}${mark}` : `${choice.id}${mark} (${choice.mb}MB, ${choice.backend}, ${modelLanguageTag(choice)})`;
  }).join(", ");
  const installedModels = voice.installedModels.length ? voice.installedModels.map((item) => item.name).join(", ") : "none";
  const runtimes = [
    voice.runtimes.whisperServer ? "whisper-server" : voice.runtimes.whisperCli ? "whisper-cli" : "",
    voice.runtimes.sherpa ? "sherpa-onnx" : "",
    voice.runtimes.piper ? "piper" : "",
  ]
    .filter(Boolean)
    .join(", ") || "none";

  const installedVoiceSet = new Set(voice.installedVoices.map((item) => item.name));
  const voiceCatalogList = VOICE_CATALOG.map((v) => {
    const mark = installedVoiceSet.has(v.id) ? " [installed]" : "";
    return slim ? `${v.id}${mark}` : `${v.id}${mark} (${v.language})`;
  }).join(", ");
  const installedVoices = voice.installedVoices.length ? voice.installedVoices.map((item) => item.name).join(", ") : "none";
  const themeLimit = slim ? 8 : 20;

  const approvalLabel = viby.mode === "plan" ? "ask-all" : viby.mode === "never" ? "never-ask" : "ask-risky";

  return [
    `- Viby (you): planner=${viby.planner || "none"}${viby.pickedEngine ? "" : " (auto)"}, model=${viby.model || "default"}, effort=${viby.effort || "low (default)"}, mode=${viby.mode} (${approvalLabel}), terse=${viby.terse === false ? "off" : "on"}, projectsFolder=${viby.projectsFolder || "~/Projects"}; available planners: ${planners || "none"}`,
    `- Voice & STT: ${voice.ready ? "ready" : "not ready"}, activeModel=${voice.activeModel || "none"} (setting: ${voice.pickedModel || "auto"}, language=${voice.language}, runtimes: ${runtimes}); installed STT models: [${installedModels}]; downloadable STT catalog: [${catalogList}]`,
    `- Viby's voice & controls: talkBack=${voice.talkBack ? "on" : "off"}, talkOver=${voice.talkOver}, speaker=${voice.activeSpeaker || "none"} (installed voices: [${installedVoices}]; downloadable voices: [${voiceCatalogList}]), mouseButton=${voice.mouseButton}, sendButton=${voice.sendButton}`,
    `- App settings: defaultEngine=${app.defaultEngine || "none"}, shell=${app.defaultShell}, theme=${app.theme}${app.availableThemes?.length ? ` (themes: ${app.availableThemes.slice(0, themeLimit).join(", ")})` : ""}, language=${app.language}, font="${app.terminalFontFamily}" ${app.terminalFontSize}px${app.terminalPassthrough ? ", terminalPassthrough=on" : ""}, notify=${app.notify ? "on" : "off"}, sounds=${app.sounds.on ? `on (${Math.round(app.sounds.volume * 100)}%)` : "off"}, tray=${app.tray ? "on" : "off"} (closeToTray=${app.closeToTray ? "on" : "off"}${app.autostart !== undefined ? `, autostart=${app.autostart ? "on" : "off"}` : ""}), usage=${app.usage ? "on" : "off"}, planLimits=${app.planLimits ? "on" : "off"}, quotaAlerts=${app.quotaAlerts ? "on" : "off"}, activity=${app.activity}, checkUpdates=${app.checkUpdates ? "on" : "off"}, agentTalk=${app.agentTalk.on ? `on (handOff=${app.agentTalk.handOff}, lead=${app.agentTalk.lead || "none"})` : "off"}, phone=${app.companion.enabled ? "on" : "off"}, sync=${app.sync.enabled ? "on" : "off"}, keepRuns=${app.keepRuns.days || "forever"}d/${app.keepRuns.maxMb || "unlimited"}MB`,
    ...(local
      ? [
          `- Local AI: ${local.enabled ? (local.active ? "on (Local mode active)" : "enabled (currently in Cloud mode)") : "disabled"}, url=${local.url || "unset"}, model=${local.model || "unset"}${local.vibyModel ? `, vibyModel=${local.vibyModel}` : ""}, harness=${local.harness}, overrideAgents=${local.overrideAgents ? "on" : "off"}`,
        ]
      : []),
    `- ${describeComputerGrants(viby.computer)}`,
    ...(slim ? ['  (Use an `inspect` step with prompt "settings" or "voice" for full model/voice sizes, languages, and themes.)'] : []),
  ];
}

/** Compact fingerprint of settings so a resumed planning session notices changes made between turns. */
export function settingsFingerprint(settings: PlanSettingsContext | undefined): string {
  if (!settings) return "";
  const { viby, voice, app } = settings;
  return JSON.stringify([
    viby.planner,
    viby.mode,
    viby.terse !== false,
    viby.model,
    viby.effort,
    viby.projectsFolder,
    viby.computer ?? null,
    voice.ready,
    voice.activeModel,
    voice.pickedModel,
    voice.installedModels.map((m) => m.name),
    voice.language,
    voice.talkBack,
    voice.talkOver,
    voice.activeSpeaker,
    app.defaultEngine,
    app.theme,
    app.language,
    app.terminalFontSize,
    app.terminalFontFamily,
    app.notify,
    app.sounds.on,
    app.sounds.volume,
    app.tray,
    app.closeToTray,
    app.autostart,
    app.usage,
    app.planLimits,
    app.quotaAlerts,
    app.activity,
    app.checkUpdates,
    app.companion.enabled,
    app.sync.enabled,
    app.agentTalk.on,
    app.agentTalk.handOff,
    app.agentTalk.lead,
    settings.local ?? null,
  ]);
}

// ------------------------------------------------------------------ parsing & validation

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const SPOKEN_LANGS: Record<string, string> = {
  auto: "auto",
  detect: "auto",
  automatic: "auto",
  system: "system",
  english: "en",
  en: "en",
  german: "de",
  deutsch: "de",
  de: "de",
  spanish: "es",
  espanol: "es",
  es: "es",
  french: "fr",
  francais: "fr",
  fr: "fr",
  japanese: "ja",
  ja: "ja",
  portuguese: "pt",
  portugues: "pt",
  pt: "pt",
  chinese: "zh",
  mandarin: "zh",
  zh: "zh",
  italian: "it",
  it: "it",
  dutch: "nl",
  nl: "nl",
  polish: "pl",
  pl: "pl",
  russian: "ru",
  ru: "ru",
  ukrainian: "uk",
  uk: "uk",
  swedish: "sv",
  sv: "sv",
};

function parseBool(raw: string): boolean | null {
  const clean = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:on|true|yes|1|enable|enabled|turn on)$/.test(clean)) return true;
  if (/^(?:off|false|no|0|disable|disabled|turn off)$/.test(clean)) return false;
  return null;
}

/** The languages the window comes in: `LANGUAGES` in src/ui/i18n/index.ts (a test keeps the two alike). */
export const APP_LANGUAGES: readonly string[] = ["en", "de", "es", "fr", "pt", "ja", "zh"];

function isResetWord(raw: string): boolean {
  return /^(?:auto|automatic|default|reset|clear|best|none)$/.test(raw.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** Matches a spoken or typed STT model name against MODEL_CATALOG. */
export function matchCatalogModel(query: string): ModelChoice | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const wanted = squash(trimmed.replace(/^ggml-|\.bin$/gi, ""));
  if (!wanted) return null;

  for (const choice of MODEL_CATALOG) {
    const fileStem = choice.file.replace(/^ggml-|\.bin$/gi, "");
    if (
      choice.id.toLowerCase() === trimmed.toLowerCase() ||
      choice.file.toLowerCase() === trimmed.toLowerCase() ||
      squash(choice.id) === wanted ||
      squash(fileStem) === wanted ||
      squash(choice.id.replace(/-int8$/i, "")) === wanted
    ) {
      return choice;
    }
  }

  // Natural spoken aliases ("parakeet", "parakeet v3", "parakeet v2", "canary", "moonshine", "distil", "turbo").
  const lower = trimmed.toLowerCase();
  if (/\bparakeet\b/.test(lower)) {
    const v2 = /\bv2\b|\benglish\b/.test(lower) && !/\bv3\b/.test(lower);
    return MODEL_CATALOG.find((c) => c.id === (v2 ? "parakeet-tdt-0.6b-v2-int8" : "parakeet-tdt-0.6b-v3-int8")) ?? null;
  }
  if (/\bcanary\b/.test(lower)) return MODEL_CATALOG.find((c) => c.id === "canary-180m-flash-int8") ?? null;
  if (/\bmoonshine\b/.test(lower)) {
    const tiny = /\btiny\b/.test(lower);
    return MODEL_CATALOG.find((c) => c.id === (tiny ? "moonshine-tiny-en-int8" : "moonshine-base-en-int8")) ?? null;
  }
  if (/\bdistil\b/.test(lower)) return MODEL_CATALOG.find((c) => c.id === "distil-small.en") ?? null;
  if (/\bturbo\b|\blarge[- ]?v3\b/.test(lower)) return MODEL_CATALOG.find((c) => c.id === "large-v3-turbo-q5_0") ?? null;
  if (/\bsmall[.\s-]*en\b.*\bq5\b|\bq5\b.*\bsmall[.\s-]*en\b/.test(lower)) return MODEL_CATALOG.find((c) => c.id === "small.en-q5_1") ?? null;
  if (/\bsmall\b.*\bq5\b|\bq5\b.*\bsmall\b/.test(lower)) return MODEL_CATALOG.find((c) => c.id === "small-q5_1") ?? null;

  const partial = MODEL_CATALOG.filter((choice) => squash(choice.id).includes(wanted) || wanted.includes(squash(choice.id)));
  return partial.length === 1 ? partial[0] : null;
}

/** Matches a spoken or typed Piper voice name against VOICE_CATALOG. */
export function matchCatalogVoice(query: string): VoiceChoice | null {
  const trimmed = query.trim().replace(/\.onnx$/i, "");
  if (!trimmed) return null;
  const wanted = squash(trimmed);
  for (const choice of VOICE_CATALOG) {
    if (choice.id.toLowerCase() === trimmed.toLowerCase() || squash(choice.id) === wanted) return choice;
  }
  const partial = VOICE_CATALOG.filter((choice) => squash(choice.id).includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

export type SettingsAction =
  | {
      op: "viby";
      engine?: string;
      model?: string;
      effort?: string;
      mode?: OrchestratorMode;
      terse?: boolean;
      projectsFolder?: string;
      summary: string;
    }
  | {
      op: "voice-model";
      /** `""` resets to automatic best-installed selection. */
      model: string;
      /** Catalog id to download automatically when not yet on disk. */
      downloadId?: string;
      summary: string;
    }
  | {
      op: "voice-download";
      kind: "model" | "voice" | "sherpa";
      id: string;
      summary: string;
    }
  | {
      op: "voice-speaker";
      speaker: string;
      downloadId?: string;
      summary: string;
    }
  | {
      op: "voice-patch";
      patch: Partial<{
        language: string;
        talkBack: boolean;
        talkOver: "auto" | "always" | "never";
        mouseButton: "off" | "back" | "forward" | "middle";
        sendButton: "off" | "pointer" | "always";
        agent: string;
      }>;
      summary: string;
    }
  | {
      op: "voice-stop-download";
      summary: string;
    }
  | {
      op: "rail";
      mode: "hide" | "show" | "order";
      views: string[];
      summary: string;
    }
  | {
      op: "engines-recheck";
      summary: string;
    }
  | {
      op: "engine-save";
      row: EngineRow;
      summary: string;
    }
  | {
      op: "engine-remove";
      id: string;
      summary: string;
    }
  | {
      op: "app-patch";
      patch: Record<string, unknown>;
      autostart?: boolean;
      /** Turning on a networked service (planLimits, companion, sync) waits for Go in a voice call. */
      networkOn?: boolean;
      summary: string;
    };

export interface SettingsStepInput {
  target?: string;
  prompt?: string;
  engine?: string;
  engineId?: string;
  model?: string;
  effort?: string;
  folder?: string;
  branch?: string;
  name?: string;
  options?: string;
}

export interface SettingsValidationContext {
  engines: ReadonlyArray<{ id: string; label: string; available: boolean; bin?: string }>;
  agents?: ReadonlyArray<{ id: string; name: string }>;
  settings?: PlanSettingsContext;
}

function matchEngine(query: string, engines: SettingsValidationContext["engines"]): SettingsValidationContext["engines"][number] | null {
  const cleaned = cleanQuery(query);
  const wanted = squash(cleaned);
  if (!wanted) return null;
  return (
    engines.find((e) => squash(e.id) === wanted || squash(e.label) === wanted) ??
    engines.find((e) => squash(e.label).startsWith(wanted) || squash(e.id).startsWith(wanted)) ??
    fuzzyMatchName(cleaned, engines, (e) => [e.id, e.label], true) ??
    null
  );
}

function isPlannerRow(row: Pick<EngineRow, "id" | "bin">): boolean {
  if (row.id === "local") return true;
  const name = `${row.id} ${(row.bin ?? "").split("/").pop() ?? ""}`.toLowerCase();
  return /\b(?:grok|claude|codex|agy)\b|antigravity/.test(name);
}

function parseApprovalMode(raw: string, allowAmbiguous = false): OrchestratorMode | null {
  const clean = raw.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  if (/^(?:plan|show|show me first|ask|ask all|ask always|ask for everything|ask before everything|everything|always ask|review|wait)$/.test(clean)) {
    return "plan";
  }
  if (
    /^(?:go|just go|risky|ask risky|ask only for risky|ask only for risky actions|ask for risky|ask for risky actions|ask for risky only|risky only|only risky|balanced|normal)$/.test(
      clean,
    ) ||
    (allowAmbiguous && clean === "default")
  ) {
    return "go";
  }
  if (
    /^(?:never|never ask|never ask for approval|always|always go|all|no ask|no approval|no confirmations?|immediate|immediately|full auto|autonomous)$/.test(
      clean,
    ) ||
    (allowAmbiguous && clean === "auto")
  ) {
    return "never";
  }
  return null;
}

function parseTerseFlag(raw: string): boolean | null {
  const b = parseBool(raw);
  if (b !== null) return b;
  const clean = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:terse|brief|short|concise|quiet|compact)$/.test(clean)) return true;
  if (/^(?:verbose|full|detailed|chatty|long|normal)$/.test(clean)) return false;
  return null;
}

/**
 * Parses a `settings` step into a concrete `SettingsAction`, or returns `{ issue, asked }` when
 * something named by the step is unknown or unsupported.
 */
export function resolveSettingsStep(
  input: SettingsStepInput,
  context: SettingsValidationContext,
): { action: SettingsAction; issue: null; asked: string } | { action: null; issue: "engine" | "engineMissing" | "effort" | "folder" | "prompt"; asked: string } {
  const rawTarget = (input.target ?? "").trim();
  const key = squash(rawTarget);
  const value = (input.prompt ?? "").trim();
  const engineArg = (input.engineId || input.engine || "").trim();
  const modelArg = (input.model ?? "").trim();
  const effortArg = (input.effort ?? "").trim().toLowerCase();
  const folderArg = (input.folder ?? "").trim();
  const opts = parseOptions(input.options);

  // 1. Viby / Orchestrator self-configuration
  const isVibyRoot =
    (!key && Boolean(engineArg || modelArg || effortArg)) ||
    /^(?:viby|vibey|maestro|orchestrator|self|planner)$/.test(key);
  const isVibySub =
    /^(?:viby|vibey|maestro|orchestrator)(?:engine|planner|cli|model|effort|reasoningeffort|mode|approval|approvals|approvalmode|terse|tersereplies|concise|projectsfolder|projects|folder)$/.test(
      key,
    ) || /^(?:approval|approvals|approvalmode|terse|tersereplies)$/.test(key);

  if (isVibyRoot || isVibySub) {
    let engine: string | undefined;
    let model: string | undefined;
    let effort: string | undefined;
    let mode: OrchestratorMode | undefined;
    let terse: boolean | undefined;
    let projectsFolder: string | undefined;

    if (key.endsWith("engine") || key.endsWith("planner") || key.endsWith("cli") || (key === "planner" && value)) {
      const askedEngine = engineArg || value;
      if (!askedEngine) return { action: null, issue: "engine", asked: rawTarget || "planner" };
      if (isResetWord(askedEngine)) {
        engine = "";
        model = "";
        effort = "";
      } else {
        const matched = matchEngine(askedEngine, context.engines);
        if (!matched || !isPlannerRow({ id: matched.id, bin: matched.bin ?? matched.id })) {
          return { action: null, issue: "engine", asked: askedEngine };
        }
        if (!matched.available) return { action: null, issue: "engineMissing", asked: matched.label };
        engine = matched.id;
      }
      if (modelArg) model = isResetWord(modelArg) ? "" : cleanModel(modelArg);
      if (effortArg) effort = isResetWord(effortArg) ? "" : effortArg;
    } else if (key.endsWith("model")) {
      const askedModel = modelArg || value;
      if (!askedModel) return { action: null, issue: "prompt", asked: "Viby model" };
      if (isResetWord(askedModel)) model = "";
      else {
        const cleaned = cleanModel(askedModel);
        if (!cleaned) return { action: null, issue: "prompt", asked: askedModel };
        model = cleaned;
      }
    } else if (key.endsWith("effort") || key.endsWith("reasoningeffort")) {
      const askedEffort = (effortArg || value).toLowerCase();
      if (!askedEffort) return { action: null, issue: "effort", asked: "Viby effort" };
      effort = isResetWord(askedEffort) ? "" : askedEffort;
    } else if (key.endsWith("mode") || key.endsWith("approval") || key.endsWith("approvals") || key.endsWith("approvalmode")) {
      const parsedMode = parseApprovalMode(value, true);
      if (!parsedMode) return { action: null, issue: "prompt", asked: value || "Viby mode" };
      mode = parsedMode;
    } else if (key.endsWith("terse") || key.endsWith("tersereplies") || key.endsWith("concise")) {
      const parsedTerse = parseTerseFlag(value);
      if (parsedTerse === null) return { action: null, issue: "prompt", asked: value || "Viby terse replies" };
      terse = parsedTerse;
    } else if (key.endsWith("projectsfolder") || key.endsWith("projects") || key.endsWith("folder")) {
      const askedFolder = folderArg || value;
      if (!askedFolder) return { action: null, issue: "folder", asked: "projects folder" };
      if (isResetWord(askedFolder)) projectsFolder = "";
      else if ((askedFolder.startsWith("/") || askedFolder.startsWith("~/")) && !askedFolder.split("/").includes("..")) projectsFolder = askedFolder;
      else return { action: null, issue: "folder", asked: askedFolder };
    } else {
      // Root `target: "viby"` with one or more fields
      const optMode = opts.str("mode") ?? opts.str("approval");
      if (optMode) {
        const parsedMode = parseApprovalMode(optMode, true);
        if (!parsedMode) return { action: null, issue: "prompt", asked: optMode };
        mode = parsedMode;
      }
      const optTerse = opts.str("terse");
      if (optTerse !== undefined) {
        const parsedTerse = parseTerseFlag(optTerse);
        if (parsedTerse === null) return { action: null, issue: "prompt", asked: optTerse };
        terse = parsedTerse;
      }
      if (engineArg) {
        if (isResetWord(engineArg)) {
          engine = "";
        } else {
          const matched = matchEngine(engineArg, context.engines);
          if (!matched || !isPlannerRow({ id: matched.id, bin: matched.bin ?? matched.id })) {
            return { action: null, issue: "engine", asked: engineArg };
          }
          if (!matched.available) return { action: null, issue: "engineMissing", asked: matched.label };
          engine = matched.id;
        }
      }
      if (modelArg) {
        if (isResetWord(modelArg)) model = "";
        else {
          const cleaned = cleanModel(modelArg);
          if (!cleaned) return { action: null, issue: "prompt", asked: modelArg };
          model = cleaned;
        }
      }
      if (effortArg) {
        effort = isResetWord(effortArg) ? "" : effortArg;
      }
      if (folderArg) {
        if (isResetWord(folderArg)) projectsFolder = "";
        else if ((folderArg.startsWith("/") || folderArg.startsWith("~/")) && !folderArg.split("/").includes("..")) projectsFolder = folderArg;
        else return { action: null, issue: "folder", asked: folderArg };
      }
      if (value) {
        const lower = value.toLowerCase();
        const maybeMode = parseApprovalMode(value);
        if (maybeMode && mode === undefined) mode = maybeMode;
        else if (!engineArg && !modelArg && !effortArg) {
          const maybeEngine = matchEngine(value, context.engines);
          if (maybeEngine && isPlannerRow({ id: maybeEngine.id, bin: maybeEngine.bin ?? maybeEngine.id })) {
            if (!maybeEngine.available) return { action: null, issue: "engineMissing", asked: maybeEngine.label };
            engine = maybeEngine.id;
          } else if (isResetWord(value)) {
            // "default" is the model going back to the CLI's own, not a model called "default".
            model = "";
          } else if (/^(?:none|minimal|low|medium|high|xhigh|max)$/.test(lower)) {
            // An effort level said on its own ("medium") is the effort, not a model of that name,
            // which every later planning turn would fail on.
            effort = lower;
          } else {
            const cleaned = cleanModel(value);
            if (cleaned) model = cleaned;
            else return { action: null, issue: "prompt", asked: value };
          }
        }
      }
    }

    if (effort) {
      const targetEngineId = engine ?? context.settings?.viby.planner ?? "";
      const row = context.engines.find((e) => e.id === targetEngineId);
      if (row?.bin !== undefined) {
        const levels = effortLevels({ id: row.id, bin: row.bin });
        if (levels.length && !levels.includes(effort)) {
          return { action: null, issue: "effort", asked: effort };
        }
      } else if (!/^(?:none|minimal|low|medium|high|xhigh|max)$/.test(effort)) {
        return { action: null, issue: "effort", asked: effort };
      }
    }

    if (engine === undefined && model === undefined && effort === undefined && mode === undefined && terse === undefined && projectsFolder === undefined) {
      return { action: null, issue: "prompt", asked: "Viby settings" };
    }

    const parts: string[] = [];
    if (engine !== undefined) parts.push(engine ? (context.engines.find((e) => e.id === engine)?.label ?? engine) : "auto planner");
    if (model !== undefined) parts.push(model || "default model");
    if (effort !== undefined) parts.push(effort ? `${effort} effort` : "default effort");
    if (mode !== undefined) parts.push(`approval: ${mode === "plan" ? "ask for everything" : mode === "never" ? "never ask" : "ask only for risky"}`);
    if (terse !== undefined) parts.push(`terse replies: ${terse ? "on" : "off"}`);
    if (projectsFolder !== undefined) parts.push(`folder: ${projectsFolder || "auto"}`);
    const summary = `Viby · ${parts.join(" · ")}`;
    return { action: { op: "viby", engine, model, effort, mode, terse, projectsFolder, summary }, issue: null, asked: summary };
  }

  // 2. Voice & STT model selection / download
  if (/^(?:voicemodel|stt|sttmodel|speechmodel|speechtotext|speechtotextmodel|dictationmodel|whispermodel)$/.test(key)) {
    const wanted = value || modelArg;
    if (!wanted) return { action: null, issue: "prompt", asked: "voice model" };
    if (isResetWord(wanted)) {
      const summary = "Voice model · auto (best installed)";
      return { action: { op: "voice-model", model: "", summary }, issue: null, asked: summary };
    }
    const installed = context.settings?.voice.installedModels ?? [];
    const directInstalled = installed.find(
      (item) =>
        item.path === wanted ||
        item.name.toLowerCase() === wanted.toLowerCase() ||
        squash(item.name.replace(/^ggml-|\.bin$/gi, "")) === squash(wanted.replace(/^ggml-|\.bin$/gi, "")),
    );
    if (directInstalled) {
      const summary = `Voice model · ${directInstalled.name}`;
      return { action: { op: "voice-model", model: directInstalled.path, summary }, issue: null, asked: summary };
    }
    const choice = matchCatalogModel(wanted);
    if (choice) {
      const onDisk = installed.find((item) => item.name === choice.file);
      const summary = onDisk ? `Voice model · ${choice.id}` : `Voice model · ${choice.id} (download & select)`;
      return {
        action: { op: "voice-model", model: onDisk?.path ?? choice.file, ...(onDisk ? {} : { downloadId: choice.id }), summary },
        issue: null,
        asked: summary,
      };
    }
    if (wanted.startsWith("/") && /\.bin$/i.test(wanted)) {
      const name = wanted.split("/").pop() ?? wanted;
      const summary = `Voice model · ${name}`;
      return { action: { op: "voice-model", model: wanted, summary }, issue: null, asked: summary };
    }
    return { action: null, issue: "prompt", asked: wanted };
  }

  if (/^(?:voicedownload|sttdownload|downloadmodel|downloadvoice|sherpa|sherpaonnx)$/.test(key)) {
    const wanted = value || modelArg || rawTarget;
    if (/^(?:sherpa|sherpaonnx|runtime)$/.test(squash(wanted))) {
      const summary = "Download · sherpa-onnx runtime";
      return { action: { op: "voice-download", kind: "sherpa", id: "runtime", summary }, issue: null, asked: summary };
    }
    const modelChoice = matchCatalogModel(wanted);
    if (modelChoice) {
      const summary = `Download STT model · ${modelChoice.id}`;
      return { action: { op: "voice-download", kind: "model", id: modelChoice.id, summary }, issue: null, asked: summary };
    }
    const voiceChoice = matchCatalogVoice(wanted);
    if (voiceChoice) {
      const summary = `Download voice · ${voiceChoice.id}`;
      return { action: { op: "voice-download", kind: "voice", id: voiceChoice.id, summary }, issue: null, asked: summary };
    }
    return { action: null, issue: "prompt", asked: wanted || "voice download" };
  }

  if (/^(?:voicespeaker|voicevoice|vibyspeaker|speaker|ttsvoice|tts|pipervoice)$/.test(key) || (key === "vibyvoice" && parseBool(value) === null)) {
    const wanted = value || modelArg;
    if (!wanted) return { action: null, issue: "prompt", asked: "Viby voice" };
    if (isResetWord(wanted)) {
      const summary = "Viby voice · auto";
      return { action: { op: "voice-speaker", speaker: "", summary }, issue: null, asked: summary };
    }
    const installed = context.settings?.voice.installedVoices ?? [];
    const direct = installed.find((item) => item.path === wanted || squash(item.name) === squash(wanted.replace(/\.onnx$/i, "")));
    if (direct) {
      const summary = `Viby voice · ${direct.name}`;
      return { action: { op: "voice-speaker", speaker: direct.path, summary }, issue: null, asked: summary };
    }
    const choice = matchCatalogVoice(wanted);
    if (choice) {
      const onDisk = installed.find((item) => item.name === choice.id);
      const summary = onDisk ? `Viby voice · ${choice.id}` : `Viby voice · ${choice.id} (download & select)`;
      return {
        action: { op: "voice-speaker", speaker: onDisk?.path ?? `${choice.id}.onnx`, ...(onDisk ? {} : { downloadId: choice.id }), summary },
        issue: null,
        asked: summary,
      };
    }
    return { action: null, issue: "prompt", asked: wanted };
  }

  if (/^(?:voicelanguage|dictationlanguage|spokenlanguage|sttlanguage)$/.test(key)) {
    const mapped = SPOKEN_LANGS[squash(value)] ?? (/^[a-z]{2,3}$/.test(value.toLowerCase()) ? value.toLowerCase() : "");
    if (!mapped || mapped === "system") {
      const code = mapped === "system" ? "auto" : "";
      if (!code) return { action: null, issue: "prompt", asked: value || "voice language" };
      const summary = `Voice language · ${code}`;
      return { action: { op: "voice-patch", patch: { language: code }, summary }, issue: null, asked: summary };
    }
    const summary = `Voice language · ${mapped}`;
    return { action: { op: "voice-patch", patch: { language: mapped }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voicetalkback|vibytalkback|vibyvoice|talkback|readaloud|readanswersaloud)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "talkBack" };
    const summary = `Viby spoken replies · ${flag ? "on" : "off"}`;
    return { action: { op: "voice-patch", patch: { talkBack: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voicetalkover|talkover|bargein)$/.test(key)) {
    const clean = squash(value);
    const talkOver =
      clean === "auto" || clean === "echo" ? "auto" : clean === "always" || clean === "headphones" || clean === "on" ? "always" : clean === "never" || clean === "off" ? "never" : null;
    if (!talkOver) return { action: null, issue: "prompt", asked: value || "talkOver" };
    const summary = `Talk over Viby · ${talkOver}`;
    return { action: { op: "voice-patch", patch: { talkOver }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voicemousebutton|mousebutton)$/.test(key)) {
    const clean = squash(value);
    const btn = clean === "off" || clean === "none" ? "off" : clean === "back" || clean === "forward" || clean === "middle" ? clean : null;
    if (!btn) return { action: null, issue: "prompt", asked: value || "mouse button" };
    const summary = `Dictate mouse button · ${btn}`;
    return { action: { op: "voice-patch", patch: { mouseButton: btn }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voicesendbutton|sendbutton)$/.test(key)) {
    const clean = squash(value);
    const sendButton =
      clean === "off" || clean === "never" ? "off" : clean === "always" || clean === "on" ? "always" : clean === "pointer" || clean === "auto" || clean === "mouse" ? "pointer" : null;
    if (!sendButton) return { action: null, issue: "prompt", asked: value || "send button" };
    const summary = `Dictation Send button · ${sendButton}`;
    return { action: { op: "voice-patch", patch: { sendButton }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voiceagent|desktopagent)$/.test(key)) {
    if (!value || isResetWord(value) || squash(value) === "last") {
      const summary = "Desktop voice key · last agent";
      return { action: { op: "voice-patch", patch: { agent: "" }, summary }, issue: null, asked: summary };
    }
    const agents = context.agents ?? [];
    const matched = agents.find((a) => squash(a.id) === squash(value) || squash(a.name) === squash(value));
    if (!matched && agents.length > 0) return { action: null, issue: "engine", asked: value };
    const agentId = matched?.id ?? value;
    const summary = `Desktop voice key · ${matched?.name ?? agentId}`;
    return { action: { op: "voice-patch", patch: { agent: agentId }, summary }, issue: null, asked: summary };
  }

  // 3. General VibeForge settings
  if (/^(?:defaultengine|defaultcli)$/.test(key)) {
    const asked = engineArg || value;
    const matched = matchEngine(asked, context.engines);
    if (!matched) return { action: null, issue: "engine", asked: asked || "default CLI" };
    if (!matched.available) return { action: null, issue: "engineMissing", asked: matched.label };
    const summary = `Default CLI · ${matched.label}`;
    return { action: { op: "app-patch", patch: { defaultEngine: matched.id }, summary }, issue: null, asked: summary };
  }

  if (/^(?:defaultshell|shell)$/.test(key)) {
    const shell = (folderArg || value).trim();
    if (!shell || /\s/.test(shell)) return { action: null, issue: "prompt", asked: shell || "shell" };
    const summary = `Default shell · ${shell}`;
    return { action: { op: "app-patch", patch: { defaultShell: shell }, summary }, issue: null, asked: summary };
  }

  if (/^(?:theme|colour|colours|color|colors|appearance)$/.test(key)) {
    if (!value) return { action: null, issue: "prompt", asked: "theme" };
    const clean = value.trim().toLowerCase().replace(/\s+/g, "-");
    const theme = /^(?:omarchy|follow-omarchy|auto|system|desktop)$/.test(clean) ? "omarchy" : clean;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(theme)) return { action: null, issue: "prompt", asked: value };
    const known = context.settings?.app.availableThemes;
    if (known?.length && theme !== "omarchy" && !known.includes(theme)) {
      const fuzzy = known.find((id) => squash(id) === squash(theme));
      if (!fuzzy) return { action: null, issue: "prompt", asked: value };
      const summary = `Theme · ${fuzzy}`;
      return { action: { op: "app-patch", patch: { theme: fuzzy }, summary }, issue: null, asked: summary };
    }
    const summary = `Theme · ${theme}`;
    return { action: { op: "app-patch", patch: { theme }, summary }, issue: null, asked: summary };
  }

  if (/^(?:language|applanguage|uilanguage)$/.test(key)) {
    const clean = squash(value);
    const lang = clean === "auto" || clean === "system" || clean === "desktop" ? "system" : SPOKEN_LANGS[clean] ?? (/^[a-z]{2,3}$/.test(value.toLowerCase()) ? value.toLowerCase() : "");
    // Only a language the window has (Italian would show English, with nothing picked in Settings).
    if (!lang || lang === "auto" || (lang !== "system" && !APP_LANGUAGES.includes(lang))) return { action: null, issue: "prompt", asked: value || "language" };
    const summary = `App language · ${lang}`;
    return { action: { op: "app-patch", patch: { language: lang }, summary }, issue: null, asked: summary };
  }

  if (/^(?:terminalfontsize|fontsize)$/.test(key)) {
    const num = Number(value.replace(/px$/i, "").trim());
    if (!Number.isFinite(num) || num < 8 || num > 32) return { action: null, issue: "prompt", asked: value || "font size (8–32)" };
    const size = Math.round(num);
    const summary = `Terminal font size · ${size}px`;
    return { action: { op: "app-patch", patch: { terminalFontSize: size }, summary }, issue: null, asked: summary };
  }

  if (/^(?:terminalfontfamily|fontfamily|terminalfont|font)$/.test(key)) {
    if (!value || value.length > 100) return { action: null, issue: "prompt", asked: value || "terminal font" };
    const summary = `Terminal font · ${value}`;
    return { action: { op: "app-patch", patch: { terminalFontFamily: value }, summary }, issue: null, asked: summary };
  }

  if (/^(?:notify|notifications)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "notifications" };
    const summary = `Notifications · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { notify: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:sounds|sound|soundson)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "sounds" };
    const summary = `Sounds · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { sounds: { on: flag } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:soundsvolume|soundvolume|volume)$/.test(key)) {
    const clean = value.trim().toLowerCase();
    let volume: number | null = null;
    if (clean === "soft" || clean === "low" || clean === "quiet") volume = 0.3;
    else if (clean === "medium" || clean === "normal") volume = 0.6;
    else if (clean === "loud" || clean === "high" || clean === "max" || clean === "full") volume = 1;
    else {
      const pct = clean.endsWith("%");
      const raw = Number(clean.replace(/%$/, "").trim());
      if (Number.isFinite(raw) && raw >= 0 && raw <= 100) {
        volume = pct || raw > 1 ? raw / 100 : raw;
      }
    }
    if (volume === null) return { action: null, issue: "prompt", asked: value || "volume" };
    const rounded = Math.round(volume * 100) / 100;
    const summary = `Sound volume · ${Math.round(rounded * 100)}%`;
    return { action: { op: "app-patch", patch: { sounds: { volume: rounded } }, summary }, issue: null, asked: summary };
  }

  const soundFlagMatch = /^sounds(voice|attention|finished|routines|infront)$/.exec(key);
  if (soundFlagMatch) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || rawTarget };
    const field = soundFlagMatch[1] === "infront" ? "inFront" : soundFlagMatch[1];
    const summary = `Sound (${field}) · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { sounds: { [field]: flag } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:tray|showtray)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "tray" };
    const summary = `Tray icon · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { tray: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:closetotray|keeprunningintray)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "closeToTray" };
    const summary = `Close to tray · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { closeToTray: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:autostart|startatlogin|login)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "autostart" };
    const summary = `Start at login · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: {}, autostart: flag, summary }, issue: null, asked: summary };
  }

  if (/^(?:usage|tokenusage)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "usage" };
    const summary = `Local token usage · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { usage: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:planlimits|limits|quotas)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "planLimits" };
    const summary = `Plan limits · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { planLimits: flag }, networkOn: flag, summary }, issue: null, asked: summary };
  }

  if (/^(?:quotaalerts|planalerts)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "quotaAlerts" };
    const summary = `Plan limit alerts · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { quotaAlerts: flag }, summary }, issue: null, asked: summary };
  }

  if (/^(?:activity|activitygraph|contributions)$/.test(key)) {
    const clean = squash(value);
    const activity = clean === "off" || clean === "none" ? "off" : clean === "git" || clean === "local" ? "git" : clean === "github" || clean === "gh" ? "github" : null;
    if (!activity) return { action: null, issue: "prompt", asked: value || "activity" };
    const summary = `Home activity graph · ${activity}`;
    return { action: { op: "app-patch", patch: { activity }, networkOn: activity === "github", summary }, issue: null, asked: summary };
  }

  if (/^(?:checkupdates|updates|autoupdates)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "checkUpdates" };
    const summary = `Check for updates · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { checkUpdates: flag }, networkOn: flag, summary }, issue: null, asked: summary };
  }

  if (/^(?:agenttalk|agenttalkon)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "agentTalk" };
    const summary = `Agent messaging · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { agentTalk: { on: flag } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:agenttalklead|lead)$/.test(key)) {
    const asked = engineArg || value;
    if (!asked || isResetWord(asked)) {
      const summary = "Lead CLI in Code · none";
      return { action: { op: "app-patch", patch: { agentTalk: { lead: "" } }, summary }, issue: null, asked: summary };
    }
    const matched = matchEngine(asked, context.engines);
    if (!matched) return { action: null, issue: "engine", asked };
    if (!matched.available) return { action: null, issue: "engineMissing", asked: matched.label };
    const summary = `Lead CLI in Code · ${matched.label}`;
    return { action: { op: "app-patch", patch: { agentTalk: { lead: matched.id } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:agenttalkhandoff|handoff)$/.test(key)) {
    const clean = squash(value);
    const handOff = clean === "go" || clean === "auto" ? "go" : clean === "ask" || clean === "wait" ? "ask" : null;
    if (!handOff) return { action: null, issue: "prompt", asked: value || "handOff" };
    const summary = `Handing out work · ${handOff}`;
    return { action: { op: "app-patch", patch: { agentTalk: { handOff } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:agenttalkleadapplies|leadapplies)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "leadApplies" };
    const summary = `Lead applies changes · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { agentTalk: { leadApplies: flag } }, summary }, issue: null, asked: summary };
  }

  const talkCountMatch = /^agenttalk(maxmessages|reviewrounds|maxworking|maxhandoffs)$/.exec(key);
  if (talkCountMatch) {
    const num = Math.round(Number(value));
    const fieldMap: Record<string, { field: string; max: number }> = {
      maxmessages: { field: "maxMessages", max: 50 },
      reviewrounds: { field: "reviewRounds", max: 5 },
      maxworking: { field: "maxWorking", max: 20 },
      maxhandoffs: { field: "maxHandOffs", max: 50 },
    };
    const spec = fieldMap[talkCountMatch[1]];
    if (!Number.isFinite(num) || num < 1 || num > spec.max) return { action: null, issue: "prompt", asked: value || rawTarget };
    const summary = `Agent talk (${spec.field}) · ${num}`;
    return { action: { op: "app-patch", patch: { agentTalk: { [spec.field]: num } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:companion|phone|phonepage|companionenabled)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "phone page" };
    const summary = `Phone page · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { companion: { enabled: flag } }, networkOn: flag, summary }, issue: null, asked: summary };
  }

  if (/^(?:sync|syncenabled)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "sync" };
    const summary = `Workspace sync · ${flag ? "on" : "off"}`;
    return { action: { op: "app-patch", patch: { sync: { enabled: flag } }, networkOn: flag, summary }, issue: null, asked: summary };
  }

  if (/^(?:local|localai|localmode|uselocal)$/.test(key)) {
    const flag = parseBool(value);
    if (flag === null) return { action: null, issue: "prompt", asked: value || "local" };
    const summary = `Local AI mode · ${flag ? "on" : "off"}`;
    return {
      action: {
        op: "app-patch",
        patch: { local: flag ? { enabled: true, active: true, useForViby: true } : { active: false } },
        ...(flag ? { networkOn: true } : {}),
        summary,
      },
      issue: null,
      asked: summary,
    };
  }

  if (/^(?:syncname|machinename)$/.test(key)) {
    const name = value.replace(/\s+/g, " ").trim().slice(0, 40);
    const summary = `Sync machine name · ${name || "hostname"}`;
    return { action: { op: "app-patch", patch: { sync: { name } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:keeprunsdays|rundays)$/.test(key)) {
    // Nothing said is not 0 (Number("") is): 0 would keep runs forever.
    const num = !value ? Number.NaN : /^(?:0|forever|always|all|unlimited)$/i.test(value) ? 0 : Math.round(Number(value));
    if (!Number.isFinite(num) || num < 0 || num > 36500) return { action: null, issue: "prompt", asked: value || "keepRuns.days" };
    const summary = `Keep runs · ${num === 0 ? "forever" : `${num} days`}`;
    return { action: { op: "app-patch", patch: { keepRuns: { days: num } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:keeprunsmaxmb|runmaxmb|storagecap)$/.test(key)) {
    const num = !value ? Number.NaN : /^(?:0|none|unlimited|forever)$/i.test(value) ? 0 : Math.round(Number(value));
    if (!Number.isFinite(num) || num < 0 || num > 1_000_000) return { action: null, issue: "prompt", asked: value || "keepRuns.maxMb" };
    const summary = `Run storage cap · ${num === 0 ? "unlimited" : `${num} MB`}`;
    return { action: { op: "app-patch", patch: { keepRuns: { maxMb: num } }, summary }, issue: null, asked: summary };
  }

  if (/^(?:voicestopdownload|stopdownload|canceldownload)$/.test(key)) {
    const summary = "Voice download · cancel";
    return { action: { op: "voice-stop-download", summary }, issue: null, asked: summary };
  }

  if (/^(?:companionnudges|phonenudges|nudges)$/.test(key)) {
    const nudges = value
      .split(/[\n;|]+|,\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!nudges.length && !isResetWord(value)) return { action: null, issue: "prompt", asked: value || "companion.nudges" };
    const finalNudges = isResetWord(value) ? [] : nudges;
    const summary = finalNudges.length ? `Phone nudges · ${finalNudges.length}` : "Phone nudges · cleared";
    return { action: { op: "app-patch", patch: { companion: { nudges: finalNudges } }, summary }, issue: null, asked: summary };
  }

  const railViews = ["home", "agents", "code", "chat", "tasks", "routines", "skills", "runs", "orchestrator"] as const;
  const parseRailView = (raw: string): string | null => {
    const k = squash(raw);
    if (k === "viby" || k === "vibey" || k === "maestro") return "orchestrator";
    return railViews.find((v) => v === k) ?? null;
  };

  if (/^(?:railhide|hiderail|hideview)$/.test(key)) {
    const views = value
      .split(/[\s,;]+/)
      .map(parseRailView)
      .filter((v): v is string => Boolean(v));
    if (!views.length || views.includes("code")) return { action: null, issue: "prompt", asked: value || "rail.hide" };
    const summary = `Hide rail · ${views.join(", ")}`;
    return { action: { op: "rail", mode: "hide", views, summary }, issue: null, asked: summary };
  }

  if (/^(?:railshow|showrail|showview)$/.test(key)) {
    const views = value
      .split(/[\s,;]+/)
      .map(parseRailView)
      .filter((v): v is string => Boolean(v));
    if (!views.length) return { action: null, issue: "prompt", asked: value || "rail.show" };
    const summary = `Show rail · ${views.join(", ")}`;
    return { action: { op: "rail", mode: "show", views, summary }, issue: null, asked: summary };
  }

  if (/^(?:railorder|orderrail|reorderrail)$/.test(key)) {
    const views = [
      ...new Set(
        value
          .split(/[\s,;]+/)
          .map(parseRailView)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    if (!views.length) return { action: null, issue: "prompt", asked: value || "rail.order" };
    const summary = `Rail order · ${views.join(", ")}`;
    return { action: { op: "rail", mode: "order", views, summary }, issue: null, asked: summary };
  }

  if (/^(?:enginesrecheck|recheckengines|recheckclis|refreshclis)$/.test(key)) {
    const summary = "Coding CLIs · recheck PATH";
    return { action: { op: "engines-recheck", summary }, issue: null, asked: summary };
  }

  if (/^(?:enginesadd|addengine|enginesedit|editengine|enginessave|saveengine|addcli|editcli)$/.test(key)) {
    const opts = parseOptions(input.options);
    const idRaw = (engineArg || opts.str("id") || input.name || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const bin = (folderArg || opts.str("bin") || opts.str("binary") || "").trim();
    const label = (input.name || opts.str("label") || idRaw).trim();
    const args = splitArgs(opts.str("args") ?? value);
    const promptArgs = splitArgs(opts.str("promptArgs") ?? opts.str("prompt") ?? "");
    const continueArgs = splitArgs(opts.str("continueArgs") ?? opts.str("continue") ?? "");
    if (!idRaw || !bin || /\s/.test(bin)) return { action: null, issue: "prompt", asked: idRaw || bin || "engine" };
    if (promptArgs.length > 0 && !promptArgs.some((arg) => arg.includes("{prompt}"))) {
      return { action: null, issue: "prompt", asked: "promptArgs must include {prompt}" };
    }
    const row: EngineRow = {
      id: idRaw,
      label: label || idRaw,
      bin,
      args,
      ...(promptArgs.length ? { promptArgs } : {}),
      ...(continueArgs.length ? { continueArgs } : {}),
    };
    const summary = `CLI · ${row.label} (${row.bin})`;
    return { action: { op: "engine-save", row, summary }, issue: null, asked: summary };
  }

  if (/^(?:enginesremove|removeengine|enginesdelete|deleteengine|removecli|deletecli)$/.test(key)) {
    const asked = engineArg || value || (input.name ?? "").trim();
    const matched = matchEngine(asked, context.engines);
    if (!matched) return { action: null, issue: "engine", asked: asked || "engine" };
    const summary = `Remove CLI · ${matched.label}`;
    return { action: { op: "engine-remove", id: matched.id, summary }, issue: null, asked: summary };
  }

  return { action: null, issue: "prompt", asked: rawTarget || value || "setting" };
}
