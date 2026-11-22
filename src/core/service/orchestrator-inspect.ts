import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCodingCli } from "../checkout.js";
import { isDirectory } from "../fsx.js";
import {
  detectWaitingPrompt,
  formatScheduleBrief,
  formatSettingsRules,
  inspectsQuotas,
  inspectsSettings,
  inspectsStorage,
  type OrchestratorStep,
  type PlanSettingsContext,
} from "../orchestrator.js";
import { repoKind } from "../sync/git-rescue.js";
import type { ChatDesk } from "./chats.js";
import type { ServiceCore } from "./core.js";
import type { LibraryDesk } from "./library.js";
import type { MessageDesk } from "./messages.js";
import type { MaestroCopies } from "./orchestrator-copies.js";
import { gitIn, isSensitiveInspectPath, LOOKUP_FOLDERS, LOOKUP_WALK_MS, oneLine, readBoundedInspectText, realInside, tildify, expandHome } from "./orchestrator-utils.js";
import type { RoutineDesk } from "./routines.js";
import type { RunDesk } from "./runs.js";
import type { TaskDesk } from "./tasks.js";
import type { WorkspaceDesk } from "./workspaces.js";

export interface InspectDeps {
  core: ServiceCore;
  workspaces: WorkspaceDesk;
  messages: MessageDesk;
  runs?: RunDesk;
  library?: LibraryDesk;
  routines?: RoutineDesk;
  tasks?: TaskDesk;
  chats?: ChatDesk;
  copies: MaestroCopies;
  models: Map<string, string[]>;
  planner: () => string;
  listModels: (engineId: string) => Promise<string[]>;
  buildSettingsContext: () => PlanSettingsContext;
  projectsFolder: () => string;
}

/**
 * Read-only inspection of quotas/usage, settings/voice, storage, saved entities (agents, skills,
 * routines, tasks, chats, runs), a copy's diff, a running CLI's screen and latest reply, or a
 * workspace's git state, branches and files, so Viby can diagnose, review and brainstorm with real facts.
 */
