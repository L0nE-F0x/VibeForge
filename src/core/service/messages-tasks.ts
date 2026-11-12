import { cleanText, DEFAULT_WAIT_MS, taskReportText } from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import { replyLogFor } from "../replies.js";
import { slugify } from "../slug.js";
import { createTask } from "../tasks.js";
import type { TalkState } from "../types.js";
import { isGitRepo } from "../vcs.js";
import { copyPatch, patchFiles } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import type { Answered, Answers } from "./messages-answers.js";
import type { Delivery } from "./messages-delivery.js";
import type { SavedFiles } from "./messages-files.js";
import type { Roster } from "./messages-who.js";
import type { TaskDesk } from "./tasks.js";

/** How long a handed-out task is watched for its first answer, to report it to the CLI that handed it out. */
const REPORT_MS = 4 * 60 * 60 * 1000;
/** A handed-out task's CLI that hasn't moved since it started counts as quiet after this long. */
const STUCK_MS = 30_000;
/** Reports of a task waiting for a person, after each of which its answer is watched for again. */
const MAX_REWATCH = 3;

export type TaskResult = { ok: true; taskId: string; title: string; started: boolean; reply?: string | null; note?: string } | { ok: false; error: string };

/**
 * `vibeforge task`: a CLI hands a task to an agent, which works in its own copy. Past Settings'
 * limits it waits for a person to press Start; its first answer, its changes and where they are
 * go back to the CLI that handed it out as a report, and `vibeforge apply` can bring them in.
 */
export class HandedTasks {
  /** Handed-out tasks and the terminal that handed each one out, which hears back from it. */
  private readonly handed = new Map<string, string>();
  /** Handed-out tasks waiting for a person to press Start, by the terminal that handed them out. */
  private readonly proposed = new Map<string, string>();
  /** Tasks each terminal has handed out since a person last typed in it. */
  private readonly handedSince = new Map<string, number>();
  /** How many times each task has been watched again after a report that it waits for a person. */
  private readonly rewatched = new Map<string, number>();
  /** `--wait` callers, by task, until its first answer; `end` when none will come: its CLI ended, or a person pressed Stop. */
  private readonly waitFor = new Map<string, (answered: Answered | null, end: "ended" | "stopped" | null) => void>();

  constructor(
    private readonly core: ServiceCore,
    private readonly tasks: TaskDesk,
    private readonly roster: Roster,
    private readonly delivery: Delivery,
    private readonly answers: Answers,
    private readonly files: SavedFiles,
    /** Delivers what can go now (MessageDesk.pump). */
    private readonly pump: () => void,
  ) {}

  private settings() {
    return this.core.store.readSettings().agentTalk;
  }

  private nowMs(): number {
    return this.core.now().getTime();
  }

  /** How many handed-out tasks wait for a person to press Start. */
  get waitingToStart(): number {
    return this.proposed.size;
  }

  /** A person typed in `ptyId`: its hand-offs are counted from none again. */
  personTyped(ptyId: string): void {
    this.handedSince.delete(ptyId);
  }

  /**
   * Lets go of tasks that are gone and of terminals that ended: nothing asks about them again, and
   * these lists would otherwise grow for as long as VibeForge runs. Done tasks stay while their
   * terminal does, as one can still be executed again or applied from its copy. Run as a task is
   * handed out, the only time the lists grow, so a deleted task's Undo has until the next one.
   */
  private forget(): void {
    for (const [taskId, asker] of [...this.handed]) {
      if (this.core.live.has(asker) && this.core.store.getTask(taskId)) continue;
      this.handed.delete(taskId);
      this.rewatched.delete(taskId);
    }
    for (const [taskId, asker] of [...this.proposed]) if (!this.core.live.has(asker)) this.proposed.delete(taskId);
    for (const asker of [...this.handedSince.keys()]) if (!this.core.live.has(asker)) this.handedSince.delete(asker);
  }

