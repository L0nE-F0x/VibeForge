import path from "node:path";
import { isCodingCli, sessionFolder, writersIn, type Writer } from "../checkout.js";
import { repoRoot } from "../worktrees.js";
import type { LiveSession } from "../types.js";
import type { ServiceCore } from "./core.js";

/** How often waiting work looks at its folder again. */
const CHECK_MS = 3_000;

/** Something that waits for its folder: a task's Execute or a routine's Run now. */
interface Turn {
  kind: "task" | "routine";
  id: string;
  folder: string;
  since: string;
  /** Starts it. Called once the folder is free; it checks again itself, under the folder's lock. */
  start: () => Promise<unknown>;
  /** Tells the person the start failed, since nobody is watching when it happens. */
  failed: (message: string) => void;
}

export interface Waiting {
  since: string;
  /** The coding CLIs it is waiting for. */
  behind: Writer[];
}

/**
 * Agents take turns in a folder. A task or routine that would start where another coding CLI is
 * busy waits here instead, and starts on its own once that CLI has gone quiet. Code terminals and
 * chats never wait: a person is at those. Also answers "who else is in this folder" for the views.
 */
export class FolderTurns {
  /** Each folder's repository top folder, or null when it isn't in one. */
  private readonly repos = new Map<string, string | null>();
  private readonly looking = new Map<string, Promise<string | null>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly queue = new Map<string, Turn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly core: ServiceCore) {
    core.onChange((topics) => {
      if (topics.includes("live")) void this.learnFolders();
    });
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.clear();
  }

  /** The repository a folder belongs to, looked up once and remembered. */
  async repoOf(folder: string): Promise<string | null> {
    const key = path.resolve(folder);
    if (this.repos.has(key)) return this.repos.get(key)!;
    let pending = this.looking.get(key);
    if (!pending) {
      pending = repoRoot(key).catch(() => null);
      this.looking.set(key, pending);
    }
    const repo = await pending;
    this.looking.delete(key);
    this.repos.set(key, repo);
    return repo;
  }

  /** Who is in `folder` right now, from what is already known about repositories. */
  writersNow(folder: string, except?: ReadonlySet<string>): Writer[] {
    return writersIn(this.core.listLive(), folder, this.repos, this.core.now().getTime(), except);
  }

  /** The live sessions, each with the other coding CLIs that share its folder. */
  withNeighbours(): LiveSession[] {
    return this.core.listLive().map((session) => ({
      ...session,
      alsoHere: this.writersNow(sessionFolder(session), new Set([session.ptyId])).map((writer) => ({ ptyId: writer.ptyId, label: writer.label, agentId: writer.agentId })),
    }));
  }

  /** Who is in `folder`, looking up any repository not known yet. */
  async writers(folder: string, except?: ReadonlySet<string>): Promise<Writer[]> {
    await Promise.all([folder, ...this.cliFolders()].map((dir) => this.repoOf(dir)));
    return this.writersNow(folder, except);
  }

  /** The writers that still have their turn: the reason to wait. */
  async busyIn(folder: string): Promise<Writer[]> {
    return (await this.writers(folder)).filter((writer) => writer.busy);
  }

  /**
   * One unattended start at a time per checkout, from the check until the CLI is in the live list,
   * so two starts can't both find the folder free. Keyed by repository, so `repo` and `repo/src`
   * share a lock. A failed job doesn't hold up the next one.
   */
  async withFolderLock<T>(folder: string, job: () => Promise<T>): Promise<T> {
    const key = (await this.repoOf(folder)) ?? path.resolve(folder);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(job, job);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  /** Wait for the folder. Waiting again for the same thing keeps its place in line. */
  enqueue(turn: Omit<Turn, "since">): void {
    const key = `${turn.kind}:${turn.id}`;
    const since = this.queue.get(key)?.since ?? this.core.now().toISOString();
    this.queue.set(key, { ...turn, since });
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), CHECK_MS);
      this.timer.unref?.();
    }
  }

  cancel(kind: Turn["kind"], id: string): boolean {
    const removed = this.queue.delete(`${kind}:${id}`);
    if (!this.queue.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return removed;
  }

  /** Whether something is waiting, since when, and for whom. */
  waiting(kind: Turn["kind"], id: string): Waiting | null {
    const turn = this.queue.get(`${kind}:${id}`);
    if (!turn) return null;
    return { since: turn.since, behind: this.writersNow(turn.folder).filter((writer) => writer.busy) };
  }

  /** Start whatever is waiting for a folder that has come free, oldest first. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const [key, turn] of [...this.queue]) {
        if ((await this.busyIn(turn.folder)).length) continue;
        if (this.queue.get(key) !== turn) continue;
        this.cancel(turn.kind, turn.id);
        try {
          await turn.start();
        } catch (error) {
          turn.failed(error instanceof Error ? error.message : String(error));
        }
        this.core.emit(turn.kind === "task" ? "tasks" : "routines");
      }
    } finally {
      this.checking = false;
    }
  }

  private cliFolders(): string[] {
    return this.core
      .listLive()
      .filter((session) => isCodingCli(session))
      .map((session) => sessionFolder(session));
  }

  /** Look up the repositories of folders that just appeared, so the views can say who overlaps. */
  private async learnFolders(): Promise<void> {
    const places = [
      ...this.core.listLive().map((session) => sessionFolder(session)),
      ...this.core.store.readWorkspaces().workspaces.map((workspace) => workspace.path),
      ...this.core.store.listAgents().flatMap((agent) => agent.places.slice(0, 1)),
    ];
    const folders = [...new Set(places.map((folder) => path.resolve(folder)))];
    const unknown = folders.filter((folder) => !this.repos.has(folder));
    if (this.repos.size > 500) {
      const keep = new Set(folders);
      for (const key of this.repos.keys()) if (!keep.has(key)) this.repos.delete(key);
    }
    if (!unknown.length) return;
    await Promise.all(unknown.map((folder) => this.repoOf(folder)));
    this.core.emit("live", "tasks", "routines");
  }
}
