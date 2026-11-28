// The parts of a workspace's "when a copy is made" setting that both the window and the main
// process need: the default files, clean folder paths, and what a Viby copy-setup step changes.

import { normalizeWorkspaceAction, parseOptions } from "./orchestrator-actions.js";

/** Files brought into a new copy by default when a workspace hasn't overridden them. */
export const DEFAULT_COPY_FILES: readonly string[] = [".env*"];

/**
 * Package and build folders. Cloning one into a copy gives an agent nothing it couldn't install
 * itself, so Viby may add them without Go; any other folder could hold secrets and waits.
 */
export const PACKAGE_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules", "vendor", "dist", "dist-electron", "build", "out", "target", "coverage", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".vite", ".parcel-cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".gradle", ".tox",
]);

/** Normalize a configured folder path relative to the workspace; null when unsafe or empty. */
export function cleanCopyFolderPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\")) return null;
  let clean = trimmed;
  while (clean.startsWith("./")) clean = clean.slice(2);
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  if (!clean || clean.startsWith("/") || clean === "." || clean === "..") return null;
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  if (parts[0] === ".git") return null;
  return parts.join("/");
}

/** What a Viby copy-setup step changes. A field left out is left as it is. */
export interface CopySetupChange {
  /** The files to bring along: null goes back to the default (.env*), [] brings none. */
  files?: string[] | null;
  /** The folders to clone; [] clones none. */
  folders?: string[];
  /** The setup command; "" removes it. */
  command?: string;
  /** Whether the project's .worktreeinclude is used too. */
  worktreeInclude?: boolean;
}

const DEFAULT_WORDS = /^(?:default|reset|auto)$/i;
const NONE_WORDS = /^(?:none|clear|empty|off|nothing)$/i;

function listValue(raw: string): string[] {
  return raw.split(/[\s,;]+/).filter(Boolean);
}

/** The change a workspace copy-setup step makes, or null for any other step. */
export function copySetupChange(step: { kind: string; action?: string; prompt?: string; options?: string }): CopySetupChange | null {
  if (step.kind !== "workspace" || normalizeWorkspaceAction(step.action) !== "copy-setup") return null;
  const opts = parseOptions(step.options);
  const change: CopySetupChange = {};
  if (opts.has("files")) {
    const raw = (opts.str("files") ?? "").trim();
    change.files = DEFAULT_WORDS.test(raw) ? null : !raw || NONE_WORDS.test(raw) ? [] : listValue(raw);
  }
  if (opts.has("folders")) {
    const raw = (opts.str("folders") ?? "").trim();
    change.folders = !raw || NONE_WORDS.test(raw) || DEFAULT_WORDS.test(raw) ? [] : listValue(raw).map(cleanCopyFolderPath).filter((item): item is string => item !== null);
  }
  const include = opts.bool("worktreeInclude");
  if (include !== undefined) change.worktreeInclude = include;
  const prompt = (step.prompt ?? "").trim();
  if (prompt || opts.has("setupCommand") || opts.has("command")) {
    const command = (prompt || opts.str("setupCommand") || opts.str("command") || "").trim();
    change.command = !command || NONE_WORDS.test(command) || DEFAULT_WORDS.test(command) ? "" : command;
  }
  return change;
}

/**
 * Whether a copy-setup change waits for Go: a setup command (it runs in every new copy), files
 * beyond the default .env*, or a folder that isn't a package or build folder. Each gives the
 * agents working in copies more to act on.
 */
export function copySetupNeedsGo(change: CopySetupChange | null, current?: { files?: string[]; worktreeInclude?: boolean } | null): boolean {
  if (!change) return false;
  if (change.command) return true;
  // Turning copying back on after the person turned it off widens it too.
  if (change.worktreeInclude === true && (current === undefined || current?.worktreeInclude === false)) return true;
  if (change.files === null && current?.files && current.files.length === 0) return true;
  if (change.files?.some((pattern) => !DEFAULT_COPY_FILES.includes(pattern))) return true;
  if (change.folders?.some((folder) => !PACKAGE_FOLDERS.has(folder.split("/").pop() ?? ""))) return true;
  return false;
}
