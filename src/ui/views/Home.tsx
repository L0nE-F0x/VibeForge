import { Bot, CalendarClock, CheckCheck, FolderOpen, FolderPlus, History, MessagesSquare, SquareTerminal, TerminalSquare } from "lucide-react";
import { useMemo } from "react";
import type { RunView } from "../../shared/api.js";
import { duration, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useEngines, useInbox, useLive, useNow, useQuery, useRoutines, useTasks, useWorkspaces } from "../api.js";
import { BlockBars, PixelField, PixelWordmark } from "../components/Pixel.js";
import { ORIGIN_LABEL } from "../components/RunDetail.js";
import { Button, StatusChip, TimeAgo } from "../components/ui.js";
import { useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { useAction, useNav } from "../state.js";

const DAYS = 14;

export function RunRow({ run, selected, onClick, compact }: { run: RunView; selected?: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" className="run-row" aria-selected={selected} onClick={onClick}>
      <span className={`dot ${run.status}`} />
      <span className="vstack grow" style={{ gap: 1 }}>
        <span className="title truncate">{run.title}</span>
        <span className="meta truncate">
          {ORIGIN_LABEL[run.origin]}
          {run.changes ? ` · ${run.changes}` : ""}
          {" · "}
          <TimeAgo iso={run.endedAt ?? run.startedAt} />
        </span>
      </span>
      {!compact && <StatusChip status={run.status} exitCode={run.exitCode} />}
    </button>
  );
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
  const tasks = useTasks().data ?? [];
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
  const reviewTasks = tasks.filter((task) => task.status === "review");
  const available = engines.filter((engine) => engine.available);
  const activity = perDay(recent, DAYS, now);
  const hour = new Date(now).getHours();
  const greeting = t(hour < 5 ? "home.greeting.night" : hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening");
  const date = new Date(now).toLocaleDateString(t.language, { weekday: "short", day: "numeric", month: "short" });
  const clock = new Date(now).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" });
  const onboarding = agents.length === 0 || workspaces.length === 0;
  const liveIn = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;

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
            <PixelField className="home-drift" cols={52} rows={17} cell={12} size={7} from="right" />
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
                <kbd>Ctrl 3</kbd>
              </Button>
              <Button icon={Bot} onClick={() => go({ view: "agents" })}>
                {t("home.action.agent")}
                <kbd>Ctrl 2</kbd>
              </Button>
              <Button icon={MessagesSquare} onClick={() => go({ view: "chat" })}>
                {t("home.action.chat")}
                <kbd>Ctrl 4</kbd>
              </Button>
            </div>
          </section>

          <div className="stats">
            <button type="button" className={`stat${live.length ? " hot" : ""}`} onClick={() => go({ view: "runs", filter: "live" })}>
              <span className="value">{live.length}</span>
              <span className="label">{t("home.stat.live")}</span>
              <span className="foot truncate">{live[0]?.title ?? t("home.stat.liveNone")}</span>
            </button>
            <button type="button" className={`stat${inbox.length ? " hot" : ""}`} onClick={() => go({ view: "runs", filter: "review" })}>
              <span className="value">{inbox.length}</span>
              <span className="label">{t("home.stat.review")}</span>
              <span className="foot truncate">
                {reviewTasks.length ? t.count("home.stat.reviewTasks", reviewTasks.length) : (inbox[0]?.title ?? t("home.stat.reviewNone"))}
              </span>
            </button>
            <button type="button" className="stat" onClick={() => go({ view: "runs", filter: "all" })}>
              <span className="value">{recent.length}</span>
              <span className="label">{t("home.stat.runs")}</span>
              <BlockBars values={activity} label={t("home.stat.runsChart")} />
            </button>
            <button type="button" className="stat" onClick={() => go({ view: "routines" })}>
              <span className="value">{routines.filter((routine) => routine.enabled).length}</span>
              <span className="label">{t("home.stat.routines")}</span>
              <span className="foot truncate">{upcoming[0] ? t("home.stat.routineNext", { time: time(upcoming[0].at) }) : t("home.stat.routineNone")}</span>
            </button>
          </div>

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
              <div className="section-title">
                <History size={13} /> {t("home.review.title")} {inbox.length > 0 && <span className="count">{inbox.length}</span>}
                <span className="grow" />
                {inbox.length > 1 && (
                  <Button size="sm" variant="ghost" icon={CheckCheck} busy={marking} onClick={() => void markAll()}>
                    {t("home.review.markAll")}
                  </Button>
                )}
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {inbox.length === 0 && <div className="home-empty">{t("home.review.empty")}</div>}
                {inbox.map((run) => (
                  <RunRow key={run.id} run={run} onClick={() => go({ view: "runs", runId: run.id })} />
                ))}
              </div>

              <div className="section-title">
                <FolderOpen size={13} /> {t("home.workspaces.title")}
              </div>
              {workspaces.length === 0 ? (
                <div className="home-empty">{t("home.workspaces.empty")}</div>
              ) : (
                <div className="workspace-tiles">
                  {workspaces.map((workspace) => (
                    <button key={workspace.id} type="button" className="run-row" onClick={() => go({ view: "code", workspaceId: workspace.id })}>
                      <FolderOpen size={14} className="accent-text" />
                      <span className="vstack grow" style={{ gap: 1 }}>
                        <span className="title truncate">{workspace.name}</span>
                        <span className="meta truncate">{tildify(workspace.path, home)}</span>
                      </span>
                      {liveIn(workspace.id) > 0 && <span className="ws-live">{liveIn(workspace.id)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="section-title">
                <TerminalSquare size={13} /> {t("home.live.title")}
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {live.length === 0 && <div className="home-empty">{t("home.live.empty")}</div>}
                {live.slice(0, 8).map((session) => (
                  <button
                    key={session.ptyId}
                    type="button"
                    className="run-row"
                    onClick={() => {
                      if (session.origin === "agent-chat" && session.agentId && session.chatId) go({ view: "agents", agentId: session.agentId, tab: "chats", chatId: session.chatId });
                      else if (session.origin === "chat" && session.chatId) go({ view: "chat", chatId: session.chatId });
                      else if (session.origin === "task" && session.taskId) go({ view: "tasks", taskId: session.taskId });
                      else if (session.workspaceId) go({ view: "code", workspaceId: session.workspaceId, ptyId: session.ptyId });
                      else if (session.runId) go({ view: "runs", runId: session.runId });
                    }}
                  >
                    {session.kind === "shell" ? <SquareTerminal size={14} className="faint" /> : <span className="dot running" />}
                    <span className="vstack grow" style={{ gap: 1 }}>
                      <span className="title truncate">{session.title}</span>
                      <span className="meta truncate">{tildify(session.cwd, home)}</span>
                    </span>
                    <span className="meta">{duration(session.startedAt, null, now)}</span>
                  </button>
                ))}
              </div>

              <div className="section-title">
                <CalendarClock size={13} /> {t("home.next.title")}
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {upcoming.length === 0 && <div className="home-empty">{t("home.next.empty")}</div>}
                {upcoming.map(({ routine, at }) => (
                  <button key={routine.id} type="button" className="run-row" onClick={() => go({ view: "routines", routineId: routine.id })}>
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
              <div className="which selectable">
                <div className="prompt">
                  <b>$</b> which {available.map((engine) => engine.bin).join(" ") || "…"}
                </div>
                {available.length === 0 && <div className="faint">{t("home.clis.none")}</div>}
                {available.slice(0, 9).map((engine) => (
                  <div key={engine.id} className="which-row">
                    <span className="pixel" />
                    <span className="truncate">{engine.label}</span>
                    <span className="path truncate">{engine.path ? tildify(engine.path, home) : engine.bin}</span>
                  </div>
                ))}
                {available.length > 9 && <div className="faint">{t("home.clis.more", { count: available.length - 9 })}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
