import crypto from "node:crypto";
import path from "node:path";
import { cwdAllowed, isPathInside } from "./places.js";
import type { CompanionSettings, LiveSession } from "./types.js";

/** Loopback port the phone page uses. Tailscale Serve publishes this, the app does not. */
export const COMPANION_PORT = 4737;

/** How long a finished run stays on the phone desk. */
export const COMPANION_RECENT_MS = 36 * 60 * 60 * 1000;

/** Finished rows kept under one workspace, so a busy day does not fill the phone. */
export const COMPANION_DONE_CAP = 4;

export const DEFAULT_NUDGES = [
  "Keep going.",
  "Commit what you have and tell me what changed.",
  "Stop and summarize where things stand.",
] as const;

export function defaultCompanion(): CompanionSettings {
  return {
    enabled: false,
    port: COMPANION_PORT,
    token: "",
    nudges: [...DEFAULT_NUDGES],
  };
}

export function newCompanionToken(): string {
  return `vf_${crypto.randomBytes(16).toString("hex")}`;
}

function companionPort(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const port = Math.round(value);
  return port >= 1024 && port <= 65535 ? port : fallback;
}

function companionToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  return /^vf_[0-9a-f]{32}$/.test(token) ? token : "";
}

/** Missing becomes the defaults. An explicit empty list stays empty. */
export function normalizeNudges(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const next = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 240))
    .filter((item) => item.length > 0);
  return [...new Set(next)].slice(0, 8);
}

export function normalizeCompanion(value: unknown): CompanionSettings {
  const defaults = defaultCompanion();
  const raw = value && typeof value === "object" ? (value as Partial<CompanionSettings>) : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    port: companionPort(raw.port, defaults.port),
    token: companionToken(raw.token),
    nudges: normalizeNudges(raw.nudges, defaults.nudges),
  };
}

/** True when `given` is the pairing code. A mismatch tells the caller nothing about the code. */
export function tokenMatches(have: string, given: string): boolean {
  if (!have || !given) return false;
  const left = Buffer.from(have);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

/** The end of a transcript or a screen, capped so a long run does not cross the network whole. */
export function tailText(text: string, maxLines: number, maxChars: number): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "").split("\n");
  let sliced = lines.slice(-Math.max(1, maxLines)).join("\n").trim();
  if (sliced.length > maxChars) sliced = sliced.slice(-maxChars);
  return sliced;
}

export type DeskState = "working" | "waiting" | "done";

export interface DeskSession {
  ptyId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  state: DeskState;
  startedAt: string;
  endedAt: string | null;
  changes: string | null;
  alsoHere: string[];
}

export interface DeskWorkspace {
  id: string;
  name: string;
  path: string;
  folder: string;
  sessions: DeskSession[];
}

export interface DeskAgent {
  id: string;
  name: string;
  engine: string;
  workspaceIds: string[];
}

export interface DeskPayload {
  nudges: string[];
  agents: DeskAgent[];
  /** The coding CLIs installed here, for starting one without an agent. */
  engines: Array<{ id: string; label: string }>;
  workspaces: DeskWorkspace[];
}

export interface DeskRun {
  id: string;
  title: string;
  agentId: string | null;
  engine: string;
  cwd: string;
  workspaceId: string | null;
  startedAt: string;
  endedAt: string | null;
  changes: string | null;
  status: string;
}

export interface DeskInput {
  workspaces: Array<{ id: string; name: string; path: string }>;
  agents: Array<{ id: string; name: string; engine: string; places: string[] }>;
  engines: Array<{ id: string; label: string; available?: boolean }>;
  live: LiveSession[];
  recent: DeskRun[];
  nudges: string[];
  now: number;
}

/** A coding CLI's session: a run's own terminal, or a shell with a CLI in its foreground. A bare shell is not one. */
export function isCodingSession(session: Pick<LiveSession, "kind" | "programEngineId">): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

const STATE_RANK: Record<DeskState, number> = { working: 0, waiting: 1, done: 2 };

function engineLabel(engines: Array<{ id: string; label: string }>, id: string | null | undefined): string {
  if (!id) return "";
  return engines.find((engine) => engine.id === id)?.label ?? id;
}

