import {
  Volume2,
  Bot,
  BookOpen,
  Brain,
  FolderOpen,
  FolderPlus,
  History,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useChatAttention } from "../attention.js";
import type { Agent, ChatView, Engine } from "../../shared/api.js";
import { listText, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useChats, useEngines, useInbox, useQuery, useSkills } from "../api.js";
import { useDraftState } from "../drafts.js";
import { SessionPane } from "../components/Session.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { Avatar, Button, Chip, Empty, Field, Input, Modal, Notice, SecretNote, Select, StatusDot, Tabs, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { useAction, useConfirm, useDeleted, useDropMissing, useNav, useToast, type AgentTab, type Route } from "../state.js";
import { RunRow } from "./Home.js";
import { useT } from "../i18n/index.js";
import { useVoiceStatus } from "../voice.js";

/** Save on Ctrl+S while a form is on screen. */
export function useSaveShortcut(save: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save, enabled]);
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

export function AgentsView({ route }: { route: Extract<Route, { view: "agents" }> }) {
  const t = useT();
  const { go, replace } = useNav();
  const agents = useAgents();
  const chats = useChats(undefined).data ?? [];
  const inbox = useInbox().data ?? [];
  const engines = useEngines().data ?? [];
  const [creating, setCreating] = useState(false);
  const list = agents.data ?? [];
  const selected = list.find((agent) => agent.id === route.agentId) ?? null;
  useDropMissing(agents.loaded, Boolean(route.agentId) && !selected, { view: "agents" });
  const chatAttention = useChatAttention();
  const wants = (agentId: string) => [...chatAttention.values()].some((mark) => mark.agentId === agentId && mark.attention === "waiting");

  useEffect(() => {
    if (!route.agentId && list.length > 0) replace({ view: "agents", agentId: list[0].id, tab: "chats" });
  }, [route.agentId, list, replace]);

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
            {list.map((agent) => (
              <StripItem
                key={agent.id}
                label={agent.name}
                selected={agent.id === selected?.id}
                onClick={() => go({ view: "agents", agentId: agent.id, tab: route.tab ?? "chats" })}
                badge={wants(agent.id) ? <span className="ws-state waiting in-strip" /> : chats.some((chat) => chat.agentId === agent.id && chat.live) ? <span className="strip-live" /> : undefined}
              >
                <Avatar name={agent.name} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          {agents.loaded && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("agents.none")}</div>}
          {list.map((agent) => {
            const live = chats.some((chat) => chat.agentId === agent.id && chat.live);
            const unread = inbox.filter((run) => run.agentId === agent.id).length;
            const engine = engines.find((item) => item.id === agent.engine);
            return (
              <button
                key={agent.id}
                type="button"
                className={`row${wants(agent.id) ? " needs-you" : ""}`}
                aria-selected={agent.id === selected?.id}
                onClick={() => go({ view: "agents", agentId: agent.id, tab: route.tab ?? "chats" })}
              >
                <Avatar name={agent.name} />
                <span className="vstack grow" style={{ gap: 0 }}>
                  <span className="row-title truncate">{agent.name}</span>
                  <span className="row-sub truncate" style={engine && !engine.available ? { color: "var(--red)" } : undefined}>
                    {engine?.label ?? agent.engine}
                    {engine && !engine.available ? ` · ${t("common.missing")}` : ""}
                  </span>
                </span>
                {unread > 0 && <Chip tone="accent">{unread}</Chip>}
                {live && <StatusDot status="running" title={t("agents.chatLive")} />}
              </button>
            );
          })}
        </div>
      </SidePanel>
      {selected ? (
        <AgentDetail key={selected.id} agent={selected} tab={route.tab ?? "chats"} chatId={route.chatId} />
      ) : (
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

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const settings = useQuery("settings", ["settings"], () => call("settings.get")).data;
  const home = useAppInfo().data?.home ?? "";
  const available = engines.filter((engine) => engine.available);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [engine, setEngine] = useState("");
  const [places, setPlaces] = useState<string[]>([]);
  const [allowRoutines, setAllowRoutines] = useState(true);

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
    const agent = await call("agents.save", { name, brief, engine, places, allowRoutines });
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

function AgentDetail({ agent, tab, chatId }: { agent: Agent; tab: AgentTab; chatId?: string }) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const engine = engines.find((item) => item.id === agent.engine);
  const chats = useChats(agent.id).data ?? [];
  const runs = useQuery(`runs:agent:${agent.id}`, ["runs"], () => call("runs.list", { agentId: agent.id, limit: 100 }));
  const setTab = (next: AgentTab) => go({ view: "agents", agentId: agent.id, tab: next, chatId: next === "chats" ? chatId : undefined });

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
  const chatAttention = useChatAttention();
  const chatWants = (id: string) => chatAttention.get(id)?.attention === "waiting";
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
            {chats.slice(0, 12).map((item) => (
              <StripItem key={item.id} label={item.title} selected={item.id === chat?.id} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })} badge={chatWants(item.id) ? <span className="ws-state waiting in-strip" /> : undefined}>
                <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          <button type="button" className="row" aria-selected={!chat} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
            <MessageSquarePlus size={15} className="accent-text" />
            <span className="row-title">{t("agents.newChat")}</span>
          </button>
          {chats.length > 0 && <div className="list-label">{t("agents.recent")}</div>}
          {chats.map((item) => (
            <div key={item.id} className={`row${chatWants(item.id) ? " needs-you" : ""}`} aria-selected={item.id === chat?.id} role="button" tabIndex={0} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })} onKeyDown={(event) => event.key === "Enter" && go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })}>
              <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{item.title}</span>
                <span className="row-sub">
                  <TimeAgo iso={item.updatedAt} />
                </span>
              </span>
              <span className="row-actions">
                <Button size="sm" variant="ghost" icon={Trash2} title={t("agents.deleteChat")} onClick={(event) => { event.stopPropagation(); void remove(item); }} />
              </span>
            </div>
          ))}
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

