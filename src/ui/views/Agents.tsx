import {
  Bot,
  BookOpen,
  Brain,
  FolderOpen,
  FolderPlus,
  History,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChatAttention } from "../attention.js";
import type { Agent, AgentTier, ChatView, Engine } from "../../shared/api.js";
import { listText, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useChats, useEngines, useInbox, useLive, useQuery, useSettings, useSkills } from "../api.js";
import { autosaveDue, oneLine } from "../autosave.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { SessionPane } from "../components/Session.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { LoadFailed, UnreadableFiles, useUnreadableOf } from "../components/LoadState.js";
import { Avatar, Button, Chip, Empty, Field, Input, Modal, Notice, SecretNote, Segmented, Select, StatusDot, Tabs, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { ListBar, NoMatch, PickMark, activeFilterLabels, useList, type ListLabels, type ListRules } from "../components/ListTools.js";
import { matchesQuery, nameOrder, timeOf, type ListSpec } from "../list-view.js";
import { deleteEach, useAction, useConfirm, useDeleted, useDeletedMany, useDropMissing, useNav, useToast, type AgentTab, type Route } from "../state.js";
import { forget, recall, remember } from "../remember.js";
import { isShortcut } from "../shortcuts.js";
import { RunRow } from "./Home.js";
import { AGENT_CHAT_LIST, useChatList } from "./chat-list.js";
import { EngineStandIn, LibraryConflicts, SyncMark, SyncSwitch, WaitingFolders, useLibrary, useSyncReady } from "../components/LibrarySync.js";
import { useT } from "../i18n/index.js";

/** Save on Ctrl+S while a form is on screen. */
export function useSaveShortcut(save: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (isShortcut("form.save", event)) {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save, enabled]);
}

/**
 * A page editor saves on its own a moment after typing stops, and on the way out; Ctrl+S saves at
 * once. `value` is what is being edited, so each change restarts the wait. Each value is tried
 * once (see autosaveDue), so one that doesn't stick isn't saved again every second.
 */
export function useAutosave(value: unknown, dirty: boolean, ready: boolean, save: () => void, delay = 800): () => void {
  const latest = useRef({ save, dirty, ready });
  const cancelled = useRef(false);
  latest.current = { save, dirty: dirty && !cancelled.current, ready };
  const key = JSON.stringify(value);
  const attempted = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (cancelled.current || !autosaveDue(key, attempted.current, dirty, ready)) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (cancelled.current) return;
      attempted.current = key;
      latest.current.save();
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [key, dirty, ready, delay]);
  useEffect(
    () => () => {
      if (!cancelled.current && latest.current.dirty && latest.current.ready) latest.current.save();
    },
    [],
  );
  useSaveShortcut(() => latest.current.save(), dirty && ready && !cancelled.current);
  return () => {
    cancelled.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    latest.current.dirty = false;
  };
}

/** Where an autosaving editor is: saving, waiting to save, or saved (with what that means). */
export function SaveState({ dirty, saving, note }: { dirty: boolean; saving: boolean; note?: ReactNode }) {
  const t = useT();
  return <span className="faint save-state">{saving ? t("common.saving") : dirty ? t("common.unsaved") : (note ?? t("common.saved"))}</span>;
}

export function EngineSelect({ engines, value, onChange, allowMissing }: { engines: Engine[]; value: string; onChange: (id: string) => void; allowMissing?: string }) {
  const t = useT();
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {!value && <option value="">{t("agents.pickEngine")}</option>}
      {engines
        .filter((engine) => engine.available || engine.id === allowMissing)
        .map((engine) => (
          <option key={engine.id} value={engine.id}>
            {engine.label}
            {engine.available ? "" : ` ${t("common.notOnPath")}`}
          </option>
        ))}
    </Select>
  );
}

// ------------------------------------------------------------------ view

const AGENT_SCOPE = "agents.tab";
const AGENT_TABS: readonly AgentTab[] = ["chats", "brief", "memory", "skills", "folders", "runs", "settings"];

function isAgentPlace(value: unknown): value is { tab: AgentTab; chatId?: string } {
  const place = value as { tab?: unknown; chatId?: unknown } | null;
  return Boolean(place && AGENT_TABS.includes(place.tab as AgentTab) && (place.chatId === undefined || typeof place.chatId === "string"));
}

/**
 * Where an agent was left: its tab, and the chat last open on its Chats tab (kept while on another
 * tab, so going back to Chats finds it). A new one starts on Chats.
 */
function agentPlace(agentId: string): { agentId: string; tab: AgentTab; chatId?: string } {
  const place = recall(AGENT_SCOPE, agentId, isAgentPlace);
  return { agentId, tab: place?.tab ?? "chats", chatId: place?.tab === "chats" ? place.chatId : undefined };
}

