import { ArrowUpDown, ListChecks, ListFilter, RotateCcw, Search, Square, SquareCheck, X, type LucideIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT, type Translator } from "../i18n/index.js";
import { applyView, defaultView, isDefaultView, loadView, saveView, toggleIn, viewCounts, type ListSpec, type ListView } from "../list-view.js";
import { tipProps } from "./Tooltip.js";
import { Button, cx, Input, MenuButton, type MenuEntry, type MenuItem } from "./ui.js";

// The tools over a list, as Code's workspace list has them: a search, one Filter and sort menu,
// pills for what is on, and Select to act on several at once. Every list in the app uses these,
// so they look and work the same everywhere.

/** A list's search text and its remembered Filter and sort. */
export function useListView<F extends string, S extends string>(spec: ListSpec<F, S>) {
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<ListView<F, S>>(() => loadView(spec));
  const setView = (next: Partial<ListView<F, S>>) => {
    const merged = { ...view, ...next };
    setViewState(merged);
    saveView(spec, merged);
  };
  const hasQuery = query.trim() !== "";
  const hasFilters = view.filters.length > 0;
  return {
    spec,
    query,
    setQuery,
    view,
    setView,
    toggleFilter: (filter: F) => setView({ filters: toggleIn(spec.filters, view.filters, filter) }),
    reset: () => setView(defaultView(spec)),
    /** Clears the search and the filters, as "Clear search and filters" does; the sort stays. */
    clear: () => {
      setQuery("");
      if (hasFilters) setView({ filters: [] });
    },
    changed: !isDefaultView(spec, view),
    hasQuery,
    hasFilters,
    narrowed: hasQuery || hasFilters,
  };
}

/** Select mode: which of the shown items are picked. Only what is on screen counts as picked. */
export function useSelection<T>(shown: readonly T[], idOf: (item: T) => string) {
  /** Ids picked while Select is on; null while it's off. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const picked = selected ? shown.filter((item) => selected.has(idOf(item))) : [];
  return {
    selecting: selected !== null,
    picked,
    isPicked: (id: string) => selected?.has(id) ?? false,
    toggle: (id: string) =>
      setSelected((was) => {
        const next = new Set(was);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    pickAll: () => setSelected((was) => new Set([...(was ?? []), ...shown.map(idOf)])),
    setSelecting: (on: boolean) => setSelected(on ? new Set() : null),
    /** Esc on the list leaves Select, unless something inside it used the key. */
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape" && selected && !event.defaultPrevented) {
        event.preventDefault();
        setSelected(null);
      }
    },
  };
}

/** The box at the start of a row while Select is on. */
export function PickMark({ picked }: { picked: boolean }) {
  return picked ? <SquareCheck size={15} className="accent-text" style={{ flex: "none" }} /> : <Square size={15} className="faint" style={{ flex: "none" }} />;
}

/** One pill for a filter or sort that is on; clicking it turns that one off. */
export interface ViewChip {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** A filter: drawn in the accent, as it narrows what is shown. */
  accent?: boolean;
  onRemove: () => void;
}

/**
 * The Filter and sort menu: Show all and each filter (with what it would show), the sorts, any
 * further section the list has (the workspaces' Group), and Reset view once something is on.
 */
