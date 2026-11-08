import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The control socket: how `vibeforge --voice start` reaches the running window in a few
// milliseconds, instead of starting a second Electron only to be handed off, and how
// `vibeforge tell|who|task|apply` from a CLI in one of its terminals reaches the others. One per data folder,
// so a test instance with its own VIBEFORGE_DATA never answers for the real one. scripts/vibeforge
// works out the same path in bash; keep the two in step.

export const VOICE_ACTIONS = ["start", "stop", "cancel"] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

/**
 * Where the socket goes without XDG_RUNTIME_DIR: a folder in /tmp that only this user can enter,
 * since a bare path in /tmp could be made first by anyone. `tmp` is for tests.
 */
export function fallbackSocketDir(uid: number, tmp = "/tmp"): string {
  return path.join(tmp, `vibeforge-${uid}`);
}

export function controlSocketPath(dataRoot: string, runtimeDir: string | undefined, uid: number, tmp = "/tmp"): string {
  const tag = createHash("sha1").update(dataRoot).digest("hex").slice(0, 8);
  // Unix socket paths are limited to about 100 bytes, so the folder is hashed rather than used.
  return path.join(runtimeDir || fallbackSocketDir(uid, tmp), `vibeforge-${tag}.sock`);
}

/**
 * Readies the socket's folder when it is the /tmp fallback: made with mode 0700, or, when it is
 * there already, a real folder this user owns, closed to everyone else. False when it belongs to
 * someone else, whose socket it could be. scripts/vibeforge checks the same before connecting.
 */
export function prepareSocketDir(socketPath: string, uid: number, tmp = "/tmp"): boolean {
  const dir = path.dirname(socketPath);
  if (dir !== fallbackSocketDir(uid, tmp)) return true;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid) return false;
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** "voice start" → "start"; anything else is ignored. */
export function parseControl(line: string): VoiceAction | null {
  const match = /^\s*voice\s+(\w+)\s*$/.exec(line);
  const action = match?.[1] as VoiceAction | undefined;
  return action && VOICE_ACTIONS.includes(action) ? action : null;
}

/** A request from `vibeforge tell|who|task` (scripts/talk.mjs): one JSON line. */
export type TalkRequest =
  | { op: "who"; pty: string | null }
  | { op: "tell"; pty: string | null; to: string; text: string; wait: boolean; timeoutMs?: number }
  | { op: "task"; pty: string | null; agent: string; text: string; title?: string; start: boolean; wait: boolean; timeoutMs?: number }
  | { op: "apply"; pty: string | null; task: string };

/** Any request can come back refused, with the reason. */
export type TalkRefusal = { ok: false; error: string };

/**
 * The JSON line that answers each request, as scripts/talk.mjs reads it (through JSDoc).
 * tests/unit/talk-answers.test.ts holds these to what the team service returns.
 */
export interface TalkAnswers {
  who:
    | {
        ok: true;
        you: string | null;
        clis: Array<{ handle: string; label: string; folder: string; working: boolean; you: boolean }>;
        agents: Array<{ name: string; handle: string; engine: string; goodAt: string; tier: string }>;
      }
    | TalkRefusal;
  tell: { ok: true; to: string; delivered: "sent" | "draft" | "queued"; reply?: string | null; fromScreen?: boolean; timedOut?: boolean; note?: string } | TalkRefusal;
  task: { ok: true; taskId: string; title: string; started: boolean; reply?: string | null; note?: string } | TalkRefusal;
  apply: { ok: true; files: string[]; conflicts: string[]; note: string } | TalkRefusal;
}

/** The largest request line: a long message is still one line of JSON. */
export const TALK_REQUEST_MAX = 512 * 1024;

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);
const duration = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 60 * 60 * 1000) : undefined;

export function parseTalkRequest(line: string): TalkRequest | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const pty = text(raw.pty, 200) || null;
  if (raw.op === "who") return { op: "who", pty };
  if (raw.op === "apply") {
    const task = text(raw.task, 200);
    return task ? { op: "apply", pty, task } : null;
  }
  const body = text(raw.text, TALK_REQUEST_MAX);
  if (!body) return null;
  if (raw.op === "tell") {
    const to = text(raw.to, 200);
    return to ? { op: "tell", pty, to, text: body, wait: raw.wait === true, timeoutMs: duration(raw.timeoutMs) } : null;
  }
  if (raw.op === "task") {
    const agent = text(raw.agent, 200);
    if (!agent) return null;
    return { op: "task", pty, agent, text: body, title: text(raw.title, 200) ?? undefined, start: raw.start !== false, wait: raw.wait === true, timeoutMs: duration(raw.timeoutMs) };
  }
  return null;
}

/** `--voice start` (or `--voice=start`) among a second instance's arguments. */
export function voiceArg(argv: readonly string[]): VoiceAction | null {
  for (let i = 0; i < argv.length; i++) {
    const inline = /^--voice=(\w+)$/.exec(argv[i]);
    const value = inline ? inline[1] : argv[i] === "--voice" ? (argv[i + 1] ?? "start") : null;
    if (value !== null) return parseControl(`voice ${value}`);
  }
  return null;
}

export const HOLD_KEYS = { lua: "SUPER + ALT + V", conf: "SUPER ALT, V" };

/**
 * Hold Super+Alt+V to talk to one agent from anywhere on the desktop. Omarchy's Lua config
 * (bindings.lua), or hyprland.conf.
 */
export function hyprlandBindings(launcher: string, lua: boolean): string {
  const run = (action: string) => `${launcher} --voice ${action}`;
  if (lua) {
    return [
      "-- VibeForge voice: hold to talk to one agent, from anywhere",
      `o.bind("${HOLD_KEYS.lua}", "VibeForge: hold to talk", "${run("start")}")`,
      `o.bind("${HOLD_KEYS.lua}", "VibeForge: stop talking", "${run("stop")}", { release = true })`,
    ].join("\n");
  }
  return [
    "# VibeForge voice: hold to talk to one agent, from anywhere",
    `bind = ${HOLD_KEYS.conf}, exec, ${run("start")}`,
    `bindr = ${HOLD_KEYS.conf}, exec, ${run("stop")}`,
  ].join("\n");
}
