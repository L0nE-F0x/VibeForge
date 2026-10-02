import fs from "node:fs";
import path from "node:path";
import { newCompanionToken, normalizeCompanion } from "../companion.js";
import { planLaunch, resumeArgsFromTranscript, withAvailability } from "../engines.js";
import { isDirectory, readText, writeFileAtomic } from "../fsx.js";
import { diffSince, summarizeSnapshot } from "../vcs.js";
import { buildPreamble } from "../preamble.js";
import { allocateRunDir, RUN_FILES } from "../runs.js";
import { hasRunFile } from "../run-storage.js";
import { Store } from "../store.js";
import { Trash, type Bin } from "../trash.js";
import { syncTaskWithRun } from "../tasks.js";
import type { Agent, Engine, EngineRow, LiveSession, RunMeta, RunOrigin, Settings, Topic, Workspace } from "../types.js";
import { type Deleted, type DeskOptions, LATE_PATCH_NOTE, type Launched, type RunView, UNDO_MS } from "./types.js";

/**
 * The state every part of the service shares, and the lifecycle of a run: launching it, its exit,
 * and what is written when it ends. The desks in this folder hold the rest; `TeamService` puts
 * them together behind one API.
 */
export class ServiceCore {
  readonly options: DeskOptions;
  readonly store: Store;
  readonly live = new Map<string, LiveSession>();
  readonly ptyByRun = new Map<string, string>();
  private readonly listeners = new Set<(topics: Topic[]) => void>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly finishing = new Set<Promise<void>>();
  /** Per shell: the latest command line in its foreground, and the queue that records it. */
  readonly shellArgv = new Map<string, string[]>();
  readonly recordings = new Map<string, Promise<void>>();
  /** Per shell: the host's last word on activity, kept while no coding CLI is in front to use it. */
  readonly hostWorking = new Map<string, boolean>();
  /** The git snapshot when a shell run started: a tree that was already dirty isn't this run's doing. */
  readonly gitAtStart = new Map<string, string>();
  readonly trash: Trash;
  private readonly undoable = new Map<string, { bin: Bin; restore: () => void; timer: ReturnType<typeof setTimeout>; settle?: () => void }>();
  private pending = new Set<Topic>();
  private flushQueued = false;
  readonly settled: Promise<void>;

  constructor(options: DeskOptions) {
    this.options = options;
    this.store = new Store(options.configRoot, options.dataRoot);
    // Anything left in the trash was deleted in an earlier session, past its undo.
    this.trash = new Trash(path.join(options.dataRoot, "trash"));
    this.trash.empty();
    // Anything still "running" in the index belongs to a process that died with the last app session.
    const orphans = this.store.queryRuns({ status: "running", limit: 2000 });
    this.settled = this.settleOrphans(orphans);
  }

  whenSettled(): Promise<void> {
    return this.settled;
  }

  now(): Date {
    return this.options.now();
  }

  close(): void {
    for (const entry of this.undoable.values()) clearTimeout(entry.timer);
    const settling = [...this.undoable.values()].flatMap((entry) => (entry.settle ? [entry.settle] : []));
    this.undoable.clear();
    this.trash.empty();
    for (const settle of settling) settle();
    this.store.close();
  }

  // ---------------------------------------------------------------- undo

  /**
   * Keep a delete undoable for a while; after that its files go for good, and `settle` tidies
   * whatever lived outside them (a task copy's git branch).
   */
  keepForUndo(bin: Bin, restore: () => void, settle?: () => void): Deleted {
    const timer = setTimeout(() => {
      this.undoable.delete(bin.token);
      this.trash.drop(bin);
      settle?.();
    }, UNDO_MS);
    timer.unref?.();
    this.undoable.set(bin.token, { bin, restore, timer, settle });
    return { undo: bin.token };
  }

  /** Put back what a delete removed. */
  undoDelete(token: string): void {
    const entry = this.undoable.get(token);
    if (!entry) throw new Error("It is too late to undo that.");
    clearTimeout(entry.timer);
    this.undoable.delete(token);
    this.trash.restore(entry.bin);
    entry.restore();
  }

  // ---------------------------------------------------------------- events