export async function inspectOrchestratorStep(deps: InspectDeps, step: OrchestratorStep): Promise<{ summary: string; details: string }> {
  if (inspectsQuotas(step.prompt) || inspectsQuotas(step.target)) {
    const details = (await deps.core.options.host.quotas?.()) ?? "Plan limits and token usage are not enabled in Settings.";
    return { summary: oneLine(details, 140), details };
  }
  if (inspectsStorage(step.prompt) || inspectsStorage(step.target) || step.action === "storage") {
    const summary = deps.runs?.storageSummary();
    if (!summary) return { summary: "Storage summary unavailable.", details: "Runs desk is not configured." };
    const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
    const details = [
      `VibeForge data root: ${tildify(summary.dataRoot)}`,
      `- Runs (${summary.runCount}): ${mb(summary.runs)}`,
      `- Voice models & voices: ${mb(summary.voice)}`,
      `- Logs: ${mb(summary.logs)}`,
      `- Scratch chats: ${mb(summary.scratch)}`,
    ].join("\n");
    return {
      summary: `${summary.runCount} runs (${mb(summary.runs)}) · voice ${mb(summary.voice)} · scratch ${mb(summary.scratch)}`,
      details,
    };
  }
  if (inspectsSettings(step.prompt) || inspectsSettings(step.target)) {
    const query = `${step.prompt} ${step.target}`;
    const planner = deps.planner();
    if (planner && /\b(?:planner|viby|orchestrator)[- ]models?\b/i.test(query) && !deps.models.has(planner)) {
      await deps.listModels(planner).catch(() => []);
    }
    const settings = deps.buildSettingsContext();
    const lines = [...formatSettingsRules(settings)];
    const liveVoice = deps.core.options.host.voiceStatus?.();
    if (liveVoice?.download) {
      lines.push(`- Active download: ${liveVoice.download.kind} ${liveVoice.download.id} (${Math.round(liveVoice.download.received / 1_000_000)} / ${Math.round(liveVoice.download.total / 1_000_000)} MB)`);
    }
    if (liveVoice?.downloadError) {
      lines.push(`- Last download error: ${liveVoice.downloadError}`);
    }
    return {
      summary: `Planner: ${settings.viby.planner || "none"} (${settings.viby.model || "default"}, ${settings.viby.effort || "low"}) · Voice: ${settings.voice.activeModel || "none"}`,
      details: lines.join("\n"),
    };
  }

  if (step.action && ["agent", "skill", "routine", "task", "chat", "run"].includes(step.action)) {
    const inspected = await inspectOrchestratorEntity(deps, step.action as "agent" | "skill" | "routine" | "task" | "chat" | "run", step.target);
    if (inspected) return inspected;
  }

  const copy = step.target ? deps.copies.list().find((item) => item.id === step.target) : undefined;
  if (copy) {
    const diff = await deps.copies.diff(copy.id).catch(() => "");
    const clipped = diff.length > 10_000 ? `${diff.slice(0, 10_000)}\n… (truncated)` : diff || "(no diff yet)";
    return {
      summary: `Copy ${copy.name} (${copy.branch}): ${diff ? `${diff.split("\n").length} diff lines` : "no changes yet"}`,
      details: `Copy "${copy.name}" on branch ${copy.branch}:\n${clipped}`,
    };
  }
  const session = step.target ? deps.core.live.get(step.target) : undefined;
  if (session) {
    const [answer, screen, status] = await Promise.all([
      isCodingCli(session) ? deps.messages.answerOf(session.ptyId, true).catch(() => ({ reply: "", fromScreen: false })) : Promise.resolve({ reply: "", fromScreen: false }),
      deps.core.options.host.screen ? deps.core.options.host.screen(session.ptyId).catch(() => "") : Promise.resolve(""),
      gitIn(["status", "--short"], session.programCwd || session.cwd),
    ]);
    const tailScreen = screen.split(/\r?\n/).filter((line) => line.trim()).slice(-40).join("\n");
    const waiting = detectWaitingPrompt(screen);
    const parts = [
      `CLI: ${session.program || session.title} in ${tildify(session.programCwd || session.cwd)} (${session.working ? "working" : waiting ? `WAITING ON PROMPT: "${waiting}"` : "idle"})`,
      ...(answer.reply ? [`Latest reply:\n${answer.reply.slice(0, 6000)}`] : []),
      ...(tailScreen ? [`Terminal screen (last lines):\n${tailScreen.slice(-4000)}`] : []),
      ...(status.code === 0 && status.stdout.trim() ? [`Git status:\n${status.stdout.trim().slice(0, 2000)}`] : []),
    ];
    const summary = waiting ? `Waiting on prompt: ${waiting}` : answer.reply ? oneLine(answer.reply, 120) : oneLine(tailScreen || "Idle.", 120);
    return { summary, details: parts.join("\n\n") };
  }
  if (step.target) {
    for (const kind of ["agent", "skill", "routine", "task", "chat", "run"] as const) {
      const inspected = await inspectOrchestratorEntity(deps, kind, step.target);
      if (inspected) return inspected;
    }
  }
  const ws = step.workspaceId ? deps.core.workspaceById(step.workspaceId) : null;
  if (ws && isDirectory(ws.path)) {
    const [branchOut, statusOut, logOut, statOut] = await Promise.all([
      gitIn(["rev-parse", "--abbrev-ref", "HEAD"], ws.path),
      gitIn(["status", "--short"], ws.path),
      gitIn(["log", "-n", "5", "--oneline"], ws.path),
      gitIn(["diff", "--stat"], ws.path),
    ]);
    const parts: string[] = [`Workspace "${ws.name}" (${tildify(ws.path)})`];
    if (branchOut.code === 0 && branchOut.stdout.trim()) parts.push(`Branch: ${branchOut.stdout.trim()}`);
    if (/\bbranch(?:es)?\b/i.test(step.prompt)) {
      const list = await deps.workspaces.listBranches(ws.id).catch(() => null);
      if (list?.branches.length) {
        parts.push(
          `Local branches:\n${list.branches
            .slice(0, 40)
            .map((b) => `- ${b.name}${b.current ? " (current)" : ""}${b.checkout ? ` [checked out: ${tildify(b.checkout)}]` : ""} (${b.commit})`)
            .join("\n")}`,
        );
      }
    }
    if (statusOut.code === 0) parts.push(`Git status:\n${statusOut.stdout.trim() || "(clean)"}`);
    if (statOut.code === 0 && statOut.stdout.trim()) parts.push(`Uncommitted diff stat:\n${statOut.stdout.trim()}`);
    if (/\bdiff\b/i.test(step.prompt)) {
      const fullDiff = await gitIn(["diff"], ws.path);
      if (fullDiff.code === 0 && fullDiff.stdout.trim()) parts.push(`Git diff:\n${fullDiff.stdout.slice(0, 6000)}`);
    }
    if (logOut.code === 0 && logOut.stdout.trim()) parts.push(`Recent commits:\n${logOut.stdout.trim()}`);
    const entries = await fs.promises
      .readdir(ws.path, { withFileTypes: true })
      .then((list) => list.filter((e) => !e.name.startsWith(".")).slice(0, 40).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)))
      .catch(() => [] as string[]);
    if (entries.length) parts.push(`Top-level files: ${entries.join(", ")}`);

    const wantedFile = (step.folder || (!/\b(?:status|diff|log|files|tree|commits?|branch(?:es)?)\b/i.test(step.prompt) ? step.prompt : "")).trim();
    if (wantedFile) {
      const rel = wantedFile.replace(/\\/g, "/");
      if (isSensitiveInspectPath(rel)) {
        parts.push(`File ${wantedFile}: [skipped sensitive credential/env file]`);
      } else {
        const safeFile = realInside(ws.path, path.resolve(ws.path, wantedFile));
        const read = safeFile ? readBoundedInspectText(safeFile) : null;
        if (read && "text" in read) parts.push(`File ${wantedFile}:\n${read.text}`);
        else if (read) parts.push(`File ${wantedFile}: [skipped ${read.reason}]`);
      }
    }
    const cleanStatus = statusOut.code === 0 && statusOut.stdout.trim() ? `${statusOut.stdout.trim().split("\n").length} modified/untracked` : "clean";
    return { summary: `${ws.name}: ${branchOut.stdout.trim() || "folder"} (${cleanStatus})`, details: parts.join("\n\n") };
  }
  return { summary: "Nothing found to inspect.", details: "No matching workspace, running CLI, entity, or copy was found." };
}

