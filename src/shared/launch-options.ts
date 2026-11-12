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

/**
 * The options that start a CLI on `model` with `effort`. A model or an effort the CLI doesn't take
 * is left out, so a step that names one can never start it with an option it refuses.
 */
export function launchOptionArgs(row: Pick<EngineRow, "id" | "bin">, opts: { model?: string; effort?: string }): string[] {
  const kind = launchKind(row);
  if (!kind) return [];
  const flags = FLAGS[kind];
  const model = cleanModel(opts.model);
  const effort = (opts.effort ?? "").trim().toLowerCase();
  return [...(model ? flags.model(model) : []), ...(flags.effort && flags.efforts.includes(effort) ? flags.effort(effort) : [])];
}
