import path from "node:path";
import { isDirectory } from "../fsx.js";
import { diffSince } from "../vcs.js";
import { plainPrompt } from "../preamble.js";
import { readRunFiles, RUN_FILES, type RunFiles } from "../runs.js";
import { repairBlankCapture } from "../restore-screen.js";
import { compressRun, folderBytes, hasRunFile, planCleanup, readRunText } from "../run-storage.js";
import { grokHome, readGrokPrompts } from "../session-prompts.js";
import type { RunQuery } from "../store.js";
import { type Launched, REVIEW_ORIGINS, type RunBundle, type RunHit, type RunUpkeep, type RunView, type StorageSummary, type TermSize, TWO_DAYS_MS } from "./types.js";
import type { ServiceCore } from "./core.js";
import type { ChatDesk } from "./chats.js";
import type { TaskDesk } from "./tasks.js";

/** The run index as the app reads it: lists, the review inbox, one run's files, its diff, and continuing it. */
export class RunDesk {
  constructor(
    private readonly core: ServiceCore,
    private readonly chats: ChatDesk,
    private readonly tasks: TaskDesk,
  ) {}

  /** The tidy-up pass in progress, if any. */
  private upkeep: Promise<RunUpkeep> | null = null;

  listRuns(query: RunQuery = {}): RunView[] {
    return this.core.store.queryRuns(query).map((run) => this.core.view(run));
  }

  inbox(now: Date = this.core.now()): RunView[] {
    // A Code session was watched as it happened; it only waits for review when it changed something.
    return this.listRuns({
      status: ["exited", "stopped", "failed"],
      unopened: true,
      origin: REVIEW_ORIGINS,
      since: new Date(now.getTime() - TWO_DAYS_MS).toISOString(),
    }).filter((run) => run.origin !== "code" || (run.changes !== null && run.changes !== "No changes"));
  }

  getRun(id: string): RunBundle {
    const run = this.core.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    const files: RunFiles = run.dir && isDirectory(run.dir)
      ? readRunFiles(run.dir)
      : { preamble: "", prompts: "", screen: "", scrollback: "", transcript: "", git: "", patchSaved: false };
    return { run: this.core.view(run), files };
  }

  /** The run plus its screen, transcript and, for a typed Grok, the prompts it was given. */
  async loadRun(id: string): Promise<RunBundle> {
    const bundle = this.getRun(id);
    let files = bundle.files;
    if (bundle.run.dir && bundle.run.status !== "running") {
      try {
        files = await repairBlankCapture(bundle.run.dir, files);
      } catch {
        /* the stored files still open */
      }
    }
    if (!files.preamble.trim() && bundle.run.engine === "grok" && bundle.run.cwd) {
      try {
        files = { ...files, prompts: readGrokPrompts(grokHome(), bundle.run.cwd, bundle.run.startedAt) };
      } catch {
        /* the prompt tab explains that none was handed over */
      }
    }
    return { ...bundle, files };
  }

  markRunOpened(id: string, opened = true): void {
    const run = this.core.store.getRun(id);
    if (!run) return;
    if (opened && (run.openedAt || run.status === "running")) return;
    this.core.store.saveRun({ ...run, openedAt: opened ? this.core.now().toISOString() : null });
    this.core.emit("runs");
  }

  markAllOpened(): void {
    const now = this.core.now().toISOString();
    for (const run of this.inbox()) this.core.store.saveRun({ ...run, openedAt: now });
    this.core.emit("runs");
  }


