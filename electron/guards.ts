import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIDDEN_ARG } from "../src/core/autostart.js";

// Small rules the main process keeps, pure so the tests can reach them without Electron.

/** Where VibeForge's own page lives: the built index.html, or the Vite dev server while developing. */
export interface AppPage {
  file: string;
  devUrl?: string;
}

/**
 * Whether `url` is VibeForge's own page. Only that page may run with the preload's bridge, so any
 * other file, even one beside it, is not: the dev server matches by origin, the build by its exact file.
 */
export function isAppPage(url: string, page: AppPage): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (page.devUrl) {
    try {
      const dev = new URL(page.devUrl);
      return /^https?:$/.test(dev.protocol) && parsed.origin === dev.origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== "file:") return false;
  try {
    return fileURLToPath(parsed) === path.resolve(page.file);
  } catch {
    // A host other than localhost, or an encoded slash.
    return false;
  }
}

/**
 * The arguments a restart starts with: this copy's own, minus --hidden, so a copy started at login
 * comes back as a window rather than in the tray.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter((arg) => arg !== HIDDEN_ARG);
}
