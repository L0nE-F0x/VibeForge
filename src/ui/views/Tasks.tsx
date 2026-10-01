import { CheckCircle2, FolderPlus, GitBranch, GitMerge, Hourglass, KanbanSquare, Play, Plus, RotateCcw, Save, Square, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { setPtyInView } from "../attention.js";
import type { TaskStatus, TaskView } from "../../shared/api.js";
import { call, useAgents, useQuery, useSettings, useTasks, useWorkspaces } from "../api.js";
import { LiveTerminal } from "../components/Terminal.js";
import { Button, Chip, Field, Input, Notice, Select, Sheet, StatusChip, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { Rich } from "../i18n/Rich.js";
import { useAction, useConfirm, useDeleted, useNav, useToast, type Route } from "../state.js";
import { writerNames } from "../components/Occupancy.js";
import { useSaveShortcut } from "./Agents.js";
import { RunRow } from "./Home.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { useT, type Key } from "../i18n/index.js";

const COLUMNS: Array<{ status: TaskStatus; label: Key }> = [
  { status: "todo", label: "tasks.col.todo" },
  { status: "running", label: "tasks.col.running" },
  { status: "review", label: "tasks.col.review" },
  { status: "done", label: "tasks.col.done" },
];

const blockerKey = (blocker: NonNullable<TaskView["blocker"]>): Key => `tasks.blocker.${blocker}`;

export function TasksView({ route }: { route: Extract<Route, { view: "tasks" }> }) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const tasks = useTasks();
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const list = tasks.data ?? [];
  const open = route.taskId ? list.find((task) => task.id === route.taskId) ?? null : null;

  const onDrop = (status: TaskStatus) => async (event: DragEvent) => {
    setDropTarget(null);
    const id = event.dataTransfer.getData("application/x-vibeforge-task");
    const task = list.find((item) => item.id === id);
    if (!task || task.status === status || status === "running") return;
    try {
      await call("tasks.setStatus", id, status);
    } catch (error) {
      fail(error, t("tasks.moveFailed"));
    }
  };

  return (
    <div className="main">
      <div className="page-head">
        <KanbanSquare size={17} className="accent-text" />
        <div className="vstack grow" style={{ gap: 0 }}>
          <h1>{t("tasks.title")}</h1>
          <span className="sub">{t("tasks.sub")}</span>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
          {t("tasks.new")}
        </Button>
      </div>
      <div className="board">
        {COLUMNS.map((column) => {
          const items = list.filter((task) => task.status === column.status);
          return (
            <section
              key={column.status}
              className={`column${dropTarget === column.status ? " drop" : ""}`}
              onDragOver={(event) => {
                if (column.status === "running" || !event.dataTransfer.types.includes("application/x-vibeforge-task")) return;
                event.preventDefault();
                setDropTarget(column.status);
              }}
              onDragLeave={() => setDropTarget((prev) => (prev === column.status ? null : prev))}
              onDrop={(event) => void onDrop(column.status)(event)}
            >
              <div className="column-head">
                {t(column.label)}
                <span className="faint">{items.length}</span>
                <span className="grow" />
                {column.status === "todo" && <Button size="sm" variant="ghost" icon={Plus} title={t("tasks.new")} onClick={() => setCreating(true)} />}
              </div>
              <div className="column-body">
                {items.length === 0 && (
                  <div className="faint" style={{ padding: "8px 4px", fontSize: "var(--fs-sm)" }}>
                    {column.status === "todo" ? t("tasks.empty.todo") : column.status === "running" ? t("tasks.empty.running") : column.status === "review" ? t("tasks.empty.review") : "—"}
                  </div>
                )}
                {items.map((task) => {
                  const agent = agents.find((item) => item.id === task.agentId);
                  const workspace = workspaces.find((item) => item.id === task.workspaceId);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className={`task-card${task.lastRun?.live ? " live" : ""}`}
                      draggable={task.status !== "running"}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-vibeforge-task", task.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => go({ view: "tasks", taskId: task.id })}
                    >
                      <span className="title">{task.title}</span>
                      <span className="hstack wrap" style={{ gap: 5 }}>
                        <Chip>{agent?.name ?? t("tasks.noAgent")}</Chip>
                        <Chip>{workspace?.name ?? t("tasks.noWorkspace")}</Chip>
                        {task.isolated && <Chip icon={GitBranch} tone={task.copy ? "accent" : undefined} title={task.copy?.branch}>{t("tasks.copyChip")}</Chip>}
                      </span>
                      {task.status === "todo" && task.blocker && <span style={{ color: "var(--yellow)", fontSize: "var(--fs-sm)" }}>{t(blockerKey(task.blocker))}</span>}
                      {task.waiting && (
                        <span className="hstack accent-text" style={{ fontSize: "var(--fs-sm)" }}>
                          <Hourglass size={12} />
                          <span className="truncate">{t("turns.waitingShort", { names: writerNames(task.waiting.behind, agents) || t("turns.someone") })}</span>
                        </span>
                      )}
                      {task.lastRun && (
                        <span className="hstack faint" style={{ fontSize: "var(--fs-sm)" }}>
                          <span className={`dot ${task.lastRun.status}`} />
                          <span className="truncate">
                            {task.lastRun.live ? "running" : task.lastRun.changes ?? task.lastRun.status} · <TimeAgo iso={task.lastRun.endedAt ?? task.lastRun.startedAt} />
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {(open || creating) && (
        <TaskSheet
          key={open?.id ?? "new"}
          task={open}
          onClose={() => {
            setCreating(false);
            if (route.taskId) go({ view: "tasks" });
          }}
          onCreated={(task) => {
            setCreating(false);
            go({ view: "tasks", taskId: task.id });
          }}
        />
      )}
    </div>
  );
}

function TaskSheet({ task, onClose, onCreated }: { task: TaskView | null; onClose: () => void; onCreated: (task: TaskView) => void }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const fontSize = useSettings().data?.terminalFontSize ?? 13;
  // The live terminal fills the top of the sheet: 1100px wide at most, 46% of the window tall.
  const termSize = () => ({
    cols: Math.floor((Math.min(1100, window.innerWidth - 120) - 14) / (fontSize * 0.6)),
    rows: Math.floor((window.innerHeight * 0.46 - 14) / Math.ceil(fontSize * 1.32 * 1.18)),
  });
  const runs = useQuery(task ? `runs:task:${task.id}` : null, ["runs"], () => call("runs.list", { taskId: task!.id, limit: 50 }));
  const [form, setForm, discard] = useDraftState(task ? `task:${task.id}` : "task:new", {
    title: task?.title ?? "",
    body: task?.body ?? "",
    agentId: task ? (task.agentId ?? "") : (agents[0]?.id ?? ""),
    workspaceId: task ? (task.workspaceId ?? "") : (workspaces[0]?.id ?? ""),
    isolated: task?.isolated ?? false,
    shareCheckout: task?.shareCheckout ?? false,
  });
  const { title, body, agentId, workspaceId } = form;
  // A draft kept before copies existed has no `isolated`.
  const isolated = form.isolated ?? false;
  const setIsolated = (next: boolean) => setForm((prev) => ({ ...prev, isolated: next }));
  // A draft kept before 2.0 has no `shareCheckout`.
  const shareCheckout = form.shareCheckout ?? false;
  const setShareCheckout = (next: boolean) => setForm((prev) => ({ ...prev, shareCheckout: next }));
  const setTitle = (next: string) => setForm((prev) => ({ ...prev, title: next }));
  const setBody = (next: string) => setForm((prev) => ({ ...prev, body: next }));
  const setAgentId = (next: string) => setForm((prev) => ({ ...prev, agentId: next }));
  const setWorkspaceId = (next: string) => setForm((prev) => ({ ...prev, workspaceId: next }));

  const dirty =
    !task || title !== task.title || body !== task.body || (agentId || null) !== task.agentId || (workspaceId || null) !== task.workspaceId || isolated !== task.isolated || shareCheckout !== task.shareCheckout;
  const fields = () => ({ title, body, agentId: agentId || null, workspaceId: workspaceId || null, isolated, shareCheckout });
  const agent = agents.find((item) => item.id === agentId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const live = task?.lastRun?.live ? task.lastRun : null;
  // The task's terminal is in front of you while the sheet is open.
  useEffect(() => {
    setPtyInView("task", live?.ptyId ?? null);
    return () => setPtyInView("task", null);
  }, [live?.ptyId]);

  const [save, saving] = useAction(async () => {
    const saved = await call("tasks.save", { id: task?.id, ...fields() });
    if (!task) {
      forgetDraft("task:new");
      onCreated(saved);
    } else push("success", t("tasks.saved"));
    return saved;
  }, t("tasks.saveFailed"));
  const [execute, executing] = useAction(async (now: boolean = false, inCopy: boolean = false) => {
    if (!task) return;
    if (dirty || inCopy) await call("tasks.save", { id: task.id, ...fields(), ...(inCopy ? { isolated: true } : {}) });
    const result = await call("tasks.execute", task.id, termSize(), now);
    if ("queued" in result) push("info", t("turns.queued", { names: result.behind.join(", ") }), t("turns.queuedBody"));
  }, t("tasks.executeFailed"));
  const [stopWaiting] = useAction(async () => task && call("tasks.cancelWait", task.id), t("tasks.stopFailed"));
  const [cont, continuing] = useAction(async () => task && call("tasks.continue", task.id, termSize()), t("tasks.continueFailed"));
  const [stop, stopping] = useAction(async () => task && call("tasks.stop", task.id), t("tasks.stopFailed"));
  const [setStatus] = useAction(async (status: TaskStatus) => task && call("tasks.setStatus", task.id, status), t("tasks.moveFailed"));
  const [applyCopy, applying] = useAction(async () => {
    if (!task || !workspace) return;
    const result = await call("tasks.applyCopy", task.id);
    if (!result.files.length) push("info", t("tasks.applyNothing"));
    else if (result.conflicts.length) push("error", t("tasks.applyConflicts"), t("tasks.applyConflictsBody", { files: result.conflicts.join(", ") }));
    else push("success", t("tasks.applied", { workspace: workspace.name }), t.count("tasks.appliedBody", result.files.length));
  }, t("tasks.applyFailed"));
  const [discardCopy, discarding] = useAction(async () => {
    if (!task) return;
    const ok = await confirm({ title: t("tasks.discardCopyTitle", { title: task.title }), body: t("tasks.discardCopyBody"), confirm: t("tasks.discardCopy"), danger: true });
    if (ok) await call("tasks.discardCopy", task.id);
  }, t("tasks.discardFailed"));
  const [forgetCopy] = useAction(async () => task && call("tasks.discardCopy", task.id), t("tasks.discardFailed"));
  const [allowFolder, allowing] = useAction(async () => {
    if (!agent || !workspace) return;
    await call("agents.save", { ...agent, places: [...agent.places, workspace.path] });
    push("success", t("tasks.allowed", { agent: agent.name, workspace: workspace.name }));
  }, t("agents.addFolderFailed"));
  const [remove] = useAction(async () => {
    if (!task) return;
    // Deleting is undone from the toast. A running task asks first: stopping it can't be undone.
    if (task.status === "running") {
      const ok = await confirm({ title: t("common.deleteNamed", { name: task.title }), body: t("tasks.deleteRunningBody"), confirm: t("common.stopAndDelete"), danger: true });
      if (!ok) return;
    }
    const result = await call("tasks.delete", task.id);
    onClose();
    deleted(t("common.deletedNamed", { name: task.title }), result);
  }, t("tasks.deleteFailed"));
  useSaveShortcut(() => void save(), dirty && !saving && Boolean(title.trim()));

  const outside = agent && workspace && !agent.places.some((place) => workspace.path === place || workspace.path.startsWith(`${place}/`));

  return (
    <Sheet onClose={onClose} width={live ? 1100 : 780} label={task ? task.title : t("tasks.new")}>
      <div className="page-head">
        <KanbanSquare size={17} className="accent-text" />
        <h1 className="grow truncate">{task ? task.title : t("tasks.new")}</h1>
        {task?.lastRun && task.status !== "running" && <StatusChip status={task.lastRun.status} exitCode={task.lastRun.exitCode} />}
        {task && <Chip tone={task.status === "done" ? "ok" : task.status === "review" ? "warn" : task.status === "running" ? "accent" : undefined}>{t(COLUMNS.find((column) => column.status === task.status)?.label ?? "tasks.col.todo")}</Chip>}
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} title={t("common.closeEsc")} />
      </div>
      {live && (
        <div style={{ height: "46vh", display: "flex", flexDirection: "column", borderBottom: "1px solid var(--line)" }}>
          <LiveTerminal key={live.ptyId!} ptyId={live.ptyId!} autoFocus />
        </div>
      )}
      <div className="page-body vstack" style={{ gap: 14 }}>
        <div className="hstack wrap">
          {task && (task.status === "todo" || task.status === "review" || task.status === "done") && !live && (
            <Button variant="primary" icon={Play} busy={executing} disabled={(Boolean(task.blocker) && !dirty) || Boolean(task.waiting)} onClick={() => void execute()}>
              {task.runIds.length ? t("tasks.runAgain") : t("tasks.execute")}
            </Button>
          )}
          {task && task.lastRun && !live && task.status !== "todo" && (
            <Button icon={RotateCcw} busy={continuing} onClick={() => void cont()} title={t("tasks.reopen")}>
              {t("common.continue")}
            </Button>
          )}
          {live && (
            <Button icon={Square} busy={stopping} onClick={() => void stop()}>
              {t("tasks.stop")}
            </Button>
          )}
          {task?.status === "review" && (
            <Button icon={CheckCircle2} onClick={() => void setStatus("done")}>
              {t("tasks.markDone")}
            </Button>
          )}
          {task && (task.status === "review" || task.status === "done") && (
            <Button variant="ghost" icon={Undo2} onClick={() => void setStatus("todo")}>
              {t("tasks.backToTodo")}
            </Button>
          )}
          <span className="grow" />
          {task && dirty && (
            <Button variant="ghost" icon={Undo2} onClick={discard}>
              {t("common.discard")}
            </Button>
          )}
          <Button icon={Save} busy={saving} disabled={!dirty || !title.trim()} onClick={() => void save()}>
            {task ? t("common.save") : t("tasks.create")}
          </Button>
          {task && <Button variant="danger" icon={Trash2} onClick={() => void remove()} title={t("tasks.delete")} />}
        </div>
        {task?.waiting && !live && (
          <Notice tone="accent" icon={Hourglass}>
            <div className="vstack" style={{ gap: 8 }}>
              <span>{t("turns.waitingNote", { names: writerNames(task.waiting.behind, agents) || t("turns.someone"), workspace: workspace?.name ?? "" })}</span>
              <div className="hstack wrap">
                {!task.isolated && (
                  <Button size="sm" variant="primary" icon={GitBranch} busy={executing} tip={t("turns.inCopyTip")} onClick={() => void execute(true, true)}>
                    {t("turns.inCopy")}
                  </Button>
                )}
                <Button size="sm" icon={Play} busy={executing} tip={t("turns.anywayTip")} onClick={() => void execute(true)}>
                  {t("turns.anyway")}
                </Button>
                <Button size="sm" variant="ghost" icon={X} onClick={() => void stopWaiting()}>
                  {t("turns.stopWaiting")}
                </Button>
              </div>
            </div>
          </Notice>
        )}
        {task && !task.waiting && !live && !task.isolated && task.writers.length > 0 && (
          <Notice icon={Hourglass}>
            {t(task.writers.some((writer) => writer.busy) ? "turns.busyHere" : "turns.idleHere", { names: writerNames(task.writers, agents) })}
          </Notice>
        )}
        {task?.blocker && !live && task.status !== "running" && (
          <Notice tone="warn">
            <div className="hstack wrap">
              <span className="grow">{t("tasks.blockerNote", { blocker: t(blockerKey(task.blocker)) })}</span>
              {task.blocker === "outside-places" && outside && (
                <Button size="sm" icon={FolderPlus} busy={allowing} onClick={() => void allowFolder()}>
                  {t("tasks.allow", { agent: agent!.name, workspace: workspace!.name })}
                </Button>
              )}
            </div>
          </Notice>
        )}
        {task?.copy && !task.copyOwned && (
          <Notice tone="warn" icon={GitBranch}>
            <div className="hstack wrap">
              <span className="grow">
                <Rich text={t("tasks.copyUntrusted", { path: task.copy.path })} />
              </span>
              {!live && (
                <Button size="sm" variant="ghost" icon={X} busy={discarding} onClick={() => void forgetCopy()}>
                  {t("tasks.forgetCopy")}
                </Button>
              )}
            </div>
          </Notice>
        )}
        {task?.copy && task.copyOwned && (
          <Notice tone="accent" icon={GitBranch}>
            <div className="hstack wrap">
              <span className="grow">
                <Rich text={t("tasks.copyNote", { branch: task.copy.branch, workspace: workspace?.name ?? task.copy.repo })} />
              </span>
              {!live && (
                <>
                  <Button size="sm" variant="primary" icon={GitMerge} busy={applying} tip={t("tasks.applyTip")} onClick={() => void applyCopy()}>
                    {t("tasks.apply", { workspace: workspace?.name ?? "" })}
                  </Button>
                  <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} onClick={() => void discardCopy()}>
                    {t("tasks.discardCopy")}
                  </Button>
                </>
              )}
            </div>
          </Notice>
        )}
        <Field label={t("tasks.fieldTitle")}>
          <Input autoFocus={!task} value={title} placeholder={t("tasks.titlePlaceholder")} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t("tasks.details")} hint={t("tasks.detailsHint")}>
          <TextArea value={body} style={{ minHeight: 150 }} placeholder={t("tasks.detailsPlaceholder")} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label={t("tasks.agent")}>
            <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">{t("tasks.noAgentYet")}</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("tasks.workspace")} hint={outside ? t("tasks.outsideHint", { agent: agent!.name }) : undefined}>
            <Select value={workspaceId} disabled={Boolean(task?.copy)} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">{t("tasks.noWorkspaceYet")}</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field hint={t("tasks.isolatedHint")}>
          <Toggle checked={isolated} disabled={Boolean(task?.copy)} onChange={setIsolated} label={t("tasks.isolated")} />
        </Field>
        {!isolated && (
          <Field hint={t("turns.takeTurnsHint")}>
            <Toggle checked={!shareCheckout} onChange={(on) => setShareCheckout(!on)} label={t("turns.takeTurns")} />
          </Field>
        )}
        {task && (runs.data?.length ?? 0) > 0 && (
          <>
            <div className="section-title">{t("runs.title")}</div>
            <div className="vstack" style={{ gap: 6 }}>
              {runs.data!.map((run) => (
                <RunRow key={run.id} run={run} onClick={() => go({ view: "runs", runId: run.id, filter: "all" })} />
              ))}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
