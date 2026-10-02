import { buildDesk, COMPANION_RECENT_MS, tailText, type DeskPayload, type DeskRun } from "../src/core/companion.js";
import { CompanionHttpError, startCompanionHttp, type CompanionActions, type CompanionHttp, type LaunchResult, type SessionPayload } from "../src/core/companion-http.js";
import { describeError } from "../src/core/log.js";
import { readRunText } from "../src/core/run-storage.js";
import { RUN_FILES } from "../src/core/runs.js";
import type { TeamService } from "../src/core/team-service.js";
import type { RunMeta } from "../src/core/types.js";
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
    send: (ptyId, text, force) => sendTo(service, wire.supervisor, ptyId, text, force),
    stop: async (ptyId) => {
      if (!service.isLive(ptyId)) throw new Error("That session has ended.");
      await service.killPty(ptyId);
    },
    launch: async (input) => {
      const result = await service.launchAgent(input.workspaceId, input.agentId, input.prompt || null, PHONE_SIZE);
      return { ptyId: result.ptyId, runId: result.runId };
    },
    continue: (runId, text) => carryOn(service, wire.supervisor, runId, text),
    saveNudges: (nudges) => {
      const current = service.getSettings().companion;
      return service.saveSettings({ companion: { ...current, nudges } }).companion.nudges;
    },
  };
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
    engines: service.listEngines().map((engine) => ({ id: engine.id, label: engine.label })),
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
  const live = query.ptyId ? service.listLive().find((session) => session.ptyId === query.ptyId) : undefined;
  const run = service.findRun(query.runId || live?.runId || "");
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
  const agent = (live?.agentId || run?.agentId) ? service.getAgent((live?.agentId || run?.agentId) as string) : null;
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
    canStop: Boolean(live),
  };
}

async function sendTo(service: TeamService, supervisor: PtySupervisor, ptyId: string, text: string, force: boolean): Promise<{ working: true } | { working: false }> {
  const live = service.listLive().find((session) => session.ptyId === ptyId);
  if (!live) throw new Error("That session has ended. Send again to pick it up.");
  if (live.working && !force) return { working: true };
  if (live.chatId) await service.sendChat(live.chatId, text, PHONE_SIZE);
  else await supervisor.send(ptyId, text);
  return { working: false };
}

async function carryOn(service: TeamService, supervisor: PtySupervisor, runId: string, text: string): Promise<LaunchResult> {
  const run = service.findRun(runId);
  if (!run) throw new Error("That run no longer exists.");
  const livePty = service.ptyByRun.get(runId);
  if (livePty) {
    if (text) {
      const sent = await sendTo(service, supervisor, livePty, text, false);
      if (sent.working) throw new CompanionHttpError("Still working.", 409, { working: true });
    }
    return { ptyId: livePty, runId };
  }
  if (run.chatId && service.listChats().some((chat) => chat.id === run.chatId)) {
    const result = text ? await service.sendChat(run.chatId, text, PHONE_SIZE) : await service.continueChat(run.chatId, PHONE_SIZE);
    return { ptyId: result.ptyId, runId: result.runId };
  }
  if (run.workspaceId && text) {
    const result = await service.startEngine({ workspaceId: run.workspaceId, engineId: run.engine, prompt: text, continueSession: true, ...PHONE_SIZE });
    return { ptyId: result.ptyId, runId: result.runId };
  }
  const result = await service.continueRun(runId, PHONE_SIZE);
  return { ptyId: result.ptyId, runId: result.runId };
}