/** The chat last open on an agent's Chats tab. */
function lastChat(agentId: string): string | undefined {
  return recall(AGENT_SCOPE, agentId, isAgentPlace)?.chatId;
}

type AgentFilter = "live" | "waiting" | "review" | "missing";
type AgentSort = "name" | "recent" | "engine";
const AGENT_LIST: ListSpec<AgentFilter, AgentSort> = { key: "agents", filters: ["live", "waiting", "review", "missing"], sorts: ["name", "recent", "engine"], defaultSort: "name" };

export function AgentsView({ route }: { route: Extract<Route, { view: "agents" }> }) {
  const t = useT();
  const { go, replace } = useNav();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const deletedMany = useDeletedMany();
  const agents = useAgents();
  const unreadableFiles = useUnreadableOf("agent").length;
  const chats = useChats(undefined).data ?? [];
  const inbox = useInbox().data ?? [];
  const engines = useEngines().data ?? [];
  const sessions = useLive().data ?? [];
  const [creating, setCreating] = useState(false);
  const library = useLibrary().data;
  const syncReady = useSyncReady().ready;
  const list = agents.data ?? [];
  // A list that couldn't be read says so, and isn't taken for "no agents" (nor drops the one asked for).
  const unreadable = agents.error !== null && agents.data === undefined;
  const selected = list.find((agent) => agent.id === route.agentId) ?? null;
  useDropMissing(agents.loaded && !unreadable, Boolean(route.agentId) && !selected, { view: "agents" });
  const chatAttention = useChatAttention();
  const wants = (agentId: string) => [...chatAttention.values()].some((mark) => mark.agentId === agentId && mark.attention === "waiting");

  useEffect(() => {
    if (!route.agentId && list.length > 0) replace({ view: "agents", ...agentPlace(list[0].id) });
  }, [route.agentId, list, replace]);
  // Each agent keeps the tab (and chat) it was left on; a link that names no tab lands there too.
  const tab = route.tab ?? (route.agentId ? agentPlace(route.agentId).tab : "chats");
  const chatId = route.tab ? route.chatId : route.agentId ? agentPlace(route.agentId).chatId : undefined;
  useEffect(() => {
    if (route.agentId && selected) remember(AGENT_SCOPE, route.agentId, { tab, chatId: tab === "chats" ? chatId : lastChat(route.agentId) });
  }, [route.agentId, selected, tab, chatId]);

  // ------------------------------------------------ search, filter, sort, select
  const engineOf = (agent: Agent) => engines.find((item) => item.id === agent.engine);
  const chatLive = (agentId: string) => chats.some((chat) => chat.agentId === agentId && chat.live);
  const unreadOf = (agentId: string) => inbox.filter((run) => run.agentId === agentId).length;
  // Its latest chat, else when it was last changed.
  const activeAt = (agent: Agent) => Math.max(timeOf(agent.updatedAt), ...chats.filter((chat) => chat.agentId === agent.id).map((chat) => timeOf(chat.updatedAt)));
  const collator = nameOrder(t.language);
  const rules: ListRules<Agent, AgentFilter, AgentSort> = {
    test: (filter, agent) => {
      if (filter === "live") return chatLive(agent.id);
      if (filter === "waiting") return wants(agent.id);
      if (filter === "review") return unreadOf(agent.id) > 0;
      const engine = engineOf(agent);
      return Boolean(engine && !engine.available);
    },
    search: (query, agent) => matchesQuery(query, agent.name, engineOf(agent)?.label ?? agent.engine, agent.goodAt),
    compare: (sort, a, b) => {
      if (sort === "recent") return Number(chatLive(b.id)) - Number(chatLive(a.id)) || activeAt(b) - activeAt(a);
      if (sort === "engine") return collator.compare(engineOf(a)?.label ?? a.engine, engineOf(b)?.label ?? b.engine) || collator.compare(a.name, b.name);
      return collator.compare(a.name, b.name);
    },
  };
  const view = useList(AGENT_LIST, list, rules, (agent) => agent.id);
  const { selection } = view;
  const labels: ListLabels<AgentFilter, AgentSort> = {
    filters: { live: t("agents.filter.live"), waiting: t("list.filter.waiting"), review: t("agents.filter.review"), missing: t("agents.filter.missing") },
    sorts: { name: t("list.sort.name"), recent: t("list.sort.recent"), engine: t("list.sort.engine") },
    sortChips: { name: t("list.sortShort.name"), recent: t("list.sortShort.recent"), engine: t("list.sortShort.engine") },
  };
  const [deletePicked, deleting] = useAction(async () => {
    const picked = selection.picked;
    if (!picked.length) return;
    // Deleting is undone from the toast. Only a running session asks first: stopping it can't be undone.
    const running = picked.filter((agent) => sessions.some((session) => session.agentId === agent.id && session.runId)).length;
    if (running) {
      const one = picked.length === 1;
      const ok = await confirm({
        title: one ? t("common.deleteNamed", { name: picked[0].name }) : t.count("agents.deleteManyTitle", picked.length),
        body: one ? t("agents.deleteRunningBody") : t.count("list.deleteLiveBody", running),
        confirm: t("common.stopAndDelete"),
        danger: true,
      });
      if (!ok) return;
    }
    const { gone, deleted: undo, error } = await deleteEach(picked, (agent) => call("agents.delete", agent.id));
    for (const agent of gone) forget(AGENT_SCOPE, agent.id);
    if (selected && gone.includes(selected)) {
      // Straight to one that is left: the list hasn't reloaded yet.
      const left = view.shown.find((agent) => !gone.includes(agent)) ?? list.find((agent) => !gone.includes(agent));
      go(left ? { view: "agents", ...agentPlace(left.id) } : { view: "agents" });
    }
    if (gone.length === 1) deleted(t("common.deletedNamed", { name: gone[0].name }), undo[0]);
    else deletedMany(t.count("agents.deletedMany", gone.length), undo);
    if (error) throw error;
    selection.setSelecting(false);
  }, t("agents.deleteFailed"));
  // All of them syncing already: the button stops them; otherwise it starts the rest.
  const pickedSync = selection.picked.length > 0 && selection.picked.every((agent) => library?.agents[agent.id]?.on);
  const [syncPicked, syncing] = useAction(async () => {
    for (const agent of selection.picked) if (Boolean(library?.agents[agent.id]?.on) === pickedSync) await call("sync.setAgent", agent.id, !pickedSync);
  }, t("library.setFailed"));

  return (
    <div className="view split-list">
      <SidePanel
        id="agents"
        title={t("agents.title")}
        actions={
          <Button size="sm" icon={Plus} onClick={() => setCreating(true)} tip={t("agents.newTip")}>
            {t("common.new")}
          </Button>
        }
        strip={
          <>
            <StripItem label={t("agents.empty.action")} onClick={() => setCreating(true)}>
              <Plus size={16} />
            </StripItem>
            {view.ordered.map((agent) => (
              <StripItem
                key={agent.id}
                label={agent.name}
                selected={agent.id === selected?.id}
                onClick={() => go({ view: "agents", ...agentPlace(agent.id) })}
                badge={wants(agent.id) ? <span className="ws-state waiting in-strip" /> : chats.some((chat) => chat.agentId === agent.id && chat.live) ? <span className="strip-live" /> : undefined}
              >
                <Avatar name={agent.name} />
              </StripItem>
            ))}
          </>
        }
      >
        <ListBar
          list={view}
          labels={labels}
          placeholder={t("agents.search")}
          selectTip={t("list.selectDeleteTip")}
          actions={
            <>
              {syncReady && (
                <Button size="sm" icon={RefreshCw} busy={syncing} disabled={!selection.picked.length} onClick={() => void syncPicked()} tip={t(pickedSync ? "library.stopPickedTip" : "library.syncPickedTip")}>
                  {t(pickedSync ? "library.stopPicked" : "library.syncPicked")}
                </Button>
              )}
              <Button size="sm" variant="danger" icon={Trash2} busy={deleting} disabled={!selection.picked.length} onClick={() => void deletePicked()} tip={t("list.deleteSelectedTip")}>
                {t("common.delete")}
              </Button>
            </>
          }
        />
        <div className="list-scroll" onKeyDown={selection.onKeyDown}>
          <LoadFailed query={agents} />
          <UnreadableFiles kind="agent" reload={agents.reload} />
          {agents.loaded && !unreadable && !unreadableFiles && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("agents.none")}</div>}
          {list.length > 0 && view.shown.length === 0 && <NoMatch hasQuery={view.hasQuery} filters={activeFilterLabels(view, labels)} onClear={view.clear} />}
          {view.shown.map((agent) => {
            const live = chatLive(agent.id);
            const unread = unreadOf(agent.id);
            const engine = engineOf(agent);
            return (
              <button
                key={agent.id}
                type="button"
                className={`row${wants(agent.id) ? " needs-you" : ""}`}
                aria-current={(!selection.selecting && agent.id === selected?.id) || undefined}
                aria-pressed={selection.selecting ? selection.isPicked(agent.id) : undefined}
                onClick={() => (selection.selecting ? selection.toggle(agent.id) : go({ view: "agents", ...agentPlace(agent.id) }))}
              >
                {selection.selecting ? <PickMark picked={selection.isPicked(agent.id)} /> : <Avatar name={agent.name} />}
                <span className="vstack grow" style={{ gap: 0 }}>
                  <span className="row-title truncate">{agent.name}</span>
                  <span className="row-sub truncate" style={engine && !engine.available ? { color: "var(--red)" } : undefined}>
                    {engine?.label ?? agent.engine}
                    {engine && !engine.available ? ` · ${t("common.missing")}` : ""}
                  </span>
                </span>
                <SyncMark item={library?.agents[agent.id]} />
                {unread > 0 && (
                  <Chip tone="accent" title={t.count("home.status.review", unread).replaceAll("**", "")}>
                    {unread}
                  </Chip>
                )}
                {live && <StatusDot status="running" title={t("agents.chatLive")} />}
              </button>
            );
          })}
        </div>
      </SidePanel>
      {selected ? (
        <AgentDetail key={selected.id} agent={selected} tab={tab} chatId={chatId} />
      ) : unreadable ? null : (
        <Empty
          icon={Bot}
          title={t("agents.empty.title")}
          actions={
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              {t("agents.empty.action")}
            </Button>
          }
        >
          {t("agents.empty.body")}
        </Empty>
      )}
      {creating && (
        <NewAgent
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            go({ view: "agents", agentId: agent.id, tab: "chats" });
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ create

function FolderList({ places, onRemove, home }: { places: string[]; onRemove?: (place: string) => void; home: string }) {
  const t = useT();
  const exists = useQuery(`exists:${places.join("|")}`, [], async () => Promise.all(places.map((place) => call("app.pathExists", place))));
  return (
    <div className="vstack" style={{ gap: 6 }}>
      {places.map((place, index) => (
        <div key={place} className="card hstack" style={{ padding: "8px 10px" }}>
          <FolderOpen size={14} className={exists.data?.[index] === false ? undefined : "accent-text"} style={exists.data?.[index] === false ? { color: "var(--red)" } : undefined} />
          <span className="mono truncate grow">{tildify(place, home)}</span>
          {exists.data?.[index] === false && <Chip tone="bad">{t("common.missing")}</Chip>}
          <Button size="sm" variant="ghost" icon={FolderOpen} title={t("common.open")} onClick={() => void call("app.openPath", place)} />
          {onRemove && <Button size="sm" variant="ghost" icon={X} title={t("common.remove")} onClick={() => onRemove(place)} />}
        </div>
      ))}
    </div>
  );
}

const NEW_AGENT_DRAFT = "agent:new";

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const home = useAppInfo().data?.home ?? "";
  const available = engines.filter((engine) => engine.available);
  // Kept as a draft, as a new task, skill or routine is: Esc or a click outside doesn't lose a long brief.
  const [form, setForm] = useDraftState(NEW_AGENT_DRAFT, { name: "", brief: "", engine: "", places: [] as string[], allowRoutines: true, goodAt: "" });
  const { name, brief, engine, places, allowRoutines } = form;
  const goodAt = form.goodAt ?? "";
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setBrief = (next: string) => setForm((prev) => ({ ...prev, brief: next }));
  const setEngine = (next: string) => setForm((prev) => ({ ...prev, engine: next }));
  const setPlaces = (update: (prev: string[]) => string[]) => setForm((prev) => ({ ...prev, places: update(prev.places) }));
  const setAllowRoutines = (next: boolean) => setForm((prev) => ({ ...prev, allowRoutines: next }));

  useEffect(() => {
    if (engine || !available.length) return;
    const preferred = available.find((item) => item.id === settings?.defaultEngine) ?? available[0];
    setEngine(preferred.id);
  }, [available, engine, settings]);

  const [pick] = useAction(async () => {
    const folder = await call("app.pickFolder", t("agents.pickFolder"));
    if (folder && !places.includes(folder)) setPlaces((prev) => [...prev, folder]);
  });
  const [save, saving] = useAction(async () => {
    const agent = await call("agents.save", {
      name,
      brief,
      engine,
      places,
      allowRoutines,
      ...(goodAt.trim() ? { goodAt: goodAt.trim() } : {}),
    });
    forgetDraft(NEW_AGENT_DRAFT);
    onCreated(agent);
  }, t("agents.createFailed"));

  const missing = [
    !name.trim() && t("agents.need.name"),
    !brief.trim() && t("agents.need.brief"),
    !engine && t("agents.need.engine"),
    places.length === 0 && t("agents.need.folder"),
  ].filter(Boolean) as string[];

  return (
    <Modal
      title={t("agents.newTitle")}
      icon={Bot}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint grow">{missing.length ? t("agents.needs", { list: listText(missing, t.language) }) : t("agents.ready")}</span>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" busy={saving} disabled={missing.length > 0} onClick={() => void save()}>
            {t("agents.create")}
          </Button>
        </>
      }
    >
      {engines.length > 0 && available.length === 0 && (
        <Notice tone="warn">
          <div className="hstack wrap" style={{ gap: 8 }}>
            <span className="grow">{t("agents.noEngines")}</span>
            <Button
              size="sm"
              icon={Settings2}
              onClick={() => {
                onClose();
                go({ view: "settings", section: "engines" });
              }}
            >
              {t("orch.openSettings")}
            </Button>
          </div>
        </Notice>
      )}
      <Field label={t("agents.templates")}>
        <div className="hstack wrap" style={{ gap: 6 }}>
          {(["builder", "reviewer", "fixer", "tester"] as const).map((id) => (
            <Button
              key={id}
              size="sm"
              variant="ghost"
              icon={Sparkles}
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  name: t(`agents.template.${id}.name`),
                  goodAt: t(`agents.template.${id}.goodAt`),
                  brief: t(`agents.template.${id}.brief`),
                }))
              }
            >
              {t(`agents.template.${id}.label`)}
            </Button>
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label={t("common.name")}>
          <Input autoFocus placeholder={t("agents.namePlaceholder")} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("common.engine")} hint={t("agents.engineHint")}>
          <EngineSelect engines={engines} value={engine} onChange={setEngine} />
        </Field>
      </div>
      <Field label={t("agents.brief")} hint={t("agents.briefHint")}>
        <TextArea value={brief} placeholder={t("agents.briefPlaceholder")} style={{ minHeight: 150 }} onChange={(event) => setBrief(event.target.value)} />
      </Field>
      <SecretNote />
      <Field label={t("agents.folders")} hint={t("agents.foldersHint")}>
        {places.length > 0 && <FolderList places={places} home={home} onRemove={(place) => setPlaces((prev) => prev.filter((item) => item !== place))} />}
        <div>
          <Button icon={FolderPlus} onClick={() => void pick()}>
            {t("agents.addFolder")}
          </Button>
        </div>
      </Field>
      <Toggle checked={allowRoutines} onChange={setAllowRoutines} label={t("agents.allowRoutines")} />
    </Modal>
  );
}

