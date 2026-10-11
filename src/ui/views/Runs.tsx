import { History, Search } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { RunView } from "../../shared/api.js";
import { dayHeading, dayKey } from "../../shared/text.js";
import { call, useDebounced, useInbox, useQuery } from "../api.js";
import { RunDetail } from "../components/RunDetail.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { Empty, Input, Segmented, Skeleton } from "../components/ui.js";
import { useNav, type Route, type RunFilter } from "../state.js";
import { RunRow } from "./Home.js";
import { useT } from "../i18n/index.js";

export function RunsView({ route }: { route: Extract<Route, { view: "runs" }> }) {
  const t = useT();
  const { go, replace } = useNav();
  const [filter, setFilter] = useState<RunFilter>(route.filter ?? (route.runId ? "all" : "review"));
  const [search, setSearch] = useState("");
  const inbox = useInbox();
  const typed = useDebounced(search.trim(), 160);
  const all = useQuery("runs:all", ["runs", "live"], () => call("runs.list", { limit: 300 }));
  const found = useQuery(typed ? `runs:search:${typed}` : null, ["runs", "live"], () => call("runs.search", typed, 200));
  const searching = filter === "all" && typed !== "";

  useEffect(() => {
    if (route.filter) setFilter(route.filter);
  }, [route.filter]);

  const selected = route.runId ?? null;
  let runs: RunView[] = [];
  // Opening a run marks it reviewed. The ones reviewed during this visit stay in the list, in
  // their places, so K can go back to them; the list starts fresh next time.
  const reviewed = useRef(new Set<string>());
  if (filter !== "review") reviewed.current.clear();
  else if (selected) reviewed.current.add(selected);
  if (filter === "review") {
    const pool = new Map([...(all.data ?? []), ...(inbox.data ?? [])].map((run) => [run.id, run]));
    const ids = new Set([...(inbox.data ?? []).map((run) => run.id), ...reviewed.current]);
    runs = [...ids]
      .map((id) => pool.get(id))
      .filter((run): run is RunView => Boolean(run))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  } else if (filter === "live") runs = (all.data ?? []).filter((run) => run.live);
  else runs = searching ? (found.data ?? []) : (all.data ?? []);
  const snippets = new Map(searching ? (found.data ?? []).map((hit) => [hit.id, hit.snippet]) : []);
  const loaded = filter === "review" ? inbox.loaded : searching ? found.loaded : all.loaded;

  // Coming to review: the first run waiting is already open.
  const first = filter === "review" && loaded && !selected ? runs[0]?.id : undefined;
  useEffect(() => {
    if (first) replace({ view: "runs", runId: first, filter: "review" });
  }, [first, replace]);

  // The run after this one in the list, or before it at the end of the list.
  const at = runs.findIndex((run) => run.id === selected);
  const step = (by: number) => {
    const next = runs[at + by] ?? (at < 0 ? runs[0] : undefined);
    if (next) go({ view: "runs", runId: next.id, filter });
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  // While reviewing, the next one waiting: below this one, else the first one above it.
  const nextWaiting = filter === "review" ? (runs.slice(at + 1).find((run) => !run.openedAt) ?? runs.slice(0, Math.max(0, at)).find((run) => !run.openedAt)) : undefined;

  // J and K step through the list from anywhere in the view, except while typing or in a terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || (event.key !== "j" && event.key !== "k")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], .xterm, .modal, .sheet")) return;
      event.preventDefault();
      stepRef.current(event.key === "j" ? 1 : -1);
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
            {runs.slice(0, 14).map((run) => (
              <StripItem key={run.id} label={run.title} selected={run.id === selected} onClick={() => go({ view: "runs", runId: run.id, filter })}>
                <span className={`dot ${run.status}`} />
              </StripItem>
            ))}
          </>
        }
      >
        {filter === "all" && (
          <div style={{ padding: "8px 8px 0" }}>
            <div className="hstack" style={{ position: "relative" }}>
              <Search size={13} className="faint" style={{ position: "absolute", left: 9 }} />
              <Input placeholder={t("runs.searchPlaceholder")} aria-label={t("runs.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} style={{ paddingLeft: 28 }} />
            </div>
          </div>
        )}
        <div className="list-scroll list-compact">
          {!loaded && <Skeleton rows={6} />}
          {loaded && runs.length === 0 && (
            <div className="faint" style={{ padding: "14px 10px" }}>
              {searching ? t("runs.noMatch") : filter === "review" ? t("runs.waitingNone") : filter === "live" ? t("runs.runningNone") : t("runs.none")}
            </div>
          )}
          {runs.map((run, index) => {
            const day = dayKey(run.startedAt);
            // Search results come best first, so they aren't grouped by day.
            const heading = !searching && (index === 0 || dayKey(runs[index - 1].startedAt) !== day);
            return (
              <Fragment key={run.id}>
                {heading && <div className="list-day">{dayHeading(run.startedAt, t.language)}</div>}
                <RunRow run={run} compact snippet={snippets.get(run.id)} selected={run.id === selected} onClick={() => go({ view: "runs", runId: run.id, filter })} />
              </Fragment>
            );
          })}
        </div>
      </SidePanel>
      {selected ? (
        <RunDetail key={selected} runId={selected} onNext={nextWaiting ? () => go({ view: "runs", runId: nextWaiting.id, filter }) : undefined} />
      ) : (
        <Empty icon={History} title={t("runs.empty.title")}>
          {t("runs.empty.body")}
        </Empty>
      )}
    </div>
  );
}
