import fs from "node:fs";
import path from "node:path";
import { newCompanionToken, normalizeCompanion, shellForegroundEngine } from "../companion.js";
import { instructionArgs, launchOptionArgs, planLaunch, resumeArgsFromTranscript, withAvailability } from "../engines.js";
import { LOCAL_ENGINE_ID, cleanLocalModel, localEngineSpec, normalizeLocalUrl, type ConcreteLocalHarness, type LocalServerProbe } from "../local.js";
import { normalizeVibyRoute, vibyLocalModel } from "../../shared/local.js";
import { isDirectory, readJson, readText, writeFileAtomic } from "../fsx.js";
import { diffSince, dirtyFiles, leaveOutUntouched, summarizeSnapshot, type DirtyFiles } from "../vcs.js";
import { buildPreamble } from "../preamble.js";
import { allocateRunDir, RUN_FILES } from "../runs.js";
import { hasRunFile, readRunTail } from "../run-storage.js";
import { Store } from "../store.js";
import { Trash, type Bin } from "../trash.js";
import { failStreak, ROUTINE_FAILING } from "../routines.js";
import { syncTaskWithRun } from "../tasks.js";
import type { Agent, Engine, EngineRow, LiveSession, RunMeta, RunOrigin, Settings, Topic, UnreadableFile, Workspace } from "../types.js";
import { removeCopy, type WorkingCopy } from "../worktrees.js";
import { type Deleted, type DeskOptions, LATE_PATCH_NOTE, type Launched, type RunView, UNDO_MS } from "./types.js";

/** What tidies up after a delete once its Undo has passed; a promise when that takes a while. */
type Settle = () => unknown;

export interface ResolvedEngine {
  row: EngineRow;
  binPath: string;
  harness?: ConcreteLocalHarness | null;
  extraArgs?: string[];
  env?: Record<string, string>;
  localModel?: string;
}

