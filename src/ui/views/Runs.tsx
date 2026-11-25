import { CheckCheck, Eye, EyeOff, History, Square } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { RunView } from "../../shared/api.js";
import { dayHeading, dayKey } from "../../shared/text.js";
import { call, useDebounced, useEngines, useInbox, useQuery } from "../api.js";
import { activeFilterLabels, ListBar, NoMatch, useListOver, useListView, type ListLabels, type ListRules } from "../components/ListTools.js";
import { ORIGIN_KEY, RunDetail } from "../components/RunDetail.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { LoadFailed } from "../components/LoadState.js";
import { Button, Empty, Segmented, Skeleton } from "../components/ui.js";
import { matchesQuery, nameOrder, runWentWrong, timeOf, type ListSpec } from "../list-view.js";
import { useAction, useConfirm, useNav, type Route, type RunFilter } from "../state.js";
import { markKeyboardNavigation } from "../overlays.js";
import { isShortcut } from "../shortcuts.js";
import { RunRow, runLabel } from "./Home.js";
import { useT } from "../i18n/index.js";

type RunFacet = "unread" | "changes" | "failed";
type RunSort = "newest" | "oldest" | "name";
const RUN_LIST: ListSpec<RunFacet, RunSort> = { key: "runs", filters: ["unread", "changes", "failed"], sorts: ["newest", "oldest", "name"], defaultSort: "newest" };

/** How many runs All lists; older ones are found by searching. */
const ALL_RUNS = 300;

