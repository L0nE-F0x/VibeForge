import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_THEMES } from "./themes-bundled.js";

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
  /** The theme's folder name, as Omarchy names it: "tokyo-night". */
  id: string;
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
  id: "apex-forge",
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

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

export function mixHex(a: string, b: string, amount: number): string {
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((value, index) => Math.round(value + (y[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function hueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = channels(hex).map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const light = (max + min) / 2;
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return { hue: (hue * 60 + 360) % 360, sat };
}

/**
 * The second gradient stop when a theme does not name one: the palette colour whose hue sits
 * closest to the accent (but is still a different colour), so Tokyo Night runs blue → violet and
 * Nord runs frost → cyan instead of everything fading into yellow.
 */
export function companionColor(accent: string, candidates: string[], fallback: string): string {
  const base = hueSat(accent);
  let best: { hex: string; distance: number } | null = null;
  for (const hex of candidates) {
    if (!hex || hex.toLowerCase() === accent.toLowerCase()) continue;
    const { hue, sat } = hueSat(hex);
    if (sat < 0.25) continue;
    const distance = Math.min(Math.abs(hue - base.hue), 360 - Math.abs(hue - base.hue));
    if (distance < 12) continue;
    if (!best || distance < best.distance) best = { hex, distance };
  }
  return best && best.distance <= 110 ? best.hex : fallback;
}

/** Faint text must stay readable: lift the theme's muted colour toward the foreground if needed. */
export function readableMuted(muted: string, foreground: string, background: string, minimum = 3.4): string {
  let amount = 0;
  let color = muted;
  while (contrast(color, background) < minimum && amount < 1) {
    amount = Math.min(1, amount + 0.05);
    color = mixHex(muted, foreground, amount);
  }
  return color;
}

export function paletteFromFiles(input: { id?: string; name: string; colors: string | Readonly<Record<string, string>>; ghostty?: string | null }): Palette | null {
  const colors = typeof input.colors === "string" ? parseFlatToml(input.colors) : input.colors;
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
  const muted = readableMuted(pick("muted", "dark_foreground") ?? base.muted, foreground, background);
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
    id: input.id ?? input.name.toLowerCase().replace(/\s+/g, "-"),
    name: input.name || "Omarchy",
    source: "omarchy",
    mode,
    accent,
    accent2: secondStop && secondStop !== accent ? secondStop : companionColor(accent, [magenta, cyan, blue, green, yellow, red], yellow),
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
    const id = readOptional(path.join(dir, "..", "theme.name"))?.trim() || path.basename(dir);
    const palette = paletteFromFiles({ id, name: themeName(id), colors, ghostty: readOptional(path.join(dir, "ghostty.conf")) });
    if (palette) return palette;
  }
  return null;
}

/** "tokyo-night" → "Tokyo Night", as `omarchy theme list` shows it. */
export function themeName(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A theme folder's name, safe to join onto a themes folder. "omarchy" is the setting that follows the desktop. */
export function isThemeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/** Where Omarchy keeps themes. The person's own come first, as they replace a stock theme of the same name. */
export function themeRoots(home = os.homedir(), omarchyPath = process.env.OMARCHY_PATH): string[] {
  const roots = [path.join(home, ".config", "omarchy", "themes")];
  if (omarchyPath) roots.push(path.join(omarchyPath, "themes"));
  roots.push(path.join(home, ".local", "share", "omarchy", "themes"), "/usr/share/omarchy/themes");
  return [...new Set(roots)];
}

function readThemeDir(root: string, id: string): Palette | null {
  const dir = path.join(root, id);
  const colors = readOptional(path.join(dir, "colors.toml"));
  return colors ? paletteFromFiles({ id, name: themeName(id), colors, ghostty: readOptional(path.join(dir, "ghostty.conf")) }) : null;
}

function bundledPalette(theme: (typeof BUNDLED_THEMES)[number]): Palette | null {
  const palette = paletteFromFiles({ id: theme.id, name: themeName(theme.id), colors: theme.colors });
  return palette && { ...palette, source: "builtin" };
}

/** One theme by its folder name: installed on this machine, else shipped with VibeForge, else null. */
export function readTheme(id: string, roots = themeRoots()): Palette | null {
  if (!isThemeId(id)) return null;
  for (const root of roots) {
    const palette = readThemeDir(root, id);
    if (palette) return palette;
  }
  const bundled = BUNDLED_THEMES.find((theme) => theme.id === id);
  if (bundled) return bundledPalette(bundled);
  return id === BUILTIN_PALETTE.id ? BUILTIN_PALETTE : null;
}

/** What Settings shows of a theme: its name and three squares. */
export interface ThemeChoice {
  id: string;
  name: string;
  mode: "dark" | "light";
  background: string;
  accent: string;
  accent2: string;
}

export interface ThemeList {
  /** The desktop's own theme, when this is Omarchy. */
  system: ThemeChoice | null;
  /** Apex Forge first, then by name. */
  themes: ThemeChoice[];
}

function choice(palette: Palette): ThemeChoice {
  return { id: palette.id, name: palette.name, mode: palette.mode, background: palette.background, accent: palette.accent, accent2: palette.accent2 };
}

/** Every theme VibeForge can wear: the ones installed here, then the stock ones it ships. */
export function listThemes(home = os.homedir(), roots = themeRoots(home)): ThemeList {
  const found = new Map<string, Palette>();
  for (const root of roots) {
    let ids: string[];
    try {
      ids = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (found.has(id) || !isThemeId(id)) continue;
      const palette = readThemeDir(root, id);
      if (palette) found.set(id, palette);
    }
  }
  for (const theme of BUNDLED_THEMES) {
    const palette = found.has(theme.id) ? null : bundledPalette(theme);
    if (palette) found.set(theme.id, palette);
  }
  if (!found.has(BUILTIN_PALETTE.id)) found.set(BUILTIN_PALETTE.id, BUILTIN_PALETTE);
  const first = (item: ThemeChoice) => (item.id === BUILTIN_PALETTE.id ? 0 : 1);
  const themes = [...found.values()].map(choice).sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name));
  const system = readOmarchyPalette(home);
  return { system: system && choice(system), themes };
}

/**
 * "omarchy" follows the desktop's theme; anything else pins a theme by its folder name. A pinned
 * theme that is gone falls back to following, and no Omarchy theme at all means Apex Forge.
 */
export function resolvePalette(theme: string, home = os.homedir(), roots = themeRoots(home)): Palette {
  const pinned = theme === "omarchy" ? null : readTheme(theme, roots);
  return pinned ?? readOmarchyPalette(home) ?? BUILTIN_PALETTE;
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
