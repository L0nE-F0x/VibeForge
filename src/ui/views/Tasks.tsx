import { CheckCircle2, FolderPlus, KanbanSquare, Play, Plus, RotateCcw, Save, Square, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import type { TaskStatus, TaskView } from "../../shared/api.js";
import { call, useAgents, useQuery, useSettings, useTasks, useWorkspaces } from "../api.js";
import { LiveTerminal } from "../components/Terminal.js";
import { Button, Chip, Field, Input, Notice, Select, Sheet, StatusChip, TextArea, TimeAgo } from "../components/ui.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { useSaveShortcut } from "./Agents.js";
import { RunRow } from "./Home.js";

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "To do" },
  { status: "running", label: "Running" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

const BLOCKERS: Record<NonNullable<TaskView["blocker"]>, string> = {
  "missing-agent": "No agent assigned",
  "missing-workspace": "No workspace",
  "outside-places": "Workspace is outside the agent's folders",
  "engine-missing": "Agent's engine is not on PATH",
};

export function TasksView({ route }: { route: Extract<Route, { view: "tasks" }> }) {
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
      fail(error, "Could not move the task");
    }
  };

  return (
    <div className="main">
      <div className="page-head">
        <KanbanSquare size={17} className="accent-text" />
        <div className="vstack grow" style={{ gap: 0 }}>
          <h1>Tasks</h1>
          <span className="sub">Writing or assigning a task never starts anything. Execute does.</span>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
          New task
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
                {column.label}
                <span className="faint">{items.length}</span>
                <span className="grow" />
                {column.status === "todo" && <Button size="sm" variant="ghost" icon={Plus} title="New task" onClick={() => setCreating(true)} />}
              </div>
              <div className="column-body">
                {items.length === 0 && (
                  <div className="faint" style={{ padding: "8px 4px", fontSize: "var(--fs-sm)" }}>
                    {column.status === "todo" ? "Nothing queued." : column.status === "running" ? "Nothing running." : column.status === "review" ? "Finished runs land here." : "—"}
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
                        <Chip>{agent?.name ?? "No agent"}</Chip>
                        <Chip>{workspace?.name ?? "No workspace"}</Chip>
                      </span>
                      {task.status === "todo" && task.blocker && <span style={{ color: "var(--yellow)", fontSize: "var(--fs-sm)" }}>{BLOCKERS[task.blocker]}</span>}
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
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const fontSize = useSettings().data?.terminalFontSize ?? 13;
  // The live terminal fills the top of the sheet: 1100px wide at most, 46% of the window tall.
  const termSize = () => ({
    cols: Math.floor((Math.min(1100, window.innerWidth - 120) - 14) / (fontSize * 0.6)),
    rows: Math.floor((window.innerHeight * 0.46 - 14) / Math.ceil(fontSize * 1.32 * 1.18)),
  });
  const runs = useQuery(task ? `runs:task:${task.id}` : null, ["runs"], () => call("runs.list", { taskId: task!.id, limit: 50 }));
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [agentId, setAgentId] = useState(task?.agentId ?? agents[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? workspaces[0]?.id ?? "");

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setBody(task.body);
    setAgentId(task.agentId ?? "");
    setWorkspaceId(task.workspaceId ?? "");
  }, [task?.id]);

  const dirty = !task || title !== task.title || body !== task.body || (agentId || null) !== task.agentId || (workspaceId || null) !== task.workspaceId;
  const agent = agents.find((item) => item.id === agentId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const live = task?.lastRun?.live ? task.lastRun : null;

  const [save, saving] = useAction(async () => {
    const saved = await call("tasks.save", { id: task?.id, title, body, agentId: agentId || null, workspaceId: workspaceId || null });
    if (!task) onCreated(saved);
    else push("success", "Task saved");
    return saved;
  }, "Could not save the task");
  const [execute, executing] = useAction(async () => {
    if (!task) return;
    if (dirty) await call("tasks.save", { id: task.id, title, body, agentId: agentId || null, workspaceId: workspaceId || null });
    await call("tasks.execute", task.id, termSize());
  }, "Could not execute");
  const [cont, continuing] = useAction(async () => task && call("tasks.continue", task.id, termSize()), "Could not continue");
  const [stop, stopping] = useAction(async () => task && call("tasks.stop", task.id), "Could not stop");
  const [setStatus] = useAction(async (status: TaskStatus) => task && call("tasks.setStatus", task.id, status), "Could not move the task");
  const [allowFolder, allowing] = useAction(async () => {
    if (!agent || !workspace) return;
    await call("agents.save", { ...agent, places: [...agent.places, workspace.path] });
    push("success", `${agent.name} may now work in ${workspace.name}`);
  }, "Could not add the folder");
  const [remove] = useAction(async () => {
    if (!task) return;
    const ok = await confirm({ title: `Delete "${task.title}"?`, body: "Its runs stay in Runs.", confirm: "Delete task", danger: true });
    if (!ok) return;
    await call("tasks.delete", task.id);
    onClose();
  }, "Could not delete the task");
  useSaveShortcut(() => void save(), dirty && !saving && Boolean(title.trim()));

  const outside = agent && workspace && !agent.places.some((place) => workspace.path === place || workspace.path.startsWith(`${place}/`));

  return (
    <Sheet onClose={onClose} width={live ? 1100 : 780}>
      <div className="page-head">
        <KanbanSquare size={17} className="accent-text" />
        <h1 className="grow truncate">{task ? task.title : "New task"}</h1>
        {task?.lastRun && task.status !== "running" && <StatusChip status={task.lastRun.status} exitCode={task.lastRun.exitCode} />}
        {task && <Chip tone={task.status === "done" ? "ok" : task.status === "review" ? "warn" : task.status === "running" ? "accent" : undefined}>{COLUMNS.find((column) => column.status === task.status)?.label}</Chip>}
        <Button variant="ghost" size="sm" icon={X} onClick={onClose} title="Close (Esc)" />
      </div>
      {live && (
        <div style={{ height: "46vh", display: "flex", flexDirection: "column", borderBottom: "1px solid var(--line)" }}>
          <LiveTerminal key={live.ptyId!} ptyId={live.ptyId!} autoFocus />
        </div>
      )}
      <div className="page-body vstack" style={{ gap: 14 }}>
        <div className="hstack wrap">
          {task && (task.status === "todo" || task.status === "review" || task.status === "done") && !live && (
            <Button variant="primary" icon={Play} busy={executing} disabled={Boolean(task.blocker) && !dirty} onClick={() => void execute()}>
              {task.runIds.length ? "Run again" : "Execute"}
            </Button>
          )}
          {task && task.lastRun && !live && task.status !== "todo" && (
            <Button icon={RotateCcw} busy={continuing} onClick={() => void cont()} title="Reopen the engine's latest session in the workspace">
              Continue
            </Button>
          )}
          {live && (
            <Button icon={Square} busy={stopping} onClick={() => void stop()}>
              Stop
            </Button>
          )}
          {task?.status === "review" && (
            <Button icon={CheckCircle2} onClick={() => void setStatus("done")}>
              Mark done
            </Button>
          )}
          {task && (task.status === "review" || task.status === "done") && (
            <Button variant="ghost" icon={Undo2} onClick={() => void setStatus("todo")}>
              Back to To do
            </Button>
          )}
          <span className="grow" />
          <Button icon={Save} busy={saving} disabled={!dirty || !title.trim()} onClick={() => void save()}>
            {task ? "Save" : "Create task"}
          </Button>
          {task && <Button variant="danger" icon={Trash2} onClick={() => void remove()} title="Delete task" />}
        </div>
        {task?.blocker && !live && task.status !== "running" && (
          <Notice tone="warn">
            <div className="hstack wrap">
              <span className="grow">{BLOCKERS[task.blocker]}. Execute needs an agent, a workspace, and that workspace inside the agent's allowed folders.</span>
              {task.blocker === "outside-places" && outside && (
                <Button size="sm" icon={FolderPlus} busy={allowing} onClick={() => void allowFolder()}>
                  Allow {agent!.name} in {workspace!.name}
                </Button>
              )}
            </div>
          </Notice>
        )}
        <Field label="Title">
          <Input autoFocus={!task} value={title} placeholder="What should be different when this is done?" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Details" hint="Handed to the agent as the run's prompt, after its brief, memory and skills.">
          <TextArea value={body} style={{ minHeight: 150 }} placeholder="Context, the outcome you want, how to verify it, and what not to touch." onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Agent">
            <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">No agent yet</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Workspace" hint={outside ? `Not one of ${agent!.name}'s allowed folders.` : undefined}>
            <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">No workspace yet</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {task && (runs.data?.length ?? 0) > 0 && (
          <>
            <div className="section-title">Runs</div>
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
