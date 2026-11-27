import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effortForModel } from "../../shared/launch-options.js";
import { isDirectory } from "../fsx.js";
import {
  branchFromPrompt,
  folderNameOk,
  formatScheduleBrief,
  isClearWord,
  normalizeAgentAction,
  normalizeChatAction,
  normalizeRoutineStepAction,
  normalizeRunAction,
  normalizeSkillAction,
  normalizeTalkAction,
  normalizeTaskStepAction,
  normalizeWorkspaceAction,
  parseAgentTier,
  parseOptions,
  parseRoutineSchedule,
  parseTaskStatus,
  parseWorkbenchAction,
  PLANNED_PREFIX,
  plannedId,
  resolveSettingsStep,
  type OrchestratorStep,
  type OrchestratorTurn,
  type PlanContext,
} from "../orchestrator.js";
import { taskPrompt } from "../preamble.js";
import { MEMORY_STARTER } from "../store/library.js";
import type { Settings } from "../types.js";
import { isGitRepo } from "../vcs.js";
import type { ChatDesk } from "./chats.js";
import type { ServiceCore } from "./core.js";
import type { LibraryDesk } from "./library.js";
import type { MessageDesk } from "./messages.js";
import type { MaestroCopies } from "./orchestrator-copies.js";
import { expandHome, gitIn, hasCommit, isInside, START_SIZE, substitutePlannedId, tildify, waitsTurn } from "./orchestrator-utils.js";
import type { RoutineDesk } from "./routines.js";
import type { RunDesk } from "./runs.js";
import type { TaskDesk } from "./tasks.js";
import type { WorkspaceDesk } from "./workspaces.js";

export interface EntityStepDeps {
  core: ServiceCore;
  workspaces: WorkspaceDesk;
  messages: MessageDesk;
  tasks?: TaskDesk;
  routines?: RoutineDesk;
  runs?: RunDesk;
  library?: LibraryDesk;
  chats?: ChatDesk;
  copies: MaestroCopies;
  context: (fresh?: boolean) => Promise<PlanContext>;
  planner: () => string;
  projectsFolder: () => string;
  updateWorkspacesKey: () => void;
  hasCall: () => boolean;
}

function resolveAgentPlace(deps: EntityStepDeps, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
  const ws = deps.core.workspaceById(trimmed);
  if (ws) return path.resolve(ws.path);
  return path.resolve(expandHome(trimmed));
}

async function syncOption(deps: EntityStepDeps, kind: "agent" | "skill", id: string, opts: ReturnType<typeof parseOptions>): Promise<string> {
  const on = opts.bool("sync");
  if (on === undefined) return "";
  if (!deps.core.options.host.syncLibrary) throw new Error("Sync is not running. Turn it on in Settings.");
  await deps.core.options.host.syncLibrary(kind, id, on);
  return on ? " It syncs with your other machines now." : " It no longer syncs with your other machines.";
}

async function makeWorkspace(deps: EntityStepDeps, step: OrchestratorStep): Promise<string> {
  const name = (step.name ?? "").trim();
  if (!folderNameOk(name)) throw new Error("A new workspace needs a name that isn't a path.");
  const folder = path.resolve(expandHome((step.folder ?? "").trim()));
  if (!(step.folder ?? "").trim() || folder === path.parse(folder).root || folder === os.homedir()) throw new Error("Choose a folder for the new workspace.");
  if (fs.existsSync(folder) && !isDirectory(folder)) throw new Error(`There's a file at ${tildify(folder)}, not a folder.`);
  const fresh = !fs.existsSync(folder) || fs.readdirSync(folder).length === 0;
  fs.mkdirSync(folder, { recursive: true });
  // Only a folder that is new (or was empty) is made a repository: an existing one stays as it is.
  if (step.git && fresh && !(await isGitRepo(folder).catch(() => false))) {
    const made = await gitIn(["init", "-q"], folder);
    if (made.code !== 0) throw new Error(`Could not make ${tildify(folder)} a git repository: ${made.stderr.trim().split("\n")[0] || "git failed"}`);
  }
  const known = deps.core.store.readWorkspaces().workspaces.find((item) => path.resolve(item.path) === folder);
  if (known) return known.id;
  const id = deps.workspaces.addQuietly(folder, name);
  deps.updateWorkspacesKey();
  return id;
}

