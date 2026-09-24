import { useCallback, useEffect, useMemo, useState } from "react";
import type { Schedule } from "../../core/types.js";
import type { Agent, Task, Workspace } from "../../core/types.js";
import type { AgentDraft, Engine, RoutineDraft, RoutineRow, SkillDraft } from "../../shared/api.js";
import type { RunMetaFile } from "../../core/runfiles.js";
import { TerminalView } from "../../components/TerminalView.js";

type Nav =
  | { kind: "dashboard" }
  | { kind: "routines" }
  | { kind: "skills" }
  | { kind: "tasks" }
  | { kind: "agent"; id: string };

type Tab = "chats" | "brief" | "memory" | "skills" | "places" | "settings";

const SECRET = "Do not put passwords, keys, or tokens in this text.";
const BRIEF_PLACEHOLDER = "What do you own?\nWhat context matters?\nWhat does good look like?\nWhich actions still need a person?";
const ROUTINE_PLACEHOLDER = "Look at the allowed folder.\nDraft the result.\nName the source of each claim.\nStop after the draft. Do not push, publish, delete, or send.";
const SKILL_TEMPLATE = "## When\n\n## Steps\n\n## Verify\n\n## Ask first\n";

export function AgentScreen() {
  const api = window.forgedesk;
  const [nav, setNav] = useState<Nav>({ kind: "dashboard" });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [skills, setSkills] = useState<SkillDraft[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [inbox, setInbox] = useState<RunMetaFile[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const [nextAgents, nextEngines, nextRoutines, nextSkills, nextTasks, files, nextInbox] = await Promise.all([
      api.listAgents(),
      api.listEngines(),
      api.listRoutines(),
      api.listSkills(),
      api.listTasks(),
      api.listWorkspaces(),
      api.listInbox(),
    ]);
    setAgents(nextAgents);
    setEngines(nextEngines);
    setRoutines(nextRoutines);
    setSkills(nextSkills);
    setTasks(nextTasks);
    setWorkspaces(files.workspaces);
    setInbox(nextInbox);
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const selected = nav.kind === "agent" ? agents.find((agent) => agent.id === nav.id) : undefined;

  return (
    <div className="fd-fill">
      <aside className="fd-sidebar">
        <div className="fd-side-scroll">
          <NavButton current={nav.kind === "dashboard"} onClick={() => setNav({ kind: "dashboard" })}>Dashboard</NavButton>
          <NavButton current={nav.kind === "routines"} onClick={() => setNav({ kind: "routines" })}>Routines</NavButton>
          <NavButton current={nav.kind === "skills"} onClick={() => setNav({ kind: "skills" })}>Skills</NavButton>
          <NavButton current={nav.kind === "tasks"} onClick={() => setNav({ kind: "tasks" })}>Tasks</NavButton>
          <div className="fd-label">Agents</div>
          {agents.map((agent) => (
            <button
              key={agent.id}
              className="fd-agentbtn"
              type="button"
              aria-pressed={nav.kind === "agent" && nav.id === agent.id}
              onClick={() => setNav({ kind: "agent", id: agent.id })}
            >
              {agent.name}
            </button>
          ))}
          <button className="fd-btn" type="button" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
            New agent
          </button>
        </div>
      </aside>
      <section className="fd-main">
        {nav.kind === "dashboard" && (
          <Dashboard agents={agents} routines={routines} inbox={inbox} onOpenAgent={(id) => setNav({ kind: "agent", id })} onRefresh={refresh} />
        )}
        {nav.kind === "routines" && <Routines agents={agents} routines={routines} onRefresh={refresh} />}
        {nav.kind === "skills" && <Skills agents={agents} skills={skills} onRefresh={refresh} />}
        {nav.kind === "tasks" && <Tasks agents={agents} tasks={tasks} workspaces={workspaces} onRefresh={refresh} />}
        {selected && <AgentDetail agent={selected} engines={engines} skills={skills} onRefresh={refresh} />}
        {nav.kind === "agent" && !selected && <div className="fd-empty"><h2>That teammate is gone.</h2></div>}
      </section>
      {creating && (
        <NewAgent
          engines={engines}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setNav({ kind: "agent", id: agent.id });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function NavButton({ current, onClick, children }: { current: boolean; onClick: () => void; children: string }) {
  return (
    <button className="fd-navbtn" type="button" aria-pressed={current} onClick={onClick}>
      {children}
    </button>
  );
}

function Dashboard({
  agents,
  routines,
  inbox,
  onOpenAgent,
  onRefresh,
}: {
  agents: Agent[];
  routines: RoutineRow[];
  inbox: RunMetaFile[];
  onOpenAgent: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const upcoming = routines
    .filter((routine) => routine.enabled)
    .slice(0, 6);
  return (
    <div className="fd-stack">
      <div>
        <p className="fd-kicker">Dashboard</p>
        <h2 style={{ margin: "4px 0 0" }}>Review what finished.</h2>
      </div>
      <div className="fd-list">
        {agents.map((agent) => (
          <button key={agent.id} className="fd-card" type="button" onClick={() => onOpenAgent(agent.id)} style={{ textAlign: "left" }}>
            <h3>{agent.name}</h3>
            <span className="fd-muted">{agent.engine} · {agent.places.length} allowed folder{agent.places.length === 1 ? "" : "s"}</span>
          </button>
        ))}
        {agents.length === 0 && <p className="fd-muted">Name a teammate, give it a brief, and point it at a folder.</p>}
      </div>
      <h3>Next routines</h3>
      {upcoming.length === 0 && <p className="fd-muted">No routines are scheduled.</p>}
      {upcoming.map((routine) => (
        <div key={routine.id} className="fd-card">
          <h3>{routine.name}</h3>
          <span className="fd-muted">{routine.stillRunning ? "still running" : routine.enabled ? "scheduled" : "paused"}</span>
          {routine.lastMissedAt && <span className="fd-muted">missed while closed · {new Date(routine.lastMissedAt).toLocaleString()}</span>}
        </div>
      ))}
      <h3>Needs review</h3>
      {inbox.length === 0 && <p className="fd-muted">Finished runs from the last two days show up here until you open them.</p>}
      {inbox.map((run) => (
        <button key={run.id} className="fd-card" type="button" onClick={() => setOpenId(run.id)} style={{ textAlign: "left" }}>
          <h3>{run.origin} · {run.status}</h3>
          <span className="fd-muted">{new Date(run.startedAt).toLocaleString()}</span>
        </button>
      ))}
      {openId && <RunReader id={openId} onClose={() => { setOpenId(null); void onRefresh(); }} />}
    </div>
  );
}

function RunReader({ id, onClose }: { id: string; onClose: () => void }) {
  const api = window.forgedesk;
  const [text, setText] = useState("Loading…");
  const [git, setGit] = useState("");
  const [ptyId, setPtyId] = useState<string | null>(null);
  useEffect(() => {
    void api.getRun(id).then(async (bundle) => {
      if (!bundle) {
        setText("That run is gone.");
        return;
      }
      setText(bundle.scrollback || "(empty transcript)");
      setGit(bundle.git);
      if (bundle.meta.status === "running" && bundle.ptyId) setPtyId(bundle.ptyId);
      await api.markRunOpened(id);
    });
  }, [api, id]);
  return (
    <div className="fd-modal-back">
      <div className="fd-panel fd-modal" style={{ width: "min(760px, calc(100% - 32px))", maxHeight: "80%", overflow: "auto" }}>
        <div className="fd-row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Run</h3>
          <button className="fd-btn" type="button" onClick={onClose}>Close</button>
        </div>
        {ptyId ? <div style={{ height: 280 }}><TerminalView ptyId={ptyId} /></div> : <pre className="fd-pre">{text}</pre>}
        <p className="fd-label">git</p>
        <pre className="fd-pre">{git || "No git snapshot yet."}</pre>
      </div>
    </div>
  );
}

function NewAgent({
  engines,
  onClose,
  onCreated,
}: {
  engines: Engine[];
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const api = window.forgedesk;
  const available = engines.filter((engine) => engine.available);
  const [draft, setDraft] = useState<AgentDraft>({
    name: "",
    brief: "",
    engine: available[0]?.id ?? "",
    places: [],
    allowRoutines: true,
  });
  const [exists, setExists] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const blockers = useMemo(() => agentBlockers(draft, engines, exists), [draft, engines, exists]);

  async function addPlace() {
    const folder = await api.pickDirectory();
    if (!folder) return;
    const ok = await api.pathExists(folder);
    setDraft((prev) => ({ ...prev, places: [...prev.places, folder] }));
    setExists((prev) => [...prev, ok]);
  }

  async function save() {
    setError(null);
    try {
      const agent = await api.saveAgent(draft);
      onCreated(agent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="fd-modal-back">
      <div className="fd-panel fd-modal" style={{ width: "min(560px, calc(100% - 32px))" }}>
        <p className="fd-kicker">New agent</p>
        <p className="fd-warn">{SECRET}</p>
        <label className="fd-muted">Name</label>
        <input className="fd-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <label className="fd-muted">Brief</label>
        <textarea className="fd-text" placeholder={BRIEF_PLACEHOLDER} value={draft.brief} onChange={(event) => setDraft({ ...draft, brief: event.target.value })} />
        <label className="fd-muted">Engine</label>
        <select className="fd-input" value={draft.engine} onChange={(event) => setDraft({ ...draft, engine: event.target.value })}>
          {available.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
        </select>
        <div className="fd-row" style={{ marginTop: 8 }}>
          <span className="fd-muted">Allowed folders</span>
          <button className="fd-btn" type="button" onClick={() => void addPlace()}>Add folder</button>
        </div>
        {draft.places.map((place) => <div key={place} className="fd-muted">{place}</div>)}
        <p className="fd-faint">These folders are the working directories handed to the CLI. This is not an OS sandbox.</p>
        {error && <p className="fd-error">{error}</p>}
        {blockers.length > 0 && <p className="fd-muted">Still needed: {blockers.join(", ")}</p>}
        <div className="fd-row">
          <button className="fd-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="fd-btn-primary" type="button" disabled={blockers.length > 0} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}

function agentBlockers(draft: AgentDraft, engines: Engine[], exists: boolean[]): string[] {
  const reasons: string[] = [];
  if (!draft.name.trim()) reasons.push("name");
  if (!draft.brief.trim()) reasons.push("brief");
  const engine = engines.find((item) => item.id === draft.engine);
  if (!engine?.available) reasons.push("an engine on PATH");
  if (draft.places.length < 1) reasons.push("one allowed folder");
  else if (exists.some((ok) => !ok)) reasons.push("an existing folder");
  return reasons;
}

function AgentDetail({ agent, engines, skills, onRefresh }: { agent: Agent; engines: Engine[]; skills: SkillDraft[]; onRefresh: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("chats");
  return (
    <>
      <div className="fd-tabs">
        {(["chats", "brief", "memory", "skills", "places", "settings"] as Tab[]).map((item) => (
          <button key={item} type="button" aria-pressed={tab === item} onClick={() => setTab(item)}>
            {item === "places" ? "Allowed folders" : item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {tab === "chats" && <AgentChats agent={agent} />}
      {tab === "brief" && <BriefTab agent={agent} onRefresh={onRefresh} />}
      {tab === "memory" && <MemoryTab agent={agent} />}
      {tab === "skills" && <AgentSkills agent={agent} skills={skills} onRefresh={onRefresh} />}
      {tab === "places" && <PlacesTab agent={agent} onRefresh={onRefresh} />}
      {tab === "settings" && <AgentSettings agent={agent} engines={engines} onRefresh={onRefresh} />}
    </>
  );
}

function AgentChats({ agent }: { agent: Agent }) {
  const api = window.forgedesk;
  const [chats, setChats] = useState<{ id: string; title: string; ptyId: string | null }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await api.listChats();
    setChats(all.filter((chat) => chat.agentId === agent.id).map((chat) => ({ id: chat.id, title: chat.title, ptyId: chat.ptyId })));
  }, [api, agent.id]);

  useEffect(() => { void load(); }, [load]);

  async function send() {
    const prompt = text.trim();
    if (!prompt) return;
    setError(null);
    try {
      let chatId = active;
      if (!chatId) {
        const created = await api.startAgentChat(agent.id);
        chatId = created.id;
        setActive(created.id);
      }
      const sent = await api.sendAgentChat(agent.id, chatId, prompt);
      if (!sent.ok || !sent.chatId) {
        setError(sent.reason ?? "Could not send.");
        return;
      }
      setActive(sent.chatId);
      setPtyId(sent.ptyId ?? null);
      setNote(sent.startedNew ? sent.message ?? "That session ended. This is a new chat." : null);
      setText("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="fd-fill" style={{ minHeight: 0 }}>
      <div className="fd-sidebar" style={{ width: 200 }}>
        <div className="fd-side-scroll">
          <button className="fd-btn" type="button" onClick={() => { setActive(null); setPtyId(null); setNote(null); }}>New chat</button>
          {chats.map((chat) => (
            <button
              key={chat.id}
              className="fd-agentbtn"
              type="button"
              aria-pressed={chat.id === active}
              onClick={() => { setActive(chat.id); setPtyId(chat.ptyId); setNote(null); }}
            >
              {chat.title}
            </button>
          ))}
        </div>
      </div>
      <div className="fd-main">
        {note && <p className="fd-warn" style={{ padding: "8px 10px" }}>{note}</p>}
        {error && <p className="fd-error" style={{ padding: "0 10px" }}>{error}</p>}
        <div className="fd-canvas">{ptyId ? <TerminalView ptyId={ptyId} /> : <div className="fd-empty"><p className="fd-muted">Send a prompt to start this teammate.</p></div>}</div>
        <div className="fd-composer">
          <textarea className="fd-text" style={{ minHeight: 56 }} value={text} placeholder="Ask for one outcome" onChange={(event) => setText(event.target.value)} />
          <button className="fd-btn-primary" type="button" onClick={() => void send()}>Send</button>
        </div>
      </div>
    </div>
  );
}

function BriefTab({ agent, onRefresh }: { agent: Agent; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  const [brief, setBrief] = useState(agent.brief);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fd-stack">
      <p className="fd-warn">{SECRET}</p>
      <textarea className="fd-text" style={{ minHeight: 180 }} value={brief} onChange={(event) => setBrief(event.target.value)} />
      {error && <p className="fd-error">{error}</p>}
      <button className="fd-btn-primary" type="button" disabled={!brief.trim()} onClick={() => void api.saveAgent({ ...agent, brief }).then(onRefresh).catch((reason: unknown) => setError(String(reason)))}>
        Save brief
      </button>
    </div>
  );
}

function MemoryTab({ agent }: { agent: Agent }) {
  const api = window.forgedesk;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.readMemory(agent.id).then(setText); }, [api, agent.id]);
  return (
    <div className="fd-stack">
      <p className="fd-warn">{SECRET}</p>
      <textarea className="fd-text" style={{ minHeight: 220 }} value={text} onChange={(event) => setText(event.target.value)} />
      {error && <p className="fd-error">{error}</p>}
      <button className="fd-btn-primary" type="button" onClick={() => void api.writeMemory(agent.id, text).catch((reason: unknown) => setError(String(reason)))}>
        Save memory
      </button>
    </div>
  );
}

function AgentSkills({ agent, skills, onRefresh }: { agent: Agent; skills: SkillDraft[]; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  return (
    <div className="fd-stack">
      {skills.map((skill) => {
        const on = agent.skills.includes(skill.id || "");
        return (
          <label key={skill.id} className="fd-card">
            <span className="fd-row">
              <input
                type="checkbox"
                checked={on}
                onChange={() => {
                  const skillsNext = on ? agent.skills.filter((id) => id !== skill.id) : [...agent.skills, skill.id || ""];
                  void api.saveAgent({ ...agent, skills: skillsNext }).then(onRefresh);
                }}
              />
              <strong>{skill.name}</strong>
            </span>
          </label>
        );
      })}
      {skills.length === 0 && <p className="fd-muted">No skills yet. Write one from the Skills section.</p>}
    </div>
  );
}

function PlacesTab({ agent, onRefresh }: { agent: Agent; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  const [error, setError] = useState<string | null>(null);
  async function add() {
    const folder = await api.pickDirectory();
    if (!folder) return;
    try {
      await api.saveAgent({ ...agent, places: [...agent.places, folder] });
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <div className="fd-stack">
      <h3 style={{ margin: 0 }}>Allowed folders</h3>
      <p className="fd-muted">These folders are the working directories handed to the CLI. This is not an OS sandbox.</p>
      {agent.places.map((place) => (
        <div key={place} className="fd-row" style={{ justifyContent: "space-between" }}>
          <span>{place}</span>
          <button
            className="fd-btn"
            type="button"
            onClick={() => void api.saveAgent({ ...agent, places: agent.places.filter((item) => item !== place) }).then(onRefresh).catch((reason: unknown) => setError(String(reason)))}
          >
            Remove
          </button>
        </div>
      ))}
      {error && <p className="fd-error">{error}</p>}
      <button className="fd-btn" type="button" onClick={() => void add()}>Add folder</button>
    </div>
  );
}

function AgentSettings({ agent, engines, onRefresh }: { agent: Agent; engines: Engine[]; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  const [engine, setEngine] = useState(agent.engine);
  const [allow, setAllow] = useState(agent.allowRoutines);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const changed = engine !== agent.engine;
  return (
    <div className="fd-stack">
      <p className="fd-muted">Changing the engine applies to the next run. The brief, memory, skills, and allowed folders stay with this teammate.</p>
      <select className="fd-input" value={engine} onChange={(event) => setEngine(event.target.value)}>
        {engines.filter((item) => item.available || item.id === agent.engine).map((item) => (
          <option key={item.id} value={item.id}>{item.label}{item.available ? "" : " (missing)"}</option>
        ))}
      </select>
      <label className="fd-row">
        <input type="checkbox" checked={allow} onChange={(event) => setAllow(event.target.checked)} />
        Allow routines
      </label>
      {error && <p className="fd-error">{error}</p>}
      <button
        className="fd-btn-primary"
        type="button"
        onClick={() => void api.saveAgent({ ...agent, engine, allowRoutines: allow }).then(onRefresh).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}
      >
        {changed ? "Save engine for the next run" : "Save settings"}
      </button>
      <h3>Delete</h3>
      <input className="fd-input" placeholder={`Type ${agent.name}`} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <button className="fd-danger" type="button" disabled={confirm !== agent.name} onClick={() => void api.deleteAgent(agent.id, confirm).then(onRefresh).catch((reason: unknown) => setError(String(reason)))}>
        Delete teammate
      </button>
    </div>
  );
}

function Routines({ agents, routines, onRefresh }: { agents: Agent[]; routines: RoutineRow[]; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  const [editing, setEditing] = useState<RoutineDraft | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    void api.previewRoutine(editing.schedule).then(setPreview).catch(() => setPreview([]));
  }, [api, editing]);

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      await api.saveRoutine(editing);
      setEditing(null);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="fd-stack">
      <div className="fd-row" style={{ justifyContent: "space-between" }}>
        <div>
          <p className="fd-kicker">Routines</p>
          <h2 style={{ margin: 0 }}>Work that starts while the desk is open</h2>
        </div>
        <button
          className="fd-btn-primary"
          type="button"
          onClick={() => setEditing({
            name: "",
            agentId: agents[0]?.id ?? "",
            schedule: { kind: "cron", expr: "0 9 * * 1-5" },
            prompt: "",
            enabled: true,
            notify: true,
          })}
        >
          New routine
        </button>
      </div>
      {routines.map((routine) => (
        <div key={routine.id} className="fd-card">
          <h3>{routine.name}</h3>
          <span className="fd-muted">{routine.enabled ? "Active" : "Paused"}{routine.stillRunning ? " · still running" : ""}</span>
          {routine.lastMissedAt && <span className="fd-muted">missed while closed · {new Date(routine.lastMissedAt).toLocaleString()}</span>}
          {routine.issues.map((issue) => <span key={issue} className="fd-error">{issue}</span>)}
          <div className="fd-row">
            <button className="fd-btn" type="button" onClick={() => void api.runRoutineNow(routine.id).then((result) => { if (!result.ok) setError(result.reason ?? "Could not run."); return onRefresh(); })}>Run now</button>
            <button className="fd-btn" type="button" onClick={() => void api.setRoutineEnabled(routine.id, !routine.enabled).then(onRefresh)}>{routine.enabled ? "Pause" : "Resume"}</button>
            <button className="fd-btn" type="button" onClick={() => setEditing(routine)}>Edit</button>
            <button
              className="fd-btn"
              type="button"
              onClick={() => void api.listRuns().then((runs) => {
                const last = runs.find((run) => run.routineId === routine.id);
                if (last) setOpenRun(last.id);
                else setError("This routine has no run yet.");
              })}
            >
              Open last
            </button>
            <button className="fd-danger" type="button" onClick={() => void api.deleteRoutine(routine.id).then(onRefresh)}>Delete</button>
          </div>
        </div>
      ))}
      {error && <p className="fd-error">{error}</p>}
      {openRun && <RunReader id={openRun} onClose={() => { setOpenRun(null); void onRefresh(); }} />}
      {editing && (
        <div className="fd-panel">
          <p className="fd-warn">{SECRET}</p>
          <input className="fd-input" placeholder="Name" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
          <select className="fd-input" value={editing.agentId} onChange={(event) => setEditing({ ...editing, agentId: event.target.value })}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <div className="fd-row">
            <select
              className="fd-input"
              value={editing.schedule.kind}
              onChange={(event) => {
                const kind = event.target.value;
                const schedule: Schedule = kind === "cron" ? { kind: "cron", expr: "0 9 * * 1-5" } : { kind: "every", minutes: 30 };
                setEditing({ ...editing, schedule });
              }}
            >
              <option value="cron">Cron</option>
              <option value="every">Every N minutes</option>
            </select>
            {editing.schedule.kind === "cron" ? (
              <input className="fd-input" value={editing.schedule.expr} onChange={(event) => setEditing({ ...editing, schedule: { kind: "cron", expr: event.target.value } })} />
            ) : (
              <input className="fd-input" type="number" min={5} value={editing.schedule.minutes} onChange={(event) => setEditing({ ...editing, schedule: { kind: "every", minutes: Number(event.target.value) } })} />
            )}
          </div>
          <p className="fd-muted">Include the outcome, the source of truth, the scope, the output format, and which actions still need approval.</p>
          <textarea className="fd-text" placeholder={ROUTINE_PLACEHOLDER} value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
          <label className="fd-row"><input type="checkbox" checked={editing.notify !== false} onChange={(event) => setEditing({ ...editing, notify: event.target.checked })} /> Notify when a run finishes</label>
          <div className="fd-muted">Next: {preview.length ? preview.map((item) => new Date(item).toLocaleString()).join(" · ") : "Set a valid schedule to preview three fires."}</div>
          {error && <p className="fd-error">{error}</p>}
          <div className="fd-row">
            <button className="fd-btn" type="button" onClick={() => setEditing(null)}>Cancel</button>
            <button className="fd-btn-primary" type="button" disabled={!editing.name.trim() || !editing.agentId} onClick={() => void save()}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Skills({ agents, skills, onRefresh }: { agents: Agent[]; skills: SkillDraft[]; onRefresh: () => Promise<void> }) {
  const api = window.forgedesk;
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fd-stack">
      <div className="fd-row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Skills</h2>
        <button className="fd-btn-primary" type="button" onClick={() => setDraft({ name: "", description: "", body: SKILL_TEMPLATE })}>New skill</button>
      </div>
      {skills.map((skill) => (
        <button key={skill.id} className="fd-card" type="button" onClick={() => setDraft(skill)} style={{ textAlign: "left" }}>
          <h3>{skill.name}</h3>
          <span className="fd-muted">{skill.description}</span>
        </button>
      ))}
      {draft && (
        <div className="fd-panel">
          <p className="fd-warn">{SECRET}</p>
          <input className="fd-input" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <input className="fd-input" placeholder="When this skill applies" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          <textarea className="fd-text" style={{ minHeight: 180 }} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
          <p className="fd-muted">Installed on: {agents.filter((agent) => draft.id && agent.skills.includes(draft.id)).map((agent) => agent.name).join(", ") || "nobody yet"}</p>
          {error && <p className="fd-error">{error}</p>}
          <div className="fd-row">
            <button className="fd-btn" type="button" onClick={() => setDraft(null)}>Close</button>
            {draft.id && <button className="fd-danger" type="button" onClick={() => void api.deleteSkill(draft.id!).then(() => { setDraft(null); return onRefresh(); })}>Delete</button>}
            <button className="fd-btn-primary" type="button" onClick={() => void api.saveSkill(draft).then(() => { setDraft(null); return onRefresh(); }).catch((reason: unknown) => setError(String(reason)))}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tasks({
  agents,
  tasks,
  workspaces,
  onRefresh,
}: {
  agents: Agent[];
  tasks: Task[];
  workspaces: Workspace[];
  onRefresh: () => Promise<void>;
}) {
  const api = window.forgedesk;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const columns: Task["status"][] = ["todo", "running", "review", "done"];

  async function save() {
    setError(null);
    try {
      await api.saveTask({ title, body, agentId: agentId || null, workspaceId: workspaceId || null });
      setTitle("");
      setBody("");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="fd-stack">
      <div>
        <p className="fd-kicker">Tasks</p>
        <h2 style={{ margin: "4px 0" }}>Saving a task does not start it</h2>
      </div>
      <div className="fd-panel">
        <input className="fd-input" placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea className="fd-text" placeholder="What done looks like" value={body} onChange={(event) => setBody(event.target.value)} />
        <div className="fd-row">
          <select className="fd-input" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">No agent yet</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <select className="fd-input" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">No workspace yet</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="fd-btn" type="button" disabled={!title.trim()} onClick={() => void save()}>Save task</button>
        </div>
        {error && <p className="fd-error">{error}</p>}
      </div>
      <div className="fd-board">
        {columns.map((status) => (
          <div key={status} className="fd-col">
            <span className="fd-label" style={{ margin: 0 }}>{status}</span>
            {tasks.filter((task) => task.status === status).map((task) => (
              <div key={task.id} className="fd-card">
                <h3>{task.title}</h3>
                <span className="fd-muted">{agents.find((agent) => agent.id === task.agentId)?.name ?? "Unassigned"}</span>
                {status === "todo" && (
                  <button className="fd-btn-primary" type="button" onClick={() => void api.executeTask(task.id).then((result) => { if (!result.ok) setError(result.reason ?? "Could not execute."); return onRefresh(); })}>
                    Execute
                  </button>
                )}
                {status === "running" && (
                  <button className="fd-btn" type="button" onClick={() => void api.stopTask(task.id).then(onRefresh)}>Stop</button>
                )}
                {status === "review" && (
                  <button className="fd-btn" type="button" onClick={() => void api.setTaskStatus(task.id, "done").then(onRefresh)}>Mark done</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
