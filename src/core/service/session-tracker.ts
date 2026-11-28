import { LOCAL_ENGINE_ID } from "../local.js";
import { replyLogFor, type ReplyLog } from "../replies.js";
import { matchSessionLogs, resumeArgsFor, sessionIdOf, type SessionLog, type TrackedRun } from "../session-ids.js";
import type { ServiceCore } from "./core.js";

/** How often live CLIs' session logs are looked at. */
const LOOK_MS = 8000;

/**
 * Keeps each live run's exact session on its record while it runs (`resumeArgs`), read from the
 * CLI's own session log, so a run cut off by VibeForge closing reopens the session it was in. A
 * CLI killed at quit often never prints its "--resume <id>" line, and the folder's latest session
 * is the wrong one when two of them share a folder.
 */
export class SessionTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Each log's mtime at the last look, to see which grew since. */
  private before = new Map<string, number>();
  /** Each live run's log, as matched so far. */
  private files = new Map<string, string>();
  private lastLook = 0;
  private looking: Promise<void> | null = null;

  constructor(private readonly core: ServiceCore) {}

  start(): void {
    if (this.timer || !this.core.options.host.sessionLogs) return;
    this.timer = setInterval(() => void this.look(), LOOK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Look now (one look at a time); resolves when done. A failure is ignored: the next look tries again. */
  look(): Promise<void> {
    this.looking ??= this.lookOnce()
      .catch(() => undefined)
      .finally(() => {
        this.looking = null;
      });
    return this.looking;
  }

  private kindOf(engine: string, localHarness: string | null | undefined): ReplyLog | null {
    if (engine === LOCAL_ENGINE_ID) return localHarness ? replyLogFor(localHarness, localHarness) : null;
    const row = this.core.store.readEngineRows().find((item) => item.id === engine);
    return replyLogFor(engine, row?.bin ?? engine);
  }

  private async lookOnce(): Promise<void> {
    const find = this.core.options.host.sessionLogs;
    if (!find) return;
    const now = this.core.now().getTime();
    const since = this.lastLook || now;
    const runs: TrackedRun[] = [];
    for (const session of this.core.live.values()) {
      if (!session.runId) continue;
      if (session.kind === "shell" && !session.programEngineId) continue;
      const run = this.core.store.getRun(session.runId);
      if (!run || run.status !== "running") continue;
      const kind = this.kindOf(run.engine, run.localHarness);
      if (!kind || kind === "opencode") continue;
      const quiet = session.quietAt ? Date.parse(session.quietAt) : NaN;
      runs.push({
        runId: run.id,
        kind,
        cwd: run.cwd,
        startedMs: Date.parse(run.startedAt),
        active: Boolean(session.working) || (Number.isFinite(quiet) && quiet >= since - 1000),
        file: this.files.get(run.id) ?? null,
      });
    }
    const liveIds = new Set(runs.map((run) => run.runId));
    for (const runId of [...this.files.keys()]) if (!liveIds.has(runId)) this.files.delete(runId);
    // Only folders where something may have changed: a run still unmatched, or one that worked.
    const groups = new Map<string, TrackedRun[]>();
    for (const run of runs) {
      const key = `${run.kind}\u0000${run.cwd}`;
      groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    const logs = new Map<string, SessionLog[]>();
    const looked: TrackedRun[] = [];
    for (const [key, group] of groups) {
      if (!group.some((run) => run.active || !run.file)) continue;
      const earliest = Math.min(...group.map((run) => run.startedMs));
      logs.set(key, await find({ kind: group[0].kind, cwd: group[0].cwd, since: earliest }));
      looked.push(...group);
    }
    this.lastLook = now;
    if (!looked.length) return;
    const matched = matchSessionLogs(looked, logs, this.before);
    for (const list of logs.values()) for (const log of list) this.before.set(log.file, log.mtimeMs);
    if (this.before.size > 2000) this.before = new Map([...this.before].slice(-1000));
    for (const run of looked) {
      const file = matched.get(run.runId);
      if (!file || file === run.file) continue;
      this.files.set(run.runId, file);
      const id = sessionIdOf(run.kind, file);
      const args = id ? resumeArgsFor(run.kind, id) : null;
      if (!args) continue;
      const latest = this.core.store.getRun(run.runId);
      if (!latest || latest.status !== "running" || sameArgs(latest.resumeArgs, args)) continue;
      this.core.store.saveRun({ ...latest, resumeArgs: args });
    }
  }
}

function sameArgs(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  return Boolean(a) && a?.length === b.length && a.every((item, index) => item === b[index]);
}