export async function carryOutWorkspaceStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
  const action = normalizeWorkspaceAction(step.action);
  if (!action || action === "create") {
    const workspaceId = await makeWorkspace(deps, step);
    step.openedWorkspaceId = workspaceId;
    const created = deps.core.workspaceById(workspaceId);
    substitutePlannedId(turn.steps, plannedId(step.id), workspaceId, created?.path);
    return;
  }
  const wsId = step.workspaceId || step.target;
  if (!wsId || wsId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
  const ws = deps.core.workspaceById(wsId);
  if (!ws) throw new Error("That workspace is gone.");
  if (action === "rename") {
    const nextName = (step.name || step.prompt || "").trim();
    if (!folderNameOk(nextName)) throw new Error("A new workspace needs a name that isn't a path.");
    deps.workspaces.updateWorkspace(ws.id, { name: nextName });
    step.openedWorkspaceId = ws.id;
    step.result = `Renamed to ${nextName}.`;
    return;
  }
  if (action === "remove") {
    const deleted = await deps.workspaces.removeWorkspace(ws.id);
    step.undo = deleted.undo;
    step.result = `Removed workspace ${ws.name}.`;
    return;
  }
  if (action === "move") {
    const list = deps.workspaces.listWorkspaces().workspaces;
    const cur = list.findIndex((item) => item.id === ws.id);
    if (cur < 0) throw new Error("That workspace is gone.");
    const pos = (step.status || step.prompt || parseOptions(step.options).str("index") || "").trim().toLowerCase();
    let toIndex = cur;
    if (pos === "top" || pos === "first") toIndex = 0;
    else if (pos === "bottom" || pos === "last") toIndex = Math.max(0, list.length - 1);
    else if (pos === "up") toIndex = Math.max(0, cur - 1);
    else if (pos === "down") toIndex = Math.min(list.length - 1, cur + 1);
    else if (/^\d+$/.test(pos)) toIndex = Math.max(0, Math.min(list.length - 1, Number(pos) - 1));
    else throw new Error("Say where to move the workspace (top, bottom, up, down, or a position number).");
    deps.workspaces.moveWorkspace(ws.id, toIndex);
    step.openedWorkspaceId = ws.id;
    step.result = `Moved ${ws.name} to position ${toIndex + 1}.`;
    return;
  }
  throw new Error("Unsupported action.");
}

export async function carryOutAgentStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
  if (!deps.library) throw new Error("That agent no longer exists.");
  const action = normalizeAgentAction(step.action, Boolean(step.target));
  if (!action) throw new Error("Unsupported action.");
  if (action === "create") {
    const places = (step.places ?? []).map((p) => resolveAgentPlace(deps, p)).filter(Boolean);
    const skills = (step.skills ?? []).filter((id) => !id.startsWith(PLANNED_PREFIX));
    const opts = parseOptions(step.options);
    const allowRoutines = opts.bool("allowRoutines") ?? opts.bool("routines") ?? true;
    const goodAt = (step.description?.trim() || opts.str("goodAt") || "").trim();
    const tier = parseAgentTier(opts.str("tier")) ?? "";
    const saved = deps.library.saveAgent({
      name: (step.name ?? "").trim(),
      engine: step.engineId,
      brief: step.prompt.trim(),
      places,
      skills,
      allowRoutines,
      goodAt,
      tier,
    });
    step.target = saved.id;
    step.result = `Created agent ${saved.name}.${await syncOption(deps, "agent", saved.id, opts)}`;
    substitutePlannedId(turn.steps, plannedId(step.id), saved.id);
    return;
  }
  if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
  if (action === "delete") {
    const deleted = await deps.library.deleteAgent(step.target);
    step.undo = deleted.undo;
    step.result = "Deleted agent.";
    return;
  }
  if (action === "memory-clear") {
    deps.library.writeMemory(step.target, MEMORY_STARTER);
    step.result = "Cleared memory.md.";
    return;
  }
  if (action === "memory-set") {
    const text = step.prompt.trim();
    if (!text) throw new Error("Type something to send.");
    deps.library.writeMemory(step.target, `${text}\n`);
    step.result = "Updated memory.md.";
    return;
  }
  if (action === "memory-append") {
    const addition = step.prompt.trim();
    if (!addition) throw new Error("Type something to send.");
    const prev = deps.library.readMemory(step.target);
    const next = prev.trimEnd() ? `${prev.trimEnd()}\n\n${addition}\n` : `${addition}\n`;
    deps.library.writeMemory(step.target, next);
    step.result = "Appended to memory.md.";
    return;
  }
  const existing = deps.library.getAgent(step.target);
  if (!existing) throw new Error("That agent no longer exists.");
  if (action === "add-folder") {
    const added = (step.places ?? []).map((p) => resolveAgentPlace(deps, p)).filter(Boolean);
    const places = [...new Set([...existing.places, ...added])];
    deps.library.saveAgent({ ...existing, places });
    step.result = `Added folder to ${existing.name}.`;
    return;
  }
  if (action === "remove-folder") {
    const drop = new Set((step.places ?? []).map((p) => resolveAgentPlace(deps, p)));
    const places = existing.places.filter((p) => !drop.has(path.resolve(p)));
    if (!places.length) throw new Error("Add at least one allowed folder.");
    deps.library.saveAgent({ ...existing, places });
    step.result = `Removed folder from ${existing.name}.`;
    return;
  }
  if (action === "add-skill") {
    const toAdd = (step.skills ?? []).filter((id) => !id.startsWith(PLANNED_PREFIX));
    const skills = [...new Set([...existing.skills, ...toAdd])];
    deps.library.saveAgent({ ...existing, skills });
    step.result = `Added skill to ${existing.name}.`;
    return;
  }
  if (action === "remove-skill") {
    const drop = new Set(step.skills ?? []);
    const skills = existing.skills.filter((id) => !drop.has(id));
    deps.library.saveAgent({ ...existing, skills });
    step.result = `Removed skill from ${existing.name}.`;
    return;
  }
  const opts = parseOptions(step.options);
  const places = step.places?.length ? step.places.map((p) => resolveAgentPlace(deps, p)).filter(Boolean) : existing.places;
  const skills = step.skills?.length ? step.skills.filter((id) => !id.startsWith(PLANNED_PREFIX)) : isClearWord(opts.str("skills")) ? [] : existing.skills;
  const allowRoutines = opts.bool("allowRoutines") ?? opts.bool("routines") ?? existing.allowRoutines;
  const goodAt =
    step.description !== undefined
      ? isClearWord(step.description)
        ? ""
        : step.description.trim()
      : opts.has("goodAt")
        ? isClearWord(opts.str("goodAt"))
          ? ""
          : opts.str("goodAt")
        : existing.goodAt;
  const tier = opts.has("tier") ? (parseAgentTier(opts.str("tier")) ?? existing.tier) : existing.tier;
  const saved = deps.library.saveAgent({
    id: existing.id,
    name: step.name?.trim() || existing.name,
    engine: step.engineId || existing.engine,
    brief: step.prompt.trim() || existing.brief,
    places,
    skills,
    allowRoutines,
    goodAt,
    tier,
  });
  step.result = `Updated agent ${saved.name}.${await syncOption(deps, "agent", saved.id, opts)}`;
}

