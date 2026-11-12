import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_MESSAGES } from "../agent-talk.js";
import { defaultCompanion, normalizeCompanion } from "../companion.js";
import { ENGINE_SEED_REVISION, mergeEngineRows, normalizeEngineRows, seedEngines } from "../engines.js";
import { readJson, writeJson } from "../fsx.js";
import { isSafeId } from "../slug.js";
import { isThemeId } from "../theme.js";
import type { WorkspaceFile } from "../workspaces.js";
import type { EngineRow, LayoutNode, Settings, SoundSettings, VoiceSettings, Workspace } from "../types.js";
import { bool, str, strOrNull } from "./fields.js";
import type { ReadCache } from "./read-cache.js";

export function defaultSettings(): Settings {
  return {
    defaultEngine: "claude",
    defaultShell: process.env.SHELL || "/bin/bash",
    notify: true,
    terminalFontSize: 13,
    terminalFontFamily: "JetBrainsMono Nerd Font",
    theme: "omarchy",
    tourDone: false,
    checkUpdates: true,
    language: "system",
    voice: { model: "", language: "auto", talkBack: true, speaker: "", agent: "" },
    sounds: { on: true, volume: 0.6, voice: true, attention: true, finished: true, routines: false, inFront: false },
    tray: true,
    closeToTray: true,
    usage: true,
    planLimits: false,
    quotaAlerts: false,
    activity: "git",
    rail: { order: [], hidden: [] },
    keepRuns: { days: 0, maxMb: 0 },
    companion: defaultCompanion(),
    agentTalk: { on: true, maxMessages: DEFAULT_MAX_MESSAGES, reviewRounds: 1, lead: "", handOff: "ask", maxWorking: 3, maxHandOffs: 4, leadApplies: false },
    orchestrator: { engine: "", mode: "plan", model: "", projectsFolder: "" },
  };
}

/** A whole number from 0 to `max`; anything else is `fallback`. */
function count(value: unknown, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : fallback;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

/** Older settings said "summary", "full", or "off". Reading aloud is now on or off; on is the first paragraph. */
function talkBackFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "off") return false;
  if (value === "summary" || value === "full") return true;
  return fallback;
}

function normalizeSoundSettings(value: unknown, defaults: SoundSettings): SoundSettings {
  const raw = value && typeof value === "object" ? (value as Partial<SoundSettings>) : {};
  const volume = typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : defaults.volume;
  return {
    on: bool(raw.on, defaults.on),
    volume,
    voice: bool(raw.voice, defaults.voice),
    attention: bool(raw.attention, defaults.attention),
    finished: bool(raw.finished, defaults.finished),
    routines: bool(raw.routines, defaults.routines),
    inFront: bool(raw.inFront, defaults.inFront),
  };
}

function normalizeVoiceSettings(value: unknown, defaults: VoiceSettings): VoiceSettings {
  const raw = value && typeof value === "object" ? (value as Partial<VoiceSettings> & { talkBack?: unknown }) : {};
  return {
    model: str(raw.model).trim(),
    language: /^(auto|[a-z]{2,3})$/.test(str(raw.language)) ? str(raw.language) : defaults.language,
    talkBack: talkBackFlag(raw.talkBack, defaults.talkBack),
    speaker: str(raw.speaker).trim(),
    agent: str(raw.agent).trim(),
  };
}

function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  const folder = str(record.path);
  if (!isSafeId(id) || !folder) return null;
  return { id, name: str(record.name) || path.basename(folder) || id, path: folder, dockUrl: str(record.dockUrl) };
}

function isLayoutNode(value: unknown, depth = 0): value is LayoutNode {
  if (!value || typeof value !== "object" || depth > 12) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane") {
    const launch = node.launch as Record<string, unknown> | undefined;
    return typeof node.id === "string" && !!launch && (launch.type === "shell" || (launch.type === "engine" && typeof launch.engineId === "string"));
  }
  if (node.kind === "split") {
    return (
      (node.dir === "row" || node.dir === "col") &&
      typeof node.ratio === "number" &&
      isLayoutNode(node.a, depth + 1) &&
      isLayoutNode(node.b, depth + 1)
    );
  }
  return false;
}

