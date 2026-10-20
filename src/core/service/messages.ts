import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  cleanText,
  DEFAULT_WAIT_MS,
  HUMAN_DRAFT_MS,
  MESSAGE_INLINE_MAX,
  messageText,
  pairKey,
  reachable,
  resolveTarget,
  reviewReplyText,
  reviewRequestText,
  screenTail,
  answerFromScreen,
  Handles,
  SETTLE_MS,
  type Answer,
  type Reachable,
} from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import { writeFileAtomic } from "../fsx.js";
import { replyLogFor, type ReplyLog } from "../replies.js";
import { slugify } from "../slug.js";
import { createTask } from "../tasks.js";
import { diffSince, isGitRepo, leaveOutUntouched } from "../vcs.js";
import { patchFiles } from "../worktrees.js";
import type { LiveSession, TalkState } from "../types.js";
import type { ServiceCore } from "./core.js";
import type { TaskDesk } from "./tasks.js";

// CLIs talking to each other through VibeForge: `vibeforge tell` from one terminal pastes into
// another once it is idle, `--wait` hands the answer back, Send to… leaves a draft for a person,
// Review with… runs a review loop, and `vibeforge task` hands a task to an agent in its own copy.
// Every message is labelled with its sender; two CLIs may trade a limited number of messages
// before a person has to press Enter; Stop ends it. A person typing into a terminal resets its count.

