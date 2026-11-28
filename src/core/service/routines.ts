import path from "node:path";
import { typedIn } from "../../shared/terminal-input.js";
import { isPathInside } from "../places.js";
import {
  classifyRoutineTurn,
  decideRoutineTick,
  decideRunNow,
  DEFAULT_ROUTINE_TIMEOUT_MINUTES,
  describeSchedule,
  failStreak,
  firedAtOrAfter,
  isRoutineTimeoutValid,
  isScheduleValid,
  mostRecentSlot,
  nextFireTimes,
  ROUTINE_FAILING,
  type TickDecision,
} from "../routines.js";
import { allocateRunDir } from "../runs.js";
import type { Bin } from "../trash.js";
import type { Agent, Routine, RunMeta, Schedule } from "../types.js";
import { applyToWorkspace, copyPatch, leftInCopy, lockCopy, ownedCopyPath, removeCopy, repoRoot, unlockCopy, type ApplyResult, type CopyOwner, type WorkingCopy } from "../worktrees.js";
import type { Deleted, Launched, Queued, RoutineInput, RoutineView, SchedulePreview, TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";
import type { MessageDesk } from "./messages.js";
import type { TaskDesk } from "./tasks.js";
import type { FolderTurns } from "./turns.js";

/** Initial screen check delay for a routine whose CLI might open directly on a trust or login question. */
const ROUTINE_STUCK_MS = 30_000;
/** How many recent runs are attached to each routine view for its run list. */
const ROUTINE_RECENT_RUNS = 5;

interface ActiveRoutineRun {
  routineId: string;
  ptyId: string;
  words: string;
  sent: string;
  activeSince: number;
  unwatch: (() => void) | null;
  timer: NodeJS.Timeout | null;
  questionNotified: boolean;
}

/** Routines: scheduled prompts for an agent, fired by `tick`. */
export class RoutineDesk {
  private readonly activeRuns = new Map<string, ActiveRoutineRun>();

  constructor(
    private readonly core: ServiceCore,
    private readonly turns: FolderTurns,
    private readonly tasks: TaskDesk,
    private readonly messages: MessageDesk,
  ) {}

  close(): void {
    for (const runId of [...this.activeRuns.keys()]) this.clearActive(runId);
  }

  private copyId(routineId: string): string {
    return `routine-${routineId}`;
  }

  private copyOwner(routineId: string): CopyOwner {
    return { dataRoot: this.core.options.dataRoot, taskId: this.copyId(routineId) };
  }

  private workspaceNameFor(folder: string | null): string | null {
    if (!folder) return null;
    const match = this.core.store
      .readWorkspaces()
      .workspaces.find((ws) => path.resolve(ws.path) === folder || isPathInside(path.resolve(ws.path), folder));
    return match?.name ?? path.basename(folder);
  }

  private async repoTrusted(agent: Agent | null, copy: WorkingCopy): Promise<boolean> {
    const folder = agent ? this.core.firstPlace(agent.places) : null;
    const repo = folder ? await repoRoot(folder) : null;
    return repo !== null && repo === path.resolve(copy.repo);
  }

  listRoutines(): RoutineView[] {
    this.pruneInactive();
    const now = this.core.now();
    return this.core.store.listRoutines().map((routine) => {
      const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
      const recent = this.core.store.queryRuns({ routineId: routine.id, limit: 20 });
      const last = recent[0] ?? null;
      const streak = failStreak(recent);
      const folder = agent ? this.core.firstPlace(agent.places) : null;
      const own = new Set(this.core.listLive().filter((session) => session.routineId === routine.id).map((session) => session.ptyId));
      const stillRunning = this.routineStillRunning(routine.id);
      const needsInput = Boolean(
        stillRunning &&
          this.core.listLive().some((session) => {
            if (!session.runId) return false;
            const run = this.core.store.getRun(session.runId);
            return run?.routineId === routine.id && (run.result === "question" || Boolean(session.needsInput));
          }),
      );
      const copyOwned = routine.copy ? Boolean(ownedCopyPath(this.copyOwner(routine.id), routine.copy.path)) : true;
      return {
        ...routine,
        agentName: agent?.name ?? null,
        issues: this.routineIssues(routine, agent),
        stillRunning,
        needsInput,
        description: describeSchedule(routine.schedule),
        nextFires: routine.enabled ? nextFireTimes(routine.schedule, now, 3).map((date) => date.toISOString()) : [],
        lastRun: last ? this.core.view(last) : null,
        recentRuns: recent.slice(0, ROUTINE_RECENT_RUNS).map((run) => this.core.view(run)),
        copyOwned,
        workspaceName: this.workspaceNameFor(folder),
        failStreak: streak,
        failing: streak >= ROUTINE_FAILING,
        writers: !routine.isolated && folder ? this.turns.writersNow(folder, own) : [],
        waiting: this.turns.waiting("routine", routine.id),
      };
    });
  }

  previewSchedule(schedule: Schedule): SchedulePreview {
    const valid = isScheduleValid(schedule);
    return {
      valid,
      description: describeSchedule(schedule),
      next: valid ? nextFireTimes(schedule, this.core.now(), 3).map((date) => date.toISOString()) : [],
    };
  }

  saveRoutine(input: RoutineInput): Routine {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the routine a name.");
    if (!input.agentId?.trim() || !this.core.store.getAgent(input.agentId)) throw new Error("Pick an agent for the routine.");
    const schedule: Schedule =
      input.schedule?.kind === "cron"
        ? { kind: "cron", expr: input.schedule.expr.trim().replace(/\s+/g, " ") }
        : { kind: "every", minutes: Math.round(Number(input.schedule?.minutes)) };
    if (!isScheduleValid(schedule)) {
      throw new Error(schedule.kind === "cron" ? "That cron expression is not valid (five fields, local time)." : "Intervals must be at least 5 minutes.");
    }
    if (!input.prompt?.trim()) throw new Error("Write the routine's prompt.");
    const existing = input.id ? this.core.store.getRoutine(input.id) : null;
    const timeoutMinutes =
      input.timeoutMinutes !== undefined
        ? Math.round(Number(input.timeoutMinutes))
        : (existing?.timeoutMinutes ?? DEFAULT_ROUTINE_TIMEOUT_MINUTES);
    if (!isRoutineTimeoutValid(timeoutMinutes)) throw new Error("Time limits must be between 5 minutes and 7 days.");
    if (existing?.copy && existing.agentId !== input.agentId) {
      throw new Error("Apply or discard the routine's copy before changing its agent.");
    }
    const routine: Routine = {
      id: existing?.id ?? this.core.freeId("routines", name, ".yaml", (id) => this.core.store.queryRuns({ routineId: id, limit: 1 }).length > 0),
      name,
      agentId: input.agentId,
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      schedule,
      prompt: input.prompt.trimEnd(),
      notify: typeof input.notify === "boolean" ? input.notify : (existing?.notify ?? true),
      timeoutMinutes,
      isolated: typeof input.isolated === "boolean" ? input.isolated : (existing?.isolated ?? false),
      copy: existing?.copy ?? null,
      lastFiredAt: existing?.lastFiredAt ?? null,
      lastMissedAt: existing?.lastMissedAt ?? null,
      shareCheckout: typeof input.shareCheckout === "boolean" ? input.shareCheckout : (existing?.shareCheckout ?? false),
    };
    // A new or rescheduled routine starts counting from now, not from a slot in the past.
    const scheduleChanged = !existing || JSON.stringify(existing.schedule) !== JSON.stringify(schedule);
    if (scheduleChanged) {
      routine.lastFiredAt = this.core.now().toISOString();
      routine.lastMissedAt = null;
    }
    this.core.store.writeRoutine(routine);
    this.core.emit("routines");
    return routine;
  }

  async deleteRoutine(id: string): Promise<Deleted> {
    const routine = this.core.store.getRoutine(id);
    const file = this.core.store.pathOf("routine", id);
    if (!routine || !file) throw new Error("That routine no longer exists.");
    for (const session of this.core.live.values()) {
      if (session.routineId === id && session.runId) await this.core.stopRun(session.runId);
    }
    this.turns.cancel("routine", id);
    const copy = routine.copy;
    const owner = this.copyOwner(id);
    const owned = copy ? ownedCopyPath(owner, copy.path) : null;
    const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
    const trusted = copy && owned ? await this.repoTrusted(agent, copy) : false;
    const locked = copy && owned?.real && trusted ? await lockCopy(copy, owner).catch(() => false) : false;
    let bin: Bin;
    try {
      bin = this.core.trash.stash(owned?.real ? [file, owned.real] : [file], copy && owned && trusted ? { kind: "copy", taskId: owner.taskId, copy } : undefined);
    } catch (error) {
      if (copy && locked) await unlockCopy(copy, owner).catch(() => undefined);
      throw error;
    }
    this.core.emit("routines");
    const deleted = this.core.keepForUndo(
      bin,
      () => {
        if (copy && locked) void unlockCopy(copy, owner).catch(() => undefined);
        this.core.emit("routines");
      },
      copy && owned ? () => (this.core.store.getRoutine(id) ? undefined : removeCopy(copy, owner, trusted).catch(() => undefined)) : undefined,
    );
    return copy && !owned ? { ...deleted, copyLeft: true } : deleted;
  }

  /**
   * Bring an isolated routine copy's changes into its folder as uncommitted edits. A clean apply
   * removes the copy (or nothing to apply); with conflicts or ignored files the copy stays.
   */
  async applyCopy(id: string): Promise<ApplyResult> {
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    if (!routine.copy) throw new Error("This routine has no separate copy.");
    if (this.routineStillRunning(id)) throw new Error("Stop the routine before applying its changes.");
    const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
    if (!(await this.repoTrusted(agent, routine.copy))) throw new Error("This routine's copy names another repository, so it was left alone.");
    const owner = this.copyOwner(id);
    const patch = await copyPatch(routine.copy, owner);
    const result = await applyToWorkspace(routine.copy, patch);
    const left = result.conflicts.length ? [] : await leftInCopy(routine.copy);
    if (left.length) result.left = { folder: routine.copy.path, files: left };
    if (!result.conflicts.length && !left.length) {
      await removeCopy(routine.copy, owner);
      const current = this.core.store.getRoutine(id) ?? routine;
      this.core.store.writeRoutine({ ...current, copy: null });
    }
    this.core.emit("routines");
    if (result.pulled) this.core.emit("workspaces");
    return result;
  }

  /** Throw an isolated routine's copy away, with Undo support. */
  async discardCopy(id: string): Promise<Deleted> {
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    if (this.routineStillRunning(id)) throw new Error("Stop the routine before discarding its copy.");
    const copy = routine.copy;
    const owner = this.copyOwner(id);
    const owned = copy ? ownedCopyPath(owner, copy.path) : null;
    const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
    const trusted = copy && owned ? await this.repoTrusted(agent, copy) : false;
    const locked = copy && owned?.real && trusted ? await lockCopy(copy, owner).catch(() => false) : false;
    let bin: Bin;
    try {
      bin = this.core.trash.stash(owned?.real ? [owned.real] : [], copy && owned && trusted ? { kind: "copy", taskId: owner.taskId, copy } : undefined);
    } catch (error) {
      if (copy && locked) await unlockCopy(copy, owner).catch(() => undefined);
      throw error;
    }
    this.core.store.writeRoutine({ ...(this.core.store.getRoutine(id) ?? routine), copy: null });
    this.core.emit("routines");
    const deleted = this.core.keepForUndo(
      bin,
      (restored) => {
        if (copy && locked) void unlockCopy(copy, owner).catch(() => undefined);
        const now = this.core.store.getRoutine(id);
        const back = copy !== null && now !== null && !now.copy && (!owned?.real || restored.includes(owned.real));
        if (back) this.core.store.writeRoutine({ ...now, copy });
        else if (copy && owned && !now && restored.length) void removeCopy(copy, owner, trusted).catch(() => undefined);
        this.core.emit("routines");
      },
      copy && owned
        ? () =>
            this.core.store.getRoutine(id)?.copy || (owned.real && this.core.trash.holds(owned.real))
              ? undefined
              : removeCopy(copy, owner, trusted).catch(() => undefined)
        : undefined,
    );
    return copy && !owned ? { ...deleted, copyLeft: true } : deleted;
  }

  setRoutineEnabled(id: string, enabled: boolean): Routine {
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    // Resuming does not replay the slots that passed while it was paused; pausing cancels any wait.
    if (!enabled) this.turns.cancel("routine", id);
    const next = { ...routine, enabled, ...(enabled && !routine.enabled ? { lastFiredAt: this.core.now().toISOString() } : {}) };
    this.core.store.writeRoutine(next);
    this.core.emit("routines");
    return next;
  }

  /**
   * Run a routine now. Like a due slot, it waits its turn while another coding CLI is busy in the
   * agent's folder, unless `now`, `isolated`, or the routine's `shareCheckout` says to start anyway.
   */
  async runRoutineNow(id: string, size: TermSize = {}, now = false): Promise<Launched | Queued> {
    await this.core.settled;
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    const agent = this.core.store.getAgent(routine.agentId);
    if (!agent) throw new Error("The routine's agent no longer exists.");
    const target = this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true });
    const engine = this.core.resolveEngine(target.engineId, { model: target.model });
    const decision = decideRunNow({
      allowRoutines: agent.allowRoutines,
      engineAvailable: Boolean(engine),
      previousStillRunning: this.routineStillRunning(routine.id),
    });
    if (!decision.ok) {
      throw new Error(
        decision.reason === "disallowed"
          ? `${agent.name} does not allow routines. Turn it on in the agent's settings.`
          : decision.reason === "engine-missing"
            ? this.core.engineMissingText(target.engineId)
            : "The previous run of this routine is still going.",
      );
    }
    return this.fire(routine.id, null, size, now);
  }

  /** Stop a routine waiting for its folder. A due slot that was waiting is let go, as if missed. */
  cancelWait(id: string): void {
    const waited = this.turns.waiting("routine", id);
    this.turns.cancel("routine", id);
    const routine = this.core.store.getRoutine(id);
    if (waited && routine) this.core.store.writeRoutine({ ...routine, lastFiredAt: this.core.now().toISOString() });
    this.core.emit("routines");
  }

  /**
   * Start a routine in the agent's first folder (or its own copy when `isolated` is on), taking
   * its turn there when sharing the checkout.
   */
  private async fire(id: string, scheduledAt: string | null, size: TermSize, now = false): Promise<Launched | Queued> {
    const found = this.core.store.getRoutine(id);
    const agent = found ? this.core.store.getAgent(found.agentId) : null;
    if (!found || !agent) throw new Error("That routine no longer exists.");
    const cwd = this.core.firstPlace(agent.places);
    if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
    if (found.isolated) {
      this.turns.cancel("routine", id);
      if (scheduledAt) this.core.store.writeRoutine({ ...found, lastFiredAt: scheduledAt });
      return this.launchRoutine(found, agent, size);
    }
    return this.turns.withFolderLock(cwd, async () => {
      const routine = this.core.store.getRoutine(id);
      const currentAgent = routine ? this.core.store.getAgent(routine.agentId) : null;
      if (!routine || !currentAgent) return { queued: true, behind: [] };
      if (
        scheduledAt &&
        (!routine.enabled ||
          !currentAgent.allowRoutines ||
          this.routineStillRunning(id) ||
          firedAtOrAfter(routine.lastFiredAt, new Date(scheduledAt)))
      ) {
        this.turns.cancel("routine", id);
        return { queued: true, behind: [] };
      }
      const busy = now || routine.shareCheckout || routine.isolated ? [] : await this.turns.busyIn(cwd);
      if (busy.length) {
        const first = !this.turns.waiting("routine", id);
        this.turns.enqueue({
          kind: "routine",
          id,
          folder: cwd,
          slot: scheduledAt,
          start: () => this.fire(id, scheduledAt && this.slotAfterWait(id, scheduledAt), size),
          failed: (message) => this.failedStart(routine, currentAgent, message, scheduledAt && this.slotAfterWait(id, scheduledAt)),
        });
        // A due slot is nobody's click: say once that it is waiting, and for whom.
        if (first && scheduledAt) this.tell(routine, `waiting for ${busy.map((writer) => writer.label).join(", ")} to finish`);
        this.core.emit("routines");
        return { queued: true, behind: busy.map((writer) => writer.label) };
      }
      this.turns.cancel("routine", id);
      // Use up the slot first so a failed start never hot-loops on every tick.
      if (scheduledAt) this.core.store.writeRoutine({ ...routine, lastFiredAt: scheduledAt });
      return this.launchRoutine(routine, currentAgent, size);
    });
  }

  /**
   * The slot a routine that waited for its folder stands for once it starts: the newest one due by
   * then. A wait that ran past the next slot is one run, not one for each slot it waited through.
   */
  private slotAfterWait(id: string, lined: string): string {
    const routine = this.core.store.getRoutine(id);
    const latest = routine ? mostRecentSlot(routine.schedule, this.core.now())?.toISOString() : undefined;
    return latest && latest > lined ? latest : lined;
  }

  /** A start that failed with nobody watching: a failed run for a due slot, a notification for Run now. */
  private failedStart(routine: Routine, agent: Agent, message: string, scheduledAt: string | null): void {
    if (!scheduledAt) {
      this.tell(routine, message);
      return;
    }
    const current = this.core.store.getRoutine(routine.id);
    if (current?.lastFiredAt !== scheduledAt) {
      this.core.store.writeRoutine({ ...(current ?? routine), lastFiredAt: scheduledAt });
      this.core.emit("routines");
    }
    const latest = this.core.store.queryRuns({ routineId: routine.id, limit: 1 })[0];
    if (!latest || latest.startedAt < scheduledAt) this.recordFailedStart(routine, agent, message);
    // A spawn that failed has its run already.
    else this.core.notifyFinished(latest);
  }

  /** A note about a routine, when notifications are on for it. */
  private tell(routine: Routine, body: string, title: string = routine.name, runId?: string): void {
    if (!this.core.store.readSettings().notify || !routine.notify) return;
    this.core.options.host.notify({ title, body, routineId: routine.id, ...(runId ? { runId } : {}) });
  }

  /** A person answered a routine waiting on a question: clear its needs-input state and watch its next turn. */
  onHumanInput(ptyId: string, data: string): void {
    if (!typedIn(data)) return;
    this.pruneInactive();
    for (const [runId, entry] of this.activeRuns) {
      if (entry.ptyId !== ptyId) continue;
      entry.questionNotified = false;
      entry.activeSince = this.core.now().getTime();
      const session = this.core.live.get(ptyId);
      let changed = false;
      if (session?.needsInput) {
        this.core.live.set(ptyId, { ...session, needsInput: false });
        changed = true;
      }
      const run = this.core.store.getRun(runId);
      if (run?.result === "question") {
        this.core.store.saveRun({ ...run, result: undefined });
        changed = true;
      }
      this.armRun(runId, false);
      if (changed) this.core.emit("live", "runs", "routines");
      break;
    }
  }

  async tick(now: Date = this.core.now()): Promise<Array<{ routineId: string; decision: TickDecision; error?: string }>> {
    await this.core.settled;
    this.pruneInactive();
    if (this.activeRuns.size) {
      await this.messages.pump();
      // Give any screen reader resolved by pump() a turn to inspect and schedule exit before timeout/slot checks.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.enforceTimeouts(now);
    const results: Array<{ routineId: string; decision: TickDecision; error?: string }> = [];
    for (const routine of this.core.store.listRoutines()) {
      const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
      const engine = agent
        ? (() => {
            const target = this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true });
            return this.core.resolveEngine(target.engineId, { model: target.model });
          })()
        : null;
      const last = this.core.store.queryRuns({ routineId: routine.id, limit: 1 })[0] ?? null;
      const decision = decideRoutineTick({
        now,
        appStartedAt: this.core.options.appStartedAt,
        enabled: routine.enabled,
        allowRoutines: agent ? agent.allowRoutines : false,
        engineAvailable: Boolean(engine),
        schedule: routine.schedule,
        lastFiredAt: routine.lastFiredAt,
        previousStillRunning: this.routineStillRunning(routine.id),
        previousEndedAt: last?.endedAt ?? null,
      });
      results.push({ routineId: routine.id, decision });
      if (decision.action === "miss") {
        // Already queued behind a busy CLI: keep its wait instead of marking it missed while waiting.
        if (this.turns.waiting("routine", routine.id)) continue;
        if (routine.lastMissedAt !== decision.scheduledAt) {
          this.core.store.writeRoutine({ ...routine, lastMissedAt: decision.scheduledAt, lastFiredAt: decision.scheduledAt });
          this.core.emit("routines");
        }
      } else if (decision.action === "fire" && agent) {
        // Already in line for its folder: it starts from there.
        if (this.turns.waiting("routine", routine.id)) continue;
        const runsBefore = new Set(this.core.store.queryRuns({ routineId: routine.id, limit: 5 }).map((run) => run.id));
        try {
          await this.fire(routine.id, decision.scheduledAt, {});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results[results.length - 1].error = message;
          // A spawn failure has already recorded its run; a missing folder or CLI fails before
          // there is one, so record it here or the slot would pass with nothing to show for it.
          if (this.core.store.getRoutine(routine.id)?.lastFiredAt !== decision.scheduledAt) {
            this.core.store.writeRoutine({ ...(this.core.store.getRoutine(routine.id) ?? routine), lastFiredAt: decision.scheduledAt });
          }
          const recorded = this.core.store.queryRuns({ routineId: routine.id, limit: 5 }).find((run) => !runsBefore.has(run.id));
          if (!recorded) this.recordFailedStart(routine, agent, message);
          else this.core.notifyFinished(recorded);
        }
        this.core.emit("routines");
      }
    }
    return results;
  }

  private async launchRoutine(routine: Routine, agent: Agent, size: TermSize): Promise<Launched> {
    const folder = this.core.firstPlace(agent.places);
    if (!folder) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
    const workspace = this.core.store
      .readWorkspaces()
      .workspaces.find((ws) => path.resolve(ws.path) === folder || isPathInside(path.resolve(ws.path), folder));
    let cwd = folder;
    let workingCopy: { path: string; of: string } | null = null;
    let setupCommand: string | null = null;
    if (routine.isolated) {
      const prepared = await this.tasks.ensureCopy(
        this.copyId(routine.id),
        folder,
        routine.copy,
        "This routine's copy is not in VibeForge's worktrees folder, so it was left alone.",
        "This routine's copy names another repository, so it was left alone.",
        // Its workspace's "when a copy is made" setting, as a task's copy has.
        workspace?.copySetup,
      );
      cwd = prepared.cwd;
      setupCommand = prepared.setupCommand;
      workingCopy = { path: cwd, of: folder };
      if (prepared.created) {
        this.core.store.writeRoutine({ ...(this.core.store.getRoutine(routine.id) ?? routine), copy: prepared.copy });
        this.core.emit("routines");
      }
    }
    const target = this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true });
    const engine = this.core.requireEngine(target.engineId, { model: target.model });
    const promptText = this.core.preambleFor(agent, routine.prompt, null, workingCopy);
    const launched = await this.core.launch({
      origin: "routine",
      title: `${agent.name} · ${routine.name}`,
      engine,
      cwd,
      prompt: routine.prompt,
      promptText,
      agentId: agent.id,
      routineId: routine.id,
      ...(workspace ? { workspaceId: workspace.id } : {}),
      setupCommand,
      ...size,
    });
    this.watchLaunched(launched.runId, launched.ptyId, routine, promptText);
    return launched;
  }

  private watchLaunched(runId: string, ptyId: string, routine: Routine, sentText: string): void {
    if (!this.core.live.has(ptyId)) return;
    const words =
      sentText
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) ?? routine.prompt.slice(0, 80);
    this.clearActive(runId);
    this.activeRuns.set(runId, {
      routineId: routine.id,
      ptyId,
      words,
      sent: sentText,
      activeSince: this.core.now().getTime(),
      unwatch: null,
      timer: null,
      questionNotified: false,
    });
    this.armRun(runId, true);
  }

  private armRun(runId: string, initial: boolean): void {
    const entry = this.activeRuns.get(runId);
    if (!entry) return;
    entry.unwatch?.();
    if (entry.timer) clearTimeout(entry.timer);
    entry.unwatch = this.messages.watchRoutineTurn(entry.ptyId, {
      words: entry.words,
      sent: entry.sent,
      since: entry.activeSince - 1,
      ...(initial ? { stuckMs: ROUTINE_STUCK_MS } : {}),
      onTurn: (info) => this.handleTurn(runId, info),
    });
    const routine = this.core.store.getRoutine(entry.routineId);
    const limitMs = (routine?.timeoutMinutes ?? DEFAULT_ROUTINE_TIMEOUT_MINUTES) * 60_000;
    const elapsed = Math.max(0, this.core.now().getTime() - entry.activeSince);
    const delay = Math.max(10, limitMs - elapsed);
    entry.timer = setTimeout(() => void this.enforceTimeouts(this.core.now()), delay);
    entry.timer.unref?.();
  }

  private async handleTurn(
    runId: string,
    info: { reply: string | null; fromScreen: boolean; screen: string; hasLogReader: boolean },
  ): Promise<void> {
    const entry = this.activeRuns.get(runId);
    if (!entry) return;
    const session = this.core.live.get(entry.ptyId);
    const run = this.core.store.getRun(runId);
    if (!session || !run || run.status !== "running") {
      this.clearActive(runId);
      return;
    }
    const quietAt = Date.parse(session.quietAt ?? "");
    const worked = Number.isFinite(quietAt) && quietAt >= entry.activeSince - 1;
    const verdict = classifyRoutineTurn({
      reply: info.reply,
      screen: info.screen,
      fromScreen: info.fromScreen,
      hasLogReader: info.hasLogReader,
      worked,
    });
    if (verdict === "working") {
      const routine = this.core.store.getRoutine(entry.routineId);
      const limitMs = (routine?.timeoutMinutes ?? DEFAULT_ROUTINE_TIMEOUT_MINUTES) * 60_000;
      if (this.core.now().getTime() - entry.activeSince >= limitMs) return;
      // Nothing has run yet (slow CLI start): keep waiting for real turn completion without re-checking stuckMs.
      this.armRun(runId, false);
      return;
    }
    if (verdict === "question") {
      // Leave the session open for the person and suspend timeout while it awaits their answer.
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.unwatch = null;
      this.core.live.set(entry.ptyId, { ...session, needsInput: true });
      if (run.result !== "question") this.core.store.saveRun({ ...run, result: "question" });
      if (!entry.questionNotified) {
        entry.questionNotified = true;
        const routine = this.core.store.getRoutine(entry.routineId);
        if (routine) this.tell(routine, "waiting on a question", run.title, run.id);
      }
      this.core.emit("live", "runs", "routines");
      return;
    }
    this.clearActive(runId);
    await this.core.endRunWithResult(runId, { status: "exited", exitCode: 0, result: "finished" });
    await this.core.waitForExit(entry.ptyId, 200);
  }

  private async enforceTimeouts(now: Date): Promise<void> {
    this.pruneInactive();
    for (const session of [...this.core.live.values()]) {
      if (!session.runId) continue;
      const run = this.core.store.getRun(session.runId);
      if (!run || run.origin !== "routine" || !run.routineId || run.status !== "running" || run.result === "question") continue;
      if (run.result === "timeout") {
        await this.core.waitForExit(session.ptyId, 200);
        continue;
      }
      const routine = this.core.store.getRoutine(run.routineId);
      if (!routine) continue;
      const since = this.activeRuns.get(run.id)?.activeSince ?? Date.parse(run.startedAt);
      if (!Number.isFinite(since)) continue;
      if (now.getTime() - since < routine.timeoutMinutes * 60_000) continue;
      this.clearActive(run.id);
      await this.core.endRunWithResult(run.id, {
        status: "stopped",
        result: "timeout",
        error: "Stopped after reaching its time limit.",
      });
      await this.core.waitForExit(session.ptyId, 200);
    }
    await this.core.whenIdle();
  }

  private clearActive(runId: string): void {
    const entry = this.activeRuns.get(runId);
    if (!entry) return;
    this.activeRuns.delete(runId);
    entry.unwatch?.();
    if (entry.timer) clearTimeout(entry.timer);
  }

  private pruneInactive(): void {
    for (const [runId, entry] of this.activeRuns) {
      if (!this.core.live.has(entry.ptyId)) this.clearActive(runId);
    }
  }

  /** A routine that could not even start: a failed run, so Review shows why the slot passed. */
  private recordFailedStart(routine: Routine, agent: Agent, message: string): void {
    const started = this.core.now();
    const title = `${agent.name} · ${routine.name}`;
    const { id, dir } = allocateRunDir(this.core.options.dataRoot, started, title);
    const at = started.toISOString();
    const run: RunMeta = {
      id,
      origin: "routine",
      title,
      agentId: agent.id,
      routineId: routine.id,
      taskId: null,
      chatId: null,
      workspaceId: null,
      engine: agent.engine,
      argv: [],
      cwd: agent.places[0] ?? "",
      prompt: routine.prompt,
      startedAt: at,
      endedAt: at,
      status: "failed",
      exitCode: null,
      signal: null,
      stopRequested: false,
      openedAt: null,
      notifiedAt: null,
      dir,
      error: message,
      changes: null,
      gitStart: null,
      continuedFrom: null,
    };
    this.core.store.saveRun(run);
    this.core.notifyFinished(run);
    this.core.emit("runs");
  }

  private routineStillRunning(routineId: string): boolean {
    for (const session of this.core.live.values()) {
      if (!session.runId) continue;
      const run = this.core.store.getRun(session.runId);
      if (run?.routineId === routineId) return true;
    }
    return false;
  }

  private routineIssues(routine: Routine, agent: Agent | null): string[] {
    if (!agent) return ["The agent for this routine is gone."];
    const issues: string[] = [];
    if (!agent.allowRoutines) issues.push(`${agent.name} does not allow routines.`);
    const target = this.core.resolveLaunchTarget({ engineId: agent.engine, fromAgent: true });
    if (!this.core.resolveEngine(target.engineId, { model: target.model })) issues.push(this.core.engineMissingText(target.engineId));
    if (!this.core.firstPlace(agent.places)) issues.push("None of the agent's allowed folders exist.");
    if (!isScheduleValid(routine.schedule)) issues.push("The schedule is not valid.");
    if (!isRoutineTimeoutValid(routine.timeoutMinutes)) issues.push("Time limits must be between 5 minutes and 7 days.");
    return issues;
  }
}
