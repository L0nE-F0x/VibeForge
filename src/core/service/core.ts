import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newCompanionToken, normalizeCompanion, shellForegroundEngine } from "../companion.js";
import { instructionArgs, launchOptionArgs, planLaunch, resumeArgsFromTranscript, withAvailability } from "../engines.js";
import { LOCAL_ENGINE_ID, cleanLocalModel, localEngineSpec, normalizeLocalUrl, type ConcreteLocalHarness, type LocalServerProbe } from "../local.js";
import { normalizeLocalServer, normalizeVibyRoute, vibyLocalModel } from "../../shared/local.js";
import { isDirectory, readJson, readText, writeFileAtomic } from "../fsx.js";
import { diffSince, dirtyFiles, leaveOutUntouched, summarizeSnapshot, type DirtyFiles } from "../vcs.js";
import { applyUndoRestore, isRunInCopy, removeRunSnapshots, takeEndSnapshot, takeStartSnapshot, type RestoreUndoData } from "../snapshots.js";
import { buildPreamble } from "../preamble.js";
import { allocateRunDir, RUN_FILES } from "../runs.js";
import { hasRunFile, readRunTail } from "../run-storage.js";
import { Store } from "../store.js";
import { Trash, type Bin } from "../trash.js";
import { failStreak, isCutOffRun, ROUTINE_FAILING } from "../routines.js";
import { syncTaskWithRun } from "../tasks.js";
import type { Agent, CutOff, Engine, EngineRow, LiveSession, RoutineRunResult, RunMeta, RunOrigin, Settings, Topic, UnreadableFile, Workspace } from "../types.js";
import { readCutOff, settleCutOff, writeCutOff, type CutOffNote } from "../cut-off.js";
import { wrapForCopy } from "../copy-setup.js";
import { catalog, fill, phoneLanguage } from "../companion-text.js";
import { matchCoreText } from "../../ui/core-match.js";
import { removeCopy, type WorkingCopy } from "../worktrees.js";
import { type CutOffRun, type Deleted, type DeskOptions, LATE_PATCH_NOTE, type Launched, type RunView, UNDO_MS } from "./types.js";

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
/** Who wrote into a pane: a person (or Viby, or a chat, for one), or another CLI's message. */
export type PaneInputFrom = "person" | "cli";

export class ServiceCore {
  readonly options: DeskOptions;
  readonly store: Store;
  readonly live = new Map<string, LiveSession>();
  readonly ptyByRun = new Map<string, string>();
  readonly ptyTokens = new Map<string, string>();
  private readonly listeners = new Set<(topics: Topic[]) => void>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly finishing = new Set<Promise<void>>();
  /** Explicit end state for a run VibeForge closes on purpose (routine turn end or time limit). */
  private readonly pendingOutcome = new Map<string, { status: "exited" | "stopped"; exitCode?: number | null; result: RoutineRunResult; error?: string }>();
  /** Per shell: the latest command line in its foreground, and the queue that records it. */
  readonly shellArgv = new Map<string, string[]>();
  readonly recordings = new Map<string, Promise<void>>();
  /** Per shell: the cut-off run its first CLI picks back up (typed in by Continue its session). */
  readonly shellContinues = new Map<string, string>();
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
  private readonly restoreUndos = new Map<string, { data: RestoreUndoData; timer: ReturnType<typeof setTimeout> }>();
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
    for (const entry of this.restoreUndos.values()) clearTimeout(entry.timer);
    const settling = [...this.undoable.values()].flatMap((entry) => (entry.settle ? [entry.settle] : []));
    this.undoable.clear();
    this.restoreUndos.clear();
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

  /** Keep a file-restore operation undoable for a short window, putting the end state back for those exact files. */
  keepRestoreForUndo(data: RestoreUndoData): string {
    const token = randomUUID();
    const timer = setTimeout(() => {
      this.restoreUndos.delete(token);
    }, UNDO_MS);
    timer.unref?.();
    this.restoreUndos.set(token, { data, timer });
    return token;
  }

  /** Undo a previous "Put files back as before this run" action. */
  async undoRunRestore(token: string): Promise<void> {
    const entry = this.restoreUndos.get(token);
    if (!entry) throw new Error("It is too late to undo that.");
    clearTimeout(entry.timer);
    this.restoreUndos.delete(token);
    const reverted = await applyUndoRestore(entry.data);
    if (reverted.length > 0) this.emit("workspaces");
  }