export async function carryOutSkillStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
  if (!deps.library) throw new Error("That skill no longer exists.");
  const action = normalizeSkillAction(step.action, Boolean(step.target));
  if (!action) throw new Error("Unsupported action.");
  if (action === "create") {
    const saved = deps.library.saveSkill({
      name: (step.name ?? "").trim(),
      description: step.description ?? "",
      body: step.prompt,
    });
    if (step.agents?.length) {
      deps.library.setSkillAgents(
        saved.id,
        step.agents.filter((id) => !id.startsWith(PLANNED_PREFIX)),
      );
    }
    step.target = saved.id;
    step.result = `Created skill ${saved.name}.${await syncOption(deps, "skill", saved.id, parseOptions(step.options))}`;
    substitutePlannedId(turn.steps, plannedId(step.id), saved.id);
    return;
  }
  if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
  if (action === "delete") {
    const deleted = deps.library.deleteSkill(step.target);
    step.undo = deleted.undo;
    step.result = "Deleted skill.";
    return;
  }
  const existing = deps.core.store.getSkill(step.target);
  if (!existing) throw new Error("That skill no longer exists.");
  if (action === "edit") {
    const saved = deps.library.saveSkill({
      id: existing.id,
      name: step.name?.trim() || existing.name,
      description: step.description !== undefined ? step.description : existing.description,
      body: step.prompt.trim() ? step.prompt : existing.body,
    });
    if (step.agents?.length) {
      deps.library.setSkillAgents(
        saved.id,
        step.agents.filter((id) => !id.startsWith(PLANNED_PREFIX)),
      );
    }
    step.result = `Updated skill ${saved.name}.${await syncOption(deps, "skill", saved.id, parseOptions(step.options))}`;
    return;
  }
  if (action === "attach") {
    const current = deps.library.listAgents().filter((a) => a.skills.includes(existing.id)).map((a) => a.id);
    const next = [...new Set([...current, ...(step.agents ?? []).filter((id) => !id.startsWith(PLANNED_PREFIX))])];
    deps.library.setSkillAgents(existing.id, next);
    step.result = `Attached ${existing.name}.`;
    return;
  }
  if (action === "detach") {
    const drop = new Set(step.agents ?? []);
    const next = deps.library.listAgents().filter((a) => a.skills.includes(existing.id) && !drop.has(a.id)).map((a) => a.id);
    deps.library.setSkillAgents(existing.id, next);
    step.result = `Detached ${existing.name}.`;
    return;
  }
  const opts = parseOptions(step.options);
  const next = isClearWord(opts.str("agents")) ? [] : (step.agents ?? []).filter((id) => !id.startsWith(PLANNED_PREFIX));
  deps.library.setSkillAgents(existing.id, next);
  step.result = next.length ? `Updated agents for ${existing.name}.` : `Cleared agents from ${existing.name}.`;
}

