import {
  cleanText,
  DEFAULT_WAIT_MS,
  messageText,
  resolveTarget,
  screenTail,
  taskReportText,
  type Answer,
  type Reachable,
} from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import { replyLogFor } from "../replies.js";
import { slugify } from "../slug.js";
import { createTask } from "../tasks.js";
import { isGitRepo } from "../vcs.js";
import { copyPatch, patchFiles } from "../worktrees.js";
import type { TalkState } from "../types.js";
import type { ServiceCore } from "./core.js";
import { Answers, type Answered } from "./messages-answers.js";
import { Delivery, typedIn } from "./messages-delivery.js";
import { SavedFiles } from "./messages-files.js";
import { changesOf, Reviews } from "./messages-review.js";
import { Roster, type WhoResult } from "./messages-who.js";
import type { TaskDesk } from "./tasks.js";

export type { WhoResult } from "./messages-who.js";

// CLIs talking to each other through VibeForge: `vibeforge tell` from one terminal pastes into
// another once it is idle, `--wait` hands the answer back, Send to… leaves a draft for a person,
// Review with… runs a review loop, and `vibeforge task` hands a task to an agent in its own copy.
// Every message is labelled with its sender; two CLIs may trade a limited number of messages
// before a person has to press Enter; Stop ends it. A person typing into a terminal resets its count.

const PUMP_MS = 1000;
/** How long a handed-out task is watched for its first answer, to report it to the CLI that handed it out. */
const REPORT_MS = 4 * 60 * 60 * 1000;
/** A handed-out task's CLI that hasn't moved since it started counts as quiet after this long. */
const STUCK_MS = 30_000;
/** Reports of a task waiting for a person, after each of which its answer is watched for again. */
const MAX_REWATCH = 3;
export type TellResult =
  | { ok: true; to: string; delivered: "sent" | "draft" | "queued"; reply?: string | null; fromScreen?: boolean; timedOut?: boolean; note?: string }
  | { ok: false; error: string };

export type TaskResult = { ok: true; taskId: string; title: string; started: boolean; reply?: string | null; note?: string } | { ok: false; error: string };

export class MessageDesk {
  /** Handed-out tasks and the terminal that handed each one out, which hears back from it. */
  private readonly handed = new Map<string, string>();
  /** Handed-out tasks waiting for a person to press Start, by the terminal that handed them out. */
  private readonly proposed = new Map<string, string>();
  /** Tasks each terminal has handed out since a person last typed in it. */
  private readonly handedSince = new Map<string, number>();
  /** How many times each task has been watched again after a report that it waits for a person. */
  private readonly rewatched = new Map<string, number>();
  /** `--wait` callers, by task, until its first answer. */
  private readonly waitFor = new Map<string, (answered: Answered | null, ended: boolean) => void>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly roster: Roster;
  private readonly files: SavedFiles;
  private readonly answers: Answers;
  private readonly delivery: Delivery;
  private readonly reviews: Reviews;

  constructor(
    private readonly core: ServiceCore,
    private readonly tasks: TaskDesk,
  ) {
    this.roster = new Roster(core);
    this.answers = new Answers(core, this.roster, () => this.ensureTimer(), (from, to, reply) => this.forward(from, to, reply));
    this.delivery = new Delivery(core, this.answers);
    this.files = new SavedFiles(core, () => [...this.delivery.texts(), ...this.answers.texts()]);
    this.reviews = new Reviews(core, this.roster, this.delivery, this.files, () => void this.pump());
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.answers.close();
  }

  private settings() {
    return this.core.store.readSettings().agentTalk;
  }

  private nowMs(): number {
    return this.core.now().getTime();
  }

  // ---------------------------------------------------------------- who is there

  /** Every coding CLI that can be reached. The engines and each agent are read once for the lot, not once per CLI. */
  list(): Reachable[] {
    return this.roster.list();
  }

  who(fromPty: string | null): WhoResult {
    return this.roster.who(fromPty);
  }

  // ---------------------------------------------------------------- tell