function EditorShell({ children, dirty, onSave, onDiscard, saving, note }: { children: ReactNode; dirty: boolean; onSave: () => void; onDiscard: () => void; saving: boolean; note?: ReactNode }) {
  const t = useT();
  useSaveShortcut(onSave, dirty && !saving);
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 12 }}>
        {children}
        <div className="hstack">
          <Button variant="primary" icon={Save} disabled={!dirty} busy={saving} onClick={onSave}>
            {t("common.save")}
          </Button>
          {dirty && (
            <Button variant="ghost" icon={Undo2} onClick={onDiscard}>
              {t("common.discard")}
            </Button>
          )}
          <span className="faint">{dirty ? t("common.unsaved") : note ?? t("common.saved")}</span>
        </div>
      </div>
    </div>
  );
}

function BriefTab({ agent }: { agent: Agent }) {
  const t = useT();
  const { push } = useToast();
  const [brief, setBrief, discard] = useDraftState(`agent:${agent.id}:brief`, agent.brief);
  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, brief });
    push("success", t("agents.briefSaved"), t("agents.briefSavedBody"));
  }, t("agents.briefFailed"));
  return (
    <EditorShell dirty={brief !== agent.brief} saving={saving} onSave={() => void save()} onDiscard={discard}>
      <Notice icon={BookOpen}>{t("agents.briefNote")}</Notice>
      <TextArea value={brief} placeholder={t("agents.briefPlaceholder")} style={{ minHeight: 320 }} onChange={(event) => setBrief(event.target.value)} />
      <SecretNote />
    </EditorShell>
  );
}

function MemoryTab({ agent }: { agent: Agent }) {
  const t = useT();
  const { push } = useToast();
  const memory = useQuery(`memory:${agent.id}`, ["agents"], () => call("agents.readMemory", agent.id));
  const [text, setText, discard] = useDraftState<string | null>(memory.data === undefined ? null : `agent:${agent.id}:memory`, memory.data ?? null);
  const [save, saving] = useAction(async () => {
    await call("agents.writeMemory", agent.id, text ?? "");
    push("success", t("agents.memorySaved"));
  }, t("agents.memoryFailed"));
  if (text === null) return null;
  return (
    <EditorShell dirty={text !== memory.data} saving={saving} onSave={() => void save()} onDiscard={discard} note={t("agents.memoryStored")}>
      <Notice icon={Brain}>{t("agents.memoryNote")}</Notice>
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
        <FolderList places={agent.places} home={home} onRemove={agent.places.length > 1 ? (place) => void remove(place) : undefined} />
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
  const engines = useEngines().data ?? [];
  const [form, setForm, discard] = useDraftState(`agent:${agent.id}:settings`, { name: agent.name, engine: agent.engine, allow: agent.allowRoutines, voice: agent.voice });
  const { name, engine, allow, voice } = form;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setEngine = (next: string) => setForm((prev) => ({ ...prev, engine: next }));
  const setAllow = (next: boolean) => setForm((prev) => ({ ...prev, allow: next }));
  const setVoice = (next: string) => setForm((prev) => ({ ...prev, voice: next }));
  const voices = useVoiceStatus().data?.voices ?? [];
  const dirty = name !== agent.name || engine !== agent.engine || allow !== agent.allowRoutines || voice !== agent.voice;
  const engineRow = useMemo(() => engines.find((item) => item.id === engine), [engines, engine]);

  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, name, engine, allowRoutines: allow, voice });
    push("success", t("agents.updated"), engine !== agent.engine ? t("agents.engineFromNext", { engine: engineRow?.label ?? engine }) : undefined);
  }, t("common.saveFailed"));
  const [remove, removing] = useAction(async () => {
    const ok = await confirm({
      title: t("agents.deleteTitle", { name: agent.name }),
      body: t("agents.deleteBody"),
      confirm: t("agents.delete"),
      danger: true,
      typeToConfirm: agent.name,
    });
    if (!ok) return;
    await call("agents.delete", agent.id, agent.name);
    go({ view: "agents" });
  }, t("agents.deleteFailed"));
  useSaveShortcut(() => void save(), dirty && !saving);

  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 16 }}>
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
        <Toggle checked={allow} onChange={setAllow} label={t("agents.allowRoutines")} />
        <Field label={t("voice.agentVoice")} hint={voices.length ? t("voice.agentVoiceHint") : t("voice.agentVoiceNone")}>
          <div className="hstack" style={{ gap: 6, maxWidth: 420 }}>
            <Select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={!voices.length && !voice}>
              <option value="">{t("voice.agentVoiceDefault")}</option>
              {voice && !voices.includes(voice) && <option value={voice}>{voice.slice(voice.lastIndexOf("/") + 1)} ({t("voice.missing")})</option>}
              {voices.map((file) => (
                <option key={file} value={file}>
                  {file.slice(file.lastIndexOf("/") + 1).replace(/\.onnx$/, "")}
                </option>
              ))}
            </Select>
            <Button icon={Volume2} disabled={!voices.length} tip={t("voice.hearIt")} onClick={() => void call("voice.speak", t("voice.agentSample", { name }), voice)} />
          </div>
        </Field>
        <div className="hstack">
          <Button variant="primary" icon={Save} disabled={!dirty} busy={saving} onClick={() => void save()}>
            {t("common.saveChanges")}
          </Button>
          {dirty && (
            <Button variant="ghost" icon={Undo2} onClick={discard}>
              {t("common.discard")}
            </Button>
          )}
          {dirty && <span className="faint">Ctrl+S</span>}
        </div>
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
