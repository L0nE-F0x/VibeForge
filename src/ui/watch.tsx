import { useEffect, useMemo, useRef, useState } from "react";
import { trackLive, usePtyAttention, usePtysInView, useWorkspaceInView, type AttentionMark } from "./attention.js";
import { call, on, useAgents, useChats, useLive, useSettings, useTasks, useWindowFocused, useWorkspaces } from "./api.js";
import { useT, type Translator } from "./i18n/index.js";
import { cue, setSoundSettings } from "./sounds.js";
import { routeForMark, useNav } from "./state.js";

/** How often a CLI sitting on its first screen is looked at again. */
const RECHECK_MS = 2_000;
/** Names listed in one notification before "and N more". */
const NAMED = 3;

interface Names {
  agents: ReturnType<typeof useAgents>["data"];
  chats: ReturnType<typeof useChats>["data"];
  workspaces: NonNullable<ReturnType<typeof useWorkspaces>["data"]>["workspaces"] | undefined;
  tasks: ReturnType<typeof useTasks>["data"];
}

/** Who wants you: the agent's name when there is one, else the CLI's. */
export function markWho(mark: AttentionMark, names: Pick<Names, "agents">): string {
  return names.agents?.find((agent) => agent.id === mark.agentId)?.name ?? mark.label;
}

/** Where it waits: the chat, the task, or the workspace. */
export function markWhere(mark: AttentionMark, names: Omit<Names, "agents">): string {
  if (mark.chatId) return names.chats?.find((chat) => chat.id === mark.chatId)?.title ?? "";
  if (mark.taskId) return names.tasks?.find((task) => task.id === mark.taskId)?.title ?? "";
  return names.workspaces?.find((workspace) => workspace.id === mark.workspaceId)?.name ?? "";
}

function listNames(t: Translator, labels: string[]): string {
  const named = labels.slice(0, NAMED).join(", ");
  return labels.length > NAMED ? t("notify.andMore", { names: named, count: labels.length - NAMED }) : named;
}

/**
 * Watches the live sessions and finished runs for the whole window: marks CLIs that went quiet
 * out of sight, tells the tray who is waiting, sends one desktop notification when VibeForge is
 * in the background, and plays the sounds. Mounted once, in the shell.
 */
export function SessionWatch() {
  const t = useT();
  const { route, go } = useNav();
  const live = useLive().data;
  const settings = useSettings().data;
  const agents = useAgents().data;
  const chats = useChats(undefined).data;
  const workspaces = useWorkspaces().data?.workspaces;
  const tasks = useTasks().data;
  const focused = useWindowFocused();
  const workspaceInView = useWorkspaceInView();
  const ptysInView = usePtysInView();
  const ptyKey = [...ptysInView].sort().join(" ");
  const names = useRef<Names>({ agents, chats, workspaces, tasks });
  names.current = { agents, chats, workspaces, tasks };
  const liveRef = useRef(live);
  liveRef.current = live;
  const routinesSeen = useRef<Set<string> | null>(null);
  const marks = usePtyAttention();
  const [tick, setTick] = useState(0);

  // A CLI on its first screen changes nothing anyone hears about, so look again now and then.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), RECHECK_MS);
    return () => clearInterval(timer);
  }, []);

  // The tray gets its amber corner from the count, and a row per waiter.
  const waiting = useMemo(() => [...marks.values()].filter((mark) => mark.attention === "waiting").sort((a, b) => a.since - b.since), [marks]);
  useEffect(() => {
    const present = new Set((liveRef.current ?? []).map((session) => session.ptyId));
    const waiters = waiting.slice(0, 8).map((mark) => {
      const where = markWhere(mark, names.current);
      return { label: where ? `${markWho(mark, names.current)} · ${where}` : markWho(mark, names.current), route: routeForMark(mark, present.has(mark.ptyId)) };
    });
    void call("app.attention", { count: waiting.length, waiters }).catch(() => undefined);
  }, [waiting, agents, chats, workspaces, tasks]);

  useEffect(() => setSoundSettings(settings?.sounds), [settings?.sounds]);

  const chatInView =
    route.view === "agents" && (route.tab ?? "chats") === "chats" ? (route.chatId ?? null) : route.view === "chat" ? (route.chatId ?? null) : null;
  const looking = useMemo(
    () => (focused ? { ptys: new Set(ptyKey ? ptyKey.split(" ") : []), chatId: chatInView, workspaceId: workspaceInView } : null),
    [focused, ptyKey, chatInView, workspaceInView],
  );

  useEffect(() => {
    if (!live) return;
    const fresh = trackLive(live, looking);
    if (fresh.some((mark) => mark.attention === "waiting")) cue("attention");
    if (fresh.length && !document.hasFocus()) {
      // One notification for everyone who just started waiting (or finished), not one each.
      const urgent = fresh.filter((mark) => mark.attention === "waiting");
      const group = urgent.length ? urgent : fresh;
      const kind = urgent.length ? "waiting" : "done";
      const first = group[0];
      const who = group.map((mark) => markWho(mark, names.current));
      const present = new Set(live.map((session) => session.ptyId));
      void call("app.notify", {
        title: group.length === 1 ? t(kind === "waiting" ? "notify.waiting" : "notify.done", { label: who[0] }) : t(kind === "waiting" ? "notify.waitingMany" : "notify.doneMany", { count: group.length }),
        body: group.length === 1 ? markWhere(first, names.current) : listNames(t, who),
        route: routeForMark(first, present.has(first.ptyId)),
      }).catch(() => undefined);
    }
    // A routine that starts while VibeForge is open; the ones already running at launch don't count.
    const routines = live.filter((session) => session.origin === "routine").map((session) => session.ptyId);
    if (routinesSeen.current && routines.some((ptyId) => !routinesSeen.current!.has(ptyId))) cue("routine");
    routinesSeen.current = new Set(routines);
  }, [live, looking, tick, t]);

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
