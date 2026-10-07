import { ServiceCore } from "./service/core.js";
import { LibraryDesk } from "./service/library.js";
import { WorkspaceDesk } from "./service/workspaces.js";
import { RoutineDesk } from "./service/routines.js";
import { TaskDesk } from "./service/tasks.js";
import { ChatDesk } from "./service/chats.js";
import { RunDesk } from "./service/runs.js";
import { ShellRecorder } from "./service/shell-runs.js";
import { FolderTurns } from "./service/turns.js";
import type { TickDecision } from "./routines.js";
import type { RunQuery } from "./store.js";
import type { Agent, LayoutNode, LiveSession, Routine, Schedule, Skill, TaskStatus } from "./types.js";
import type { WorkspaceFile } from "./workspaces.js";
import type { BranchList } from "./branches.js";
import type { ApplyResult } from "./worktrees.js";
import type { Writer } from "./checkout.js";
import type { AgentInput, ChatView, Deleted, Launched, Queued, RoutineInput, RoutineView, RunBundle, RunHit, RunView, SchedulePreview, SendResult, SkillInput, StorageSummary, RunUpkeep, TaskInput, TaskView, TermSize } from "./service/types.js";

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

  override close(): void {
    this.turns.close();
    super.close();
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

  deleteAgent(id: string, confirmName: string): void {
    this.library.deleteAgent(id, confirmName);
  }

  readMemory(agentId: string): string {
    return this.library.readMemory(agentId);
  }

  writeMemory(agentId: string, text: string): void {
    this.library.writeMemory(agentId, text);
  }

  listSkills(): Skill[] {
    return this.library.listSkills();
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

  addWorkspace(folder: string): WorkspaceFile {
    return this.workspaces.addWorkspace(folder);
  }

  removeWorkspace(id: string): Promise<WorkspaceFile> {
    return this.workspaces.removeWorkspace(id);
  }

  selectWorkspace(id: string): void {
    this.workspaces.selectWorkspace(id);
  }

  moveWorkspace(id: string, toIndex: number): WorkspaceFile {
    return this.workspaces.moveWorkspace(id, toIndex);
  }

  updateWorkspace(id: string, patch: { name?: string; dockUrl?: string }): WorkspaceFile {
    return this.workspaces.updateWorkspace(id, patch);
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

  startShell(opts: { workspaceId?: string; cwd?: string } & TermSize): Promise<{ ptyId: string }> {
    return this.workspaces.startShell(opts);
  }

  startCommand(opts: { command: string; title: string; cwd: string } & TermSize): Promise<{ ptyId: string }> {
    return this.workspaces.startCommand(opts);
  }

  startEngine(opts: { workspaceId: string; engineId: string; prompt?: string; continueSession?: boolean } & TermSize): Promise<Launched> {
    return this.workspaces.startEngine(opts);
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

  executeTask(id: string, size: TermSize = {}, now = false): Promise<Launched | Queued> {
    return this.tasks.executeTask(id, size, false, now);
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
    return this.turns.withNeighbours();
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

  discardTaskCopy(id: string): Promise<TaskView> {
    return this.tasks.discardCopy(id);
  }

  // ---------------------------------------------------------------- chats

  listChats(filter: { agentId?: string | null } = {}): ChatView[] {
    return this.chats.listChats(filter);
  }

  createChat(input: { agentId?: string | null; engine?: string }): ChatView {
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

  sendChat(id: string, text: string, size: TermSize = {}): Promise<SendResult> {
    return this.chats.sendChat(id, text, size);
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

  onPtyProgram(ptyId: string, argv: string[] | null, cwd: string | null = null): void {
    this.shellRuns.onPtyProgram(ptyId, argv, cwd);
  }

  onPtyActivity(ptyId: string, working: boolean): void {
    this.shellRuns.onPtyActivity(ptyId, working);
  }
}
