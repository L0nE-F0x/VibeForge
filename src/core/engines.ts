import fs from "node:fs";
import path from "node:path";
import type { Engine, EngineRow } from "./types.js";

/**
 * Seed rows for the CLIs VibeForge knows how to hand a prompt to. The human owns
 * engines.json after the first launch; these only fill a missing file.
 */
export function seedEngines(): EngineRow[] {
  return [
    { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    { id: "codex", label: "Codex", bin: "codex", args: [], promptArgs: ["{prompt}"], continueArgs: ["resume", "--last"] },
    { id: "grok", label: "Grok Build", bin: "grok", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    { id: "cursor-agent", label: "Cursor Agent", bin: "cursor-agent", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    { id: "gemini", label: "Gemini CLI", bin: "gemini", args: [], promptArgs: ["-i", "{prompt}"], continueArgs: ["--resume", "latest"] },
    { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    { id: "copilot", label: "Copilot", bin: "copilot", args: [], promptArgs: ["-i", "{prompt}"], continueArgs: ["--continue"] },
    { id: "kimi", label: "Kimi", bin: "kimi", args: [], continueArgs: ["--continue"] },
    { id: "crush", label: "Crush", bin: "crush", args: [], continueArgs: ["--continue"] },
    { id: "pi", label: "Pi", bin: "pi", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    { id: "hermes", label: "Hermes", bin: "hermes", args: [], continueArgs: ["--continue"] },
  ];
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeEngineRows(value: unknown): EngineRow[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { engines?: unknown }).engines)
      ? (value as { engines: unknown[] }).engines
      : [];
  const rows: EngineRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const bin = typeof record.bin === "string" && record.bin.trim() ? record.bin.trim() : id;
    const row: EngineRow = {
      id,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
      bin,
      args: stringList(record.args) ?? [],
    };
    const promptArgs = stringList(record.promptArgs);
    if (promptArgs && promptArgs.length > 0) row.promptArgs = promptArgs;
    const continueArgs = stringList(record.continueArgs);
    if (continueArgs && continueArgs.length > 0) row.continueArgs = continueArgs;
    rows.push(row);
  }
  return rows;
}

function executable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `which` without spawning a process for every row on every refresh. */
export function whichBin(bin: string, envPath: string = process.env.PATH ?? ""): string | null {
  if (typeof bin !== "string" || bin.length === 0 || bin.includes("\0")) return null;
  if (bin.includes("/")) {
    const resolved = path.resolve(bin);
    return executable(resolved) ? resolved : null;
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (executable(candidate)) return candidate;
  }
  return null;
}

export function withAvailability(
  rows: readonly EngineRow[],
  resolveBin: (bin: string) => string | null,
): Engine[] {
  return rows.map((row) => {
    const resolved = resolveBin(row.bin);
    const found = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
    return { ...row, available: found !== null, path: found };
  });
}

const INTERPRETERS = /^(node|bun|deno|python[\d.]*|bash|sh|env)$/;

/**
 * Name the program in a terminal's foreground from its command line. A coding CLI is found by
 * its binary, including when it is a script run by an interpreter (`node …/claude`).
 */
export function programOf(argv: readonly string[], rows: readonly EngineRow[]): { label: string; engineId: string | null } {
  // Programs that set process.title (npm does) leave one space-separated string behind.
  if (argv.length === 1 && /\s/.test(argv[0]) && !argv[0].startsWith("/")) argv = argv[0].split(/\s+/);
  const runner = path.basename(argv[0] ?? "");
  const rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  // `npx vitest`, `npm exec vitest`: name the package it runs. `npm run dev` reads best whole.
  if (/^(npx|bunx|pnpx)$/.test(runner) && rest[0]) return programOf(rest, rows);
  if (/^(npm|pnpm|yarn|bun)$/.test(runner) && /^(exec|x|dlx)$/.test(rest[0] ?? "") && rest[1]) return programOf(rest.slice(1), rows);
  if (/^(npm|pnpm|yarn|bun)$/.test(runner) && /^(run|run-script|start|test)$/.test(rest[0] ?? "")) return { label: [runner, ...rest.slice(0, 2)].join(" "), engineId: null };
  const name = (arg: string | undefined) => {
    const base = path.basename(arg ?? "").replace(/\.(c|m)?js$/, "").replace(/^-/, "");
    // Self-updating CLIs run a file named for its version: ~/.local/share/claude/versions/2.1.283.
    if (!/^v?\d+(\.\d+)+/.test(base)) return base;
    const parts = (arg ?? "").split("/");
    const at = parts.lastIndexOf("versions");
    return (at > 0 ? parts[at - 1] : parts.at(-2)) || base;
  };
  // Look past an interpreter to the script it runs; later arguments are only the CLI's own.
  const script = argv.slice(1).find((arg) => !arg.startsWith("-"));
  const names = INTERPRETERS.test(name(argv[0])) ? [name(argv[0]), name(script)] : [name(argv[0])];
  for (const row of rows) {
    if (names.includes(path.basename(row.bin))) return { label: row.label, engineId: row.id };
  }
  return { label: names.at(-1) || names[0], engineId: null };
}

/**
 * CLIs print how to reopen a session when they exit: "claude --resume <id>", "grok --resume <id>",
 * "codex resume <id>". Resuming that exact session beats "--continue", which takes whichever
 * session in the folder happened to be last.
 */
export function resumeArgsFromTranscript(row: EngineRow, transcript: string): string[] | null {
  const name = path.basename(row.bin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "claude --resume <id>", "codex resume <id>", "copilot --resume=<id>", "crush --session <id>".
  const pattern = new RegExp(`\\b${name}\\s+(--resume|resume|--session)(?:\\s+|=)([0-9A-Za-z][\\w-]{7,})`, "g");
  const matches = [...transcript.slice(-20_000).matchAll(pattern)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return last[0].includes(`${last[1]}=`) ? [`${last[1]}=${last[2]}`] : [last[1], last[2]];
}

/** Linux refuses a single argv string past 128 KiB. Stay well under it. */
export const MAX_PROMPT_ARG_BYTES = 100_000;

export interface LaunchPlan {
  argv: string[];
  /** The argv for the run record: the same, with each prompt slot left as "{prompt}". */
  recordArgv: string[];
  /** Text VibeForge pastes into the session once the CLI is ready, if it could not go on argv. */
  pasteInput: string | null;
}

export function planLaunch(
  row: EngineRow,
  binPath: string,
  opts: { prompt?: string | null; continueSession?: boolean; resumeArgs?: string[] | null; promptFile?: string | null },
): LaunchPlan {
  const argv = [binPath, ...row.args];
  if (opts.resumeArgs?.length) argv.push(...opts.resumeArgs);
  else if (opts.continueSession && row.continueArgs?.length) argv.push(...row.continueArgs);
  const prompt = opts.prompt?.trim() ? opts.prompt : null;
  if (!prompt) return { argv, recordArgv: argv, pasteInput: null };
  if (!row.promptArgs?.length) return { argv, recordArgv: argv, pasteInput: prompt };
  let text = prompt;
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_ARG_BYTES) {
    if (!opts.promptFile) return { argv, recordArgv: argv, pasteInput: prompt };
    text = `Your full instructions for this run are in ${opts.promptFile}. Read that file first and follow it.`;
  }
  const promptArgs = text.startsWith("-") && endsPositional(row.promptArgs) ? [...row.promptArgs.slice(0, -1), "--", "{prompt}"] : row.promptArgs;
  return {
    argv: [...argv, ...promptArgs.map((arg) => arg.replaceAll("{prompt}", text))],
    recordArgv: [...argv, ...promptArgs],
    pasteInput: null,
  };
}

/**
 * Whether the prompt is the last argument and not a flag's value. Only then can "--" go before
 * a prompt such as "--help" so the CLI reads it as text: after "-i" the prompt is the flag's value,
 * and anything after "--" would no longer be read as an option.
 */
function endsPositional(promptArgs: string[]): boolean {
  const last = promptArgs.length - 1;
  return promptArgs[last] === "{prompt}" && (last === 0 || !promptArgs[last - 1].startsWith("-"));
}
