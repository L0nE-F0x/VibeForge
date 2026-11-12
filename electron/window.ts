import path from "node:path";
import { app, BrowserWindow, nativeImage, session, shell } from "electron";
import { PageErrors } from "../src/core/log.js";
import type { Dock } from "./dock.js";
import { isAppPage, permissionAllowed } from "./guards.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";
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

  /** Electron allows every permission unless told otherwise; see permissionAllowed. */
  guardPermissions(): void {
    const { ctx } = this;
    const allowed = (contents: Electron.WebContents | null, permission: string) => permissionAllowed(Boolean(ctx.win && contents === ctx.win.webContents), permission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
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
        if (!this.trayNoticeShown && ctx.service.getSettings().notify) {
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
    win.webContents.on("render-process-gone", (_event, details) => log.error(`The window's page stopped: ${details.reason} (exit code ${details.exitCode})`));
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") pageErrors.report(`${event.message}${event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : ""}`);
    });
    const page = ctx.page;
    if (page.devUrl) await win.loadURL(page.devUrl);
    else await win.loadFile(page.file);
  }
}