// ------------------------------------------------------------------ detail

/** How many of an agent's runs its Runs tab lists; the rest are in Runs. */
const AGENT_RUNS = 100;

function AgentDetail({ agent, tab, chatId }: { agent: Agent; tab: AgentTab; chatId?: string }) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const engine = engines.find((item) => item.id === agent.engine);
  const chats = useChats(agent.id).data ?? [];
  const runs = useQuery(`runs:agent:${agent.id}`, ["runs"], () => call("runs.list", { agentId: agent.id, limit: AGENT_RUNS }));
  const setTab = (next: AgentTab) => go({ view: "agents", agentId: agent.id, tab: next, chatId: next === "chats" ? (chatId ?? lastChat(agent.id)) : undefined });

  return (
    <div className="main">
      <div className="page-head">
        <Avatar name={agent.name} size="lg" />
        <div className="vstack grow" style={{ gap: 1 }}>
          <h1 className="truncate">{agent.name}</h1>
          <div className="sub truncate">
            {engine?.label ?? agent.engine}
            {engine && !engine.available && <span style={{ color: "var(--red)" }}> {t("common.notOnPath")}</span>} · {t.count("agents.folderCount", agent.places.length)} ·{" "}
            {t.count("agents.skillCount", agent.skills.length)}
            {agent.allowRoutines ? "" : ` · ${t("agents.routinesOff")}`}
          </div>
        </div>
        {/* The Chats tab has its own New chat row; elsewhere this is the way back to talking. */}
        {tab !== "chats" && (
          <Button icon={MessageSquarePlus} variant="primary" onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
            {t("agents.newChat")}
          </Button>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "chats", label: t("agents.chats"), icon: MessagesSquare, badge: chats.some((chat) => chat.live) ? <span className="dot running" /> : undefined },
          { value: "brief", label: t("agents.brief"), icon: BookOpen },
          { value: "memory", label: t("agents.tab.memory"), icon: Brain },
          { value: "skills", label: t("skills.title"), icon: Sparkles, badge: agent.skills.length ? <Chip>{agent.skills.length}</Chip> : undefined },
          { value: "folders", label: t("agents.folders"), icon: FolderOpen },
          { value: "runs", label: t("runs.title"), icon: History },
          { value: "settings", label: t("settings.title"), icon: Settings2 },
        ]}
      />
      {tab === "chats" && <ChatsTab agent={agent} chats={chats} chatId={chatId} />}
      {tab === "brief" && <BriefTab agent={agent} />}
      {tab === "memory" && <MemoryTab agent={agent} />}
      {tab === "skills" && <SkillsTab agent={agent} />}
      {tab === "folders" && <FoldersTab agent={agent} />}
      {tab === "runs" && (
        <div className="page-body">
          <div className="vstack page-narrow" style={{ gap: 6 }}>
            {runs.data?.length === 0 && <Notice>{t("runs.none")}</Notice>}
            {runs.data?.map((run) => <RunRow key={run.id} run={run} onClick={() => go({ view: "runs", runId: run.id, filter: "all" })} />)}
            {(runs.data?.length ?? 0) >= AGENT_RUNS && <div className="list-cut faint">{t("runs.cutElsewhere", { count: AGENT_RUNS })}</div>}
          </div>
        </div>
      )}
      {tab === "settings" && <SettingsTab agent={agent} />}
    </div>
  );
}

