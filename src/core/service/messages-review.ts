import { randomBytes } from "node:crypto";
import { cleanText, reviewReplyText, reviewRequestText, SETTLE_MS } from "../agent-talk.js";
import { isCodingCli } from "../checkout.js";
import type { TalkState } from "../types.js";
import { diffSince, leaveOutUntouched } from "../vcs.js";
import { patchFiles } from "../worktrees.js";
import type { ServiceCore } from "./core.js";
import type { Delivery } from "./messages-delivery.js";
import type { SavedFiles } from "./messages-files.js";
import type { Roster } from "./messages-who.js";

interface Review {
  id: string;
  authorPty: string;
  reviewerPty: string;
  round: number;
  rounds: number;
  phase: "author" | "reviewer" | "fixing";
  /** When the phase began; the author has to work and go quiet after it before the next round. */
  since: number;
  lastPatch?: string;
}

/**
 * Review with…: when the author's turn ends, the reviewer reads its changes, and the author gets
 * the review back, for as many rounds as Settings says.
 */
export class Reviews {
  private readonly reviews = new Map<string, Review>();

  constructor(
    private readonly core: ServiceCore,
    private readonly roster: Roster,
    private readonly delivery: Delivery,
    private readonly files: SavedFiles,
    /** Delivers what can go now (MessageDesk.pump). */
    private readonly pump: () => void,
  ) {}

  /** How many reviews are going. */
  get size(): number {
    return this.reviews.size;
  }

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
    const changes = Boolean((await changesOf(this.core, authorPty)).trim());
    for (const [id, review] of this.reviews) if (review.authorPty === authorPty) this.reviews.delete(id);
    this.delivery.unstop(authorPty);
    this.delivery.unstop(reviewerPty);
    const id = randomBytes(4).toString("hex");
    this.reviews.set(id, {
      id,
      authorPty,
      reviewerPty,
      round: 1,
      rounds: this.core.store.readSettings().agentTalk.reviewRounds,
      phase: "author",
      since: 0,
    });
    this.core.emit("live");
    this.pump();
    return { changes };
  }

  /** Takes each review a step on where its CLIs are ready for one. */
  async step(now: number): Promise<void> {
    for (const [key, review] of [...this.reviews]) await this.stepReview(key, review, now);
  }

  /** Stop: reviews `ptyId` is in end. */
  stop(ptyId: string): void {
    for (const [id, review] of this.reviews) if (review.authorPty === ptyId || review.reviewerPty === ptyId) this.reviews.delete(id);
  }

  /** The review `ptyId` is in, for its pane; `name` gives the other CLI's label. */
  viewFor(ptyId: string, name: (ptyId: string) => string | null): TalkState["review"] {
    const review = [...this.reviews.values()].find((item) => item.authorPty === ptyId || item.reviewerPty === ptyId) ?? null;
    if (!review) return null;
    return {
      role: review.authorPty === ptyId ? "author" : "reviewer",
      other: name(review.authorPty === ptyId ? review.reviewerPty : review.authorPty) ?? "",
      phase: review.phase,
      round: Math.min(review.round, review.rounds),
      rounds: review.rounds,
    };
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
    const patch = await changesOf(this.core, review.authorPty);
    const list = this.roster.list();
    const authorLabel = list.find((item) => item.ptyId === review.authorPty)?.label ?? "The other CLI";
    const reviewerLabel = list.find((item) => item.ptyId === review.reviewerPty)?.label ?? "The reviewer";
    if (!this.reviews.has(key)) return;
    if (!patch.trim() || patch === review.lastPatch) {
      // Nothing yet: asked before the author has changed anything, so wait for its next turn. A
      // turn that ends with nothing changed ends the review.
      if (review.since === 0) review.since = now;
      else this.reviews.delete(key);
      this.core.emit("live");
      return;
    }
    const file = this.files.savePatch(patch);
    review.lastPatch = patch;
    review.phase = "reviewer";
    this.core.emit("live");
    this.delivery.queue({
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
          review.since = this.core.now().getTime();
          this.delivery.queue({
            fromPty: null,
            toPty: review.authorPty,
            text: reviewReplyText({ reviewerLabel, reply, savedAt: this.files.saveIfLong("reviews", reply) }),
            enter: true,
            counts: false,
            waiter: null,
            delivered: () => {
              review.since = this.core.now().getTime();
            },
            dropped: () => this.reviews.delete(key),
          });
          this.core.emit("live");
          this.pump();
        },
      },
      dropped: () => this.reviews.delete(key),
    });
  }
}

/** What this CLI changed: the folder's changes since it started, less files already changed then that it hasn't touched. */
export async function changesOf(core: ServiceCore, ptyId: string): Promise<string> {
  const session = core.live.get(ptyId);
  if (!session) return "";
  const run = session.runId ? core.store.getRun(session.runId) : null;
  const cwd = run?.cwd || session.programCwd || session.cwd;
  const before = session.runId ? await core.dirtyAtStart.get(session.runId) : null;
  const patch = await diffSince(cwd, run?.gitStart ?? null).catch(() => "");
  return leaveOutUntouched(patch, cwd, before);
}
