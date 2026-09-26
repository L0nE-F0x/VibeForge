import { createHash } from "node:crypto";
import path from "node:path";

// The control socket: how `vibeforge --voice start` reaches the running window in a few
// milliseconds, instead of starting a second Electron only to be handed off. One per data folder,
// so a test instance with its own VIBEFORGE_DATA never answers for the real one. scripts/vibeforge
// works out the same path in bash; keep the two in step.

export const VOICE_ACTIONS = ["start", "stop", "toggle", "cancel", "converse"] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

export function controlSocketPath(dataRoot: string, runtimeDir: string | undefined, uid: number): string {
  const tag = createHash("sha1").update(dataRoot).digest("hex").slice(0, 8);
  // Unix socket paths are limited to about 100 bytes, so the folder is hashed rather than used.
  return runtimeDir ? path.join(runtimeDir, `vibeforge-${tag}.sock`) : path.join("/tmp", `vibeforge-${uid}-${tag}.sock`);
}

/** "voice start" → "start"; anything else is ignored. */
export function parseControl(line: string): VoiceAction | null {
  const match = /^\s*voice\s+(\w+)\s*$/.exec(line);
  const action = match?.[1] as VoiceAction | undefined;
  return action && VOICE_ACTIONS.includes(action) ? action : null;
}

/** `--voice start` (or `--voice=start`) among a second instance's arguments. */
export function voiceArg(argv: readonly string[]): VoiceAction | null {
  for (let i = 0; i < argv.length; i++) {
    const inline = /^--voice=(\w+)$/.exec(argv[i]);
    const value = inline ? inline[1] : argv[i] === "--voice" ? (argv[i + 1] ?? "toggle") : null;
    if (value !== null) return parseControl(`voice ${value}`);
  }
  return null;
}

export const HOLD_KEYS = { lua: "SUPER + ALT + V", conf: "SUPER ALT, V" };
export const CONVERSE_GLOBAL = { lua: "SUPER + ALT + T", conf: "SUPER ALT, T" };

/**
 * Keybindings that reach VibeForge from anywhere on the desktop: hold Super+Alt+V to talk, and
 * Super+Alt+T to start or end a conversation. Omarchy's Lua config (bindings.lua), or hyprland.conf.
 */
export function hyprlandBindings(launcher: string, lua: boolean): string {
  const run = (action: string) => `${launcher} --voice ${action}`;
  if (lua) {
    return [
      "-- VibeForge voice: hold to talk, from anywhere",
      `o.bind("${HOLD_KEYS.lua}", "VibeForge: hold to talk", "${run("start")}")`,
      `o.bind("${HOLD_KEYS.lua}", "VibeForge: stop talking", "${run("stop")}", { release = true })`,
      `o.bind("${CONVERSE_GLOBAL.lua}", "VibeForge: conversation", "${run("converse")}")`,
    ].join("\n");
  }
  return [
    "# VibeForge voice: hold to talk, from anywhere",
    `bind = ${HOLD_KEYS.conf}, exec, ${run("start")}`,
    `bindr = ${HOLD_KEYS.conf}, exec, ${run("stop")}`,
    `bind = ${CONVERSE_GLOBAL.conf}, exec, ${run("converse")}`,
  ].join("\n");
}
