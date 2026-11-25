import type { DeskNotice } from "../src/shared/api.js";

// Errors nothing was there to handle: an uncaught exception or an unhandled rejection in the main
// process, or one the terminal host caught on its own. Each is logged where it happens and the app
// carries on, but whatever it was doing may be half done, so the person is told, at most once in a
// while, and Copy diagnostics carries the count.

/** At most one notice in this long; the next one carries the count so far. */
export const UNEXPECTED_NOTICE_MS = 10 * 60_000;

export class UnexpectedErrors {
  /** Since VibeForge started. */
  count = 0;
  private toldAt: number | null = null;
  private tell: ((notice: DeskNotice) => void) | null = null;
  /** One came before anyone could be told. */
  private untold = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** From now on the person hears of them; one that came before is said now. */
  attach(tell: (notice: DeskNotice) => void): void {
    this.tell = tell;
    if (this.untold) this.say();
  }

  /** One more; the caller has logged it. */
  add(): void {
    this.count += 1;
    if (this.toldAt !== null && this.now() - this.toldAt < UNEXPECTED_NOTICE_MS) return;
    this.say();
  }

  private say(): void {
    if (!this.tell) {
      this.untold = true;
      return;
    }
    this.untold = false;
    this.toldAt = this.now();
    this.tell({ id: "errors", count: this.count });
  }
}
