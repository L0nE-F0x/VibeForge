import path from "node:path";
import { isCodingCli, sessionFolder, TURN_GRACE_MS, writersIn, type Writer } from "../checkout.js";
import { isDirectory, readJson, writeJson } from "../fsx.js";
import { repoRoot } from "../worktrees.js";
import type { LiveSession } from "../types.js";
import type { ServiceCore } from "./core.js";

/** How often waiting work looks at its folder again. */
const CHECK_MS = 3_000;
/** A wait older than this when VibeForge starts again is let go: whoever asked has moved on. */
const RESTORE_MS = 24 * 60 * 60 * 1000;

/** Something that waits for its folder: a task's Execute or a routine's Run now. */
interface Turn {
  kind: "task" | "routine";
  id: string;
  folder: string;
  since: string;
  /**
   * The due slot a routine's wait stands for, when its schedule (not a click) started it. Not kept
   * past a restart: a slot due before VibeForge started is missed, as any other is.
   */
  slot?: string | null;
  /** Starts it. Called once the folder is free; it checks again itself, under the folder's lock. */
  start: () => Promise<unknown>;
  /** Tells the person the start failed, since nobody is watching when it happens. */
  failed: (message: string) => void;
}

/** A wait as it is kept in `<data>/waiting.json`, to pick it back up after a restart. */
export type SavedTurn = Pick<Turn, "kind" | "id" | "folder" | "since">;

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
  /** The workspaces' and agents' folders, read again only once either changes (not on every CLI going busy or quiet). */
  private places: string[] | null = null;
  /** What waiting.json holds now, so a wait joined again doesn't write it again. */
  private saved: string | null = null;
  /** VibeForge is quitting: its CLIs are ending, and a folder they free isn't a turn for anything to start in. */
  private holding = false;
  /** Waits put back on start hold off until then, so the CLIs the window opens again get their turn first. */
  private startsAfter = 0;

  constructor(private readonly core: ServiceCore) {
    core.onChange((topics) => {
      const placesChanged = topics.includes("workspaces") || topics.includes("agents");
      if (placesChanged) this.places = null;
      // A new workspace or agent folder is learned at once, not at the next CLI starting or ending.
      if (placesChanged || topics.includes("live")) void this.learnFolders();
    });
  }

  /** Lets go of the waits in memory; waiting.json keeps them for the next start. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.clear();
  }

  /** Quitting: nothing more starts, and what is waiting stays saved for the next start. */
  hold(): void {
    this.holding = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get file(): string {
    return path.join(this.core.options.dataRoot, "waiting.json");
  }

  /** Keeps what is waiting for the next start. Best effort: a wait still works without it. */
  private save(): void {
    const waiting: SavedTurn[] = [...this.queue.values()].filter((turn) => !turn.slot).map(({ kind, id, folder, since }) => ({ kind, id, folder, since }));
    const text = JSON.stringify(waiting);
    if (text === this.saved) return;
    try {
      writeJson(this.file, { waiting });
      this.saved = text;
    } catch {
      /* the next change tries again */
    }
  }

  /**
   * Puts back what was waiting when VibeForge last closed, in its old order and place in line.
   * `resume` gives each its start again, or null when its task or routine is gone. A wait for a
   * folder that's gone, or older than a day, is let go.
   */
  restore(resume: (saved: SavedTurn) => Pick<Turn, "start" | "failed"> | null): void {
    const raw = readJson<{ waiting?: unknown } | null>(this.file, null);
    const now = this.core.now().getTime();
    for (const item of Array.isArray(raw?.waiting) ? raw.waiting : []) {
      const saved = savedTurn(item);
      if (!saved || now - Date.parse(saved.since) > RESTORE_MS || !isDirectory(saved.folder)) continue;
      const key = `${saved.kind}:${saved.id}`;
      if (this.queue.has(key)) continue;
      const again = resume(saved);
      if (again) this.queue.set(key, { ...saved, ...again });
    }
    // Written again only when something was let go: no file and nothing waiting stays that way.
    this.saved = raw ? null : "[]";
    this.save();
    if (!this.queue.size) return;
    this.startsAfter = now + TURN_GRACE_MS;
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer || this.holding) return;
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref?.();
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
    const live = this.core.listLive();
    const now = this.core.now().getTime();
    return live.map((session) => ({
      ...session,
      alsoHere: writersIn(live, sessionFolder(session), this.repos, now, new Set([session.ptyId])).map((writer) => ({ ptyId: writer.ptyId, label: writer.label, agentId: writer.agentId })),
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
    this.save();
    this.ensureTimer();
  }

  cancel(kind: Turn["kind"], id: string): boolean {
    const removed = this.queue.delete(`${kind}:${id}`);
    if (removed) this.save();
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
    if (this.checking || this.holding || this.core.now().getTime() < this.startsAfter) return;
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
    this.places ??= [
      ...this.core.store.readWorkspaces().workspaces.map((workspace) => workspace.path),
      ...this.core.store.listAgents().flatMap((agent) => agent.places.slice(0, 1)),
    ];
    const places = [...this.core.listLive().map((session) => sessionFolder(session)), ...this.places];
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

/** One entry of waiting.json, or null when it isn't one (a hand edit, or a file from another version). */
function savedTurn(value: unknown): SavedTurn | null {
  const item = value as Partial<Record<keyof SavedTurn, unknown>> | null;
  if (!item || (item.kind !== "task" && item.kind !== "routine")) return null;
  if (typeof item.id !== "string" || !item.id || typeof item.folder !== "string" || !path.isAbsolute(item.folder)) return null;
  if (typeof item.since !== "string" || !Number.isFinite(Date.parse(item.since))) return null;
  return { kind: item.kind, id: item.id, folder: item.folder, since: item.since };
}
