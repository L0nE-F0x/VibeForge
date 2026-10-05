import { buildDesk, COMPANION_RECENT_MS, isCodingSession, shellForegroundEngine, tailText, type DeskPayload, type DeskRun } from "../src/core/companion.js";
import { startCompanionHttp, type CompanionActions, type CompanionHttp, type LaunchResult, type SessionPayload } from "../src/core/companion-http.js";
import { describeError } from "../src/core/log.js";
import { readRunText } from "../src/core/run-storage.js";
import { RUN_FILES } from "../src/core/runs.js";
import type { TeamService } from "../src/core/team-service.js";
import type { PlanSummary } from "../src/core/plans.js";
import type { LiveSession, RunMeta } from "../src/core/types.js";
import type { CompanionStatus } from "../src/shared/api.js";
import type { PtySupervisor } from "./supervisor.js";

/** A phone has no pane to measure, so a launched agent gets a modest terminal. */
const PHONE_SIZE = { cols: 100, rows: 32 };

export interface CompanionWire {
  service: TeamService;
  supervisor: PtySupervisor;
  /** The `companion/` directory shipped with the app. */
  root: string;
  icon: string | null;
  log: (line: string) => void;
  /** Plan limits as the desktop's live popover reads them (null when Settings leave them off). */
  plans: () => Promise<PlanSummary | null>;
}

let server: CompanionHttp | null = null;
let boundToken = "";
let status: CompanionStatus = { listening: false, url: null, error: null };
let job: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = job.then(task, task);
  job = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function companionStatus(): CompanionStatus {
  return status;
}

export function syncCompanion(wire: CompanionWire): void {
  void enqueue(() => apply(wire));
}

export function stopCompanion(): Promise<void> {
  return enqueue(async () => {
    await closeServer();
    boundToken = "";
    status = { listening: false, url: null, error: null };
  });
}

async function closeServer(): Promise<void> {
  const current = server;
  server = null;
  if (current) await current.close();
}

async function apply(wire: CompanionWire): Promise<void> {
  const settings = wire.service.getSettings().companion;
  const url = `http://127.0.0.1:${settings.port}`;
  if (settings.enabled && !settings.token) {
    // The next settings event starts the page once a code exists.
    wire.service.saveSettings({ companion: { enabled: true } });
    return;
  }
  if (!settings.enabled) {
    await closeServer();
    boundToken = "";
    status = { listening: false, url: null, error: null };
    return;
  }
  if (server && status.listening && status.url === url && boundToken === settings.token) return;
  await closeServer();
  try {
    server = await startCompanionHttp({
      port: settings.port,
      token: settings.token,
      root: wire.root,
      icon: wire.icon,
      actions: actionsFor(wire),
      language: () => wire.service.getSettings().language,
    });
    boundToken = settings.token;
    status = { listening: true, url, error: null };
    wire.log(`Phone page listening on ${url}`);
  } catch (error) {
    boundToken = "";
    status = { listening: false, url: null, error: describeError(error).split("\n")[0] };
    wire.log(`Phone page could not listen on ${url}: ${status.error}`);
  }
}

function actionsFor(wire: CompanionWire): CompanionActions {
  const service = wire.service;
  return {
    desk: () => deskOf(service),
    session: (query) => sessionOf(service, wire.supervisor, query),
    send: (input) => sendTo(service, wire.supervisor, input),
    stop: async (ptyId) => {
      const live = codingSession(service, ptyId);
      if (!live) throw new Error("That session has ended.");
      // A run's terminal is its own; a shell is the person's, so only the CLI's turn is stopped there.
      if (live.kind === "run") {
        await service.killPty(ptyId);
        return;
      }
      const seen = await shellNow(service, wire.supervisor, ptyId);
      if (seen.where !== "cli") {
        if (seen.where === "shell") service.onPtyProgram(ptyId, seen.argv, seen.cwd);
        throw new Error("That session has ended.");
      }
      await wire.supervisor.write(ptyId, "\x1b");
    },
    launch: async (input) => {
      const result = input.agentId
        ? await service.launchAgent(input.workspaceId, input.agentId, input.prompt || null, PHONE_SIZE)
        : await service.startEngine({ workspaceId: input.workspaceId, engineId: input.engineId, prompt: input.prompt, ...PHONE_SIZE });
      return { ptyId: result.ptyId, runId: result.runId };
    },
    plans: () => wire.plans(),
  };
}

/** The live session behind `ptyId`, while a coding CLI holds it. A bare shell is never typed into from the phone. */
function codingSession(service: TeamService, ptyId: string | null | undefined): LiveSession | undefined {
  if (!ptyId) return undefined;
  const live = service.listLive().find((session) => session.ptyId === ptyId);
  return live && isCodingSession(live) ? live : undefined;
}

