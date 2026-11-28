import { ServiceCore } from "./service/core.js";
import { LibraryDesk } from "./service/library.js";
import { WorkspaceDesk } from "./service/workspaces.js";
import { RoutineDesk } from "./service/routines.js";
import { TaskDesk } from "./service/tasks.js";
import { ChatDesk } from "./service/chats.js";
import { RunDesk } from "./service/runs.js";
import { ShellRecorder } from "./service/shell-runs.js";
import { SessionTracker } from "./service/session-tracker.js";
import { FolderTurns, type SavedTurn } from "./service/turns.js";
import { MessageDesk, type TaskResult, type TellResult, type WhoResult } from "./service/messages.js";
import { OrchestratorDesk } from "./service/orchestrator.js";
import os from "node:os";
import path from "node:path";
import { detectLocalRuntimes, probeLocalServer, LOCAL_ENGINE_ID, normalizeLocalUrl, type LocalRuntimeStatus, type LocalServerProbe } from "./local.js";
import { LocalServerRunner } from "./local-server.js";
import { localServerPlan, localServerWanted, type LocalServerView } from "../shared/local.js";
import type { CutOff, Settings } from "./types.js";
import type { Looking, OrchestratorView, StepPatch, VibyWord } from "./orchestrator.js";
import type { TickDecision } from "./routines.js";
import type { RunQuery } from "./store.js";
import type { Agent, LayoutNode, LiveSession, Routine, Schedule, Skill, TaskStatus, UnreadableItem, WorkspaceCategory } from "./types.js";
import type { WorkspaceFile } from "./workspaces.js";
import type { BranchList } from "./branches.js";
import type { ApplyResult } from "./worktrees.js";
import type { Writer } from "./checkout.js";
import type { AgentInput, ChatView, Deleted, DeskOptions, Launched, Queued, RememberResult, RoutineInput, RoutineView, RunBundle, RunHit, RunRestorePreview, RunRestoreResult, RunView, SchedulePreview, SendResult, SkillInput, StorageSummary, RunUpkeep, TaskInput, TaskView, TermSize, WorkspaceSummary } from "./service/types.js";

export * from "./service/types.js";

/**
 * Everything VibeForge does with agents, routines, tasks, chats and runs, behind one API for the
 * main process. The work is split by subject into `./service/`; this class only puts it together.
 */
export class TeamService extends ServiceCore {
  private readonly library = new LibraryDesk(this);
  private readonly workspaces = new WorkspaceDesk(this);
  private readonly turns = new FolderTurns(this);
  private readonly routines = new RoutineDesk(this, this.turns);
  private readonly tasks = new TaskDesk(this, this.turns);
  private readonly chats = new ChatDesk(this);
  private readonly runs = new RunDesk(this, this.chats, this.tasks);
  private readonly shellRuns = new ShellRecorder(this);
  private readonly sessions = new SessionTracker(this);
  private readonly messages = new MessageDesk(this, this.tasks);
  readonly orchestrator = new OrchestratorDesk(this, this.workspaces, this.messages, this.tasks, this.routines, this.runs, this.library, this.chats);

  /** The Local AI server started from Settings → Local AI → Run a server. */
  private readonly localServer: LocalServerRunner;

  constructor(options: DeskOptions) {
    super(options);
    // Each live CLI's exact session, read from its own log, so a close can't lose which one it was.
    this.sessions.start();
    // What was waiting for its folder when VibeForge last closed waits again.
    this.turns.restore((saved) => this.resumeWait(saved));
    this.localServer = new LocalServerRunner({
      logFile: path.join(options.dataRoot, "logs", "local-server.log"),
      probe: async (url) => (await probeLocalServer(url, { timeoutMs: 1000 })).reachable,
      onChange: () => this.emit("localServer"),
      onReady: (url) => void this.localServerReady(url),
    });
    // Opened in Local mode with "Start with Local mode" on: the server comes up with VibeForge.
    const settings = this.store.readSettings();
    if (settings.local.server.managed && settings.local.server.withLocalMode && this.wantsLocalServer(settings)) queueMicrotask(() => void this.localServerStart().catch(() => undefined));
  }

