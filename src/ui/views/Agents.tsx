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
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Agent, ChatView, Engine } from "../../shared/api.js";
import { tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useChats, useEngines, useInbox, useQuery, useSkills } from "../api.js";
import { SessionPane } from "../components/Session.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { Avatar, Button, Chip, Empty, Field, Input, Modal, Notice, SecretNote, Select, StatusDot, Tabs, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { useAction, useConfirm, useNav, useToast, type AgentTab, type Route } from "../state.js";
import { RunRow } from "./Home.js";
import { useT } from "../i18n/index.js";
import { useVoiceStatus } from "../voice.js";

const BRIEF_PLACEHOLDER = `What do you own?
What context matters?
What does good look like?
Which actions still need a person?`;

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
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {!value && <option value="">Pick an engine</option>}
      {engines
        .filter((engine) => engine.available || engine.id === allowMissing)
        .map((engine) => (
          <option key={engine.id} value={engine.id}>
            {engine.label}
            {engine.available ? "" : " (not on PATH)"}
          </option>
        ))}
    </Select>
  );
}

// ------------------------------------------------------------------ view

export function AgentsView({ route }: { route: Extract<Route, { view: "agents" }> }) {
  const t = useT();
  const { go } = useNav();
  const agents = useAgents();
  const chats = useChats(undefined).data ?? [];
  const inbox = useInbox().data ?? [];
  const engines = useEngines().data ?? [];
  const [creating, setCreating] = useState(false);
  const list = agents.data ?? [];
  const selected = list.find((agent) => agent.id === route.agentId) ?? null;

  useEffect(() => {
    if (!route.agentId && list.length > 0) go({ view: "agents", agentId: list[0].id, tab: "chats" });
  }, [route.agentId, list, go]);

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
                badge={chats.some((chat) => chat.agentId === agent.id && chat.live) ? <span className="strip-live" /> : undefined}
              >
                <Avatar name={agent.name} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          {agents.loaded && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>No agents yet.</div>}
          {list.map((agent) => {
            const live = chats.some((chat) => chat.agentId === agent.id && chat.live);
            const unread = inbox.filter((run) => run.agentId === agent.id).length;
            const engine = engines.find((item) => item.id === agent.engine);
            return (
              <button
                key={agent.id}
                type="button"
                className="row"
                aria-selected={agent.id === selected?.id}
                onClick={() => go({ view: "agents", agentId: agent.id, tab: route.tab ?? "chats" })}
              >
                <Avatar name={agent.name} />
                <span className="vstack grow" style={{ gap: 0 }}>
                  <span className="row-title truncate">{agent.name}</span>
                  <span className="row-sub truncate" style={engine && !engine.available ? { color: "var(--red)" } : undefined}>
                    {engine?.label ?? agent.engine}
                    {engine && !engine.available ? " · missing" : ""}
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
          {exists.data?.[index] === false && <Chip tone="bad">missing</Chip>}
          <Button size="sm" variant="ghost" icon={FolderOpen} title={t("common.open")} onClick={() => void call("app.openPath", place)} />
          {onRemove && <Button size="sm" variant="ghost" icon={X} title={t("common.remove")} onClick={() => onRemove(place)} />}
        </div>
      ))}
    </div>
  );
}

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
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
    const folder = await call("app.pickFolder", "Choose a folder this agent may work in");
    if (folder && !places.includes(folder)) setPlaces((prev) => [...prev, folder]);
  });
  const [save, saving] = useAction(async () => {
    const agent = await call("agents.save", { name, brief, engine, places, allowRoutines });
    onCreated(agent);
  }, "Could not create the agent");

  const missing = [!name.trim() && "a name", !brief.trim() && "a brief", !engine && "an engine", places.length === 0 && "an allowed folder"].filter(Boolean) as string[];

  return (
    <Modal
      title="New agent"
      icon={Bot}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint grow">{missing.length ? `Still needs ${missing.join(", ")}.` : "Ready."}</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} disabled={missing.length > 0} onClick={() => void save()}>
            Create agent
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <Input autoFocus placeholder="Release notes" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Engine" hint="Only CLIs found on PATH are listed. You can switch later.">
          <EngineSelect engines={engines} value={engine} onChange={setEngine} />
        </Field>
      </div>
      <Field label="Brief" hint="The agent's job, standards and tone. Sent at the start of every run.">
        <TextArea value={brief} placeholder={BRIEF_PLACEHOLDER} style={{ minHeight: 150 }} onChange={(event) => setBrief(event.target.value)} />
      </Field>
      <SecretNote />
      <Field label="Allowed folders" hint="Runs start in the first one. The prompt tells the CLI to stay inside them. This is a policy, not a sandbox.">
        {places.length > 0 && <FolderList places={places} home={home} onRemove={(place) => setPlaces((prev) => prev.filter((item) => item !== place))} />}
        <div>
          <Button icon={FolderPlus} onClick={() => void pick()}>
            Add folder
          </Button>
        </div>
      </Field>
      <Toggle checked={allowRoutines} onChange={setAllowRoutines} label="Routines may start this agent on a schedule" />
    </Modal>
  );
}

