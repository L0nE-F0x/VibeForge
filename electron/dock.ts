import { WebContentsView, type BrowserWindow, type WebContents } from "electron";
import type { DockBounds, DockState } from "../src/shared/api.js";
import { isDockUrl } from "../src/shared/dock-url.js";

/** Wait before writing an in-page move, so a run of them stores the last address. */
const SAVE_MS = 400;

interface Slot {
  view: WebContentsView;
  /** Last http(s) address the page reached, or the one just asked for. */
  current: string;
  /**
   * Last address the panel asked to show. A redirect does not change it, so a later show of that
   * same address (a resize, while the saved URL catches up) does not reload the pre-redirect page.
   */
  lastShow: string;
  error: string | null;
  /** Bumped on every load we start. Events from an older load are ignored. */
  epoch: number;
  /** The epoch whose `did-start-loading` has been seen. */
  loadingEpoch: number;
  /** False until the load we asked for commits. Until then getURL() can still be the previous page. */
  committed: boolean;
  dead: boolean;
  /** The address was cleared. Later moves in the hidden page must not write it back. */
  quiet: boolean;
}

function httpUrl(contents: WebContents): string {
  if (contents.isDestroyed()) return "";
  try {
    const url = contents.getURL();
    return isDockUrl(url) ? url : "";
  } catch {
    return "";
  }
}

