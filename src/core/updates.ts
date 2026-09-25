import path from "node:path";
import { shellQuote } from "../shared/text.js";

// Updates: which release is newest, whether this copy is behind it, and how this copy updates
// itself. Pure; the main process does the asking and runs the command in a terminal.

export const RELEASES_URL = "https://api.github.com/repos/L0nE-F0x/VibeForge/releases/latest";
export const INSTALL_URL = "https://vibe-forge.net/install";
/** The installer leaves this file in the copy it manages. */
export const INSTALLER_MARK = ".vibeforge-installer";

export interface Release {
  version: string;
  name: string;
  url: string;
  notes: string;
  publishedAt: string | null;
}

/** How this copy got here: the installer, a git checkout someone builds themselves, or anything else. */
export type InstallKind = "installer" | "checkout" | "other";

export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** A release from GitHub's "latest release" answer, or null when the answer isn't one. */
export function releaseFrom(json: unknown): Release | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name.trim() : "";
  if (!parseVersion(tag)) return null;
  return {
    version: tag.replace(/^v/, ""),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `VibeForge ${tag}`,
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    notes: typeof raw.body === "string" ? raw.body.slice(0, 20_000) : "",
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
  };
}

export function installKind(appRoot: string, found: { installerHome: string; marked: boolean; checkout: boolean }): InstallKind {
  if (found.marked || path.resolve(appRoot) === path.resolve(found.installerHome)) return "installer";
  return found.checkout ? "checkout" : "other";
}

/**
 * The shell command that updates this copy, shown and run in a terminal, or null when it updates
 * some other way (a distro package). `override` is for packagers and tests.
 */
export function updateCommand(kind: InstallKind, appRoot: string, override?: string): string | null {
  if (override?.trim()) return override.trim();
  if (kind === "installer") return `curl -fsSL ${INSTALL_URL} | VIBEFORGE_HOME=${shellQuote(appRoot)} bash`;
  if (kind === "checkout") return `cd ${shellQuote(appRoot)} && git pull --ff-only && npm install --no-audit --no-fund && npm run build`;
  return null;
}
