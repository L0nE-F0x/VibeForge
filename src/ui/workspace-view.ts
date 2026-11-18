import { fuzzyScore } from "./fuzzy.js";

/** Facets the workspace list can narrow to; several may be on at once (ANDed), and empty means Show all. */
export type WorkspaceFilter = "open" | "working" | "waiting" | "review" | "dirty" | "synced";
/** The order the list shows workspaces in (and within each folder when grouped). */
export type WorkspaceSort = "manual" | "name" | "parent" | "recent" | "changes";
/** How workspaces are grouped in the list: flat, or under their parent directory. */
export type WorkspaceGroup = "none" | "parent";

export interface WorkspaceView {
  filters: WorkspaceFilter[];
  sort: WorkspaceSort;
  group: WorkspaceGroup;
}

export interface WorkspaceGroupBucket<T> {
  /** Parent directory header (empty string when grouping is off). */
  folder: string;
  items: T[];
}

export const FILTERS: readonly WorkspaceFilter[] = ["open", "working", "waiting", "review", "dirty", "synced"];
export const SORTS: readonly WorkspaceSort[] = ["manual", "name", "parent", "recent", "changes"];
export const DEFAULT_WORKSPACE_VIEW: WorkspaceView = { filters: [], sort: "manual", group: "none" };
const VIEW_KEY = "vf.workspaces.view";

/** What the list knows of a workspace to sort, group, filter and search it. */
export interface WorkspaceFacts {
  name: string;
  /** Its folder, as the list shows it (with ~ for home). */
  path: string;
  open: boolean;
  /** A coding CLI here is actively busy right now. */
  working?: boolean;
  waiting: boolean;
  /** This workspace is (or has) a copy waiting for review. */
  review?: boolean;
  synced: boolean;
  /** Inside a git working tree. */
  git?: boolean;
  /** Current git branch name, when on a branch. */
  branch?: string | null;
  /** Uncommitted or untracked files in git (0 when clean). */
  dirty?: number;
  /** Commits ahead of upstream (0 when none). */
  ahead?: number;
  /** Latest activity timestamp (epoch ms or ISO 8601), 0/null when none. */
  activityAt?: number | string | null;
}