  onChange(listener: (topics: Topic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(...topics: Topic[]): void {
    for (const topic of topics) this.pending.add(topic);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const batch = [...this.pending];
      this.pending = new Set();
      if (batch.length === 0) return;
      for (const listener of this.listeners) {
        try {
          listener(batch);
        } catch {
          /* a listener failing must not break the service */
        }
      }
    });
  }

  // ---------------------------------------------------------------- settings & engines

  getSettings(): Settings {
    return this.store.readSettings();
  }

  saveSettings(patch: Partial<Omit<Settings, "companion">> & { companion?: Partial<Settings["companion"]> }): Settings {
    const current = this.store.readSettings();
    const { companion: companionPatch, ...rest } = patch;
    const next: Settings = { ...current, ...rest };
    // A partial phone-page patch must not drop the pairing code or the saved nudges.
    if (companionPatch) {
      next.companion = normalizeCompanion({ ...current.companion, ...companionPatch });
      if (next.companion.enabled && !next.companion.token) next.companion.token = newCompanionToken();
    }
    this.store.writeSettings(next);
    this.emit("settings");
    return this.store.readSettings();
  }

  listEngines(): Engine[] {
    return withAvailability(this.store.readEngineRows(), (bin) => this.options.host.resolveBin(bin));
  }

  saveEngines(rows: EngineRow[]): Engine[] {
    this.store.writeEngineRows(rows);
    this.emit("engines", "agents", "routines", "tasks");
    return this.listEngines();
  }

  resolveEngine(engineId: string): { row: EngineRow; binPath: string } | null {
    const row = this.store.readEngineRows().find((engine) => engine.id === engineId);
    if (!row) return null;
    const binPath = this.options.host.resolveBin(row.bin);
    return binPath ? { row, binPath } : null;
  }

  requireEngine(engineId: string): { row: EngineRow; binPath: string } {
    const engine = this.resolveEngine(engineId);
    if (engine) return engine;
    const row = this.store.readEngineRows().find((item) => item.id === engineId);
    throw new Error(row ? `${row.label} (${row.bin}) is not on PATH.` : `There is no engine called "${engineId}".`);
  }

  engineMissingText(engineId: string): string {
    const row = this.store.readEngineRows().find((item) => item.id === engineId);
    return row ? `${row.label} (${row.bin}) is not on PATH.` : `The engine "${engineId}" is not configured.`;
  }

  workspaceById(id: string | null | undefined): Workspace | null {
    if (!id) return null;
    return this.store.readWorkspaces().workspaces.find((item) => item.id === id) ?? null;
  }

  // ---------------------------------------------------------------- runs

  view(run: RunMeta): RunView {
    const ptyId = this.ptyByRun.get(run.id) ?? null;
    return { ...run, live: Boolean(ptyId), ptyId };
  }


  async stopRun(id: string): Promise<void> {
    const run = this.store.getRun(id);
    if (!run || run.status !== "running") return;
    const ptyId = this.ptyByRun.get(id);
    this.store.saveRun({ ...run, stopRequested: true });
    if (ptyId) {
      await this.options.host.kill(ptyId);
      return;
    }
    await this.finishRun(run.id, { exitCode: null, signal: null, status: "stopped" });
  }


  /**
   * How to pick a finished session back up with the same engine: its exact session id when the
   * CLI printed one, the engine's continue flag otherwise, or not at all.
   */
  resumePlan(row: EngineRow, previous: RunMeta | null): { native: boolean; resumeArgs: string[] | null } {
    // A different CLI cannot pick up another CLI's session; start fresh with the transcript instead.
    if (!previous || previous.engine !== row.id) return { native: false, resumeArgs: null };
    if (previous.dir) {
      const resumeArgs = resumeArgsFromTranscript(row, readText(path.join(previous.dir, RUN_FILES.transcript)));
      if (resumeArgs) return { native: true, resumeArgs };
    }
    return { native: Boolean(row.continueArgs?.length), resumeArgs: null };
  }