export async function inspectOrchestratorEntity(
  deps: InspectDeps,
  kind: "agent" | "skill" | "routine" | "task" | "chat" | "run",
  id: string,
): Promise<{ summary: string; details: string } | null> {
  if (!id) return null;
  if (kind === "agent") {
    const agent = deps.core.store.getAgent(id);
    if (!agent) return null;
    const memory = deps.library?.readMemory(agent.id) ?? deps.core.store.readMemory(agent.id);
    const parts = [
      `Agent "${agent.name}" (id: ${agent.id})`,
      `Engine: ${agent.engine} · allowRoutines: ${agent.allowRoutines ? "yes" : "no"}${agent.tier ? ` · tier: ${agent.tier}` : ""}`,
      ...(agent.goodAt ? [`Good at: ${agent.goodAt}`] : []),
      `Allowed folders:\n${agent.places.map((p) => `- ${tildify(p)}`).join("\n") || "(none)"}`,
      `Skills: ${agent.skills.join(", ") || "(none)"}`,
      `Brief:\n${agent.brief.slice(0, 4000)}`,
      `Memory (memory.md):\n${memory.slice(0, 4000) || "(empty)"}`,
    ];
    return {
      summary: `Agent ${agent.name} (${agent.engine}, ${agent.places.length} folder${agent.places.length === 1 ? "" : "s"}, ${agent.skills.length} skill${agent.skills.length === 1 ? "" : "s"})`,
      details: parts.join("\n\n"),
    };
  }
  if (kind === "skill") {
    const skill = deps.core.store.getSkill(id);
    if (!skill) return null;
    const agents = deps.core.store.listAgents().filter((a) => a.skills.includes(skill.id)).map((a) => `${a.name} (${a.id})`);
    const parts = [
      `Skill "${skill.name}" (id: ${skill.id})`,
      ...(skill.description ? [`Description: ${skill.description}`] : []),
      `Attached agents: ${agents.join(", ") || "(none)"}`,
      `Body (SKILL.md):\n${skill.body.slice(0, 6000) || "(empty)"}`,
    ];
    return {
      summary: `Skill ${skill.name}${skill.description ? `: ${oneLine(skill.description, 80)}` : ""}`,
      details: parts.join("\n\n"),
    };
  }
  if (kind === "routine") {
    const view = deps.routines?.listRoutines().find((r) => r.id === id);
    const routine = view ?? deps.core.store.getRoutine(id);
    if (!routine) return null;
    const sched = view ? view.description : formatScheduleBrief(routine.schedule);
    const parts = [
      `Routine "${routine.name}" (id: ${routine.id})`,
      `Agent: ${view?.agentName ?? routine.agentId} · Schedule: ${sched} · ${routine.enabled ? "enabled" : "paused"} · notify: ${routine.notify ? "on" : "off"} · shareCheckout: ${routine.shareCheckout ? "yes" : "no"}`,
      ...(view?.nextFires.length ? [`Next runs: ${view.nextFires.join(", ")}`] : []),
      ...(view?.issues.length ? [`Issues: ${view.issues.join("; ")}`] : []),
      ...(view?.failStreak ? [`Fail streak: ${view.failStreak}`] : []),
      ...(view?.lastRun ? [`Last run: ${view.lastRun.status} (${view.lastRun.startedAt})${view.lastRun.changes ? ` — ${view.lastRun.changes}` : ""}`] : []),
      `Prompt:\n${routine.prompt.slice(0, 4000)}`,
    ];
    return {
      summary: `Routine ${routine.name} (${sched}, ${routine.enabled ? "enabled" : "paused"})`,
      details: parts.join("\n\n"),
    };
  }
  if (kind === "task") {
    const view = deps.tasks?.listTasks().find((t) => t.id === id);
    const task = view ?? deps.core.store.getTask(id);
    if (!task) return null;
    const agent = task.agentId ? deps.core.store.getAgent(task.agentId) : null;
    const ws = task.workspaceId ? deps.core.workspaceById(task.workspaceId) : null;
    const parts = [
      `Task "${task.title}" (id: ${task.id})`,
      `Status: ${task.status} · Agent: ${agent?.name ?? task.agentId ?? "none"} · Workspace: ${ws?.name ?? task.workspaceId ?? "none"} · isolated: ${task.isolated ? "yes" : "no"}${task.copy ? ` · copy branch: ${task.copy.branch}` : ""}`,
      ...(view?.blocker ? [`Blocker: ${view.blocker}`] : []),
      ...(view?.waiting ? ["Waiting for workspace folder to clear."] : []),
      ...(view?.lastRun ? [`Last run: ${view.lastRun.status} (${view.lastRun.startedAt})${view.lastRun.changes ? ` — ${view.lastRun.changes}` : ""}`] : []),
      `Instructions:\n${task.body.slice(0, 4000) || "(empty)"}`,
    ];
    return {
      summary: `Task "${task.title}" (${task.status}${agent ? `, ${agent.name}` : ""}${ws ? `, ${ws.name}` : ""})`,
      details: parts.join("\n\n"),
    };
  }
  if (kind === "chat") {
    const view = deps.chats?.listChats().find((c) => c.id === id);
    const chat = view ?? deps.core.store.getChat(id);
    if (!chat) return null;
    const agent = chat.agentId ? deps.core.store.getAgent(chat.agentId) : null;
    const parts = [
      `Chat "${chat.title}" (id: ${chat.id})`,
      `Type: ${agent ? `Agent chat (${agent.name})` : `Plain chat (${chat.engine})`} · Folder: ${tildify(chat.cwd)} · Live: ${view?.live ? "yes" : "no"} · Runs: ${chat.runIds.length}`,
      ...(view?.lastRun ? [`Last run: ${view.lastRun.status} (${view.lastRun.startedAt})${view.lastRun.changes ? ` — ${view.lastRun.changes}` : ""}`] : []),
    ];
    return {
      summary: `Chat "${chat.title}" (${agent ? agent.name : chat.engine}${view?.live ? ", live" : ""})`,
      details: parts.join("\n\n"),
    };
  }
  const bundle = deps.runs ? await deps.runs.loadRun(id).catch(() => null) : null;
  if (!bundle) return null;
  const { run, files } = bundle;
  const parts = [
    `Run "${run.title}" (id: ${run.id})`,
    `Status: ${run.status} · Origin: ${run.origin} · Engine: ${run.engine} · Folder: ${tildify(run.cwd)} · Reviewed: ${run.openedAt ? "yes" : "no"}${run.changes ? ` · Changes: ${run.changes}` : ""}`,
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(run.prompt ? [`Prompt:\n${run.prompt.slice(0, 2000)}`] : []),
    ...(files.git ? [`Git summary:\n${files.git.slice(0, 2000)}`] : []),
    ...(files.transcript ? [`Transcript tail:\n${files.transcript.slice(-4000)}`] : []),
  ];
  return {
    summary: `Run "${run.title}" (${run.status}${run.changes ? `, ${run.changes}` : ""})`,
    details: parts.join("\n\n"),
  };
}