function folderOf(cwd: string, workspaceId: string | null, workspaces: DeskInput["workspaces"]): string | null {
  if (workspaceId && workspaces.some((workspace) => workspace.id === workspaceId)) return workspaceId;
  if (!cwd) return null;
  let best: { id: string; length: number } | null = null;
  for (const workspace of workspaces) {
    if (!workspace.path || !isPathInside(workspace.path, cwd)) continue;
    const length = path.resolve(workspace.path).length;
    if (!best || length > best.length) best = { id: workspace.id, length };
  }
  return best?.id ?? null;
}

function isRecent(run: DeskRun, now: number): boolean {
  const stamp = Date.parse(run.endedAt || run.startedAt);
  return Number.isFinite(stamp) && now - stamp <= COMPANION_RECENT_MS && now - stamp >= 0;
}

/**
 * The phone's desk: each workspace, the coding sessions in it, and which agents may start there.
 * An idle shell is left out. A finished run stays for a day and a half, a few per workspace.
 */
export function buildDesk(input: DeskInput): DeskPayload {
  const agentName = new Map(input.agents.map((agent) => [agent.id, agent.name]));
  const groups = new Map<string, DeskSession[]>(input.workspaces.map((workspace) => [workspace.id, []]));
  const elsewhere: DeskSession[] = [];
  const liveRunIds = new Set<string>();

  const place = (workspaceId: string | null, session: DeskSession) => {
    if (workspaceId && groups.has(workspaceId)) groups.get(workspaceId)?.push(session);
    else elsewhere.push(session);
  };

  for (const session of input.live) {
    if (!isCodingSession(session)) continue;
    if (session.runId) liveRunIds.add(session.runId);
    const agent = session.agentId ? agentName.get(session.agentId) : undefined;
    const title = agent || session.program || session.title;
    const detail = engineLabel(input.engines, session.programEngineId);
    place(folderOf(session.programCwd || session.cwd, session.workspaceId, input.workspaces), {
      ptyId: session.ptyId,
      runId: session.runId,
      title,
      detail: detail && detail !== title ? detail : "",
      state: session.working ? "working" : "waiting",
      startedAt: session.cliSince || session.startedAt,
      endedAt: null,
      changes: null,
      alsoHere: (session.alsoHere ?? []).map((other) => other.label).filter((label) => label && label !== title),
    });
  }

  const doneByWorkspace = new Map<string, DeskSession[]>();
  const recent = input.recent
    .filter((run) => run.status !== "running" && !liveRunIds.has(run.id) && isRecent(run, input.now))
    .sort((a, b) => (b.endedAt || b.startedAt).localeCompare(a.endedAt || a.startedAt));
  for (const run of recent) {
    const workspaceId = folderOf(run.cwd, run.workspaceId, input.workspaces);
    const key = workspaceId ?? "";
    const list = doneByWorkspace.get(key) ?? [];
    if (list.length >= COMPANION_DONE_CAP) continue;
    const agent = run.agentId ? agentName.get(run.agentId) : undefined;
    const title = agent || run.title;
    const detail = engineLabel(input.engines, run.engine);
    const session: DeskSession = {
      ptyId: null,
      runId: run.id,
      title,
      detail: detail && detail !== title ? detail : "",
      state: "done",
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      changes: run.changes,
      alsoHere: [],
    };
    list.push(session);
    doneByWorkspace.set(key, list);
  }
  for (const [id, sessions] of doneByWorkspace) {
    if (id && groups.has(id)) groups.get(id)?.push(...sessions);
    else elsewhere.push(...sessions);
  }

  const order = (sessions: DeskSession[]) =>
    sessions.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.startedAt.localeCompare(a.startedAt));

  const workspaces: DeskWorkspace[] = input.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    folder: path.basename(workspace.path) || workspace.name,
    sessions: order(groups.get(workspace.id) ?? []),
  }));
  if (elsewhere.length) {
    workspaces.push({ id: "", name: "Elsewhere", path: "", folder: "", sessions: order(elsewhere) });
  }

  const agents: DeskAgent[] = input.agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      engine: engineLabel(input.engines, agent.engine) || agent.engine,
      workspaceIds: input.workspaces.filter((workspace) => cwdAllowed(workspace.path, agent.places)).map((workspace) => workspace.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const engines = input.engines.filter((engine) => engine.available !== false).map((engine) => ({ id: engine.id, label: engine.label }));
  return { nudges: input.nudges, agents, engines, workspaces };
}
