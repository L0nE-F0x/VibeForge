// Who draws with WebGL. A page gets a handful of WebGL contexts before Chromium starts dropping
// the oldest, so terminals share a few slots and the rest draw with xterm's DOM renderer. The
// terminals on screen come first, the most recently used of them first. A hidden terminal keeps
// its slot only until one on screen needs it, so switching back and forth doesn't rebuild them.

export interface GlUser {
  /** Start drawing with WebGL. False when that failed: it draws without. */
  attach(): boolean;
  detach(): void;
}

interface Seat {
  shown: boolean;
  used: number;
  on: boolean;
  /** WebGL failed or its context was lost here: not tried again until it is shown again. */
  resting: boolean;
}

export class WebglPool {
  private readonly seats = new Map<GlUser, Seat>();
  private clock = 0;
  private queued = false;

  constructor(
    readonly slots: number,
    // Wrapped: the browser's queueMicrotask throws when called as a method of something else.
    private readonly later: (job: () => void) => void = (job) => queueMicrotask(job),
  ) {}

  add(user: GlUser, shown: boolean): void {
    this.seats.set(user, { shown, used: ++this.clock, on: false, resting: false });
    this.schedule();
  }

  remove(user: GlUser): void {
    const seat = this.seats.get(user);
    if (!seat) return;
    this.seats.delete(user);
    if (seat.on) user.detach();
    this.schedule();
  }

  /** It came on screen or went off it. */
  show(user: GlUser, shown: boolean): void {
    const seat = this.seats.get(user);
    if (!seat || seat.shown === shown) return;
    seat.shown = shown;
    if (shown) {
      seat.used = ++this.clock;
      seat.resting = false;
    }
    this.schedule();
  }

  /** It was used (focused): first in line for a slot. */
  touch(user: GlUser): void {
    const seat = this.seats.get(user);
    if (!seat) return;
    seat.used = ++this.clock;
    if (seat.shown && !seat.on && !seat.resting) this.schedule();
  }

  /** Its WebGL context was lost and the renderer let go: the slot goes to someone else. */
  lost(user: GlUser): void {
    const seat = this.seats.get(user);
    if (!seat) return;
    seat.on = false;
    seat.resting = true;
    this.schedule();
  }

  /** Who holds a slot now, for tests. */
  holders(): GlUser[] {
    return [...this.seats].filter(([, seat]) => seat.on).map(([user]) => user);
  }

  /** Changes come in bursts (a workspace switch hides some and shows others): settle once after. */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    this.later(() => {
      this.queued = false;
      this.settle();
    });
  }

  settle(): void {
    const seats = [...this.seats];
    const waiting = seats
      .filter(([, seat]) => seat.shown && !seat.on && !seat.resting)
      .sort((a, b) => b[1].used - a[1].used);
    // Hidden holders give theirs up least recently used first.
    const hidden = seats.filter(([, seat]) => !seat.shown && seat.on).sort((a, b) => a[1].used - b[1].used);
    let free = this.slots - seats.filter(([, seat]) => seat.on).length;
    for (const [user, seat] of waiting) {
      if (free <= 0) {
        const taken = hidden.shift();
        if (!taken) break;
        taken[1].on = false;
        taken[0].detach();
        free += 1;
      }
      if (user.attach()) {
        seat.on = true;
        free -= 1;
      } else seat.resting = true;
    }
  }
}