function ChatsTab({ agent, chats, chatId }: { agent: Agent; chats: ChatView[]; chatId?: string }) {
  const t = useT();
  const { go } = useNav();
  const confirm = useConfirm();
  const chat = chats.find((item) => item.id === chatId) ?? null;
  const { list, labels, bar, waiting: chatWants } = useChatList(AGENT_CHAT_LIST, chats, (gone) => {
    if (gone.some((item) => item.id === chatId)) go({ view: "agents", agentId: agent.id, tab: "chats" });
  });
  const { selection } = list;
  const deleted = useDeleted();
  const [remove] = useAction(async (target: ChatView) => {
    // Deleting is undone from the toast. Only a live session asks first: stopping it can't be undone.
    if (target.live) {
      const ok = await confirm({
        title: t("common.deleteNamed", { name: target.title }),
        body: t("agents.deleteLiveChatBody"),
        confirm: t("common.stopAndDelete"),
        danger: true,
      });
      if (!ok) return;
    }
    const result = await call("chats.delete", target.id);
    if (target.id === chatId) go({ view: "agents", agentId: agent.id, tab: "chats" });
    deleted(t("common.deletedNamed", { name: target.title }), result);
  }, t("agents.deleteChatFailed"));

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <SidePanel
        id="agent-chats"
        scrollKey={`agent-chats:${agent.id}`}
        title={t("agents.chats")}
        primary={false}
        defaultWidth={240}
        min={180}
        max={420}
        strip={
          <>
            <StripItem label={t("agents.newChat")} selected={!chat} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
              <MessageSquarePlus size={16} />
            </StripItem>
            {list.ordered.slice(0, 12).map((item) => (
              <StripItem key={item.id} label={item.title} selected={item.id === chat?.id} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })} badge={chatWants(item.id) ? <span className="ws-state waiting in-strip" /> : undefined}>
                <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              </StripItem>
            ))}
          </>
        }
      >
        {bar}
        <div className="list-scroll" onKeyDown={selection.onKeyDown}>
          {!selection.selecting && (
            <button type="button" className="row" aria-current={!chat || undefined} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
              <MessageSquarePlus size={15} className="accent-text" />
              <span className="row-title">{t("agents.newChat")}</span>
            </button>
          )}
          {chats.length > 0 && <div className="list-label">{t("agents.recent")}</div>}
          {chats.length > 0 && list.shown.length === 0 && <NoMatch hasQuery={list.hasQuery} filters={activeFilterLabels(list, labels)} onClear={list.clear} />}
          {list.shown.map((item) => {
            const picked = selection.isPicked(item.id);
            const open = () => (selection.selecting ? selection.toggle(item.id) : go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id }));
            return (
                <div
                  key={item.id}
                  className={`row${chatWants(item.id) ? " needs-you" : ""}`}
                  aria-current={(!selection.selecting && item.id === chat?.id) || undefined}
                  aria-pressed={selection.selecting ? picked : undefined}
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || (selection.selecting && event.key === " ")) {
                      event.preventDefault();
                      open();
                    }
                  }}
                >
                  {selection.selecting ? <PickMark picked={picked} /> : <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />}
                  <span className="vstack grow" style={{ gap: 0 }}>
                    <span className="row-title truncate">{item.title}</span>
                    <span className="row-sub">
                      <TimeAgo iso={item.updatedAt} />
                    </span>
                  </span>
                  {!selection.selecting && (
                    <span className="row-actions">
                      <Button size="sm" variant="ghost" icon={Trash2} title={t("agents.deleteChat")} onClick={(event) => { event.stopPropagation(); void remove(item); }} />
                    </span>
                  )}
                </div>
            );
          })}
        </div>
      </SidePanel>
      <SessionPane
        key={chat?.id ?? "new"}
        chat={chat}
        create={() => call("chats.create", { agentId: agent.id })}
        newKey={agent.id}
        onCreated={(created) => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: created.id })}
        placeholder={t("agents.placeholder", { name: agent.name })}
        slim
        head={<span className="row-title truncate">{chat?.title ?? t("agents.newChat")}</span>}
        empty={{
          icon: Bot,
          title: t("agents.chatEmpty.title", { name: agent.name }),
          body: t("agents.chatEmpty.body"),
        }}
      />
    </div>
  );
}

