import { fuzzyScore } from "./fuzzy.js";

/** Which workspaces the list shows: all of them, ones with terminals open, ones a CLI waits in, or synced ones. */
export type WorkspaceFilter = "all" | "open" | "waiting" | "synced";
/** The order the list shows them in: the one you dragged them into, or by name. */
export type WorkspaceSort = "manual" | "name";

export interface WorkspaceView {
  filter: WorkspaceFilter;
  sort: WorkspaceSort;
}

export const DEFAULT_WORKSPACE_VIEW: WorkspaceView = { filter: "all", sort: "manual" };
const FILTERS: readonly WorkspaceFilter[] = ["all", "open", "waiting", "synced"];
const VIEW_KEY = "vf.workspaces.view";

/** What the list knows of a workspace to sort, filter and search it. */
export interface WorkspaceFacts {
  name: string;
  /** Its folder, as the list shows it (with ~ for home). */
  path: string;
  open: boolean;
  waiting: boolean;
  synced: boolean;
}

/** A search finds a workspace by its name (letters in order, as the switcher does) or by a piece of its folder. */
export function matchesSearch(query: string, item: Pick<WorkspaceFacts, "name" | "path">): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fuzzyScore(q, item.name) >= 0 || item.path.toLowerCase().includes(q);
}

export function matchesFilter(filter: WorkspaceFilter, item: WorkspaceFacts): boolean {
  if (filter === "open") return item.open;
  if (filter === "waiting") return item.waiting;
  if (filter === "synced") return item.synced;
  return true;
}

/** The list as it shows: sorted (stable, so "manual" keeps your order), then filtered and searched. */
export function viewWorkspaces<T>(items: readonly T[], facts: (item: T) => WorkspaceFacts, view: WorkspaceView, query: string, language?: string): T[] {
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  const sorted = view.sort === "name" ? [...items].sort((a, b) => collator.compare(facts(a).name, facts(b).name)) : [...items];
  return sorted.filter((item) => {
    const known = facts(item);
    return matchesFilter(view.filter, known) && matchesSearch(query, known);
  });
}

/** The filter and sort picked last time; the search starts empty each time. */
export function loadWorkspaceView(): WorkspaceView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<WorkspaceView> | null;
    return {
      filter: raw && FILTERS.includes(raw.filter as WorkspaceFilter) ? (raw.filter as WorkspaceFilter) : "all",
      sort: raw?.sort === "name" ? "name" : "manual",
    };
  } catch {
    return DEFAULT_WORKSPACE_VIEW;
  }
}

export function saveWorkspaceView(view: WorkspaceView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // A blocked store only means the pick isn't remembered.
  }
}