function deskOf(service: TeamService): DeskPayload {
  const now = service.now().getTime();
  const recent = service.listRuns({
    status: ["exited", "stopped", "failed"],
    since: new Date(now - COMPANION_RECENT_MS).toISOString(),
    limit: 80,
  });
  return buildDesk({
    workspaces: service.listWorkspaces().workspaces,
    agents: service.listAgents(),
    engines: service.listEngines().map((engine) => ({ id: engine.id, label: engine.label, available: engine.available })),
    live: service.liveForView(),
    recent: recent.map(toDeskRun),
    nudges: service.getSettings().companion.nudges,
    now,
  });
}

function toDeskRun(run: RunMeta): DeskRun {
  return {
    id: run.id,
    title: run.title,
    agentId: run.agentId,
    engine: run.engine,
    cwd: run.cwd,
    workspaceId: run.workspaceId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    changes: run.changes,
    status: run.status,
  };
}

async function sessionOf(service: TeamService, supervisor: PtySupervisor, query: { ptyId: string; runId: string }): Promise<SessionPayload> {
  const live = codingSession(service, query.ptyId) ?? codingSession(service, query.runId ? service.ptyByRun.get(query.runId) : null);
  // A shell's run belongs to the CLI that was in it; once the CLI quits, the shell's next run is another one.
  const run = service.findRun(live?.runId || query.runId || "");
  if (!live && !run) throw new Error("That session is gone.");
  let screen = "";
  if (live) {
    try {
      screen = (await supervisor.snapshot(live.ptyId)).plain;
    } catch {
      screen = "";
    }
  }
  if (!screen.trim() && run?.dir) screen = readRunText(run.dir, RUN_FILES.transcript);
  const agentId = live?.agentId || run?.agentId;
  const agent = agentId ? service.getAgent(agentId) : null;
  const engineId = live?.programEngineId || run?.engine || "";
  const engine = engineId ? service.listEngines().find((item) => item.id === engineId)?.label || engineId : "";
  const title = agent?.name || live?.program || live?.title || run?.title || "Session";
  return {
    ptyId: live?.ptyId ?? null,
    runId: run?.id ?? live?.runId ?? null,
    title,
    detail: engine && engine !== title ? engine : "",
    state: live ? (live.working ? "working" : "waiting") : "done",
    changes: run?.changes ?? null,
    screen: tailText(screen, 160, 20_000),
    canSend: Boolean(live) || Boolean(run),
    stop: !live ? null : live.kind === "run" ? "end" : "interrupt",
  };
}

/** The shell's foreground right now, not the host's last poll. "unknown" means the read failed. */
async function shellNow(
  service: TeamService,
  supervisor: PtySupervisor,
  ptyId: string,
): Promise<{ where: "cli" | "shell" | "unknown"; argv: string[] | null; cwd: string | null }> {
  const seen = await supervisor.foreground(ptyId);
  return { where: shellForegroundEngine(seen, service.store.readEngineRows()), argv: seen.argv, cwd: seen.cwd };
}

async function sendTo(
  service: TeamService,
  supervisor: PtySupervisor,
  input: { ptyId: string; runId: string; text: string; force: boolean },
): Promise<{ working: true } | ({ working: false } & LaunchResult)> {
  let live = codingSession(service, input.ptyId) ?? codingSession(service, input.runId ? service.ptyByRun.get(input.runId) : null);
  if (live?.kind === "shell") {
    const seen = await shellNow(service, supervisor, live.ptyId);
    if (seen.where === "unknown") throw new Error("That session is still closing.");
    if (seen.where !== "cli") {
      // The poll can still say the CLI is here for a second after it has returned to the shell.
      service.onPtyProgram(live.ptyId, seen.argv, seen.cwd);
      live = undefined;
    }
  }
  if (live) {
    if (live.working && !input.force) return { working: true };
    if (live.chatId) await service.sendChat(live.chatId, input.text, PHONE_SIZE);
    else await supervisor.send(live.ptyId, input.text);
    return { working: false, ptyId: live.ptyId, runId: live.runId ?? input.runId };
  }
  // The CLI has ended (or quit back to its shell): pick its session up again, with this as the next instruction.
  if (!input.runId || !service.findRun(input.runId)) throw new Error("That session has ended.");
  const result = await service.continueRun(input.runId, PHONE_SIZE, input.text);
  return { working: false, ptyId: result.ptyId, runId: result.runId };
}
