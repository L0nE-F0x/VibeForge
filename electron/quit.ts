import { app, dialog, powerMonitor } from "electron";
import { describeError } from "../src/core/log.js";
import { stopCompanion } from "./companion.js";
import { oneAtATime, settleWithin } from "./guards.js";
import type { MainContext } from "./main-context.js";
import type { Voice } from "./voice.js";

// Ways out: the question about running terminals, Quit in the tray, the shutdown every quit runs
// through, and the exit when start fails.

/** How long a quit waits for the phone page's server to close before going on without it. */
const COMPANION_STOP_MS = 2000;
/** How long a quit waits for sync's Syncthing to end (it is asked, then told, then killed). */
const SYNC_STOP_MS = 12_000;
/** How long a quit waits for deletes that just became final to tidy up after themselves in git. */
const CLOSE_WAIT_MS = 3000;

export class Quit {
  private shutdownDone = false;
  /** The shutdown under way: a second quit (Quit again, a SIGTERM) waits for it rather than starting another. */
  private shuttingDown: Promise<void> | null = null;

  constructor(
    private readonly ctx: MainContext,
    private readonly parts: { voice: Pick<Voice, "dispose">; sync?: { stop(): Promise<void> } },
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

  /**
   * The phone page, Syncthing and the terminals stop side by side, so a Syncthing slow to end no
   * longer holds up the terminals writing their files; the core closes once all three are done.
   */
  private async shutdown(): Promise<void> {
    const { ctx } = this;
    const { log } = ctx;
    const phone = settleWithin(stopCompanion(), COMPANION_STOP_MS, (error) => log.warn(`The phone page did not stop cleanly: ${describeError(error)}`)).then((stopped) => {
      if (!stopped) log.warn("The phone page did not stop in time; quitting without waiting for it");
    });
    const sync = this.parts.sync
      ? settleWithin(this.parts.sync.stop(), SYNC_STOP_MS, (error) => log.warn(`Sync did not stop cleanly: ${describeError(error)}`)).then((ended) => {
          if (!ended) log.warn("Sync did not stop in time; quitting without waiting for it");
        })
      : Promise.resolve();
    this.parts.voice.dispose();
    await Promise.all([phone, sync, this.stopTerminals()]);
    if (!ctx.service) return;
    ctx.service.shutdown();
    // A task deleted moments ago still has its copy's branch to drop: give git a moment for it.
    await Promise.race([ctx.service.close(), new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))]);
    // A Local AI server still ending is told once more on the way out, without waiting.
    ctx.service.disposeLocalServer();
    ctx.service = null;
  }

  /** Every terminal ends and writes its run files, and the core waits for what it records about them. */
  private async stopTerminals(): Promise<void> {
    const { ctx } = this;
    const service = ctx.service;
    if (!service) return;
    service.prepareShutdown();
    await ctx.supervisor.shutdown(7000);
    await Promise.race([service.whenIdle(), new Promise((resolve) => setTimeout(resolve, 4000))]);
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

  /**
   * Another VibeForge holds this copy's config or data folder (core/folder-lock.ts): say which, and
   * exit before anything is started. Nothing of the other copy's is touched.
   */
  async folderInUse(folder: string): Promise<void> {
    const { log, words } = this.ctx;
    log.warn(`Another VibeForge is using ${folder}; this copy is not starting`);
    try {
      // Settings belong to the other copy: the desktop's language, then.
      await words.use("system", app.getLocale());
    } catch {
      /* English, then */
    }
    const title = words.say("main.folderInUse", { folder });
    const body = words.say("main.folderInUseBody");
    // Said where it was started from too, for a copy started from a terminal or a script.
    console.error(`${title}\n${body}`);
    // A window-less copy (--ozone-platform=headless, as the smoke test runs) can't show a dialog: Chromium stops on one.
    if (app.commandLine.getSwitchValue("ozone-platform") !== "headless") dialog.showErrorBox(title, body);
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

    // A reboot or shutdown: the system is asked to wait (logind's delay, a few seconds) while
    // VibeForge quits the usual way, so every terminal's run files are written first.
    // powerMonitor can only be used once Electron is ready.
    void app.whenReady().then(() =>
      // Electron hands the listener an event to prevent, though its types say no argument.
      powerMonitor.on("shutdown", ((event?: { preventDefault(): void }) => {
        event?.preventDefault();
        this.ctx.log.info("The system is shutting down; quitting so the terminals' files are written first");
        this.ctx.quitting = true;
        app.quit();
      }) as () => void),
    );
  }
}