function EditorShell({ children, dirty, saving, note }: { children: ReactNode; dirty: boolean; saving: boolean; note?: ReactNode }) {
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 12 }}>
        {children}
        <SaveState dirty={dirty} saving={saving} note={note} />
      </div>
    </div>
  );
}

function BriefTab({ agent }: { agent: Agent }) {
  const t = useT();
  const [brief, setBrief] = useDraftState(`agent:${agent.id}:brief`, agent.brief);
  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, brief });
  }, t("agents.briefFailed"));
  // Compared as the core keeps it (trailing space trimmed), or a trailing space would never count as saved.
  const dirty = brief.trimEnd() !== agent.brief;
  useAutosave(brief, dirty, !saving && Boolean(brief.trim()), () => void save());
  return (
    <EditorShell dirty={dirty} saving={saving} note={`${t("common.saved")} · ${t("agents.briefSavedBody")}`}>
      <Notice icon={BookOpen}>{t("agents.briefNote")}</Notice>
      <LibraryConflicts kind="agent" id={agent.id} />
      <TextArea value={brief} placeholder={t("agents.briefPlaceholder")} style={{ minHeight: 320 }} onChange={(event) => setBrief(event.target.value)} />
      <SecretNote />
    </EditorShell>
  );
}

function MemoryTab({ agent }: { agent: Agent }) {
  const t = useT();
  const memory = useQuery(`memory:${agent.id}`, ["agents"], () => call("agents.readMemory", agent.id), { what: "load.memory" });
  const [text, setText] = useDraftState<string | null>(memory.data === undefined ? null : `agent:${agent.id}:memory`, memory.data ?? null);
  const [save, saving] = useAction(async () => {
    await call("agents.writeMemory", agent.id, text ?? "");
    await memory.reload();
  }, t("agents.memoryFailed"));
  const dirty = text !== null && text !== memory.data;
  useAutosave(text, dirty, !saving, () => void save());
  // Never an empty editor for a memory that couldn't be read: saving that would write over it.
  if (text === null) return <LoadFailed query={memory} />;
  return (
    <EditorShell dirty={dirty} saving={saving} note={`${t("common.saved")} · ${t("agents.memoryStored")}`}>
      <Notice icon={Brain}>{t("agents.memoryNote")}</Notice>
      <LibraryConflicts kind="agent" id={agent.id} />
      <TextArea code value={text} style={{ minHeight: 320 }} onChange={(event) => setText(event.target.value)} />
      <SecretNote />
    </EditorShell>
  );
}