export function viewMenu<F extends string, S extends string>(
  t: Translator,
  opts: {
    filters: ReadonlyArray<{ id: F; label: string }>;
    active: readonly F[];
    counts: Record<F, number> & { all: number };
    onFilters: (next: F[]) => void;
    sorts: ReadonlyArray<{ id: S; label: string }>;
    sort: S;
    onSort: (sort: S) => void;
    more?: MenuEntry[];
    changed: boolean;
    onReset: () => void;
  },
): MenuEntry[] {
  const order = opts.filters.map((filter) => filter.id);
  return [
    { heading: t("list.filterHeading") },
    {
      label: t("list.showAll"),
      role: "menuitemcheckbox",
      checked: opts.active.length === 0,
      hint: opts.counts.all,
      keepOpen: true,
      onSelect: () => opts.onFilters([]),
    },
    ...opts.filters.map(
      (filter): MenuItem => ({
        label: filter.label,
        role: "menuitemcheckbox",
        checked: opts.active.includes(filter.id),
        hint: opts.counts[filter.id],
        keepOpen: true,
        onSelect: () => opts.onFilters(toggleIn(order, opts.active, filter.id)),
      }),
    ),
    "sep",
    { heading: t("list.sortHeading") },
    ...opts.sorts.map(
      (sort): MenuItem => ({
        label: sort.label,
        role: "menuitemradio",
        checked: opts.sort === sort.id,
        keepOpen: true,
        onSelect: () => opts.onSort(sort.id),
      }),
    ),
    ...(opts.more ?? []),
    ...(opts.changed ? ["sep" as const, { label: t("list.reset"), icon: RotateCcw, onSelect: opts.onReset }] : []),
  ];
}

/** The pills for the filters on and a sort other than the list's own. */
export function viewChips<F extends string, S extends string>(opts: {
  filters: ReadonlyArray<{ id: F; label: string }>;
  active: readonly F[];
  onFilter: (filter: F) => void;
  sort: S;
  defaultSort: S;
  sortLabel: string;
  onSortReset: () => void;
}): ViewChip[] {
  return [
    ...opts.active.map((id) => ({ key: id, label: opts.filters.find((filter) => filter.id === id)?.label ?? id, accent: true, onRemove: () => opts.onFilter(id) })),
    ...(opts.sort !== opts.defaultSort ? [{ key: "__sort", label: opts.sortLabel, icon: ArrowUpDown, onRemove: opts.onSortReset }] : []),
  ];
}

/** "Filter and sort", or "Filter and sort: Live, Name" once something is on. */
export function viewTipText(t: Translator, active: readonly string[]): string {
  return active.length ? `${t("list.viewTip")}: ${active.join(", ")}` : t("list.viewTip");
}

/** Whether a list has enough to be worth the tools: two or more, or something already narrowed. */
export function toolsWanted(total: number, narrowed: boolean, changed: boolean, selecting: boolean): boolean {
  return total > 1 || narrowed || changed || selecting;
}

