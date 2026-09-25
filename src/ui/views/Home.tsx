import { Bot, CalendarClock, CheckCheck, FolderPlus, History, MessagesSquare, Sparkles, SquareTerminal, TerminalSquare } from "lucide-react";
import type { RunView } from "../../shared/api.js";
import { clockTime, duration, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useEngines, useInbox, useLive, useNow, useRoutines, useTasks, useWorkspaces } from "../api.js";
import { ORIGIN_LABEL } from "../components/RunDetail.js";
import { Button, Chip, Logo, StatusChip, TimeAgo } from "../components/ui.js";
import { useAction, useNav } from "../state.js";

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

export function HomeView() {
  const { go } = useNav();
  const now = useNow(1000);
  const inbox = useInbox().data ?? [];
  const live = useLive().data ?? [];
  const routines = useRoutines().data ?? [];
  const tasks = useTasks().data ?? [];
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const engines = useEngines().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const [markAll, marking] = useAction(() => call("runs.markAllOpened"));

  const upcoming = routines
    .filter((routine) => routine.enabled && routine.nextFires.length)
    .map((routine) => ({ routine, at: routine.nextFires[0] }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 5);
  const reviewTasks = tasks.filter((task) => task.status === "review");
  const available = engines.filter((engine) => engine.available);
  const hour = new Date(now).getHours();
  const greeting = hour < 5 ? "Burning the midnight oil" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const onboarding = agents.length === 0 || workspaces.length === 0;

  return (
    <div className="main">
      <div className="page-body">
        <div className="home-page">
          <div className="hero">
            <Logo size={34} />
            <div className="grow">
              <h1>{greeting}.</h1>
              <p>
                {live.length ? `${live.length} terminal${live.length === 1 ? "" : "s"} running` : "Nothing running"}
                {" · "}
                {inbox.length ? `${inbox.length} run${inbox.length === 1 ? "" : "s"} to review` : "inbox clear"}
                {upcoming[0] ? ` · next routine ${clockTime(upcoming[0].at)}` : ""}
              </p>
            </div>
          </div>

          <div className="stats">
            <button type="button" className={`stat${live.length ? " hot" : ""}`} onClick={() => go({ view: "runs", filter: "live" })}>
              <span className="value">{live.length}</span>
              <span className="label">Live terminals</span>
            </button>
            <button type="button" className={`stat${inbox.length ? " hot" : ""}`} onClick={() => go({ view: "runs", filter: "review" })}>
              <span className="value">{inbox.length}</span>
              <span className="label">Runs to review</span>
            </button>
            <button type="button" className={`stat${reviewTasks.length ? " hot" : ""}`} onClick={() => go({ view: "tasks" })}>
              <span className="value">{reviewTasks.length}</span>
              <span className="label">Tasks in review</span>
            </button>
            <button type="button" className="stat" onClick={() => go({ view: "routines" })}>
              <span className="value">{routines.filter((routine) => routine.enabled).length}</span>
              <span className="label">Active routines</span>
            </button>
          </div>

          {onboarding && (
            <>
              <div className="section-title" style={{ marginTop: 26 }}>
                Get set up
              </div>
              <div className="card-grid">
                <button type="button" className="card interactive" onClick={() => go({ view: "code" })}>
                  <div className="hstack">
                    <FolderPlus size={16} className="accent-text" />
                    <h3>Open a workspace</h3>
                    {workspaces.length > 0 && <Chip tone="ok">Done</Chip>}
                  </div>
                  <p className="muted" style={{ margin: "6px 0 0" }}>
                    A project folder with real terminals, your CLIs, a file tree and a browser dock.
                  </p>
                </button>
                <button type="button" className="card interactive" onClick={() => go({ view: "agents" })}>
                  <div className="hstack">
                    <Bot size={16} className="accent-text" />
                    <h3>Name a teammate</h3>
                    {agents.length > 0 && <Chip tone="ok">Done</Chip>}
                  </div>
                  <p className="muted" style={{ margin: "6px 0 0" }}>
                    An agent keeps its brief, memory, skills and allowed folders, whichever CLI runs it.
                  </p>
                </button>
                <button type="button" className="card interactive" onClick={() => go({ view: "chat" })}>
                  <div className="hstack">
                    <MessagesSquare size={16} className="accent-text" />
                    <h3>Ask something quick</h3>
                  </div>
                  <p className="muted" style={{ margin: "6px 0 0" }}>
                    A throwaway chat in an empty scratch folder. No teammate, no project.
                  </p>
                </button>
              </div>
            </>
          )}

          <div className="home-grid">
            <div>
              <div className="section-title">
                <History size={13} /> Needs review {inbox.length > 0 && <span className="count">{inbox.length}</span>}
                <span className="grow" />
                {inbox.length > 1 && (
                  <Button size="sm" variant="ghost" icon={CheckCheck} busy={marking} onClick={() => void markAll()}>
                    Mark all reviewed
                  </Button>
                )}
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {inbox.length === 0 && (
                  <div className="card faint">Finished agent, routine and task runs from the last two days wait here until you open them.</div>
                )}
                {inbox.map((run) => (
                  <RunRow key={run.id} run={run} onClick={() => go({ view: "runs", runId: run.id })} />
                ))}
              </div>
            </div>

            <div>
              <div className="section-title">
                <TerminalSquare size={13} /> Live now
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {live.length === 0 && <div className="card faint">No terminals are running.</div>}
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
                      <span className="meta truncate mono">{tildify(session.cwd, home)}</span>
                    </span>
                    <span className="meta">{duration(session.startedAt, null, now)}</span>
                  </button>
                ))}
              </div>

              <div className="section-title">
                <CalendarClock size={13} /> Up next
              </div>
              <div className="vstack" style={{ gap: 6 }}>
                {upcoming.length === 0 && <div className="card faint">No routines are scheduled.</div>}
                {upcoming.map(({ routine, at }) => (
                  <button key={routine.id} type="button" className="run-row" onClick={() => go({ view: "routines", routineId: routine.id })}>
                    <CalendarClock size={14} className="accent-text" />
                    <span className="vstack grow" style={{ gap: 1 }}>
                      <span className="title truncate">{routine.name}</span>
                      <span className="meta truncate">
                        {routine.agentName ?? "Missing agent"} · {routine.description}
                      </span>
                    </span>
                    <span className="meta">{clockTime(at)}</span>
                  </button>
                ))}
              </div>

              <div className="section-title">
                <Sparkles size={13} /> CLIs on this machine
              </div>
              <div className="engine-strip">
                {available.map((engine) => (
                  <Chip key={engine.id} tone="ok" title={engine.path ?? undefined}>
                    {engine.label}
                  </Chip>
                ))}
                {available.length === 0 && <span className="faint">None found on PATH. Check Settings.</span>}
                <Button size="sm" variant="ghost" onClick={() => go({ view: "settings" })}>
                  Manage
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
