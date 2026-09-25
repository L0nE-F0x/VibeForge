import type { ITheme } from "@xterm/xterm";
import { useSyncExternalStore } from "react";
import type { Palette } from "../shared/api.js";
import { call, on } from "./api.js";

let current: Palette | null = null;
const listeners = new Set<() => void>();

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Text on the accent gradient: whichever of the theme's darkest and white reads better on both stops. */
function onAccent(palette: Palette): string {
  const dark = palette.darkerBackground;
  const score = (text: string) => Math.min(contrast(text, palette.accent), contrast(text, palette.accent2));
  return score(dark) >= score("#ffffff") ? dark : "#ffffff";
}

/** Fill the raw CSS tokens; everything else in app.css is derived from them. */
export function applyPalette(palette: Palette): void {
  current = palette;
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(name, value);
  set("--bg", palette.background);
  set("--bg-dark", palette.darkBackground);
  set("--bg-deep", palette.darkerBackground);
  set("--bg-raised", palette.lighterBackground);
  set("--fg", palette.foreground);
  set("--fg-2", palette.lightForeground);
  set("--fg-3", palette.muted);
  set("--accent", palette.accent);
  set("--accent-2", palette.accent2);
  set("--on-accent", onAccent(palette));
  set("--red", palette.red);
  set("--green", palette.green);
  set("--yellow", palette.yellow);
  set("--blue", palette.blue);
  set("--cyan", palette.cyan);
  set("--magenta", palette.magenta);
  set("--selection", palette.selection);
  set("--term-bg", palette.terminal.background);
  document.documentElement.style.colorScheme = palette.mode;
  document.documentElement.dataset.theme = palette.mode;
  for (const listener of listeners) listener();
}

export async function initTheme(): Promise<void> {
  on("palette", applyPalette);
  try {
    applyPalette(await call("app.palette"));
  } catch {
    /* the CSS defaults are the Apex Forge palette */
  }
}

export function usePalette(): Palette | null {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
  );
}

export function xtermTheme(palette: Palette | null): ITheme {
  if (!palette) return {};
  const t = palette.terminal;
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    selectionInactiveBackground: palette.selection,
    scrollbarSliderBackground: `${palette.muted}40`,
    scrollbarSliderHoverBackground: `${palette.accent}90`,
    scrollbarSliderActiveBackground: palette.accent,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}
