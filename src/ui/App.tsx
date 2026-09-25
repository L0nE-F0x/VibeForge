import {
  Activity,
  Bot,
  CalendarClock,
  History,
  House,
  KanbanSquare,
  MessagesSquare,
  Settings as SettingsIcon,
  Sparkles,
  SquareTerminal,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { duration, tildify } from "../shared/text.js";
import { call, on, useAppInfo, useInbox, useLive, useNow, useTasks } from "./api.js";
import { Button, ConfirmDialog, Empty, Logo, Popover, Toasts } from "./components/ui.js";
import { ConfirmProvider, NavProvider, ToastProvider, useNav, useToast, type Route, type ViewName } from "./state.js";
import { AgentsView } from "./views/Agents.js";
import { ChatView } from "./views/Chat.js";
import { CodeView } from "./views/Code.js";
import { HomeView } from "./views/Home.js";
import { RoutinesView } from "./views/Routines.js";
import { RunsView } from "./views/Runs.js";
import { SettingsView } from "./views/Settings.js";
import { SkillsView } from "./views/Skills.js";
import { TasksView } from "./views/Tasks.js";

const VIEWS: Array<{ view: Exclude<ViewName, "settings">; label: string; icon: LucideIcon }> = [
  { view: "home", label: "Home", icon: House },
  { view: "agents", label: "Agents", icon: Bot },
  { view: "code", label: "Code", icon: SquareTerminal },
  { view: "chat", label: "Chat", icon: MessagesSquare },
  { view: "tasks", label: "Tasks", icon: KanbanSquare },
  { view: "routines", label: "Routines", icon: CalendarClock },
  { view: "skills", label: "Skills", icon: Sparkles },
  { view: "runs", label: "Runs", icon: History },
];

export function App() {
  return (
    <NavProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
          <Toasts />
          <ConfirmDialog />
        </ConfirmProvider>
      </ToastProvider>
    </NavProvider>
  );
}

function Shell() {
  const { route, go, back } = useNav();
  const { push } = useToast();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-8]$/.test(event.key)) {
        event.preventDefault();
        go({ view: VIEWS[Number(event.key) - 1].view } as Route);
      } else if (event.ctrlKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        go({ view: "settings" });
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        void call("app.toggleDevTools");
      }
    };
    window.addEventListener("keydown", onKey);
    const offRun = on("open-run", ({ runId }) => go({ view: "runs", runId }));
    const offCrash = on("host-crash", (message) => push("error", "Terminal host problem", message));
    return () => {
      window.removeEventListener("keydown", onKey);
      offRun();
      offCrash();
    };
  }, [go, back, push]);

  return (
    <div className="app">
      <Rail />
      <main className="stage">
        <CrashBoundary key={route.view}>
          {route.view === "home" && <HomeView />}
          {route.view === "agents" && <AgentsView route={route} />}
          {route.view === "chat" && <ChatView route={route} />}
          {route.view === "tasks" && <TasksView route={route} />}
          {route.view === "routines" && <RoutinesView route={route} />}
          {route.view === "skills" && <SkillsView route={route} />}
          {route.view === "runs" && <RunsView route={route} />}
          {route.view === "settings" && <SettingsView />}
        </CrashBoundary>
        <CrashBoundary>
          <CodeView active={route.view === "code"} route={route.view === "code" ? route : null} />
        </CrashBoundary>
      </main>
    </div>
  );
}

function Rail() {
  const { route, go } = useNav();
  const inbox = useInbox().data ?? [];
  const tasks = useTasks().data ?? [];
  const live = useLive().data ?? [];
  const review = tasks.filter((task) => task.status === "review").length;
  const [liveAnchor, setLiveAnchor] = useState<HTMLElement | null>(null);

  const badge = (view: ViewName): number => {
    if (view === "runs") return inbox.length;
    if (view === "tasks") return review;
    return 0;
  };

  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-logo" title="VibeForge">
        <Logo size={20} />
      </div>
      {VIEWS.map((item, index) => {
        const count = badge(item.view);
        return (
          <button
            key={item.view}
            type="button"
            className="rail-btn"
            aria-current={route.view === item.view ? "page" : undefined}
            title={`${item.label} (Ctrl+${index + 1})`}
            onClick={() => go({ view: item.view } as Route)}
          >
            <item.icon size={19} strokeWidth={1.9} />
            <span>{item.label}</span>
            {count > 0 && <span className="rail-badge">{count > 99 ? "99+" : count}</span>}
          </button>
        );
      })}
      <div className="rail-foot">
        <button
          type="button"
          className="rail-btn"
          aria-pressed={Boolean(liveAnchor)}
          title="Running terminals"
          onClick={(event) => setLiveAnchor(liveAnchor ? null : event.currentTarget)}
        >
          <Activity size={19} strokeWidth={1.9} className={live.length ? "accent-text" : undefined} />
          <span className={live.length ? "live-pulse" : undefined}>{live.length ? `${live.length} live` : "Idle"}</span>
        </button>
        <button
          type="button"
          className="rail-btn"
          aria-current={route.view === "settings" ? "page" : undefined}
          title="Settings (Ctrl+,)"
          onClick={() => go({ view: "settings" })}
        >
          <SettingsIcon size={19} strokeWidth={1.9} />
          <span>Settings</span>
        </button>
      </div>
      {liveAnchor && <LivePopover anchor={liveAnchor} onClose={() => setLiveAnchor(null)} />}
    </nav>
  );
}

function LivePopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const { go } = useNav();
  const live = useLive().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const now = useNow(1000);
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="list-label" style={{ paddingTop: 6 }}>
        Running terminals
      </div>
      {live.length === 0 && <div className="faint" style={{ padding: "6px 9px 10px" }}>Nothing is running.</div>}
      {live.map((session) => (
        <button
          key={session.ptyId}
          type="button"
          className="menu-item"
          onClick={() => {
            onClose();
            if (session.origin === "agent-chat" && session.agentId && session.chatId) go({ view: "agents", agentId: session.agentId, tab: "chats", chatId: session.chatId });
            else if (session.origin === "chat" && session.chatId) go({ view: "chat", chatId: session.chatId });
            else if (session.origin === "task" && session.taskId) go({ view: "tasks", taskId: session.taskId });
            else if (session.workspaceId && (session.origin === "code" || session.kind === "shell")) go({ view: "code", workspaceId: session.workspaceId, ptyId: session.ptyId });
            else if (session.runId) go({ view: "runs", runId: session.runId });
          }}
        >
          {session.kind === "shell" ? <TerminalSquare size={14} /> : <span className="dot running" />}
          <span className="vstack grow" style={{ gap: 0 }}>
            <span className="truncate" style={{ color: "var(--fg)" }}>
              {session.title}
            </span>
            <span className="truncate faint mono" style={{ fontSize: "var(--fs-xs)" }}>
              {tildify(session.cwd, home)}
            </span>
          </span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {duration(session.startedAt, null, now)}
          </span>
        </button>
      ))}
    </Popover>
  );
}

class CrashBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return (
        <Empty
          icon={Activity}
          title="This view hit a problem"
          actions={
            <Button variant="primary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        >
          <span className="mono selectable">{this.state.error.message}</span>
        </Empty>
      );
    }
    return this.props.children;
  }
}