  /** `vibeforge task <agent> "…"`: a task for a VibeForge agent, in its own copy so it never works in the sender's folder. */
  async handTask(input: { fromPty: string | null; agent: string; text: string; title?: string; start?: boolean; wait?: boolean; timeoutMs?: number }): Promise<TaskResult> {
    if (!this.settings().on) return { ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." };
    const agents = this.core.store.listAgents();
    const agent = findAgent(agents, input.agent);
    if (!agent) return { ok: false, error: `No agent called "${input.agent}".${agents.length ? ` Agents: ${agents.map((item) => item.id).join(", ")}.` : " There are no agents yet."}` };
    const text = cleanText(input.text);
    if (!text) return { ok: false, error: "The task is empty." };
    const from = this.roster.list().find((item) => item.ptyId === input.fromPty) ?? null;
    const session = input.fromPty ? this.core.live.get(input.fromPty) : undefined;
    const parent = session?.taskId ? this.core.store.getTask(session.taskId) : null;
    if (parent?.askedBy) return { ok: false, error: "This task was handed out by another CLI, so it can't hand out tasks of its own. Ask the CLI that started it." };
    const workspace =
      this.core.workspaceById(session?.workspaceId) ??
      this.core.workspaceById(parent?.workspaceId) ??
      this.core.store.readWorkspaces().workspaces.find((item) => agent.places.some((place) => item.path === place || item.path.startsWith(`${place}/`))) ??
      null;
    if (!workspace) return { ok: false, error: "Start this from a terminal in a workspace, so VibeForge knows where the task belongs." };
    const askedBy = from?.label ?? "a terminal outside VibeForge";
    const isolated = await isGitRepo(workspace.path).catch(() => false);
    const title = taskTitle(input.title?.trim() || text.split("\n")[0]);
    const task = createTask({
      title,
      body: `${text}\n\nAsked by ${askedBy}.`,
      agentId: agent.id,
      workspaceId: workspace.id,
      isolated,
      askedBy,
      sourceRunId: session?.runId ?? null,
      now: this.core.now(),
    });
    this.core.store.writeTask(task);
    this.core.emit("tasks");
    const asker = from?.ptyId ?? null;
    this.forget();
    if (asker) this.handed.set(task.id, asker);
    const reports = asker ? " What it did comes back to you as a message when it finishes." : "";
    if (input.start === false) return { ok: true, taskId: task.id, title, started: false, note: "It waits in To do until a person executes it." };
    if (!isolated) return { ok: true, taskId: task.id, title, started: false, note: `${workspace.path} isn't a git repository, so the task can't have its own copy. It waits in To do for a person to start it.` };
    // How far a CLI goes on its own (Settings → Agents together): a task past it waits for a
    // person to press Start on the terminal that handed it out.
    const talk = this.settings();
    const held = (why: string): TaskResult => {
      if (asker) this.proposed.set(task.id, asker);
      this.core.emit("live");
      return { ok: true, taskId: task.id, title, started: false, note: asker ? `${why}${reports}` : "It waits in To do for a person to start it." };
    };
    const handedNow = asker ? (this.handedSince.get(asker) ?? 0) + 1 : 0;
    if (asker) this.handedSince.set(asker, handedNow);
    if (talk.handOff === "ask") return held("It waits for the person to press Start on your terminal's title bar (Ask first, in VibeForge's Settings → Agents together).");
    if (asker && handedNow > talk.maxHandOffs) return held(`You've handed out ${talk.maxHandOffs} tasks since the person last wrote to you, so this one waits for them to press Start.`);
    if (asker && this.answers.reportingTo(asker) >= talk.maxWorking) return held(`${talk.maxWorking} of your tasks are still working, so this one waits for the person to press Start.`);
    return this.startHanded(task.id, asker, input);
  }

  /**
   * Start a handed-out task and watch for its first answer. `--wait` gets it as the result;
   * otherwise, or once the wait is over, it goes to the CLI that handed it out as a report.
   */
  private async startHanded(taskId: string, asker: string | null, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<TaskResult> {
    // Out of the held ones while it starts, so a second Start can't start it twice; back if it doesn't.
    const heldBy = this.proposed.get(taskId);
    this.proposed.delete(taskId);
    const task = this.core.store.getTask(taskId);
    if (!task) return { ok: false, error: "That task no longer exists." };
    const agent = task.agentId ? this.core.store.getAgent(task.agentId) : null;
    const workspace = this.core.workspaceById(task.workspaceId);
    const title = task.title;
    let launched: Awaited<ReturnType<TaskDesk["executeTask"]>>;
    try {
      launched = await this.tasks.executeTask(taskId);
    } catch (error) {
      if (heldBy) this.proposed.set(taskId, heldBy);
      return { ok: true, taskId, title, started: false, note: `It couldn't start: ${error instanceof Error ? error.message : String(error)} It waits in To do.` };
    }
    const name = agent?.name ?? "The agent";
    const note = `${name} works in its own copy of ${workspace?.path ?? "the workspace"}. ${this.settings().leadApplies && asker ? "You can apply its changes with vibeforge apply once it reports." : "A person applies its changes from the task."}`;
    const reports = asker ? " What it did comes back to you as a message when it finishes." : "";
    // Nobody to answer or report to: a terminal outside VibeForge gets the usual notification.
    if (!("ptyId" in launched) || (!opts.wait && !asker)) return { ok: true, taskId, title, started: true, note };
    this.watchReport(taskId, launched.ptyId, asker, opts);
    if (!opts.wait) return { ok: true, taskId, title, started: true, note: `${note}${reports}` };
    return new Promise<TaskResult>((resolve) => {
      this.waitFor.set(taskId, (answered, end) =>
        resolve(
          end === "ended"
            ? { ok: true, taskId, title, started: true, reply: null, note: `It ended before ${name} answered. ${note}` }
            : end === "stopped"
              ? {
                  ok: true,
                  taskId,
                  title,
                  started: true,
                  reply: null,
                  // Stop holds the conversation, not the task: it goes on, and nothing of it comes back here.
                  note: `A person stopped this conversation, so ${name}'s answer won't come back to you. It goes on in its own copy of ${workspace?.path ?? "the workspace"}; a person applies its changes from the task.`,
                }
              : { ok: true, taskId, title, started: true, reply: answered?.reply ?? null, note: answered ? note : `${name} is still working on it. ${note}${reports}` },
        ),
      );
    });
  }

  /** Watches a started task's first answer (from `since`, its start by default); see startHanded. */
  private watchReport(taskId: string, ptyId: string, asker: string | null, opts: { wait?: boolean; timeoutMs?: number }, since?: number): void {
    const settle = (answered: Answered | null, end: "ended" | "stopped" | null) => {
      const waiting = this.waitFor.get(taskId);
      this.waitFor.delete(taskId);
      waiting?.(answered, end);
    };
    this.answers.watchAnswer(
      ptyId,
      {
        words: "",
        deadline: this.nowMs() + (opts.wait ? Math.max(1000, opts.timeoutMs ?? DEFAULT_WAIT_MS) : 0),
        done: (answered) => settle(answered, null),
        dropped: (_why, stopped) => settle(null, stopped ? "stopped" : "ended"),
        // Not waiting: the answer is a report from the start.
        gone: opts.wait ? undefined : AbortSignal.abort(),
        // Only from its start: once reported as waiting for a person, it has to move before it's heard from again.
        stuckMs: since === undefined ? STUCK_MS : undefined,
        after: asker
          ? {
              answered: (answered) =>
                void this.reportTask(taskId, ptyId, asker, answered, false).then((waiting) => {
                  // Stuck on a question for a person: watch again, so its answer still comes back.
                  const times = this.rewatched.get(taskId) ?? 0;
                  if (!waiting || times >= MAX_REWATCH || !this.core.live.has(ptyId)) return;
                  this.rewatched.set(taskId, times + 1);
                  this.watchReport(taskId, ptyId, asker, {}, this.nowMs());
                }),
              ended: () => void this.reportTask(taskId, ptyId, asker, null, true),
              forMs: REPORT_MS,
            }
          : undefined,
      },
      since ?? (Date.parse(this.core.live.get(ptyId)?.startedAt ?? "") || this.nowMs()),
      asker,
    );
  }

  /** This terminal's held tasks that are still there to start; ones deleted or started from the board drop out. */
  toStart(ptyId: string): TalkState["toStart"] {
    const out: TalkState["toStart"] = [];
    for (const [taskId, asker] of [...this.proposed]) {
      if (asker !== ptyId) continue;
      const task = this.core.store.getTask(taskId);
      if (!task || task.status !== "todo") {
        this.proposed.delete(taskId);
        continue;
      }
      out.push({ taskId, title: task.title, agent: (task.agentId && this.core.store.getAgent(task.agentId)?.name) || "" });
    }
    return out;
  }

  /** Start: a person starts tasks a CLI handed out that were held for them (all of this terminal's, or the ones named). */
  async startHeld(ptyId: string, taskIds: readonly string[] | null): Promise<{ started: number; failed: string[] }> {
    const ids = [...this.proposed].filter(([id, asker]) => asker === ptyId && (!taskIds || taskIds.includes(id))).map(([id]) => id);
    let started = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const result = await this.startHanded(id, ptyId);
      if (result.ok && result.started) started += 1;
      else failed.push(result.ok ? (result.note ?? id) : result.error);
    }
    this.core.emit("live");
    return { started, failed };
  }

  /** A person executed a handed-out task from the board: it reports to the CLI that handed it out all the same. */
  adoptStarted(taskId: string, ptyId: string): void {
    const asker = this.handed.get(taskId) ?? null;
    if (!asker || !this.core.live.has(asker)) return;
    if (this.proposed.delete(taskId)) this.core.emit("live");
    this.watchReport(taskId, ptyId, asker, {});
  }

  /**
   * `vibeforge apply <task>`: the CLI that handed a task out brings its changes into the workspace,
   * when Settings lets it. The task's session ends first, as its work is done.
   */
  async applyHanded(input: { fromPty: string | null; task: string }): Promise<{ ok: true; files: string[]; conflicts: string[]; note: string } | { ok: false; error: string }> {
    const talk = this.settings();
    if (!talk.on) return { ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." };
    if (!talk.leadApplies) return { ok: false, error: "A person applies handed-out tasks' changes. VibeForge's Settings → Agents together can let the CLI that handed one out do it." };
    // By id, else by title: of tasks with that title, the one this CLI handed out (another CLI's may share it).
    const byId = this.core.store.getTask(input.task);
    const titled = byId ? [] : this.core.store.listTasks().filter((item) => item.title === input.task);
    const task = byId ?? titled.find((item) => input.fromPty && this.handed.get(item.id) === input.fromPty) ?? titled[0] ?? null;
    if (!task) return { ok: false, error: `No task called "${input.task}".` };
    if (!input.fromPty || this.handed.get(task.id) !== input.fromPty) return { ok: false, error: "Only the CLI that handed this task out can apply it. A person can apply it from the task in VibeForge." };
    if (!task.copy) return { ok: false, error: "This task has no changes of its own to apply." };
    try {
      const live = task.runIds.at(-1) ? this.core.ptyByRun.get(task.runIds.at(-1)!) : undefined;
      await this.tasks.stopTask(task.id);
      if (live) await this.core.waitForExit(live, 5000);
      const result = await this.tasks.applyCopy(task.id);
      return {
        ok: true,
        files: result.files,
        conflicts: result.conflicts,
        note: result.conflicts.length
          ? `Some changes conflict with this folder (${result.conflicts.join(", ")}); the rest are in. The task's copy stays until a person sorts it out.`
          : `Applied as uncommitted changes, and the task is done.`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A handed-out task's first answer (or its end), its changes and where they are, to the CLI that
   * handed it out. True when it reported the task as waiting for a person rather than answered.
   */
  private async reportTask(taskId: string, taskPty: string, asker: string, answered: Answered | null, ended: boolean): Promise<boolean> {
    const to = this.core.live.get(asker);
    const task = this.core.store.getTask(taskId);
    if (!to || !isCodingCli(to) || !task || this.delivery.isStopped(asker) || this.delivery.isStopped(taskPty)) return false;
    // Read from the screen although VibeForge reads this CLI's log: nothing came into the log, so
    // it never got going (a trust or permission question on screen, most likely).
    const session = this.core.live.get(taskPty);
    const engine = session ? this.roster.engineOf(session) : null;
    const waiting = Boolean(!ended && answered?.fromScreen && engine && replyLogFor(engine.id, engine.bin));
    const from = this.roster.list().find((item) => item.ptyId === taskPty) ?? null;
    const agent = task.agentId ? this.core.store.getAgent(task.agentId) : null;
    let patch = "";
    let changesError: string | null = null;
    if (task.copy) {
      try {
        patch = await copyPatch(task.copy, { dataRoot: this.core.options.dataRoot, taskId });
      } catch (error) {
        changesError = error instanceof Error ? error.message : String(error);
      }
    }
    const reply = answered?.reply ? cleanText(answered.reply) : null;
    const text = taskReportText({
      agentLabel: from?.label ?? agent?.name ?? "The agent",
      handle: from?.handle ?? null,
      title: task.title,
      ended,
      reply,
      savedAt: reply ? this.files.saveIfLong("messages", reply) : null,
      patchPath: patch.trim() ? this.files.saveFile("reviews", "patch", patch) : null,
      files: patchFiles(patch),
      copyPath: task.copy?.path ?? null,
      applyWith: this.settings().leadApplies && !ended ? task.id : null,
      waiting,
      changesError,
    });
    // Counted like any message between the two: past the limit it waits in the prompt for a person
    // (checked as it goes in, see Delivery.deliver).
    this.delivery.queue({ fromPty: taskPty, toPty: asker, text, enter: true, counts: true, waiter: null, dropped: () => undefined });
    this.core.emit("live");
    this.pump();
    return waiting;
  }
}

/**
 * The agent `vibeforge task` names: by id (what `vibeforge who` prints), by name, or by the
 * 24-letter cut of its name that `who` printed before 2.10.
 */
export function findAgent<T extends { id: string; name: string }>(agents: readonly T[], wanted: string): T | null {
  const slug = slugify(wanted, 48);
  return (
    agents.find((item) => item.id === wanted) ??
    agents.find((item) => item.id === slug || slugify(item.name, 48) === slug) ??
    agents.find((item) => slugify(item.name, 24) === slug) ??
    null
  );
}

/** A task's title from its first line: up to 80 characters, cut at a word ("…the single word: hi" kept its "hi" only once this did). */
export function taskTitle(line: string, max = 80): string {
  const text = line.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // A word that ends right at the cut stays; one cut in half goes.
  const whole = /[\s,;:.!?]/.test(text[cut.length]);
  const space = cut.lastIndexOf(" ");
  return `${(whole || space <= max / 2 ? cut : cut.slice(0, space)).replace(/[\s,;:.-]+$/, "")}…`;
}
