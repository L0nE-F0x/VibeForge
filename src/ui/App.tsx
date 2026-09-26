import { Activity, CircleHelp, EyeOff, Settings as SettingsIcon, SlidersHorizontal, TerminalSquare } from "lucide-react";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { duration, tildify } from "../shared/text.js";
import { call, on, useAppInfo, useInbox, useLive, useNow, useSettings, useTasks, useUpdate, useWorkspaces } from "./api.js";
import { HelpPopover, SHOW_SHORTCUTS_EVENT, ShortcutsModal } from "./components/Help.js";
import { TOGGLE_PANEL_EVENT } from "./components/SidePanel.js";
import { TooltipLayer, tipProps } from "./components/Tooltip.js";
import { START_TOUR_EVENT, Tour } from "./components/Tour.js";
import { SHOW_UPDATE_EVENT, UpdateSheet } from "./components/Update.js";
import { VoiceLayer } from "./voice.js";
import { Button, ConfirmDialog, Empty, Logo, Menu, Popover, Toasts } from "./components/ui.js";
import { applyLanguageSetting, t as translateNow, useT } from "./i18n/index.js";
import { PINNED, railViews, type RailView } from "./rail.js";
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

export function App() {
  return (
    <NavProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
          <Toasts />
          <ConfirmDialog />
          <TooltipLayer />
        </ConfirmProvider>
      </ToastProvider>
    </NavProvider>
  );
}

function Shell() {
  const { route, go, back } = useNav();
  const { push } = useToast();
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const rail = useSettings().data?.rail;
  const railRef = useRef(rail);
  railRef.current = rail;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const item = railViews(railRef.current).visible[Number(event.key) - 1];
        if (!item) return;
        event.preventDefault();
        go({ view: item.view } as Route);
      } else if (event.ctrlKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        go({ view: "settings" });
      } else if (event.altKey && !event.ctrlKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
        const workspace = workspacesRef.current[Number(event.code.slice(5)) - 1];
        if (!workspace) return;
        event.preventDefault();
        go({ view: "code", workspaceId: workspace.id });
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.ctrlKey && event.shiftKey && event.code === "Slash") {
        event.preventDefault();
        window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT));
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        window.dispatchEvent(new Event(TOGGLE_PANEL_EVENT));
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
      <Guides />
      <VoiceLayer />
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

/** The welcome tour (first launch, or replayed from Help) and the shortcut sheet. */
function Guides() {
  const settings = useSettings().data;
  const appPath = useAppInfo().data?.appPath ?? "";
  const [tour, setTour] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [update, setUpdate] = useState(false);
  const autoOpened = useRef(false);

  useEffect(() => applyLanguageSetting(settings?.language ?? "system"), [settings?.language]);

  useEffect(() => {
    if (!settings || autoOpened.current) return;
    autoOpened.current = true;
    if (!settings.tourDone) setTour(true);
  }, [settings]);

  useEffect(() => {
    const start = () => {
      setShortcuts(false);
      setTour(true);
    };
    const keys = () => setShortcuts((open) => !open);
    const showUpdate = () => setUpdate(true);
    window.addEventListener(START_TOUR_EVENT, start);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, keys);
    window.addEventListener(SHOW_UPDATE_EVENT, showUpdate);
    return () => {
      window.removeEventListener(START_TOUR_EVENT, start);
      window.removeEventListener(SHOW_SHORTCUTS_EVENT, keys);
      window.removeEventListener(SHOW_UPDATE_EVENT, showUpdate);
    };
  }, []);

  const closeTour = useCallback(() => {
    setTour(false);
    void call("settings.save", { tourDone: true });
  }, []);
  const closeShortcuts = useCallback(() => setShortcuts(false), []);

  return (
    <>
      {tour && <Tour onClose={closeTour} />}
      {shortcuts && !tour && <ShortcutsModal onClose={closeShortcuts} />}
      {update && !tour && <UpdateSheet appPath={appPath} onClose={() => setUpdate(false)} />}
    </>
  );
}