// ------------------------------------------------------------------ detail

function AgentDetail({ agent, tab, chatId }: { agent: Agent; tab: AgentTab; chatId?: string }) {
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
            {engine && !engine.available && <span style={{ color: "var(--red)" }}> (not on PATH)</span>} · {agent.places.length} folder
            {agent.places.length === 1 ? "" : "s"} · {agent.skills.length} skill{agent.skills.length === 1 ? "" : "s"}
            {agent.allowRoutines ? "" : " · routines off"}
          </div>
        </div>
        <Button icon={MessageSquarePlus} variant="primary" onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
          New chat
        </Button>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "chats", label: "Chats", icon: MessagesSquare, badge: chats.some((chat) => chat.live) ? <span className="dot running" /> : undefined },
          { value: "brief", label: "Brief", icon: BookOpen },
          { value: "memory", label: "Memory", icon: Brain },
          { value: "skills", label: "Skills", icon: Sparkles, badge: agent.skills.length ? <Chip>{agent.skills.length}</Chip> : undefined },
          { value: "folders", label: "Allowed folders", icon: FolderOpen },
          { value: "runs", label: "Runs", icon: History },
          { value: "settings", label: "Settings", icon: Settings2 },
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
            {runs.data?.length === 0 && <Notice>No runs yet.</Notice>}
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
  const [remove] = useAction(async (target: ChatView) => {
    const ok = await confirm({
      title: `Delete "${target.title}"?`,
      body: "The chat and its transcripts are removed. Run records and git snapshots stay in Runs.",
      confirm: "Delete chat",
      danger: true,
    });
    if (!ok) return;
    await call("chats.delete", target.id);
    if (target.id === chatId) go({ view: "agents", agentId: agent.id, tab: "chats" });
  }, "Could not delete the chat");

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <SidePanel
        id="agent-chats"
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
              <StripItem key={item.id} label={item.title} selected={item.id === chat?.id} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })}>
                <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          <button type="button" className="row" aria-selected={!chat} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats" })}>
            <MessageSquarePlus size={15} className="accent-text" />
            <span className="row-title">New chat</span>
          </button>
          {chats.length > 0 && <div className="list-label">Recent</div>}
          {chats.map((item) => (
            <div key={item.id} className="row" aria-selected={item.id === chat?.id} role="button" tabIndex={0} onClick={() => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })} onKeyDown={(event) => event.key === "Enter" && go({ view: "agents", agentId: agent.id, tab: "chats", chatId: item.id })}>
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
        onCreated={(created) => go({ view: "agents", agentId: agent.id, tab: "chats", chatId: created.id })}
        placeholder={t("agents.placeholder", { name: agent.name })}
        empty={{
          icon: Bot,
          title: t("agents.chatEmpty.title", { name: agent.name }),
          body: t("agents.chatEmpty.body"),
        }}
      />
    </div>
  );
}

function EditorShell({ children, dirty, onSave, saving, note }: { children: ReactNode; dirty: boolean; onSave: () => void; saving: boolean; note?: ReactNode }) {
  useSaveShortcut(onSave, dirty && !saving);
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 12 }}>
        {children}
        <div className="hstack">
          <Button variant="primary" icon={Save} disabled={!dirty} busy={saving} onClick={onSave}>
            Save
          </Button>
          <span className="faint">{dirty ? "Unsaved changes · Ctrl+S" : note ?? "Saved"}</span>
        </div>
      </div>
    </div>
  );
}

function BriefTab({ agent }: { agent: Agent }) {
  const { push } = useToast();
  const [brief, setBrief] = useState(agent.brief);
  useEffect(() => setBrief(agent.brief), [agent.brief]);
  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, brief });
    push("success", "Brief saved", "It applies to the next run.");
  }, "Could not save the brief");
  return (
    <EditorShell dirty={brief !== agent.brief} saving={saving} onSave={() => void save()}>
      <Notice icon={BookOpen}>
        The brief opens every run: the job, the standards, and the actions that still need you. A good brief answers four questions — what the agent owns,
        what context matters, what good looks like, and what needs a person.
      </Notice>
      <TextArea value={brief} placeholder={BRIEF_PLACEHOLDER} style={{ minHeight: 320 }} onChange={(event) => setBrief(event.target.value)} />
      <SecretNote />
    </EditorShell>
  );
}

