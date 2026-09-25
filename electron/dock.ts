import { shell, WebContentsView, type BrowserWindow } from "electron";
import type { DockBounds, DockState } from "../src/shared/api.js";

/** The browser dock: a sandboxed web view laid over a placeholder the renderer positions. */
export class Dock {
  private view: WebContentsView | null = null;
  private current = "";
  private error: string | null = null;

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly emit: (state: DockState) => void,
  ) {}

  private ensure(): WebContentsView | null {
    const win = this.window();
    if (!win) return null;
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    view.setBackgroundColor("#00000000");
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const update = () => this.publish();
    contents.on("did-start-loading", () => {
      this.error = null;
      update();
    });
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", update);
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.error = `${description || "Could not load"} (${url})`;
      update();
    });
    contents.on("render-process-gone", () => {
      this.error = "The page crashed. Reload to try again.";
      update();
    });
    win.contentView.addChildView(view);
    view.setVisible(false);
    this.view = view;
    return view;
  }

  private publish(): void {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    this.emit({
      url: contents.getURL() || this.current,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: this.error,
    });
  }

  show(bounds: DockBounds, url: string): void {
    const view = this.ensure();
    if (!view) return;
    if (bounds.width < 8 || bounds.height < 8) {
      view.setVisible(false);
      return;
    }
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
    const target = url.trim();
    if (target && target !== this.current) {
      this.current = target;
      this.error = null;
      view.webContents.loadURL(target).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/ERR_ABORTED/.test(message)) {
          this.error = message.replace(/^Error invoking remote method[^:]*: /, "");
          this.publish();
        }
      });
    }
    this.publish();
  }

  hide(): void {
    this.view?.setVisible(false);
  }

  command(command: "back" | "forward" | "reload" | "stop" | "devtools"): void {
    const contents = this.view?.webContents;
    if (!contents) return;
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === "reload") {
      this.error = null;
      if (contents.getURL()) contents.reload();
      else if (this.current) void contents.loadURL(this.current).catch(() => undefined);
    } else if (command === "stop") contents.stop();
    else if (command === "devtools") contents.openDevTools({ mode: "detach" });
  }

  dispose(): void {
    this.view = null;
    this.current = "";
  }
}
