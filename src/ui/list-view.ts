import { fuzzyScore } from "./fuzzy.js";
import { isCutOffRun } from "../shared/routine-result.js";

// Search, filter and sort for VibeForge's lists (agents, skills, chats, routines, tasks, runs),
// the way Code's workspace list does them (workspace-view.ts): a search box, filters that can be
// on together (every one on must match), one sort, and the pick remembered for next time.

/** What a list's Filter and sort menu is set to. */
export interface ListView<F extends string = string, S extends string = string> {
  filters: F[];
  sort: S;
}

/** What one list can narrow to and order by. */
export interface ListSpec<F extends string, S extends string> {
  /** Remembered in this window's localStorage as `vf.list.<key>.view`. */
  key: string;
  /** In the order the menu shows them; equal sets always save the same way. */
  filters: readonly F[];
  sorts: readonly S[];
  /** The order the list had before there was a choice, and has again after Reset view. */
  defaultSort: S;
}

export function defaultView<F extends string, S extends string>(spec: ListSpec<F, S>): ListView<F, S> {
  return { filters: [], sort: spec.defaultSort };
}

export function isDefaultView<F extends string, S extends string>(spec: ListSpec<F, S>, view: ListView<F, S>): boolean {
  return view.filters.length === 0 && view.sort === spec.defaultSort;
}

/** Turn one filter on or off, keeping `order` so equal sets always serialize identically. */
export function toggleIn<F extends string>(order: readonly F[], active: readonly F[], filter: F): F[] {
  const next = new Set(active);
  if (next.has(filter)) next.delete(filter);
  else next.add(filter);
  return order.filter((candidate) => next.has(candidate));
}

const storageKey = (key: string) => `vf.list.${key}.view`;

/** The filters and sort picked last time; anything this version doesn't know is dropped. */
export function loadView<F extends string, S extends string>(spec: ListSpec<F, S>): ListView<F, S> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(spec.key)) ?? "null") as { filters?: unknown; sort?: unknown } | null;
    if (!raw || typeof raw !== "object") return defaultView(spec);
    const filters = Array.isArray(raw.filters) ? spec.filters.filter((filter) => (raw.filters as unknown[]).includes(filter)) : [];
    const sort = spec.sorts.includes(raw.sort as S) ? (raw.sort as S) : spec.defaultSort;
    return { filters, sort };
  } catch {
    return defaultView(spec);
  }
}

export function saveView<F extends string, S extends string>(spec: ListSpec<F, S>, view: ListView<F, S>): void {
  try {
    if (isDefaultView(spec, view)) localStorage.removeItem(storageKey(spec.key));
    else localStorage.setItem(storageKey(spec.key), JSON.stringify(view));
  } catch {
    // A blocked store only means the pick isn't remembered.
  }
}

/**
 * A search finds a thing by its name (its letters in order, as the switcher does), or by the
 * words typed anywhere in its other text: an agent's CLI, a task's workspace, a run's prompt.
 */
export function matchesQuery(query: string, name: string, ...more: ReadonlyArray<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fuzzyScore(q, name) >= 0 || more.some((field) => Boolean(field?.toLowerCase().includes(q)));
}

export interface ViewRules<T, F extends string, S extends string> {
  /** Whether `item` is one `filter` keeps. */
  test: (filter: F, item: T) => boolean;
  /** Whether the search finds `item`. */
  searched: (item: T) => boolean;
  /** Orders two items by `sort`; ties keep the list's own order. */
  compare: (sort: S, a: T, b: T) => number;
}

/** The list as it shows: sorted (stably), with every filter on matching, and found by the search. */
export function applyView<T, F extends string, S extends string>(items: readonly T[], view: ListView<F, S>, rules: ViewRules<T, F, S>): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => view.filters.every((filter) => rules.test(filter, item)) && rules.searched(item))
    .sort((a, b) => rules.compare(view.sort, a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Counts for the filter menu: `all` is what the search finds; each filter counts what the search
 * finds with that filter and the other filters on, so a number is what clicking it would show.
 */
export function viewCounts<T, F extends string>(
  items: readonly T[],
  filters: readonly F[],
  active: readonly F[],
  rules: Pick<ViewRules<T, F, string>, "test" | "searched">,
): Record<F, number> & { all: number } {
  const searched = items.filter((item) => rules.searched(item));
  const counts: Record<string, number> = { all: searched.length };
  for (const filter of filters) {
    const others = active.filter((on) => on !== filter);
    counts[filter] = searched.filter((item) => rules.test(filter, item) && others.every((on) => rules.test(on, item))).length;
  }
  return counts as Record<F, number> & { all: number };
}

/** A run that failed, timed out, was cut off, or exited with an error: what "Last run went wrong" and "Went wrong" keep. */
export function runWentWrong(run: { status: string; exitCode: number | null; result?: string | null; origin?: string | null; cutOff?: string | null }): boolean {
  return run.status === "failed" || (run.status === "exited" && Boolean(run.exitCode)) || run.result === "timeout" || run.result === "failed" || isCutOffRun(run);
}

/** Epoch ms of an ISO time, 0 when there is none: what "recent" sorts compare. */
export function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Names in the order a person reads them in their language ("site-2" before "site-10"). */
export function nameOrder(language?: string): Intl.Collator {
  return new Intl.Collator(language, { numeric: true, sensitivity: "base" });
}
