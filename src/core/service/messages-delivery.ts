import { randomBytes } from "node:crypto";
import { HUMAN_DRAFT_MS, pairKey } from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import type { LiveSession } from "../types.js";
import type { ServiceCore } from "./core.js";
import type { Answers, WaitSpec } from "./messages-answers.js";

/** A CLI that just went quiet, or was just sent something, isn't sent the next message straight away. */
const IDLE_MS = 1500;
const BETWEEN_MS = 3000;
/** A CLI that hasn't gone quiet once since it started may still be drawing its first screen. */
const BOOT_MS = 5000;
/**
 * Escape sequences: all a terminal ever writes back on its own. Focus in/out, mouse reports (X10
 * first, its three bytes can be anything), and its answers to a CLI's questions: cursor position,
 * device attributes, colours, its name (CSI, OSC, DCS and the other string sequences, SS3 and the
 * two-byte ones). Arrows, F-keys and a bare Esc are these too, so they aren't a person stepping in;
 * a letter, Backspace or Enter is.
 */
const ESCAPES = /\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)|\x1bO[\s\S]|\x1b[ -/]*[0-~]/g;

interface Pending {
  id: string;
  fromPty: string | null;
  toPty: string;
  /** The CLI that was in front in `toPty` when it was put in line (see queue and cliIn): another one there now isn't sent it. */
  cli?: string | null;
  text: string;
  enter: boolean;
  /** Counted against the two CLIs' limit (a person's draft and review steps aren't). */
  counts: boolean;
  waiter: WaitSpec | null;
  /** It went in; `draft` when without Enter, as it was queued or because the two reached their limit while it waited. */
  delivered?: (draft: boolean) => void;
  dropped: (why: string) => void;
}

/** A message to put in line (see Delivery.queue). */
export type Outgoing = Omit<Pending, "id" | "cli">;

/**
 * Delivery: messages wait in line for their terminal and go in once its CLI is idle. Two CLIs
 * trade so many before the next waits in the prompt for a person to press Enter, and Stop holds a
 * terminal until a person types in it.
 */