  // ---------------------------------------------------------------- input into a pane

  /**
   * Something went into a pane from outside its program: a person typing, or something sent on a
   * person's behalf (Viby answering a prompt, a chat message), or (`from` "cli") another CLI's
   * message through `vibeforge tell`. Every write into a pane reports here once it's in, so
   * routines, messages and the attention marks all see the same input. TeamService hands it on.
   */
  paneInput(_ptyId: string, _data: string, _from: PaneInputFrom): void {}

  // ---------------------------------------------------------------- events

  onChange(listener: (topics: Topic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A copy's CLI argv, wrapped to show first what copy setup couldn't bring along and to run its
   * setup command (copy-setup.ts), in the window's language.
   */
  private async wrapForCopy(argv: string[], setupCommand?: string | null, notes?: readonly string[]): Promise<string[]> {
    if (!setupCommand?.trim() && !notes?.length) return argv;
    const settings = this.store.readSettings();
    const words = await catalog(phoneLanguage(settings.language, process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG));
    const say = (text: string) => {
      const found = matchCoreText(text);
      return found ? fill(words[found.key], found.vars) : text;
    };
    return wrapForCopy(argv, { setupCommand, notes: notes?.map(say), words: { failed: words["core.copySetupFailed"] }, userShell: settings.defaultShell });
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
      local?: Partial<Omit<Settings["local"], "server">> & { server?: Partial<Settings["local"]["server"]> };
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
      // A partial server patch keeps the rest of how the server starts.
      const server = localPatch.server ? normalizeLocalServer({ ...current.local.server, ...localPatch.server }) : current.local.server;
      next.local = { ...current.local, ...localPatch, server, viby: normalizeVibyRoute(localPatch.viby) ?? current.local.viby };
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
    this.pendingOutcome.delete(id);
    const ptyId = this.ptyByRun.get(id);
    this.store.saveRun({ ...run, stopRequested: true, result: undefined });
    if (ptyId) {
      await this.options.host.kill(ptyId);
      return;
    }
    await this.finishRun(run.id, { exitCode: null, signal: null, status: "stopped" });
  }

  /**
   * Ends a running session with an explicit outcome (e.g. a routine whose turn ended cleanly,
   * or a routine that hit its time limit) so its exit records that result instead of plain "stopped".
   */
  async endRunWithResult(
    id: string,
    outcome: { status: "exited" | "stopped"; exitCode?: number | null; result: RoutineRunResult; error?: string },
  ): Promise<void> {
    const run = this.store.getRun(id);
    if (!run || run.status !== "running") return;
    const ptyId = this.ptyByRun.get(id);
    this.pendingOutcome.set(id, outcome);
    this.store.saveRun({
      ...run,
      stopRequested: outcome.status === "stopped",
      result: outcome.result,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (ptyId) {
      await this.options.host.kill(ptyId);
      return;
    }
    this.pendingOutcome.delete(id);
    await this.finishRun(run.id, {
      exitCode: outcome.exitCode ?? null,
      signal: null,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      result: outcome.result,
    });
  }


  /**
   * The arguments that reopen exactly the session `run` was in: the "--resume <id>" line the CLI
   * printed as it exited, else the session read from its log while it ran. Null when neither is known.
   */
  exactResume(run: RunMeta, row?: EngineRow): string[] | null {
    const engine = row ?? this.store.readEngineRows().find((item) => item.id === run.engine);
    if (engine && run.dir) {
      const fromTranscript = resumeArgsFromTranscript(engine, readText(path.join(run.dir, RUN_FILES.transcript)));
      if (fromTranscript) return fromTranscript;
      // Full-screen CLIs keep their alt-screen frame in transcript.txt, leaving any post-exit resume line only in scrollback.
      const fromScrollback = resumeArgsFromTranscript(engine, stripTerminalCodes(readRunTail(run.dir, RUN_FILES.scrollback)));
      if (fromScrollback) return fromScrollback;
    }
    return run.resumeArgs?.length ? run.resumeArgs : null;
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
      const exact = this.exactResume(previous, row);
      if (exact) return { native: true, resumeArgs: exact };
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
    /** The Code pane it is started in. */
    paneId?: string | null;
    /** The Orchestrator started it (Code gives it a pane). */
    orchestrated?: boolean;
    /** The model and reasoning effort to start the CLI with, where it takes them (launchOptionArgs). */
    model?: string;
    effort?: string;
    /** Optional per-workspace setup command run visibly in the copy's terminal before the CLI starts. */
    setupCommand?: string | null;
    /** What copy setup couldn't bring along, shown in the copy's terminal before the CLI starts. */
    setupNotes?: readonly string[];
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
    const spawnArgv = await this.wrapForCopy(plan.argv, input.setupCommand, input.setupNotes);
    let gitStart: string | null = null;
    const captureStartGit = async () => {
      try {
        gitStart = await this.options.host.gitHead(input.cwd);
        // What the tree looked like: a run that only answers a question ends with "No changes",
        // however many edits were already there, and doesn't go to Review for them.
        if (gitStart) this.gitAtStart.set(id, await this.options.host.snapshotGit(input.cwd, gitStart));
      } catch {
        /* not a repository, or git is slow: the run is recorded without */
      }
    };
    const captureStartSnapshot = async () => {
      if (isRunInCopy(input.cwd, this.options.dataRoot)) return;
      await takeStartSnapshot({
        cwd: input.cwd,
        runId: id,
        runDir: dir,
        onWarn: (message) => this.options.host.logWarn?.(message),
      });
    };
    await Promise.all([captureStartGit(), captureStartSnapshot()]);
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
      ...(input.paneId ? { paneId: input.paneId } : {}),
      // The session it reopens, until its own log says otherwise: a second close before it writes keeps it exact.
      ...(input.resumeArgs?.length ? { resumeArgs: input.resumeArgs } : {}),
      ...(input.engine.harness ? { localHarness: input.engine.harness } : {}),
      ...(input.engine.localModel ? { localModel: input.engine.localModel } : {}),
    };
    this.store.saveRun(meta);
    let spawned: { ptyId: string; pid: number; ptyToken?: string };
    try {
      spawned = await this.options.host.spawn({
        cwd: input.cwd,
        argv: spawnArgv,
        ...(input.engine.env && Object.keys(input.engine.env).length ? { env: input.engine.env } : {}),
        runDir: dir,
        pasteInput,
        cols: input.cols,
        rows: input.rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dirtyAtStart.delete(id);
      this.gitAtStart.delete(id);
      await removeRunSnapshots(meta);
      this.store.saveRun({ ...meta, status: "failed", endedAt: this.now().toISOString(), error: message, ...(meta.origin === "routine" ? { result: "failed" as const } : {}) });
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
      ...(input.paneId ? { paneId: input.paneId } : {}),
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
    if (input.continuedFrom) this.settleCutOff([input.continuedFrom]);
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
      const planned = this.pendingOutcome.get(session.runId);
      this.pendingOutcome.delete(session.runId);
      const resolvedStatus: "exited" | "stopped" = planned ? planned.status : run?.stopRequested ? "stopped" : "exited";
      const resolvedExit = planned && planned.exitCode !== undefined ? planned.exitCode : exitCode;
      const resolvedSignal = planned?.status === "exited" && planned.exitCode === 0 ? null : signal;
      const resolvedError = planned?.error ?? error ?? undefined;
      const resolvedResult: RoutineRunResult | undefined = planned?.result ?? (run?.origin === "routine" ? routineExitResult(run, resolvedStatus, resolvedExit, signal, error) : undefined);
      const done = this.finishRun(session.runId, {
        exitCode: resolvedExit,
        signal: resolvedSignal,
        status: resolvedStatus,
        ...(resolvedError ? { error: resolvedError } : {}),
        ...(resolvedResult ? { result: resolvedResult } : {}),
      });
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
    outcome: { exitCode: number | null; signal: number | null; status: "exited" | "stopped"; error?: string; result?: RoutineRunResult },
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
    if (!isRunInCopy(run.cwd, this.options.dataRoot)) {
      await takeEndSnapshot({
        cwd: run.cwd,
        runId: run.id,
        runDir: run.dir,
        onWarn: (message) => this.options.host.logWarn?.(message),
      });
      if (this.closed) return;
    }
    const latest = this.store.getRun(runId) ?? run;
    const before = this.gitAtStart.get(runId);
    this.gitAtStart.delete(runId);
    this.dirtyAtStart.delete(runId);
    // Only edits that were there before it started, left as they were: none of this run's doing.
    const untouched = Boolean(dirty?.size) && own !== null && !own.trim() && !git.includes("commits since the run started");
    const status = latest.stopRequested ? "stopped" : outcome.status;
    const result = outcome.result ?? (status === "stopped" ? (latest.result ?? undefined) : latest.result === "question" ? undefined : (latest.result ?? undefined));
    const finished = this.store.saveRun({
      ...latest,
      status,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      endedAt: this.now().toISOString(),
      ...(outcome.error ? { error: outcome.error } : {}),
      result,
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
        outcome:
          finished.result === "timeout" || finished.result === "cutoff" || finished.result === "failed"
            ? "failed"
            : finished.status === "stopped" || finished.result === "stuck"
              ? "stopped"
              : finished.status === "failed" || (finished.exitCode && finished.exitCode !== 0)
                ? "failed"
                : "ok",
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
      run.result === "timeout"
        ? "hit its time limit"
        : run.result === "limit"
          ? "ended at its time limit"
          : run.result === "stuck"
          ? "stuck on a question"
          : isCutOffRun(run)
          ? "cut off"
          : run.status === "stopped"
            ? "stopped"
            : run.status === "failed" && run.exitCode === null
              ? `couldn't start: ${run.error ?? "unknown error"}`
              : run.exitCode && run.exitCode !== 0
                ? `exited with code ${run.exitCode}`
                : run.result === "failed" && run.signal !== null
                  ? `ended by signal ${run.signal}`
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
      await removeRunSnapshots(run);
      if (this.closed) return;
      this.store.saveRun({
        ...run,
        status: "stopped",
        endedAt: run.endedAt ?? this.now().toISOString(),
        error: run.error ?? "VibeForge closed while this run was going.",
        ...(run.origin === "routine" && run.result !== "timeout" ? { result: "cutoff" as const } : {}),
        changes,
        cutOff: run.cutOff ?? "crash",
      });
      if (run.taskId) {
        // Only when this orphan is still the task's run: an Execute during settling owns it now.
        const task = this.store.getTask(run.taskId);
        if (task?.status === "running" && task.runIds.at(-1) === run.id) this.store.writeTask({ ...task, status: "review" });
      }
    }
    if (orphans.length) {
      // Offered back at this start, as a quit's are; a routine's next slot is its own retry.
      const runIds = orphans.filter((run) => run.origin !== "routine").map((run) => run.id);
      // A quit or update whose last runs were never recorded left these behind: they join its note,
      // which keeps its reason. Otherwise VibeForge went down, and this start offers what it cut off.
      const noted = this.readNote();
      if (noted && runIds.some((id) => noted.runIds.includes(id))) this.noteCutOff({ ...noted, runIds: [...new Set([...noted.runIds, ...runIds])] });
      else if (runIds.length) this.noteCutOff({ reason: "crash", at: this.now().toISOString(), runIds, offered: true });
      this.emit("runs", "tasks", "routines");
    }
  }

  private async settleTrash(trashed: unknown[]): Promise<void> {
    if (!trashed.length) return;
    const copies = readJson<{ copies?: Array<{ id?: string }> } | null>(path.join(this.options.dataRoot, "orchestrator", "copies.json"), null)?.copies ?? [];
    for (const item of trashed) {
      if (this.closed) return;
      if (!item || typeof item !== "object") continue;
      const note = item as { kind?: unknown; taskId?: unknown; copy?: WorkingCopy };
      if (note.kind !== "copy" || typeof note.taskId !== "string" || !note.copy) continue;
      // A task, routine, or Viby copy that still holds this folder/branch keeps it.
      const ownedByRoutine =
        note.taskId.startsWith("routine-") && Boolean(this.store.getRoutine(note.taskId.slice("routine-".length))?.copy);
      if (this.store.getTask(note.taskId)?.copy || ownedByRoutine || copies.some((entry) => entry?.id === note.taskId)) continue;
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

  /**
   * Before the app quits: mark every live run as stopped on purpose, so its exit records "stopped",
   * and as cut off by this close (`reason`), so the next start offers to pick it back up. A
   * routine's run is recorded as cut off; its next slot is its own retry, so it isn't offered.
   */
  prepareShutdown(reason: CutOff = "quit"): void {
    const cut: string[] = [];
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      const run = this.store.getRun(session.runId);
      if (!run || run.status !== "running" || run.stopRequested) continue;
      if (run.origin === "routine") {
        this.pendingOutcome.set(run.id, { status: "stopped", result: "cutoff", error: "Stopped when VibeForge quit." });
        this.store.saveRun({ ...run, stopRequested: true, cutOff: reason, result: "cutoff", error: "Stopped when VibeForge quit." });
        continue;
      }
      this.store.saveRun({ ...run, stopRequested: true, cutOff: reason });
      cut.push(run.id);
    }
    this.noteCutOff({ reason, at: this.now().toISOString(), runIds: cut });
  }

  // ---------------------------------------------------------------- runs cut off by a close

  /** The runs the last close cut off, still to be picked back up or let go. */
  private cutOffNote: CutOffNote | null | undefined;

  private noteCutOff(note: CutOffNote): void {
    if (this.closed) return;
    this.cutOffNote = note;
    try {
      writeCutOff(this.options.dataRoot, note);
    } catch {
      /* the offer is a nicety; the runs themselves are recorded */
    }
  }

  /**
   * The note as this start found it. It is offered at this start only: the next one drops it unless
   * a close wrote a new one, so an offer ignored once doesn't come back days later.
   */
  private readNote(): CutOffNote | null {
    if (this.cutOffNote !== undefined) return this.cutOffNote;
    const found = readCutOff(this.options.dataRoot);
    if (found?.offered) {
      this.noteCutOff({ ...found, runIds: [] });
      return this.cutOffNote ?? null;
    }
    this.cutOffNote = found;
    if (found?.runIds.length) this.noteCutOff({ ...found, offered: true });
    return this.cutOffNote;
  }

  /** What the last close cut off and how it closed, with what each run needs to reopen its session. */
  async cutOffRuns(): Promise<{ reason: CutOff; at: string; runs: CutOffRun[] } | null> {
    // A crash's runs are noted once they are settled, which can take a moment after start.
    await this.settled;
    const note = this.readNote();
    if (!note?.runIds.length) return null;
    const runs: CutOffRun[] = [];
    for (const id of note.runIds) {
      const run = this.store.getRun(id);
      // Already picked up (a live run again), or deleted since.
      if (!run || run.status === "running" || this.ptyByRun.has(id)) continue;
      runs.push({
        runId: run.id,
        title: run.title,
        origin: run.origin,
        engine: run.engine,
        workspaceId: run.workspaceId,
        paneId: run.paneId ?? null,
        chatId: run.chatId,
        taskId: run.taskId,
        exact: Boolean(this.exactResume(run)),
      });
    }
    return runs.length ? { reason: note.reason, at: note.at, runs } : null;
  }

  /** These were picked back up, or let go: they are not offered again. */
  settleCutOff(runIds: readonly string[]): void {
    const note = this.readNote();
    if (!note || !runIds.some((id) => note.runIds.includes(id))) return;
    this.noteCutOff(settleCutOff(note, runIds) ?? note);
    this.emit("runs");
  }

  /** The pane's cut-off run is let go: something else started there. */
  settleCutOffInPane(paneId: string): void {
    const note = this.readNote();
    const ids = note?.runIds.filter((id) => this.store.getRun(id)?.paneId === paneId) ?? [];
    if (ids.length) this.settleCutOff(ids);
  }

  /** The live run that already picks `runId` back up, if one does: a second Continue goes there. */
  continuedLive(runId: string): { runId: string; ptyId: string } | null {
    for (const session of this.live.values()) {
      if (!session.runId) continue;
      if (this.store.getRun(session.runId)?.continuedFrom === runId) return { runId: session.runId, ptyId: session.ptyId };
    }
    return null;
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
      this.store.saveRun({
        ...run,
        status: "stopped",
        stopRequested: true,
        endedAt: ended,
        error: "Stopped when VibeForge quit.",
        cutOff: run.cutOff ?? "quit",
        ...(run.origin === "routine" ? { result: "cutoff" as const } : {}),
      });
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

/**
 * How a routine's run ended when its terminal did, with no outcome planned for it: cut off when
 * the terminal host stopped under it (`error` is only given then), finished when the CLI quit by
 * itself with code 0, failed when it quit with an error code or was ended by a signal. A person's
 * Stop records no result; neither does an exit that says nothing (no code, no signal).
 */
function routineExitResult(run: RunMeta, status: "exited" | "stopped", exitCode: number | null, signal: number | null, error: string | null): RoutineRunResult | undefined {
  if (error) return "cutoff";
  if (status !== "exited") return run.result === "question" ? undefined : (run.result ?? undefined);
  if (exitCode === 0) return "finished";
  if ((exitCode !== null && exitCode !== 0) || signal !== null) return "failed";
  return undefined;
}