export function ListTools({
  query,
  onQuery,
  placeholder,
  shown,
  total,
  menu,
  changed,
  viewTip,
  filterCount,
  chips,
  selecting,
  onSelecting,
  selectTip,
  picked,
  onPickAll,
  actions,
  page,
  className,
}: {
  query: string;
  onQuery: (next: string) => void;
  placeholder: string;
  /** How many the list shows now, and has in all, for "3/12". */
  shown: number;
  total: number;
  menu: MenuEntry[];
  /** Something other than the list's own view is on: the menu button is drawn in the accent. */
  changed: boolean;
  viewTip: string;
  /** How many filters are on, shown on the menu button. */
  filterCount: number;
  chips: ViewChip[];
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  /** What Select is for here: "Select several to delete at once". */
  selectTip: string;
  picked: number;
  onPickAll: () => void;
  /** The buttons that act on what is picked (Delete, Pause, Mark reviewed). */
  actions: ReactNode;
  /** Laid out across a page (Routines, Tasks) instead of over a side panel's list. */
  page?: boolean;
  className?: string;
}) {
  const t = useT();
  const searchRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim() !== "";
  return (
    <div className={cx("list-tools", page && "page", className)}>
      <div className="hstack list-tools-bar">
        <div className="hstack grow list-search">
          <Search size={13} className="faint" style={{ position: "absolute", left: 9, pointerEvents: "none" }} />
          <Input
            ref={searchRef}
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              if (query) onQuery("");
              else event.currentTarget.blur();
            }}
            style={{ paddingLeft: 28, paddingRight: hasQuery ? 58 : undefined }}
          />
          {hasQuery && (
            <span className="list-search-tail">
              <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                {shown}/{total}
              </span>
              <button
                type="button"
                className="list-search-clear"
                aria-label={t("list.clearQuery")}
                {...tipProps(t("list.clearQuery"))}
                onClick={() => {
                  onQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X size={12} />
              </button>
            </span>
          )}
        </div>
        <MenuButton size="sm" variant="ghost" icon={ListFilter} className={changed ? "accent-text" : undefined} aria-label={viewTip} title={viewTip} items={menu}>
          {filterCount ? filterCount : null}
        </MenuButton>
        <Button
          size="sm"
          variant="ghost"
          icon={ListChecks}
          pressed={selecting}
          className={selecting ? "accent-text" : undefined}
          tip={selecting ? t("list.selectDone") : selectTip}
          onClick={() => onSelecting(!selecting)}
        />
      </div>
      {chips.length > 0 && (
        <div className="list-active-view">
          {chips.map((chip) => (
            <button key={chip.key} type="button" className={cx("chip list-chip", chip.accent && "accent")} onClick={chip.onRemove}>
              {chip.icon && <chip.icon size={11} />}
              <span className="truncate">{chip.label}</span>
              <X size={11} />
            </button>
          ))}
          {filterCount > 0 && !hasQuery && (
            <span className="faint mono" style={{ marginLeft: "auto", fontSize: "var(--fs-xs)" }}>
              {shown}/{total}
            </span>
          )}
        </div>
      )}
      {selecting && (
        <div className="hstack list-picking">
          <span className="faint grow" style={{ whiteSpace: "nowrap" }}>
            {t.count("list.selected", picked)}
          </span>
          <Button size="sm" variant="ghost" disabled={!shown || picked === shown} onClick={onPickAll}>
            {t("list.selectAll")}
          </Button>
          {actions}
        </div>
      )}
    </div>
  );
}

/** How one list filters, searches and sorts its items. */
export interface ListRules<T, F extends string, S extends string> {
  test: (filter: F, item: T) => boolean;
  /** Whether `query` (already non-empty) finds `item`. */
  search: (query: string, item: T) => boolean;
  /** Orders two items by `sort`; ties keep the order the items came in. */
  compare: (sort: S, a: T, b: T) => number;
}

/**
 * Everything a list needs for its tools: the search and remembered view, what shows, the filter
 * counts, the order the folded strip follows (the sort, without the search or filters), and Select.
 */
export function useList<T, F extends string, S extends string>(spec: ListSpec<F, S>, items: readonly T[], rules: ListRules<T, F, S>, idOf: (item: T) => string) {
  return useListOver(useListView(spec), items, rules, idOf);
}

/** `useList` for a list whose items depend on its own search (Runs asks the core to search). */
export function useListOver<T, F extends string, S extends string>(list: ReturnType<typeof useListView<F, S>>, items: readonly T[], rules: ListRules<T, F, S>, idOf: (item: T) => string) {
  const { spec } = list;
  const query = list.query.trim();
  const viewRules = { test: rules.test, compare: rules.compare, searched: (item: T) => !query || rules.search(query, item) };
  const shown = applyView(items, list.view, viewRules);
  const counts = viewCounts(items, spec.filters, list.view.filters, viewRules);
  const ordered = list.view.sort === spec.defaultSort ? items : applyView(items, { filters: [], sort: list.view.sort }, { ...viewRules, searched: () => true });
  const selection = useSelection(shown, idOf);
  return { ...list, items, shown, counts, ordered, selection };
}

export type ListState<T, F extends string, S extends string> = ReturnType<typeof useListOver<T, F, S>>;

/** What a list calls its filters and sorts: the menu's words, and shorter ones for the pills. */
export interface ListLabels<F extends string, S extends string> {
  filters: Record<F, string>;
  sorts: Record<S, string>;
  /** The pill's word for a sort, when the menu's is long ("Sort by name" is "Name"). */
  sortChips?: Partial<Record<S, string>>;
}