function SkillsTab({ agent }: { agent: Agent }) {
  const t = useT();
  const { go } = useNav();
  const skills = useSkills().data ?? [];
  const [toggle] = useAction(async (skillId: string, on: boolean) => {
    const next = on ? [...agent.skills, skillId] : agent.skills.filter((id) => id !== skillId);
    await call("agents.save", { ...agent, skills: next });
  }, t("agents.skillsFailed"));
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 8 }}>
        <Notice icon={Sparkles}>{t("agents.skillsNote")}</Notice>
        {skills.length === 0 && (
          <Empty icon={Sparkles} title={t("agents.noSkills.title")} actions={<Button icon={Plus} onClick={() => go({ view: "skills" })}>{t("skills.write")}</Button>}>
            {t("agents.noSkills.body")}
          </Empty>
        )}
        {skills.map((skill) => (
          <div key={skill.id} className="card hstack">
            <Sparkles size={15} className="accent-text" />
            <span className="vstack grow" style={{ gap: 1 }}>
              <strong>{skill.name}</strong>
              <span className="faint truncate">{skill.description || t("common.noDescription")}</span>
            </span>
            <Toggle checked={agent.skills.includes(skill.id)} onChange={(on) => void toggle(skill.id, on)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FoldersTab({ agent }: { agent: Agent }) {
  const t = useT();
  const home = useAppInfo().data?.home ?? "";
  const [add] = useAction(async () => {
    const folder = await call("app.pickFolder", t("agents.allowIn", { name: agent.name }));
    if (folder) await call("agents.save", { ...agent, places: [...agent.places, folder] });
  }, t("agents.addFolderFailed"));
  const [remove] = useAction(async (place: string) => {
    await call("agents.save", { ...agent, places: agent.places.filter((item) => item !== place) });
  }, t("agents.removeFolderFailed"));
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 12 }}>
        <Notice icon={FolderOpen}>{t("agents.foldersNote")}</Notice>
        {agent.places.length === 0 && <Notice tone="warn">{t("library.noFolderHere")}</Notice>}
        <FolderList places={agent.places} home={home} onRemove={agent.places.length > 1 ? (place) => void remove(place) : undefined} />
        <WaitingFolders agent={agent} />
        <div>
          <Button icon={FolderPlus} onClick={() => void add()}>
            {t("agents.addFolder")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ agent }: { agent: Agent }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const others = (useAgents().data ?? []).filter((item) => item.id !== agent.id);
  const running = (useLive().data ?? []).some((session) => session.agentId === agent.id && session.runId);
  const engines = useEngines().data ?? [];
  const [form, setForm] = useDraftState(`agent:${agent.id}:settings`, { name: agent.name, engine: agent.engine, allow: agent.allowRoutines, goodAt: agent.goodAt, tier: agent.tier });
  const { name, engine, allow, goodAt, tier } = form;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setEngine = (next: string) => setForm((prev) => ({ ...prev, engine: next }));
  const setAllow = (next: boolean) => setForm((prev) => ({ ...prev, allow: next }));
  const setGoodAt = (next: string) => setForm((prev) => ({ ...prev, goodAt: next }));
  const setTier = (next: AgentTier) => setForm((prev) => ({ ...prev, tier: next }));
  const dirty =
    name.trim() !== agent.name || engine !== agent.engine || allow !== agent.allowRoutines || oneLine(goodAt ?? "") !== agent.goodAt || (tier ?? "") !== agent.tier;
  const engineRow = useMemo(() => engines.find((item) => item.id === engine), [engines, engine]);

  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, name: name.trim(), engine, allowRoutines: allow, goodAt: goodAt ?? "", tier: tier ?? "" });
    // A new engine is worth a word; the rest just saves.
    if (engine !== agent.engine) push("success", t("agents.updated"), t("agents.engineFromNext", { engine: engineRow?.label ?? engine }));
  }, t("common.saveFailed"));
  const cancelAutosave = useAutosave(form, dirty, !saving && Boolean(name.trim()), () => void save());
  const [remove, removing] = useAction(async () => {
    // Deleting is undone from the toast. Only a running session asks first: stopping it can't be undone.
    if (running) {
      const ok = await confirm({ title: t("common.deleteNamed", { name: agent.name }), body: t("agents.deleteRunningBody"), confirm: t("common.stopAndDelete"), danger: true });
      if (!ok) return;
    }
    cancelAutosave();
    const result = await call("agents.delete", agent.id);
    // Straight to one that is left: the list hasn't reloaded yet, so "the first one" would be this one.
    go(others[0] ? { view: "agents", ...agentPlace(others[0].id) } : { view: "agents" });
    forget(AGENT_SCOPE, agent.id);
    deleted(t("common.deletedNamed", { name: agent.name }), result);
  }, t("agents.deleteFailed"));

  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 16 }}>
        <SyncSwitch kind="agent" id={agent.id} />
        <LibraryConflicts kind="agent" id={agent.id} />
        <div className="form-grid">
          <Field label={t("common.name")}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t("common.engine")} hint={t("agents.engineChangeHint")}>
            <EngineSelect engines={engines} value={engine} onChange={setEngine} allowMissing={agent.engine} />
          </Field>
        </div>
        {engine !== agent.engine && (
          <Notice tone="accent">{t("agents.switching", { engine: engineRow?.label ?? engine })}</Notice>
        )}
        {engine === agent.engine && <EngineStandIn agentId={agent.id} />}
        <Toggle checked={allow} onChange={setAllow} label={t("agents.allowRoutines")} />
        <div className="form-grid">
          <Field label={t("agents.goodAt")} hint={t("agents.goodAtHint")}>
            <Input value={goodAt ?? ""} maxLength={160} placeholder={t("agents.goodAtPlaceholder")} onChange={(event) => setGoodAt(event.target.value)} />
          </Field>
          <Field label={t("agents.tier")}>
            <Segmented<AgentTier>
              value={tier ?? ""}
              onChange={setTier}
              options={[
                { value: "", label: t("agents.tierNone") },
                { value: "fast", label: t("agents.tierFast") },
                { value: "everyday", label: t("agents.tierEveryday") },
                { value: "strong", label: t("agents.tierStrong") },
              ]}
            />
          </Field>
        </div>
        <SaveState dirty={dirty} saving={saving} />
        <div className="section-title" style={{ marginTop: 28 }}>
          {t("common.dangerZone")}
        </div>
        <div className="card hstack">
          <span className="grow muted">{t("agents.deleteNote")}</span>
          <Button variant="danger" icon={Trash2} busy={removing} onClick={() => void remove()}>
            {t("agents.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}