export async function carryOutRoutineStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
  if (!deps.routines) throw new Error("That routine no longer exists.");
  const hasCreateFields = Boolean(step.schedule?.trim() || step.name?.trim() || step.agentId || step.taskId);
  const action = normalizeRoutineStepAction(step.action, step.prompt, Boolean(step.target), hasCreateFields);
  if (!action) throw new Error("Unsupported action.");

  if (action === "create") {
    if (step.taskId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const task = step.taskId ? deps.core.store.getTask(step.taskId) : null;
    if (step.taskId && !task) throw new Error("That task no longer exists.");
    const agentId = step.agentId || task?.agentId || "";
    if (!agentId || agentId.startsWith(PLANNED_PREFIX)) throw new Error("Pick an agent for the routine.");
    const schedule = parseRoutineSchedule(step.schedule);
    if (!schedule) throw new Error("The schedule is not valid.");
    const name = (step.name || task?.title || "").trim();
    const extra = step.prompt.trim();
    const prompt = task ? (extra ? `${taskPrompt(task.title, task.body)}\n\n${extra}` : taskPrompt(task.title, task.body)) : extra;
    const opts = parseOptions(step.options);
    const saved = deps.routines.saveRoutine({
      name,
      agentId,
      schedule,
      prompt,
      enabled: opts.bool("enabled") ?? true,
      notify: opts.bool("notify") ?? true,
      shareCheckout: opts.bool("shareCheckout") ?? false,
    });
    step.target = saved.id;
    step.result = `Created routine ${saved.name} (${formatScheduleBrief(saved.schedule)}).`;
    substitutePlannedId(turn.steps, plannedId(step.id), saved.id);
    return;
  }

  if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
  if (action === "edit") {
    const existing = deps.core.store.getRoutine(step.target);
    if (!existing) throw new Error("That routine no longer exists.");
    if (step.taskId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const task = step.taskId ? deps.core.store.getTask(step.taskId) : null;
    if (step.taskId && !task) throw new Error("That task no longer exists.");
    if (step.agentId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const schedule = step.schedule?.trim() ? parseRoutineSchedule(step.schedule) : existing.schedule;
    if (!schedule) throw new Error("The schedule is not valid.");
    const opts = parseOptions(step.options);
    const extra = step.prompt.trim();
    const prompt = task
      ? extra
        ? `${taskPrompt(task.title, task.body)}\n\n${extra}`
        : taskPrompt(task.title, task.body)
      : extra || existing.prompt;
    const saved = deps.routines.saveRoutine({
      id: existing.id,
      name: step.name?.trim() || existing.name,
      agentId: step.agentId || task?.agentId || existing.agentId,
      schedule,
      prompt,
      enabled: opts.bool("enabled") ?? existing.enabled,
      notify: opts.bool("notify") ?? existing.notify,
      shareCheckout: opts.bool("shareCheckout") ?? existing.shareCheckout,
    });
    step.result = `Updated routine ${saved.name}.`;
    return;
  }
  if (action === "delete") {
    const deleted = deps.routines.deleteRoutine(step.target);
    step.undo = deleted.undo;
    step.result = "Deleted routine.";
    return;
  }
  if (action === "enable" || action === "disable") {
    deps.routines.setRoutineEnabled(step.target, action === "enable");
    step.result = action === "enable" ? "Enabled routine." : "Paused routine.";
    return;
  }
  if (action === "cancel-wait") {
    deps.routines.cancelWait(step.target);
    step.result = "Cancelled routine wait.";
    return;
  }
  const launched = await deps.routines.runRoutineNow(step.target, START_SIZE, action === "run-now");
  if ("ptyId" in launched) {
    step.ptyId = launched.ptyId;
    step.runId = launched.runId;
  } else step.result = waitsTurn(launched.behind);
}

export async function carryOutTaskStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep, formatApply: (res: Awaited<ReturnType<TaskDesk["applyCopy"]>>, label: string) => string): Promise<void> {
  if (!deps.tasks) throw new Error("That task no longer exists.");
  const action = normalizeTaskStepAction(step.action, Boolean(step.target), Boolean(step.workspaceId || step.agentId || step.name || step.prompt));
  if (!action) throw new Error("Unsupported action.");

  if (action === "handoff") {
    if (!step.agentId || step.agentId.startsWith(PLANNED_PREFIX)) throw new Error("Assign an agent first.");
    const created = deps.tasks.handOff(step.target, step.agentId);
    step.target = created.id;
    step.result = `Handed off as task "${created.title}".`;
    substitutePlannedId(turn.steps, plannedId(step.id), created.id);
    return;
  }
  if (action === "create" || action === "create-run") {
    if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
    if (step.agentId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const workspace = step.workspaceId ? deps.core.workspaceById(step.workspaceId) : null;
    const opts = parseOptions(step.options);
    const explicitIsolated = opts.bool("isolated");
    const isolated =
      explicitIsolated !== undefined
        ? explicitIsolated
        : Boolean(workspace) && (await isGitRepo(workspace?.path ?? "").catch(() => false)) && (await hasCommit(workspace?.path ?? ""));
    const shareCheckout = opts.bool("shareCheckout") ?? false;
    const saved = deps.tasks.saveTask({
      title: step.name?.trim() || branchFromPrompt(step.prompt),
      body: step.prompt,
      agentId: step.agentId || null,
      workspaceId: step.workspaceId || null,
      isolated,
      shareCheckout,
    });
    step.target = saved.id;
    substitutePlannedId(turn.steps, plannedId(step.id), saved.id);
    if (action === "create") {
      step.result = `Added task "${saved.title}".`;
      return;
    }
    const launched = await deps.tasks.executeTask(saved.id, START_SIZE);
    if ("ptyId" in launched) {
      step.ptyId = launched.ptyId;
      step.runId = launched.runId;
      deps.messages.adoptStarted(saved.id, launched.ptyId);
    } else step.result = waitsTurn(launched.behind);
    return;
  }

  if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
  if (action === "edit") {
    const existing = deps.core.store.getTask(step.target);
    if (!existing) throw new Error("That task no longer exists.");
    if (step.workspaceId.startsWith(PLANNED_PREFIX)) throw new Error("That workspace wasn't made.");
    if (step.agentId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const opts = parseOptions(step.options);
    const clearAgent = isClearWord(opts.str("agent"));
    const clearWorkspace = isClearWord(opts.str("workspace"));
    const saved = deps.tasks.saveTask({
      id: existing.id,
      title: step.name?.trim() || existing.title,
      body: step.prompt.trim() ? step.prompt : existing.body,
      agentId: clearAgent ? null : step.agentId ? step.agentId : existing.agentId,
      workspaceId: clearWorkspace ? null : step.workspaceId ? step.workspaceId : existing.workspaceId,
      isolated: opts.bool("isolated") ?? existing.isolated,
      shareCheckout: opts.bool("shareCheckout") ?? existing.shareCheckout,
    });
    if (step.status?.trim()) {
      const nextStatus = parseTaskStatus(step.status);
      if (nextStatus && nextStatus !== saved.status) deps.tasks.setTaskStatus(existing.id, nextStatus);
    }
    step.result = `Updated task "${saved.title}".`;
    return;
  }
  if (action === "delete") {
    const deleted = await deps.tasks.deleteTask(step.target);
    step.undo = deleted.undo;
    step.result = "Deleted task.";
    return;
  }
  if (action === "continue") {
    const launched = await deps.tasks.continueTask(step.target, START_SIZE, step.prompt.trim() || null);
    step.ptyId = launched.ptyId;
    step.runId = launched.runId;
    return;
  }
  if (action === "stop") {
    await deps.tasks.stopTask(step.target);
    step.result = "Stopped task.";
    return;
  }
  if (action === "status") {
    const nextStatus = parseTaskStatus(step.status || step.prompt);
    if (!nextStatus) throw new Error("Choose todo, review, or done.");
    deps.tasks.setTaskStatus(step.target, nextStatus);
    step.result = `Moved task to ${nextStatus}.`;
    return;
  }
  if (action === "cancel-wait") {
    deps.tasks.cancelWait(step.target);
    step.result = "Cancelled task wait.";
    return;
  }
  if (action === "apply") {
    const result = await deps.tasks.applyCopy(step.target);
    step.result = formatApply(result, "Applied task changes and marked done.");
    return;
  }
  if (action === "discard") {
    // Undone from the step, as a delete is.
    step.undo = (await deps.tasks.discardCopy(step.target)).undo;
    step.result = "Discarded task copy.";
    return;
  }
  const launched = await deps.tasks.executeTask(step.target, START_SIZE, false, action === "run-now");
  if ("ptyId" in launched) {
    step.ptyId = launched.ptyId;
    step.runId = launched.runId;
    deps.messages.adoptStarted(step.target, launched.ptyId);
  } else step.result = waitsTurn(launched.behind);
}

export async function carryOutChatStep(deps: EntityStepDeps, turn: OrchestratorTurn, step: OrchestratorStep): Promise<void> {
  if (!deps.chats) throw new Error("That chat no longer exists.");
  const action = normalizeChatAction(step.action, Boolean(step.target), Boolean(step.prompt.trim()));
  if (!action) throw new Error("Unsupported action.");

  if (action === "create") {
    if (step.agentId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    const created = deps.chats.createChat({
      ...(step.agentId ? { agentId: step.agentId } : { engine: step.engineId }),
      ...(step.prompt.trim() ? { prompt: step.prompt.trim() } : {}),
    });
    if (step.name?.trim()) deps.chats.renameChat(created.id, step.name.trim());
    step.target = created.id;
    substitutePlannedId(turn.steps, plannedId(step.id), created.id);
    if (step.prompt.trim()) {
      const sent = await deps.chats.sendChat(created.id, step.prompt.trim(), START_SIZE);
      step.ptyId = sent.ptyId;
      step.runId = sent.runId;
      if (!sent.started) deps.messages.onHumanInput(sent.ptyId, step.prompt.trim());
    } else {
      step.result = `Created chat "${step.name?.trim() || created.title}".`;
    }
    return;
  }

  if (action === "send") {
    if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    if (step.agentId?.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
    let chatId = step.target;
    if (!chatId && step.agentId) {
      const existing = deps.chats.listChats({ agentId: step.agentId })[0];
      chatId = existing ? existing.id : deps.chats.createChat({ agentId: step.agentId }).id;
      step.target = chatId;
    }
    if (!chatId) throw new Error("That chat no longer exists.");
    const sent = await deps.chats.sendChat(chatId, step.prompt.trim(), START_SIZE);
    step.ptyId = sent.ptyId;
    step.runId = sent.runId;
    if (!sent.started) deps.messages.onHumanInput(sent.ptyId, step.prompt.trim());
    if (sent.note) step.result = sent.note;
    return;
  }

  if (step.target.startsWith(PLANNED_PREFIX)) throw new Error("That earlier step did not finish creating what this step needs.");
  if (action === "continue") {
    const sent = await deps.chats.continueChat(step.target, START_SIZE);
    step.ptyId = sent.ptyId;
    step.runId = sent.runId;
    return;
  }
  if (action === "stop") {
    await deps.chats.stopChat(step.target);
    step.result = "Stopped chat.";
    return;
  }
  if (action === "rename") {
    const nextTitle = (step.name || step.prompt || "").trim();
    if (!nextTitle) throw new Error("Give the chat a title.");
    deps.chats.renameChat(step.target, nextTitle);
    step.result = `Renamed chat to "${nextTitle}".`;
    return;
  }
  if (action === "set-engine") {
    deps.chats.setChatEngine(step.target, step.engineId);
    step.result = `Switched chat CLI to ${step.engineId}.`;
    return;
  }
  if (action === "delete") {
    const deleted = await deps.chats.deleteChat(step.target);
    step.undo = deleted.undo;
    step.result = "Deleted chat.";
    return;
  }
  throw new Error("Unsupported action.");
}

export async function carryOutRunStep(deps: EntityStepDeps, step: OrchestratorStep): Promise<void> {
  const action = normalizeRunAction(step.action);
  if (!action) throw new Error("Unsupported action.");
  if (action === "mark-all-reviewed") {
    deps.runs?.markAllOpened();
    step.result = "Marked all runs reviewed.";
    return;
  }
  if (action === "tidy") {
    if (!deps.runs) throw new Error("That run no longer exists.");
    const upkeep = await deps.runs.maintainRuns();
    const mb = (upkeep.freed / 1_000_000).toFixed(1);
    step.result = `Compressed ${upkeep.compressed}, removed ${upkeep.removed}, freed ${mb} MB.`;
    return;
  }
  if (action === "continue") {
    if (!deps.runs) throw new Error("That run no longer exists.");
    const launched = await deps.runs.continueRun(step.target, START_SIZE, step.prompt.trim() || null);
    step.ptyId = launched.ptyId;
    step.runId = launched.runId;
    return;
  }
  if (action === "stop") {
    await deps.core.stopRun(step.target);
    step.result = "Stopped run.";
    return;
  }
  if (action === "mark-reviewed" || action === "mark-unreviewed") {
    deps.runs?.markRunOpened(step.target, action === "mark-reviewed");
    step.result = action === "mark-reviewed" ? "Marked run reviewed." : "Marked run unreviewed.";
    return;
  }
  if (action === "handoff") {
    if (!deps.tasks) throw new Error("That task no longer exists.");
    if (!step.agentId || step.agentId.startsWith(PLANNED_PREFIX)) throw new Error("Assign an agent first.");
    const created = deps.tasks.handOff(step.target, step.agentId);
    step.result = `Handed off as task "${created.title}".`;
    return;
  }
  if (action === "copy-markdown") {
    if (!deps.runs) throw new Error("That run no longer exists.");
    const md = await deps.runs.runMarkdown(step.target);
    deps.core.options.host.writeClipboard?.(md);
    step.result = "Copied run as Markdown.";
    return;
  }
}

export async function carryOutTalkStep(deps: EntityStepDeps, step: OrchestratorStep): Promise<void> {
  const action = normalizeTalkAction(step.action);
  if (!action) throw new Error("Unsupported action.");
  if (!deps.core.isLive(step.target)) throw new Error("That CLI isn't running any more.");
  if (action === "review") {
    const reviewer = step.agents?.[0];
    if (!reviewer || !deps.core.isLive(reviewer)) throw new Error("That CLI isn't running any more.");
    const res = await deps.messages.startReview(step.target, reviewer);
    step.result = res.changes ? "Started review." : "Review will start once the author makes changes.";
    return;
  }
  if (action === "send-draft") {
    const toPty = step.agents?.[0];
    if (!toPty || !deps.core.isLive(toPty)) throw new Error("That CLI isn't running any more.");
    const what = step.prompt === "changes" ? "changes" : "reply";
    const res = await deps.messages.sendDraft({ fromPty: step.target, toPty, what });
    step.result = res.sent ? `Placed ${what} draft in target terminal.` : `Nothing to send (${what} was empty).`;
    return;
  }
  if (action === "stop") {
    deps.messages.stop(step.target);
    step.result = "Paused agent-to-agent messages for that terminal.";
    return;
  }
  if (action === "start-tasks") {
    const taskIds = step.places?.length ? step.places : null;
    const res = await deps.messages.startHeld(step.target, taskIds);
    const detail = res.failed.join("; ");
    if (res.failed.length && !res.started) throw new Error(detail);
    step.result = res.failed.length ? `Started ${res.started}; ${res.failed.length} failed (${res.failed[0]}).` : `Started ${res.started} held task(s).`;
    return;
  }
}

export async function carryOutWorkbenchStep(deps: EntityStepDeps, step: OrchestratorStep): Promise<void> {
  const action = parseWorkbenchAction(step);
  if (!action) throw new Error("Unsupported workbench action.");
  if (action.op === "mark-reviewed") {
    deps.runs?.markAllOpened();
    step.result = "Marked all runs reviewed.";
    return;
  }
  if (action.op === "undo") {
    const token = action.token || deps.core.latestUndoToken();
    if (!token) throw new Error("Nothing left to undo.");
    deps.core.undoDelete(token);
    step.result = "Restored what was just deleted.";
    return;
  }
  if (action.op === "mkdir") {
    const ws = step.workspaceId ? deps.core.workspaceById(step.workspaceId) : null;
    const raw = expandHome(action.folder);
    const target = path.isAbsolute(raw) ? path.resolve(raw) : ws ? path.resolve(ws.path, raw) : path.resolve(expandHome(deps.projectsFolder()), raw);
    if (target === path.parse(target).root || target === os.homedir()) throw new Error("Refusing to modify root or home directory directly.");
    if (ws && !path.isAbsolute(raw) && !isInside(ws.path, target)) throw new Error("Folder path stays inside its workspace.");
    if (!ws && !path.isAbsolute(raw) && !isInside(path.resolve(expandHome(deps.projectsFolder())), target)) throw new Error("Folder path stays inside the projects folder.");
    const roots = [os.homedir(), path.resolve(expandHome(deps.projectsFolder())), ...deps.core.store.readWorkspaces().workspaces.map((item) => item.path)];
    if (!roots.some((root) => isInside(root, target))) throw new Error("Folder path stays inside your home, projects or workspace folders.");
    fs.mkdirSync(target, { recursive: true });
    step.result = `Created ${tildify(target)}.`;
    return;
  }
  if (action.op === "branch") {
    const opened = await deps.workspaces.openBranch(step.workspaceId, action.branch);
    step.openedWorkspaceId = opened.lastWorkspaceId ?? step.workspaceId;
    if (step.openedWorkspaceId) deps.core.options.host.show?.({ view: "code", workspaceId: step.openedWorkspaceId }, !deps.hasCall());
    return;
  }
  if (action.op === "browser-open") {
    deps.workspaces.updateWorkspace(step.workspaceId, { dockUrl: action.url });
    deps.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, !deps.hasCall());
    deps.core.options.host.codeWorkbench?.({ kind: "browser-open", workspaceId: step.workspaceId, url: action.url });
    step.result = action.url;
    return;
  }
  if (action.op === "browser-cmd") {
    deps.core.options.host.dockCommand?.(action.command);
    step.result = `Browser: ${action.command}.`;
    return;
  }
  if (action.op === "side") {
    if (step.workspaceId) deps.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, !deps.hasCall());
    deps.core.options.host.codeWorkbench?.({ kind: "side", ...(step.workspaceId ? { workspaceId: step.workspaceId } : {}), tab: action.tab });
    return;
  }
  if (action.op === "pane") {
    if (step.workspaceId) deps.core.options.host.show?.({ view: "code", workspaceId: step.workspaceId }, !deps.hasCall());
    deps.core.options.host.codeWorkbench?.({ kind: "pane", ...(step.workspaceId ? { workspaceId: step.workspaceId } : {}), action: action.action });
    return;
  }
  if (action.op === "diff") {
    const copy = deps.copies.list().find((item) => item.id === action.target || item.name === action.target || item.branch === action.target);
    if (copy) {
      deps.core.options.host.show?.({ view: "orchestrator", copyId: copy.id }, !deps.hasCall());
      return;
    }
    const run = deps.core.store.getRun(action.target) ?? deps.core.store.queryRuns({ limit: 50 }).find((r) => r.id === action.target || r.title.toLowerCase().includes(action.target.toLowerCase()));
    if (run) {
      deps.core.options.host.show?.({ view: "runs", runId: run.id }, !deps.hasCall());
      return;
    }
    throw new Error(`No copy or run matched "${action.target}".`);
  }
  if (action.op === "open-folder") {
    const ws = step.workspaceId ? deps.core.workspaceById(step.workspaceId) : null;
    if (!ws) throw new Error("That workspace is gone.");
    await deps.core.options.host.openFolder?.(ws.path);
    step.result = `Opened ${tildify(ws.path)}.`;
    return;
  }
  if (action.op === "check-updates") {
    const msg = (await deps.core.options.host.checkUpdates?.()) || "Checked for updates.";
    step.result = msg;
    return;
  }
}

export async function carryOutSettingsStep(deps: EntityStepDeps, step: OrchestratorStep): Promise<void> {
  const context = await deps.context();
  const resolved = resolveSettingsStep(
    {
      target: step.target,
      prompt: step.prompt,
      engine: step.engineId,
      model: step.model,
      effort: step.effort,
      folder: step.folder,
      branch: step.branch,
      name: step.name,
      options: step.options,
    },
    context,
  );
  const action = resolved.action;
  if (!action) throw new Error("Unsupported settings change.");

  if (action.op === "viby") {
    const current = deps.core.getSettings().orchestrator;
    const activePlanner = deps.planner();
    const nextEngine = action.engine !== undefined ? action.engine : (current.engine || activePlanner);
    const changedEngine = action.engine !== undefined && action.engine !== (current.engine || activePlanner);
    const nextModel = action.model !== undefined ? action.model : changedEngine ? "" : current.model;
    const keptEffort = action.effort !== undefined ? action.effort : changedEngine ? "" : (current.effort ?? "");
    // A new model keeps the effort only where it is still valid for it (an Antigravity id names its own).
    const nextRow = action.model !== undefined && action.effort === undefined ? context.engines.find((e) => e.id === nextEngine) : undefined;
    const nextEffort = nextRow?.bin !== undefined ? effortForModel({ id: nextRow.id, bin: nextRow.bin }, nextModel, keptEffort) : keptEffort;
    const nextMode = action.mode ?? current.mode;
    const nextProjectsFolder = action.projectsFolder !== undefined ? action.projectsFolder : current.projectsFolder;
    const nextTerse = action.terse ?? (current.terse ?? true);
    deps.core.saveSettings({
      orchestrator: {
        engine: nextEngine,
        mode: nextMode,
        model: nextModel,
        projectsFolder: nextProjectsFolder,
        terse: nextTerse,
        ...(nextEffort ? { effort: nextEffort } : {}),
      },
    });
    step.result = `Updated ${action.summary}.`;
    return;
  }

  if (action.op === "voice-model") {
    const currentVoice = deps.core.getSettings().voice;
    const nextModel = action.model
      ? path.isAbsolute(action.model)
        ? action.model
        : path.join(deps.core.options.dataRoot, "models", action.model)
      : "";
    deps.core.saveSettings({ voice: { ...currentVoice, model: nextModel } });
    if (action.downloadId) deps.core.options.host.voiceDownload?.("model", action.downloadId);
    step.result = action.downloadId
      ? `Downloading ${action.downloadId} and selected it for voice.`
      : `Updated ${action.summary}.`;
    return;
  }

  if (action.op === "voice-download") {
    deps.core.options.host.voiceDownload?.(action.kind, action.id);
    step.result = `Started ${action.summary.toLowerCase()}.`;
    return;
  }

  if (action.op === "voice-stop-download") {
    deps.core.options.host.voiceStopDownload?.();
    step.result = "Stopped voice download.";
    return;
  }

  if (action.op === "voice-speaker") {
    const currentVoice = deps.core.getSettings().voice;
    const nextSpeaker = action.speaker
      ? path.isAbsolute(action.speaker)
        ? action.speaker
        : path.join(deps.core.options.dataRoot, "voices", action.speaker)
      : "";
    deps.core.saveSettings({ voice: { ...currentVoice, speaker: nextSpeaker } });
    if (action.downloadId) deps.core.options.host.voiceDownload?.("voice", action.downloadId);
    step.result = action.downloadId
      ? `Downloading ${action.downloadId} and selected it as speaker.`
      : `Updated ${action.summary}.`;
    return;
  }

  if (action.op === "voice-patch") {
    const currentVoice = deps.core.getSettings().voice;
    deps.core.saveSettings({ voice: { ...currentVoice, ...action.patch } });
    step.result = `Updated ${action.summary}.`;
    return;
  }

  if (action.op === "rail") {
    const currentRail = deps.core.getSettings().rail;
    let order = [...currentRail.order];
    let hidden = [...currentRail.hidden];
    if (action.mode === "hide") {
      hidden = [...new Set([...hidden, ...action.views.filter((v) => v !== "code")])];
    } else if (action.mode === "show") {
      const showSet = new Set(action.views);
      hidden = hidden.filter((v) => !showSet.has(v));
    } else {
      const mentioned = new Set(action.views);
      order = [...action.views, ...order.filter((v) => !mentioned.has(v))];
    }
    deps.core.saveSettings({ rail: { order, hidden } });
    step.result = `Updated ${action.summary}.`;
    return;
  }

  if (action.op === "engines-recheck") {
    const engines = deps.core.listEngines();
    deps.core.emit("engines", "agents", "routines", "tasks");
    const available = engines.filter((e) => e.available).map((e) => e.label);
    step.result = `Checked coding CLIs: ${available.length} available (${available.join(", ") || "none"}).`;
    return;
  }

  if (action.op === "engine-save") {
    const rows = deps.core.store.readEngineRows();
    const idx = rows.findIndex((r) => r.id === action.row.id);
    const next = idx >= 0 ? rows.map((r, i) => (i === idx ? action.row : r)) : [...rows, action.row];
    deps.core.saveEngines(next);
    step.result = `Saved coding CLI ${action.row.label} (${action.row.id}).`;
    return;
  }

  if (action.op === "engine-remove") {
    const rows = deps.core.store.readEngineRows();
    const next = rows.filter((r) => r.id !== action.id);
    if (next.length === rows.length) throw new Error(`There is no engine called "${action.id}".`);
    deps.core.saveEngines(next);
    step.result = `Removed coding CLI ${action.id}.`;
    return;
  }

  const current = deps.core.getSettings();
  const rawPatch = action.patch;
  const merged: Parameters<ServiceCore["saveSettings"]>[0] = {};
  for (const [k, v] of Object.entries(rawPatch)) {
    if (k === "sounds" && v && typeof v === "object") {
      merged.sounds = { ...current.sounds, ...(v as Partial<Settings["sounds"]>) };
    } else if (k === "agentTalk" && v && typeof v === "object") {
      merged.agentTalk = { ...current.agentTalk, ...(v as Partial<Settings["agentTalk"]>) };
    } else if (k === "sync" && v && typeof v === "object") {
      merged.sync = { ...current.sync, ...(v as Partial<Settings["sync"]>) };
    } else if (k === "local" && v && typeof v === "object") {
      merged.local = { ...current.local, ...(v as Partial<Settings["local"]>) };
    } else if (k === "keepRuns" && v && typeof v === "object") {
      merged.keepRuns = { ...current.keepRuns, ...(v as Partial<Settings["keepRuns"]>) };
    } else if (k === "companion" && v && typeof v === "object") {
      merged.companion = v as Partial<Settings["companion"]>;
    } else {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  if (Object.keys(merged).length > 0) deps.core.saveSettings(merged);
  if (action.autostart !== undefined) deps.core.options.host.autostart?.set(action.autostart);
  step.result = `Updated ${action.summary}.`;
}
