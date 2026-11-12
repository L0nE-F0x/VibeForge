import { app, dialog } from "electron";
import { describeError } from "../src/core/log.js";
import { stopCompanion } from "./companion.js";
import { oneAtATime, settleWithin } from "./guards.js";
import type { MainContext } from "./main-context.js";
import type { Talk } from "./talk.js";
import type { Voice } from "./voice.js";

// Ways out: the question about running terminals, Quit in the tray, the shutdown every quit runs
// through, and the exit when start fails.

/** How long a quit waits for the phone page's server to close before going on without it. */
const COMPANION_STOP_MS = 2000;

export class Quit {
  private shutdownDone = false;
  /** The shutdown under way: a second quit (Quit again, a SIGTERM) waits for it rather than starting another. */
  private shuttingDown: Promise<void> | null = null;

  constructor(
    private readonly ctx: MainContext,
    private readonly parts: { talk: Pick<Talk, "dispose">; voice: Pick<Voice, "dispose"> },
  ) {}

  /**
   * Asks whether to quit with terminals still running; true to quit. Never the blocking kind of
   * dialog: while one held the main process, terminal output backed up and every CLI stalled.
   * While the question is on screen, a second close or Quit joins it instead of asking again.
   */
  readonly ask = oneAtATime((live: Array<{ kind: string }>): Promise<boolean> => {
    const { words, win } = this.ctx;
    const runs = live.filter((session) => session.kind === "run").length;
    const options: Electron.MessageBoxOptions = {
      type: "question",
      buttons: [words.say("main.quitStop"), words.say("main.quitKeep")],
      defaultId: 1,
      cancelId: 1,
      title: "VibeForge",
      message: words.count("main.quit", live.length),
      detail: words.say(runs ? "main.quitRuns" : "main.quitCloses"),
    };
    return (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(({ response }) => response === 0);
  });

  /** Quit from the tray menu; running terminals are asked about first, as when closing the window. */
  async fromTray(): Promise<void> {
    const { ctx } = this;
    const live = ctx.service?.listLive() ?? [];
    if (live.length && ctx.win) {
      ctx.focusWindow();
      if (!(await this.ask(live))) return;
    }
    ctx.quitting = true;
    app.quit();
  }

  private async shutdown(): Promise<void> {
    const { ctx } = this;
    const { log } = ctx;
    const stopped = await settleWithin(stopCompanion(), COMPANION_STOP_MS, (error) => log.warn(`The phone page did not stop cleanly: ${describeError(error)}`));
    if (!stopped) log.warn("The phone page did not stop in time; quitting without waiting for it");
    this.parts.talk.dispose();
    this.parts.voice.dispose();
    if (!ctx.service) return;
    ctx.service.prepareShutdown();
    await ctx.supervisor.shutdown(7000);
    await Promise.race([ctx.service.whenIdle(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    ctx.service.shutdown();
    ctx.service.close();
    ctx.service = null;
  }

  /**
   * Start failed: say why and where the log is, then exit. Staying on with no window and no tray
   * would keep the single-instance lock, and every later launch would quietly do nothing.
   */
  async startFailed(error: unknown): Promise<void> {
    const { log, words } = this.ctx;
    console.error(error);
    const detail = describeError(error);
    log.error(`VibeForge could not start: ${detail}`);
    try {
      await words.use(this.ctx.service?.getSettings().language ?? "system", app.getLocale());
    } catch {
      /* English, then */
    }
    dialog.showErrorBox(words.say("main.startFailed"), words.say("main.startFailedBody", { error: detail.split("\n")[0], log: log.file }));
    app.exit(1);
  }

  /** Every quit sets the flag, then waits for the shutdown before Electron goes. */
  handleEvents(): void {
    app.on("before-quit", () => {
      this.ctx.quitting = true;
    });

    app.on("will-quit", (event) => {
      if (this.shutdownDone) return;
      event.preventDefault();
      // Already on its way: the one under way quits when it is done.
      if (this.shuttingDown) return;
      this.shuttingDown = this.shutdown().finally(() => {
        this.shutdownDone = true;
        // On the next turn: with no terminal host to wait for, shutdown settles while Electron is
        // still inside this event, where a quit is ignored and the app would stay on, windowless.
        setImmediate(() => app.quit());
      });
    });

    app.on("window-all-closed", () => app.quit());
  }
}
