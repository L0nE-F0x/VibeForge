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
