import { cleanText, DEFAULT_WAIT_MS, messageText, resolveTarget, screenTail, type Answer, type Reachable } from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import { replyLogFor } from "../replies.js";
import type { TalkState } from "../types.js";
import { patchFiles } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import { Answers } from "./messages-answers.js";
import { Delivery, typedIn } from "./messages-delivery.js";
import { SavedFiles } from "./messages-files.js";
import { changesOf, Reviews } from "./messages-review.js";
import { HandedTasks, type TaskResult } from "./messages-tasks.js";
import { Roster, type WhoResult } from "./messages-who.js";
import type { TaskDesk } from "./tasks.js";

export { findAgent, taskTitle, type TaskResult } from "./messages-tasks.js";
export type { WhoResult } from "./messages-who.js";

// CLIs talking to each other through VibeForge: `vibeforge tell` from one terminal pastes into
// another once it is idle, `--wait` hands the answer back, Send to… leaves a draft for a person,
// Review with… runs a review loop, and `vibeforge task` hands a task to an agent in its own copy.
// Every message is labelled with its sender; two CLIs may trade a limited number of messages
// before a person has to press Enter; Stop ends it. A person typing into a terminal resets its count.
//
// MessageDesk is what the rest of the service uses. The work is in the parts beside it, each the
// one owner of its own state, given only the other parts it needs:
//   messages-who.ts       Roster: the CLIs that can be reached, by their handles, and the agents
//   messages-delivery.ts  Delivery: the line of messages, the two CLIs' limit, Stop, pasting into an idle CLI
//   messages-answers.ts   Answers: waiting for an answer, from a CLI's log or its screen, and late answers
//   messages-review.ts    Reviews: Review with…, round by round
//   messages-tasks.ts     HandedTasks: `vibeforge task` and `apply`, held tasks, reports to the CLI that handed one out
//   messages-files.ts     SavedFiles: long messages and patches, saved for a CLI to read by their path
// The pump here takes them all a step on, every second while anything is in flight.

const PUMP_MS = 1000;

export type TellResult =
  | { ok: true; to: string; delivered: "sent" | "draft" | "queued"; reply?: string | null; fromScreen?: boolean; timedOut?: boolean; note?: string }
  | { ok: false; error: string };

export class MessageDesk {
  private readonly roster: Roster;
  private readonly answers: Answers;
  private readonly delivery: Delivery;
  private readonly files: SavedFiles;
  private readonly reviews: Reviews;
  private readonly handed: HandedTasks;
  private timer: NodeJS.Timeout | null = null;
  private readonly stopTidying: () => void;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly core: ServiceCore,
    tasks: TaskDesk,
  ) {
    this.roster = new Roster(core);
    this.answers = new Answers(core, this.roster, () => this.ensureTimer(), (from, to, reply) => this.forward(from, to, reply));
    this.delivery = new Delivery(core, this.answers);
    this.files = new SavedFiles(core, () => [...this.delivery.texts(), ...this.answers.texts()]);
    this.stopTidying = this.files.tidyNowAndHourly();
    const pump = () => void this.pump();
    this.reviews = new Reviews(core, this.roster, this.delivery, this.files, pump);
    this.handed = new HandedTasks(core, tasks, this.roster, this.delivery, this.answers, this.files, pump);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopTidying();
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
        const file = this.files.savePatch(patch);
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
    this.handed.personTyped(ptyId);
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
  handTask(input: { fromPty: string | null; agent: string; text: string; title?: string; start?: boolean; wait?: boolean; timeoutMs?: number; gone?: AbortSignal }): Promise<TaskResult> {
    return this.handed.handTask(input);
  }

  /** Start: a person starts tasks a CLI handed out that were held for them (all of this terminal's, or the ones named). */
  startHeld(ptyId: string, taskIds: readonly string[] | null): Promise<{ started: number; failed: string[] }> {
    return this.handed.startHeld(ptyId, taskIds);
  }

  /** A person executed a handed-out task from the board: it reports to the CLI that handed it out all the same. */
  adoptStarted(taskId: string, ptyId: string): void {
    this.handed.adoptStarted(taskId, ptyId);
  }

  /** `vibeforge apply <task>`: the CLI that handed a task out brings its changes into the workspace, when Settings lets it. */
  applyHanded(input: { fromPty: string | null; task: string }): Promise<{ ok: true; files: string[]; conflicts: string[]; note: string } | { ok: false; error: string }> {
    return this.handed.applyHanded(input);
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
    const busy = this.delivery.counting || this.delivery.queued || this.answers.size || this.reviews.size || this.handed.waitingToStart;
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
    const toStart = this.handed.toStart(ptyId);
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

  // ---------------------------------------------------------------- the pump

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

  /** One step for everything in flight: reviews whose author's turn ended, then messages that can go, then answers. */
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
    // Cleaned before it's measured and saved, as a report's answer is: a log's answer can carry a terminal's bytes.
    const text = cleanText(reply);
    if (!text) return;
    const from = this.list().find((item) => item.ptyId === target);
    this.delivery.queue({
      fromPty: target,
      toPty: to,
      text: messageText({ fromLabel: from?.label ?? "The other CLI", fromHandle: from?.handle ?? null, text, answer: "tell", savedAt: this.files.saveIfLong("messages", text) }),
      enter: true,
      counts: true,
      waiter: null,
      dropped: () => undefined,
    });
    void this.pump();
  }
}
