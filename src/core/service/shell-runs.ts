import path from "node:path";
import { programOf } from "../engines.js";
import { allocateRunDir } from "../runs.js";
import { BLIP_MS } from "./types.js";
import type { ServiceCore } from "./core.js";

/** Runs typed into a Code shell: a coding CLI in a shell's foreground is recorded as a run. */
export class ShellRecorder {
  constructor(private readonly core: ServiceCore) {}

  /** A shell's foreground program changed: `claude` typed at its prompt, or back to the prompt. */
  onPtyProgram(ptyId: string, argv: string[] | null, cwd: string | null = null): void {
    const session = this.core.live.get(ptyId);
    if (!session || session.kind !== "shell") return;
    const found = argv ? programOf(argv, this.core.store.readEngineRows()) : null;
    const program = found?.label || null;
    const programEngineId = found?.engineId ?? null;
    const programCwd = found ? cwd : null;
    if (session.program === program && session.programEngineId === programEngineId && session.programCwd === programCwd) return;
    // The host only reports a change. A CLI that starts working at once was already "working" while
    // its command line was typed, so it takes that state over from the shell.
    const working = programEngineId ? (this.core.hostWorking.get(ptyId) ?? session.working) : false;
    this.core.live.set(ptyId, { ...session, program, programEngineId, programCwd, working });
    this.core.emit("live");
    if (argv) this.core.shellArgv.set(ptyId, argv);
    if (session.programEngineId !== programEngineId) this.queueRecording(ptyId);
  }

  /** Only coding CLIs count as working; a dev server's logs are just a shell being busy. */
  onPtyActivity(ptyId: string, working: boolean): void {
    const session = this.core.live.get(ptyId);
    if (!session) return;
    if (session.kind === "shell") this.core.hostWorking.set(ptyId, working);
    if (session.kind === "shell" && !session.programEngineId && working) return;
    if (Boolean(session.working) === working) return;
    this.core.live.set(ptyId, { ...session, working });
    this.core.emit("live");
  }

  // ---------------------------------------------------------------- runs typed into a shell

  /** Changes of program are handled one at a time per shell, in the order they happened. */
  private queueRecording(ptyId: string): void {
    const next = (this.core.recordings.get(ptyId) ?? Promise.resolve())
      .then(() => this.syncRecording(ptyId))
      .catch(() => undefined)
      .finally(() => {
        if (this.core.recordings.get(ptyId) === next) this.core.recordings.delete(ptyId);
      });
    this.core.recordings.set(ptyId, next);
  }

  /** A shell in a workspace records a run while a coding CLI holds its foreground. */
  private async syncRecording(ptyId: string): Promise<void> {
    await this.core.settled;
    const session = this.core.live.get(ptyId);
    if (!session || session.kind !== "shell" || !session.workspaceId) return;
    const want = session.programEngineId ?? null;
    const current = session.runId ? this.core.store.getRun(session.runId) : null;
    if (current?.status === "running" && current.engine === want) return;
    if (current) await this.endShellRun(ptyId, current.id);
    if (want) await this.startShellRun(ptyId, want);
  }

  private async startShellRun(ptyId: string, engineId: string): Promise<void> {
    const session = this.core.live.get(ptyId);
    const row = this.core.store.readEngineRows().find((item) => item.id === engineId);
    if (!session || !row) return;
    const workspace = this.core.workspaceById(session.workspaceId);
    const cwd = session.programCwd || session.cwd;
    const started = this.core.now();
    const title = `${row.label} · ${workspace?.name ?? (path.basename(cwd) || cwd)}`;
    const { id, dir } = allocateRunDir(this.core.options.dataRoot, started, title);
    let gitStart: string | null = null;
    try {
      gitStart = await this.core.options.host.gitHead(cwd);
      this.core.gitAtStart.set(id, await this.core.options.host.snapshotGit(cwd, gitStart));
    } catch {
      /* not a repo, or git is slow; the run is recorded without */
    }
    this.core.store.saveRun({
      id,
      origin: "code",
      title,
      agentId: null,
      routineId: null,
      taskId: null,
      chatId: null,
      workspaceId: session.workspaceId,
      engine: row.id,
      argv: this.core.shellArgv.get(ptyId) ?? [row.bin],
      cwd,
      prompt: "",
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
      continuedFrom: null,
    });
    try {
      await this.core.options.host.record(ptyId, dir);
    } catch {
      /* the shell ended meanwhile; its exit is handled below */
    }
    const latest = this.core.live.get(ptyId);
    if (!latest) {
      // The terminal closed while the run was being set up: record what there is.
      await this.core.finishRun(id, { exitCode: null, signal: null, status: "stopped" });
      return;
    }
    this.core.ptyByRun.set(id, ptyId);
    this.core.live.set(ptyId, { ...latest, runId: id });
    this.core.emit("runs", "live");
  }

  private async endShellRun(ptyId: string, runId: string): Promise<void> {
    try {
      await this.core.options.host.record(ptyId, null);
    } catch {
      /* already stopped with the terminal */
    }
    this.core.ptyByRun.delete(runId);
    const session = this.core.live.get(ptyId);
    if (session?.runId === runId) this.core.live.set(ptyId, { ...session, runId: null });
    await this.core.finishRun(runId, { exitCode: null, signal: null, status: "exited" });
    this.dropBlip(runId);
  }

  private dropBlip(runId: string): void {
    const run = this.core.store.getRun(runId);
    if (!run?.endedAt || run.stopRequested) return;
    const lasted = Date.parse(run.endedAt) - Date.parse(run.startedAt);
    if (lasted >= BLIP_MS || (run.changes && run.changes !== "No changes")) return;
    this.core.store.deleteRun(run);
    this.core.emit("runs");
  }
}
