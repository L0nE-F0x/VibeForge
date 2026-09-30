import { History, Search } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
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
  const { go } = useNav();
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
  if (filter === "review") {
    runs = inbox.data ?? [];
    // Opening a run marks it reviewed; keep it in the list while it is on screen.
    const open = selected ? (all.data ?? []).find((run) => run.id === selected) : undefined;
    if (open && !runs.some((run) => run.id === open.id)) runs = [open, ...runs];
  } else if (filter === "live") runs = (all.data ?? []).filter((run) => run.live);
  else runs = searching ? (found.data ?? []) : (all.data ?? []);
  const snippets = new Map(searching ? (found.data ?? []).map((hit) => [hit.id, hit.snippet]) : []);
  const loaded = filter === "review" ? inbox.loaded : searching ? found.loaded : all.loaded;

  return (
    <div className="view split-list">
      <SidePanel
        id="runs"
        title={t("runs.title")}
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
        <RunDetail key={selected} runId={selected} />
      ) : (
        <Empty icon={History} title={t("runs.empty.title")}>
          {t("runs.empty.body")}
        </Empty>
      )}
    </div>
  );
}
