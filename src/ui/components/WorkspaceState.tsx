import type { LiveSession } from "../../shared/api.js";
import type { Attention } from "../attention.js";
import { useT } from "../i18n/index.js";
import { tipProps } from "./Tooltip.js";

export type WorkspaceMark = Attention | "working" | "open";

/** What a workspace's terminals are up to, most urgent first; null when none are open. */
export function workspaceMark(workspaceId: string, live: readonly LiveSession[], attention: ReadonlyMap<string, Attention>): WorkspaceMark | null {
  const flagged = attention.get(workspaceId);
  if (flagged) return flagged;
  const sessions = live.filter((session) => session.workspaceId === workspaceId);
  if (sessions.some((session) => session.working)) return "working";
  return sessions.length ? "open" : null;
}

/** One pixel for a workspace: open, a CLI working, a CLI waiting for you, or one that finished. */
export function WorkspaceState({ mark, count, strip }: { mark: WorkspaceMark | null; count: number; strip?: boolean }) {
  const t = useT();
  if (!mark) return null;
  const tip = mark === "open" ? t.count("code.running", count) : t(`ws.${mark}`);
  return <span className={`ws-state ${mark}${strip ? " in-strip" : ""}`} role="img" aria-label={tip} {...tipProps(tip)} />;
}

/**
 * A plain shell's number among the shells open in its workspace, by when they started, so two of
 * them read "Shell 1" and "Shell 2" in Code and on Home alike. Null when it is the only one.
 */
export function shellNumber(ptyId: string | null | undefined, live: readonly LiveSession[]): number | null {
  const session = live.find((item) => item.ptyId === ptyId);
  if (!session || session.kind !== "shell" || !session.workspaceId) return null;
  const shells = live
    .filter((item) => item.kind === "shell" && item.workspaceId === session.workspaceId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.ptyId.localeCompare(b.ptyId));
  return shells.length > 1 ? shells.indexOf(session) + 1 : null;
}