  /** Start the next attempt of a finished run, in the same place it belongs to. */
  async continueRun(id: string, size: TermSize = {}): Promise<Launched & { chatId: string | null; taskId: string | null }> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const run = this.core.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    const livePty = this.core.ptyByRun.get(id);
    if (livePty) return { runId: id, ptyId: livePty, chatId: run.chatId, taskId: run.taskId };
    if (run.chatId && this.core.store.getChat(run.chatId)) {
      const result = await this.chats.continueChat(run.chatId, size);
      return { runId: result.runId, ptyId: result.ptyId, chatId: run.chatId, taskId: null };
    }
    if (run.taskId && this.core.store.getTask(run.taskId)) {
      const launched = await this.tasks.executeTask(run.taskId, size, true);
      return { ...launched, chatId: null, taskId: run.taskId };
    }
    const engine = this.core.requireEngine(run.engine);
    const resume = this.core.resumePlan(engine.row, run);
    const nativeContinue = resume.native;
    const agent = run.agentId ? this.core.store.getAgent(run.agentId) : null;
    const prior = nativeContinue ? null : this.core.transcriptPath(run);
    const followUp = "Continue where the previous attempt stopped.";
    const launched = await this.core.launch({
      origin: run.origin,
      title: run.title,
      engine,
      cwd: run.cwd,
      prompt: run.prompt,
      promptText: nativeContinue ? null : agent ? this.core.preambleFor(agent, run.prompt || followUp, prior) : plainPrompt(run.prompt || followUp, prior),
      continueSession: nativeContinue,
      resumeArgs: resume.resumeArgs,
      agentId: run.agentId,
      routineId: run.routineId,
      workspaceId: run.workspaceId,
      continuedFrom: run.id,
      ...size,
    });
    return { ...launched, chatId: null, taskId: null };
  }

  /**
   * The patch for a run. Once the run has ended and diff.patch is on disk, that file is what
   * comes back: it is the tree at the moment the run ended. `now` reads the folder as it is.
   */
  async runDiff(id: string, source: "saved" | "now" = "saved"): Promise<string> {
    const run = this.core.store.getRun(id);
    if (!run) throw new Error("That run no longer exists.");
    if (source !== "now" && run.status !== "running" && run.dir) {
      if (hasRunFile(run.dir, RUN_FILES.patch)) return readRunText(run.dir, RUN_FILES.patch);
    }
    return diffSince(run.cwd, run.gitStart);
  }

  /** Runs matching the words typed, in their title, prompt, transcript or folder; best first. */
  searchRuns(text: string, limit = 50): RunHit[] {
    this.indexMissingText(500);
    return this.core.store.searchRuns(text, limit).map(({ run, snippet }) => ({ ...this.core.view(run), snippet }));
  }

  /** Put ended runs the search index doesn't have yet into it, newest first. Returns how many. */
  private indexMissingText(limit: number): number {
    const missing = this.core.store.runsMissingText(limit);
    for (const run of missing) this.core.indexText(run);
    return missing.length;
  }

  /**
   * Compress every ended run's big files, then remove the runs Settings → Storage says not to keep.
   * One pass at a time; a second call while one is going waits for it.
   */
  maintainRuns(): Promise<RunUpkeep> {
    this.upkeep ??= this.upkeepPass().finally(() => {
      this.upkeep = null;
    });
    return this.upkeep;
  }

  private async upkeepPass(): Promise<RunUpkeep> {
    await this.core.settled;
    const result: RunUpkeep = { compressed: 0, removed: 0, freed: 0 };
    // Runs from before search, a few hundred at a time between passes.
    this.indexMissingText(1000);
    const runs = this.core.store.allRuns().filter((run) => run.dir && run.status !== "running" && !this.core.ptyByRun.has(run.id));
    for (const run of runs) {
      const saved = await compressRun(run.dir);
      if (saved > 0) {
        result.compressed += 1;
        result.freed += saved;
      }
    }
    const rule = this.core.store.readSettings().keepRuns;
    const keep = new Set<string>(this.inbox().map((run) => run.id));
    for (const chat of this.core.store.listChats()) if (chat.runIds.length) keep.add(chat.runIds[chat.runIds.length - 1]);
    for (const task of this.core.store.listTasks()) if (task.runIds.length) keep.add(task.runIds[task.runIds.length - 1]);
    const doomed = planCleanup(
      runs.map((run) => ({ run, bytes: folderBytes(run.dir) })),
      rule,
      this.core.now(),
      keep,
    );
    for (const { run, bytes } of doomed) {
      // Still ended, and still not picked up again, since the list was read.
      const latest = this.core.store.getRun(run.id);
      if (!latest || latest.status === "running" || this.core.ptyByRun.has(run.id)) continue;
      this.core.store.deleteRun(latest);
      result.removed += 1;
      result.freed += bytes;
    }
    if (result.removed) this.core.emit("runs");
    return result;
  }

  storageSummary(): StorageSummary {
    const root = this.core.options.dataRoot;
    return {
      dataRoot: root,
      runs: folderBytes(path.join(root, "runs")),
      runCount: this.core.store.allRuns().length,
      voice: folderBytes(path.join(root, "models")) + folderBytes(path.join(root, "voices")),
      logs: folderBytes(path.join(root, "logs")),
      scratch: folderBytes(path.join(root, "scratch")),
    };
  }
}
