import { answerFromScreen, cleanText, SETTLE_MS } from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import { replyLogFor, type ReplyLog } from "../replies.js";
import type { ServiceCore } from "./core.js";
import type { Roster } from "./messages-who.js";

/** A CLI whose log should have the answer, but doesn't after this long quiet, is read from its screen. */
const LOG_PATIENCE_MS = 30_000;
/** An answer still not in this long after the sender stopped waiting is given up on. */
const LATE_ANSWER_MS = 30 * 60 * 1000;

export type Answered = { reply: string | null; fromScreen: boolean };

/** What waiting for an answer is for: `done` gets the answer, or null once the deadline passes. */
export interface WaitSpec {
  /** The first line of what was sent, to find that prompt in the CLI's log. */
  words: string;
  /** All of what was sent, to find where the answer starts on a screen. */
  sent?: string;
  deadline: number;
  done: (answered: Answered | null) => void;
  /** The CLI went away, or (`stopped`) a person pressed Stop on it or on the sender. */
  dropped?: (why: string, stopped: boolean) => void;
  /** Aborts when the sender stops waiting early (its own tool timed out): the answer then goes to it as a message. */
  gone?: AbortSignal;
  /** Once the sender has stopped waiting: what to do with an answer or an end, and for how long to keep watching. Without it, an answer is forwarded as a message. */
  after?: { answered: (answered: Answered) => void; ended: () => void; forMs: number };
  /**
   * A CLI that drew one screen and never moved (a trust question as it starts) never goes "quiet":
   * it counts as quiet this long after the watch began.
   */
  stuckMs?: number;
}

interface Waiter extends WaitSpec {
  /** When the message was pasted; the answer is the turn after it. */
  since: number;
  abort: AbortController;
  logKind: ReplyLog | null;
  reading: boolean;
  /** The deadline passed and the sender was told; the answer goes to `forwardTo` as a message. */
  gaveUp: boolean;
  forwardTo: string | null;
}

/**
 * Answers to what was sent: from the CLI's own log when VibeForge reads that CLI's logs, else the
 * end of its screen once it has worked and gone quiet. Past the deadline the sender is told it's
 * still going, and the answer follows as a message (or goes where `WaitSpec.after` says).
 */
export class Answers {
  /** Who is waited on, by terminal. */
  private readonly waiting = new Map<string, Waiter[]>();

  constructor(
    private readonly core: ServiceCore,
    private readonly roster: Roster,
    /** Starts the once-a-second pass that checks on each waiter (see MessageDesk.pump). */
    private readonly wake: () => void,
    /** An answer that came after its sender stopped waiting, to the sender as a message. */
    private readonly forward: (from: string, to: string, reply: string) => void,
  ) {}

  /** How many terminals are waited on. */
  get size(): number {
    return this.waiting.size;
  }

  close(): void {
    for (const list of this.waiting.values()) for (const waiter of list) waiter.abort.abort();
  }

  /** What was sent and is still being answered: a saved file one names is kept. */
  texts(): string[] {
    return [...this.waiting.values()].flat().map((waiter) => waiter.sent ?? "");
  }

  /** For `ptyId`'s pane: whether it's waited on, and the terminal a task it works on reports to. */
  waitedOn(ptyId: string): { any: boolean; reportsTo: string | null } {
    const mine = this.waiting.get(ptyId) ?? [];
    const reporting = mine.find((waiter) => waiter.after && waiter.forwardTo);
    return { any: mine.length > 0, reportsTo: reporting?.forwardTo ?? null };
  }

  /** Tasks `asker` handed out that are still working: started, and not reported back yet. */
  reportingTo(asker: string): number {
    let count = 0;
    for (const list of this.waiting.values()) for (const waiter of list) if (waiter.after && waiter.forwardTo === asker) count += 1;
    return count;
  }

  /** Stop: nothing more is waited for from `ptyId`, or for it. */
  stop(ptyId: string): void {
    for (const [target, list] of [...this.waiting]) {
      for (const waiter of [...list]) if (target === ptyId || waiter.forwardTo === ptyId) this.dropWaiter(target, waiter, "A person stopped this conversation.", false);
    }
  }

  /** Reads the answers that are ready, and settles waits that are over. */
  async check(now: number): Promise<void> {
    for (const [target, list] of [...this.waiting]) for (const waiter of [...list]) await this.checkWaiter(target, waiter, now);
  }

