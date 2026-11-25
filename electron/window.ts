import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, session, shell } from "electron";
import { PageErrors } from "../src/core/log.js";
import type { Dock } from "./dock.js";
import { guardSession, guardWebContents, isAppPage, relaunchArgs } from "./guards.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";
import { PageRecovery } from "./page-recovery.js";
import type { Quit } from "./quit.js";
import type { TrayController } from "./tray-controller.js";

// VibeForge's one window: what its page may do, where it may go, and what closing it does (hide it
// in the tray, ask about running terminals, or quit).

export class MainWindow {
  /** The first close that keeps VibeForge in the tray says so; later ones don't. */
  private trayNoticeShown = false;

  constructor(
    private readonly ctx: MainContext,
    private readonly parts: {
      /** Started by the login autostart entry: stay in the tray until opened. */
      startHidden: boolean;
      tray: TrayController;
      quit: Pick<Quit, "ask">;
      notify: Notify;
      dock: Pick<Dock, "dispose">;
    },
  ) {}

  /** Electron allows every permission unless told otherwise; see guardSession. */
  guardPermissions(): void {
    const { ctx } = this;
    guardSession(session.defaultSession, (contents) => Boolean(ctx.win && contents === ctx.win.webContents));
  }

  async create(): Promise<void> {
    const { ctx } = this;
    const { log, words } = ctx;
    const { startHidden, tray, quit, notify, dock } = this.parts;
    const icon = nativeImage.createFromPath(ctx.iconPath);
    const win = new BrowserWindow({
      width: 1480,
      height: 920,
      // A tiling window manager will give this window whatever slice is left. These floors stay
      // under a quarter of a laptop screen so the page actually becomes that size. The desk then
      // pans sideways (see --screen-floor) instead of drawing past the edge of the tile.
      minWidth: 280,
      minHeight: 220,
      title: "VibeForge",
      backgroundColor: ctx.palette.background,
      icon: icon.isEmpty() ? undefined : icon,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ctx.appRoot, "dist-electron", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    ctx.win = win;
    guardWebContents(win.webContents);
    win.once("ready-to-show", () => {
      if (!(startHidden && ctx.service?.getSettings().tray)) {
        ctx.win?.show();
        return;
      }
      // From the login autostart entry, the window waits in the tray, once something hosts one.
      void tray.waitForHost(10_000).then((found) => {
        if (found) return;
        log.info("Started hidden, but nothing hosts the tray; showing the window");
        ctx.win?.show();
      });
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    // The window shows VibeForge's page and nothing else: a link or a script that points it at another
    // page, a file:// one included, is refused, and web links open in the browser instead.
    win.webContents.on("will-navigate", (event, url) => {
      if (isAppPage(url, ctx.page)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    // Frames inside the page too (it has none of its own).
    win.webContents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame || isAppPage(event.url, ctx.page)) return;
      event.preventDefault();
    });
    win.on("close", (event) => {
      if (ctx.quitting || !ctx.service) return;
      if (tray.icon.shown && tray.host && ctx.service.getSettings().tray && ctx.service.getSettings().closeToTray) {
        event.preventDefault();
        ctx.win?.hide();
        // A call goes on with the window closed: said each time, as the microphone is still open.
        if (tray.calling && ctx.service.getSettings().notify) notify({ title: words.say("main.callStillOn"), body: words.say("main.callStillOnBody") });
        else if (!this.trayNoticeShown && ctx.service.getSettings().notify) {
          this.trayNoticeShown = true;
          notify({ title: words.say("main.stillRunning"), body: words.say("main.stillRunningBody") });
        }
        return;
      }
      const live = ctx.service.listLive();
      if (live.length === 0) return;
      // The window stays while the question is up; a yes quits, which closes it.
      event.preventDefault();
      void quit.ask(live).then((yes) => {
        if (!yes) return;
        ctx.quitting = true;
        app.quit();
      });
    });
    const pageErrors = new PageErrors((line) => log.warn(`Page error: ${line}`));
    win.on("closed", () => {
      // First, so nothing goes on talking to a window that is gone if what follows throws.
      ctx.win = null;
      pageErrors.flush();
      try {
        dock.dispose();
      } catch (error) {
        log.warn(`Could not close the browser dock's pages: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.recoverPage(win);
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") pageErrors.report(`${event.message}${event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : ""}`);
    });
    const page = ctx.page;
    if (page.devUrl) await win.loadURL(page.devUrl);
    else await win.loadFile(page.file);
  }

  /**
   * A page that stops is reloaded, up to PAGE_RELOADS times in five minutes; the terminals go on
   * meanwhile and each pane re-attaches when the page is back. Past that, the person chooses. A page
   * that hangs gets Reload offered, which ends the hung page and so takes the same way back.
   */
  private recoverPage(win: BrowserWindow): void {
    const { ctx } = this;
    const { log, words } = ctx;
    const recovery = new PageRecovery();
    /** The question about a hung page, while it is up. */
    let hung: AbortController | null = null;
    // Notices wait for the page that loads next.
    win.webContents.on("did-start-loading", () => ctx.pageGone());
    win.webContents.on("render-process-gone", (_event, details) => {
      log.error(`The window's page stopped: ${details.reason} (exit code ${details.exitCode})`);
      ctx.pageGone();
      hung?.abort();
      if (ctx.quitting || win.isDestroyed()) return;
      const step = recovery.gone(details.reason);
      if (step === "ignore") return;
      if (step === "reload") {
        log.info("Reloading the window's page; the terminals go on running");
        ctx.notice({ id: "window-reloaded", reason: details.reason });
        win.webContents.reload();
        return;
      }
      log.warn("The window's page keeps stopping; asking before reloading again");
      const options: Electron.MessageBoxOptions = {
        type: "error",
        title: "VibeForge",
        message: words.say("main.windowKeepsStopping"),
        detail: words.say("main.windowKeepsStoppingBody"),
        buttons: [words.say("main.windowReload"), words.say("main.windowRestart")],
        defaultId: 0,
        cancelId: 0,
      };
      void dialog.showMessageBox(win, options).then(({ response }) => {
        if (win.isDestroyed() || ctx.quitting) return;
        if (response === 1) {
          log.info("Restarting, after the window's page kept stopping");
          app.relaunch({ execPath: process.execPath, args: relaunchArgs(process.argv) });
          ctx.quitting = true;
          app.quit();
          return;
        }
        ctx.notice({ id: "window-reloaded", reason: details.reason });
        win.webContents.reload();
      });
    });
    win.on("unresponsive", () => {
      if (hung || ctx.quitting) return;
      log.warn("The window's page is not responding");
      const asking = new AbortController();
      hung = asking;
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: "VibeForge",
        message: words.say("main.windowHung"),
        detail: words.say("main.windowHungBody"),
        buttons: [words.say("main.windowReload"), words.say("main.windowWait")],
        defaultId: 1,
        cancelId: 1,
        signal: asking.signal,
      };
      void dialog.showMessageBox(win, options).then(({ response }) => {
        if (hung === asking) hung = null;
        // Ending the hung page is what lets it reload: render-process-gone above does that.
        if (response === 0 && !asking.signal.aborted && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer();
      });
    });
    win.on("responsive", () => {
      if (!hung) return;
      log.info("The window's page is responding again");
      hung.abort();
      hung = null;
    });
  }
}