/**
 * Search VibeForge's run history, workspace git branches, and project folders on disk for a
 * session id, branch, or project folder.
 */
export async function lookupOrchestrator(deps: InspectDeps, query: string): Promise<{ summary: string; details: string }> {
  const raw = query.trim();
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .filter((tok) => tok.length >= 2);
  const matches = (haystack: string) => {
    const lower = haystack.toLowerCase();
    if (lower.includes(raw.toLowerCase())) return true;
    return tokens.length > 0 && tokens.every((tok) => lower.includes(tok));
  };
  const anyToken = (haystack: string) => {
    const lower = haystack.toLowerCase();
    return tokens.some((tok) => tok.length >= 3 && lower.includes(tok));
  };
  const lines: string[] = [];
  const workspaces = deps.core.store.readWorkspaces().workspaces;
  const wsById = new Map(workspaces.map((w) => [w.id, w]));

  const allRuns = deps.core.store.queryRuns({ limit: 200 });
  const runHits = allRuns.filter((run) => {
    const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
    const blob = [run.id, run.title, run.engine, run.cwd, ws?.name ?? "", run.prompt ?? "", run.changes ?? ""].join(" ");
    return matches(blob);
  });
  const fallbackRuns = runHits.length
    ? runHits
    : allRuns.filter((run) => {
        const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
        const blob = [run.id, run.title, run.engine, run.cwd, ws?.name ?? "", run.prompt ?? ""].join(" ");
        return anyToken(blob);
      });
  for (const run of fallbackRuns.slice(0, 6)) {
    const ws = run.workspaceId ? wsById.get(run.workspaceId) : undefined;
    lines.push(
      `- Run ${run.id}: ${run.engine} in ${tildify(run.cwd)}${ws ? ` (workspace "${ws.name}")` : ""}${run.prompt ? ` — prompt: "${oneLine(run.prompt, 120)}"` : ""}`,
    );
  }

  for (const ws of workspaces) {
    if (!isDirectory(ws.path)) continue;
    const branchOut = await gitIn(["branch", "--format=%(refname:short)"], ws.path);
    const branches = branchOut.code === 0 ? branchOut.stdout.split("\n").map((b) => b.trim()).filter(Boolean) : [];
    const hitBranches = branches.filter((b) => matches(b) || anyToken(b));
    if (matches(`${ws.name} ${ws.path}`) || hitBranches.length > 0) {
      lines.push(`- Workspace "${ws.name}" (${tildify(ws.path)})${hitBranches.length ? `: matching branches [${hitBranches.slice(0, 8).join(", ")}]` : ""}`);
    }
  }

  const roots = new Set<string>([path.resolve(expandHome(deps.projectsFolder())), path.join(os.homedir(), "Projects")]);
  const byPath = raw.includes("/");
  const strong: string[] = [];
  const weak: string[] = [];
  const seenDirs = new Set<string>();
  const deadline = Date.now() + LOOKUP_WALK_MS;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || strong.length >= LOOKUP_FOLDERS || Date.now() > deadline) return;
    let resolved: string;
    try {
      resolved = await fs.promises.realpath(dir);
    } catch {
      return;
    }
    if (seenDirs.has(resolved)) return;
    seenDirs.add(resolved);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "target") continue;
      const full = path.join(dir, entry.name);
      const line = () => `- Folder on disk: ${tildify(full)}${repoKind(full) !== "none" ? " (git repository)" : ""}`;
      if (matches(entry.name) || (byPath && matches(tildify(full)))) strong.push(line());
      else if (weak.length < LOOKUP_FOLDERS && anyToken(entry.name)) weak.push(line());
      if (strong.length >= LOOKUP_FOLDERS) return;
      if (depth < 3) await walk(full, depth + 1);
    }
  };
  for (const root of roots) {
    if (isDirectory(root)) await walk(root, 1);
  }
  lines.push(...[...strong, ...weak].slice(0, LOOKUP_FOLDERS));

  if (!lines.length) {
    return {
      summary: `No runs, branches or folders matched "${oneLine(raw, 60)}".`,
      details: `No runs, git branches, or folders under ${[...new Set([deps.projectsFolder(), "~/Projects"])].join(" or ")} matched "${raw}".`,
    };
  }
  return {
    summary: oneLine(lines[0].replace(/^- /, ""), 120),
    details: lines.join("\n"),
  };
}