  /** `vibeforge tell <to> "…"`: a message from one CLI (or a terminal outside VibeForge) to another. */
  /**
   * `fromPerson`: words a person sent through Maestro. They go in as typed, with no sender line, and
   * aren't CLIs talking to each other: that setting and the message limit don't apply to them.
   */
  tell(input: { fromPty: string | null; to: string; text: string; wait?: boolean; timeoutMs?: number; gone?: AbortSignal; fromPerson?: boolean }): Promise<TellResult> {
    const person = Boolean(input.fromPerson) && !input.fromPty;
    if (!person && !this.settings().on) return Promise.resolve({ ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." });
    const list = this.list();
    const from = list.find((item) => item.ptyId === input.fromPty) ?? null;
    const found = resolveTarget(input.to, from?.ptyId ?? null, list);
    if (!found.ok) {
      const others = found.options.length ? ` Running now: ${found.options.join(", ")}.` : " No other coding CLI is running in VibeForge.";
      const error =
        found.reason === "self" ? "That's you." : found.reason === "ambiguous" ? `"${input.to}" could be more than one CLI.${others}` : `No CLI called "${input.to}" is running.${others}`;
      return Promise.resolve({ ok: false, error });
    }
    const to = found.to;
    const text = cleanText(input.text);
    if (!text) return Promise.resolve({ ok: false, error: "The message is empty." });
    if (this.delivery.isStopped(to.ptyId) || (from && this.delivery.isStopped(from.ptyId))) {
      return Promise.resolve({ ok: false, error: `A person stopped the conversation with ${from && this.delivery.isStopped(from.ptyId) ? "you" : to.label}. It starts again once they type in that terminal.` });
    }
    const atLimit = !person && this.delivery.atLimit(from?.ptyId ?? null, to.ptyId);
    const answer: Answer = input.wait ? "wait" : from ? "tell" : "none";
    const body = person ? text : messageText({ fromLabel: from?.label ?? "a terminal outside VibeForge", fromHandle: from?.handle ?? null, text, answer, savedAt: this.files.saveIfLong("messages", text) });
    const note = () =>
      `You and ${to.label} have sent each other ${this.settings().maxMessages} messages without a person stepping in, so this one waits in its prompt for a person to press Enter.`;

    return new Promise<TellResult>((resolve) => {
      const waitMs = Math.max(1000, input.timeoutMs ?? DEFAULT_WAIT_MS);
      this.delivery.queue({
        fromPty: from?.ptyId ?? null,
        toPty: to.ptyId,
        text: body,
        enter: !atLimit,
        counts: Boolean(from),
        waiter:
          input.wait && !atLimit
            ? {
                words: body.split("\n")[0],
                deadline: this.nowMs() + waitMs,
                done: (answered) =>
                  answered
                    ? resolve({ ok: true, to: to.handle, delivered: "sent", reply: answered.reply, fromScreen: answered.fromScreen || undefined })
                    : resolve({
                        ok: true,
                        to: to.handle,
                        delivered: "sent",
                        reply: null,
                        timedOut: true,
                        note: from ? `${to.label} is still working. Its answer will be sent to you as a message when it's done.` : `${to.label} is still working.`,
                      }),
                dropped: (why) => resolve({ ok: false, error: why }),
                gone: input.gone,
              }
            : null,
        // With --wait, an answer settles it, unless it went in as a draft (the limit came while it waited).
        delivered: (draft) => {
          if (draft || !input.wait) resolve({ ok: true, to: to.handle, delivered: draft ? "draft" : "sent", note: draft ? note() : undefined });
        },
        dropped: (why) => resolve({ ok: false, error: why }),
      });
      // Busy for now: say so at once rather than holding the sender until there's room.
      if (!input.wait && !atLimit && !this.delivery.idle(to.ptyId)) {
        resolve({ ok: true, to: to.handle, delivered: "queued", note: `${to.label} is busy; your message goes in as soon as it's free.` });
      }
      this.core.emit("live");
      void this.pump();
    });
  }

  /** Send to…: a draft from one pane into another, labelled, for a person to read and send. */
  async sendDraft(input: { fromPty: string; toPty: string; what: "reply" | "selection" | "changes"; selection?: string }): Promise<{ sent: boolean }> {
    const from = this.list().find((item) => item.ptyId === input.fromPty);
    const to = this.core.live.get(input.toPty);
    if (!from || !to || !isCodingCli(to)) throw new Error("That CLI isn't running any more.");
    let text = "";
    if (input.what === "selection") text = cleanText(input.selection ?? "");
    else if (input.what === "reply") text = await this.lastAnswer(from);
    else {
      const patch = await changesOf(this.core, from.ptyId);
      if (patch.trim()) {
        const file = this.files.saveFile("reviews", "patch", patch);
        const files = patchFiles(patch);
        text = `My changes are in ${file}${files.length ? ` (${files.slice(0, 12).join(", ")}${files.length > 12 ? "…" : ""})` : ""}.`;
      }
    }
    if (!text) return { sent: false };
    const saved = this.files.saveIfLong("messages", text);
    await this.core.options.host.send(input.toPty, messageText({ fromLabel: from.label, fromHandle: null, text, answer: "none", savedAt: saved }), false);
    return { sent: true };
  }

  /** The CLI's last finished answer: its own log when VibeForge can read it, else the end of its screen. */
  private async lastAnswer(from: Reachable): Promise<string> {
    const session = this.core.live.get(from.ptyId);
    const engine = session ? this.roster.engineOf(session) : null;
    const kind = engine ? replyLogFor(engine.id, engine.bin) : null;
    if (kind && this.core.options.host.lastReply && session) {
      const since = Date.parse(session.cliSince ?? session.startedAt) - 5000;
      const reply = await this.core.options.host.lastReply({ kind, cwd: from.cwd, since }).catch(() => null);
      if (reply?.trim()) return cleanText(reply);
    }
    return this.screenOf(from.ptyId);
  }

  private async screenOf(ptyId: string): Promise<string> {
    const screen = await this.core.options.host.screen?.(ptyId).catch(() => "");
    return cleanText(screenTail(screen ?? ""));
  }

  // ---------------------------------------------------------------- a person steps in

  /** A person typed into a terminal: its counts start again, and a Stop on it is lifted. */
  onHumanInput(ptyId: string, data: string): void {
    const typed = typedIn(data);
    if (!typed) return;
    const changed = this.delivery.personTyped(ptyId, typed);
    this.handedSince.delete(ptyId);
    if (changed) this.core.emit("live");
  }

  /** Stop: nothing more goes to or from this terminal until a person types in it. */
  stop(ptyId: string): void {
    this.delivery.stop(ptyId);
    this.answers.stop(ptyId);
    this.reviews.stop(ptyId);
    this.core.emit("live");
  }

  // ---------------------------------------------------------------- review with…

  /**
   * Review with…: when the author's turn ends, the reviewer reads its changes, and the author gets
   * the review back. `changes` says whether the author has changed anything yet; without, the
   * review waits for its next turn.
   */
  startReview(authorPty: string, reviewerPty: string): Promise<{ changes: boolean }> {
    return this.reviews.startReview(authorPty, reviewerPty);
  }

  // ---------------------------------------------------------------- task

  /** `vibeforge task <agent> "…"`: a task for a VibeForge agent, in its own copy so it never works in the sender's folder. */
  async handTask(input: { fromPty: string | null; agent: string; text: string; title?: string; start?: boolean; wait?: boolean; timeoutMs?: number }): Promise<TaskResult> {
    if (!this.settings().on) return { ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." };
    const agents = this.core.store.listAgents();
    const agent = findAgent(agents, input.agent);
    if (!agent) return { ok: false, error: `No agent called "${input.agent}".${agents.length ? ` Agents: ${agents.map((item) => item.id).join(", ")}.` : " There are no agents yet."}` };
    const text = cleanText(input.text);
    if (!text) return { ok: false, error: "The task is empty." };
    const from = this.list().find((item) => item.ptyId === input.fromPty) ?? null;
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
      this.waitFor.set(taskId, (answered, ended) =>
        resolve(
          ended
            ? { ok: true, taskId, title, started: true, reply: null, note: `It ended before ${name} answered. ${note}` }
            : { ok: true, taskId, title, started: true, reply: answered?.reply ?? null, note: answered ? note : `${name} is still working on it. ${note}${reports}` },
        ),
      );
    });
  }

  /** Watches a started task's first answer (from `since`, its start by default); see startHanded. */
  private watchReport(taskId: string, ptyId: string, asker: string | null, opts: { wait?: boolean; timeoutMs?: number }, since?: number): void {
    const settle = (answered: Answered | null, ended: boolean) => {
      const waiting = this.waitFor.get(taskId);
      this.waitFor.delete(taskId);
      waiting?.(answered, ended);
    };
    this.answers.watchAnswer(
      ptyId,
      {
        words: "",
        deadline: this.nowMs() + (opts.wait ? Math.max(1000, opts.timeoutMs ?? DEFAULT_WAIT_MS) : 0),
        done: (answered) => settle(answered, false),
        dropped: () => settle(null, true),
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
  private toStart(ptyId: string): TalkState["toStart"] {
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
    const task = this.core.store.getTask(input.task) ?? this.core.store.listTasks().find((item) => item.title === input.task) ?? null;
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
    const from = this.list().find((item) => item.ptyId === taskPty) ?? null;
    const agent = task.agentId ? this.core.store.getAgent(task.agentId) : null;
    const patch = task.copy ? await copyPatch(task.copy, { dataRoot: this.core.options.dataRoot, taskId }).catch(() => "") : "";
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
    });
    // Counted like any message between the two: past the limit it waits in the prompt for a person
    // (checked as it goes in, see pass).
    this.delivery.queue({ fromPty: taskPty, toPty: asker, text, enter: true, counts: true, waiter: null, dropped: () => undefined });
    this.core.emit("live");
    void this.pump();
    return waiting;
  }

  // ---------------------------------------------------------------- the window

  /** How a terminal is talking right now, for its pane. Null when it isn't. */
  talkFor(ptyId: string): TalkState | null {
    return this.talkForEach([ptyId]).get(ptyId) ?? null;
  }

  /**
   * How each of these terminals is talking, for the window's list of them. Who is there and the
   * settings are read once for all of them: a refresh happens whenever any CLI goes busy or quiet.
   */
  talkForEach(ptyIds: readonly string[]): Map<string, TalkState | null> {
    const out = new Map<string, TalkState | null>();
    const busy = this.delivery.counting || this.delivery.queued || this.answers.size || this.reviews.size || this.proposed.size;
    if (!busy) {
      for (const ptyId of ptyIds) out.set(ptyId, null);
      return out;
    }
    const list = this.list();
    const max = this.settings().maxMessages;
    for (const ptyId of ptyIds) out.set(ptyId, this.talkOf(ptyId, list, max));
    return out;
  }

  private talkOf(ptyId: string, list: readonly Reachable[], max: number): TalkState | null {
    const name = (id: string) => list.find((item) => item.ptyId === id)?.label ?? null;
    const partners = this.delivery.partnersOf(ptyId);
    const queued = this.delivery.queuedFor(ptyId);
    const waited = this.answers.waitedOn(ptyId);
    const review = this.reviews.viewFor(ptyId, name);
    const toStart = this.toStart(ptyId);
    if (!partners.size && !queued && !waited.any && !review && !toStart.length) return null;
    return {
      with: [...partners.keys()].map(name).filter((label): label is string => Boolean(label)),
      messages: Math.max(0, ...partners.values()),
      max,
      queued,
      held: [...partners.values()].some((count) => count >= max),
      review,
      reportsTo: waited.reportsTo ? name(waited.reportsTo) : null,
      toStart,
    };
  }

  // ---------------------------------------------------------------- delivery

  /**
   * Delivers what can go now and reads answers that are ready. Runs every second while anything is
   * in flight. A call while a pass is running waits for it and one more pass.
   */
  pump(): Promise<void> {
    this.ensureTimer();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        // In the same step as the last look at `again`, so a call in between can't be lost.
        this.running = null;
        if (!this.delivery.queued && !this.answers.size && !this.reviews.size && this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }
    })();
    this.running = run;
    return run;
  }

  private async pass(): Promise<void> {
    const now = this.nowMs();
    await this.reviews.step(now);
    await this.delivery.deliver(now);
    await this.answers.check(now);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pump(), PUMP_MS);
    this.timer.unref?.();
  }

  /** An answer that came after its sender stopped waiting: to the sender as a message. */
  private forward(target: string, to: string, reply: string): void {
    const from = this.list().find((item) => item.ptyId === target);
    this.delivery.queue({
      fromPty: target,
      toPty: to,
      text: messageText({ fromLabel: from?.label ?? "The other CLI", fromHandle: from?.handle ?? null, text: cleanText(reply), answer: "tell", savedAt: this.files.saveIfLong("messages", reply) }),
      enter: true,
      counts: true,
      waiter: null,
      dropped: () => undefined,
    });
    void this.pump();
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
