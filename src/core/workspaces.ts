import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./types.js";

export interface WorkspaceFile {
  workspaces: Workspace[];
  lastWorkspaceId: string | null;
}

const EMPTY: WorkspaceFile = { workspaces: [], lastWorkspaceId: null };

export function workspaceFilePath(configRoot: string): string {
  return path.join(configRoot, "workspaces.json");
}

export function readWorkspaces(configRoot: string): WorkspaceFile {
  const file = workspaceFilePath(configRoot);
  if (!fs.existsSync(file)) return { ...EMPTY, workspaces: [] };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as WorkspaceFile;
  return {
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
    lastWorkspaceId: raw.lastWorkspaceId ?? null,
  };
}

export function writeWorkspaces(configRoot: string, data: WorkspaceFile): void {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(workspaceFilePath(configRoot), JSON.stringify(data, null, 2));
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "workspace";
}

export function addWorkspaceRecord(data: WorkspaceFile, folderPath: string): WorkspaceFile {
  const resolved = path.resolve(folderPath);
  const existing = data.workspaces.find((item) => path.resolve(item.path) === resolved);
  if (existing) return { ...data, lastWorkspaceId: existing.id };
  let id = slug(path.basename(resolved));
  const used = new Set(data.workspaces.map((item) => item.id));
  let n = 2;
  while (used.has(id)) {
    id = `${slug(path.basename(resolved))}-${n}`;
    n += 1;
  }
  const workspace: Workspace = {
    id,
    name: path.basename(resolved),
    path: resolved,
    dockUrl: "http://127.0.0.1:5177",
  };
  return {
    workspaces: [...data.workspaces, workspace],
    lastWorkspaceId: workspace.id,
  };
}

export function removeWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  const workspaces = data.workspaces.filter((item) => item.id !== id);
  const lastWorkspaceId =
    data.lastWorkspaceId === id ? (workspaces[0]?.id ?? null) : data.lastWorkspaceId;
  return { workspaces, lastWorkspaceId };
}

export function selectWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  if (!data.workspaces.some((item) => item.id === id)) return data;
  return { ...data, lastWorkspaceId: id };
}

export function setDockUrlRecord(data: WorkspaceFile, id: string, dockUrl: string): WorkspaceFile {
  return {
    ...data,
    workspaces: data.workspaces.map((item) => (item.id === id ? { ...item, dockUrl } : item)),
  };
}
