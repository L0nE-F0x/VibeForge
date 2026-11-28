import { BellRing, Bot, CalendarClock, CheckCheck, FolderOpen, FolderPlus, GitBranch, History, Hourglass, KanbanSquare, MessagesSquare, Play, Settings, SquareTerminal, TerminalSquare } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { LiveSession, RunView, Workspace, WorkspaceCategory } from "../../shared/api.js";
import { LOCAL_ENGINE_ID, shortLocalModel } from "../../shared/local.js";
import { isCutOffRun } from "../../shared/routine-result.js";
import { duration, fireTime, tildify } from "../../shared/text.js";
import { call, useActivity, useAgents, useAppInfo, useChats, useEngines, useInbox, useLive, useNow, useOrchestrator, useQuery, useRoutines, useSettings, useTasks, useWorkspaces } from "../api.js";
import { PickMark } from "../components/ListTools.js";
import { Snippet } from "../components/Snippet.js";
import { BlockBars, ContributionGraph, PixelField, PixelWordmark } from "../components/Pixel.js";
import { ORIGIN_KEY } from "../components/RunDetail.js";
import { Button, ShortAgo, StatusChip, TimeAgo } from "../components/ui.js";
import { tipProps } from "../components/Tooltip.js";
import { shellNumber, workspaceMark, WorkspaceState } from "../components/WorkspaceState.js";
import { useAttention, usePtyAttention, type Attention } from "../attention.js";
import { writerNames } from "../components/Occupancy.js";
import { markWhere, markWho } from "../watch.js";
import { t as translate, useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { routeForMark, useAction, useNav } from "../state.js";
import { railKey, type RailView } from "../rail.js";
import { changesFor } from "../changes-text.js";
import { firstSteps, firstStepsDone, startCliIn } from "../first-run.js";
import { scheduleText } from "../schedule-text.js";
import { useWorkspaceCategory, workspacesInCategory } from "../workspace-view.js";
import { dropWorkspaceOnCategory, WORKSPACE_MIME, WorkspaceTabs } from "./code/WorkspaceTabs.js";

const DAYS = 14;
/** Waiting rows painted on Home before "and N more"; eight is the point, this is a backstop. */
const WAITING_ROWS = 24;

export function RunRow({
  run,
  selected,
  onClick,
  compact,
  snippet,
  picked,
}: {
  run: RunView;
  selected?: boolean;
  onClick: () => void;
  compact?: boolean;
  snippet?: string;
  /** While a list's Select is on: whether this one is picked (its box shows in place of the dot). */
  picked?: boolean;
}) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const isLocalRun = run.engine === LOCAL_ENGINE_ID || Boolean(run.localModel);
  const engineLabel = isLocalRun
    ? run.localModel
      ? `${t("pane.local")} · ${shortLocalModel(run.localModel)}`
      : t("pane.local")
    : (engines.find((engine) => engine.id === run.engine)?.label ?? null);
  const { title, kind } = runLabel(run, engineLabel);
  // The dot says how it went; a chip only for what didn't simply finish.
  const clean = run.status === "exited" && !run.exitCode && run.result !== "timeout" && run.result !== "failed" && run.result !== "stuck" && !isCutOffRun(run);
  const picking = picked !== undefined;
  return (
    <button type="button" className="run-row" aria-current={(!picking && selected) || undefined} aria-pressed={picking ? picked : undefined} onClick={onClick}>
      {picking ? <PickMark picked={picked} /> : <span className={`dot ${run.status}`} />}
      <span className="vstack grow" style={{ gap: 1 }}>
        {compact ? (
          // A narrow list: the time stays on the first line, so the second can shrink first.
          <span className="hstack" style={{ gap: 8 }}>
            <span className="title truncate grow">{title}</span>
            <span className="meta when">
              <ShortAgo iso={run.endedAt ?? run.startedAt} />
            </span>
          </span>
        ) : (
          <span className="title truncate">{title}</span>
        )}
        <span className="meta truncate">
          {kind}
          {isLocalRun && !kind.includes(t("pane.local"))
            ? ` · ${run.localModel ? `${t("pane.local")} · ${shortLocalModel(run.localModel)}` : t("pane.local")}`
            : ""}
          {run.changes ? ` · ${changesFor(run.changes, t)}` : ""}
          {!compact && (
            <>
              {" · "}
              <TimeAgo iso={run.endedAt ?? run.startedAt} />
            </>
          )}
        </span>
        {snippet && <Snippet text={snippet} className="truncate-2" />}
      </span>
      {!compact && !clean && <StatusChip status={run.status} exitCode={run.exitCode} result={run.result} origin={run.origin} cutOff={run.cutOff} />}
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

export function HomeWorkspacesSection({
  workspaces,
  categories,
  home,
  live,
  attention,
  onOpen,
}: {
  workspaces: readonly Workspace[];
  categories: readonly WorkspaceCategory[];
  home: string;
  live: readonly LiveSession[];
  attention: ReadonlyMap<string, Attention>;
  onOpen: (workspaceId: string) => void;
}) {
  const t = useT();
  const { currentCategory, activeCategory, selectCategory } = useWorkspaceCategory(categories);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [moveWorkspaceCategory] = useAction(
    async (workspace: Workspace, targetCategoryId: string, fromCategoryId: string | null, copy: boolean = false) => {
      await dropWorkspaceOnCategory(workspace, targetCategoryId, fromCategoryId, copy);
    },
    t("code.categoryAddFailed"),
  );
  const tabWorkspaces = workspacesInCategory(workspaces, activeCategory);
  const showTabs = workspaces.length > 0 || categories.length > 0;
  const liveIn = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;

  return (
    <>
      <div className="section-title">
        <FolderOpen size={13} /> {t("home.workspaces.title")}
      </div>
      {showTabs && (
        <WorkspaceTabs
          categories={categories}
          workspaces={workspaces}
          activeCategory={activeCategory}
          onSelect={selectCategory}
          draggingWorkspace={draggingWorkspaceId !== null}
          onDropWorkspace={(workspaceId, targetCategoryId, copy) => {
            setDraggingWorkspaceId(null);
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (workspace) void moveWorkspaceCategory(workspace, targetCategoryId, activeCategory, copy);
          }}
        />
      )}
      {workspaces.length === 0 ? (
        <div className="home-empty">{t("home.workspaces.empty")}</div>
      ) : tabWorkspaces.length === 0 && currentCategory ? (
        <div className="home-empty hstack" style={{ gap: 10 }}>
          <span className="grow">{t("code.categoryEmpty", { name: currentCategory.name })}</span>
          <Button size="sm" onClick={() => selectCategory(null)}>
            {t("code.categoryShowAll")}
          </Button>
        </div>
      ) : (
        <div className="workspace-tiles">
          {tabWorkspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`run-row${attention.get(workspace.id) === "waiting" ? " needs-you" : ""}${draggingWorkspaceId === workspace.id ? " is-dragging" : ""}`}
              draggable={categories.length > 0}
              onDragStart={(event) => {
                event.dataTransfer.setData(WORKSPACE_MIME, workspace.id);
                event.dataTransfer.effectAllowed = "move";
                setDraggingWorkspaceId(workspace.id);
              }}
              onDragEnd={() => setDraggingWorkspaceId(null)}
              onClick={() => onOpen(workspace.id)}
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
    </>
  );
}

export function HomeView() {
  const t = useT();
  const { go } = useNav();
  const now = useNow(10_000);
  const inbox = useInbox().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const live = useLive().data ?? [];
  const routines = useRoutines().data ?? [];
  const agents = useAgents().data ?? [];
  const workspaceFile = useWorkspaces().data;
  const workspaces = workspaceFile?.workspaces ?? [];
  const categories = workspaceFile?.categories ?? [];
  const engines = useEngines().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const since = useMemo(() => new Date(Date.now() - DAYS * 86_400_000).toISOString(), []);
  // Only the last two weeks, for the bars; new runs reload it, so the 30-second refresh is off.
  const recent = useQuery("home-activity", ["runs"], () => call("runs.list", { since, limit: 2000 }), { poll: false }).data ?? [];
  const [markAll, marking] = useAction(() => call("runs.markAllOpened"));
  // The newest runs of any age, for the first steps: one recorded, and one opened.
  const latestRuns = useQuery("home-first-runs", ["runs"], () => call("runs.list", { limit: 20 }), { poll: false }).data;
  const settings = useSettings().data;

  const time = (iso: string) => fireTime(iso, t.language, now);
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
  const steps = firstSteps({ workspaces: workspaces.length, runs: latestRuns ?? [] });
  // Until the runs are read, the steps wait rather than flash in front of someone who has done them.
  const onboarding = latestRuns !== undefined && !firstStepsDone(steps);
  const rail = settings?.rail;
  // The CLI the "Run a CLI" step starts: the default one when it is here, else the first found.
  const firstCli =
    (settings?.local.enabled && settings.local.active ? available.find((engine) => engine.local) : undefined) ??
    available.find((engine) => engine.id === settings?.defaultEngine) ??
    available[0] ??
    null;
  const lastWorkspace = workspaces.find((item) => item.id === workspaceFile?.lastWorkspaceId) ?? workspaces.at(-1) ?? null;
  const runCli = () => {
    if (!lastWorkspace) {
      go({ view: "code" });
      return;
    }
    if (!firstCli) {
      go({ view: "settings", section: "engines" });
      return;
    }
    go({ view: "code", workspaceId: lastWorkspace.id });
    void startCliIn(lastWorkspace.id, firstCli.id);
  };
  const stepText = {
    folder: { title: t("first.home.folder.title"), body: t("home.setup.workspace.body"), go: t("home.setup.workspace.go"), icon: FolderPlus, onClick: () => go({ view: "code" }) },
    cli: {
      title: t("first.home.cli.title"),
      body: available.length ? t("first.home.cli.found", { list: available.map((engine) => engine.label).join(", ") }) : t("first.home.cli.none"),
      go: !lastWorkspace ? t("first.home.cli.folderFirst") : firstCli ? t("first.home.cli.go", { cli: firstCli.label }) : t("orch.openSettings"),
      icon: Play,
      onClick: runCli,
    },
    review: {
      title: t("first.home.review.title"),
      body: t("first.home.review.body"),
      go: t("first.home.review.go"),
      icon: History,
      onClick: () => go(latestRuns?.[0] ? { view: "runs", runId: latestRuns[0].id } : { view: "runs" }),
    },
  } as const;
  const keyFor = (view: RailView) => {
    const key = railKey(rail, view);
    return key ? <kbd>{key.replace("+", " ")}</kbd> : null;
  };
  /** A running CLI by its name; a plain shell by its number when its workspace has more than one. */
  const liveTitle = (session: (typeof live)[number]) => {
    const number = session.program ? null : shellNumber(session.ptyId, live);
    return session.program ?? (number ? `${t("common.shell")} ${number} · ${session.title}` : session.title);
  };
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
  // The graph's 365 day labels are worked out once per graph and language, not on every clock tick.
  const source = graph?.source;
  const dayTip = useCallback(
    (day: string, count: number) => {
      const date = new Date(`${day}T12:00:00`).toLocaleDateString(t.language, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      return t.count(source === "github" ? "home.activity.githubDay" : "home.activity.gitDay", count, { count: count.toLocaleString(t.language), date });
    },
    [t, source],
  );

  const status = [
    live.length ? t.count("home.status.live", live.length) : "",
    inbox.length ? t.count("home.status.review", inbox.length) : "",
    copies.length ? t.count("home.status.copies", copies.length) : "",
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
            {/* While setting up, the numbered steps below are the way in; these would only repeat them. */}
            {!onboarding && (
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
            )}
          </section>

          {recent.length > 0 && (
            <button type="button" className="home-activity" onClick={() => go({ view: "runs", filter: "all" })}>
              <span className="value">{recent.length}</span>
              <span className="label">{t.count("home.stat.runs", recent.length)}</span>
              <span className="grow" />
              <BlockBars values={runsPerDay} label={t("home.stat.runsChart")} />
            </button>
          )}

          {onboarding && (
            <div className="home-steps">
              {steps.map((step, index) => {
                const text = stepText[step.key];
                return (
                  <button key={step.key} type="button" className={`home-step${step.done ? " done" : ""}`} onClick={text.onClick}>
                    <span className="num">
                      0{index + 1} {step.done ? `· ${t("home.setup.done")}` : ""}
                    </span>
                    <h3>{text.title}</h3>
                    <p>{text.body}</p>
                    <span className="go">{text.go} →</span>
                  </button>
                );
              })}
            </div>
          )}
          {/* A teammate and a quick chat come after a first result, not before it. */}
          {agents.length === 0 && (
            <div className="home-later">
              <span className="home-later-label">{t("first.home.later")}</span>
              <button type="button" className="run-row home-later-item" onClick={() => go({ view: "agents" })}>
                <Bot size={14} className="accent-text" />
                <span className="vstack grow" style={{ gap: 1 }}>
                  <span className="title">{t("home.setup.agent.title")}</span>
                  <span className="meta">{t("home.setup.agent.body")}</span>
                </span>
              </button>
              <button type="button" className="run-row home-later-item" onClick={() => go({ view: "chat" })}>
                <MessagesSquare size={14} className="accent-text" />
                <span className="vstack grow" style={{ gap: 1 }}>
                  <span className="title">{t("home.setup.chat.title")}</span>
                  <span className="meta">{t("home.setup.chat.body")}</span>
                </span>
              </button>
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

              {copies.length > 0 && (
                <>
                  <div className="section-title">
                    <GitBranch size={13} /> {t("orch.toReview")} <span className="count">{copies.length}</span>
                  </div>
                  <div className="vstack" style={{ gap: 6 }}>
                    {copies.map((copy) => {
                      const from = workspaces.find((item) => item.id === copy.workspaceId);
                      const engineLabel = engines.find((item) => item.id === copy.engineId)?.label ?? copy.engineId;
                      return (
                        <button key={copy.id} type="button" className="run-row" onClick={() => go({ view: "orchestrator", copyId: copy.id })}>
                          <GitBranch size={14} className="accent-text" />
                          <span className="vstack grow" style={{ gap: 1 }}>
                            <span className="title truncate">{copy.name}</span>
                            <span className="meta truncate">
                              {engineLabel}
                              {from ? ` · ${from.name}` : ""}
                            </span>
                          </span>
                          <span className="meta">{t("orch.review")}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              <HomeWorkspacesSection
                workspaces={workspaces}
                categories={categories}
                home={home}
                live={live}
                attention={attention}
                onOpen={(workspaceId) => go({ view: "code", workspaceId })}
              />
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
              {live.length > 0 && (
                <div className="vstack" style={{ gap: 6 }}>
                  {live.slice(0, 8).map((session) => (
                    <button
                      key={session.ptyId}
                      type="button"
                      className={`run-row${marks.get(session.ptyId)?.attention === "waiting" || session.needsInput ? " needs-you" : ""}`}
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
                        <span className="title truncate">{liveTitle(session)}</span>
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
              )}

              {upcoming.length > 0 && (
                <div className="section-title">
                  <CalendarClock size={13} /> {t("home.next.title")}
                </div>
              )}
              {upcoming.length > 0 && (
                <div className="vstack" style={{ gap: 6 }}>
                  {upcoming.map(({ routine, at }) => (
                    <button key={routine.id} type="button" className={`run-row${routine.failing || routine.needsInput ? " needs-you" : ""}`} onClick={() => go({ view: "routines", routineId: routine.id })}>
                      <CalendarClock size={14} className="accent-text" />
                      <span className="vstack grow" style={{ gap: 1 }}>
                        <span className="title truncate">{routine.name}</span>
                        <span className="meta truncate">
                          {routine.agentName ?? t("home.next.missingAgent")} · {scheduleText(routine.schedule, t, routine.description)}
                        </span>
                      </span>
                      <span className="meta">{time(at)}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="home-clis">
              <div className="section-title">
                <SquareTerminal size={13} /> {t("home.clis.title")}
                <span className="grow" />
                <Button size="sm" variant="ghost" onClick={() => go({ view: "settings", section: "engines" })}>
                  {t("home.clis.manage")}
                </Button>
              </div>
              {available.length === 0 ? (
                <div className="home-empty hstack" style={{ gap: 10 }}>
                  <span className="grow">{t("home.clis.none")}</span>
                  <Button size="sm" icon={Settings} onClick={() => go({ view: "settings", section: "engines" })}>
                    {t("orch.openSettings")}
                  </Button>
                </div>
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
    </div>
  );
}