  /** A task's Execute or a routine's Run now, saved while it waited, with its start again; null once it's gone. */
  private resumeWait(saved: SavedTurn): { start: () => Promise<unknown>; failed: (message: string) => void } | null {
    if (saved.kind === "task") {
      const task = this.store.getTask(saved.id);
      if (!task) return null;
      return {
        start: () => this.tasks.executeTask(saved.id),
        failed: (message) => this.options.host.notify({ title: task.title, body: message, taskId: saved.id }),
      };
    }
    const routine = this.store.getRoutine(saved.id);
    if (!routine) return null;
    return {
      start: () => this.routines.runRoutineNow(saved.id),
      failed: (message) => {
        if (this.store.readSettings().notify && routine.notify) this.options.host.notify({ title: routine.name, body: message, routineId: saved.id });
      },
    };
  }

  override prepareShutdown(reason: CutOff = "quit"): void {
    // The CLIs are about to end, which frees their folders: nothing waiting should start now.
    this.turns.hold();
    this.sessions.stop();
    // The Local AI server VibeForge started ends with it (it holds the GPU's memory).
    void this.localServer.stop();
    super.prepareShutdown(reason);
  }

  /** One more look at which session each live CLI is in, before a quit ends them. */
  lookForSessions(): Promise<void> {
    return this.sessions.look();
  }

  override close(): Promise<void> {
    this.sessions.stop();
    this.turns.close();
    this.messages.close();
    this.orchestrator.close();
    const stopped = this.localServer.stop().then(() => undefined);
    return Promise.all([super.close(), stopped]).then(() => undefined);
  }

  /** A close that couldn't wait: the server is told to end on the way out. */
  disposeLocalServer(): void {
    this.localServer.dispose();
  }

  // ---------------------------------------------------------------- settings

  override saveSettings(patch: Parameters<ServiceCore["saveSettings"]>[0]): Settings {
    const before = this.store.readSettings();
    const next = super.saveSettings(patch);
    if (patch.local || patch.orchestrator) this.followLocalMode(before, next);
    return next;
  }

  /** Local mode wants the server: Local AI on, and in Local mode or with Viby planning on Local. */
  private wantsLocalServer(settings: Settings): boolean {
    return localServerWanted(settings.local, settings.orchestrator.engine === LOCAL_ENGINE_ID);
  }

  /** "Start with Local mode": the server comes up as Local mode turns on, and goes as it turns off. */
  private followLocalMode(before: Settings, after: Settings): void {
    // Switched to a server that is already running (or elsewhere): the one VibeForge started goes.
    if (before.local.server.managed && !after.local.server.managed) {
      void this.localServer.stop();
      return;
    }
    if (!after.local.server.managed || !after.local.server.withLocalMode) return;
    const wanted = this.wantsLocalServer(after);
    if (wanted === this.wantsLocalServer(before)) return;
    if (wanted) void this.localServerStart().catch(() => undefined);
    else void this.localServer.stop();
  }

  // ---------------------------------------------------------------- the Local AI server VibeForge runs

  localServerView(): LocalServerView {
    const local = this.store.readSettings().local;
    const resolve = this.options.host.resolveBin;
    const worked = localServerPlan(local.server, local.url, resolve, os.homedir());
    return {
      state: this.localServer.view(),
      plan: worked.plan,
      problem: worked.problem,
      found: {
        llamacpp: Boolean(resolve("llama-server")),
        ollama: Boolean(resolve("ollama")),
        lmstudio: Boolean(resolve("lms") ?? resolve(path.join(os.homedir(), ".lmstudio", "bin", "lms"))),
      },
    };
  }

  async localServerStart(): Promise<LocalServerView> {
    const local = this.store.readSettings().local;
    const worked = localServerPlan(local.server, local.url, this.options.host.resolveBin, os.homedir());
    if (worked.plan) await this.localServer.start(worked.plan);
    else this.localServer.refuse(worked.problem);
    return this.localServerView();
  }

  async localServerStop(): Promise<LocalServerView> {
    await this.localServer.stop();
    return this.localServerView();
  }

  /** It answers: Local AI points at it, and its models are listed in the pickers. */
  private async localServerReady(url: string): Promise<void> {
    const local = this.store.readSettings().local;
    if (normalizeLocalUrl(local.url) !== url || !local.enabled) this.saveSettings({ local: { enabled: true, url } });
    const probe = await probeLocalServer(url).catch(() => null);
    if (!probe?.reachable) return;
    const current = this.store.readSettings().local;
    const ids = probe.models.map((m) => m.id);
    // A model picked that this server doesn't have: its first one, so Local mode can start at once.
    if (ids.length && (!current.model || !ids.includes(current.model))) this.saveSettings({ local: { model: probe.models.find((m) => m.loaded)?.id ?? ids[0] } });
    if (this.recordLocalProbe(probe)) this.emit("orchestrator");
    this.emit("settings");
  }

