import { BellRing, Bot, CalendarClock, CheckCheck, FolderOpen, FolderPlus, History, Hourglass, KanbanSquare, MessagesSquare, SquareTerminal, TerminalSquare } from "lucide-react";
import { useMemo } from "react";
import type { RunView } from "../../shared/api.js";
import { duration, tildify } from "../../shared/text.js";
import { call, useActivity, useAgents, useAppInfo, useChats, useEngines, useInbox, useLive, useNow, useQuery, useRoutines, useSettings, useTasks, useWorkspaces } from "../api.js";
import { Snippet } from "../components/Snippet.js";
import { BlockBars, ContributionGraph, PixelField, PixelWordmark } from "../components/Pixel.js";
import { ORIGIN_KEY } from "../components/RunDetail.js";
import { Button, StatusChip, TimeAgo } from "../components/ui.js";
import { tipProps } from "../components/Tooltip.js";
import { workspaceMark, WorkspaceState } from "../components/WorkspaceState.js";
import { useAttention, usePtyAttention } from "../attention.js";
import { writerNames } from "../components/Occupancy.js";
import { markWhere, markWho } from "../watch.js";
import { t as translate, useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { routeForMark, useAction, useNav } from "../state.js";
import { railKey, type RailView } from "../rail.js";

const DAYS = 14;
/** Waiting rows painted on Home before "and N more"; eight is the point, this is a backstop. */
const WAITING_ROWS = 24;

export function RunRow({ run, selected, onClick, compact, snippet }: { run: RunView; selected?: boolean; onClick: () => void; compact?: boolean; snippet?: string }) {
  const engines = useEngines().data ?? [];
  const { title, kind } = runLabel(run, engines.find((engine) => engine.id === run.engine)?.label ?? null);
  return (
    <button type="button" className="run-row" aria-selected={selected} aria-current={selected || undefined} onClick={onClick}>
      <span className={`dot ${run.status}`} />
      <span className="vstack grow" style={{ gap: 1 }}>
        <span className="title truncate">{title}</span>
        <span className="meta truncate">
          {kind}
          {run.changes ? ` · ${run.changes}` : ""}
          {" · "}
          <TimeAgo iso={run.endedAt ?? run.startedAt} />
        </span>
        {snippet && <Snippet text={snippet} className="truncate-2" />}
      </span>
      {!compact && <StatusChip status={run.status} exitCode={run.exitCode} />}
    </button>
  );
}

/**
 * A Code run is titled "Claude Code · project". In a list the project leads and the CLI moves to
 * the line under it, in place of "Code", so a column of runs reads as projects, not one CLI's name.
 */
export function runLabel(run: Pick<RunView, "origin" | "title">, engineLabel: string | null): { title: string; kind: string } {
  const prefix = engineLabel ? `${engineLabel} · ` : null;
  if (run.origin === "code" && prefix && run.title.startsWith(prefix) && run.title.length > prefix.length) {
    return { title: run.title.slice(prefix.length), kind: engineLabel! };
  }
  return { title: run.title, kind: translate(ORIGIN_KEY[run.origin]) };
}

/** Runs started on each of the last `days` days, oldest first, by local date. */
function perDay(runs: RunView[], days: number, now: number): number[] {
  const counts = new Array<number>(days).fill(0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (const run of runs) {
    const day = new Date(run.startedAt);
    day.setHours(0, 0, 0, 0);
    const back = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    if (back >= 0 && back < days) counts[days - 1 - back] += 1;
  }
  return counts;
}

export function HomeView() {
  const t = useT();
  const { go } = useNav();
  const now = useNow(10_000);
  const inbox = useInbox().data ?? [];
  const live = useLive().data ?? [];
  const routines = useRoutines().data ?? [];
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const engines = useEngines().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const since = useMemo(() => new Date(Date.now() - DAYS * 86_400_000).toISOString(), []);
  const recent = useQuery("home-activity", ["runs"], () => call("runs.list", { since, limit: 2000 })).data ?? [];
  const [markAll, marking] = useAction(() => call("runs.markAllOpened"));

  const time = (iso: string) => new Date(iso).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" });
  const upcoming = routines
    .filter((routine) => routine.enabled && routine.nextFires.length)
    .map((routine) => ({ routine, at: routine.nextFires[0] }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 5);
  const available = engines.filter((engine) => engine.available);
  const runsPerDay = perDay(recent, DAYS, now);
  const hour = new Date(now).getHours();
  const greeting = t(hour < 5 ? "home.greeting.night" : hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening");
  const date = new Date(now).toLocaleDateString(t.language, { weekday: "short", day: "numeric", month: "short" });
  const clock = new Date(now).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" });
  const onboarding = agents.length === 0 || workspaces.length === 0;
  const rail = useSettings().data?.rail;
  const keyFor = (view: RailView) => {
    const key = railKey(rail, view);
    return key ? <kbd>{key.replace("+", " ")}</kbd> : null;
  };
  const liveIn = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;
  const attention = useAttention();
  const marks = usePtyAttention();
  const tasks = useTasks().data ?? [];
  const chats = useChats(undefined).data ?? [];
  const waiting = [...marks.values()].filter((mark) => mark.attention === "waiting").sort((a, b) => a.since - b.since);
  const present = new Set(live.map((session) => session.ptyId));
  const inLine = [
    ...tasks.filter((task) => task.waiting).map((task) => ({ key: `task:${task.id}`, title: task.title, behind: task.waiting!.behind, since: task.waiting!.since, icon: KanbanSquare, to: { view: "tasks" as const, taskId: task.id } })),
    ...routines.filter((routine) => routine.waiting).map((routine) => ({ key: `routine:${routine.id}`, title: routine.name, behind: routine.waiting!.behind, since: routine.waiting!.since, icon: CalendarClock, to: { view: "routines" as const, routineId: routine.id } })),
  ].sort((a, b) => a.since.localeCompare(b.since));
  const contributions = useActivity().data;
  const graph = contributions && !contributions.error && contributions.days.length ? contributions : null;
  const number = (value: number) => value.toLocaleString(t.language);
  const dayTip = (day: string, count: number) => {
    const date = new Date(`${day}T12:00:00`).toLocaleDateString(t.language, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return t.count(graph?.source === "github" ? "home.activity.githubDay" : "home.activity.gitDay", count, { count: number(count), date });
  };

  const status = [
    live.length ? t.count("home.status.live", live.length) : "",
    inbox.length ? t.count("home.status.review", inbox.length) : "",
  ].filter(Boolean);
  const statusLine = (status.length ? status.join(" · ") : t("home.status.quiet")) + (upcoming[0] ? ` · ${t("home.status.next", { time: time(upcoming[0].at) })}` : "");

  return (
    <div className="main">
      <div className="page-body">
        <div className="home-page">
          <section className="home-hero">
            {graph ? (
              <div className="home-graph">
                <ContributionGraph days={graph.days} tip={dayTip} className="graph" />
                <div className="home-graph-caption">
                  {t.count(graph.source === "github" ? "home.activity.github" : "home.activity.git", graph.total, { count: number(graph.total) })}
                  {" · "}
                  {graph.source === "github" && graph.login ? (
                    <button type="button" onClick={() => void call("app.openExternal", `https://github.com/${graph.login}`)}>
                      github.com/{graph.login}
                    </button>
                  ) : (
                    <button type="button" onClick={() => go({ view: "settings" })} {...tipProps(t("home.activity.gitTip"))}>
                      {t.count("home.activity.workspaces", workspaces.length)}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <PixelField className="home-drift" cols={52} rows={17} cell={12} size={7} from="right" />
            )}
            <PixelWordmark px={7} className="wordmark" />
            <p className="home-when">
              {greeting} · <b>{date}</b> · {clock}
            </p>
            <p className="home-status">
              <Rich text={statusLine} />
            </p>
            <div className="home-actions">
              <Button variant="primary" icon={FolderOpen} onClick={() => go({ view: "code" })}>
                {t("home.action.workspace")}
                {keyFor("code")}
              </Button>
              <Button icon={Bot} onClick={() => go({ view: "agents" })}>
                {t("home.action.agent")}
                {keyFor("agents")}
              </Button>
              <Button icon={MessagesSquare} onClick={() => go({ view: "chat" })}>
                {t("home.action.chat")}
                {keyFor("chat")}
              </Button>
            </div>
          </section>

          <button type="button" className="home-activity" onClick={() => go({ view: "runs", filter: "all" })}>
            <span className="value">{recent.length}</span>
            <span className="label">{t("home.stat.runs")}</span>
            <span className="grow" />
            <BlockBars values={runsPerDay} label={t("home.stat.runsChart")} />
          </button>

          {onboarding && (
            <div className="home-steps">
              {(
                [
                  { key: "workspace", done: workspaces.length > 0, icon: FolderPlus, onClick: () => go({ view: "code" }) },
                  { key: "agent", done: agents.length > 0, icon: Bot, onClick: () => go({ view: "agents" }) },
                  { key: "chat", done: false, icon: MessagesSquare, onClick: () => go({ view: "chat" }) },
                ] as const
              ).map((step, index) => (
                <button key={step.key} type="button" className={`home-step${step.done ? " done" : ""}`} onClick={step.onClick}>
                  <span className="num">
                    0{index + 1} {step.done ? `· ${t("home.setup.done")}` : ""}
                  </span>
                  <h3>{t(`home.setup.${step.key}.title`)}</h3>
                  <p>{t(`home.setup.${step.key}.body`)}</p>
                  <span className="go">{t(`home.setup.${step.key}.go`)} →</span>
                </button>
              ))}
            </div>
          )}

          <div className="home-grid">
            <div>
              {inbox.length > 0 && (
                <>
                  <div className="section-title">
                    <History size={13} /> {t("home.review.title")} <span className="count">{inbox.length}</span>
                    <span className="grow" />
                    {inbox.length > 1 && (
                      <Button size="sm" variant="ghost" icon={CheckCheck} busy={marking} onClick={() => void markAll()}>
                        {t("home.review.markAll")}
                      </Button>
                    )}
                  </div>
                  <div className="vstack" style={{ gap: 6 }}>
                    {inbox.map((run) => (
                      <RunRow key={run.id} run={run} onClick={() => go({ view: "runs", runId: run.id })} />
                    ))}
                  </div>
                </>
              )}

              <div className="section-title">
                <FolderOpen size={13} /> {t("home.workspaces.title")}
              </div>
              {workspaces.length === 0 ? (
                <div className="home-empty">{t("home.workspaces.empty")}</div>
              ) : (
                <div className="workspace-tiles">
                  {workspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      className={`run-row${attention.get(workspace.id) === "waiting" ? " needs-you" : ""}`}
                      onClick={() => go({ view: "code", workspaceId: workspace.id })}
                    >
                      <FolderOpen size={14} className="accent-text" />
                      <span className="vstack grow" style={{ gap: 1 }}>
                        <span className="title truncate">{workspace.name}</span>
                        <span className="meta truncate">{tildify(workspace.path, home)}</span>
                      </span>
                      <WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveIn(workspace.id)} />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              {waiting.length > 0 && (
                <>
                  <div className="section-title">
                    <BellRing size={13} /> {t("home.waiting.title")}
                  </div>
                  <div className="vstack" style={{ gap: 6 }}>
                    {waiting.slice(0, WAITING_ROWS).map((mark) => (
                      <button key={mark.ptyId} type="button" className="run-row needs-you" onClick={() => go(routeForMark(mark, present.has(mark.ptyId)))}>
                        <BellRing size={14} className="accent-text" />
                        <span className="vstack grow" style={{ gap: 1 }}>
                          <span className="title truncate">{markWho(mark, { agents })}</span>
                          <span className="meta truncate">{markWhere(mark, { chats, tasks, workspaces }) || mark.label}</span>
                        </span>
                        <span className="meta">
                          <TimeAgo iso={new Date(mark.since).toISOString()} />
                        </span>
                      </button>
                    ))}
                    {waiting.length > WAITING_ROWS && <div className="faint">{t("home.waiting.more", { count: waiting.length - WAITING_ROWS })}</div>}
                  </div>
                </>
              )}
              {inLine.length > 0 && (
                <>
                  <div className="section-title">
                    <Hourglass size={13} /> {t("home.turns.title")}
                  </div>
                  <div className="vstack" style={{ gap: 6 }}>
                    {inLine.map((item) => (
                      <button key={item.key} type="button" className="run-row" onClick={() => go(item.to)}>
                        <item.icon size={14} className="accent-text" />
                        <span className="vstack grow" style={{ gap: 1 }}>
                          <span className="title truncate">{item.title}</span>
                          <span className="meta truncate">{t("turns.waitingShort", { names: writerNames(item.behind, agents) || t("turns.someone") })}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {live.length > 0 && (
                <div className="section-title">
                  <TerminalSquare size={13} /> {t("home.live.title")}
                </div>
              )}
              <div className="vstack" style={{ gap: 6 }}>
                {live.slice(0, 8).map((session) => (
                  <button
                    key={session.ptyId}
                    type="button"
                    className={`run-row${marks.get(session.ptyId)?.attention === "waiting" ? " needs-you" : ""}`}
                    onClick={() => {
                      if (session.origin === "agent-chat" && session.agentId && session.chatId) go({ view: "agents", agentId: session.agentId, tab: "chats", chatId: session.chatId });
                      else if (session.origin === "chat" && session.chatId) go({ view: "chat", chatId: session.chatId });
                      else if (session.origin === "task" && session.taskId) go({ view: "tasks", taskId: session.taskId });
                      else if (session.workspaceId) go({ view: "code", workspaceId: session.workspaceId, ptyId: session.ptyId });
                      else if (session.runId) go({ view: "runs", runId: session.runId });
                    }}
                  >
                    {session.kind === "shell" && !session.programEngineId ? (
                      <SquareTerminal size={14} className="faint" />
                    ) : (
                      <span className={`ws-state ${session.working ? "working" : "open"}`} {...tipProps(session.working ? t("ws.working") : t("home.live.quiet"))} />
                    )}
                    <span className="vstack grow" style={{ gap: 1 }}>
                      <span className="title truncate">{session.program ?? session.title}</span>
                      <span className="meta truncate">
                        {session.program ? `${session.title} · ` : ""}
                        {tildify(session.cwd, home)}
                        {session.alsoHere?.length ? ` · ${t("occupancy.alsoHere", { names: writerNames(session.alsoHere, agents) })}` : ""}
                      </span>
                    </span>
                    <span className="meta">{duration(session.startedAt, null, now)}</span>
                  </button>
                ))}
              </div>

              {upcoming.length > 0 && (
                <div className="section-title">
                  <CalendarClock size={13} /> {t("home.next.title")}
                </div>
              )}
              <div className="vstack" style={{ gap: 6 }}>
                {upcoming.map(({ routine, at }) => (
                  <button key={routine.id} type="button" className={`run-row${routine.failing ? " needs-you" : ""}`} onClick={() => go({ view: "routines", routineId: routine.id })}>
                    <CalendarClock size={14} className="accent-text" />
                    <span className="vstack grow" style={{ gap: 1 }}>
                      <span className="title truncate">{routine.name}</span>
                      <span className="meta truncate">
                        {routine.agentName ?? t("home.next.missingAgent")} · {routine.description}
                      </span>
                    </span>
                    <span className="meta">{time(at)}</span>
                  </button>
                ))}
              </div>

              <div className="section-title">
                <SquareTerminal size={13} /> {t("home.clis.title")}
                <span className="grow" />
                <Button size="sm" variant="ghost" onClick={() => go({ view: "settings" })}>
                  {t("home.clis.manage")}
                </Button>
              </div>
              {available.length === 0 ? (
                <div className="home-empty">{t("home.clis.none")}</div>
              ) : (
                <div className="cli-chips">
                  {available.map((engine) => (
                    <span key={engine.id} className="cli-chip" {...tipProps(engine.path ? tildify(engine.path, home) : engine.bin)}>
                      <span className="pixel" />
                      {engine.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