/** Strip terminal escape sequences so post-exit resume commands in raw scrollback read cleanly. */
function stripTerminalCodes(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n?/g, "\n");
}

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
  readonly ptyTokens = new Map<string, string>();
  private readonly listeners = new Set<(topics: Topic[]) => void>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly finishing = new Set<Promise<void>>();
  /** Per shell: the latest command line in its foreground, and the queue that records it. */
  readonly shellArgv = new Map<string, string[]>();
  readonly recordings = new Map<string, Promise<void>>();
  /** Per shell: the host's last word on activity, kept while no coding CLI is in front to use it. */
  readonly hostWorking = new Map<string, boolean>();
  /** The git snapshot when a run started: a tree that was already dirty isn't this run's doing. */
  readonly gitAtStart = new Map<string, string>();
  private readonly localProbeCache = new Map<string, LocalServerProbe>();
  private readonly knownLocalModels = new Set<string>();
  /** Per live run: the files already changed when it started, so its own changes can be told apart. */
  readonly dirtyAtStart = new Map<string, Promise<DirtyFiles | null>>();
  readonly trash: Trash;
  private readonly undoable = new Map<string, { bin: Bin; restore: (restored: string[]) => void; timer: ReturnType<typeof setTimeout>; settle?: Settle }>();
  private pending = new Set<Topic>();
  private flushQueued = false;
  protected closed = false;
  private closePromise: Promise<void> | null = null;
  readonly settled: Promise<void>;

  constructor(options: DeskOptions) {
    this.options = options;
    this.store = new Store(options.configRoot, options.dataRoot);
    // A settings file that stops (or starts again) reading correctly: the window says so.
    this.store.onUnreadableChange(() => this.emit("unreadable"));
    // Anything left in the trash was deleted in an earlier session, past its undo; settle any copy branches that didn't finish clearing.
    this.trash = new Trash(path.join(options.dataRoot, "trash"));
    const trashed = this.trash.empty();
    // Anything still "running" in the index belongs to a process that died with the last app session.
    const orphans = this.store.queryRuns({ status: "running", limit: 2000 });
    this.settled = Promise.all([this.settleOrphans(orphans), this.settleTrash(trashed)]).then(() => undefined);
  }

  whenSettled(): Promise<void> {
    return this.settled;
  }

  now(): Date {
    return this.options.now();
  }

  /**
   * Done: a delete still undoable is final now, and what it leaves outside its files (a task
   * copy's worktree entry and branch) is tidied. Resolves once that tidying has finished, which a
   * quit waits for a moment: git still had a few steps to go when the app went.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const entry of this.undoable.values()) clearTimeout(entry.timer);
    const settling = [...this.undoable.values()].flatMap((entry) => (entry.settle ? [entry.settle] : []));
    this.undoable.clear();
    this.trash.empty();
    this.store.close();
    const tidied = settling.map((settle) => {
      try {
        return Promise.resolve(settle()).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve();
      }
    });
    this.closePromise = Promise.all(tidied).then(() => undefined);
    return this.closePromise;
  }

  // ---------------------------------------------------------------- undo

  /**
   * Keep a delete undoable for a while; after that its files go for good, and `settle` tidies
   * whatever lived outside them (a task copy's git branch). `restore` hears which paths went back.
   */
  keepForUndo(bin: Bin, restore: (restored: string[]) => void, settle?: Settle): Deleted {
    const timer = setTimeout(() => {
      this.undoable.delete(bin.token);
      this.trash.drop(bin);
      void Promise.resolve(settle?.()).catch(() => undefined);
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
    entry.restore(this.trash.restore(entry.bin));
  }

  /** The most recent delete still inside its undo window, or null when none is left. */
  latestUndoToken(): string | null {
    return [...this.undoable.keys()].at(-1) ?? null;
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

  saveSettings(
    patch: Partial<Omit<Settings, "companion" | "local">> & {
      companion?: Partial<Settings["companion"]>;
      local?: Partial<Settings["local"]>;
    },
  ): Settings {
    const current = this.store.readSettings();
    const { companion: companionPatch, local: localPatch, ...rest } = patch;
    const next: Settings = { ...current, ...rest };
    // A partial phone-page patch must not drop the pairing code or the saved nudges.
    if (companionPatch) {
      next.companion = normalizeCompanion({ ...current.companion, ...companionPatch });
      // A new code (the old one cleared) unpairs every phone: each pairs again with the new one.
      if (companionPatch.token === "" && current.companion.token) next.companion.devices = [];
      if (next.companion.enabled && !next.companion.token) next.companion.token = newCompanionToken();
    }
    if (localPatch) {
      // Viby's own route (local.viby) stays as it was saved: switching coding to Local or back never moves Viby.
      next.local = { ...current.local, ...localPatch, viby: normalizeVibyRoute(localPatch.viby) ?? current.local.viby };
    }
    this.store.writeSettings(next);
    if (localPatch) {
      this.emit("settings", "engines", "orchestrator", "agents", "routines", "tasks");
    } else {
      this.emit("settings");
    }
    return this.store.readSettings();
  }

  /** settings.json, engines.json, workspaces.json or chats.json, there but not readable right now. */
  unreadableFiles(): UnreadableFile[] {
    return this.store.unreadableFiles();
  }

  /**
   * "Use the saved copy" for a file the window listed as unreadable: it moves to `<name>.broken`, and
   * the copy from the last read that worked goes back in its place. Anything else is refused.
   */
  restoreSavedCopy(file: string): void {
    if (!this.store.unreadableFiles().some((item) => item.file === file)) return;
    this.store.restoreSavedCopy(file);
    this.emit("unreadable", "settings", "engines", "agents", "routines", "tasks", "workspaces", "chats");
  }

  recordLocalProbe(probe: LocalServerProbe): boolean {
    let changed = false;
    const url = normalizeLocalUrl(probe.url);
    if (url && probe.reachable) {
      const prev = this.localProbeCache.get(url);
      const signature = (p: LocalServerProbe) => `${p.contextLength ?? ""}|${p.models.map((m) => `${m.id}:${m.contextLength ?? ""}`).join(",")}`;
      if (!prev || signature(prev) !== signature(probe)) changed = true;
      this.localProbeCache.set(url, probe);
    }
    for (const m of probe.models) {
      const clean = cleanLocalModel(m.id);
      if (clean && !this.knownLocalModels.has(clean)) {
        this.knownLocalModels.add(clean);
      }
    }
    return changed;
  }

  cachedLocalContext(url: string, model: string): number | null {
    const probe = this.localProbeCache.get(normalizeLocalUrl(url));
    if (!probe) return null;
    const clean = cleanLocalModel(model);
    const exact = clean ? probe.models.find((m) => m.id === clean)?.contextLength : null;
    return exact ?? probe.contextLength ?? null;
  }

  private isKnownLocalModel(model: string): boolean {
    const clean = cleanLocalModel(model);
    if (!clean) return false;
    const { local } = this.store.readSettings();
    return clean === local.model || clean === local.vibyModel || this.knownLocalModels.has(clean);
  }

  localBrainConfig(): { url: string; model: string } | null {
    const { local } = this.store.readSettings();
    if (!local.enabled) return null;
    const url = normalizeLocalUrl(local.url);
    const model = cleanLocalModel(vibyLocalModel(local));
    return url && model ? { url, model } : null;
  }

  isLocalCodingActive(): boolean {
    const { local } = this.store.readSettings();
    return local.enabled && local.active && Boolean(this.resolveEngine(LOCAL_ENGINE_ID));
  }

  isLocalAgentOverrideActive(): boolean {
    return this.isLocalCodingActive() && this.store.readSettings().local.overrideAgents;
  }

  effectiveDefaultEngine(): string {
    return this.isLocalCodingActive() ? LOCAL_ENGINE_ID : this.store.readSettings().defaultEngine;
  }

  effectiveEngineId(engineId: string, opts?: { fromAgent?: boolean }): string {
    if (engineId === LOCAL_ENGINE_ID) return LOCAL_ENGINE_ID;
    if (opts?.fromAgent && this.isLocalAgentOverrideActive()) return LOCAL_ENGINE_ID;
    return engineId;
  }

  /** Single entry point choosing engine + model for Code, Agents, Chat, Tasks, Routines, and Viby start steps. */
  resolveLaunchTarget(input: { engineId?: string | null; fromAgent?: boolean; model?: string | null }): { engineId: string; model?: string } {
    const baseId = input.engineId?.trim() || this.effectiveDefaultEngine();
    const engineId = this.effectiveEngineId(baseId, { fromAgent: input.fromAgent });
    const rawModel = typeof input.model === "string" ? input.model.trim() : "";
    if (engineId === LOCAL_ENGINE_ID) {
      const clean = cleanLocalModel(rawModel);
      const model = baseId === LOCAL_ENGINE_ID && clean && this.isKnownLocalModel(clean) ? clean : undefined;
      return model ? { engineId, model } : { engineId };
    }
    return rawModel ? { engineId, model: rawModel } : { engineId };
  }

  listEngines(): Engine[] {
    const rows = this.store.readEngineRows();
    const engines = withAvailability(rows, (bin) => this.options.host.resolveBin(bin));
    const { local } = this.store.readSettings();
    if (local.enabled && !engines.some((engine) => engine.id === LOCAL_ENGINE_ID)) {
      engines.push(localEngineSpec(local, rows, (bin) => this.options.host.resolveBin(bin)).engine);
    }
    return engines;
  }

  saveEngines(rows: EngineRow[]): Engine[] {
    this.store.writeEngineRows(rows.filter((row) => row.id !== LOCAL_ENGINE_ID));
    this.emit("engines", "agents", "routines", "tasks");
    return this.listEngines();
  }

  resolveEngine(engineId: string, opts?: { model?: string }): ResolvedEngine | null {
    const rows = this.store.readEngineRows();
    if (engineId === LOCAL_ENGINE_ID) {
      const { local } = this.store.readSettings();
      if (!local.enabled) return null;
      const spec = localEngineSpec(local, rows, (bin) => this.options.host.resolveBin(bin), opts?.model);
      if (!spec.engine.available || !spec.binPath) return null;
      return {
        row: spec.engine,
        binPath: spec.binPath,
        harness: spec.harness,
        extraArgs: spec.extraArgs,
        env: spec.env,
        localModel: spec.localModel,
      };
    }
    const row = rows.find((engine) => engine.id === engineId);
    if (!row) return null;
    const binPath = this.options.host.resolveBin(row.bin);
    return binPath ? { row, binPath } : null;
  }

  requireEngine(engineId: string, opts?: { model?: string }): ResolvedEngine {
    const engine = this.resolveEngine(engineId, opts);
    if (engine) return engine;
    if (engineId === LOCAL_ENGINE_ID) {
      throw new Error("Local AI needs a connected server, a model, and OpenCode, Claude Code, or Codex installed.");
    }
    const row = this.store.readEngineRows().find((item) => item.id === engineId);
    throw new Error(row ? `${row.label} (${row.bin}) is not on PATH.` : `There is no engine called "${engineId}".`);
  }

  engineMissingText(engineId: string): string {
    if (engineId === LOCAL_ENGINE_ID) {
      return "Local AI is not ready (check server, model, and OpenCode/Claude/Codex).";
    }
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
   * CLI printed one, the engine's continue flag when the folder's latest run on that CLI was in the
   * same mode and harness, or starting fresh from the transcript otherwise.
   */
  resumePlan(
    target: ResolvedEngine | EngineRow,
    previous: RunMeta | null,
    cwd?: string,
    opts?: { allowBareWithoutPrevious?: boolean },
  ): { native: boolean; resumeArgs: string[] | null } {
    const row = "row" in target ? target.row : target;
    const harness = "row" in target ? (target.harness ?? null) : null;
    if (previous) {
      // A different CLI cannot pick up another CLI's session; start fresh with the transcript instead.
      if (previous.engine !== row.id) return { native: false, resumeArgs: null };
      if (row.id === LOCAL_ENGINE_ID && previous.localHarness && harness && previous.localHarness !== harness) {
        return { native: false, resumeArgs: null };
      }
      if (previous.dir) {
        const fromTranscript = resumeArgsFromTranscript(row, readText(path.join(previous.dir, RUN_FILES.transcript)));
        if (fromTranscript) return { native: true, resumeArgs: fromTranscript };
        // Full-screen CLIs keep their alt-screen frame in transcript.txt, leaving any post-exit resume line only in scrollback.
        const fromScrollback = resumeArgsFromTranscript(row, stripTerminalCodes(readRunTail(previous.dir, RUN_FILES.scrollback)));
        if (fromScrollback) return { native: true, resumeArgs: fromScrollback };
      }
    } else if (!opts?.allowBareWithoutPrevious) {
      return { native: false, resumeArgs: null };
    }
    if (!row.continueArgs?.length) return { native: false, resumeArgs: null };
    // Bare continue flags (e.g. `claude --continue`, `codex resume --last`) resume whatever session
    // last ran in that folder on the underlying CLI; block them if a newer run used the opposite mode.
    const folder = path.resolve(cwd || previous?.cwd || ".");
    const rows = this.store.readEngineRows();
    const underlyingCli = (run: Pick<RunMeta, "engine" | "localHarness" | "argv">): string => {
      if (run.engine === LOCAL_ENGINE_ID) return run.localHarness || path.basename(run.argv[0] ?? "");
      const known = rows.find((item) => item.id === run.engine);
      return known?.bin ? path.basename(known.bin) : run.engine || path.basename(run.argv[0] ?? "");
    };
    const currentCli = row.id === LOCAL_ENGINE_ID ? (harness || path.basename(row.bin)) : path.basename(row.bin || row.id);
    const folderRuns = this.store.queryRuns({ limit: 50 }).filter((run) => run.cwd && path.resolve(run.cwd) === folder);
    const recentInFolder = folderRuns.find((run) => underlyingCli(run) === currentCli);
    if (recentInFolder) {
      const sameMode = (recentInFolder.engine === LOCAL_ENGINE_ID) === (row.id === LOCAL_ENGINE_ID);
      if (!sameMode) return { native: false, resumeArgs: null };
      if (row.id === LOCAL_ENGINE_ID && recentInFolder.localHarness && harness && recentInFolder.localHarness !== harness) {
        return { native: false, resumeArgs: null };
      }
    }
    if (row.id === LOCAL_ENGINE_ID && harness) {
      const recentLocalInFolder = folderRuns.find((run) => run.engine === LOCAL_ENGINE_ID);
      if (recentLocalInFolder?.localHarness && recentLocalInFolder.localHarness !== harness) {
        return { native: false, resumeArgs: null };
      }
    }
    return { native: true, resumeArgs: null };
  }

  transcriptPath(run: RunMeta): string | null {
    if (!run.dir) return null;
    for (const file of [RUN_FILES.transcript, RUN_FILES.scrollback]) {
      for (const candidate of [path.join(run.dir, file), `${path.join(run.dir, file)}.gz`]) {
        try {
          if (fs.statSync(candidate).size > 0) return candidate;
        } catch {
          /* try the next file */
        }
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

  /**
   * A new id for an agent, skill or routine named `name` in its config folder. One whose deleted
   * namesake is still waiting for Undo is taken, so Undo can put that one back; so is one old runs
   * still point to (`hasRuns`), so a new routine or agent doesn't take over the old one's history
   * (its last run, a failing streak). It gets a number instead: `helper-2`.
   */
  freeId(folder: "agents" | "skills" | "routines", name: string, extension: string, hasRuns: (id: string) => boolean = () => false): string {
    const dir = path.join(this.options.configRoot, folder);
    return this.store.uniqueId(dir, name, extension, (id) => this.trash.holds(path.join(dir, `${id}${extension}`)) || hasRuns(id));
  }

  isLive(ptyId: string): boolean {
    return this.live.has(ptyId);
  }

  onPtyProgram(_ptyId: string, _argv: string[] | null, _cwd: string | null = null): void {}

  /** Re-reads a shell pane's foreground right now so stale 1 s poll state never lets keys or text hit bare bash. */
  async refreshShellForeground(ptyId: string): Promise<boolean> {
    const session = this.live.get(ptyId);
    if (!session) return false;
    if (session.kind !== "shell" || !this.options.host.foreground) return true;
    const seen = await this.options.host.foreground(ptyId).catch(() => ({ known: false, argv: null, cwd: null }));
    if (!seen.known) return false;
    if (shellForegroundEngine(seen, this.store.readEngineRows()) === "cli") return true;
    this.onPtyProgram(ptyId, seen.argv, seen.cwd);
    return false;
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
    // A skill or memory that is there but can't be read stops the start, with why, rather than
    // starting the agent without it.
    const skills = agent.skills.flatMap((id) => {
      const skill = this.store.readSkill(id);
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
      talk: this.store.readSettings().agentTalk.on,
    });
  }

  async launch(input: {
    origin: RunOrigin;
    title: string;
    engine: ResolvedEngine;
    cwd: string;
    /** What the human asked for, kept for the record. */
    prompt: string;
    /** What reaches the CLI as its first message: a preamble, the plain prompt, or nothing. */
    promptText: string | null;
    /** Text pasted after a continued session loads. */
    pasteAfter?: string | null;
    /** Added to the CLI's own instructions where it takes some at start (see instructionArgs). */
    instructions?: string | null;
    /** A lead: Claude Code may run `vibeforge` without asking. */
    allowVibeforge?: boolean;
    continueSession?: boolean;
    /** The exact session to reopen, read from the previous run's transcript. */
    resumeArgs?: string[] | null;
    agentId?: string | null;
    routineId?: string | null;
    taskId?: string | null;
    chatId?: string | null;
    workspaceId?: string | null;
    continuedFrom?: string | null;
    /** The Orchestrator started it (Code gives it a pane). */
    orchestrated?: boolean;
    /** The model and reasoning effort to start the CLI with, where it takes them (launchOptionArgs). */
    model?: string;
    effort?: string;
    cols?: number;
    rows?: number;
  }): Promise<Launched> {
    const started = this.now();
    const { id, dir } = allocateRunDir(this.options.dataRoot, started, input.title);
    const preamblePath = path.join(dir, RUN_FILES.preamble);
    writeFileAtomic(preamblePath, input.promptText ?? "");
    const launchArgs = [
      ...(input.engine.extraArgs ?? []),
      ...launchOptionArgs(input.engine.row, {
        ...(input.engine.row.id === LOCAL_ENGINE_ID ? {} : { model: input.model }),
        effort: input.effort,
      }),
    ];
    const plan = planLaunch(input.engine.row, input.engine.binPath, {
      prompt: input.promptText,
      continueSession: input.continueSession,
      resumeArgs: input.resumeArgs,
      promptFile: preamblePath,
      instructions: input.instructions
        ? {
            argv: instructionArgs(input.engine.row, input.instructions, { allowVibeforge: input.allowVibeforge }),
            record: instructionArgs(input.engine.row, "{VibeForge note}", { allowVibeforge: input.allowVibeforge }),
          }
        : null,
      options: launchArgs,
    });
    const pasteInput = plan.pasteInput ?? input.pasteAfter ?? null;
    let gitStart: string | null = null;
    try {
      gitStart = await this.options.host.gitHead(input.cwd);
      // What the tree looked like: a run that only answers a question ends with "No changes",
      // however many edits were already there, and doesn't go to Review for them.
      if (gitStart) this.gitAtStart.set(id, await this.options.host.snapshotGit(input.cwd, gitStart));
    } catch {
      /* not a repository, or git is slow: the run is recorded without */
    }
    this.dirtyAtStart.set(id, dirtyFiles(input.cwd).catch(() => null));
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
      ...(input.engine.harness ? { localHarness: input.engine.harness } : {}),
      ...(input.engine.localModel ? { localModel: input.engine.localModel } : {}),
    };
    this.store.saveRun(meta);
    let spawned: { ptyId: string; pid: number; ptyToken?: string };
    try {
      spawned = await this.options.host.spawn({
        cwd: input.cwd,
        argv: plan.argv,
        ...(input.engine.env && Object.keys(input.engine.env).length ? { env: input.engine.env } : {}),
        runDir: dir,
        pasteInput,
        cols: input.cols,
        rows: input.rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dirtyAtStart.delete(id);
      this.store.saveRun({ ...meta, status: "failed", endedAt: this.now().toISOString(), error: message });
      this.emit("runs");
      throw new Error(`Could not start ${input.engine.row.label}: ${message}`);
    }
    if (spawned.ptyToken) this.ptyTokens.set(spawned.ptyId, spawned.ptyToken);
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
      ...(input.orchestrated ? { orchestrated: true } : {}),
      ...(input.engine.localModel ? { localModel: input.engine.localModel } : {}),
    });
    if (input.chatId) {
      const chat = this.store.getChat(input.chatId);
      if (chat) {
        try {
          this.store.writeChat({ ...chat, runIds: [...chat.runIds, id], cwd: input.cwd, updatedAt: meta.startedAt });
        } catch {
          // chats.json can't be read, so it isn't saved over (the window says so). The run has started and is in Runs.
        }
      }
    }
    this.emit("runs", "live", "chats", "routines", "tasks");
    return { runId: id, ptyId: spawned.ptyId };
  }

  // ---------------------------------------------------------------- exits

  /** A terminal ended. `error` says why when it wasn't the program's own doing (the terminal host stopped). */
  async onPtyExit(ptyId: string, exitCode: number | null, signal: number | null, error: string | null = null): Promise<void> {
    const session = this.live.get(ptyId);
    this.live.delete(ptyId);
    this.ptyTokens.delete(ptyId);
    this.shellArgv.delete(ptyId);
    this.hostWorking.delete(ptyId);
    try {
      if (this.closed || !session?.runId) {
        if (!this.closed) this.emit("live");
        return;
      }
      this.ptyByRun.delete(session.runId);
      const run = this.store.getRun(session.runId);
      const done = this.finishRun(session.runId, { exitCode, signal, status: run?.stopRequested ? "stopped" : "exited", ...(error ? { error } : {}) });
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
    outcome: { exitCode: number | null; signal: number | null; status: "exited" | "stopped"; error?: string },
  ): Promise<void> {
    if (this.closed) return;
    const run = this.store.getRun(runId);
    if (!run) return;
    const git = await this.writeSnapshot(run);
    if (this.closed) return;
    const dirty = (await this.dirtyAtStart.get(runId)) ?? null;
    if (this.closed) return;
    const own = await this.writePatch(run, "", dirty);
    if (this.closed) return;
    const latest = this.store.getRun(runId) ?? run;
    const before = this.gitAtStart.get(runId);
    this.gitAtStart.delete(runId);
    this.dirtyAtStart.delete(runId);
    // Only edits that were there before it started, left as they were: none of this run's doing.
    const untouched = Boolean(dirty?.size) && own !== null && !own.trim() && !git.includes("commits since the run started");
    const finished = this.store.saveRun({
      ...latest,
      status: latest.stopRequested ? "stopped" : outcome.status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      endedAt: this.now().toISOString(),
      ...(outcome.error ? { error: outcome.error } : {}),
      changes: (before !== undefined && before === git) || untouched ? "No changes" : summarizeSnapshot(git),
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

  /** A desktop note for a task's or routine's run that ended, or a routine's that never started. Said once. */
  notifyFinished(run: RunMeta): void {
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
        : run.status === "failed" && run.exitCode === null
          ? `couldn't start: ${run.error ?? "unknown error"}`
          : run.exitCode && run.exitCode !== 0
          ? `exited with code ${run.exitCode}`
          : "finished";
    // Said once, on the run that makes it a streak; Routines and Home keep it lit after that.
    const streak = run.routineId ? failStreak(this.store.queryRuns({ routineId: run.routineId, limit: ROUTINE_FAILING + 1 })) : 0;
    const failing = streak === ROUTINE_FAILING ? `failed ${streak} times in a row` : null;
    try {
      this.options.host.notify({
        title: run.title,
        body: [outcome, run.changes, failing].filter(Boolean).join(" · "),
        runId: run.id,
      });
    } catch {
      return;
    }
    this.store.saveRun({ ...run, notifiedAt: this.now().toISOString() });
  }

  private async settleOrphans(orphans: RunMeta[]): Promise<void> {
    for (const run of orphans) {
      if (this.closed) return;
      const dir = run.dir;
      let changes = run.changes;
      if (dir && run.cwd && isDirectory(dir)) {
        if (!fs.existsSync(path.join(dir, RUN_FILES.git))) {
          changes = summarizeSnapshot(await this.writeSnapshot(run));
        }
        if (this.closed) return;
        // The exit that should have frozen the patch never arrived. This is the tree now.
        if (!hasRunFile(dir, RUN_FILES.patch)) await this.writePatch(run, LATE_PATCH_NOTE);
      }
      if (this.closed) return;
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

  private async settleTrash(trashed: unknown[]): Promise<void> {
    if (!trashed.length) return;
    const copies = readJson<{ copies?: Array<{ id?: string }> } | null>(path.join(this.options.dataRoot, "orchestrator", "copies.json"), null)?.copies ?? [];
    for (const item of trashed) {
      if (this.closed) return;
      if (!item || typeof item !== "object") continue;
      const note = item as { kind?: unknown; taskId?: unknown; copy?: WorkingCopy };
      if (note.kind !== "copy" || typeof note.taskId !== "string" || !note.copy) continue;
      // A task that is still there with a copy (Execute made a new one) owns that folder and branch; a
      // discarded copy's task is still there without one, and its copy goes.
      if (this.store.getTask(note.taskId)?.copy || copies.some((entry) => entry?.id === note.taskId)) continue;
      await removeCopy(note.copy, { dataRoot: this.options.dataRoot, taskId: note.taskId }, true).catch(() => undefined);
    }
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
   * `preface` marks a patch taken on the next open, when the exit itself never wrote one. Files
   * that were already changed when the run started (`before`) and still hold exactly that are
   * left out: they're someone else's edits. Returns the patch written, or null when none was.
   */
  private async writePatch(run: RunMeta, preface = "", before: DirtyFiles | null = null): Promise<string | null> {
    if (!run.dir || !isDirectory(run.dir)) return null;
    if (hasRunFile(run.dir, RUN_FILES.patch)) return null;
    let patch = "";
    try {
      patch = leaveOutUntouched(await diffSince(run.cwd, run.gitStart), run.cwd, before);
    } catch {
      return null;
    }
    const body = preface + patch;
    this.writeRunFile(run, RUN_FILES.patch, body.length === 0 || body.endsWith("\n") ? body : `${body}\n`);
    return patch;
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