  // ---------------------------------------------------------------- library

  listAgents(): Agent[] {
    return this.library.listAgents();
  }

  getAgent(id: string): Agent | null {
    return this.library.getAgent(id);
  }

  saveAgent(input: AgentInput): Agent {
    return this.library.saveAgent(input);
  }

  deleteAgent(id: string): Promise<Deleted> {
    return this.library.deleteAgent(id);
  }

  readMemory(agentId: string): string {
    return this.library.readMemory(agentId);
  }

  writeMemory(agentId: string, text: string): void {
    this.library.writeMemory(agentId, text);
  }

  rememberFromPty(input: { fromPty: string | null; text: string }): RememberResult {
    return this.library.rememberFromPty(input);
  }

  listSkills(): Skill[] {
    return this.library.listSkills();
  }

  /** The agent, skill, routine and task files the lists left out because they couldn't be read. */
  unreadableItems(): UnreadableItem[] {
    return this.store.unreadableItems();
  }

  saveSkill(input: SkillInput): Skill {
    return this.library.saveSkill(input);
  }

  deleteSkill(id: string): Deleted {
    return this.library.deleteSkill(id);
  }

  setSkillAgents(skillId: string, agentIds: string[]): void {
    this.library.setSkillAgents(skillId, agentIds);
  }

  // ---------------------------------------------------------------- workspaces

  listWorkspaces(): WorkspaceFile {
    return this.workspaces.listWorkspaces();
  }

  summarizeWorkspaces(): Promise<Record<string, WorkspaceSummary>> {
    return this.workspaces.summarizeWorkspaces();
  }

  addWorkspace(folder: string, categoryId?: string | null): WorkspaceFile {
    return this.workspaces.addWorkspace(folder, categoryId);
  }

  removeWorkspace(id: string): Promise<Deleted> {
    return this.workspaces.removeWorkspace(id);
  }

  selectWorkspace(id: string): void {
    this.workspaces.selectWorkspace(id);
  }

  moveWorkspace(id: string, toIndex: number): WorkspaceFile {
    return this.workspaces.moveWorkspace(id, toIndex);
  }

  updateWorkspace(id: string, patch: { name?: string; dockUrl?: string; categories?: string[]; copySetup?: import("./types.js").WorkspaceCopySetup | null }): WorkspaceFile {
    return this.workspaces.updateWorkspace(id, patch);
  }

  addCategory(name: string): { file: WorkspaceFile; category: WorkspaceCategory } {
    return this.workspaces.addCategory(name);
  }

  renameCategory(id: string, name: string): WorkspaceFile {
    return this.workspaces.renameCategory(id, name);
  }

  moveCategory(id: string, toIndex: number): WorkspaceFile {
    return this.workspaces.moveCategory(id, toIndex);
  }

  deleteCategory(id: string): Deleted {
    return this.workspaces.deleteCategory(id);
  }

  setWorkspaceCategory(workspaceIds: string[], categoryId: string, on: boolean): WorkspaceFile {
    return this.workspaces.setWorkspaceCategory(workspaceIds, categoryId, on);
  }

  /** A folder as a workspace of its own, without making it the one Code shows (a workspace another machine synced here). */
  addWorkspaceQuietly(folder: string, name: string): string {
    return this.workspaces.addQuietly(folder, name);
  }

  listBranches(id: string): Promise<BranchList> {
    return this.workspaces.listBranches(id);
  }

  openBranch(id: string, branch: string): Promise<WorkspaceFile> {
    return this.workspaces.openBranch(id, branch);
  }

  getLayout(workspaceId: string): LayoutNode | null {
    return this.workspaces.getLayout(workspaceId);
  }

  saveLayout(workspaceId: string, layout: LayoutNode | null): void {
    this.workspaces.saveLayout(workspaceId, layout);
  }

  startShell(opts: { workspaceId?: string; cwd?: string; command?: string; paneId?: string; continueRun?: string } & TermSize): Promise<{ ptyId: string; reopenFailed?: string }> {
    return this.workspaces.startShell(opts);
  }

  startCommand(opts: { command: string; title: string; cwd: string } & TermSize): Promise<{ ptyId: string }> {
    return this.workspaces.startCommand(opts);
  }

  reopenInShell(ptyId: string, runId: string): Promise<void> {
    return this.workspaces.reopenInShell(ptyId, runId);
  }