/** The browser dock: one sandboxed page per workspace, laid over a placeholder the renderer positions. */
export class Dock {
  private readonly slots = new Map<string, Slot>();
  private readonly saves = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>();
  /** The workspace the panel is showing, even while its page is hidden behind a card or a menu. */
  private activeId: string | null = null;

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly emit: (state: DockState) => void,
    /** Stores the address for the workspace that owns the view. */
    private readonly onAddress: (workspaceId: string, url: string) => void,
  ) {}

  private ensure(workspaceId: string): Slot | null {
    const existing = this.slots.get(workspaceId);
    if (existing && !existing.dead) return existing;
    const win = this.window();
    if (!win || win.isDestroyed()) return null;
    // No partition: the view uses the default session, so the window's permission rule applies
    // and a sign-in in one workspace is there in the others.
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    view.setBackgroundColor("#00000000");
    const slot: Slot = { view, current: "", lastShow: "", error: null, epoch: 0, loadingEpoch: 0, committed: false, dead: false, quiet: false };
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      // A cleared page stays cleared. Otherwise a link that asks for a new window stays here.
      if (!slot.quiet && isDockUrl(url)) this.navigate(slot, workspaceId, url, false);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      // A cleared page should not wander off and write itself back. about:blank is the view's start.
      if (slot.quiet || (!isDockUrl(url) && url !== "about:blank")) event.preventDefault();
    });
    contents.on("did-start-loading", () => {
      if (slot.dead) return;
      slot.loadingEpoch = slot.epoch;
      slot.error = null;
      this.publish(workspaceId);
    });
    contents.on("did-stop-loading", () => {
      if (slot.dead) return;
      this.onCommit(slot, workspaceId);
      if (!slot.quiet && slot.epoch > 0 && slot.loadingEpoch === slot.epoch) this.flush(workspaceId);
    });
    contents.on("did-navigate", () => this.onCommit(slot, workspaceId));
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) this.onCommit(slot, workspaceId);
    });
    contents.on("page-title-updated", () => {
      if (!slot.dead) this.publish(workspaceId);
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (slot.dead || !isMainFrame || code === -3) return;
      if (slot.epoch === 0 || slot.loadingEpoch !== slot.epoch) return;
      slot.error = `${description || "Could not load"} (${url})`;
      this.publish(workspaceId);
    });
    contents.on("render-process-gone", () => {
      if (slot.dead) return;
      slot.error = "The page crashed. Reload to try again.";
      this.publish(workspaceId);
    });
    win.contentView.addChildView(view);
    view.setVisible(false);
    this.slots.set(workspaceId, slot);
    return slot;
  }

  /** A load we started has committed on the main frame. Older loads are ignored. */
  private onCommit(slot: Slot, workspaceId: string): void {
    if (slot.dead || slot.quiet || slot.epoch === 0 || slot.loadingEpoch !== slot.epoch) return;
    const contents = slot.view.webContents;
    if (contents.isDestroyed()) return;
    const page = httpUrl(contents);
    if (page) {
      slot.current = page;
      slot.committed = true;
      this.remember(workspaceId, page);
    }
    this.publish(workspaceId);
  }

  private publish(workspaceId: string): void {
    const slot = this.slots.get(workspaceId);
    if (!slot || slot.dead) return;
    const contents = slot.view.webContents;
    if (contents.isDestroyed()) return;
    const page = httpUrl(contents);
    let title = "";
    let loading = false;
    let canGoBack = false;
    let canGoForward = false;
    try {
      title = contents.getTitle();
      loading = contents.isLoading();
      canGoBack = contents.navigationHistory.canGoBack();
      canGoForward = contents.navigationHistory.canGoForward();
    } catch {
      return;
    }
    this.emit({
      workspaceId,
      // Before the load commits, getURL() can still be the previous page. Report what we asked for.
      // A cleared address reports nothing, so the bar does not fill itself back in.
      url: slot.quiet ? "" : (slot.committed && page ? page : slot.current),
      title,
      loading,
      canGoBack,
      canGoForward,
      error: slot.error,
    });
  }

  private navigate(slot: Slot, workspaceId: string, target: string, fromPanel: boolean): void {
    if (slot.dead || !isDockUrl(target)) return;
    const epoch = ++slot.epoch;
    slot.quiet = false;
    slot.committed = false;
    slot.current = target;
    slot.error = null;
    if (fromPanel) slot.lastShow = target;
    this.remember(workspaceId, target);
    // The address the panel asked for is stored now. A redirect that follows replaces it.
    if (fromPanel) this.flush(workspaceId);
    slot.view.webContents.loadURL(target).catch((error: unknown) => {
      if (slot.dead || slot.epoch !== epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/ERR_ABORTED/.test(message)) return;
      slot.error = message.replace(/^Error invoking remote method[^:]*: /, "");
      this.publish(workspaceId);
    });
  }

  /** Drop a waiting save and ignore later moves. The address was cleared on purpose. */
  private quiet(workspaceId: string): void {
    const pending = this.saves.get(workspaceId);
    if (pending) {
      clearTimeout(pending.timer);
      this.saves.delete(workspaceId);
    }
    const slot = this.slots.get(workspaceId);
    if (slot) slot.quiet = true;
  }

  /** Remember the latest address for a workspace, and write it once the moves settle. */
  private remember(workspaceId: string, url: string): void {
    if (!isDockUrl(url)) return;
    const pending = this.saves.get(workspaceId);
    if (pending?.url === url) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.saves.delete(workspaceId);
      this.onAddress(workspaceId, url);
    }, SAVE_MS);
    this.saves.set(workspaceId, { url, timer });
  }

  /** Write any address still waiting. A workspace switch or a quit should not drop the last page. */
  private flush(workspaceId?: string): void {
    const ids = workspaceId ? [workspaceId] : [...this.saves.keys()];
    for (const id of ids) {
      const pending = this.saves.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.saves.delete(id);
      this.onAddress(id, pending.url);
    }
  }

  show(bounds: DockBounds, url: string, workspaceId: string): void {
    if (!workspaceId) return;
    if (this.activeId && this.activeId !== workspaceId) this.flush(this.activeId);
    this.activeId = workspaceId;
    for (const [id, slot] of this.slots) {
      if (id !== workspaceId && !slot.view.webContents.isDestroyed()) slot.view.setVisible(false);
    }
    const target = url.trim();
    const tooSmall = bounds.width < 8 || bounds.height < 8;
    if (!isDockUrl(target)) this.quiet(workspaceId);
    if (!isDockUrl(target) || tooSmall) {
      const slot = this.slots.get(workspaceId);
      if (slot && !slot.view.webContents.isDestroyed()) slot.view.setVisible(false);
      if (slot) this.publish(workspaceId);
      return;
    }
    const slot = this.ensure(workspaceId);
    if (!slot) return;
    slot.quiet = false;
    slot.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    slot.view.setVisible(true);
    if (target !== slot.current && target !== slot.lastShow) this.navigate(slot, workspaceId, target, true);
    else slot.lastShow = target;
    this.publish(workspaceId);
  }

  hide(workspaceId?: string): void {
    if (this.activeId) this.flush(this.activeId);
    for (const slot of this.slots.values()) {
      if (!slot.view.webContents.isDestroyed()) slot.view.setVisible(false);
    }
    // No id means the panel is gone (Files, or Code isn't showing). An id keeps reload pointed here.
    this.activeId = workspaceId ?? null;
  }

  /**
   * A still of the page, which the renderer shows while a menu or dialog covers the view. A JPEG
   * data URL, because the app's Content-Security-Policy allows data: images but not blob: ones.
   */
  async capture(): Promise<string | null> {
    const slot = this.activeId ? this.slots.get(this.activeId) : undefined;
    if (!slot || slot.dead || !slot.view.getVisible() || slot.view.webContents.isDestroyed()) return null;
    try {
      const image = await slot.view.webContents.capturePage();
      return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(90).toString("base64")}`;
    } catch {
      return null;
    }
  }

  command(command: "back" | "forward" | "reload" | "stop" | "devtools"): void {
    const slot = this.activeId ? this.slots.get(this.activeId) : undefined;
    const workspaceId = this.activeId;
    if (!slot || !workspaceId || slot.dead || slot.view.webContents.isDestroyed()) return;
    const contents = slot.view.webContents;
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === "reload") {
      slot.error = null;
      if (httpUrl(contents)) contents.reload();
      else if (slot.current) this.navigate(slot, workspaceId, slot.current, false);
      this.publish(workspaceId);
    } else if (command === "stop") contents.stop();
    else if (command === "devtools") contents.openDevTools({ mode: "detach" });
  }

  /** The workspace is gone. Drop its page so the next one cannot show it. */
  release(workspaceId: string): void {
    if (!workspaceId) return;
    const slot = this.slots.get(workspaceId);
    if (slot) slot.dead = true;
    this.flush(workspaceId);
    if (!slot) {
      if (this.activeId === workspaceId) this.activeId = null;
      return;
    }
    this.slots.delete(workspaceId);
    if (this.activeId === workspaceId) this.activeId = null;
    this.destroy(slot);
  }

  private destroy(slot: Slot): void {
    const win = this.window();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(slot.view);
      } catch {
        // The window is already tearing the view down.
      }
    }
    const contents = slot.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      contents.close({ waitForBeforeUnload: false });
    } catch {
      // Already closing.
    }
  }

  dispose(): void {
    for (const id of [...this.slots.keys()]) this.release(id);
    this.flush();
    this.activeId = null;
  }
}
