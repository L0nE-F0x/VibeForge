import { useEffect, useRef } from "react";
import { trackLive, useAttention, useChatAttention, useWorkspaceInView } from "./attention.js";
import { call, on, useAgents, useChats, useLive, useSettings, useWindowFocused, useWorkspaces } from "./api.js";
import { useT } from "./i18n/index.js";
import { cue, setSoundSettings } from "./sounds.js";
import { useNav } from "./state.js";

/**
 * Watches the live sessions and finished runs for the whole window: flags CLIs and chats that
 * went quiet out of sight, sends the desktop notification when VibeForge is in the background,
 * and plays the sounds. Mounted once, in the shell.
 */
export function SessionWatch() {
  const t = useT();
  const { route, go } = useNav();
  const live = useLive().data;
  const settings = useSettings().data;
  const agents = useAgents().data;
  const chats = useChats(undefined).data;
  const workspaces = useWorkspaces().data?.workspaces;
  const focused = useWindowFocused();
  const workspaceInView = useWorkspaceInView();
  const names = useRef({ agents, chats, workspaces });
  names.current = { agents, chats, workspaces };
  const routinesSeen = useRef<Set<string> | null>(null);
  const attention = useAttention();
  const chatAttention = useChatAttention();
  const waiting = [...attention.values()].filter((mark) => mark === "waiting").length + [...chatAttention.values()].filter((mark) => mark.attention === "waiting").length;

  // The tray icon gets its amber corner from this.
  useEffect(() => void call("app.attention", waiting).catch(() => undefined), [waiting]);

  useEffect(() => setSoundSettings(settings?.sounds), [settings?.sounds]);

  const chatInView =
    route.view === "agents" && (route.tab ?? "chats") === "chats" ? (route.chatId ?? null) : route.view === "chat" ? (route.chatId ?? null) : null;
  const onScreen = focused ? workspaceInView : null;
  const chatOnScreen = focused ? chatInView : null;

  useEffect(() => {
    if (!live) return;
    const { agents, chats, workspaces } = names.current;
    for (const note of trackLive(live, onScreen, chatOnScreen)) {
      if (note.attention === "waiting") cue("attention");
      if (document.hasFocus()) continue;
      if ("chatId" in note) {
        const agent = agents?.find((item) => item.id === note.agentId);
        const chat = chats?.find((item) => item.id === note.chatId);
        void call("app.notify", {
          title: t(note.attention === "waiting" ? "notify.waiting" : "notify.done", { label: agent?.name ?? note.label }),
          body: chat?.title ?? "",
          chatId: note.chatId,
          agentId: note.agentId,
        }).catch(() => undefined);
      } else {
        void call("app.notify", {
          title: t(note.attention === "waiting" ? "notify.waiting" : "notify.done", { label: note.label }),
          body: workspaces?.find((workspace) => workspace.id === note.workspaceId)?.name ?? "",
          workspaceId: note.workspaceId,
        }).catch(() => undefined);
      }
    }
    // A routine that starts while VibeForge is open; the ones already running at launch don't count.
    const routines = live.filter((session) => session.origin === "routine").map((session) => session.ptyId);
    if (routinesSeen.current && routines.some((ptyId) => !routinesSeen.current!.has(ptyId))) cue("routine");
    routinesSeen.current = new Set(routines);
  }, [live, onScreen, chatOnScreen, t]);

  useEffect(() => {
    const offFinished = on("run-finished", (run) => {
      // A stop is nearly always your own click; chats are covered by the "your turn" knock.
      if (run.outcome === "stopped" || run.origin === "agent-chat" || run.origin === "chat") return;
      cue(run.outcome === "ok" ? "finished" : "failed");
    });
    const offChat = on("open-chat", ({ chatId, agentId }) =>
      go(agentId ? { view: "agents", agentId, tab: "chats", chatId } : { view: "chat", chatId }),
    );
    const offView = on("open-view", ({ view }) => go({ view }));
    return () => {
      offFinished();
      offChat();
      offView();
    };
  }, [go]);

  return null;
}
