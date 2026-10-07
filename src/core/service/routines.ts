import path from "node:path";
import { decideRoutineTick, decideRunNow, describeSchedule, failStreak, firedAtOrAfter, isScheduleValid, mostRecentSlot, nextFireTimes, ROUTINE_FAILING, type TickDecision } from "../routines.js";
import { allocateRunDir } from "../runs.js";
import type { Agent, Routine, Schedule } from "../types.js";
import type { Deleted, Launched, Queued, RoutineInput, RoutineView, SchedulePreview, TermSize } from "./types.js";
import type { ServiceCore } from "./core.js";
import type { FolderTurns } from "./turns.js";

/** Routines: scheduled prompts for an agent, fired by `tick`. */
export class RoutineDesk {
  constructor(
    private readonly core: ServiceCore,
    private readonly turns: FolderTurns,
  ) {}

  listRoutines(): RoutineView[] {
    const now = this.core.now();
    return this.core.store.listRoutines().map((routine) => {
      const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
      const recent = this.core.store.queryRuns({ routineId: routine.id, limit: 20 });
      const last = recent[0] ?? null;
      const streak = failStreak(recent);
      const folder = agent ? this.core.firstPlace(agent.places) : null;
      const own = new Set(this.core.listLive().filter((session) => session.routineId === routine.id).map((session) => session.ptyId));
      return {
        ...routine,
        agentName: agent?.name ?? null,
        issues: this.routineIssues(routine, agent),
        stillRunning: this.routineStillRunning(routine.id),
        description: describeSchedule(routine.schedule),
        nextFires: routine.enabled ? nextFireTimes(routine.schedule, now, 3).map((date) => date.toISOString()) : [],
        lastRun: last ? this.core.view(last) : null,
        failStreak: streak,
        failing: streak >= ROUTINE_FAILING,
        writers: folder ? this.turns.writersNow(folder, own) : [],
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
    const routine: Routine = {
      id: existing?.id ?? this.core.store.uniqueId(path.join(this.core.options.configRoot, "routines"), name, ".yaml"),
      name,
      agentId: input.agentId,
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      schedule,
      prompt: input.prompt.trimEnd(),
      notify: typeof input.notify === "boolean" ? input.notify : (existing?.notify ?? true),
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

  deleteRoutine(id: string): Deleted {
    const file = this.core.store.pathOf("routine", id);
    if (!file) throw new Error("That routine no longer exists.");
    const bin = this.core.trash.stash([file]);
    this.turns.cancel("routine", id);
    this.core.emit("routines");
    return this.core.keepForUndo(bin, () => this.core.emit("routines"));
  }

  setRoutineEnabled(id: string, enabled: boolean): Routine {
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    // Resuming does not replay the slots that passed while it was paused.
    const next = { ...routine, enabled, ...(enabled && !routine.enabled ? { lastFiredAt: this.core.now().toISOString() } : {}) };
    this.core.store.writeRoutine(next);
    this.core.emit("routines");
    return next;
  }

  /**
   * Run a routine now. Like a due slot, it waits its turn while another coding CLI is busy in the
   * agent's folder, unless `now` or the routine's `shareCheckout` says to start anyway.
   */
  async runRoutineNow(id: string, size: TermSize = {}, now = false): Promise<Launched | Queued> {
    await this.core.settled;
    const routine = this.core.store.getRoutine(id);
    if (!routine) throw new Error("That routine no longer exists.");
    const agent = this.core.store.getAgent(routine.agentId);
    if (!agent) throw new Error("The routine's agent no longer exists.");
    const engine = this.core.resolveEngine(agent.engine);
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
            ? this.core.engineMissingText(agent.engine)
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
   * Start a routine in the agent's first folder, taking its turn there: with another coding CLI
   * busy, it waits in line and starts once that one is quiet. A due slot (`scheduledAt`) is only
   * used up when the run actually starts, so it isn't missed while it waits.
   */
  private async fire(id: string, scheduledAt: string | null, size: TermSize, now = false): Promise<Launched | Queued> {
    const found = this.core.store.getRoutine(id);
    const agent = found ? this.core.store.getAgent(found.agentId) : null;
    if (!found || !agent) throw new Error("That routine no longer exists.");
    const cwd = this.core.firstPlace(agent.places);
    if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
    return this.turns.withFolderLock(cwd, async () => {
      const routine = this.core.store.getRoutine(id) ?? found;
      if (scheduledAt && firedAtOrAfter(routine.lastFiredAt, new Date(scheduledAt))) return { queued: true, behind: [] };
      const busy = now || routine.shareCheckout ? [] : await this.turns.busyIn(cwd);
      if (busy.length) {
        this.turns.enqueue({
          kind: "routine",
          id,
          folder: cwd,
          start: () => this.fire(id, scheduledAt && this.slotAfterWait(id, scheduledAt), size),
          failed: (message) => this.failedStart(routine, agent, message, scheduledAt && this.slotAfterWait(id, scheduledAt)),
        });
        this.core.emit("routines");
        return { queued: true, behind: busy.map((writer) => writer.label) };
      }
      this.turns.cancel("routine", id);
      // Use up the slot first so a failed start never hot-loops on every tick.
      if (scheduledAt) this.core.store.writeRoutine({ ...routine, lastFiredAt: scheduledAt });
      return this.launchRoutine(routine, agent, size);
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
      this.core.options.host.notify({ title: routine.name, body: message, routineId: routine.id });
      return;
    }
    const latest = this.core.store.queryRuns({ routineId: routine.id, limit: 1 })[0];
    if (!latest || latest.startedAt < scheduledAt) this.recordFailedStart(routine, agent, message);
  }

  async tick(now: Date = this.core.now()): Promise<Array<{ routineId: string; decision: TickDecision; error?: string }>> {
    await this.core.settled;
    const results: Array<{ routineId: string; decision: TickDecision; error?: string }> = [];
    for (const routine of this.core.store.listRoutines()) {
      const agent = routine.agentId ? this.core.store.getAgent(routine.agentId) : null;
      const engine = agent ? this.core.resolveEngine(agent.engine) : null;
      const decision = decideRoutineTick({
        now,
        appStartedAt: this.core.options.appStartedAt,
        enabled: routine.enabled,
        allowRoutines: agent ? agent.allowRoutines : false,
        engineAvailable: Boolean(engine),
        schedule: routine.schedule,
        lastFiredAt: routine.lastFiredAt,
        previousStillRunning: this.routineStillRunning(routine.id),
      });
      results.push({ routineId: routine.id, decision });
      if (decision.action === "miss") {
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
          const recorded = this.core.store.queryRuns({ routineId: routine.id, limit: 5 }).some((run) => !runsBefore.has(run.id));
          if (!recorded) this.recordFailedStart(routine, agent, message);
        }
        this.core.emit("routines");
      }
    }
    return results;
  }

  private async launchRoutine(routine: Routine, agent: Agent, size: TermSize): Promise<Launched> {
    const cwd = this.core.firstPlace(agent.places);
    if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
    const engine = this.core.requireEngine(agent.engine);
    return this.core.launch({
      origin: "routine",
      title: `${agent.name} · ${routine.name}`,
      engine,
      cwd,
      prompt: routine.prompt,
      promptText: this.core.preambleFor(agent, routine.prompt),
      agentId: agent.id,
      routineId: routine.id,
      ...size,
    });
  }

  /** A routine that could not even start: a failed run, so Review shows why the slot passed. */
  private recordFailedStart(routine: Routine, agent: Agent, message: string): void {
    const started = this.core.now();
    const title = `${agent.name} · ${routine.name}`;
    const { id, dir } = allocateRunDir(this.core.options.dataRoot, started, title);
    const at = started.toISOString();
    this.core.store.saveRun({
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
    });
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
    if (!this.core.resolveEngine(agent.engine)) issues.push(this.core.engineMissingText(agent.engine));
    if (!this.core.firstPlace(agent.places)) issues.push("None of the agent's allowed folders exist.");
    if (!isScheduleValid(routine.schedule)) issues.push("The schedule is not valid.");
    return issues;
  }
}
