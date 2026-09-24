import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "./places.js";

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "dir" | "link";
  children?: FileNode[];
}

const SKIP = new Set(["node_modules", ".git", "dist", "dist-electron", ".vite"]);

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function listTree(root: string, depth = 6): FileNode[] {
  if (!fs.existsSync(root)) return [];
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  return walk(root, realRoot, depth);
}

function walk(dir: string, realRoot: string, depth: number): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (nodes.length >= 200) break;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      nodes.push({ name: entry.name, path: full, kind: "link" });
      continue;
    }
    if (entry.isDirectory()) {
      let real = full;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!isPathInside(realRoot, real)) continue;
      nodes.push({
        name: entry.name,
        path: full,
        kind: "dir",
        children: depth > 1 ? walk(full, realRoot, depth - 1) : [],
      });
      continue;
    }
    if (entry.isFile()) nodes.push({ name: entry.name, path: full, kind: "file" });
  }
  return nodes;
}
