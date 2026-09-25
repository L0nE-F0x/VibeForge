import { Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Skill } from "../../shared/api.js";
import { call, useAgents, useSkills } from "../api.js";
import { Button, Empty, Field, Input, Notice, SecretNote, TextArea, Toggle } from "../components/ui.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";

const TEMPLATE = `## When
Use this when …

## Steps
1. …

## Verify
- …

## Ask first
- Anything that pushes, publishes, deletes, spends or sends.
`;

export function SkillsView({ route }: { route: Extract<Route, { view: "skills" }> }) {
  const { go } = useNav();
  const skills = useSkills();
  const list = skills.data ?? [];
  const creating = route.skillId === "new";
  const selected = list.find((skill) => skill.id === route.skillId) ?? null;

  useEffect(() => {
    if (!route.skillId && list.length) go({ view: "skills", skillId: list[0].id });
  }, [route.skillId, list, go]);

  return (
    <div className="view split-list">
      <aside className="list-panel">
        <div className="list-head">
          <h2 className="grow">Skills</h2>
          <Button size="sm" icon={Plus} onClick={() => go({ view: "skills", skillId: "new" })}>
            New
          </Button>
        </div>
        <div className="list-scroll">
          {skills.loaded && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>No skills yet.</div>}
          {list.map((skill) => (
            <button key={skill.id} type="button" className="row" aria-selected={skill.id === selected?.id} onClick={() => go({ view: "skills", skillId: skill.id })}>
              <Sparkles size={14} className="accent-text" style={{ flex: "none" }} />
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{skill.name}</span>
                <span className="row-sub truncate">{skill.description || "No description"}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      {creating || selected ? (
        <SkillEditor key={selected?.id ?? "new"} skill={creating ? null : selected} />
      ) : (
        <Empty
          icon={Sparkles}
          title="Procedures your agents can reuse"
          actions={
            <Button variant="primary" icon={Plus} onClick={() => go({ view: "skills", skillId: "new" })}>
              Write a skill
            </Button>
          }
        >
          A skill says when it applies, the steps, how to verify, and when to stop and ask. Install it on any agent; editing it changes their next run.
        </Empty>
      )}
    </div>
  );
}

function SkillEditor({ skill }: { skill: Skill | null }) {
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const agents = useAgents().data ?? [];
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? TEMPLATE);
  const dirty = !skill || name !== skill.name || description !== skill.description || body !== skill.body;

  const [save, saving] = useAction(async () => {
    const saved = await call("skills.save", { id: skill?.id, name, description, body });
    push("success", skill ? "Skill saved" : "Skill created", "Agents that have it use the new text from their next run.");
    if (!skill) go({ view: "skills", skillId: saved.id });
  }, "Could not save the skill");
  const [remove, removing] = useAction(async () => {
    if (!skill) return;
    const users = agents.filter((agent) => agent.skills.includes(skill.id));
    const ok = await confirm({
      title: `Delete ${skill.name}?`,
      body: users.length ? `It is removed from ${users.map((agent) => agent.name).join(", ")} too.` : "No agent has it installed.",
      confirm: "Delete skill",
      danger: true,
    });
    if (!ok) return;
    await call("skills.delete", skill.id);
    go({ view: "skills" });
  }, "Could not delete the skill");
  const [install] = useAction(async (agentId: string, on: boolean) => {
    if (!skill) return;
    const current = agents.filter((agent) => agent.skills.includes(skill.id)).map((agent) => agent.id);
    await call("skills.setAgents", skill.id, on ? [...current, agentId] : current.filter((id) => id !== agentId));
  }, "Could not update the agent");
  useSaveShortcut(() => void save(), dirty && Boolean(name.trim()) && !saving);

  return (
    <div className="main">
      <div className="page-head">
        <Sparkles size={17} className="accent-text" />
        <h1 className="grow truncate">{skill ? skill.name : "New skill"}</h1>
        {skill && <Button size="sm" variant="ghost" icon={Trash2} busy={removing} onClick={() => void remove()} title="Delete skill" />}
        <Button variant="primary" icon={Save} busy={saving} disabled={!dirty || !name.trim()} onClick={() => void save()}>
          {skill ? "Save" : "Create skill"}
        </Button>
      </div>
      <div className="page-body">
        <div className="vstack page-narrow" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="Name">
              <Input autoFocus={!skill} value={name} placeholder="release-notes" onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Description" hint="One line: when an agent should reach for it.">
              <Input value={description} placeholder="Use when turning merged commits into release notes." onChange={(event) => setDescription(event.target.value)} />
            </Field>
          </div>
          <Field label="SKILL.md" hint="Sections in this order: When, Steps, Verify, Ask first.">
            <TextArea code value={body} style={{ minHeight: 340 }} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <SecretNote />
          {skill && (
            <>
              <div className="section-title">Installed on</div>
              {agents.length === 0 && <Notice>No agents yet.</Notice>}
              <div className="vstack" style={{ gap: 6 }}>
                {agents.map((agent) => (
                  <div key={agent.id} className="card hstack" style={{ padding: "8px 12px" }}>
                    <span className="grow">{agent.name}</span>
                    <Toggle checked={agent.skills.includes(skill.id)} onChange={(on) => void install(agent.id, on)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