/** The labels of the filters that are on, for NoMatch and the menu button's tip. */
export function activeFilterLabels<T, F extends string, S extends string>(list: ListState<T, F, S>, labels: ListLabels<F, S>): string[] {
  return list.view.filters.map((filter) => labels.filters[filter]);
}

/** ListTools for a `useList` list: its menu, pills and counts made from its labels. */
export function ListBar<T, F extends string, S extends string>({
  list,
  labels,
  placeholder,
  selectTip,
  actions,
  total,
  page,
  always,
  className,
}: {
  list: ListState<T, F, S>;
  labels: ListLabels<F, S>;
  placeholder: string;
  selectTip: string;
  actions: ReactNode;
  /** How many there are in all, when that isn't how many the list was given (Runs' search). */
  total?: number;
  page?: boolean;
  /** Shown even with one item or none (a list that is often filtered from elsewhere). */
  always?: boolean;
  className?: string;
}) {
  const t = useT();
  const { spec, view } = list;
  const filters = spec.filters.map((id) => ({ id, label: labels.filters[id] }));
  const menu = viewMenu(t, {
    filters,
    active: view.filters,
    counts: list.counts,
    onFilters: (next) => list.setView({ filters: next }),
    sorts: spec.sorts.map((id) => ({ id, label: labels.sorts[id] })),
    sort: view.sort,
    onSort: (sort) => list.setView({ sort }),
    changed: list.changed,
    onReset: list.reset,
  });
  const chips = viewChips({
    filters,
    active: view.filters,
    onFilter: list.toggleFilter,
    sort: view.sort,
    defaultSort: spec.defaultSort,
    sortLabel: labels.sortChips?.[view.sort] ?? labels.sorts[view.sort],
    onSortReset: () => list.setView({ sort: spec.defaultSort }),
  });
  const tip = viewTipText(t, [...view.filters.map((filter) => labels.filters[filter]), view.sort !== spec.defaultSort ? labels.sorts[view.sort] : ""].filter(Boolean));
  const all = total ?? list.items.length;
  if (!always && !toolsWanted(all, list.narrowed, list.changed, list.selection.selecting)) return null;
  return (
    <ListTools
      query={list.query}
      onQuery={list.setQuery}
      placeholder={placeholder}
      shown={list.shown.length}
      total={all}
      menu={menu}
      changed={list.changed}
      viewTip={tip}
      filterCount={view.filters.length}
      chips={chips}
      selecting={list.selection.selecting}
      onSelecting={list.selection.setSelecting}
      selectTip={selectTip}
      picked={list.selection.picked.length}
      onPickAll={list.selection.pickAll}
      actions={actions}
      page={page}
      className={className}
    />
  );
}

/** What a narrowed list says when nothing is left, with the way back. */
export function NoMatch({
  hasQuery,
  filters,
  message,
  onClear,
}: {
  hasQuery: boolean;
  /** The labels of the filters on. */
  filters: readonly string[];
  /** Overrides the general sentence (Code's workspaces say exactly what no workspace is). */
  message?: string;
  onClear: () => void;
}) {
  const t = useT();
  const text =
    message ?? (!hasQuery && filters.length === 1 ? t("list.noMatchFilter", { filter: filters[0] }) : !hasQuery && filters.length > 1 ? t("list.noMatchFilters") : t("list.noMatch"));
  const clearLabel = hasQuery && filters.length ? t("list.clearSearch") : hasQuery ? t("list.clearQuery") : filters.length > 1 ? t("list.clearFilters") : t("list.showAll");
  return (
    <div className="vstack faint list-no-match">
      <span>{text}</span>
      <Button size="sm" onClick={onClear}>
        {clearLabel}
      </Button>
    </div>
  );
}