  transcriptPath(run: RunMeta): string | null {
    if (!run.dir) return null;
    for (const file of [RUN_FILES.transcript, RUN_FILES.scrollback]) {
      const full = path.join(run.dir, file);
      try {
        if (fs.statSync(full).size > 0) return full;
      } catch {
        /* try the next file */
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- live sessions

  listLive(): LiveSession[] {
    return [...this.live.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  liveCount(): number {
    return this.live.size;
  }

  /** Close a terminal. A run is stopped (and keeps its transcript); a shell just ends. */
  async killPty(ptyId: string): Promise<void> {
    const session = this.live.get(ptyId);
    if (session?.runId) {
      await this.stopRun(session.runId);
      return;
    }
    await this.options.host.kill(ptyId);
  }

  isLive(ptyId: string): boolean {
    return this.live.has(ptyId);
  }

  /** Resolves once the PTY has exited and its run is finished, or after the timeout. */
  waitForExit(ptyId: string, timeoutMs: number): Promise<void> {
    if (!this.live.has(ptyId)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.exitWaiters.get(ptyId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.exitWaiters.set(ptyId, list);
    });
  }

  // ---------------------------------------------------------------- launching

  preambleFor(agent: Agent, prompt: string, priorTranscript: string | null = null, workingCopy: { path: string; of: string } | null = null): string {
    const skills = agent.skills.flatMap((id) => {
      const skill = this.store.getSkill(id);
      return skill ? [{ name: skill.name, body: skill.body }] : [];
    });
    return buildPreamble({
      agentName: agent.name,
      places: agent.places,
      brief: agent.brief,
      memory: this.store.readMemory(agent.id),
      skills,
      prompt,
      priorTranscript,
      workingCopy,
    });
  }

  async launch(input: {
    origin: RunOrigin;
    title: string;
    engine: { row: EngineRow; binPath: string };
    cwd: string;
    /** What the human asked for, kept for the record. */
    prompt: string;
    /** What reaches the CLI as its first message: a preamble, the plain prompt, or nothing. */
    promptText: string | null;
    /** Text pasted after a continued session loads. */
    pasteAfter?: string | null;
    continueSession?: boolean;
    /** The exact session to reopen, read from the previous run's transcript. */
    resumeArgs?: string[] | null;
    agentId?: string | null;
    routineId?: string | null;
    taskId?: string | null;
    chatId?: string | null;
    workspaceId?: string | null;
    continuedFrom?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<Launched> {
    const started = this.now();
    const { id, dir } = allocateRunDir(this.options.dataRoot, started, input.title);
    const preamblePath = path.join(dir, RUN_FILES.preamble);
    writeFileAtomic(preamblePath, input.promptText ?? "");
    const plan = planLaunch(input.engine.row, input.engine.binPath, {
      prompt: input.promptText,
      continueSession: input.continueSession,
      resumeArgs: input.resumeArgs,
      promptFile: preamblePath,
    });
    const pasteInput = plan.pasteInput ?? input.pasteAfter ?? null;
    let gitStart: string | null = null;
    try {
      gitStart = await this.options.host.gitHead(input.cwd);
    } catch {
      gitStart = null;
    }
    const meta: RunMeta = {
      id,
      origin: input.origin,
      title: input.title,
      agentId: input.agentId ?? null,
      routineId: input.routineId ?? null,
      taskId: input.taskId ?? null,
      chatId: input.chatId ?? null,
      workspaceId: input.workspaceId ?? null,
      engine: input.engine.row.id,
      argv: plan.recordArgv,
      cwd: input.cwd,
      prompt: input.prompt,
      startedAt: started.toISOString(),
      endedAt: null,
      status: "running",
      exitCode: null,
      signal: null,
      stopRequested: false,
      openedAt: null,
      notifiedAt: null,
      dir,
      error: null,
      changes: null,
      gitStart,
      continuedFrom: input.continuedFrom ?? null,
    };
    this.store.saveRun(meta);
    let spawned: { ptyId: string; pid: number };
    try {
      spawned = await this.options.host.spawn({
        cwd: input.cwd,
        argv: plan.argv,
        runDir: dir,
        pasteInput,
        cols: input.cols,
        rows: input.rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveRun({ ...meta, status: "failed", endedAt: this.now().toISOString(), error: message });
      this.emit("runs");
      throw new Error(`Could not start ${input.engine.row.label}: ${message}`);
    }
    this.ptyByRun.set(id, spawned.ptyId);
    this.live.set(spawned.ptyId, {
      ptyId: spawned.ptyId,
      runId: id,
      kind: "run",
      title: input.title,
      cwd: input.cwd,
      pid: spawned.pid,
      startedAt: meta.startedAt,
      origin: input.origin,
      agentId: meta.agentId,
      chatId: meta.chatId,
      taskId: meta.taskId,
      workspaceId: meta.workspaceId,
      routineId: meta.routineId,
    });
    if (input.chatId) {
      const chat = this.store.getChat(input.chatId);
      if (chat) {
        this.store.writeChat({ ...chat, runIds: [...chat.runIds, id], cwd: input.cwd, updatedAt: meta.startedAt });
      }
    }
    this.emit("runs", "live", "chats", "routines", "tasks");
    return { runId: id, ptyId: spawned.ptyId };
  }

  // ---------------------------------------------------------------- exits

  async onPtyExit(ptyId: string, exitCode: number | null, signal: number | null): Promise<void> {
    const session = this.live.get(ptyId);
    this.live.delete(ptyId);
    this.shellArgv.delete(ptyId);
    this.hostWorking.delete(ptyId);
    try {
      if (!session?.runId) {
        this.emit("live");
        return;
      }
      this.ptyByRun.delete(session.runId);
      const run = this.store.getRun(session.runId);
      const done = this.finishRun(session.runId, { exitCode, signal, status: run?.stopRequested ? "stopped" : "exited" });
      this.finishing.add(done);
      try {
        await done;
      } finally {
        this.finishing.delete(done);
      }
    } finally {
      const waiters = this.exitWaiters.get(ptyId) ?? [];
      this.exitWaiters.delete(ptyId);
      for (const wake of waiters) wake();
    }
  }

  async finishRun(
    runId: string,
    outcome: { exitCode: number | null; signal: number | null; status: "exited" | "stopped" },
  ): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    const git = await this.writeSnapshot(run);
    await this.writePatch(run);
    const latest = this.store.getRun(runId) ?? run;
    const before = this.gitAtStart.get(runId);
    this.gitAtStart.delete(runId);
    const finished = this.store.saveRun({
      ...latest,
      status: latest.stopRequested ? "stopped" : outcome.status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      endedAt: this.now().toISOString(),
      changes: before !== undefined && before === git ? "No changes" : summarizeSnapshot(git),
    });
    this.indexText(finished);
    if (finished.taskId) {
      const task = this.store.getTask(finished.taskId);
      if (task && task.runIds[task.runIds.length - 1] === finished.id) {
        const status = syncTaskWithRun(task, finished.status);
        if (status !== task.status) this.store.writeTask({ ...task, status, updatedAt: this.now().toISOString() });
      }
    }
    this.notifyFinished(finished);
    try {
      this.options.host.finished?.({
        runId: finished.id,
        origin: finished.origin,
        outcome: finished.status === "stopped" ? "stopped" : finished.status === "failed" || (finished.exitCode && finished.exitCode !== 0) ? "failed" : "ok",
      });
    } catch {
      /* a sound is never worth failing a run over */
    }
    this.emit("runs", "live", "tasks", "chats", "routines");
  }

  private notifyFinished(run: RunMeta): void {
    if (run.notifiedAt) return;
    if (run.origin !== "routine" && run.origin !== "task") return;
    const settings = this.store.readSettings();
    if (!settings.notify) return;
    if (run.origin === "routine") {
      const routine = run.routineId ? this.store.getRoutine(run.routineId) : null;
      if (routine && !routine.notify) return;
    }
    const outcome =
      run.status === "stopped"
        ? "stopped"
        : run.exitCode && run.exitCode !== 0
          ? `exited with code ${run.exitCode}`
          : "finished";
    try {
      this.options.host.notify({
        title: run.title,
        body: [outcome, run.changes].filter(Boolean).join(" · "),
        runId: run.id,
      });
    } catch {
      return;
    }
    this.store.saveRun({ ...run, notifiedAt: this.now().toISOString() });
  }

  private async settleOrphans(orphans: RunMeta[]): Promise<void> {
    for (const run of orphans) {
      const dir = run.dir;
      let changes = run.changes;
      if (dir && run.cwd && isDirectory(dir)) {
        if (!fs.existsSync(path.join(dir, RUN_FILES.git))) {
          changes = summarizeSnapshot(await this.writeSnapshot(run));
        }
        // The exit that should have frozen the patch never arrived. This is the tree now.
        if (!hasRunFile(dir, RUN_FILES.patch)) await this.writePatch(run, LATE_PATCH_NOTE);
      }
      this.store.saveRun({
        ...run,
        status: "stopped",
        endedAt: run.endedAt ?? this.now().toISOString(),
        error: run.error ?? "VibeForge closed while this run was going.",
        changes,
      });
      if (run.taskId) {
        // Only when this orphan is still the task's run: an Execute during settling owns it now.
        const task = this.store.getTask(run.taskId);
        if (task?.status === "running" && task.runIds.at(-1) === run.id) this.store.writeTask({ ...task, status: "review" });
      }
    }
    if (orphans.length) this.emit("runs", "tasks");
  }

  /** Make an ended run findable by what it said. Search is a nicety: a failure here is ignored. */
  indexText(run: RunMeta): void {
    try {
      this.store.indexRunText(run, run.dir ? readText(path.join(run.dir, RUN_FILES.transcript)) : "");
    } catch {
      /* the index can be rebuilt; the run itself is saved */
    }
  }

  /** Status summary for git.txt. The string returned is the one compared with the snapshot from start. */
  private async writeSnapshot(run: RunMeta): Promise<string> {
    let git = "not a git repo\n";
    try {
      git = await this.options.host.snapshotGit(run.cwd, run.gitStart);
    } catch {
      git = "not a git repo\n";
    }
    this.writeRunFile(run, RUN_FILES.git, git.endsWith("\n") ? git : `${git}\n`);
    return git;
  }

  /**
   * Freeze diff.patch. The first write wins, so a later pass cannot replace the tree from
   * the moment the run ended with whatever the folder looks like afterwards.
   * `preface` marks a patch taken on the next open, when the exit itself never wrote one.
   */
  private async writePatch(run: RunMeta, preface = ""): Promise<void> {
    if (!run.dir || !isDirectory(run.dir)) return;
    if (hasRunFile(run.dir, RUN_FILES.patch)) return;
    let patch = "";
    try {
      patch = await diffSince(run.cwd, run.gitStart);
    } catch {
      return;
    }
    const body = preface + patch;
    this.writeRunFile(run, RUN_FILES.patch, body.length === 0 || body.endsWith("\n") ? body : `${body}\n`);
  }

  private writeRunFile(run: RunMeta, name: string, text: string): void {
    if (!run.dir || !isDirectory(run.dir)) return;
    try {
      writeFileAtomic(path.join(run.dir, name), text);
    } catch {
      /* the run folder can vanish if the human deletes it */
    }
  }

  /** Before the app quits: mark every live run as stopped on purpose, so its exit records "stopped". */
  prepareShutdown(): void {
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (run && run.status === "running" && !run.stopRequested) this.store.saveRun({ ...run, stopRequested: true });
    }
  }

  /** Resolves when every exit already reported has finished writing its run. */
  async whenIdle(): Promise<void> {
    while (this.finishing.size) await Promise.allSettled([...this.finishing]);
  }

  /** Last step before quitting: anything the PTY host never reported is recorded as stopped now. */
  shutdown(): string[] {
    const ended = this.now().toISOString();
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (!run || run.status !== "running") continue;
      this.store.saveRun({ ...run, status: "stopped", stopRequested: true, endedAt: ended, error: "Stopped when VibeForge quit." });
      if (run.taskId) {
        const task = this.store.getTask(run.taskId);
        if (task?.status === "running") this.store.writeTask({ ...task, status: "review" });
      }
    }
    return [...this.live.keys()];
  }

  // ---------------------------------------------------------------- helpers

  firstPlace(places: readonly string[]): string | null {
    for (const place of places) if (isDirectory(place)) return path.resolve(place);
    return null;
  }
}
