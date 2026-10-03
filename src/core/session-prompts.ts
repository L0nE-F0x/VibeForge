import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readText } from "./fsx.js";

const MATCH_MS = 15_000;
const MAX_PROMPT = 20_000;
const MAX_PROMPTS = 50;

export function grokHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.GROK_HOME || path.join(home, ".grok");
}

function userQueries(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)) {
    const body = match[1].trim();
    if (!body) continue;
    found.push(body.length > MAX_PROMPT ? `${body.slice(0, MAX_PROMPT)}…` : body);
    if (found.length >= MAX_PROMPTS) break;
  }
  return found;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
    .join("");
}

function queriesFromChat(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let record: { type?: string; content?: unknown };
    try {
      record = JSON.parse(line) as { type?: string; content?: unknown };
    } catch {
      continue;
    }
    if (record.type !== "user") continue;
    for (const query of userQueries(textOf(record.content))) {
      found.push(query);
      if (found.length >= MAX_PROMPTS) return found;
    }
  }
  return found;
}

/** The Grok session that started with this run, if one was written within a few seconds. */
function sessionDir(root: string, startedAt: string): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  let best: { dir: string; delta: number } | null = null;
  for (const name of names) {
    let summary: { created_at?: string };
    try {
      summary = JSON.parse(fs.readFileSync(path.join(root, name, "summary.json"), "utf8")) as { created_at?: string };
    } catch {
      continue;
    }
    const created = Date.parse(summary.created_at ?? "");
    if (!Number.isFinite(created)) continue;
    const delta = Math.abs(created - start);
    if (delta > MATCH_MS) continue;
    if (!best || delta < best.delta) best = { dir: path.join(root, name), delta };
  }
  return best?.dir ?? null;
}

/**
 * What the person typed into a Grok session VibeForge did not prompt itself.
 * A typed `grok` has no preamble; the prompts live in Grok's own session log.
 */
export function readGrokPrompts(home: string, cwd: string, startedAt: string): string {
  if (!cwd || !startedAt) return "";
  const dir = sessionDir(path.join(home, "sessions", encodeURIComponent(cwd)), startedAt);
  if (!dir) return "";
  const queries = queriesFromChat(readText(path.join(dir, "chat_history.jsonl")));
  return queries.join("\n\n");
}

/** `~/.local/share/muse`, or `$XDG_DATA_HOME/muse`. */
export function museHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "muse");
}

function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e14 ? value / 1000 : value > 1e11 ? value : value * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/** Muse's own instructions, not something the person typed. */
function museTypedPrompt(text: string): string | null {
  const body = text.trim();
  if (!body || body.startsWith("You are") || body.startsWith("You watch") || body.startsWith("{")) return null;
  return body.length > MAX_PROMPT ? `${body.slice(0, MAX_PROMPT)}…` : body;
}

function sameFolder(left: string, right: string): boolean {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

/** First records of a Muse session: the folder it opened in, and when. */
function museSessionOpen(file: string): { cwd: string | null; openedAt: number | null } {
  let text = "";
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65_536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, read).toString("utf8");
    if (read === buf.length && !text.endsWith("\n")) {
      const cut = text.lastIndexOf("\n");
      text = cut >= 0 ? text.slice(0, cut) : "";
    }
  } catch {
    return { cwd: null, openedAt: null };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const lines = text.split("\n");
  let cwd: string | null = null;
  let openedAt: number | null = null;
  for (const line of lines) {
    if (!line) continue;
    let record: { recorded_at?: unknown; payload?: { record?: { workspace_root?: unknown; cwd?: unknown } } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    openedAt ??= epochMs(record.recorded_at);
    const info = record.payload?.record;
    const folder = typeof info?.workspace_root === "string" ? info.workspace_root : typeof info?.cwd === "string" ? info.cwd : "";
    if (!cwd && folder) cwd = folder;
    if (cwd && openedAt !== null) break;
  }
  return { cwd, openedAt };
}

function promptsFromMuseLog(file: string): string[] {
  const found: string[] = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return found;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"prompt"')) continue;
    let record: { payload?: { event?: { kind?: unknown; prompt?: unknown } } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const event = record.payload?.event;
    if (event?.kind !== "started" || typeof event.prompt !== "string") continue;
    const prompt = museTypedPrompt(event.prompt);
    if (!prompt) continue;
    found.push(prompt);
    if (found.length >= MAX_PROMPTS) break;
  }
  return found;
}

/**
 * What the person typed into a Muse session VibeForge did not prompt itself.
 * Sessions are filed by the day they opened. The one whose folder and start
 * match this run is the one. Muse's launcher name is not on these lines.
 */
export function readMusePrompts(home: string, cwd: string, startedAt: string): string {
  if (!cwd || !startedAt) return "";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "";
  const root = path.join(home, "sessions");
  let best: { file: string; delta: number } | null = null;
  for (const deltaDay of [-1, 0, 1]) {
    const day = new Date(start + deltaDay * 86_400_000);
    const dir = path.join(root, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name, "session.jsonl");
      const opened = museSessionOpen(file);
      if (!opened.cwd || opened.openedAt === null || !sameFolder(opened.cwd, cwd)) continue;
      const delta = Math.abs(opened.openedAt - start);
      if (delta > MATCH_MS) continue;
      if (!best || delta < best.delta) best = { file, delta };
    }
  }
  if (!best) return "";
  return promptsFromMuseLog(best.file).join("\n\n");
}