  /**
   * Waits for the answer to what was just sent to `target`: from its own log when VibeForge reads
   * that CLI's logs, else the end of its screen once it has worked and gone quiet. Past the
   * deadline the sender is told it's still going, and the answer follows as a message.
   */
  watchAnswer(target: string, spec: WaitSpec, since: number, forwardTo: string | null = null): void {
    const session = this.core.live.get(target);
    const engine = session ? this.roster.engineOf(session) : null;
    const watch = this.core.options.host.watchReply;
    const logKind = engine && watch ? replyLogFor(engine.id, engine.bin) : null;
    const waiter: Waiter = { ...spec, since, abort: new AbortController(), logKind, reading: false, gaveUp: Boolean(spec.gone?.aborted), forwardTo };
    // A sender that hangs up early has stopped waiting, as if its deadline had passed.
    spec.gone?.addEventListener("abort", () => (waiter.gaveUp = true), { once: true });
    this.waiting.set(target, [...(this.waiting.get(target) ?? []), waiter]);
    // Checked every second from now: a CLI that never moves would otherwise never be looked at again.
    this.wake();
    if (logKind && session && watch) {
      const cwd = session.programCwd || (session.runId ? this.core.store.getRun(session.runId)?.cwd : null) || session.cwd;
      void watch({ kind: logKind, cwd, since: since - 2000, words: spec.words, signal: waiter.abort.signal })
        .then((reply) => {
          if (reply !== null) this.finishWaiter(target, waiter, { reply, fromScreen: false });
        })
        .catch(() => undefined);
    }
  }

  private async checkWaiter(target: string, waiter: Waiter, now: number): Promise<void> {
    const session = this.core.live.get(target);
    if (!session || !isCodingCli(session)) return this.dropWaiter(target, waiter, "That CLI isn't running any more.");
    const quietAt = Date.parse(session.quietAt ?? "");
    const quietSince = quietAt > waiter.since ? quietAt : waiter.stuckMs && !session.quietAt ? waiter.since + waiter.stuckMs : Number.NaN;
    const answered = !session.working && Number.isFinite(quietSince) && now - quietSince >= (waiter.logKind ? LOG_PATIENCE_MS : SETTLE_MS);
    if (answered && !waiter.reading) {
      waiter.reading = true;
      const screen = await this.core.options.host.screen?.(target).catch(() => "");
      const reply = cleanText(answerFromScreen(screen ?? "", waiter.sent ?? ""));
      return this.finishWaiter(target, waiter, { reply, fromScreen: true });
    }
    if (!waiter.gaveUp && now >= waiter.deadline) {
      waiter.gaveUp = true;
      waiter.done(null);
    }
    // Its answer never came (the CLI never took the message up): stop looking, or the pane says it's waiting forever.
    if (waiter.gaveUp && now >= waiter.deadline + (waiter.after?.forMs ?? LATE_ANSWER_MS)) this.takeWaiter(target, waiter);
  }

  private takeWaiter(target: string, waiter: Waiter): boolean {
    const list = this.waiting.get(target);
    if (!list?.includes(waiter)) return false;
    list.splice(list.indexOf(waiter), 1);
    if (!list.length) this.waiting.delete(target);
    waiter.abort.abort();
    this.core.emit("live");
    return true;
  }

  private finishWaiter(target: string, waiter: Waiter, answered: Answered): void {
    if (!this.takeWaiter(target, waiter)) return;
    if (!waiter.gaveUp) {
      waiter.done(answered);
      return;
    }
    if (waiter.after) {
      waiter.after.answered(answered);
      return;
    }
    // The sender gave up waiting: the answer reaches it as a message instead.
    if (!waiter.forwardTo || !answered.reply?.trim()) return;
    this.forward(target, waiter.forwardTo, answered.reply);
  }

  /** The CLI went away (or, with `ended` false, a person pressed Stop): nothing more will come. */
  private dropWaiter(target: string, waiter: Waiter, why: string, ended = true): void {
    if (!this.takeWaiter(target, waiter)) return;
    if (waiter.gaveUp) {
      if (ended) waiter.after?.ended();
      return;
    }
    if (waiter.dropped) waiter.dropped(why, !ended);
    else waiter.done(null);
  }
}
