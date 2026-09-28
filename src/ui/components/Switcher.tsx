import { Bot, CalendarClock, Keyboard, KanbanSquare, MessagesSquare, Mic, Power, Search, Settings as SettingsIcon, Sparkles, SquareTerminal, Volume2, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tildify } from "../../shared/text.js";
import { useAgents, useAppInfo, useChats, useRoutines, useSettings, useSkills, useTasks, useWorkspaces } from "../api.js";
import { fuzzyScore } from "../fuzzy.js";
import { useT, type Key } from "../i18n/index.js";
import { railViews } from "../rail.js";
import { useNav, useOverlay } from "../state.js";
import { SHOW_SHORTCUTS_EVENT } from "./Help.js";

// Ctrl+K: type part of a name and press Enter to land on any agent, chat, workspace, task,
// routine, skill or view. Ctrl+Shift+K does the same from inside a terminal, where Ctrl+K
// belongs to the program.

export const OPEN_SWITCHER_EVENT = "vibeforge:open-switcher";

interface Item {
  id: string;
  title: string;
  sub?: string;
  kind: Key;
  icon: LucideIcon;
  act: () => void;
}

const LIMIT = 60;

export function Switcher({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { go, open } = useNav();
  const home = useAppInfo().data?.home ?? "";
  const rail = useSettings().data?.rail;
  const agents = useAgents().data;
  const chats = useChats(undefined).data;
  const workspaces = useWorkspaces().data?.workspaces;
  const tasks = useTasks().data;
  const routines = useRoutines().data;
  const skills = useSkills().data;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useOverlay(true);

  const items = useMemo<Item[]>(() => {
    const settingsAt = (id: string) => () => {
      go({ view: "settings" });
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
    };
    const agentName = (id: string | null) => agents?.find((agent) => agent.id === id)?.name;
    return [
      ...railViews(rail).visible.map((item): Item => ({ id: `view:${item.view}`, title: t(item.label), kind: "switcher.view", icon: item.icon, act: () => open(item.view) })),
      { id: "view:settings", title: t("settings.title"), kind: "switcher.view", icon: SettingsIcon, act: () => go({ view: "settings" }) },
      ...(agents ?? []).map((agent): Item => ({
        id: `agent:${agent.id}`,
        title: agent.name,
        kind: "switcher.agent",
        icon: Bot,
        act: () => go({ view: "agents", agentId: agent.id, tab: "chats" }),
      })),
      ...(workspaces ?? []).map((workspace): Item => ({
        id: `workspace:${workspace.id}`,
        title: workspace.name,
        sub: tildify(workspace.path, home),
        kind: "switcher.workspace",
        icon: SquareTerminal,
        act: () => go({ view: "code", workspaceId: workspace.id }),
      })),
      ...[...(chats ?? [])]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((chat): Item => ({
          id: `chat:${chat.id}`,
          title: chat.title,
          sub: agentName(chat.agentId),
          kind: "switcher.chat",
          icon: MessagesSquare,
          act: () => go(chat.agentId ? { view: "agents", agentId: chat.agentId, tab: "chats", chatId: chat.id } : { view: "chat", chatId: chat.id }),
        })),
      ...(tasks ?? []).map((task): Item => ({ id: `task:${task.id}`, title: task.title, kind: "switcher.task", icon: KanbanSquare, act: () => go({ view: "tasks", taskId: task.id }) })),
      ...(routines ?? []).map((routine): Item => ({
        id: `routine:${routine.id}`,
        title: routine.name,
        sub: routine.agentName ?? undefined,
        kind: "switcher.routine",
        icon: CalendarClock,
        act: () => go({ view: "routines", routineId: routine.id }),
      })),
      ...(skills ?? []).map((skill): Item => ({ id: `skill:${skill.id}`, title: skill.name, sub: skill.description, kind: "switcher.skill", icon: Sparkles, act: () => go({ view: "skills", skillId: skill.id }) })),
      { id: "settings:voice", title: `${t("settings.title")} · ${t("voice.title")}`, kind: "switcher.setting", icon: Mic, act: settingsAt("settings-voice") },
      { id: "settings:sounds", title: `${t("settings.title")} · ${t("sounds.title")}`, kind: "switcher.setting", icon: Volume2, act: settingsAt("settings-sounds") },
      { id: "settings:tray", title: `${t("settings.title")} · ${t("tray.title")}`, kind: "switcher.setting", icon: Power, act: settingsAt("settings-tray") },
      { id: "shortcuts", title: t("shortcuts.title"), kind: "switcher.setting", icon: Keyboard, act: () => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)) },
    ];
  }, [agents, chats, workspaces, tasks, routines, skills, rail, home, t, go, open]);

  const shown = useMemo(() => {
    if (!query.trim()) return items.slice(0, LIMIT);
    return items
      .map((item) => {
        const title = fuzzyScore(query, item.title);
        // The second line (a path, an agent's name) counts only when it holds the query as typed,
        // and below a match in the name: scattered letters match almost any long path.
        const sub = item.sub?.toLowerCase().includes(query.trim().toLowerCase()) ? fuzzyScore(query, item.sub) : -1;
        return { item, score: Math.max(title, sub >= 0 ? sub / 3 : -1) };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((entry) => entry.item);
  }, [items, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.act();
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setActive((index) => (shown.length ? (index + 1) % shown.length : 0));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setActive((index) => (shown.length ? (index - 1 + shown.length) % shown.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    }
  };

  return createPortal(
    <div className="scrim switcher-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-modal aria-label={t("switcher.title")}>
        <div className="switcher-input">
          <Search size={15} className="faint" />
          <input
            autoFocus
            value={query}
            placeholder={t("switcher.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded
            aria-controls="switcher-list"
            aria-activedescendant={shown[active] ? `switcher-${active}` : undefined}
          />
        </div>
        <div className="switcher-list" id="switcher-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="faint switcher-empty">{t("switcher.nothing")}</div>}
          {shown.map((item, index) => (
            <div
              key={item.id}
              id={`switcher-${index}`}
              data-index={index}
              role="option"
              className="row"
              aria-selected={index === active}
              onMouseMove={() => index !== active && setActive(index)}
              onClick={() => choose(item)}
            >
              <item.icon size={15} className={index === active ? "accent-text" : "faint"} />
              <span className="vstack grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="row-title truncate">{item.title}</span>
                {item.sub && <span className="row-sub truncate">{item.sub}</span>}
              </span>
              <span className="switcher-kind">{t(item.kind)}</span>
            </div>
          ))}
        </div>
        <div className="switcher-foot faint">{t("switcher.keys")}</div>
      </div>
    </div>,
    document.body,
  );
}