const PUMP_MS = 1000;
/** A CLI that just went quiet, or was just sent something, isn't sent the next message straight away. */
const IDLE_MS = 1500;
const BETWEEN_MS = 3000;
/** A CLI whose log should have the answer, but doesn't after this long quiet, is read from its screen. */
const LOG_PATIENCE_MS = 30_000;
/** A CLI that hasn't gone quiet once since it started may still be drawing its first screen. */
const BOOT_MS = 5000;
/** An answer still not in this long after the sender stopped waiting is given up on. */
const LATE_ANSWER_MS = 30 * 60 * 1000;
/** Tasks one CLI may have running that it handed out; more are made but wait in To do. */
const MAX_RUNNING_HANDED_OUT = 3;
const KEEP_FILES = 40;
/** Focus in/out (CSI I, CSI O) and mouse reports (X10 and SGR), which a terminal sends on its own. */
const TERMINAL_REPORTS = /\x1b\[[IO]|\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[mM]/g;

export type TellResult =
  | { ok: true; to: string; delivered: "sent" | "draft" | "queued"; reply?: string | null; fromScreen?: boolean; timedOut?: boolean; note?: string }
  | { ok: false; error: string };

export type TaskResult = { ok: true; taskId: string; title: string; started: boolean; reply?: string | null; note?: string } | { ok: false; error: string };

export interface WhoResult {
  you: string | null;
  clis: Array<{ handle: string; label: string; folder: string; working: boolean; you: boolean }>;
  agents: Array<{ name: string; handle: string }>;
}

type Answered = { reply: string | null; fromScreen: boolean };

/** What waiting for an answer is for: `done` gets the answer, or null once the deadline passes. */
interface WaitSpec {
  /** The first line of what was sent, to find that prompt in the CLI's log. */
  words: string;
  /** All of what was sent, to find where the answer starts on a screen. */
  sent?: string;
  deadline: number;
  done: (answered: Answered | null) => void;
  /** The CLI went away, or a person pressed Stop. */
  dropped?: (why: string) => void;
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

interface Pending {
  id: string;
  fromPty: string | null;
  toPty: string;
  text: string;
  enter: boolean;
  /** Counted against the two CLIs' limit (a person's draft and review steps aren't). */
  counts: boolean;
  waiter: WaitSpec | null;
  delivered?: () => void;
  dropped: (why: string) => void;
}

interface Review {
  id: string;
  authorPty: string;
  reviewerPty: string;
  round: number;
  rounds: number;
  phase: "author" | "reviewer" | "fixing";
  /** When the phase began; the author has to work and go quiet after it before the next round. */
  since: number;
}

export class MessageDesk {
  private readonly pending: Pending[] = [];
  private readonly waiting = new Map<string, Waiter[]>();
  private readonly counts = new Map<string, number>();
  private readonly stopped = new Set<string>();
  private readonly lastHuman = new Map<string, { at: number; sent: boolean }>();
  private readonly lastSent = new Map<string, number>();
  private readonly reviews = new Map<string, Review>();
  private readonly handles = new Handles();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly core: ServiceCore,
    private readonly tasks: TaskDesk,
  ) {}

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const list of this.waiting.values()) for (const waiter of list) waiter.abort.abort();
  }

  private settings() {
    return this.core.store.readSettings().agentTalk;
  }

  private nowMs(): number {
    return this.core.now().getTime();
  }

  // ---------------------------------------------------------------- who is there

  list(): Reachable[] {
    return reachable(
      [...this.core.live.values()],
      {
        agent: (id) => this.core.store.getAgent(id)?.name ?? null,
        engine: (session) => this.engineOf(session),
      },
      this.handles,
    );
  }

  private engineOf(session: LiveSession): { id: string; label: string; bin: string } | null {
    const id = session.programEngineId || (session.runId ? this.core.store.getRun(session.runId)?.engine : null) || null;
    if (!id) return null;
    const row = this.core.store.readEngineRows().find((item) => item.id === id);
    return { id, label: row?.label ?? id, bin: row?.bin ?? id };
  }

  who(fromPty: string | null): WhoResult {
    const list = this.list();
    return {
      you: list.find((item) => item.ptyId === fromPty)?.handle ?? null,
      clis: list.map((item) => ({ handle: item.handle, label: item.label, folder: item.cwd, working: item.working, you: item.ptyId === fromPty })),
      agents: this.core.store.listAgents().map((agent) => ({ name: agent.name, handle: slugify(agent.name, 24) })),
    };
  }

  // ---------------------------------------------------------------- tell

  /** `vibeforge tell <to> "…"`: a message from one CLI (or a terminal outside VibeForge) to another. */
  tell(input: { fromPty: string | null; to: string; text: string; wait?: boolean; timeoutMs?: number }): Promise<TellResult> {
    if (!this.settings().on) return Promise.resolve({ ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." });
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
    if (this.stopped.has(to.ptyId) || (from && this.stopped.has(from.ptyId))) {
      return Promise.resolve({ ok: false, error: `A person stopped the conversation with ${from && this.stopped.has(from.ptyId) ? "you" : to.label}. It starts again once they type in that terminal.` });
    }
    const key = pairKey(from?.ptyId ?? "outside", to.ptyId);
    const atLimit = Boolean(from) && (this.counts.get(key) ?? 0) >= this.settings().maxMessages;
    const answer: Answer = input.wait ? "wait" : from ? "tell" : "none";
    const body = messageText({ fromLabel: from?.label ?? "a terminal outside VibeForge", fromHandle: from?.handle ?? null, text, answer, savedAt: this.saveIfLong("messages", text) });
    const note = atLimit
      ? `You and ${to.label} have sent each other ${this.settings().maxMessages} messages without a person stepping in, so this one waits in its prompt for a person to press Enter.`
      : undefined;

    return new Promise<TellResult>((resolve) => {
      const waitMs = Math.max(1000, input.timeoutMs ?? DEFAULT_WAIT_MS);
      this.pending.push({
        id: randomBytes(4).toString("hex"),
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
              }
            : null,
        delivered: input.wait && !atLimit ? undefined : () => resolve({ ok: true, to: to.handle, delivered: atLimit ? "draft" : "sent", note }),
        dropped: (why) => resolve({ ok: false, error: why }),
      });
      // Busy for now: say so at once rather than holding the sender until there's room.
      if (!input.wait && !atLimit && !this.idle(to.ptyId)) {
        const last = this.pending[this.pending.length - 1];
        last.delivered = undefined;
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
      const patch = await this.changesOf(from.ptyId);
      if (patch.trim()) {
        const file = this.saveFile("reviews", "patch", patch);
        const files = patchFiles(patch);
        text = `My changes are in ${file}${files.length ? ` (${files.slice(0, 12).join(", ")}${files.length > 12 ? "…" : ""})` : ""}.`;
      }
    }
    if (!text) return { sent: false };
    const saved = this.saveIfLong("messages", text);
    await this.core.options.host.send(input.toPty, messageText({ fromLabel: from.label, fromHandle: null, text, answer: "none", savedAt: saved }), false);
    return { sent: true };
  }

  /** The CLI's last finished answer: its own log when VibeForge can read it, else the end of its screen. */
  private async lastAnswer(from: Reachable): Promise<string> {
    const session = this.core.live.get(from.ptyId);
    const engine = session ? this.engineOf(session) : null;
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

  /** What this CLI changed: the folder's changes since it started, less files already changed then that it hasn't touched. */
  private async changesOf(ptyId: string): Promise<string> {
    const session = this.core.live.get(ptyId);
    if (!session) return "";
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    const cwd = run?.cwd || session.programCwd || session.cwd;
    const before = session.runId ? await this.core.dirtyAtStart.get(session.runId) : null;
    const patch = await diffSince(cwd, run?.gitStart ?? null).catch(() => "");
    return leaveOutUntouched(patch, cwd, before);
  }

  // ---------------------------------------------------------------- a person steps in

  /** A person typed into a terminal: its counts start again, and a Stop on it is lifted. */
  onHumanInput(ptyId: string, data: string): void {
    // A terminal reports focus and the mouse as input too (Claude Code asks for focus events):
    // clicking a pane isn't a person stepping into the conversation.
    if (!data.replace(TERMINAL_REPORTS, "")) return;
    this.lastHuman.set(ptyId, { at: this.nowMs(), sent: /[\r\n]/.test(data) });
    let changed = this.stopped.delete(ptyId);
    for (const key of [...this.counts.keys()]) {
      if (key.split("|").includes(ptyId)) {
        this.counts.delete(key);
        changed = true;
      }
    }
    if (changed) this.core.emit("live");
  }

  /** Stop: nothing more goes to or from this terminal until a person types in it. */
  stop(ptyId: string): void {
    this.stopped.add(ptyId);
    for (const key of [...this.counts.keys()]) if (key.split("|").includes(ptyId)) this.counts.delete(key);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i];
      if (item.toPty !== ptyId && item.fromPty !== ptyId) continue;
      this.pending.splice(i, 1);
      item.dropped("A person stopped this conversation.");
    }
    for (const [target, list] of [...this.waiting]) {
      for (const waiter of [...list]) if (target === ptyId || waiter.forwardTo === ptyId) this.dropWaiter(target, waiter, "A person stopped this conversation.");
    }
    for (const [id, review] of this.reviews) if (review.authorPty === ptyId || review.reviewerPty === ptyId) this.reviews.delete(id);
    this.core.emit("live");
  }

  // ---------------------------------------------------------------- review with…

  /**
   * Review with…: when the author's turn ends, the reviewer reads its changes, and the author gets
   * the review back. `changes` says whether the author has changed anything yet; without, the
   * review waits for its next turn.
   */
  async startReview(authorPty: string, reviewerPty: string): Promise<{ changes: boolean }> {
    const author = this.core.live.get(authorPty);
    const reviewer = this.core.live.get(reviewerPty);
    if (!author || !reviewer || !isCodingCli(author) || !isCodingCli(reviewer)) throw new Error("That CLI isn't running any more.");
    if (authorPty === reviewerPty) throw new Error("Pick another CLI to review the changes.");
    const changes = Boolean((await this.changesOf(authorPty)).trim());
    for (const [id, review] of this.reviews) if (review.authorPty === authorPty) this.reviews.delete(id);
    this.stopped.delete(authorPty);
    this.stopped.delete(reviewerPty);
    const id = randomBytes(4).toString("hex");
    this.reviews.set(id, {
      id,
      authorPty,
      reviewerPty,
      round: 1,
      rounds: this.settings().reviewRounds,
      phase: "author",
      since: 0,
    });
    this.core.emit("live");
    void this.pump();
    return { changes };
  }

  private async stepReview(key: string, review: Review, now: number): Promise<void> {
    const author = this.core.live.get(review.authorPty);
    const reviewer = this.core.live.get(review.reviewerPty);
    if (!author || !reviewer || !isCodingCli(author) || !isCodingCli(reviewer)) {
      this.reviews.delete(key);
      this.core.emit("live");
      return;
    }
    if (review.phase === "reviewer") return;
    // The author's turn is over: it went quiet a while ago, and (after the first round) worked since the last step.
    const quietAt = Date.parse(author.quietAt ?? "");
    const settled = !author.working && (review.since === 0 || quietAt > review.since) && now - (Number.isFinite(quietAt) ? quietAt : 0) >= SETTLE_MS;
    if (!settled) return;
    if (review.phase === "fixing") {
      if (review.round > review.rounds) {
        this.reviews.delete(key);
        this.core.emit("live");
        return;
      }
      review.phase = "author";
    }
    const patch = await this.changesOf(review.authorPty);
    const list = this.list();
    const authorLabel = list.find((item) => item.ptyId === review.authorPty)?.label ?? "The other CLI";
    const reviewerLabel = list.find((item) => item.ptyId === review.reviewerPty)?.label ?? "The reviewer";
    if (!this.reviews.has(key)) return;
    if (!patch.trim()) {
      // Nothing yet: asked before the author has changed anything, so wait for its next turn. A
      // turn that ends with nothing changed ends the review.
      if (review.since === 0) review.since = now;
      else this.reviews.delete(key);
      this.core.emit("live");
      return;
    }
    const file = this.saveFile("reviews", "patch", patch);
    review.phase = "reviewer";
    this.core.emit("live");
    this.pending.push({
      id: randomBytes(4).toString("hex"),
      fromPty: null,
      toPty: review.reviewerPty,
      text: reviewRequestText({ authorLabel, cwd: author.programCwd || author.cwd, patchPath: file, files: patchFiles(patch), round: review.round, rounds: review.rounds }),
      enter: true,
      counts: false,
      waiter: {
        words: "[Review request from VibeForge",
        deadline: now + 30 * 60 * 1000,
        done: (answered) => {
          if (!this.reviews.has(key)) return;
          if (!answered?.reply?.trim()) {
            this.reviews.delete(key);
            this.core.emit("live");
            return;
          }
          const reply = cleanText(answered.reply);
          review.phase = "fixing";
          review.round += 1;
          review.since = this.nowMs();
          this.pending.push({
            id: randomBytes(4).toString("hex"),
            fromPty: null,
            toPty: review.authorPty,
            text: reviewReplyText({ reviewerLabel, reply, savedAt: this.saveIfLong("reviews", reply) }),
            enter: true,
            counts: false,
            waiter: null,
            delivered: () => {
              review.since = this.nowMs();
            },
            dropped: () => this.reviews.delete(key),
          });
          this.core.emit("live");
          void this.pump();
        },
      },
      dropped: () => this.reviews.delete(key),
    });
  }

  // ---------------------------------------------------------------- task

  /** `vibeforge task <agent> "…"`: a task for a VibeForge agent, in its own copy so it never works in the sender's folder. */
  async handTask(input: { fromPty: string | null; agent: string; text: string; title?: string; start?: boolean; wait?: boolean; timeoutMs?: number }): Promise<TaskResult> {
    if (!this.settings().on) return { ok: false, error: "Agents talking to each other is turned off in VibeForge's Settings." };
    const wanted = slugify(input.agent, 48);
    const agents = this.core.store.listAgents();
    const agent = agents.find((item) => item.id === input.agent || slugify(item.name, 48) === wanted);
    if (!agent) return { ok: false, error: `No agent called "${input.agent}".${agents.length ? ` Agents: ${agents.map((item) => slugify(item.name, 24)).join(", ")}.` : " There are no agents yet."}` };
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
    const title = (input.title?.trim() || text.split("\n")[0]).replace(/\s+/g, " ").slice(0, 80);
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
    const runningFromHere = this.core.store.listTasks().filter((item) => item.askedBy === askedBy && item.status === "running").length;
    const startable = input.start !== false;
    if (!startable) return { ok: true, taskId: task.id, title, started: false, note: "It waits in To do until a person executes it." };
    if (!isolated) return { ok: true, taskId: task.id, title, started: false, note: `${workspace.path} isn't a git repository, so the task can't have its own copy. It waits in To do for a person to start it.` };
    if (runningFromHere >= MAX_RUNNING_HANDED_OUT) {
      return { ok: true, taskId: task.id, title, started: false, note: `You already have ${MAX_RUNNING_HANDED_OUT} tasks running, so this one waits in To do.` };
    }
    let launched: Awaited<ReturnType<TaskDesk["executeTask"]>>;
    try {
      launched = await this.tasks.executeTask(task.id);
    } catch (error) {
      return { ok: true, taskId: task.id, title, started: false, note: `It couldn't start: ${error instanceof Error ? error.message : String(error)} It waits in To do.` };
    }
    const note = `${agent.name} works in its own copy of ${workspace.path}. A person applies its changes from the task.`;
    if (!input.wait || !("ptyId" in launched)) return { ok: true, taskId: task.id, title, started: true, note };
    const ptyId = launched.ptyId;
    return new Promise<TaskResult>((resolve) => {
      this.watchAnswer(ptyId, {
        words: "",
        deadline: this.nowMs() + Math.max(1000, input.timeoutMs ?? DEFAULT_WAIT_MS),
        done: (answered) =>
          resolve({ ok: true, taskId: task.id, title, started: true, reply: answered?.reply ?? null, note: answered ? note : `${agent.name} is still working on it. ${note}` }),
      }, Date.parse(this.core.live.get(ptyId)?.startedAt ?? "") || this.nowMs());
    });
  }

  // ---------------------------------------------------------------- the window

  /** How a terminal is talking right now, for its pane. Null when it isn't. */
  talkFor(ptyId: string): TalkState | null {
    const list = this.list();
    const name = (id: string) => list.find((item) => item.ptyId === id)?.label ?? null;
    const partners = new Map<string, number>();
    for (const [key, count] of this.counts) {
      const [a, b] = key.split("|");
      if (a === ptyId && b !== "outside") partners.set(b, count);
      if (b === ptyId && a !== "outside") partners.set(a, count);
    }
    const queued = this.pending.filter((item) => item.toPty === ptyId || item.fromPty === ptyId).length;
    const waits = [...this.waiting.entries()].filter(([target]) => target === ptyId).length;
    const review = [...this.reviews.values()].find((item) => item.authorPty === ptyId || item.reviewerPty === ptyId) ?? null;
    if (!partners.size && !queued && !waits && !review) return null;
    const max = this.settings().maxMessages;
    return {
      with: [...partners.keys()].map(name).filter((label): label is string => Boolean(label)),
      messages: Math.max(0, ...partners.values()),
      max,
      queued,
      held: [...partners.values()].some((count) => count >= max),
      review: review
        ? {
            role: review.authorPty === ptyId ? "author" : "reviewer",
            other: name(review.authorPty === ptyId ? review.reviewerPty : review.authorPty) ?? "",
            phase: review.phase,
            round: Math.min(review.round, review.rounds),
            rounds: review.rounds,
          }
        : null,
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
        if (!this.pending.length && !this.waiting.size && !this.reviews.size && this.timer) {
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
    for (const [key, review] of [...this.reviews]) await this.stepReview(key, review, now);
    const busy = new Set<string>();
    for (const item of [...this.pending]) {
      // Taken out while an earlier delivery was going in (Stop, or the CLI ended).
      if (!this.pending.includes(item)) continue;
      const session = this.core.live.get(item.toPty);
      if (!session || !isCodingCli(session)) {
        this.pending.splice(this.pending.indexOf(item), 1);
        item.dropped("That CLI isn't running any more.");
        continue;
      }
      if (busy.has(item.toPty) || !this.idle(item.toPty, now)) {
        busy.add(item.toPty);
        continue;
      }
      busy.add(item.toPty);
      this.pending.splice(this.pending.indexOf(item), 1);
      try {
        await this.core.options.host.send(item.toPty, item.text, item.enter);
      } catch {
        item.dropped("That CLI isn't running any more.");
        continue;
      }
      const sentAt = this.nowMs();
      this.lastSent.set(item.toPty, sentAt);
      if (item.counts && item.enter) {
        const key = pairKey(item.fromPty ?? "outside", item.toPty);
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
      if (item.waiter) this.watchAnswer(item.toPty, { ...item.waiter, sent: item.text }, sentAt, item.fromPty);
      item.delivered?.();
      this.core.emit("live");
    }
    for (const [target, list] of [...this.waiting]) for (const waiter of [...list]) await this.checkWaiter(target, waiter, now);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pump(), PUMP_MS);
    this.timer.unref?.();
  }

  /** Ready for a message: its CLI isn't working, went quiet a moment ago, and a person isn't halfway through typing. */
  private idle(ptyId: string, now = this.nowMs()): boolean {
    const session = this.core.live.get(ptyId);
    if (!session || session.working) return false;
    const quiet = Date.parse(session.quietAt ?? session.cliSince ?? session.startedAt);
    if (Number.isFinite(quiet) && now - quiet < (session.quietAt ? IDLE_MS : BOOT_MS)) return false;
    if (now - (this.lastSent.get(ptyId) ?? 0) < BETWEEN_MS) return false;
    const human = this.lastHuman.get(ptyId);
    return !human || human.sent || now - human.at >= HUMAN_DRAFT_MS;
  }

  /**
   * Waits for the answer to what was just sent to `target`: from its own log when VibeForge reads
   * that CLI's logs, else the end of its screen once it has worked and gone quiet. Past the
   * deadline the sender is told it's still going, and the answer follows as a message.
   */
  private watchAnswer(target: string, spec: WaitSpec, since: number, forwardTo: string | null = null): void {
    const session = this.core.live.get(target);
    const engine = session ? this.engineOf(session) : null;
    const watch = this.core.options.host.watchReply;
    const logKind = engine && watch ? replyLogFor(engine.id, engine.bin) : null;
    const waiter: Waiter = { ...spec, since, abort: new AbortController(), logKind, reading: false, gaveUp: false, forwardTo };
    this.waiting.set(target, [...(this.waiting.get(target) ?? []), waiter]);
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
    const answered = !session.working && quietAt > waiter.since && now - quietAt >= (waiter.logKind ? LOG_PATIENCE_MS : SETTLE_MS);
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
    if (waiter.gaveUp && now >= waiter.deadline + LATE_ANSWER_MS) this.takeWaiter(target, waiter);
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
    // The sender gave up waiting: the answer reaches it as a message instead.
    if (!waiter.forwardTo || !answered.reply?.trim()) return;
    const from = this.list().find((item) => item.ptyId === target);
    this.pending.push({
      id: randomBytes(4).toString("hex"),
      fromPty: target,
      toPty: waiter.forwardTo,
      text: messageText({ fromLabel: from?.label ?? "The other CLI", fromHandle: from?.handle ?? null, text: cleanText(answered.reply), answer: "tell", savedAt: this.saveIfLong("messages", answered.reply) }),
      enter: true,
      counts: true,
      waiter: null,
      dropped: () => undefined,
    });
    void this.pump();
  }

  private dropWaiter(target: string, waiter: Waiter, why: string): void {
    if (!this.takeWaiter(target, waiter) || waiter.gaveUp) return;
    if (waiter.dropped) waiter.dropped(why);
    else waiter.done(null);
  }

  // ---------------------------------------------------------------- files

  /** A long text goes in a file: a CLI reads a path more reliably than a paste of many screens. */
  private saveIfLong(folder: string, text: string): string | null {
    return text.length > MESSAGE_INLINE_MAX ? this.saveFile(folder, "md", text) : null;
  }

  private saveFile(folder: string, ext: string, text: string): string {
    const dir = path.join(this.core.options.dataRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = this.core.now().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
    writeFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
    try {
      const names = fs.readdirSync(dir).sort();
      for (const name of names.slice(0, Math.max(0, names.length - KEEP_FILES))) fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* tidying is best effort */
    }
    return file;
  }
}
