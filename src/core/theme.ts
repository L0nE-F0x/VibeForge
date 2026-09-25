import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** ANSI 0–15. */
  ansi: string[];
}

export interface Palette {
  name: string;
  source: "omarchy" | "builtin";
  mode: "dark" | "light";
  accent: string;
  /** Second stop of the theme's signature gradient. */
  accent2: string;
  background: string;
  darkBackground: string;
  darkerBackground: string;
  lighterBackground: string;
  foreground: string;
  lightForeground: string;
  darkForeground: string;
  muted: string;
  selection: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  magenta: string;
  orange: string;
  terminal: TerminalPalette;
}

/** Apex Forge: the fallback when no Omarchy theme can be read. */
export const BUILTIN_PALETTE: Palette = {
  name: "Apex Forge",
  source: "builtin",
  mode: "dark",
  accent: "#ff6b35",
  accent2: "#fca311",
  background: "#09090b",
  darkBackground: "#0c0c0e",
  darkerBackground: "#050506",
  lighterBackground: "#151518",
  foreground: "#ffffff",
  lightForeground: "#a1a1aa",
  darkForeground: "#71717a",
  muted: "#71717a",
  selection: "#232326",
  red: "#ff4d6d",
  green: "#34d399",
  yellow: "#fca311",
  blue: "#38bdf8",
  cyan: "#22d3ee",
  magenta: "#7c3aed",
  orange: "#ff6b35",
  terminal: {
    background: "#09090b",
    foreground: "#ffffff",
    cursor: "#ff6b35",
    cursorAccent: "#09090b",
    selectionBackground: "#4a2110",
    ansi: [
      "#09090b", "#ff4d6d", "#34d399", "#fca311", "#38bdf8", "#7c3aed", "#22d3ee", "#a1a1aa",
      "#71717a", "#ff7a93", "#6ee7b7", "#fcbb00", "#7dd3fc", "#a78bfa", "#67e8f9", "#ffffff",
    ],
  },
};

export function themeDirCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "state", "omarchy", "current", "theme"),
    path.join(home, ".config", "omarchy", "current", "theme"),
  ];
}

