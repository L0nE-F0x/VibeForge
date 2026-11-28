import { ArrowRightLeft, CheckCircle2, FileDiff, FolderPlus, GitBranch, Hourglass, KanbanSquare, MessagesSquare, MoreHorizontal, Play, Plus, RotateCcw, Save, Square, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { setPtyInView } from "../attention.js";
import type { CopyReview, TaskStatus, TaskView } from "../../shared/api.js";
import { call, useAgents, useAppInfo, useQuery, useSettings, useTasks, useWorkspaces } from "../api.js";
import { CopyApplyButton } from "../components/CopyApply.js";
import { DiffReview } from "../components/DiffReviewLazy.js";
import { useCopyPick } from "../copy-pick.js";
import { LiveTerminal } from "../components/Terminal.js";
import { LoadFailed, UnreadableFiles, useUnreadableOf } from "../components/LoadState.js";
import { activeFilterLabels, ListBar, NoMatch, PickMark, toolsWanted, useList, type ListLabels, type ListRules } from "../components/ListTools.js";
import { Button, Chip, Field, Input, MenuButton, Notice, Select, Sheet, Skeleton, STATUS_KEY, StatusChip, TextArea, TimeAgo, Toggle } from "../components/ui.js";
import { matchesQuery, nameOrder, runWentWrong, timeOf, type ListSpec } from "../list-view.js";
import { Rich } from "../i18n/Rich.js";
import { deleteEach, useAction, useConfirm, useDeleted, useDeletedMany, useDropMissing, useNav, useToast, type Route } from "../state.js";
import { writerNames } from "../components/Occupancy.js";
import { useSaveShortcut } from "./Agents.js";
import { RunRow } from "./Home.js";
import { forgetDraft, useDraftState } from "../drafts.js";
import { useT, type Key } from "../i18n/index.js";
import { changesFor } from "../changes-text.js";
import { applyToast } from "../apply-note.js";
import { shortcutKeys } from "../shortcuts.js";

const COLUMNS: Array<{ status: TaskStatus; label: Key }> = [
  { status: "todo", label: "tasks.col.todo" },
  { status: "running", label: "tasks.col.running" },
  { status: "review", label: "tasks.col.review" },
  { status: "done", label: "tasks.col.done" },
];

const blockerKey = (blocker: NonNullable<TaskView["blocker"]>): Key => `tasks.blocker.${blocker}`;

type TaskFilter = "blocked" | "waiting" | "copy" | "failed" | "asked";
type TaskSort = "updated" | "created" | "name" | "agent";
const TASK_LIST: ListSpec<TaskFilter, TaskSort> = {
  key: "tasks",
  filters: ["blocked", "waiting", "copy", "failed", "asked"],
  sorts: ["updated", "created", "name", "agent"],
  defaultSort: "updated",
};

export function TasksView({ route }: { route: Extract<Route, { view: "tasks" }> }) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const deletedMany = useDeletedMany();
  const tasks = useTasks();
  const unreadableFiles = useUnreadableOf("task").length;
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const list = tasks.data ?? [];
  // A board that couldn't be read says so above its columns, and its columns don't claim "Nothing queued".
  // A list that couldn't be read, or that left some tasks out, doesn't say a column is empty.
  const unreadable = (tasks.error !== null && tasks.data === undefined) || unreadableFiles > 0;

  // ------------------------------------------------ search, filter, sort, select
  const agentName = (task: TaskView) => agents.find((item) => item.id === task.agentId)?.name ?? "";
  const workspaceName = (task: TaskView) => workspaces.find((item) => item.id === task.workspaceId)?.name ?? "";
  const collator = nameOrder(t.language);
  const rules: ListRules<TaskView, TaskFilter, TaskSort> = {
    test: (filter, task) => {
      if (filter === "blocked") return task.status === "todo" && Boolean(task.blocker);
      if (filter === "waiting") return Boolean(task.waiting);
      if (filter === "copy") return task.isolated;
      if (filter === "failed") return Boolean(task.lastRun && !task.lastRun.live && runWentWrong(task.lastRun));
      return Boolean(task.askedBy);
    },
    search: (query, task) => matchesQuery(query, task.title, task.body, agentName(task), workspaceName(task), task.askedBy),
    compare: (sort, a, b) => {
      if (sort === "created") return timeOf(b.createdAt) - timeOf(a.createdAt);
      if (sort === "name") return collator.compare(a.title, b.title);
      if (sort === "agent") return collator.compare(agentName(a), agentName(b)) || timeOf(b.updatedAt) - timeOf(a.updatedAt);
      return timeOf(b.updatedAt) - timeOf(a.updatedAt);
    },
  };
  const view = useList(TASK_LIST, list, rules, (task) => task.id);
  const { selection } = view;
  const picked = selection.picked;
  const labels: ListLabels<TaskFilter, TaskSort> = {
    filters: {
      blocked: t("tasks.filter.blocked"),
      waiting: t("tasks.filter.waiting"),
      copy: t("tasks.copyChip"),
      failed: t("list.filter.failed"),
      asked: t("tasks.filter.asked"),
    },
    sorts: { updated: t("tasks.sort.updated"), created: t("list.sort.newest"), name: t("list.sort.name"), agent: t("list.sort.agent") },
    sortChips: { created: t("list.sortShort.newest"), name: t("list.sortShort.name"), agent: t("list.sortShort.agent") },
  };
  // A running task stays where it is: it is stopped first, from its sheet.
  const movable = picked.filter((task) => task.status !== "running");
  const [movePicked, moving] = useAction(async (status: TaskStatus) => {
    for (const task of movable) if (task.status !== status) await call("tasks.setStatus", task.id, status);
    selection.setSelecting(false);
  }, t("tasks.moveFailed"));
  const [deletePicked, deleting] = useAction(async () => {
    if (!picked.length) return;
    // Deleting is undone from the toast. A running task asks first: stopping it can't be undone.
    const running = picked.filter((task) => task.status === "running").length;
    if (running) {
      const one = picked.length === 1;
      const ok = await confirm({
        title: one ? t("common.deleteNamed", { name: picked[0].title }) : t.count("tasks.deleteManyTitle", picked.length),
        body: one ? t("tasks.deleteRunningBody") : t.count("list.deleteLiveBody", running),
        confirm: t("common.stopAndDelete"),
        danger: true,
      });
      if (!ok) return;
    }
    const { gone, deleted: undo, error } = await deleteEach(picked, (task) => call("tasks.delete", task.id));
    if (gone.length === 1) deleted(t("common.deletedNamed", { name: gone[0].title }), undo[0]);
    else deletedMany(t.count("tasks.deletedMany", gone.length), undo);
    if (error) throw error;
    selection.setSelecting(false);
  }, t("tasks.deleteFailed"));
  // "new" (from Ctrl+K) opens a blank task, like the New task button.
  const open = route.taskId && route.taskId !== "new" ? list.find((task) => task.id === route.taskId) ?? null : null;
  const drafting = creating || route.taskId === "new";
  useDropMissing(tasks.loaded && !unreadable, Boolean(route.taskId) && !drafting && !open, { view: "tasks" });

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
      {toolsWanted(list.length, view.narrowed, view.changed, selection.selecting) && (
        <div className="board-tools">
          <ListBar
            list={view}
            labels={labels}
            placeholder={t("tasks.search")}
            selectTip={t("tasks.selectTip")}
            page
            actions={
              <>
                <MenuButton
                  size="sm"
                  icon={ArrowRightLeft}
                  busy={moving}
                  disabled={!movable.length}
                  tip={movable.length < picked.length ? t("tasks.moveRunningTip") : undefined}
                  items={COLUMNS.filter((column) => column.status !== "running").map((column) => ({ label: t(column.label), onSelect: () => void movePicked(column.status) }))}
                >
                  {t("tasks.moveTo")}
                </MenuButton>
                <Button size="sm" variant="danger" icon={Trash2} busy={deleting} disabled={!picked.length} onClick={() => void deletePicked()} tip={t("list.deleteSelectedTip")}>
                  {t("common.delete")}
                </Button>
              </>
            }
          />
          {view.shown.length === 0 && <NoMatch hasQuery={view.hasQuery} filters={activeFilterLabels(view, labels)} onClear={view.clear} />}
        </div>
      )}
      <LoadFailed query={tasks} />
      <UnreadableFiles kind="task" reload={tasks.reload} />
      <div className={`board${selection.selecting ? " picking" : ""}`} onKeyDown={selection.onKeyDown}>
        {COLUMNS.map((column) => {
          const items = view.shown.filter((task) => task.status === column.status);
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
                    {/* Narrowed, an empty column only means nothing here matches; unread, nothing is known. */}
                    {view.narrowed || unreadable ? "—" : column.status === "todo" ? t("tasks.empty.todo") : column.status === "running" ? t("tasks.empty.running") : column.status === "review" ? t("tasks.empty.review") : "—"}
                  </div>
                )}
                {items.map((task) => {
                  const agent = agents.find((item) => item.id === task.agentId);
                  const workspace = workspaces.find((item) => item.id === task.workspaceId);
                  const isPicked = selection.isPicked(task.id);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className={`task-card${task.lastRun?.live ? " live" : ""}`}
                      aria-pressed={selection.selecting ? isPicked : undefined}
                      draggable={!selection.selecting && task.status !== "running"}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-vibeforge-task", task.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => (selection.selecting ? selection.toggle(task.id) : go({ view: "tasks", taskId: task.id }))}
                    >
                      {selection.selecting ? (
                        <span className="task-pick">
                          <PickMark picked={isPicked} />
                          <span className="title">{task.title}</span>
                        </span>
                      ) : (
                        <span className="title">{task.title}</span>
                      )}
                      <span className="hstack wrap" style={{ gap: 5 }}>
                        {/* A missing agent or workspace is said once, by the line under the chips. */}
                        {(agent || task.blocker !== "missing-agent") && <Chip>{agent?.name ?? t("tasks.noAgent")}</Chip>}
                        {(workspace || task.blocker !== "missing-workspace") && <Chip>{workspace?.name ?? t("tasks.noWorkspace")}</Chip>}
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
                            {task.lastRun.live ? t("status.running") : changesFor(task.lastRun.changes, t) ?? t(STATUS_KEY[task.lastRun.status])} · <TimeAgo iso={task.lastRun.endedAt ?? task.lastRun.startedAt} />
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
      {(open || drafting) && (
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

/** How many of a task's runs its sheet lists; the rest are in Runs. */
const TASK_RUNS = 50;

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
  const runs = useQuery(task ? `runs:task:${task.id}` : null, ["runs"], () => call("runs.list", { taskId: task!.id, limit: TASK_RUNS }));
  // A new task starts with an agent and a workspace it is allowed in, so it can run as it stands.
  const firstAgent = agents[0];
  const [form, setForm, discard] = useDraftState(task ? `task:${task.id}` : "task:new", {
    title: task?.title ?? "",
    body: task?.body ?? "",
    agentId: task ? (task.agentId ?? "") : (firstAgent?.id ?? ""),
    workspaceId: task ? (task.workspaceId ?? "") : ((firstAgent && workspaces.find((item) => allows(firstAgent, item.path))) ?? workspaces[0])?.id ?? "",
    // A new task leaves this unset until it's switched: it then works in its own copy whenever the workspace is a git repository.
    isolated: task ? task.isolated : (undefined as boolean | undefined),
    shareCheckout: task?.shareCheckout ?? false,
  });
  const { title, body, agentId, workspaceId } = form;
  const repo = useQuery(!task && workspaceId ? `branches:${workspaceId}` : null, ["workspaces"], () => call("workspaces.branches", workspaceId));
  // A draft kept before copies existed has no `isolated` either.
  const isolated = form.isolated ?? (task ? task.isolated : Boolean(repo.data?.repo));
  const setIsolated = (next: boolean) => setForm((prev) => ({ ...prev, isolated: next }));
  // A draft kept before 2.0 has no `shareCheckout`.
  const shareCheckout = form.shareCheckout ?? false;
  const setShareCheckout = (next: boolean) => setForm((prev) => ({ ...prev, shareCheckout: next }));
  const setTitle = (next: string) => setForm((prev) => ({ ...prev, title: next }));
  const setBody = (next: string) => setForm((prev) => ({ ...prev, body: next }));
  // Picking an agent moves the workspace to one of its folders when the current one isn't.
  const setAgentId = (next: string) =>
    setForm((prev) => {
      const picked = agents.find((item) => item.id === next);
      const current = workspaces.find((item) => item.id === prev.workspaceId);
      if (!picked || task?.copy || (current && allows(picked, current.path))) return { ...prev, agentId: next };
      const allowed = workspaces.find((item) => allows(picked, item.path));
      return { ...prev, agentId: next, workspaceId: allowed?.id ?? prev.workspaceId };
    });
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
    if (inCopy) setForm((prev) => ({ ...prev, isolated: true }));
    if (dirty || inCopy) await call("tasks.save", { id: task.id, ...fields(), ...(inCopy ? { isolated: true } : {}) });
    const result = await call("tasks.execute", task.id, termSize(), now);
    if ("queued" in result) push("info", t("turns.queued", { names: result.behind.join(", ") }), t("turns.queuedBody"));
  }, t("tasks.executeFailed"));
  const [stopWaiting] = useAction(async () => task && call("tasks.cancelWait", task.id), t("tasks.stopFailed"));
  const [cont, continuing] = useAction(async () => task && call("tasks.continue", task.id, termSize()), t("tasks.continueFailed"));
  const [stop, stopping] = useAction(async () => task && call("tasks.stop", task.id), t("tasks.stopFailed"));
  const [setStatus] = useAction(async (status: TaskStatus) => task && call("tasks.setStatus", task.id, status), t("tasks.moveFailed"));
  const home = useAppInfo().data?.home ?? "";
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<CopyReview | null>(null);
  const [loadReview, loadingReview] = useAction(async (taskId: string) => {
    setReview(await call("tasks.copyDiff", taskId));
  }, t("run.diffFailed"));
  const copyPath = task?.copy?.path ?? null;
  const lastRunId = task?.lastRun?.id ?? null;
  useEffect(() => {
    setReview(null);
    if (reviewing && task?.id && copyPath && !live) void loadReview(task.id);
  }, [reviewing, task?.id, copyPath, lastRunId, live, loadReview]);
  const pick = useCopyPick(review?.files);

  const [applyCopy, applying] = useAction(async () => {
    if (!task || !workspace) return;
    const result = await call("tasks.applyCopy", task.id, pick.skip);
    const toast = applyToast(t, result, workspace.name, home);
    push(toast.tone, toast.title, toast.body);
    // The copy stays: the review shows what is left, with what just went in marked applied.
    if (reviewing && (result.stayed || result.conflicts.length || result.left)) void loadReview(task.id);
  }, t("tasks.applyFailed"));
  // Discarding happens at once, with Undo on the toast, as deleting does. Its button only shows
  // while no CLI is working in the copy, so nothing running is stopped by it.
  const [discardCopy, discarding] = useAction(async () => {
    if (!task) return;
    const result = await call("tasks.discardCopy", task.id);
    deleted(t("tasks.copyDiscarded", { title: task.title }), result);
  }, t("tasks.discardFailed"));
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

  const outside = agent && workspace && !allows(agent, workspace.path);
  const statusLabel = task ? t(COLUMNS.find((column) => column.status === task.status)?.label ?? "tasks.col.todo") : "";
  const wentWrong = task?.lastRun && task.status !== "running" && (task.lastRun.status === "failed" || task.lastRun.status === "stopped" || Boolean(task.lastRun.exitCode));
  const ended = Boolean(task && (task.status === "review" || task.status === "done") && !live);

  return (
    <Sheet onClose={onClose} width={live ? 1100 : reviewing ? 1060 : 780} label={task ? task.title : t("tasks.new")}>
      <div className="page-head">
        <KanbanSquare size={17} className="accent-text" />
        <h1 className="grow truncate">{task ? task.title : t("tasks.new")}</h1>
        {/* One chip: where the task is, unless its last run went wrong. */}
        {task?.lastRun && wentWrong ? (
          <StatusChip status={task.lastRun.status} exitCode={task.lastRun.exitCode} />
        ) : (
          task && <Chip tone={task.status === "done" ? "ok" : task.status === "review" ? "warn" : task.status === "running" ? "accent" : undefined}>{statusLabel}</Chip>
        )}
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} title={t(live ? "common.closeEscTerminal" : "common.closeEsc")} />
      </div>
      {live && (
        <div style={{ height: "46vh", display: "flex", flexDirection: "column", borderBottom: "1px solid var(--line)" }}>
          <LiveTerminal key={live.ptyId!} ptyId={live.ptyId!} autoFocus />
        </div>
      )}
      <div className="page-body vstack" style={{ gap: 14 }}>
        {task && (
          <div className="hstack wrap">
            {/* The ember button is the step that usually comes next: run a task to do, close one that's been reviewed. */}
            {task.status === "todo" && !live && (
              <Button variant="primary" icon={Play} busy={executing} disabled={(Boolean(task.blocker) && !dirty) || Boolean(task.waiting)} onClick={() => void execute()}>
                {task.runIds.length ? t("tasks.runAgain") : t("tasks.execute")}
              </Button>
            )}
            {task.status === "review" && !live && (
              <Button variant={task.copy && task.copyOwned ? undefined : "primary"} icon={CheckCircle2} onClick={() => void setStatus("done")}>
                {t("tasks.markDone")}
              </Button>
            )}
            {task.lastRun && !live && task.status !== "todo" && (
              <Button icon={RotateCcw} busy={continuing} onClick={() => void cont()} title={t("tasks.reopen")}>
                {t("common.continue")}
              </Button>
            )}
            {live && (
              <Button icon={Square} busy={stopping} onClick={() => void stop()}>
                {t("tasks.stop")}
              </Button>
            )}
            <span className="grow" />
            <MenuButton
              size="sm"
              variant="ghost"
              icon={MoreHorizontal}
              title={t("tasks.more")}
              items={[
                ...(ended
                  ? [
                      { label: t("tasks.runAgain"), icon: Play, disabled: (Boolean(task.blocker) && !dirty) || Boolean(task.waiting), onSelect: () => void execute() },
                      { label: t("tasks.backToTodo"), icon: Undo2, onSelect: () => void setStatus("todo") },
                      "sep" as const,
                    ]
                  : []),
                { label: t("tasks.delete"), icon: Trash2, danger: true, onSelect: () => void remove() },
              ]}
            />
          </div>
        )}
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
        {task?.askedBy && <Notice icon={MessagesSquare}>{t("tasks.askedBy", { name: task.askedBy })}</Notice>}
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
                <Button size="sm" variant="ghost" icon={X} busy={discarding} onClick={() => void discardCopy()}>
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
                  <Button size="sm" icon={FileDiff} pressed={reviewing} onClick={() => setReviewing((was) => !was)}>
                    {t("orch.review")}
                  </Button>
                  <CopyApplyButton pick={pick} workspace={workspace?.name ?? ""} tip={t("tasks.applyTip")} busy={applying} onApply={() => void applyCopy()} />
                  <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} onClick={() => void discardCopy()}>
                    {t("tasks.discardCopy")}
                  </Button>
                </>
              )}
            </div>
          </Notice>
        )}
        {reviewing && task?.copy && task.copyOwned && !live && (
          loadingReview && review === null ? (
            <Skeleton rows={4} />
          ) : review !== null ? (
            <DiffReview text={review.patch} reviewKey={`task:${task.id}`} workspaceId={task.workspaceId} folder={task.copy.path} selection={pick.selection} />
          ) : null
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
              {runs.data!.length >= TASK_RUNS && <div className="list-cut faint">{t("runs.cutElsewhere", { count: TASK_RUNS })}</div>}
            </div>
          </>
        )}
      </div>
      <div className="sheet-foot">
        <span className="faint grow">{task && dirty ? t("common.unsaved") : ""}</span>
        {task && dirty && (
          <Button variant="ghost" icon={Undo2} onClick={discard}>
            {t("common.discard")}
          </Button>
        )}
        {!task && (
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        )}
        <Button variant={task ? undefined : "primary"} icon={Save} busy={saving} disabled={!dirty || !title.trim()} kbd={shortcutKeys("form.save")} tip={task ? t("common.save") : t("tasks.create")} onClick={() => void save()}>
          {task ? t("common.save") : t("tasks.create")}
        </Button>
      </div>
    </Sheet>
  );
}

/** Whether an agent may work in a folder: one of its places, or inside one. */
function allows(agent: { places: string[] }, path: string): boolean {
  return agent.places.some((place) => path === place || path.startsWith(`${place}/`));
}
