import { History, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { RunView } from "../../shared/api.js";
import { call, useInbox, useQuery } from "../api.js";
import { RunDetail } from "../components/RunDetail.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { Empty, Input, Segmented } from "../components/ui.js";
import { useNav, type Route, type RunFilter } from "../state.js";
import { RunRow } from "./Home.js";
import { useT } from "../i18n/index.js";

export function RunsView({ route }: { route: Extract<Route, { view: "runs" }> }) {
  const t = useT();
  const { go } = useNav();
  const [filter, setFilter] = useState<RunFilter>(route.filter ?? (route.runId ? "all" : "review"));
  const [search, setSearch] = useState("");
  const inbox = useInbox();
  const all = useQuery(`runs:all:${search}`, ["runs", "live"], () => call("runs.list", { limit: 300, search: search || undefined }));

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
  else runs = all.data ?? [];

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
              <Input placeholder="Search titles, prompts, folders" value={search} onChange={(event) => setSearch(event.target.value)} style={{ paddingLeft: 28 }} />
            </div>
          </div>
        )}
        <div className="list-scroll list-compact">
          {runs.length === 0 && (
            <div className="faint" style={{ padding: "14px 10px" }}>
              {filter === "review" ? "Nothing waiting for review." : filter === "live" ? "Nothing is running." : "No runs yet."}
            </div>
          )}
          {runs.map((run) => (
            <RunRow key={run.id} run={run} compact selected={run.id === selected} onClick={() => go({ view: "runs", runId: run.id, filter })} />
          ))}
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