/**
 * The JSON files in the config folder: settings.json (mode 0600), engines.json, workspaces.json and
 * one layouts/<workspace>.json per workspace. Settings and engines go through the read cache.
 */
export class Config {
  private readonly configRoot: string;
  private readonly cache: ReadCache;

  constructor(configRoot: string, cache: ReadCache) {
    this.configRoot = configRoot;
    this.cache = cache;
  }

  readSettings(): Settings {
    return this.cache.read(path.join(this.configRoot, "settings.json"), () => this.loadSettings());
  }

  private loadSettings(): Settings {
    const file = path.join(this.configRoot, "settings.json");
    const defaults = defaultSettings();
    const raw = readJson<Partial<Settings> | null>(file, null);
    if (!raw) {
      // Only a missing file is written. One that doesn't parse, say a hand edit half done, is left for its
      // author, and moved aside to settings.json.broken if the app saves settings before it is fixed.
      if (!fs.existsSync(file)) writeJson(file, defaults, { mode: 0o600 });
      return defaults;
    }
    return {
      defaultEngine: str(raw.defaultEngine) || defaults.defaultEngine,
      defaultShell: str(raw.defaultShell) || defaults.defaultShell,
      notify: bool(raw.notify, defaults.notify),
      terminalFontSize:
        typeof raw.terminalFontSize === "number" && raw.terminalFontSize >= 8 && raw.terminalFontSize <= 32
          ? raw.terminalFontSize
          : defaults.terminalFontSize,
      terminalFontFamily: str(raw.terminalFontFamily) || defaults.terminalFontFamily,
      // "builtin" was Apex Forge before any theme could be picked.
      theme: raw.theme === "builtin" ? "apex-forge" : isThemeId(str(raw.theme)) ? str(raw.theme) : defaults.theme,
      tourDone: bool(raw.tourDone, defaults.tourDone),
      checkUpdates: bool(raw.checkUpdates, defaults.checkUpdates),
      language: /^(system|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(str(raw.language)) ? str(raw.language) : defaults.language,
      voice: normalizeVoiceSettings(raw.voice, defaults.voice),
      sounds: normalizeSoundSettings(raw.sounds, defaults.sounds),
      tray: bool(raw.tray, defaults.tray),
      closeToTray: bool(raw.closeToTray, defaults.closeToTray),
      usage: bool(raw.usage, defaults.usage),
      planLimits: bool(raw.planLimits, defaults.planLimits),
      quotaAlerts: bool(raw.quotaAlerts, defaults.quotaAlerts),
      activity: raw.activity === "off" || raw.activity === "github" ? raw.activity : defaults.activity,
      rail: {
        order: names(raw.rail?.order),
        hidden: names(raw.rail?.hidden),
      },
      keepRuns: {
        days: count(raw.keepRuns?.days, 36500, defaults.keepRuns.days),
        maxMb: count(raw.keepRuns?.maxMb, 1_000_000, defaults.keepRuns.maxMb),
      },
      companion: normalizeCompanion(raw.companion),
      agentTalk: {
        on: bool(raw.agentTalk?.on, defaults.agentTalk.on),
        maxMessages: Math.max(1, count(raw.agentTalk?.maxMessages, 50, defaults.agentTalk.maxMessages)),
        reviewRounds: Math.max(1, count(raw.agentTalk?.reviewRounds, 5, defaults.agentTalk.reviewRounds)),
        lead: str(raw.agentTalk?.lead).trim(),
        handOff: raw.agentTalk?.handOff === "go" ? "go" : "ask",
        maxWorking: Math.max(1, count(raw.agentTalk?.maxWorking, 20, defaults.agentTalk.maxWorking)),
        maxHandOffs: Math.max(1, count(raw.agentTalk?.maxHandOffs, 50, defaults.agentTalk.maxHandOffs)),
        leadApplies: bool(raw.agentTalk?.leadApplies, defaults.agentTalk.leadApplies),
      },
      orchestrator: {
        engine: str(raw.orchestrator?.engine).trim() || defaults.orchestrator.engine,
        mode: raw.orchestrator?.mode === "go" ? "go" : "plan",
        model: str(raw.orchestrator?.model).trim().slice(0, 120),
        projectsFolder: str(raw.orchestrator?.projectsFolder).trim().slice(0, 500),
      },
    };
  }

  writeSettings(settings: Settings): void {
    writeJson(path.join(this.configRoot, "settings.json"), settings, { mode: 0o600 });
    this.cache.forget(path.join(this.configRoot, "settings.json"));
  }

  readEngineRows(): EngineRow[] {
    return this.cache.read(path.join(this.configRoot, "engines.json"), () => this.loadEngineRows());
  }

  private loadEngineRows(): EngineRow[] {
    const file = path.join(this.configRoot, "engines.json");
    const raw = readJson<{ engines?: unknown; seedRevision?: unknown } | unknown[] | null>(file, null);
    if (!raw) {
      // As with settings.json, only a missing file is written. One that doesn't parse, say a hand edit half done, is
      // left for its author, and moved aside to engines.json.broken if the app saves engines before it is fixed.
      const seeded = seedEngines();
      if (!fs.existsSync(file)) writeJson(file, { engines: seeded, seedRevision: ENGINE_SEED_REVISION });
      return seeded;
    }
    const saved = normalizeEngineRows(raw);
    const revision = raw && !Array.isArray(raw) && typeof raw.seedRevision === "number" ? raw.seedRevision : 1;
    const merged = mergeEngineRows(saved, revision);
    if (merged.changed) writeJson(file, { engines: merged.rows, seedRevision: merged.revision });
    return merged.rows;
  }

  writeEngineRows(rows: EngineRow[]): void {
    const file = path.join(this.configRoot, "engines.json");
    const raw = readJson<{ seedRevision?: unknown }>(file, {});
    const revision = typeof raw.seedRevision === "number" ? raw.seedRevision : ENGINE_SEED_REVISION;
    writeJson(file, { engines: normalizeEngineRows(rows), seedRevision: revision });
    this.cache.forget(file);
  }

  readWorkspaces(): WorkspaceFile {
    const raw = readJson<unknown>(path.join(this.configRoot, "workspaces.json"), null);
    const list = Array.isArray(raw) ? raw : (raw as { workspaces?: unknown } | null)?.workspaces;
    const workspaces = Array.isArray(list)
      ? list.map(normalizeWorkspace).filter((item): item is Workspace => item !== null)
      : [];
    const last = strOrNull((raw as { lastWorkspaceId?: unknown } | null)?.lastWorkspaceId);
    return { workspaces, lastWorkspaceId: last && workspaces.some((item) => item.id === last) ? last : (workspaces[0]?.id ?? null) };
  }

  writeWorkspaces(file: WorkspaceFile): void {
    writeJson(path.join(this.configRoot, "workspaces.json"), file);
  }

  readLayout(workspaceId: string): LayoutNode | null {
    if (!isSafeId(workspaceId)) return null;
    const raw = readJson<unknown>(path.join(this.configRoot, "layouts", `${workspaceId}.json`), null);
    return isLayoutNode(raw) ? raw : null;
  }

  writeLayout(workspaceId: string, layout: LayoutNode | null): void {
    if (!isSafeId(workspaceId)) return;
    const file = path.join(this.configRoot, "layouts", `${workspaceId}.json`);
    if (!layout) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (!isLayoutNode(layout)) throw new Error("Layout is not valid");
    writeJson(file, layout);
  }
}