function Rail() {
  const t = useT();
  const { route, go } = useNav();
  const update = useUpdate().data;
  const waiting = update?.available && update.latest ? update.latest.version : null;
  const inbox = useInbox().data ?? [];
  const tasks = useTasks().data ?? [];
  const live = useLive().data ?? [];
  const review = tasks.filter((task) => task.status === "review").length;
  const [liveAnchor, setLiveAnchor] = useState<HTMLElement | null>(null);
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const [viewMenu, setViewMenu] = useState<{ view: RailView; anchor: HTMLElement } | null>(null);
  const rail = useSettings().data?.rail;
  const { visible } = railViews(rail);
  const hide = (view: RailView) => void call("settings.save", { rail: { order: rail?.order ?? [], hidden: [...(rail?.hidden ?? []), view] } });

  const badge = (view: ViewName): number => {
    if (view === "runs") return inbox.length;
    if (view === "tasks") return review;
    return 0;
  };

  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-logo" {...tipProps("VibeForge", { side: "right" })}>
        <Logo size={22} />
      </div>
      {visible.map((item, index) => {
        const count = badge(item.view);
        return (
          <button
            key={item.view}
            type="button"
            className="rail-btn"
            aria-current={route.view === item.view ? "page" : undefined}
            aria-label={t(item.label)}
            {...tipProps(t(item.tip), { kbd: index < 9 ? `Ctrl+${index + 1}` : undefined, side: "right" })}
            onClick={() => go({ view: item.view } as Route)}
            onContextMenu={(event) => {
              event.preventDefault();
              setViewMenu({ view: item.view, anchor: event.currentTarget });
            }}
          >
            <item.icon size={19} strokeWidth={1.9} />
            <span>{t(item.label)}</span>
            {count > 0 && <span className="rail-badge">{count > 99 ? "99+" : count}</span>}
          </button>
        );
      })}
      <div className="rail-foot">
        <button
          type="button"
          className="rail-btn"
          aria-pressed={Boolean(liveAnchor)}
          {...tipProps(live.length ? t("rail.tip.liveSome") : t("rail.tip.liveNone"), { side: "right" })}
          onClick={(event) => setLiveAnchor(liveAnchor ? null : event.currentTarget)}
        >
          <Activity size={19} strokeWidth={1.9} className={live.length ? "accent-text" : undefined} />
          <span className={live.length ? "live-pulse" : undefined}>{live.length ? t.count("rail.live", live.length) : t("rail.idle")}</span>
        </button>
        <button
          type="button"
          className="rail-btn"
          data-tour="help"
          aria-pressed={Boolean(helpAnchor)}
          {...tipProps(waiting ? t("rail.tip.helpUpdate", { version: waiting }) : t("rail.tip.help"), { side: "right" })}
          onClick={(event) => setHelpAnchor(helpAnchor ? null : event.currentTarget)}
        >
          <CircleHelp size={19} strokeWidth={1.9} />
          <span>{t("rail.help")}</span>
          {waiting && <span className="rail-dot" />}
        </button>
        <button
          type="button"
          className="rail-btn"
          aria-current={route.view === "settings" ? "page" : undefined}
          {...tipProps(t("rail.tip.settings"), { kbd: "Ctrl+,", side: "right" })}
          onClick={() => go({ view: "settings" })}
        >
          <SettingsIcon size={19} strokeWidth={1.9} />
          <span>{t("rail.settings")}</span>
        </button>
      </div>
      {viewMenu && (
        <Popover anchor={viewMenu.anchor} onClose={() => setViewMenu(null)}>
          <Menu
            onClose={() => setViewMenu(null)}
            items={[
              ...(viewMenu.view === PINNED ? [] : [{ label: t("rail.hide", { view: t(`rail.${viewMenu.view}`) }), icon: EyeOff, onSelect: () => hide(viewMenu.view) }]),
              { label: t("rail.customize"), icon: SlidersHorizontal, onSelect: () => go({ view: "settings" }) },
            ]}
          />
        </Popover>
      )}
      {liveAnchor && <LivePopover anchor={liveAnchor} onClose={() => setLiveAnchor(null)} />}
      {helpAnchor && <HelpPopover anchor={helpAnchor} onClose={() => setHelpAnchor(null)} />}
    </nav>
  );
}

function LivePopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const t = useT();
  const { go } = useNav();
  const live = useLive().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const now = useNow(1000);
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="list-label" style={{ paddingTop: 6 }}>
        {t("live.title")}
      </div>
      {live.length === 0 && <div className="faint" style={{ padding: "6px 9px 10px" }}>{t("live.none")}</div>}
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
              {session.program ?? session.title}
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
          title={translateNow("crash.title")}
          actions={
            <Button variant="primary" onClick={() => this.setState({ error: null })}>
              {translateNow("common.tryAgain")}
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
