import { Plus, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { LibraryConflicts, SyncMark, SyncSwitch, useLibrary, useSyncReady } from "../components/LibrarySync.js";
import { useEffect } from "react";
import type { Skill } from "../../shared/api.js";
import { call, useAgents, useSkills } from "../api.js";
import { activeFilterLabels, ListBar, NoMatch, PickMark, useList, type ListLabels, type ListRules } from "../components/ListTools.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { LoadFailed } from "../components/LoadState.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { Button, Empty, Field, Input, Notice, SecretNote, TextArea, Toggle } from "../components/ui.js";
import { matchesQuery, nameOrder, type ListSpec } from "../list-view.js";
import { deleteEach, useAction, useDeleted, useDeletedMany, useDropMissing, useNav, useToast, type Route } from "../state.js";
import { SaveState, useAutosave, useSaveShortcut } from "./Agents.js";
import { shortcutKeys } from "../shortcuts.js";
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

type SkillFilter = "used" | "unused" | "undescribed";
type SkillSort = "name" | "agents";
const SKILL_LIST: ListSpec<SkillFilter, SkillSort> = { key: "skills", filters: ["used", "unused", "undescribed"], sorts: ["name", "agents"], defaultSort: "name" };

export function SkillsView({ route }: { route: Extract<Route, { view: "skills" }> }) {
  const t = useT();
  const { go, replace } = useNav();
  const deleted = useDeleted();
  const deletedMany = useDeletedMany();
  const skills = useSkills();
  const agents = useAgents().data ?? [];
  const library = useLibrary().data;
  const syncReady = useSyncReady().ready;
  const list = skills.data ?? [];
  const creating = route.skillId === "new";
  const selected = list.find((skill) => skill.id === route.skillId) ?? null;
  // A list that couldn't be read says so, and isn't taken for "no skills" (nor drops the one asked for).
  const unreadable = skills.error !== null && skills.data === undefined;
  useDropMissing(skills.loaded && !unreadable, Boolean(route.skillId) && !creating && !selected, { view: "skills" });

  useEffect(() => {
    if (!route.skillId && list.length) replace({ view: "skills", skillId: list[0].id });
  }, [route.skillId, list, replace]);

  // ------------------------------------------------ search, filter, sort, select
  const usedBy = (skill: Skill) => agents.filter((agent) => agent.skills.includes(skill.id)).length;
  const collator = nameOrder(t.language);
  const rules: ListRules<Skill, SkillFilter, SkillSort> = {
    test: (filter, skill) => (filter === "used" ? usedBy(skill) > 0 : filter === "unused" ? usedBy(skill) === 0 : !skill.description.trim()),
    search: (query, skill) => matchesQuery(query, skill.name, skill.description),
    compare: (sort, a, b) => (sort === "agents" ? usedBy(b) - usedBy(a) : 0) || collator.compare(a.name, b.name),
  };
  const view = useList(SKILL_LIST, list, rules, (skill) => skill.id);
  const { selection } = view;
  const labels: ListLabels<SkillFilter, SkillSort> = {
    filters: { used: t("skills.filter.used"), unused: t("skills.filter.unused"), undescribed: t("common.noDescription") },
    sorts: { name: t("list.sort.name"), agents: t("skills.sort.agents") },
    sortChips: { name: t("list.sortShort.name"), agents: t("skills.sortShort.agents") },
  };
  // Deleting is undone from the toast, so nothing asks first.
  const [deletePicked, deleting] = useAction(async () => {
    const picked = selection.picked;
    if (!picked.length) return;
    const { gone, deleted: undo, error } = await deleteEach(picked, (skill) => call("skills.delete", skill.id));
    if (selected && gone.includes(selected)) {
      const left = view.shown.find((skill) => !gone.includes(skill)) ?? list.find((skill) => !gone.includes(skill));
      go(left ? { view: "skills", skillId: left.id } : { view: "skills" });
    }
    if (gone.length === 1) deleted(t("skills.deleted", { name: gone[0].name }), undo[0]);
    else deletedMany(t.count("skills.deletedMany", gone.length), undo);
    if (error) throw error;
    selection.setSelecting(false);
  }, t("skills.deleteFailed"));
  const pickedSync = selection.picked.length > 0 && selection.picked.every((skill) => library?.skills[skill.id]?.on);
  const [syncPicked, syncing] = useAction(async () => {
    for (const skill of selection.picked) if (Boolean(library?.skills[skill.id]?.on) === pickedSync) await call("sync.setSkill", skill.id, !pickedSync);
  }, t("library.setFailed"));

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
            {view.ordered.map((skill) => (
              <StripItem key={skill.id} label={skill.name} selected={skill.id === selected?.id} onClick={() => go({ view: "skills", skillId: skill.id })}>
                <Sparkles size={15} />
              </StripItem>
            ))}
          </>
        }
      >
        <ListBar
          list={view}
          labels={labels}
          placeholder={t("skills.search")}
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
          <LoadFailed query={skills} />
          {skills.loaded && !unreadable && list.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("skills.none")}</div>}
          {list.length > 0 && view.shown.length === 0 && <NoMatch hasQuery={view.hasQuery} filters={activeFilterLabels(view, labels)} onClear={view.clear} />}
          {view.shown.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="row"
              aria-current={(!selection.selecting && skill.id === selected?.id) || undefined}
              aria-pressed={selection.selecting ? selection.isPicked(skill.id) : undefined}
              onClick={() => (selection.selecting ? selection.toggle(skill.id) : go({ view: "skills", skillId: skill.id }))}
            >
              {selection.selecting ? <PickMark picked={selection.isPicked(skill.id)} /> : <Sparkles size={14} className="accent-text" style={{ flex: "none" }} />}
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{skill.name}</span>
                <span className="row-sub truncate">{skill.description || t("common.noDescription")}</span>
              </span>
              <SyncMark item={library?.skills[skill.id]} />
            </button>
          ))}
        </div>
      </SidePanel>
      {creating || selected ? (
        <SkillEditor key={selected?.id ?? "new"} skill={creating ? null : selected} />
      ) : unreadable ? null : (
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
  const skills = useSkills();
  const agents = useAgents().data ?? [];
  const [form, setForm] = useDraftState(skill ? `skill:${skill.id}` : "skill:new", {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    body: skill?.body ?? TEMPLATE,
  });
  const { name, description, body } = form;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setDescription = (next: string) => setForm((prev) => ({ ...prev, description: next }));
  const setBody = (next: string) => setForm((prev) => ({ ...prev, body: next }));
  // Compared as the core keeps them (trimmed), so a stray space doesn't keep an autosave going.
  const dirty = !skill || name.trim() !== skill.name || description.trim() !== skill.description || body.trim() !== skill.body;

  const [save, saving] = useAction(async () => {
    const saved = await call("skills.save", { id: skill?.id, name: name.trim(), description, body });
    if (!skill) {
      push("success", t("skills.created"), t("skills.savedBody"));
      forgetDraft("skill:new");
      go({ view: "skills", skillId: saved.id });
    }
  }, t("skills.saveFailed"));
  // An existing skill saves itself as you edit; a new one is made by Create.
  const cancelAutosave = useAutosave(form, Boolean(skill) && dirty, Boolean(name.trim()) && !saving, () => void save());
  useSaveShortcut(() => void save(), !skill && Boolean(name.trim()) && !saving);
  const [remove, removing] = useAction(async () => {
    if (!skill) return;
    cancelAutosave();
    const result = await call("skills.delete", skill.id);
    // Straight to one that is left: the list hasn't reloaded yet, so "the first one" would be this one.
    const next = (skills.data ?? []).find((item) => item.id !== skill.id);
    go(next ? { view: "skills", skillId: next.id } : { view: "skills" });
    deleted(t("skills.deleted", { name: skill.name }), result);
  }, t("skills.deleteFailed"));
  const [install] = useAction(async (agentId: string, on: boolean) => {
    if (!skill) return;
    const current = agents.filter((agent) => agent.skills.includes(skill.id)).map((agent) => agent.id);
    await call("skills.setAgents", skill.id, on ? [...current, agentId] : current.filter((id) => id !== agentId));
  }, t("skills.agentFailed"));

  return (
    <div className="main">
      <div className="page-head">
        <Sparkles size={17} className="accent-text" />
        <h1 className="grow truncate">{skill ? skill.name : t("skills.new")}</h1>
        {skill && <Button size="sm" variant="ghost" icon={Trash2} busy={removing} onClick={() => void remove()} title={t("skills.delete")} />}
        {skill ? (
          <SaveState dirty={dirty} saving={saving} note={`${t("common.saved")} · ${t("skills.savedBody")}`} />
        ) : (
          <Button variant="primary" icon={Save} busy={saving} disabled={!name.trim()} kbd={shortcutKeys("form.save")} tip={t("skills.create")} onClick={() => void save()}>
            {t("skills.create")}
          </Button>
        )}
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
              <SyncSwitch kind="skill" id={skill.id} />
              <LibraryConflicts kind="skill" id={skill.id} />
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
