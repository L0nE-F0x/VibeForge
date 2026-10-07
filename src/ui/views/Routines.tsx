import { AlertTriangle, CalendarClock, History, Hourglass, Pencil, Play, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RoutineView, Schedule, SchedulePreview } from "../../shared/api.js";
import { clockTime } from "../../shared/text.js";
import { call, useAgents, useRoutines } from "../api.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { Button, Chip, Empty, Field, Input, Notice, SecretNote, Segmented, Select, Sheet, StatusChip, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { useAction, useDeleted, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";
import { useT, type Key } from "../i18n/index.js";
import { coreText } from "../core-text.js";
import { writerNames } from "../components/Occupancy.js";

const CRON_PRESETS: Array<{ label: Key; expr: string }> = [
  { label: "routines.preset.weekdays", expr: "0 9 * * 1-5" },
  { label: "routines.preset.daily", expr: "0 18 * * *" },
  { label: "routines.preset.hourly", expr: "0 * * * *" },
  { label: "routines.preset.mondays", expr: "0 10 * * 1" },
];

export function RoutinesView({ route }: { route: Extract<Route, { view: "routines" }> }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const deleted = useDeleted();
  const routines = useRoutines();
  const agents = useAgents().data ?? [];
  const [editing, setEditing] = useState<RoutineView | "new" | null>(null);
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

  return (
    <div className="main">
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <div className="vstack grow" style={{ gap: 0 }}>
          <h1>{t("rail.routines")}</h1>
          <span className="sub">{t("routines.sub")}</span>
        </div>
        {!(routines.loaded && list.length === 0) && (
          <Button variant="primary" icon={Plus} disabled={agents.length === 0} onClick={() => setEditing("new")} title={agents.length ? undefined : t("routines.needAgent")}>
            {t("routines.new")}
          </Button>
        )}
      </div>
      <div className="page-body">
        <div className="vstack page-narrow" style={{ gap: 10, maxWidth: 980 }}>
          {routines.loaded && list.length === 0 && (
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
          {list.map((routine) => (
            <div key={routine.id} id={`routine-${routine.id}`} className={`card${routine.failing ? " needs-you" : ""}`} style={route.routineId === routine.id ? { borderColor: "var(--sel-line)" } : undefined}>
              <div className="hstack">
                <CalendarClock size={16} className={routine.enabled ? "accent-text" : "faint"} />
                <div className="vstack grow" style={{ gap: 1 }}>
                  <div className="hstack">
                    <h3 className="truncate">{routine.name}</h3>
                    {!routine.enabled && <Chip>{t("routines.paused")}</Chip>}
                    {routine.stillRunning && <Chip tone="accent">{t("routines.running")}</Chip>}
                  </div>
                  <span className="faint truncate">
                    {routine.agentName ?? t("routines.missingAgent")} · {routine.description}
                    {routine.enabled && routine.nextFires[0] ? ` · ${t("routines.nextAt", { time: clockTime(routine.nextFires[0]) })}` : ""}
                  </span>
                </div>
                <Toggle checked={routine.enabled} onChange={(on) => void toggle(routine, on)} />
              </div>
              {routine.waiting && (
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
              {!routine.waiting && !routine.stillRunning && routine.writers.length > 0 && (
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
                {routine.lastRun && (
                  <span className="hstack faint" style={{ fontSize: "var(--fs-sm)" }}>
                    <StatusChip status={routine.lastRun.status} exitCode={routine.lastRun.exitCode} />
                    <TimeAgo iso={routine.lastRun.startedAt} />
                    {routine.lastRun.changes ? ` · ${routine.lastRun.changes}` : ""}
                  </span>
                )}
                <span className="grow" />
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove(routine)} title={t("routines.delete")} />
              </div>
            </div>
          ))}
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
    shareCheckout: routine?.shareCheckout ?? false,
  });
  const { name, agentId, schedule, prompt, notify, enabled } = form;
  // A draft kept before 2.0 has no `shareCheckout`.
  const shareCheckout = form.shareCheckout ?? false;
  const setName = (next: string) => setForm((prev) => ({ ...prev, name: next }));
  const setAgentId = (next: string) => setForm((prev) => ({ ...prev, agentId: next }));
  const setSchedule = (next: Schedule) => setForm((prev) => ({ ...prev, schedule: next }));
  const setPrompt = (next: string) => setForm((prev) => ({ ...prev, prompt: next }));
  const setNotify = (next: boolean) => setForm((prev) => ({ ...prev, notify: next }));
  const setEnabled = (next: boolean) => setForm((prev) => ({ ...prev, enabled: next }));
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const agent = agents.find((item) => item.id === agentId);

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
    await call("routines.save", { id: routine?.id, name, agentId, schedule, prompt, notify, enabled, shareCheckout });
    forgetDraft(draftKey);
    push("success", routine ? t("routines.saved") : t("routines.created"), preview?.next[0] ? t("routines.nextToast", { time: clockTime(preview.next[0]) }) : undefined);
    onClose();
  }, t("routines.saveFailed"));
  const ready = Boolean(name.trim() && agentId && prompt.trim() && preview?.valid);
  useSaveShortcut(() => void save(), ready && !saving);

  return (
    <Sheet onClose={onClose} width={760} label={routine ? routine.name : t("routines.newTitle")}>
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <h1 className="grow">{routine ? t("routines.editTitle", { name: routine.name }) : t("routines.newTitle")}</h1>
        <Button variant="ghost" size="sm" icon={X} tip={t("common.close")} kbd="Esc" onClick={onClose} />
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
                  <strong>{preview.description}</strong>
                  <span className="faint">{t("routines.nextList", { times: preview.next.map((when) => clockTime(when)).join("  ·  ") })}</span>
                </div>
              ) : (
                <span style={{ color: "var(--red)" }}>{schedule.kind === "cron" ? t("routines.badCron") : t("routines.badEvery")}</span>
              )}
            </div>
          </div>
        </Field>
        <Field label={t("routines.prompt")} hint={t("routines.promptHint")}>
          <TextArea value={prompt} placeholder={t("routines.promptPlaceholder")} style={{ minHeight: 170 }} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Notice icon={CalendarClock}>{t("routines.checks")}</Notice>
        <SecretNote />
        <div className="hstack wrap" style={{ gap: 20 }}>
          <Toggle checked={enabled} onChange={setEnabled} label={t("routines.enabled")} />
          <Toggle checked={notify} onChange={setNotify} label={t("routines.notify")} />
        </div>
        <Field hint={t("turns.takeTurnsHint")}>
          <Toggle checked={!shareCheckout} onChange={(on) => setForm((prev) => ({ ...prev, shareCheckout: !on }))} label={t("turns.takeTurns")} />
        </Field>
        <div className="hstack">
          <Button variant="primary" icon={Save} busy={saving} disabled={!ready} onClick={() => void save()}>
            {routine ? t("routines.save") : t("routines.create")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              discard();
              onClose();
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