export function RunsView({ route }: { route: Extract<Route, { view: "runs" }> }) {
  const t = useT();
  const { go, replace } = useNav();
  const confirm = useConfirm();
  const engines = useEngines().data ?? [];
  const [filter, setFilter] = useState<RunFilter>(route.filter ?? (route.runId ? "all" : "review"));
  const listView = useListView(RUN_LIST);
  const inbox = useInbox();
  // All asks the core, which searches what runs said too; Review and Live are searched here.
  const typed = useDebounced(filter === "all" ? listView.query.trim() : "", 160);
  const all = useQuery("runs:all", ["runs", "live"], () => call("runs.list", { limit: ALL_RUNS }), { what: "load.runs" });
  // One entry per text typed: not kept once the search moves on.
  const found = useQuery(typed ? `runs:search:${typed}` : null, ["runs", "live"], () => call("runs.search", typed, 200), { keep: false, what: "load.search" });
  const searching = filter === "all" && typed !== "";

  useEffect(() => {
    if (route.filter) setFilter(route.filter);
  }, [route.filter]);

  const selected = route.runId ?? null;
  let runs: RunView[] = [];
  // Opening a run marks it reviewed. The ones reviewed during this visit stay in the list, in
  // their places, so K can go back to them; the list starts fresh next time.
  const reviewed = useRef(new Set<string>());
  // Marked all at once: gone from the list straight away, before the inbox catches up.
  const dropped = useRef(new Set<string>());
  if (filter !== "review") {
    reviewed.current.clear();
    dropped.current.clear();
  } else if (selected && !dropped.current.has(selected)) reviewed.current.add(selected);
  if (filter === "review") {
    const pool = new Map([...(all.data ?? []), ...(inbox.data ?? [])].map((run) => [run.id, run]));
    const ids = new Set([...(inbox.data ?? []).map((run) => run.id), ...reviewed.current].filter((id) => !dropped.current.has(id)));
    runs = [...ids]
      .map((id) => pool.get(id))
      .filter((run): run is RunView => Boolean(run))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  } else if (filter === "live") runs = (all.data ?? []).filter((run) => run.live);
  else runs = searching ? (found.data ?? []) : (all.data ?? []);
  const snippets = new Map(searching ? (found.data ?? []).map((hit) => [hit.id, hit.snippet]) : []);
  const source = filter === "review" ? inbox : searching ? found : all;
  const loaded = source.loaded;
  // A list that couldn't be read says so, instead of "No runs yet".
  const unreadable = source.error !== null && source.data === undefined;

  // ------------------------------------------------ search, filter, sort, select
  const collator = nameOrder(t.language);
  const titleOf = (run: RunView) => runLabel(run, engines.find((engine) => engine.id === run.engine)?.label ?? null);
  const rules: ListRules<RunView, RunFacet, RunSort> = {
    test: (facet, run) => (facet === "unread" ? !run.openedAt && !run.live : facet === "changes" ? Boolean(run.changes && run.changes !== "No changes") : runWentWrong(run)),
    // The core's search already chose these; a local one reads the title, the CLI or origin, the prompt and the folder.
    search: (query, run) => searching || matchesQuery(query, titleOf(run).title, titleOf(run).kind, t(ORIGIN_KEY[run.origin]), run.prompt, run.cwd),
    compare: (sort, a, b) => {
      if (sort === "oldest") return timeOf(a.startedAt) - timeOf(b.startedAt) || a.id.localeCompare(b.id);
      if (sort === "name") return collator.compare(titleOf(a).title, titleOf(b).title);
      // Search results come best first.
      return searching ? 0 : timeOf(b.startedAt) - timeOf(a.startedAt) || b.id.localeCompare(a.id);
    },
  };
  const view = useListOver(listView, runs, rules, (run) => run.id);
  const { selection } = view;
  const picked = selection.picked;
  const shownRuns = view.shown;
  const labels: ListLabels<RunFacet, RunSort> = {
    filters: { unread: t("runs.filter.unread"), changes: t("runs.filter.changes"), failed: t("runs.filter.failed") },
    sorts: { newest: t("list.sort.newest"), oldest: t("list.sort.oldest"), name: t("list.sort.name") },
    sortChips: { oldest: t("list.sortShort.oldest"), name: t("list.sortShort.name") },
  };
  // Only a finished run can be marked reviewed.
  const toReview = picked.filter((run) => !run.openedAt && !run.live);
  const reviewedPicked = picked.filter((run) => run.openedAt);
  const livePicked = picked.filter((run) => run.live);
  const [markPicked, markingPicked] = useAction(async (opened: boolean) => {
    for (const run of opened ? toReview : reviewedPicked) {
      await call("runs.markOpened", run.id, opened);
      // Marked here, so Review lets it go now rather than when the inbox catches up.
      if (opened) {
        dropped.current.add(run.id);
        reviewed.current.delete(run.id);
      } else dropped.current.delete(run.id);
    }
    selection.setSelecting(false);
  }, t("runs.markFailed"));
  const [stopPicked, stopping] = useAction(async () => {
    if (!livePicked.length) return;
    const ok = await confirm({ title: t.count("runs.stopManyTitle", livePicked.length), body: t("runs.stopManyBody"), confirm: t("runs.stopPicked"), danger: true });
    if (!ok) return;
    for (const run of livePicked) await call("runs.stop", run.id);
    selection.setSelecting(false);
  }, t("run.stopFailed"));

  // Not reading them one by one: every run waiting is marked reviewed and the list clears.
  const here = useRef({ filter, selected, mounted: true });
  here.current = { filter, selected, mounted: true };
  useEffect(
    () => () => {
      here.current.mounted = false;
    },
    [],
  );
  const [markAll, marking] = useAction(async () => {
    const ids = [...(inbox.data ?? []).map((run) => run.id), ...reviewed.current];
    const from = selected;
    await call("runs.markAllOpened");
    for (const id of ids) dropped.current.add(id);
    reviewed.current.clear();
    // Only if you're still where you clicked: not after going elsewhere while it worked.
    const now = here.current;
    if (now.mounted && now.filter === "review" && now.selected === from) replace({ view: "runs", filter: "review" });
  }, t("runs.markAllFailed"));

  // Coming to review: the first run waiting is already open.
  const first = filter === "review" && loaded && !selected ? shownRuns[0]?.id : undefined;
  useEffect(() => {
    if (first) replace({ view: "runs", runId: first, filter: "review" });
  }, [first, replace]);

  // The run after this one in the list, or before it at the end of the list.
  const at = shownRuns.findIndex((run) => run.id === selected);
  const step = (by: number) => {
    const next = shownRuns[at + by] ?? (at < 0 ? shownRuns[0] : undefined);
    if (next) go({ view: "runs", runId: next.id, filter });
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  // While reviewing, the next and previous ones waiting around this one.
  const nextWaiting =
    filter === "review" ? (shownRuns.slice(at + 1).find((run) => !run.openedAt) ?? shownRuns.slice(0, Math.max(0, at)).find((run) => !run.openedAt)) : undefined;
  const prevWaiting =
    filter === "review"
      ? ([...shownRuns.slice(0, Math.max(0, at))].reverse().find((run) => !run.openedAt) ??
          [...shownRuns.slice(at + 1)].reverse().find((run) => !run.openedAt))
      : undefined;

  // J and K step through the list from anywhere in the view, except while typing or in a terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const by = isShortcut("runs.next", event) ? 1 : isShortcut("runs.prev", event) ? -1 : 0;
      if (!by) return;
      const target = event.target as HTMLElement | null;
      // A finished run's replayed screen is read-only (its xterm's own textarea included), so J and K still step from there.
      if (!target?.closest(".term.replay") && target?.closest("input, textarea, select, [contenteditable], .xterm, .modal, .sheet")) return;
      event.preventDefault();
      // The live CLI the next run shows leaves J and K to the list (see markKeyboardNavigation).
      markKeyboardNavigation();
      stepRef.current(by);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="view split-list">
      <SidePanel
        id="runs"
        title={t("runs.title")}
        quietTitle
        actions={
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "review", label: `${t("runs.filter.review")}${inbox.data?.length ? ` ${inbox.data.length}` : ""}` },
                { value: "live", label: t("runs.filter.live") },
                { value: "all", label: t("runs.filter.all") },
              ]}
            />
          </>
        }
        strip={
          <>
            {view.ordered.slice(0, 14).map((run) => (
              <StripItem key={run.id} label={run.title} selected={run.id === selected} onClick={() => go({ view: "runs", runId: run.id, filter })}>
                <span className={`dot ${run.status}`} />
              </StripItem>
            ))}
          </>
        }
      >
        <ListBar
          list={view}
          labels={labels}
          placeholder={filter === "all" ? t("runs.searchPlaceholder") : t("runs.searchHere")}
          selectTip={t("runs.selectTip")}
          // All searches every run kept, not only the ones it lists.
          always={filter === "all" && all.loaded && (all.data?.length ?? 0) > 0}
          total={filter === "all" && searching ? all.data?.length : undefined}
          actions={
            <>
              <Button size="sm" icon={Eye} busy={markingPicked} disabled={!toReview.length} onClick={() => void markPicked(true)} tip={t("runs.markReviewedTip")}>
                {t("runs.markReviewed")}
              </Button>
              <Button size="sm" variant="ghost" icon={EyeOff} busy={markingPicked} disabled={!reviewedPicked.length} onClick={() => void markPicked(false)} tip={t("runs.markUnreviewedTip")} />
              {livePicked.length > 0 && (
                <Button size="sm" variant="danger" icon={Square} busy={stopping} onClick={() => void stopPicked()}>
                  {t("runs.stopPicked")}
                </Button>
              )}
            </>
          }
        />
        {filter === "review" && !selection.selecting && runs.some((run) => !run.openedAt) && (
          <div className="hstack" style={{ padding: "8px 8px 0" }}>
            <Button size="sm" variant="ghost" icon={CheckCheck} busy={marking} onClick={() => void markAll()} tip={t("runs.markAllTip")}>
              {t("home.review.markAll")}
            </Button>
          </div>
        )}
        <div className="list-scroll list-compact" onKeyDown={selection.onKeyDown}>
          {!loaded && <Skeleton rows={6} />}
          <LoadFailed query={source} />
          {loaded && !unreadable && runs.length === 0 && (
            <div className="faint" style={{ padding: "14px 10px" }}>
              {searching ? t("runs.noMatch") : filter === "review" ? t("runs.waitingNone") : filter === "live" ? t("runs.runningNone") : t("runs.none")}
            </div>
          )}
          {loaded && runs.length > 0 && shownRuns.length === 0 && <NoMatch hasQuery={view.hasQuery} filters={activeFilterLabels(view, labels)} onClear={view.clear} />}
          {shownRuns.map((run, index) => {
            const day = dayKey(run.startedAt);
            // Search results come best first, and a list by name has no days, so neither is grouped by day.
            const byTime = view.view.sort !== "name" && !(searching && view.view.sort === "newest");
            const heading = byTime && (index === 0 || dayKey(shownRuns[index - 1].startedAt) !== day);
            return (
              <Fragment key={run.id}>
                {heading && <div className="list-day">{dayHeading(run.startedAt, t.language)}</div>}
                <RunRow
                  run={run}
                  compact
                  snippet={snippets.get(run.id)}
                  selected={run.id === selected}
                  picked={selection.selecting ? selection.isPicked(run.id) : undefined}
                  onClick={() => (selection.selecting ? selection.toggle(run.id) : go({ view: "runs", runId: run.id, filter }))}
                />
              </Fragment>
            );
          })}
          {filter === "all" && !searching && !view.narrowed && runs.length >= ALL_RUNS && <div className="list-cut faint">{t("runs.cutSearch", { count: ALL_RUNS })}</div>}
        </div>
      </SidePanel>
      {selected ? (
        <RunDetail
          key={selected}
          runId={selected}
          onPrev={prevWaiting && prevWaiting.id !== nextWaiting?.id ? () => go({ view: "runs", runId: prevWaiting.id, filter }) : undefined}
          onNext={nextWaiting ? () => go({ view: "runs", runId: nextWaiting.id, filter }) : undefined}
        />
      ) : (
        <Empty icon={History} title={t("runs.empty.title")}>
          {t("runs.empty.body")}
        </Empty>
      )}
    </div>
  );
}
