import path from "node:path";
import { slugify } from "./slug.js";
import type { Workspace } from "./types.js";

export interface WorkspaceFile {
  workspaces: Workspace[];
  lastWorkspaceId: string | null;
}

export function addWorkspaceRecord(data: WorkspaceFile, folderPath: string): WorkspaceFile {
  const resolved = path.resolve(folderPath);
  const existing = data.workspaces.find((item) => path.resolve(item.path) === resolved);
  if (existing) return { ...data, lastWorkspaceId: existing.id };
  const name = path.basename(resolved) || resolved;
  const base = slugify(name);
  const used = new Set(data.workspaces.map((item) => item.id));
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  const workspace: Workspace = { id, name, path: resolved, dockUrl: "" };
  return { workspaces: [...data.workspaces, workspace], lastWorkspaceId: id };
}

export function removeWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  const workspaces = data.workspaces.filter((item) => item.id !== id);
  const lastWorkspaceId = data.lastWorkspaceId === id ? (workspaces[0]?.id ?? null) : data.lastWorkspaceId;
  return { workspaces, lastWorkspaceId };
}

export function selectWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  if (!data.workspaces.some((item) => item.id === id)) return data;
  return { ...data, lastWorkspaceId: id };
}

export function updateWorkspaceRecord(data: WorkspaceFile, id: string, patch: Partial<Pick<Workspace, "name" | "dockUrl">>): WorkspaceFile {
  return {
    ...data,
    workspaces: data.workspaces.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

export function moveWorkspaceRecord(data: WorkspaceFile, id: string, toIndex: number): WorkspaceFile {
  const from = data.workspaces.findIndex((item) => item.id === id);
  if (from < 0) return data;
  const workspaces = data.workspaces.slice();
  const [item] = workspaces.splice(from, 1);
  workspaces.splice(Math.max(0, Math.min(toIndex, workspaces.length)), 0, item);
  return { ...data, workspaces };
}
