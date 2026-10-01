import path from "node:path";
import { isPathInside } from "./places.js";
import type { LiveSession, RunOrigin } from "./types.js";

// Who else is in a folder: the coding CLIs whose folder overlaps it. Pure; the service looks up
// each folder's repository and passes the answers in.

/**
 * How long a coding CLI keeps its turn after it goes quiet, or after it starts before it has done
 * anything. A pause between two steps, or a question it asked, doesn't hand the folder over.
 */
export const TURN_GRACE_MS = 30_000;

export interface Writer {
  ptyId: string;
  label: string;
  cwd: string;
  origin: RunOrigin | null;
  taskId: string | null;
  routineId: string | null;
  agentId: string | null;
  chatId: string | null;
  workspaceId: string | null;
  /** Working now, or within its turn: a task or routine waits for it. */
  busy: boolean;
}

/**
 * Two folders are one checkout when they are the same folder, or one is inside the other and
 * both belong to the same repository. A CLI in your home folder doesn't overlap every project.
 */
export function cwdOverlaps(folder: string, cwd: string, repoOfFolder: string | null, repoOfCwd: string | null): boolean {
  const a = path.resolve(folder);
  const b = path.resolve(cwd);
  if (a === b) return true;
  if (!repoOfFolder || repoOfFolder !== repoOfCwd) return false;
  return isPathInside(a, b) || isPathInside(b, a);
}

/** A coding CLI: a run VibeForge started, or one typed into a shell. A bare shell or vim isn't. */
export function isCodingCli(session: LiveSession): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

/** The folder a session's CLI is working in. */
export function sessionFolder(session: LiveSession): string {
  return session.programCwd || session.cwd;
}

/** Whether a coding CLI still has its turn: working, just quiet, or just started. */
export function hasTurn(session: LiveSession, now: number): boolean {
  if (session.working) return true;
  const since = Date.parse(session.quietAt ?? session.cliSince ?? session.startedAt);
  return Number.isFinite(since) && now - since < TURN_GRACE_MS;
}

/**
 * What to call a coding CLI in "also here": the CLI typed into a shell, or the run's title up to
 * its first " · " ("Claude Code · frontier-halls" is Claude Code; a task's run is its title).
 */
export function writerLabel(session: LiveSession): string {
  return session.program || session.title.split(" · ")[0] || session.title;
}

/** The coding CLIs in `folder`, other than the ones in `except`. `repos` maps a resolved folder to its repository. */
export function writersIn(
  live: readonly LiveSession[],
  folder: string,
  repos: ReadonlyMap<string, string | null>,
  now: number,
  except: ReadonlySet<string> = new Set(),
): Writer[] {
  const repoOf = (dir: string) => repos.get(path.resolve(dir)) ?? null;
  const own = repoOf(folder);
  return live
    .filter((session) => !except.has(session.ptyId) && isCodingCli(session))
    .filter((session) => cwdOverlaps(folder, sessionFolder(session), own, repoOf(sessionFolder(session))))
    .map((session) => ({
      ptyId: session.ptyId,
      label: writerLabel(session),
      cwd: sessionFolder(session),
      origin: session.origin,
      taskId: session.taskId,
      routineId: session.routineId ?? null,
      agentId: session.agentId,
      chatId: session.chatId,
      workspaceId: session.workspaceId,
      busy: hasTurn(session, now),
    }));
}
