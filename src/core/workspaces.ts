import path from "node:path";
import { normalizeCopySetup } from "./copy-setup.js";
import { slugify } from "./slug.js";
import type { Workspace, WorkspaceCategory, WorkspaceCopySetup } from "./types.js";

export type { WorkspaceCategory };

export interface WorkspaceFile {
  workspaces: Workspace[];
  lastWorkspaceId: string | null;
  categories?: WorkspaceCategory[];
}

export function cleanCategoryName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 60);
}

function withCategories(base: { workspaces: Workspace[]; lastWorkspaceId: string | null }, categories?: readonly WorkspaceCategory[]): WorkspaceFile {
  return categories && categories.length > 0 ? { ...base, categories: [...categories] } : base;
}

function cleanWorkspaceCategories(ids: readonly string[] | undefined, valid?: ReadonlySet<string>): string[] {
  if (!ids?.length) return [];
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || (valid && !valid.has(id)) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function withWsCategories(workspace: Workspace, ids: readonly string[]): Workspace {
  if (!ids.length) {
    if (!("categories" in workspace)) return workspace;
    const { categories: _dropped, ...rest } = workspace;
    return rest;
  }
  return { ...workspace, categories: [...ids] };
}

export function addWorkspaceRecord(data: WorkspaceFile, folderPath: string, categoryId?: string | null): WorkspaceFile {
  const resolved = path.resolve(folderPath);
  const catId = categoryId && data.categories?.some((cat) => cat.id === categoryId) ? categoryId : null;
  const existing = data.workspaces.find((item) => path.resolve(item.path) === resolved);
  if (existing) {
    const workspaces =
      catId && !existing.categories?.includes(catId)
        ? data.workspaces.map((item) => (item.id === existing.id ? withWsCategories(item, [...(item.categories ?? []), catId]) : item))
        : data.workspaces;
    return withCategories({ workspaces, lastWorkspaceId: existing.id }, data.categories);
  }
  const name = path.basename(resolved) || resolved;
  const base = slugify(name);
  const used = new Set(data.workspaces.map((item) => item.id));
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  const workspace: Workspace = { id, name, path: resolved, dockUrl: "", ...(catId ? { categories: [catId] } : {}) };
  return withCategories({ workspaces: [...data.workspaces, workspace], lastWorkspaceId: id }, data.categories);
}

export function removeWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  const workspaces = data.workspaces.filter((item) => item.id !== id);
  const lastWorkspaceId = data.lastWorkspaceId === id ? (workspaces[0]?.id ?? null) : data.lastWorkspaceId;
  return withCategories({ workspaces, lastWorkspaceId }, data.categories);
}

export function selectWorkspaceRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  if (!data.workspaces.some((item) => item.id === id)) return data;
  return { ...data, lastWorkspaceId: id };
}

export function updateWorkspaceRecord(
  data: WorkspaceFile,
  id: string,
  patch: Partial<Pick<Workspace, "name" | "dockUrl" | "categories">> & { copySetup?: WorkspaceCopySetup | null },
): WorkspaceFile {
  const valid = new Set((data.categories ?? []).map((cat) => cat.id));
  return withCategories(
    {
      workspaces: data.workspaces.map((item) => {
        if (item.id !== id) return item;
        const { categories: patchCats, copySetup: patchSetup, ...restPatch } = patch;
        const next: Workspace = { ...item, ...restPatch };
        if (patchSetup !== undefined) {
          const cleanSetup = normalizeCopySetup(patchSetup);
          if (cleanSetup) next.copySetup = cleanSetup;
          else delete next.copySetup;
        }
        if (patchCats !== undefined) return withWsCategories(next, cleanWorkspaceCategories(patchCats, valid));
        return next;
      }),
      lastWorkspaceId: data.lastWorkspaceId,
    },
    data.categories,
  );
}

export function moveWorkspaceRecord(data: WorkspaceFile, id: string, toIndex: number): WorkspaceFile {
  const from = data.workspaces.findIndex((item) => item.id === id);
  if (from < 0) return data;
  const workspaces = data.workspaces.slice();
  const [item] = workspaces.splice(from, 1);
  workspaces.splice(Math.max(0, Math.min(toIndex, workspaces.length)), 0, item);
  return { ...data, workspaces };
}

export function addCategoryRecord(data: WorkspaceFile, name: string): { file: WorkspaceFile; category: WorkspaceCategory } {
  const clean = cleanCategoryName(name);
  if (!clean) throw new Error("Enter a category name.");
  const rawBase = slugify(clean);
  const base = rawBase === "all" ? "category" : rawBase;
  const used = new Set((data.categories ?? []).map((cat) => cat.id));
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  const category: WorkspaceCategory = { id, name: clean };
  return {
    file: withCategories({ workspaces: data.workspaces, lastWorkspaceId: data.lastWorkspaceId }, [...(data.categories ?? []), category]),
    category,
  };
}

export function renameCategoryRecord(data: WorkspaceFile, id: string, name: string): WorkspaceFile {
  const clean = cleanCategoryName(name);
  if (!clean || !data.categories?.some((cat) => cat.id === id)) return data;
  return withCategories(
    { workspaces: data.workspaces, lastWorkspaceId: data.lastWorkspaceId },
    data.categories.map((cat) => (cat.id === id ? { ...cat, name: clean } : cat)),
  );
}

export function moveCategoryRecord(data: WorkspaceFile, id: string, toIndex: number): WorkspaceFile {
  const categories = data.categories ? data.categories.slice() : [];
  const from = categories.findIndex((cat) => cat.id === id);
  if (from < 0) return data;
  const [item] = categories.splice(from, 1);
  categories.splice(Math.max(0, Math.min(toIndex, categories.length)), 0, item);
  return withCategories({ workspaces: data.workspaces, lastWorkspaceId: data.lastWorkspaceId }, categories);
}

export function removeCategoryRecord(data: WorkspaceFile, id: string): WorkspaceFile {
  const nextCategories = (data.categories ?? []).filter((cat) => cat.id !== id);
  const workspaces = data.workspaces.map((item) =>
    item.categories?.includes(id) ? withWsCategories(item, item.categories.filter((catId) => catId !== id)) : item,
  );
  return withCategories({ workspaces, lastWorkspaceId: data.lastWorkspaceId }, nextCategories);
}

export function setWorkspaceCategoryRecord(data: WorkspaceFile, workspaceIds: readonly string[], categoryId: string, on: boolean): WorkspaceFile {
  if (!data.categories?.some((cat) => cat.id === categoryId)) return data;
  const targets = new Set(workspaceIds);
  if (!targets.size) return data;
  const order = data.categories.map((cat) => cat.id);
  const workspaces = data.workspaces.map((item) => {
    if (!targets.has(item.id)) return item;
    const next = new Set(cleanWorkspaceCategories(item.categories));
    if (on) next.add(categoryId);
    else next.delete(categoryId);
    const ordered = order.filter((id) => next.has(id));
    return withWsCategories(item, ordered);
  });
  return withCategories({ workspaces, lastWorkspaceId: data.lastWorkspaceId }, data.categories);
}
