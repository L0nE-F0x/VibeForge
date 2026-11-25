import { CrashCount } from "./host-lifecycle.js";

// The window's page can stop on its own (a renderer crash, out of memory, killed) while every
// terminal, run and routine goes on in the main process and the terminal host. Reloading the page
// brings the window back without touching them: each pane re-attaches to its terminal by snapshot.
// A page that keeps stopping is not reloaded for ever; the person is asked instead.

/** Reloads allowed within five minutes before asking. */
export const PAGE_RELOADS = 3;

/** What to do when the page has gone: nothing (it closed normally), reload it, or ask. */
export type PageGoneStep = "ignore" | "reload" | "ask";

export class PageRecovery {
  private readonly crashes = new CrashCount();

  /** `reason` is Electron's render-process-gone reason. */
  gone(reason: string, now = Date.now()): PageGoneStep {
    if (reason === "clean-exit") return "ignore";
    return this.crashes.add(now) <= PAGE_RELOADS ? "reload" : "ask";
  }
}