/** Parent directory of a tildified or absolute folder path ("~/Projects/app" -> "~/Projects", "~/app" -> "~"). */
export function parentFolder(folderPath: string): string {
  const trimmed = folderPath.length > 1 ? folderPath.replace(/\/+$/, "") : folderPath;
  if (!trimmed || trimmed === "~" || trimmed === "/") return trimmed || "~";
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

/** Final path segment of a folder path ("~/Projects/app" -> "app"). */
export function leafFolder(folderPath: string): string {
  const trimmed = folderPath.length > 1 ? folderPath.replace(/\/+$/, "") : folderPath;
  if (!trimmed || trimmed === "~" || trimmed === "/") return trimmed;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

export function activityTime(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/** Toggle one filter in `FILTERS` order so equal filter sets always serialize identically. */
export function toggleFilter(filters: readonly WorkspaceFilter[], filter: WorkspaceFilter): WorkspaceFilter[] {
  const next = new Set(filters);
  if (next.has(filter)) next.delete(filter);
  else next.add(filter);
  return FILTERS.filter((candidate) => next.has(candidate));
}

export function isDefaultWorkspaceView(view: WorkspaceView): boolean {
  return view.filters.length === 0 && view.sort === "manual" && view.group === "none";
}

/** A search finds a workspace by its name (letters in order, as the switcher does), folder, or git branch. */
export function matchesSearch(query: string, item: Pick<WorkspaceFacts, "name" | "path" | "branch">): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fuzzyScore(q, item.name) >= 0 || item.path.toLowerCase().includes(q) || Boolean(item.branch?.toLowerCase().includes(q));
}

export function matchesFilter(filter: WorkspaceFilter, item: WorkspaceFacts): boolean {
  if (filter === "open") return item.open;
  if (filter === "working") return Boolean(item.working);
  if (filter === "waiting") return item.waiting;
  if (filter === "review") return Boolean(item.review);
  if (filter === "dirty") return (item.dirty ?? 0) > 0;
  return item.synced;
}

export function matchesFilters(filters: readonly WorkspaceFilter[], item: WorkspaceFacts): boolean {
  return filters.every((filter) => matchesFilter(filter, item));
}

/**
 * Faceted counts for the filter menu: `all` counts workspaces matching `query`; each filter counts
 * how many match `query`, the other active filters, and that filter itself.
 */
export function filterCounts<T>(
  items: readonly T[],
  facts: (item: T) => WorkspaceFacts,
  activeFilters: readonly WorkspaceFilter[] = [],
  query = "",
): Record<WorkspaceFilter, number> & { all: number } {
  const searched = items.map((item) => facts(item)).filter((known) => matchesSearch(query, known));
  const counts = { all: searched.length, open: 0, working: 0, waiting: 0, review: 0, dirty: 0, synced: 0 };
  for (const filter of FILTERS) {
    const others = activeFilters.filter((active) => active !== filter);
    counts[filter] = searched.filter((known) => matchesFilters(others, known) && matchesFilter(filter, known)).length;
  }
  return counts;
}

interface Entry<T> {
  item: T;
  facts: WorkspaceFacts;
  parent: string;
  activityMs: number;
  index: number;
}

function compareEntries<T>(a: Entry<T>, b: Entry<T>, sort: WorkspaceSort, collator: Intl.Collator): number {
  if (sort === "name") return collator.compare(a.facts.name, b.facts.name) || a.index - b.index;
  if (sort === "parent") return collator.compare(a.parent, b.parent) || collator.compare(a.facts.name, b.facts.name) || a.index - b.index;
  if (sort === "recent") {
    return (
      Number(Boolean(b.facts.working)) - Number(Boolean(a.facts.working)) ||
      b.activityMs - a.activityMs ||
      Number(b.facts.open) - Number(a.facts.open) ||
      a.index - b.index
    );
  }
  if (sort === "changes") {
    return (
      (b.facts.dirty ?? 0) - (a.facts.dirty ?? 0) ||
      Number(Boolean(b.facts.review)) - Number(Boolean(a.facts.review)) ||
      (b.facts.ahead ?? 0) - (a.facts.ahead ?? 0) ||
      Number(Boolean(b.facts.git)) - Number(Boolean(a.facts.git)) ||
      a.index - b.index
    );
  }
  return a.index - b.index;
}

/**
 * Workspaces sorted (stably, with explicit tie-breakers back to your manual order), filtered,
 * searched, and optionally grouped under their parent folder.
 */
export function groupWorkspaces<T>(
  items: readonly T[],
  facts: (item: T) => WorkspaceFacts,
  view: WorkspaceView,
  query: string,
  language?: string,
): WorkspaceGroupBucket<T>[] {
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  const entries: Entry<T>[] = items.map((item, index) => {
    const known = facts(item);
    return { item, facts: known, parent: parentFolder(known.path), activityMs: activityTime(known.activityAt), index };
  });
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, view.sort, collator));
  const filtered = sorted.filter((entry) => matchesFilters(view.filters, entry.facts) && matchesSearch(query, entry.facts));
  if (!filtered.length) return [];
  if (view.group !== "parent") return [{ folder: "", items: filtered.map((entry) => entry.item) }];
  const buckets = new Map<string, T[]>();
  for (const entry of filtered) {
    const list = buckets.get(entry.parent);
    if (list) list.push(entry.item);
    else buckets.set(entry.parent, [entry.item]);
  }
  const grouped = [...buckets.entries()].map(([folder, groupItems]) => ({ folder, items: groupItems }));
  if (view.sort === "name" || view.sort === "parent") grouped.sort((a, b) => collator.compare(a.folder, b.folder));
  return grouped;
}

/** The flat list as shown on screen (matching group order when grouped by parent folder). */
export function viewWorkspaces<T>(
  items: readonly T[],
  facts: (item: T) => WorkspaceFacts,
  view: WorkspaceView,
  query: string,
  language?: string,
): T[] {
  return groupWorkspaces(items, facts, view, query, language).flatMap((bucket) => bucket.items);
}

/** The filter, sort and grouping picked last time; migrates pre-2.23 single `filter` records too. */
export function loadWorkspaceView(): WorkspaceView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as {
      filters?: unknown;
      filter?: unknown;
      sort?: unknown;
      group?: unknown;
    } | null;
    if (!raw || typeof raw !== "object") return DEFAULT_WORKSPACE_VIEW;
    const rawFilters = Array.isArray(raw.filters)
      ? raw.filters
      : typeof raw.filter === "string" && raw.filter !== "all"
        ? [raw.filter]
        : [];
    const validFilters = FILTERS.filter((filter) => rawFilters.includes(filter));
    const sort = SORTS.includes(raw.sort as WorkspaceSort) ? (raw.sort as WorkspaceSort) : "manual";
    const group: WorkspaceGroup = raw.group === "parent" ? "parent" : "none";
    return { filters: validFilters, sort, group };
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
