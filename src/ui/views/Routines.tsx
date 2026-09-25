import { AlertTriangle, CalendarClock, History, Pencil, Play, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RoutineView, Schedule, SchedulePreview } from "../../shared/api.js";
import { clockTime } from "../../shared/text.js";
import { call, useAgents, useRoutines } from "../api.js";
import { Button, Chip, Empty, Field, Input, Notice, SecretNote, Segmented, Select, Sheet, StatusChip, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";
import { useT } from "../i18n/index.js";

const PROMPT_PLACEHOLDER = `Look at commits merged in the allowed repo since yesterday.
Draft release notes grouped by what a person can now do.
Link each claim to a commit.
Leave the draft in the chat. Do not push, tag, publish, delete or send.`;

const CRON_PRESETS = [
  { label: "Weekdays 09:00", expr: "0 9 * * 1-5" },
  { label: "Every day 18:00", expr: "0 18 * * *" },
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Mondays 10:00", expr: "0 10 * * 1" },
];

const PROMPT_CHECKS = ["The outcome you want", "The source of truth", "The scope", "The output format", "What still needs your approval"];

export function RoutinesView({ route }: { route: Extract<Route, { view: "routines" }> }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const routines = useRoutines();
  const agents = useAgents().data ?? [];
  const [editing, setEditing] = useState<RoutineView | "new" | null>(null);
  const list = routines.data ?? [];

  useEffect(() => {
    if (!route.routineId) return;
    document.getElementById(`routine-${route.routineId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [route.routineId, list.length]);

  const [runNow] = useAction(async (routine: RoutineView) => {
    const launched = await call("routines.runNow", routine.id);
    push("success", `${routine.name} started`, "Open it from Runs, or here once it finishes.");
    return launched;
  }, "Could not run the routine");
  const [toggle] = useAction(async (routine: RoutineView, enabled: boolean) => call("routines.setEnabled", routine.id, enabled), "Could not change the routine");
  const [remove] = useAction(async (routine: RoutineView) => {
    const ok = await confirm({ title: `Delete ${routine.name}?`, body: "The schedule is removed. Its past runs stay in Runs.", confirm: "Delete routine", danger: true });
    if (ok) await call("routines.delete", routine.id);
  }, "Could not delete the routine");

  return (
    <div className="main">
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <div className="vstack grow" style={{ gap: 0 }}>
          <h1>{t("rail.routines")}</h1>
          <span className="sub">{t("routines.sub")}</span>
        </div>
        <Button variant="primary" icon={Plus} disabled={agents.length === 0} onClick={() => setEditing("new")} title={agents.length ? undefined : t("routines.needAgent")}>
          {t("routines.new")}
        </Button>
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
            <div key={routine.id} id={`routine-${routine.id}`} className="card" style={route.routineId === routine.id ? { borderColor: "var(--sel-line)" } : undefined}>
              <div className="hstack">
                <CalendarClock size={16} className={routine.enabled ? "accent-text" : "faint"} />
                <div className="vstack grow" style={{ gap: 1 }}>
                  <div className="hstack">
                    <h3 className="truncate">{routine.name}</h3>
                    {!routine.enabled && <Chip>Paused</Chip>}
                    {routine.stillRunning && <Chip tone="accent">Running</Chip>}
                  </div>
                  <span className="faint truncate">
                    {routine.agentName ?? "Missing agent"} · {routine.description}
                    {routine.enabled && routine.nextFires[0] ? ` · next ${clockTime(routine.nextFires[0])}` : ""}
                  </span>
                </div>
                <Toggle checked={routine.enabled} onChange={(on) => void toggle(routine, on)} />
              </div>
              {(routine.issues.length > 0 || routine.lastMissedAt) && (
                <div className="vstack" style={{ gap: 6, marginTop: 10 }}>
                  {routine.issues.map((issue) => (
                    <Notice key={issue} tone="bad" icon={AlertTriangle}>
                      {issue}
                    </Notice>
                  ))}
                  {routine.lastMissedAt && (
                    <Notice tone="warn">
                      Missed while closed: {new Date(routine.lastMissedAt).toLocaleString()}. It was not replayed.
                    </Notice>
                  )}
                </div>
              )}
              <div className="hstack wrap" style={{ marginTop: 12 }}>
                <Button size="sm" icon={Play} disabled={routine.stillRunning} onClick={() => void runNow(routine)}>
                  Run now
                </Button>
                <Button size="sm" icon={Pencil} onClick={() => setEditing(routine)}>
                  Edit
                </Button>
                {routine.lastRun && (
                  <Button size="sm" icon={History} onClick={() => go({ view: "runs", runId: routine.lastRun!.id, filter: "all" })}>
                    Last run
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
  const [name, setName] = useState(routine?.name ?? "");
  const [agentId, setAgentId] = useState(routine?.agentId ?? agents.find((agent) => agent.allowRoutines)?.id ?? agents[0]?.id ?? "");
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? { kind: "cron", expr: "0 9 * * 1-5" });
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [notify, setNotify] = useState(routine?.notify ?? true);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
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
    await call("routines.save", { id: routine?.id, name, agentId, schedule, prompt, notify, enabled });
    push("success", routine ? "Routine saved" : "Routine created", preview?.next[0] ? `Next: ${clockTime(preview.next[0])}` : undefined);
    onClose();
  }, "Could not save the routine");
  const ready = Boolean(name.trim() && agentId && prompt.trim() && preview?.valid);
  useSaveShortcut(() => void save(), ready && !saving);

  return (
    <Sheet onClose={onClose} width={760}>
      <div className="page-head">
        <CalendarClock size={17} className="accent-text" />
        <h1 className="grow">{routine ? `Edit ${routine.name}` : "New routine"}</h1>
        <Button variant="ghost" size="sm" icon={X} tip={t("common.close")} kbd="Esc" onClick={onClose} />
      </div>
      <div className="page-body vstack" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label="Name">
            <Input autoFocus={!routine} value={name} placeholder="Weekday release notes" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Agent" error={agent && !agent.allowRoutines ? `${agent.name} does not allow routines. Turn it on in its settings.` : undefined}>
            <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Schedule" hint="Local time. Starts counting from now; past slots never fire.">
          <div className="vstack" style={{ gap: 8 }}>
            <Segmented
              value={schedule.kind}
              onChange={(kind) => setSchedule(kind === "cron" ? { kind: "cron", expr: "0 9 * * 1-5" } : { kind: "every", minutes: 30 })}
              options={[
                { value: "cron", label: "Cron" },
                { value: "every", label: "Every N minutes" },
              ]}
            />
            {schedule.kind === "cron" ? (
              <>
                <Input className="mono" value={schedule.expr} invalid={preview?.valid === false} onChange={(event) => setSchedule({ kind: "cron", expr: event.target.value })} placeholder="minute hour day month weekday" />
                <div className="hstack wrap" style={{ gap: 5 }}>
                  {CRON_PRESETS.map((preset) => (
                    <Button key={preset.expr} size="sm" variant="ghost" pressed={schedule.expr === preset.expr} onClick={() => setSchedule({ kind: "cron", expr: preset.expr })}>
                      {preset.label}
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
                <span className="faint">minutes (at least 5)</span>
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
                  <span className="faint">Next: {preview.next.map((when) => clockTime(when)).join("  ·  ")}</span>
                </div>
              ) : (
                <span style={{ color: "var(--red)" }}>{schedule.kind === "cron" ? "Not a valid five-field cron expression." : "Use a whole number of minutes, 5 or more."}</span>
              )}
            </div>
          </div>
        </Field>
        <Field label="Prompt" hint="Each run starts fresh: it gets the brief, memory and skills, and this prompt — never earlier transcripts.">
          <TextArea value={prompt} placeholder={PROMPT_PLACEHOLDER} style={{ minHeight: 170 }} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Notice icon={CalendarClock}>
          A prompt that stands alone says: {PROMPT_CHECKS.join(" · ")}. Default to a draft for review; ask it not to push, publish, delete or send.
        </Notice>
        <SecretNote />
        <div className="hstack wrap" style={{ gap: 20 }}>
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          <Toggle checked={notify} onChange={setNotify} label="Notify me when a run finishes" />
        </div>
        <div className="hstack">
          <Button variant="primary" icon={Save} busy={saving} disabled={!ready} onClick={() => void save()}>
            {routine ? "Save routine" : "Create routine"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