export class Delivery {
  private readonly pending: Pending[] = [];
  /** Messages each two terminals have traded since a person stepped in, by pairKey ("outside" for a terminal outside VibeForge). */
  private readonly counts = new Map<string, number>();
  private readonly stopped = new Set<string>();
  private readonly lastHuman = new Map<string, { at: number; sent: boolean }>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly core: ServiceCore,
    /** Watches for the answer to a message sent with a waiter. */
    private readonly answers: Answers,
  ) {}

  private nowMs(): number {
    return this.core.now().getTime();
  }

  /** How many messages are in line. */
  get queued(): number {
    return this.pending.length;
  }

  /** Whether any two terminals have traded messages since a person stepped in. */
  get counting(): boolean {
    return this.counts.size > 0;
  }

  /** The messages in line: a saved file one names is kept. */
  texts(): string[] {
    return this.pending.map((item) => item.text);
  }

  /** Messages in line to or from `ptyId`. */
  queuedFor(ptyId: string): number {
    return this.pending.filter((item) => item.toPty === ptyId || item.fromPty === ptyId).length;
  }

  /** The terminals `ptyId` has traded messages with since a person stepped in, and how many. */
  partnersOf(ptyId: string): Map<string, number> {
    const partners = new Map<string, number>();
    for (const [key, count] of this.counts) {
      const [a, b] = key.split("|");
      if (a === ptyId && b !== "outside") partners.set(b, count);
      if (b === ptyId && a !== "outside") partners.set(a, count);
    }
    return partners;
  }

  isStopped(ptyId: string): boolean {
    return this.stopped.has(ptyId);
  }

  /** A Stop on `ptyId` is lifted (a person started a review there). */
  unstop(ptyId: string): void {
    this.stopped.delete(ptyId);
  }

  /** Stop: nothing more goes to or from this terminal until a person types in it. */
  stop(ptyId: string): void {
    this.stopped.add(ptyId);
    this.forget(ptyId);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i];
      if (item.toPty !== ptyId && item.fromPty !== ptyId) continue;
      this.pending.splice(i, 1);
      item.dropped("A person stopped this conversation.");
    }
  }

  /** A person typed `typed` (see typedIn) into a terminal: its counts start again, and a Stop on it is lifted. True when either changed. */
  personTyped(ptyId: string, typed: string): boolean {
    this.lastHuman.set(ptyId, { at: this.nowMs(), sent: /[\r\n]/.test(typed) });
    const lifted = this.stopped.delete(ptyId);
    return this.forget(ptyId) || lifted;
  }

  /** `ptyId`'s counts start again. True when it had any. */
  private forget(ptyId: string): boolean {
    let changed = false;
    for (const key of [...this.counts.keys()]) {
      if (key.split("|").includes(ptyId)) {
        this.counts.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Put a message in line for `toPty`, meant for the CLI in front there now. */
  queue(item: Outgoing): void {
    const session = this.core.live.get(item.toPty);
    this.pending.push({ ...item, id: randomBytes(4).toString("hex"), cli: session ? cliIn(session) : null });
  }

  /** The two CLIs have traded as many messages as Settings allows without a person stepping in. */
  atLimit(fromPty: string | null, toPty: string): boolean {
    return fromPty !== null && (this.counts.get(pairKey(fromPty, toPty)) ?? 0) >= this.core.store.readSettings().agentTalk.maxMessages;
  }

  /** Ready for a message: its CLI isn't working, went quiet a moment ago, and a person isn't halfway through typing. */
  idle(ptyId: string, now = this.nowMs()): boolean {
    const session = this.core.live.get(ptyId);
    if (!session || session.working) return false;
    const quiet = Date.parse(session.quietAt ?? session.cliSince ?? session.startedAt);
    if (Number.isFinite(quiet) && now - quiet < (session.quietAt ? IDLE_MS : BOOT_MS)) return false;
    if (now - (this.lastSent.get(ptyId) ?? 0) < BETWEEN_MS) return false;
    const human = this.lastHuman.get(ptyId);
    return !human || human.sent || now - human.at >= HUMAN_DRAFT_MS;
  }

  /** Pastes what can go now: one message for each terminal whose CLI is idle, the rest wait their turn. */
  async deliver(now: number): Promise<void> {
    const busy = new Set<string>();
    for (const item of [...this.pending]) {
      // Taken out while an earlier delivery was going in (Stop, or the CLI ended).
      if (!this.pending.includes(item)) continue;
      const session = this.core.live.get(item.toPty);
      // Gone, or the terminal now runs another CLI than the one it was meant for (back at its shell and into a new one).
      if (!session || !isCodingCli(session) || (item.cli != null && cliIn(session) !== item.cli)) {
        this.pending.splice(this.pending.indexOf(item), 1);
        item.dropped("That CLI isn't running any more.");
        continue;
      }
      // Stopped since it was put in line: nothing goes to or from that terminal until a person types there.
      if (this.stopped.has(item.toPty) || (item.fromPty && this.stopped.has(item.fromPty))) {
        this.pending.splice(this.pending.indexOf(item), 1);
        item.dropped("A person stopped this conversation.");
        continue;
      }
      if (busy.has(item.toPty) || !this.idle(item.toPty, now)) {
        busy.add(item.toPty);
        continue;
      }
      busy.add(item.toPty);
      this.pending.splice(this.pending.indexOf(item), 1);
      // The limit is checked again now: messages queued while the CLI was busy all passed it then.
      const enter = item.enter && !(item.counts && this.atLimit(item.fromPty, item.toPty));
      try {
        await this.core.options.host.send(item.toPty, item.text, enter);
      } catch {
        item.dropped("That CLI isn't running any more.");
        continue;
      }
      const sentAt = this.nowMs();
      this.lastSent.set(item.toPty, sentAt);
      if (item.counts && enter) {
        const key = pairKey(item.fromPty ?? "outside", item.toPty);
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
      // A draft waits for a person, so there's no answer to watch for.
      if (item.waiter && enter) this.answers.watchAnswer(item.toPty, { ...item.waiter, sent: item.text }, sentAt, item.fromPty);
      item.delivered?.(!enter);
      this.core.emit("live");
    }
  }
}

/**
 * What a person typed: `data` less what a terminal reports on its own. A terminal reports focus
 * and the mouse as input too (Claude Code asks for focus events), and answers what a CLI asks it
 * (where the cursor is, what it can do): clicking a pane, or a CLI drawing its screen, isn't a
 * person stepping into the conversation. Empty when that's all it was.
 */
export function typedIn(data: string): string {
  return data.replace(ESCAPES, "").replace(/\x1b/g, "");
}

/**
 * Which CLI is in front in a terminal: a run is its own CLI; in a shell, the coding CLI typed into
 * it and when it started, so one that quit and another (or a new one) started there tells apart.
 */
function cliIn(session: LiveSession): string {
  return session.kind === "run" ? `run|${session.startedAt}` : `${session.programEngineId ?? ""}|${session.cliSince ?? ""}`;
}