/** Normalise "#FF6B35", "ff6b35", "rgba(ff6b35ee)" or "rgb(255,107,53)" to "#ff6b35". */
export function toHex(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = value.trim().replace(/^["']|["']$/g, "");
  let match = text.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (match) return `#${match[1].toLowerCase()}`;
  match = text.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (match) return `#${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}`.toLowerCase();
  match = text.match(/^rgba?\(\s*([0-9a-f]{6})(?:[0-9a-f]{2})?\s*\)$/i);
  if (match) return `#${match[1].toLowerCase()}`;
  match = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (match) {
    return `#${[match[1], match[2], match[3]].map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

/** Flat `key = "value"` TOML, which is all colors.toml uses. */
export function parseFlatToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"|^([A-Za-z0-9_.-]+)\s*=\s*'([^']*)'/);
    if (match) out[(match[1] ?? match[3]).trim()] = (match[2] ?? match[4]).trim();
  }
  return out;
}

export function parseGhostty(text: string): Partial<TerminalPalette> & { ansiOverrides: Record<number, string> } {
  const ansiOverrides: Record<number, string> = {};
  const out: Partial<TerminalPalette> & { ansiOverrides: Record<number, string> } = { ansiOverrides };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    const name = key.trim();
    const value = rest.join("=").trim();
    if (name === "palette") {
      const match = value.match(/^(\d+)\s*=\s*(\S+)/);
      const hex = match ? toHex(match[2]) : null;
      if (match && hex) ansiOverrides[Number(match[1])] = hex;
      continue;
    }
    const hex = toHex(value);
    if (!hex) continue;
    if (name === "background") out.background = hex;
    else if (name === "foreground") out.foreground = hex;
    else if (name === "cursor-color") out.cursor = hex;
    else if (name === "selection-background") out.selectionBackground = hex;
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function paletteFromFiles(input: { name: string; colors: string; ghostty?: string | null }): Palette | null {
  const colors = parseFlatToml(input.colors);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const hex = toHex(colors[key]);
      if (hex) return hex;
    }
    return null;
  };
  const background = pick("background");
  const foreground = pick("foreground");
  if (!background || !foreground) return null;
  const base = BUILTIN_PALETTE;
  const accent = pick("accent", "orange", "blue") ?? base.accent;
  const gradientStops = (colors.hyprland_active_border ?? "").match(/rgba?\([^)]*\)|#[0-9a-f]{6,8}/gi) ?? [];
  const secondStop = gradientStops.length > 1 ? toHex(gradientStops[1]) : null;
  const mode = colors.mode === "light" || colors.mode === "dark" ? colors.mode : luminance(background) > 0.5 ? "light" : "dark";
  const red = pick("red") ?? base.red;
  const green = pick("green") ?? base.green;
  const yellow = pick("yellow") ?? base.yellow;
  const blue = pick("blue") ?? base.blue;
  const cyan = pick("cyan") ?? base.cyan;
  const magenta = pick("magenta") ?? base.magenta;
  const muted = pick("muted", "dark_foreground") ?? base.muted;
  const lightForeground = pick("light_foreground") ?? foreground;
  const darkerBackground = pick("darker_background", "dark_background") ?? background;
  const ansi = [
    pick("color0", "black") ?? darkerBackground,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    pick("color7", "white") ?? lightForeground,
    pick("color8", "bright_black") ?? muted,
    pick("bright_red") ?? red,
    pick("bright_green") ?? green,
    pick("bright_yellow") ?? yellow,
    pick("bright_blue") ?? blue,
    pick("bright_magenta") ?? magenta,
    pick("bright_cyan") ?? cyan,
    pick("bright_foreground", "bright_white") ?? foreground,
  ];
  const ghostty = input.ghostty ? parseGhostty(input.ghostty) : null;
  if (ghostty) for (const [index, hex] of Object.entries(ghostty.ansiOverrides)) if (Number(index) < 16) ansi[Number(index)] = hex;
  const selection = pick("selection") ?? base.selection;
  return {
    name: input.name || "Omarchy",
    source: "omarchy",
    mode,
    accent,
    accent2: secondStop && secondStop !== accent ? secondStop : yellow,
    background,
    darkBackground: pick("dark_background") ?? background,
    darkerBackground,
    lighterBackground: pick("lighter_background") ?? background,
    foreground,
    lightForeground,
    darkForeground: pick("dark_foreground") ?? muted,
    muted,
    selection,
    red,
    green,
    yellow,
    blue,
    cyan,
    magenta,
    orange: pick("orange") ?? accent,
    terminal: {
      background: ghostty?.background ?? background,
      foreground: ghostty?.foreground ?? foreground,
      cursor: ghostty?.cursor ?? pick("cursor") ?? accent,
      cursorAccent: ghostty?.background ?? background,
      selectionBackground: ghostty?.selectionBackground ?? selection,
      ansi,
    },
  };
}

function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The active Omarchy theme, or null when this machine does not have one. */
export function readOmarchyPalette(home = os.homedir()): Palette | null {
  for (const dir of themeDirCandidates(home)) {
    const colors = readOptional(path.join(dir, "colors.toml"));
    if (!colors) continue;
    const raw = readOptional(path.join(dir, "..", "theme.name"))?.trim() || path.basename(dir);
    const name = raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const palette = paletteFromFiles({ name, colors, ghostty: readOptional(path.join(dir, "ghostty.conf")) });
    if (palette) return palette;
  }
  return null;
}

export function resolvePalette(preference: "omarchy" | "builtin", home = os.homedir()): Palette {
  if (preference === "builtin") return BUILTIN_PALETTE;
  return readOmarchyPalette(home) ?? BUILTIN_PALETTE;
}

/** Watch the Omarchy "current" folder; theme switches replace it. Returns a stop function. */
export function watchOmarchyTheme(onChange: () => void, home = os.homedir()): () => void {
  const watchers: fs.FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };
  for (const dir of themeDirCandidates(home)) {
    const parent = path.dirname(dir);
    for (const target of [parent, dir]) {
      try {
        watchers.push(fs.watch(target, { persistent: false }, fire));
      } catch {
        /* not on this machine */
      }
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
