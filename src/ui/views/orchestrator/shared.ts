import { createContext, useMemo } from "react";
import type { LiveSession, OrchestratorStep, StepIssue, Workspace } from "../../../shared/api.js";
import { plannedId, type PlanContext } from "../../../shared/orchestrator.js";
import { useAgents, useChats, useEngines, useLive, useOrchestrator, useRoutines, useSkills, useTasks, useWorkspaces } from "../../api.js";
import type { Key } from "../../i18n/index.js";

/** Put the bar away when a chip inside it jumps to a pane in Code. */
export const LeaveBar = createContext<(() => void) | null>(null);

/** A coding CLI: a run VibeForge started, or one typed into a shell. */
export function isCodingCli(session: LiveSession): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

/** What a step is checked against, from what the window already knows. */
export function usePlanContext(): { context: PlanContext; ready: boolean } {
  const workspaces = useWorkspaces().data?.workspaces;
  const engines = useEngines().data;
  const live = useLive().data;
  const copies = useOrchestrator().data?.copies;
  const agents = useAgents().data;
  const skills = useSkills().data;
  const tasks = useTasks().data;
  const routines = useRoutines().data;
  const chats = useChats(undefined).data;
  const ready = workspaces !== undefined && engines !== undefined && live !== undefined;
  const context = useMemo(() => {
    const names = new Map((workspaces ?? []).map((item) => [item.id, item.name]));
    return {
      workspaces: (workspaces ?? []).map((item) => ({ id: item.id, name: item.name, folder: item.path, git: true })),
      engines: (engines ?? []).map((item) => ({ id: item.id, label: item.label, available: item.available, bin: item.bin })),
      running: (live ?? [])
        .filter(isCodingCli)
        .map((item) => ({
          id: item.ptyId,
          engine: item.program || item.title,
          workspace: (item.workspaceId && names.get(item.workspaceId)) || item.title,
          folder: item.cwd,
          working: Boolean(item.working),
          orchestrated: Boolean(item.orchestrated),
        })),
      copies: (copies ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        branch: item.branch,
        workspace: (item.workspaceId && names.get(item.workspaceId)) || item.workspaceId,
      })),
      ...(agents ? { agents: agents.map((a) => ({ id: a.id, name: a.name, engine: a.engine, places: a.places, skills: a.skills })) } : {}),
      ...(skills ? { skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description })) } : {}),
      ...(tasks
        ? {
            tasks: tasks.map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
              ...(item.agentId ? { agentId: item.agentId } : {}),
              ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
            })),
          }
        : {}),
      ...(routines ? { routines: routines.map((r) => ({ id: r.id, name: r.name, schedule: r.description, enabled: r.enabled, agentId: r.agentId })) } : {}),
      ...(chats ? { chats: chats.map((c) => ({ id: c.id, title: c.title, engine: c.engine, agentId: c.agentId, live: c.live })) } : {}),
    };
  }, [workspaces, engines, live, copies, agents, skills, tasks, routines, chats]);
  return { context, ready };
}

const ISSUE_KEY: Record<StepIssue, Key> = {
  workspace: "orch.issue.workspace",
  engine: "orch.issue.engine",
  engineMissing: "orch.issue.engineMissing",
  target: "orch.issue.target",
  prompt: "orch.issue.prompt",
  effort: "orch.issue.effort",
  folder: "orch.issue.folder",
  copy: "orch.issue.copy",
  schedule: "orch.issue.schedule",
  name: "orch.issue.name",
};

export function issueKey(step: OrchestratorStep, issue: StepIssue): Key {
  if (step.kind === "routine" && issue === "target") return "orch.issue.routine";
  if (step.kind === "routine" && issue === "engine") return "orch.issue.agent";
  if (step.kind === "task" && issue === "target") return "orch.issue.task";
  if (step.kind === "task" && issue === "engine") return "orch.issue.agent";
  if (step.kind === "agent" && issue === "target") return "orch.issue.agent";
  if (step.kind === "skill" && issue === "target") return "orch.issue.skill";
  if (step.kind === "skill" && issue === "engine") return "orch.issue.agent";
  if (step.kind === "chat" && issue === "target") return "orch.issue.chat";
  if (step.kind === "run" && issue === "target") return "orch.issue.run";
  if (step.kind === "run" && issue === "engine") return "orch.issue.agent";
  if (step.kind === "show" && issue === "workspace") return "orch.issue.show";
  return ISSUE_KEY[issue];
}

/** What a non-start step will do. */
export function otherStepKey(step: OrchestratorStep): Key {
  const act = (step.action || "").trim().toLowerCase();
  if (step.kind === "lookup") return "orch.lookup";
  if (step.kind === "inspect") return "orch.inspect";
  if (step.kind === "shell") return "orch.shell";
  if (step.kind === "key") return "orch.key";
  if (step.kind === "workbench") return "orch.workbench";
  if (step.kind === "settings") return "orch.settings";
  if (step.kind === "workspace") {
    if (act === "rename") return "orch.workspaceRename";
    if (act === "remove") return "orch.workspaceRemove";
    if (act === "move") return "orch.workspaceMove";
    return "orch.makeWorkspace";
  }
  if (step.kind === "agent") {
    if (act === "create") return "orch.agentNew";
    if (act === "delete") return "orch.agentDelete";
    if (act.startsWith("memory-")) return "orch.agentMemory";
    return "orch.agentEdit";
  }
  if (step.kind === "skill") {
    if (act === "create") return "orch.skillNew";
    if (act === "delete") return "orch.skillDelete";
    return "orch.skillEdit";
  }
  if (step.kind === "chat") {
    if (act === "create") return "orch.chatNew";
    if (act === "send") return "orch.chatSend";
    if (act === "delete") return "orch.chatDelete";
    return "orch.chat";
  }
  if (step.kind === "run") return act === "tidy" ? "orch.runTidy" : "orch.run";
  if (step.kind === "talk") return "orch.talk";
  if (step.kind === "task") {
    if (act === "edit") return "orch.taskEdit";
    if (act === "delete") return "orch.taskDelete";
    if (act === "status") return "orch.taskStatus";
    if (act === "stop") return "orch.taskStop";
    if (act === "continue") return "orch.taskContinue";
    if (act === "handoff") return "orch.taskHandoff";
    if (act === "apply") return "orch.applyStep";
    if (act === "discard") return "orch.discard";
    return act === "create" || act === "create-run" || (!act && Boolean(step.name)) ? "orch.taskNew" : "orch.taskRun";
  }
  if (act === "create") return "orch.routineNew";
  if (act === "edit") return "orch.routineEdit";
  if (act === "delete") return "orch.routineDelete";
  const promptAct = step.prompt.trim().toLowerCase();
  return act === "enable" || promptAct === "enable" ? "orch.routineOn" : act === "disable" || promptAct === "disable" ? "orch.routineOff" : "orch.routineRun";
}

export function sessionLabel(session: LiveSession | undefined, workspaces: Workspace[]): string {
  if (!session) return "";
  const name = session.program || session.title.split(" · ")[0] || session.title;
  const where = workspaces.find((item) => item.id === session.workspaceId)?.name;
  return where ? `${name} · ${where}` : session.title;
}

export function shortBranch(branch: string): string {
  return branch.replace(/^vibeforge\//, "");
}

export { plannedId };