  startEngine(opts: { workspaceId: string; engineId: string; prompt?: string; continueSession?: boolean; paneId?: string; continueRun?: string } & TermSize): Promise<Launched> {
    return this.workspaces.startEngine(opts);
  }

  // ---------------------------------------------------------------- the Orchestrator

  orchestratorView(): OrchestratorView {
    return this.orchestrator.view();
  }

  orchestratorAsk(text: string, looking?: Looking | null, images?: string[]): Promise<void> {
    return this.orchestrator.ask(text, looking, images);
  }

  orchestratorImageData(name: string): string | null {
    return this.orchestrator.imageData(name);
  }

  orchestratorLooking(looking: Looking | null): void {
    this.orchestrator.looking = looking;
  }

  /**
   * A call is on (`heard` takes what Viby says by itself: a note about a CLI, an answer read out),
   * or over (null). While one is on, the window follows what Viby starts and tells.
   */
  orchestratorCall(heard: ((word: VibyWord) => void) | null): void {
    this.orchestrator.onCall = heard;
  }

  orchestratorModels(engineId: string): Promise<string[]> {
    return this.orchestrator.listModels(engineId);
  }

  async localStatus(url?: string): Promise<LocalRuntimeStatus> {
    const local = this.store.readSettings().local;
    const rows = this.store.readEngineRows();
    const status = await detectLocalRuntimes({ url: url ?? local.url }, rows, this.options.host.resolveBin);
    let changed = false;
    for (const srv of status.servers) if (srv.reachable && this.recordLocalProbe(srv)) changed = true;
    if (status.configured?.reachable && this.recordLocalProbe(status.configured)) changed = true;
    if (changed) this.emit("orchestrator");
    return status;
  }

  async localProbe(url: string): Promise<LocalServerProbe> {
    const probe = await probeLocalServer(url);
    if (probe.reachable && this.recordLocalProbe(probe)) this.emit("orchestrator");
    return probe;
  }

  orchestratorStopThinking(silent = false): void {
    this.orchestrator.stopThinking(silent);
  }

  orchestratorQuickShow(target: string, rawSaid: string, sayText: (label: string) => string): Promise<string | null> {
    return this.orchestrator.quickShow(target, rawSaid, sayText);
  }

  orchestratorQuickAct(
    text: string,
    looking?: Looking | null,
    words?: Parameters<OrchestratorDesk["quickAct"]>[2],
  ): Promise<{ handled: boolean; reply?: string }> {
    return this.orchestrator.quickAct(text, looking, words);
  }

  orchestratorClear(): void {
    this.orchestrator.clear();
  }

  orchestratorSelectThread(id: string): void {
    this.orchestrator.selectThread(id);
  }

  orchestratorRenameThread(id: string, title: string): void {
    this.orchestrator.renameThread(id, title);
  }

  orchestratorDeleteThread(id: string): Deleted {
    return this.orchestrator.deleteThread(id);
  }

  orchestratorReadMemory(): string {
    return this.orchestrator.readMemory();
  }

  orchestratorWriteMemory(text: string): void {
    this.orchestrator.writeMemory(text);
  }

  orchestratorRun(turnId: string): Promise<void> {
    return this.orchestrator.run(turnId);
  }

  orchestratorCancel(turnId: string): void {
    this.orchestrator.cancel(turnId);
  }

  orchestratorEditStep(turnId: string, stepId: string, patch: StepPatch): void {
    this.orchestrator.editStep(turnId, stepId, patch);
  }

  orchestratorRemoveStep(turnId: string, stepId: string): void {
    this.orchestrator.removeStep(turnId, stepId);
  }

  orchestratorCopyDiff(copyId: string): Promise<string> {
    return this.orchestrator.copyDiff(copyId);
  }

  orchestratorApplyCopy(copyId: string): Promise<ApplyResult> {
    return this.orchestrator.applyCopy(copyId);
  }

  orchestratorDiscardCopy(copyId: string): Promise<Deleted> {
    return this.orchestrator.discardCopy(copyId);
  }

  // ---------------------------------------------------------------- routines

  listRoutines(): RoutineView[] {
    return this.routines.listRoutines();
  }

  previewSchedule(schedule: Schedule): SchedulePreview {
    return this.routines.previewSchedule(schedule);
  }

  saveRoutine(input: RoutineInput): Routine {
    return this.routines.saveRoutine(input);
  }

  deleteRoutine(id: string): Deleted {
    return this.routines.deleteRoutine(id);
  }

