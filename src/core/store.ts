import { ensureLayout } from "./layout.js";
import type { RUN_FILES } from "./runs.js";
import { Chats } from "./store/chats.js";
import { Config } from "./store/config.js";
import { Library } from "./store/library.js";
import { ReadCache } from "./store/read-cache.js";
import { RunIndex, type RunQuery } from "./store/run-index.js";
import type { WorkspaceFile } from "./workspaces.js";
import type { Agent, ChatRecord, EngineRow, LayoutNode, Routine, RunMeta, Settings, Skill, Task } from "./types.js";

export { defaultSettings } from "./store/config.js";
export { agentTier, MEMORY_STARTER, oneLine, parseSkill, skillDocument } from "./store/library.js";
export { matchExpression, type RunQuery } from "./store/run-index.js";

/**
 * Everything VibeForge keeps on disk, behind one API: the run index, the config folder's JSON
 * files, the hand-edited library and the chats. Each lives in `./store/`; this class opens them
 * and passes each call on.
 */
export class Store {
  readonly configRoot: string;
  readonly dataRoot: string;
  private readonly runs: RunIndex;
  private readonly config: Config;
  private readonly library: Library;
  private readonly chats: Chats;

  constructor(configRoot: string, dataRoot: string) {
    this.configRoot = configRoot;
    this.dataRoot = dataRoot;
    ensureLayout(configRoot, dataRoot);
    this.runs = new RunIndex(dataRoot);
    const cache = new ReadCache();
    this.config = new Config(configRoot, cache);
    this.library = new Library(configRoot, cache);
    this.chats = new Chats(dataRoot, cache);
  }

  close(): void {
    this.runs.close();
  }

  // ---------------------------------------------------------------- runs (store/run-index.ts)

  reindex(): number {
    return this.runs.reindex();
  }

  saveRun(meta: RunMeta): RunMeta {
    return this.runs.saveRun(meta);
  }

  getRun(id: string): RunMeta | null {
    return this.runs.getRun(id);
  }

  queryRuns(query: RunQuery = {}): RunMeta[] {
    return this.runs.queryRuns(query);
  }

  indexRunText(meta: RunMeta, transcript: string): void {
    this.runs.indexRunText(meta, transcript);
  }

  runsMissingText(limit: number): RunMeta[] {
    return this.runs.runsMissingText(limit);
  }

  searchRuns(text: string, limit = 50): Array<{ run: RunMeta; snippet: string }> {
    return this.runs.searchRuns(text, limit);
  }

  allRuns(): RunMeta[] {
    return this.runs.allRuns();
  }

  deleteRun(run: RunMeta): void {
    this.runs.deleteRun(run);
  }

  deleteRunFile(run: RunMeta, file: keyof typeof RUN_FILES): void {
    this.runs.deleteRunFile(run, file);
  }

  // ---------------------------------------------------------------- settings, engines & layouts (store/config.ts)

  readSettings(): Settings {
    return this.config.readSettings();
  }

  writeSettings(settings: Settings): void {
    this.config.writeSettings(settings);
  }

  readEngineRows(): EngineRow[] {
    return this.config.readEngineRows();
  }

  writeEngineRows(rows: EngineRow[]): void {
    this.config.writeEngineRows(rows);
  }

  readWorkspaces(): WorkspaceFile {
    return this.config.readWorkspaces();
  }

  writeWorkspaces(file: WorkspaceFile): void {
    this.config.writeWorkspaces(file);
  }

  readLayout(workspaceId: string): LayoutNode | null {
    return this.config.readLayout(workspaceId);
  }

  writeLayout(workspaceId: string, layout: LayoutNode | null): void {
    this.config.writeLayout(workspaceId, layout);
  }

  // ---------------------------------------------------------------- agents, skills, routines & tasks (store/library.ts)

  uniqueId(dir: string, base: string, extension: string): string {
    return this.library.uniqueId(dir, base, extension);
  }

  listAgents(): Agent[] {
    return this.library.listAgents();
  }

  getAgent(id: string): Agent | null {
    return this.library.getAgent(id);
  }

  writeAgent(agent: Agent): void {
    this.library.writeAgent(agent);
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

  getSkill(id: string): Skill | null {
    return this.library.getSkill(id);
  }

  readSkillRaw(id: string): string | null {
    return this.library.readSkillRaw(id);
  }

  writeSkill(skill: Skill): void {
    this.library.writeSkill(skill);
  }

  pathOf(kind: "skill" | "routine" | "task", id: string): string | null {
    return this.library.pathOf(kind, id);
  }

  deleteSkill(id: string): void {
    this.library.deleteSkill(id);
  }

  listRoutines(): Routine[] {
    return this.library.listRoutines();
  }

  getRoutine(id: string): Routine | null {
    return this.library.getRoutine(id);
  }

  writeRoutine(routine: Routine): void {
    this.library.writeRoutine(routine);
  }

  deleteRoutine(id: string): void {
    this.library.deleteRoutine(id);
  }

  listTasks(): Task[] {
    return this.library.listTasks();
  }

  getTask(id: string): Task | null {
    return this.library.getTask(id);
  }

  writeTask(task: Task): void {
    this.library.writeTask(task);
  }

  deleteTask(id: string): void {
    this.library.deleteTask(id);
  }

  // ---------------------------------------------------------------- chats (store/chats.ts)

  listChats(): ChatRecord[] {
    return this.chats.listChats();
  }

  getChat(id: string): ChatRecord | null {
    return this.chats.getChat(id);
  }

  writeChat(chat: ChatRecord): void {
    this.chats.writeChat(chat);
  }

  deleteChat(id: string): void {
    this.chats.deleteChat(id);
  }
}
