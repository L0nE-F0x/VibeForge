import { Plus, Save, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import type { Skill } from "../../shared/api.js";
import { call, useAgents, useSkills } from "../api.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { Button, Empty, Field, Input, Notice, SecretNote, TextArea, Toggle } from "../components/ui.js";
import { useAction, useDeleted, useDropMissing, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";
import { useT } from "../i18n/index.js";

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
  const t = useT();
  const { go, replace } = useNav();
  const skills = useSkills();
  const list = skills.data ?? [];
  const creating = route.skillId === "new";
  const selected = list.find((skill) => skill.id === route.skillId) ?? null;
  useDropMissing(skills.loaded, Boolean(route.skillId) && !creating && !selected, { view: "skills" });

  useEffect(() => {
    if (!route.skillId && list.length) replace({ view: "skills", skillId: list[0].id });
  }, [route.skillId, list, replace]);

  return (
    <div className="view split-list">
      <SidePanel
        id="skills"
        title={t("skills.title")}
        actions={
          <>
            <Button size="sm" icon={Plus} onClick={() => go({ view: "skills", skillId: "new" })}>
              {t("common.new")}
            </Button>
          </>
        }
        strip={
          <>
            <StripItem label={t("skills.new")} onClick={() => go({ view: "skills", skillId: "new" })}>
              <Plus size={16} />
            </StripItem>
            {list.map((skill) => (
              <StripItem key={skill.id} label={skill.name} selected={skill.id === selected?.id} onClick={() => go({ view: "skills", skillId: skill.id })}>
                <Sparkles size={15} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          {skills.loaded && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("skills.none")}</div>}
          {list.map((skill) => (
            <button key={skill.id} type="button" className="row" aria-selected={skill.id === selected?.id} onClick={() => go({ view: "skills", skillId: skill.id })}>
              <Sparkles size={14} className="accent-text" style={{ flex: "none" }} />
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{skill.name}</span>
                <span className="row-sub truncate">{skill.description || t("common.noDescription")}</span>
              </span>
            </button>
          ))}
        </div>
      </SidePanel>
      {creating || selected ? (
        <SkillEditor key={selected?.id ?? "new"} skill={creating ? null : selected} />
      ) : (
        <Empty
          icon={Sparkles}
          title={t("skills.empty.title")}
          actions={
            <Button variant="primary" icon={Plus} onClick={() => go({ view: "skills", skillId: "new" })}>
              {t("skills.write")}
            </Button>
          }
        >
          {t("skills.empty.body")}
        </Empty>
      )}
    </div>
  );
}

function SkillEditor({ skill }: { skill: Skill | null }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const deleted = useDeleted();
  const agents = useAgents().data ?? [];
  const [form, setForm, discard] = useDraftState(skill ? `skill:${skill.id}` : "skill:new", {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    body: skill?.body ?? TEMPLATE,
  });
  const { name, description, body } = form;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setDescription = (next: string) => setForm((prev) => ({ ...prev, description: next }));
  const setBody = (next: string) => setForm((prev) => ({ ...prev, body: next }));
  const dirty = !skill || name !== skill.name || description !== skill.description || body !== skill.body;

  const [save, saving] = useAction(async () => {
    const saved = await call("skills.save", { id: skill?.id, name, description, body });
    push("success", skill ? t("skills.saved") : t("skills.created"), t("skills.savedBody"));
    if (!skill) {
      forgetDraft("skill:new");
      go({ view: "skills", skillId: saved.id });
    }
  }, t("skills.saveFailed"));
  const [remove, removing] = useAction(async () => {
    if (!skill) return;
    const result = await call("skills.delete", skill.id);
    go({ view: "skills" });
    deleted(t("skills.deleted", { name: skill.name }), result);
  }, t("skills.deleteFailed"));
  const [install] = useAction(async (agentId: string, on: boolean) => {
    if (!skill) return;
    const current = agents.filter((agent) => agent.skills.includes(skill.id)).map((agent) => agent.id);
    await call("skills.setAgents", skill.id, on ? [...current, agentId] : current.filter((id) => id !== agentId));
  }, t("skills.agentFailed"));
  useSaveShortcut(() => void save(), dirty && Boolean(name.trim()) && !saving);

  return (
    <div className="main">
      <div className="page-head">
        <Sparkles size={17} className="accent-text" />
        <h1 className="grow truncate">{skill ? skill.name : t("skills.new")}</h1>
        {skill && <Button size="sm" variant="ghost" icon={Trash2} busy={removing} onClick={() => void remove()} title={t("skills.delete")} />}
        {skill && dirty && (
          <Button variant="ghost" icon={Undo2} onClick={discard}>
            {t("common.discard")}
          </Button>
        )}
        <Button variant="primary" icon={Save} busy={saving} disabled={!dirty || !name.trim()} onClick={() => void save()}>
          {skill ? t("common.save") : t("skills.create")}
        </Button>
      </div>
      <div className="page-body">
        <div className="vstack page-narrow" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label={t("common.name")}>
              <Input autoFocus={!skill} value={name} placeholder="release-notes" onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label={t("skills.description")} hint={t("skills.descriptionHint")}>
              <Input value={description} placeholder={t("skills.descriptionPlaceholder")} onChange={(event) => setDescription(event.target.value)} />
            </Field>
          </div>
          <Field label="SKILL.md" hint={t("skills.bodyHint")}>
            <TextArea code value={body} style={{ minHeight: 340 }} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <SecretNote />
          {skill && (
            <>
              <div className="section-title">{t("skills.installedOn")}</div>
              {agents.length === 0 && <Notice>{t("agents.none")}</Notice>}
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