  setRoutineEnabled(id: string, enabled: boolean): Routine {
    return this.routines.setRoutineEnabled(id, enabled);
  }

  runRoutineNow(id: string, size: TermSize = {}, now = false): Promise<Launched | Queued> {
    return this.routines.runRoutineNow(id, size, now);
  }

  cancelRoutineWait(id: string): void {
    this.routines.cancelWait(id);
  }

  tick(now: Date = this.now()): Promise<Array<{ routineId: string; decision: TickDecision; error?: string }>> {
    return this.routines.tick(now);
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): TaskView[] {
    return this.tasks.listTasks();
  }

  saveTask(input: TaskInput): TaskView {
    return this.tasks.saveTask(input);
  }

  deleteTask(id: string): Promise<Deleted> {
    return this.tasks.deleteTask(id);
  }

  async executeTask(id: string, size: TermSize = {}, now = false): Promise<Launched | Queued> {
    const launched = await this.tasks.executeTask(id, size, false, now);
    // A handed-out task started from the board still reports to the CLI that handed it out.
    if ("ptyId" in launched) this.messages.adoptStarted(id, launched.ptyId);
    return launched;
  }

  continueTask(id: string, size: TermSize = {}, followUp: string | null = null): Promise<Launched> {
    return this.tasks.continueTask(id, size, followUp);
  }

  cancelTaskWait(id: string): TaskView {
    return this.tasks.cancelWait(id);
  }

  handOff(runId: string, agentId: string): TaskView {
    return this.tasks.handOff(runId, agentId);
  }

  /** Start whatever is waiting for a folder that has come free (also every few seconds on its own). */
  checkWaiting(): Promise<void> {
    return this.turns.check();
  }

  /** The live sessions for the window, each with who else is in its folder. */
  liveForView(): LiveSession[] {
    const sessions = this.turns.withNeighbours();
    const talk = this.messages.talkForEach(sessions.map((session) => session.ptyId));
    return sessions.map((session) => ({ ...session, talk: talk.get(session.ptyId) ?? null }));
  }

  // ---------------------------------------------------------------- agents talking

  /** The coding CLIs `vibeforge tell` can reach, and the agents `vibeforge task` can hand to. */
  whoIsHere(fromPty: string | null): WhoResult {
    return this.messages.who(fromPty);
  }

  tell(input: { fromPty: string | null; to: string; text: string; wait?: boolean; timeoutMs?: number; gone?: AbortSignal }): Promise<TellResult> {
    return this.messages.tell(input);
  }

  handTask(input: { fromPty: string | null; agent: string; text: string; title?: string; start?: boolean; wait?: boolean; timeoutMs?: number; gone?: AbortSignal }): Promise<TaskResult> {
    return this.messages.handTask(input);
  }

  /** Start on a terminal's title bar: the tasks it handed out that wait for a person. */
  startHeldTasks(ptyId: string, taskIds: readonly string[] | null = null): Promise<{ started: number; failed: string[] }> {
    return this.messages.startHeld(ptyId, taskIds);
  }

  /** `vibeforge apply <task>` from the CLI that handed the task out, when Settings allows it. */
  applyHandedTask(input: { fromPty: string | null; task: string }) {
    return this.messages.applyHanded(input);
  }

  /** Send to…: one pane's last answer, selection or changes, as a draft in another pane. */
  sendDraft(input: { fromPty: string; toPty: string; what: "reply" | "selection" | "changes"; selection?: string }): Promise<{ sent: boolean }> {
    return this.messages.sendDraft(input);
  }

  startReview(authorPty: string, reviewerPty: string): Promise<{ changes: boolean }> {
    return this.messages.startReview(authorPty, reviewerPty);
  }

  stopTalk(ptyId: string): void {
    this.messages.stop(ptyId);
  }

  /** A person typed into a terminal (not a message from another CLI). */
  onHumanInput(ptyId: string, data: string): void {
    this.messages.onHumanInput(ptyId, data);
  }

  /** Delivers waiting messages and reads answers now (also every second while any are in flight). */
  pumpMessages(): Promise<void> {
    return this.messages.pump();
  }

  /** The coding CLIs in a folder right now, for "also in this folder". */
  writersIn(folder: string): Promise<Writer[]> {
    return this.turns.writers(folder);
  }

  stopTask(id: string): Promise<TaskView> {
    return this.tasks.stopTask(id);
  }

  setTaskStatus(id: string, status: TaskStatus): TaskView {
    return this.tasks.setTaskStatus(id, status);
  }

