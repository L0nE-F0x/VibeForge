import { AlertTriangle, CalendarClock, GitBranch, GitMerge, History, Hourglass, MessageCircleQuestion, Pause, Pencil, Play, Plus, Power, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RoutineView, Schedule, SchedulePreview } from "../../shared/api.js";
import { fireTime } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useRoutines } from "../api.js";
import { applyToast } from "../apply-note.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { Button, Chip, Empty, Field, Input, Notice, PageSub, SecretNote, Segmented, Select, Sheet, StatusChip, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { Rich } from "../i18n/Rich.js";
import { activeFilterLabels, ListBar, NoMatch, PickMark, useList, type ListLabels, type ListRules } from "../components/ListTools.js";
import { matchesQuery, nameOrder, timeOf, type ListSpec } from "../list-view.js";
import { deleteEach, useAction, useDeleted, useDeletedMany, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";
import { useT, type Key } from "../i18n/index.js";
import { coreText } from "../core-text.js";
import { writerNames } from "../components/Occupancy.js";
import { LoadFailed, UnreadableFiles, useUnreadableOf } from "../components/LoadState.js";
import { changesFor } from "../changes-text.js";
import { scheduleText } from "../schedule-text.js";
import { shortcutKeys } from "../shortcuts.js";

const CRON_PRESETS: Array<{ label: Key; expr: string }> = [
  { label: "routines.preset.weekdays", expr: "0 9 * * 1-5" },
  { label: "routines.preset.daily", expr: "0 18 * * *" },
  { label: "routines.preset.hourly", expr: "0 * * * *" },
  { label: "routines.preset.mondays", expr: "0 10 * * 1" },
];

type RoutineFilter = "on" | "paused" | "running" | "failing" | "problem";
type RoutineSort = "name" | "next" | "last" | "agent";
const ROUTINE_LIST: ListSpec<RoutineFilter, RoutineSort> = {
  key: "routines",
  filters: ["on", "paused", "running", "failing", "problem"],
  sorts: ["name", "next", "last", "agent"],
  defaultSort: "name",
};

export function RoutinesView({ route }: { route: Extract<Route, { view: "routines" }> }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const deleted = useDeleted();
  const deletedMany = useDeletedMany();
  const routines = useRoutines();
  const home = useAppInfo().data?.home ?? "";
  const unreadableFiles = useUnreadableOf("routine").length;
  const agents = useAgents().data ?? [];
  const [editing, setEditing] = useState<RoutineView | "new" | null>(null);
  const [busyCopy, setBusyCopy] = useState<string | null>(null);
  const list = routines.data ?? [];

  useEffect(() => {
    if (!route.routineId) return;
    document.getElementById(`routine-${route.routineId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [route.routineId, list.length]);

  const [runNow] = useAction(async (routine: RoutineView, now: boolean = false) => {
    const result = await call("routines.runNow", routine.id, undefined, now);
    if ("queued" in result) push("info", t("turns.queued", { names: result.behind.join(", ") }), t("turns.queuedBody"));
    else push("success", t("routines.started", { name: routine.name }), t("routines.startedBody"));
    return result;
  }, t("routines.runFailed"));
  const [stopWaiting] = useAction(async (routine: RoutineView) => call("routines.cancelWait", routine.id), t("routines.changeFailed"));
  const [toggle] = useAction(async (routine: RoutineView, enabled: boolean) => call("routines.setEnabled", routine.id, enabled), t("routines.changeFailed"));
  const [remove] = useAction(async (routine: RoutineView) => {
    deleted(t("routines.deleted", { name: routine.name }), await call("routines.delete", routine.id));
  }, t("routines.deleteFailed"));
  const [applyCopy] = useAction(async (routine: RoutineView) => {
    setBusyCopy(`apply:${routine.id}`);
    try {
      const result = await call("routines.applyCopy", routine.id);
      const toast = applyToast(t, result, routine.workspaceName ?? routine.copy?.repo ?? "", home);
      push(toast.tone, toast.title, toast.body);
    } finally {
      setBusyCopy(null);
    }
  }, t("tasks.applyFailed"));
  const [discardCopy] = useAction(async (routine: RoutineView) => {
    setBusyCopy(`discard:${routine.id}`);
    try {
      const result = await call("routines.discardCopy", routine.id);
      deleted(t("tasks.copyDiscarded", { title: routine.name }), result);
    } finally {
      setBusyCopy(null);
    }
  }, t("tasks.discardFailed"));

  // ------------------------------------------------ search, filter, sort, select
  const collator = nameOrder(t.language);
  // Paused ones, and ones with nothing due, go after the ones that will run.
  const nextAt = (routine: RoutineView) => (routine.enabled && routine.nextFires[0] ? timeOf(routine.nextFires[0]) : Number.POSITIVE_INFINITY);
  const rules: ListRules<RoutineView, RoutineFilter, RoutineSort> = {
    test: (filter, routine) => {
      if (filter === "on") return routine.enabled;
      if (filter === "paused") return !routine.enabled;
      if (filter === "running") return routine.stillRunning;
      if (filter === "failing") return routine.failing;
      return routine.issues.length > 0 || Boolean(routine.lastMissedAt) || routine.needsInput;
    },
    search: (query, routine) => matchesQuery(query, routine.name, routine.agentName, routine.prompt, scheduleText(routine.schedule, t, routine.description)),
    compare: (sort, a, b) => {
      if (sort === "next") return nextAt(a) - nextAt(b) || collator.compare(a.name, b.name);
      if (sort === "last") return timeOf(b.lastRun?.startedAt) - timeOf(a.lastRun?.startedAt) || collator.compare(a.name, b.name);
      if (sort === "agent") return collator.compare(a.agentName ?? "", b.agentName ?? "") || collator.compare(a.name, b.name);
      return collator.compare(a.name, b.name);
    },
  };
  const view = useList(ROUTINE_LIST, list, rules, (routine) => routine.id);
  const { selection } = view;
  const picked = selection.picked;
  const labels: ListLabels<RoutineFilter, RoutineSort> = {
    filters: { on: t("routines.filter.on"), paused: t("routines.paused"), running: t("routines.running"), failing: t("routines.filter.failing"), problem: t("routines.filter.problem") },
    sorts: { name: t("list.sort.name"), next: t("routines.sort.next"), last: t("routines.sort.last"), agent: t("list.sort.agent") },
    sortChips: { name: t("list.sortShort.name"), next: t("routines.sortShort.next"), last: t("routines.sortShort.last"), agent: t("list.sortShort.agent") },
  };
  const [setPicked, switching] = useAction(async (enabled: boolean) => {
    for (const routine of picked) if (routine.enabled !== enabled) await call("routines.setEnabled", routine.id, enabled);
    selection.setSelecting(false);
  }, t("routines.changeFailed"));
  // Deleting is undone from the toast, so nothing asks first.
  const [deletePicked, deleting] = useAction(async () => {
    if (!picked.length) return;
    const { gone, deleted: undo, error } = await deleteEach(picked, (routine) => call("routines.delete", routine.id));
    if (gone.length === 1) deleted(t("routines.deleted", { name: gone[0].name }), undo[0]);
    else deletedMany(t.count("routines.deletedMany", gone.length), undo);
    if (error) throw error;
    selection.setSelecting(false);
  }, t("routines.deleteFailed"));

  return (
    <div className="main">
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <div className="vstack grow" style={{ gap: 0 }}>
          <h1>{t("rail.routines")}</h1>
          <PageSub text={t("routines.sub")} />
        </div>
        {!(routines.loaded && list.length === 0) && (
          <Button variant="primary" icon={Plus} disabled={agents.length === 0} onClick={() => setEditing("new")} title={agents.length ? undefined : t("routines.needAgent")}>
            {t("routines.new")}
          </Button>
        )}
      </div>
      <div className="page-body">
        <div className="vstack page-narrow" style={{ gap: 10, maxWidth: 980 }}>
          <LoadFailed query={routines} />
          <UnreadableFiles kind="routine" reload={routines.reload} />
          {routines.loaded && !routines.error && !unreadableFiles && list.length === 0 && (
            <Empty
              icon={CalendarClock}
              title={t("routines.empty.title")}
              actions={
                agents.length ? (
                  <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>
                    {t("routines.new")}
                  </Button>
                ) : (
                  <Button onClick={() => go({ view: "agents" })}>{t("routines.needAgent")}</Button>
                )
              }
            >
              {t("routines.empty.body")}
            </Empty>
          )}
          {list.length > 0 && (
            <ListBar
              list={view}
              labels={labels}
              placeholder={t("routines.search")}
              selectTip={t("routines.selectTip")}
              page
              actions={
                <>
                  <Button size="sm" icon={Power} busy={switching} disabled={!picked.some((routine) => !routine.enabled)} onClick={() => void setPicked(true)}>
                    {t("routines.turnOn")}
                  </Button>
                  <Button size="sm" icon={Pause} busy={switching} disabled={!picked.some((routine) => routine.enabled)} onClick={() => void setPicked(false)}>
                    {t("routines.pause")}
                  </Button>
                  <Button size="sm" variant="danger" icon={Trash2} busy={deleting} disabled={!picked.length} onClick={() => void deletePicked()} tip={t("list.deleteSelectedTip")}>
                    {t("common.delete")}
                  </Button>
                </>
              }
            />
          )}
          {list.length > 0 && view.shown.length === 0 && <NoMatch hasQuery={view.hasQuery} filters={activeFilterLabels(view, labels)} onClear={view.clear} />}
          <div className="vstack" style={{ gap: 10 }} onKeyDown={selection.onKeyDown}>
          {view.shown.map((routine) => {
            const isPicked = selection.isPicked(routine.id);
            return (
            <div
              key={routine.id}
              id={`routine-${routine.id}`}
              className={`card${routine.failing || routine.needsInput ? " needs-you" : ""}${selection.selecting ? " pickable" : ""}`}
              style={!selection.selecting && route.routineId === routine.id ? { borderColor: "var(--sel-line)" } : undefined}
              // While Select is on, the whole card picks it; its own buttons are put away until Done.
              role={selection.selecting ? "button" : undefined}
              tabIndex={selection.selecting ? 0 : undefined}
              aria-pressed={selection.selecting ? isPicked : undefined}
              onClick={selection.selecting ? () => selection.toggle(routine.id) : undefined}
              onKeyDown={(event) => {
                if (selection.selecting && (event.key === "Enter" || (event.key === " "))) {
                  event.preventDefault();
                  selection.toggle(routine.id);
                }
              }}
            >
              <div className="hstack">
                {selection.selecting ? <PickMark picked={isPicked} /> : <CalendarClock size={16} className={routine.enabled ? "accent-text" : "faint"} />}
                <div className="vstack grow" style={{ gap: 1 }}>
                  <div className="hstack">
                    <h3 className="truncate">{routine.name}</h3>
                    {!routine.enabled && <Chip>{t("routines.paused")}</Chip>}
                    {routine.needsInput ? <Chip tone="warn">{t("status.question")}</Chip> : routine.stillRunning ? <Chip tone="accent">{t("routines.running")}</Chip> : null}
                    {routine.isolated && <Chip icon={GitBranch} tone={routine.copy ? "accent" : undefined} title={routine.copy?.branch}>{t("tasks.copyChip")}</Chip>}
                  </div>
                  <span className="faint truncate">
                    {routine.agentName ?? t("routines.missingAgent")} · {scheduleText(routine.schedule, t, routine.description)}
                    {routine.enabled && routine.nextFires[0] ? ` · ${t("routines.nextAt", { time: fireTime(routine.nextFires[0], t.language) })}` : ""}
                  </span>
                </div>
                {!selection.selecting && <Toggle checked={routine.enabled} onChange={(on) => void toggle(routine, on)} />}
              </div>
              {routine.needsInput && routine.lastRun && !selection.selecting && (
                <div style={{ marginTop: 10 }}>
                  <Notice tone="warn" icon={MessageCircleQuestion}>
                    <div className="hstack wrap">
                      <span className="grow">{t("routines.questionNote")}</span>
                      <Button size="sm" variant="primary" onClick={() => go({ view: "runs", runId: routine.lastRun!.id, filter: "live" })}>
                        {t("routines.answerQuestion")}
                      </Button>
                    </div>
                  </Notice>
                </div>
              )}
              {routine.copy && !routine.copyOwned && !selection.selecting && (
                <div style={{ marginTop: 10 }}>
                  <Notice tone="warn" icon={GitBranch}>
                    <div className="hstack wrap">
                      <span className="grow">
                        <Rich text={t("routines.copyUntrusted", { path: routine.copy.path })} />
                      </span>
                      {!routine.stillRunning && (
                        <Button size="sm" variant="ghost" icon={X} busy={busyCopy === `discard:${routine.id}`} onClick={() => void discardCopy(routine)}>
                          {t("tasks.forgetCopy")}
                        </Button>
                      )}
                    </div>
                  </Notice>
                </div>
              )}
              {routine.copy && routine.copyOwned && !selection.selecting && (
                <div style={{ marginTop: 10 }}>
                  <Notice tone="accent" icon={GitBranch}>
                    <div className="hstack wrap">
                      <span className="grow">
                        <Rich text={t("tasks.copyNote", { branch: routine.copy.branch, workspace: routine.workspaceName ?? routine.copy.repo })} />
                      </span>
                      {!routine.stillRunning && (
                        <>
                          <Button size="sm" variant="primary" icon={GitMerge} busy={busyCopy === `apply:${routine.id}`} tip={t("tasks.applyTip")} onClick={() => void applyCopy(routine)}>
                            {t("tasks.apply", { workspace: routine.workspaceName ?? "" })}
                          </Button>
                          <Button size="sm" variant="ghost" icon={Trash2} busy={busyCopy === `discard:${routine.id}`} onClick={() => void discardCopy(routine)}>
                            {t("tasks.discardCopy")}
                          </Button>
                        </>
                      )}
                    </div>
                  </Notice>
                </div>
              )}
              {routine.waiting && !selection.selecting && (
                <div style={{ marginTop: 10 }}>
                  <Notice tone="accent" icon={Hourglass}>
                    <div className="hstack wrap">
                      <span className="grow">{t("turns.routineWaiting", { names: writerNames(routine.waiting.behind, agents) || t("turns.someone") })}</span>
                      <Button size="sm" icon={Play} tip={t("turns.anywayTip")} onClick={() => void runNow(routine, true)}>
                        {t("turns.anyway")}
                      </Button>
                      <Button size="sm" variant="ghost" icon={X} onClick={() => void stopWaiting(routine)}>
                        {t("turns.stopWaiting")}
                      </Button>
                    </div>
                  </Notice>
                </div>
              )}
              {!routine.waiting && !routine.stillRunning && !routine.isolated && routine.writers.length > 0 && (
                <div className="faint" style={{ marginTop: 8, fontSize: "var(--fs-sm)" }}>
                  {t(routine.shareCheckout ? "turns.routineShares" : "turns.routineWillWait", { names: writerNames(routine.writers, agents) })}
                </div>
              )}
              {(routine.issues.length > 0 || routine.lastMissedAt || routine.failing) && (
                <div className="vstack" style={{ gap: 6, marginTop: 10 }}>
                  {routine.failing && (
                    <Notice tone="bad" icon={AlertTriangle}>
                      {t("routines.failing", { count: routine.failStreak })}
                    </Notice>
                  )}
                  {routine.issues.map((issue) => (
                    <Notice key={issue} tone="bad" icon={AlertTriangle}>
                      {coreText(issue)}
                    </Notice>
                  ))}
                  {routine.lastMissedAt && (
                    <Notice tone="warn">
                      {t("routines.missed", { when: new Date(routine.lastMissedAt).toLocaleString(t.language) })}
                    </Notice>
                  )}
                </div>
              )}
              {!selection.selecting && routine.recentRuns.length > 0 && (
                <div className="vstack" style={{ gap: 4, marginTop: 10 }}>
                  <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{t("routines.recentRuns")}</span>
                  {routine.recentRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className="run-row"
                      style={{ padding: "6px 8px" }}
                      onClick={() => go({ view: "runs", runId: run.id, filter: "all" })}
                    >
                      <StatusChip status={run.status} exitCode={run.exitCode} result={run.result} error={run.error} />
                      <span className="meta truncate grow">
                        <TimeAgo iso={run.endedAt ?? run.startedAt} />
                        {run.changes ? ` · ${changesFor(run.changes, t)}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!selection.selecting && (
              <div className="hstack wrap" style={{ marginTop: 12 }}>
                <Button size="sm" icon={Play} disabled={routine.stillRunning || Boolean(routine.waiting)} onClick={() => void runNow(routine)}>
                  {t("routines.runNow")}
                </Button>
                <Button size="sm" icon={Pencil} onClick={() => setEditing(routine)}>
                  {t("common.edit")}
                </Button>
                {routine.lastRun && (
                  <Button size="sm" icon={History} onClick={() => go({ view: "runs", runId: routine.lastRun!.id, filter: "all" })}>
                    {t("routines.lastRun")}
                  </Button>
                )}
                <span className="grow" />
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove(routine)} title={t("routines.delete")} />
              </div>
              )}
            </div>
            );
          })}
          </div>
        </div>
      </div>
      {editing && <RoutineEditor routine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoutineEditor({ routine, onClose }: { routine: RoutineView | null; onClose: () => void }) {
  const t = useT();
  const { push } = useToast();
  const agents = useAgents().data ?? [];
  // Esc or the close button puts an unsaved edit aside for next time; Cancel throws it away.
  const draftKey = routine ? `routine:${routine.id}` : "routine:new";
  const [form, setForm, discard] = useDraftState(draftKey, {
    name: routine?.name ?? "",
    agentId: routine?.agentId ?? agents.find((agent) => agent.allowRoutines)?.id ?? agents[0]?.id ?? "",
    schedule: routine?.schedule ?? ({ kind: "cron", expr: "0 9 * * 1-5" } as Schedule),
    prompt: routine?.prompt ?? "",
    notify: routine?.notify ?? true,
    enabled: routine?.enabled ?? true,
    timeoutMinutes: routine?.timeoutMinutes ?? 120,
    isolated: routine?.isolated ?? false,
    shareCheckout: routine?.shareCheckout ?? false,
  });
  const { name, agentId, schedule, prompt, notify, enabled } = form;
  // Drafts kept before 2.0 / 3.16 have neither `shareCheckout` nor `timeoutMinutes` / `isolated`.
  const timeoutMinutes = form.timeoutMinutes ?? 120;
  const isolated = form.isolated ?? false;
  const shareCheckout = form.shareCheckout ?? false;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setAgentId = (next: string) => setForm((prev) => ({ ...prev, agentId: next }));
  const setSchedule = (next: Schedule) => setForm((prev) => ({ ...prev, schedule: next }));
  const setPrompt = (next: string) => setForm((prev) => ({ ...prev, prompt: next }));
  const setNotify = (next: boolean) => setForm((prev) => ({ ...prev, notify: next }));
  const setEnabled = (next: boolean) => setForm((prev) => ({ ...prev, enabled: next }));
  const setTimeoutMinutes = (next: number) => setForm((prev) => ({ ...prev, timeoutMinutes: next }));
  const setIsolated = (next: boolean) => setForm((prev) => ({ ...prev, isolated: next }));
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const agent = agents.find((item) => item.id === agentId);
  const validTimeout = Number.isInteger(timeoutMinutes) && timeoutMinutes >= 5 && timeoutMinutes <= 7 * 24 * 60;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void call("routines.preview", schedule)
        .then((next) => !cancelled && setPreview(next))
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [schedule]);

  const [save, saving] = useAction(async () => {
    await call("routines.save", { id: routine?.id, name, agentId, schedule, prompt, notify, enabled, timeoutMinutes, isolated, shareCheckout });
    forgetDraft(draftKey);
    push("success", routine ? t("routines.saved") : t("routines.created"), preview?.next[0] ? t("routines.nextToast", { time: fireTime(preview.next[0], t.language) }) : undefined);
    onClose();
  }, t("routines.saveFailed"));
  const ready = Boolean(name.trim() && agentId && prompt.trim() && preview?.valid && validTimeout);
  useSaveShortcut(() => void save(), ready && !saving);

  return (
    <Sheet onClose={onClose} width={760} label={routine ? routine.name : t("routines.newTitle")}>
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <h1 className="grow">{routine ? t("routines.editTitle", { name: routine.name }) : t("routines.newTitle")}</h1>
        <Button variant="ghost" size="sm" icon={X} tip={t("common.close")} kbd={shortcutKeys("overlay.close")} onClick={onClose} />
      </div>
      <div className="page-body vstack" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label={t("common.name")}>
            <Input autoFocus={!routine} value={name} placeholder={t("routines.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t("tasks.agent")} error={agent && !agent.allowRoutines ? t("routines.agentOff", { name: agent.name }) : undefined}>
            <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("routines.schedule")} hint={t("routines.scheduleHint")}>
          <div className="vstack" style={{ gap: 8 }}>
            <Segmented
              value={schedule.kind}
              onChange={(kind) => setSchedule(kind === "cron" ? { kind: "cron", expr: "0 9 * * 1-5" } : { kind: "every", minutes: 30 })}
              options={[
                { value: "cron", label: t("routines.cron") },
                { value: "every", label: t("routines.every") },
              ]}
            />
            {schedule.kind === "cron" ? (
              <>
                <Input className="mono" value={schedule.expr} invalid={preview?.valid === false} onChange={(event) => setSchedule({ kind: "cron", expr: event.target.value })} placeholder={t("routines.cronPlaceholder")} />
                <div className="hstack wrap" style={{ gap: 5 }}>
                  {CRON_PRESETS.map((preset) => (
                    <Button key={preset.expr} size="sm" variant="ghost" pressed={schedule.expr === preset.expr} onClick={() => setSchedule({ kind: "cron", expr: preset.expr })}>
                      {t(preset.label)}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <div className="hstack">
                <Input
                  type="number"
                  min={5}
                  step={5}
                  style={{ width: 120 }}
                  value={Number.isFinite(schedule.minutes) ? schedule.minutes : ""}
                  invalid={preview?.valid === false}
                  onChange={(event) => setSchedule({ kind: "every", minutes: Number(event.target.value) })}
                />
                <span className="faint">{t("routines.minutesMin")}</span>
                {[15, 30, 60, 240].map((minutes) => (
                  <Button key={minutes} size="sm" variant="ghost" pressed={schedule.minutes === minutes} onClick={() => setSchedule({ kind: "every", minutes })}>
                    {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
                  </Button>
                ))}
              </div>
            )}
            <div className="card" style={{ padding: "9px 12px" }}>
              {preview?.valid ? (
                <div className="vstack" style={{ gap: 4 }}>
                  <strong>{scheduleText(schedule, t, preview.description)}</strong>
                  <span className="faint">{t("routines.nextList", { times: preview.next.map((when) => fireTime(when, t.language)).join("  ·  ") })}</span>
                </div>
              ) : (
                <span style={{ color: "var(--red)" }}>{schedule.kind === "cron" ? t("routines.badCron") : t("routines.badEvery")}</span>
              )}
            </div>
          </div>
        </Field>
        <Field label={t("routines.prompt")} hint={t("routines.promptHint")} more={t("routines.checks")}>
          <TextArea value={prompt} placeholder={t("routines.promptPlaceholder")} style={{ minHeight: 170 }} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <SecretNote />
        <div className="hstack wrap" style={{ gap: 20 }}>
          <Toggle checked={enabled} onChange={setEnabled} label={t("routines.enabled")} />
          <Toggle checked={notify} onChange={setNotify} label={t("routines.notify")} />
        </div>
        <Field label={t("routines.timeout")} hint={t("routines.timeoutHint")}>
          <div className="hstack">
            <Input
              type="number"
              min={5}
              max={10080}
              step={5}
              style={{ width: 120 }}
              value={Number.isFinite(timeoutMinutes) ? timeoutMinutes : ""}
              invalid={!validTimeout}
              onChange={(event) => setTimeoutMinutes(Number(event.target.value))}
            />
            <span className="faint">{t("routines.minutesMin")}</span>
            {[30, 60, 120, 240].map((minutes) => (
              <Button key={minutes} size="sm" variant="ghost" pressed={timeoutMinutes === minutes} onClick={() => setTimeoutMinutes(minutes)}>
                {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
              </Button>
            ))}
          </div>
        </Field>
        <Field hint={t("routines.isolatedHint")}>
          <Toggle checked={isolated} disabled={Boolean(routine?.copy)} onChange={setIsolated} label={t("tasks.isolated")} />
        </Field>
        {!isolated && (
          <Field hint={t("turns.takeTurnsHint")}>
            <Toggle checked={!shareCheckout} onChange={(on) => setForm((prev) => ({ ...prev, shareCheckout: !on }))} label={t("turns.takeTurns")} />
          </Field>
        )}
      </div>
      <div className="sheet-foot">
        <span className="grow" />
        <Button
          variant="ghost"
          onClick={() => {
            discard();
            onClose();
          }}
        >
          {t("common.cancel")}
        </Button>
        <Button variant="primary" icon={Save} busy={saving} disabled={!ready} kbd={shortcutKeys("form.save")} tip={routine ? t("routines.save") : t("routines.create")} onClick={() => void save()}>
          {routine ? t("routines.save") : t("routines.create")}
        </Button>
      </div>
    </Sheet>
  );
}
