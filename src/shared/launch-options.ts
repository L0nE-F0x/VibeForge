// The model and reasoning effort a coding CLI starts with, for the CLIs that take them on their
// command line. Shared, so the window and the phone offer only levels a CLI accepts. No Node here.

import type { EngineRow } from "../core/types.js";

/** The CLIs whose model and effort options VibeForge knows. */
export type LaunchKind = "claude" | "grok" | "codex" | "agy" | "copilot" | "muse" | "pi" | "kimi" | "cursor";

interface LaunchFlags {
  model: (model: string) => string[];
  /** Absent: the CLI has no effort option of its own. */
  effort?: (effort: string) => string[];
  efforts: readonly string[];
}

/**
 * Each CLI's options, from its own `--help` (checked 2026-11-12): Claude Code 2.1, Grok Build 1.0.77,
 * Codex 0.167, Antigravity CLI, Copilot CLI, Muse, Pi, Kimi Code and Cursor Agent. Cursor Agent puts
 * effort inside the model name ("…[effort=high]"), so it gets a model only.
 */
const FLAGS: Record<LaunchKind, LaunchFlags> = {
  claude: { model: (model) => ["--model", model], effort: (effort) => ["--effort", effort], efforts: ["low", "medium", "high", "xhigh", "max"] },
  grok: { model: (model) => ["-m", model], effort: (effort) => ["--reasoning-effort", effort], efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  // -c takes TOML, and a JSON string is a TOML basic string.
  codex: { model: (model) => ["-m", model], effort: (effort) => ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`], efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  agy: { model: (model) => ["--model", model], effort: (effort) => ["--effort", effort], efforts: ["low", "medium", "high", "xhigh", "max"] },
  copilot: { model: (model) => ["--model", model], effort: (effort) => ["--reasoning-effort", effort], efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  muse: { model: (model) => ["--model", model], effort: (effort) => ["--reasoning-effort", effort], efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
  pi: { model: (model) => ["--model", model], effort: (effort) => ["--thinking", effort], efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  kimi: { model: (model) => ["-m", model], efforts: [] },
  cursor: { model: (model) => ["--model", model], efforts: [] },
};

/** Which CLI a row is, by its id and its binary's name, the way instructionArgs tells them apart. */
export function launchKind(row: Pick<EngineRow, "id" | "bin">): LaunchKind | null {
  const name = `${row.id} ${row.bin.split("/").pop() ?? row.bin}`.toLowerCase();
  // Before the others: "cursor-agent" also holds "agent".
  if (/\bcursor\b/.test(name)) return "cursor";
  if (/\bclaude\b/.test(name)) return "claude";
  if (/\bgrok\b/.test(name)) return "grok";
  if (/\bcodex\b/.test(name)) return "codex";
  if (/\bagy\b|antigravity/.test(name)) return "agy";
  if (/\bcopilot\b/.test(name)) return "copilot";
  if (/\bmuse\b/.test(name)) return "muse";
  if (/\bpi\b/.test(name)) return "pi";
  if (/\bkimi\b/.test(name)) return "kimi";
  return null;
}

/** The effort levels a CLI takes, lowest first; empty when it has no effort option. */
export function effortLevels(row: Pick<EngineRow, "id" | "bin">): readonly string[] {
  const kind = launchKind(row);
  return kind ? FLAGS[kind].efforts : [];
}

/** Whether VibeForge can start this CLI on a model of the person's choosing. */
export function takesModel(row: Pick<EngineRow, "id" | "bin">): boolean {
  return launchKind(row) !== null;
}

/** A model name as typed: one word, no quotes or spaces that would turn into another option. */
export function cleanModel(value: string | undefined): string {
  const model = (value ?? "").trim();
  return /^[\w.:/@[\]=,+-]{1,120}$/.test(model) && !model.startsWith("-") ? model : "";
}

/** An effort level at the end of an Antigravity model id: "gemini-4-neon-high" is Neon at high. */
const AGY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/**
 * The model and effort Antigravity CLI is given. Its model ids carry their own effort
 * ("gemini-4-neon-xhigh"), and it refuses `--effort` beside one that says another level
 * ("--model gemini-4-neon-high conflicts with --effort=xhigh"), or beside a model with no levels
 * ("--effort is not supported for model gemini-pro-orchestrator"). So with a model named:
 * - an effort the person chose that differs from the id's own goes on the model's base name
 *   ("gemini-4-neon" with `--effort xhigh`), which agy checks against that model's levels;
 * - a fallback effort (`explicit` false, such as the planner's quick "low") is left to the model.
 * `effort` comes back empty when `--effort` should be left out.
 */
export function agyModelEffort(model: string, effort: string, explicit = true): { model: string; effort: string } {
  if (!model) return { model, effort };
  const own = AGY_EFFORT_SUFFIX.exec(model)?.[1];
  if (!explicit || !effort || effort === own) return { model, effort: "" };
  return { model: own ? model.slice(0, -own.length - 1) : model, effort };
}

/** The effort a model names itself, which only Antigravity's ids do ("gemini-4-neon-high"); else "". */
export function modelOwnEffort(row: Pick<EngineRow, "id" | "bin">, model: string | undefined): string {
  if (launchKind(row) !== "agy") return "";
  const own = AGY_EFFORT_SUFFIX.exec(cleanModel(model))?.[1] ?? "";
  return effortLevels(row).includes(own) ? own : "";
}

/**
 * The effort to keep once the model is `model`: the level an Antigravity id names, so the model
 * picked is the one that runs; otherwise `effort` when the CLI takes it, else "" (the default).
 */
export function effortForModel(row: Pick<EngineRow, "id" | "bin">, model: string | undefined, effort: string | undefined): string {
  const own = modelOwnEffort(row, model);
  if (own) return own;
  const asked = (effort ?? "").trim().toLowerCase();
  return effortLevels(row).includes(asked) ? asked : "";
}

/**
 * The options that start a CLI on `model` with `effort`. A model or an effort the CLI doesn't take
 * is left out, so a step that names one can never start it with an option it refuses.
 */
export function launchOptionArgs(row: Pick<EngineRow, "id" | "bin">, opts: { model?: string; effort?: string }): string[] {
  const kind = launchKind(row);
  if (!kind) return [];
  const flags = FLAGS[kind];
  const cleaned = cleanModel(opts.model);
  const asked = (opts.effort ?? "").trim().toLowerCase();
  const taken = flags.effort && flags.efforts.includes(asked) ? asked : "";
  const { model, effort } = kind === "agy" ? agyModelEffort(cleaned, taken) : { model: cleaned, effort: taken };
  return [...(model ? flags.model(model) : []), ...(flags.effort && effort ? flags.effort(effort) : [])];
}