  applyTaskCopy(id: string): Promise<ApplyResult> {
    return this.tasks.applyCopy(id);
  }

  discardTaskCopy(id: string): Promise<Deleted> {
    return this.tasks.discardCopy(id);
  }

  // ---------------------------------------------------------------- chats

  listChats(filter: { agentId?: string | null } = {}): ChatView[] {
    return this.chats.listChats(filter);
  }

  createChat(input: { agentId?: string | null; engine?: string; prompt?: string }): ChatView {
    return this.chats.createChat(input);
  }

  renameChat(id: string, title: string): ChatView {
    return this.chats.renameChat(id, title);
  }

  setChatEngine(id: string, engineId: string): ChatView {
    return this.chats.setChatEngine(id, engineId);
  }

  deleteChat(id: string): Promise<Deleted> {
    return this.chats.deleteChat(id);
  }

  async sendChat(id: string, text: string, size: TermSize = {}): Promise<SendResult> {
    const result = await this.chats.sendChat(id, text, size);
    // Typed into a live session by a person, like typing in its terminal.
    if (!result.started) this.messages.onHumanInput(result.ptyId, "\r");
    return result;
  }

  /** Start an agent in a workspace it is allowed to use, with its brief. */
  launchAgent(workspaceId: string, agentId: string, prompt: string | null, size: TermSize = {}): Promise<SendResult> {
    return this.chats.launchAgent(workspaceId, agentId, prompt, size);
  }

  continueChat(id: string, size: TermSize = {}): Promise<SendResult> {
    return this.chats.continueChat(id, size);
  }

  stopChat(id: string): Promise<void> {
    return this.chats.stopChat(id);
  }

  // ---------------------------------------------------------------- runs

  listRuns(query: RunQuery = {}): RunView[] {
    return this.runs.listRuns(query);
  }

  /** One run's index row, without reading its transcript or patch. */
  findRun(id: string): RunView | null {
    const run = this.store.getRun(id);
    return run ? this.view(run) : null;
  }

  inbox(now: Date = this.now()): RunView[] {
    return this.runs.inbox(now);
  }

  getRun(id: string): RunBundle {
    return this.runs.getRun(id);
  }

  loadRun(id: string): Promise<RunBundle> {
    return this.runs.loadRun(id);
  }

  markRunOpened(id: string, opened = true): void {
    this.runs.markRunOpened(id, opened);
  }

  markAllOpened(): void {
    this.runs.markAllOpened();
  }

  continueRun(id: string, size: TermSize = {}, followUp: string | null = null): Promise<Launched & { chatId: string | null; taskId: string | null }> {
    return this.runs.continueRun(id, size, followUp);
  }

  runDiff(id: string, source: "saved" | "now" = "saved"): Promise<string> {
    return this.runs.runDiff(id, source);
  }

  runMarkdown(id: string): Promise<string> {
    return this.runs.runMarkdown(id);
  }

  previewRunRestore(id: string): Promise<RunRestorePreview> {
    return this.runs.previewRestore(id);
  }

  restoreRun(id: string): Promise<RunRestoreResult> {
    return this.runs.restoreRun(id);
  }

  undoRunRestore(token: string): Promise<void> {
    return this.undoRunRestoreImpl(token);
  }

  private undoRunRestoreImpl(token: string): Promise<void> {
    return super.undoRunRestore(token);
  }

  searchRuns(text: string, limit?: number): RunHit[] {
    return this.runs.searchRuns(text, limit);
  }

  maintainRuns(): Promise<RunUpkeep> {
    return this.runs.maintainRuns();
  }

  storageSummary(): StorageSummary {
    return this.runs.storageSummary();
  }

  // ---------------------------------------------------------------- shell runs

  override onPtyProgram(ptyId: string, argv: string[] | null, cwd: string | null = null): void {
    this.shellRuns.onPtyProgram(ptyId, argv, cwd);
  }

  onPtyActivity(ptyId: string, working: boolean): void {
    this.shellRuns.onPtyActivity(ptyId, working);
    this.orchestrator.onActivity(ptyId, working);
    if (!working) void this.messages.pump();
  }

  override async onPtyExit(ptyId: string, exitCode: number | null, signal: number | null, error: string | null = null): Promise<void> {
    const session = this.live.get(ptyId);
    await super.onPtyExit(ptyId, exitCode, signal, error);
    // After the run is written, so what it changed is known.
    if (!this.closed) this.orchestrator.onExit(session);
  }
}