function MemoryTab({ agent }: { agent: Agent }) {
  const { push } = useToast();
  const memory = useQuery(`memory:${agent.id}`, ["agents"], () => call("agents.readMemory", agent.id));
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (memory.data !== undefined) setText(memory.data);
  }, [memory.data]);
  const [save, saving] = useAction(async () => {
    await call("agents.writeMemory", agent.id, text ?? "");
    push("success", "Memory saved");
  }, "Could not save memory");
  if (text === null) return null;
  return (
    <EditorShell dirty={text !== memory.data} saving={saving} onSave={() => void save()} note="Stored as memory.md next to the agent; edit it anywhere.">
      <Notice icon={Brain}>
        Durable facts that should still matter next week: preferences, decisions, constraints, lessons. Dated bullets work well. VibeForge adds this to
        every run; agents never rewrite it themselves.
      </Notice>
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
  }, "Could not update skills");
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 8 }}>
        <Notice icon={Sparkles}>Installed skills are added to every run of this agent. Editing a skill changes the next run of every agent that has it.</Notice>
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
              <span className="faint truncate">{skill.description || "No description"}</span>
            </span>
            <Toggle checked={agent.skills.includes(skill.id)} onChange={(on) => void toggle(skill.id, on)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FoldersTab({ agent }: { agent: Agent }) {
  const home = useAppInfo().data?.home ?? "";
  const [add] = useAction(async () => {
    const folder = await call("app.pickFolder", `Allow ${agent.name} to work in…`);
    if (folder) await call("agents.save", { ...agent, places: [...agent.places, folder] });
  }, "Could not add the folder");
  const [remove] = useAction(async (place: string) => {
    await call("agents.save", { ...agent, places: agent.places.filter((item) => item !== place) });
  }, "Could not remove the folder");
  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 12 }}>
        <Notice icon={FolderOpen}>
          Runs start in the first folder that exists, and the prompt tells the CLI to stay inside these. A coding CLI has a shell, so this is a policy, not
          an OS sandbox.
        </Notice>
        <FolderList places={agent.places} home={home} onRemove={agent.places.length > 1 ? (place) => void remove(place) : undefined} />
        <div>
          <Button icon={FolderPlus} onClick={() => void add()}>
            Add folder
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ agent }: { agent: Agent }) {
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const engines = useEngines().data ?? [];
  const [name, setName] = useState(agent.name);
  const [engine, setEngine] = useState(agent.engine);
  const [allow, setAllow] = useState(agent.allowRoutines);
  const [voice, setVoice] = useState(agent.voice);
  const voices = useVoiceStatus().data?.voices ?? [];
  const t = useT();
  const dirty = name !== agent.name || engine !== agent.engine || allow !== agent.allowRoutines || voice !== agent.voice;
  const engineRow = useMemo(() => engines.find((item) => item.id === engine), [engines, engine]);

  const [save, saving] = useAction(async () => {
    await call("agents.save", { ...agent, name, engine, allowRoutines: allow, voice });
    push("success", "Agent updated", engine !== agent.engine ? `${engineRow?.label ?? engine} runs from the next chat on.` : undefined);
  }, "Could not save");
  const [remove, removing] = useAction(async () => {
    const ok = await confirm({
      title: `Delete ${agent.name}?`,
      body: "This removes the agent, its brief and its memory file. Its runs, transcripts and chats stay on disk and in Runs.",
      confirm: "Delete agent",
      danger: true,
      typeToConfirm: agent.name,
    });
    if (!ok) return;
    await call("agents.delete", agent.id, agent.name);
    go({ view: "agents" });
  }, "Could not delete the agent");
  useSaveShortcut(() => void save(), dirty && !saving);

  return (
    <div className="page-body">
      <div className="vstack page-narrow" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Engine" hint="The teammate stays the same. The change applies to the next run.">
            <EngineSelect engines={engines} value={engine} onChange={setEngine} allowMissing={agent.engine} />
          </Field>
        </div>
        {engine !== agent.engine && (
          <Notice tone="accent">
            Switching to {engineRow?.label ?? engine} keeps the brief, memory, skills and folders. Chats that are already running keep their current engine.
          </Notice>
        )}
        <Toggle checked={allow} onChange={setAllow} label="Routines may start this agent on a schedule" />
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
            Save changes
          </Button>
          {dirty && <span className="faint">Ctrl+S</span>}
        </div>
        <div className="section-title" style={{ marginTop: 28 }}>
          Danger zone
        </div>
        <div className="card hstack">
          <span className="grow muted">Delete this agent. Run history is kept.</span>
          <Button variant="danger" icon={Trash2} busy={removing} onClick={() => void remove()}>
            Delete agent
          </Button>
        </div>
      </div>
    </div>
  );
}
