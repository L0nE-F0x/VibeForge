import fs from "node:fs";
import path from "node:path";

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "dir" | "link";
  /** Folders that are usually noise (dependencies, build output) are listed but dimmed. */
  quiet?: boolean;
}

const HIDDEN = new Set([".git"]);
const QUIET = new Set(["node_modules", "dist", "dist-electron", "build", ".next", ".nuxt", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", ".vite", "coverage"]);
const LIMIT = 500;

export { shellQuote } from "../shared/text.js";

/** One level of a folder, directories first. The tree loads lazily as folders open. */
export function listDir(dir: string): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let kind: FileNode["kind"] = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
    if (kind === "link") {
      try {
        if (fs.statSync(full).isDirectory()) kind = "dir";
      } catch {
        /* dangling link stays a link */
      }
    }
    if (kind === "file" && !entry.isFile() && !entry.isSymbolicLink()) continue;
    nodes.push({ name: entry.name, path: full, kind, quiet: QUIET.has(entry.name) || undefined });
  }
  nodes.sort((a, b) => {
    const aDir = a.kind === "dir" ? 0 : 1;
    const bDir = b.kind === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    if (Boolean(a.quiet) !== Boolean(b.quiet)) return a.quiet ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return nodes.slice(0, LIMIT);
}
