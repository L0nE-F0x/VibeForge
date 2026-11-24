import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DockState } from "../../src/shared/api.js";

// No Electron here: the dock gets stand-in views through its constructor.
vi.mock("electron", () => ({ WebContentsView: class {} }));

const { Dock } = await import("../../electron/dock.js");

function makeFakeSession() {
  const handlers: {
    request?: (contents: unknown, permission: string, callback: (allow: boolean) => void) => void;
    check?: (contents: unknown, permission: string, origin: string) => boolean;
    device?: () => boolean;
    display?: (request: unknown, callback: (streams: unknown) => void) => void;
  } = {};
  const emitter = new EventEmitter();
  return {
    emitter,
    handlers,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    },
    setPermissionRequestHandler: (fn: typeof handlers.request) => {
      handlers.request = fn;
    },
    setPermissionCheckHandler: (fn: typeof handlers.check) => {
      handlers.check = fn;
    },
    setDevicePermissionHandler: (fn: typeof handlers.device) => {
      handlers.device = fn;
    },
    setDisplayMediaRequestHandler: (fn: typeof handlers.display) => {
      handlers.display = fn;
    },
  };
}

const sharedDockSession = makeFakeSession();

/** A page as Electron 45 has it: once destroyed, its view's `webContents` reads as undefined. */
class FakeContents extends EventEmitter {
  destroyed = false;
  url = "about:blank";
  loads: string[] = [];
  session = sharedDockSession;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined };
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getTitle = () => "";
  isLoading = () => false;
  setWindowOpenHandler = () => undefined;
  reload = () => undefined;
  stop = () => undefined;
  isDevToolsOpened = () => false;
  closeDevTools = () => undefined;
  capturePage = async () => ({ isEmpty: () => true });
  loadURL = async (url: string) => {
    this.loads.push(url);
    this.url = url;
  };
  close = () => this.destroy();
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView {
  visible = false;
  readonly page = new FakeContents();
  /** Electron hands back undefined for a destroyed page's contents. */
  get webContents() {
    return this.page.destroyed ? undefined : this.page;
  }
  setBackgroundColor = () => undefined;
  setBounds = () => undefined;
  setVisible = (visible: boolean) => {
    this.visible = visible;
  };
  getVisible = () => this.visible;
}

function setup() {
  const views: FakeView[] = [];
  const states: DockState[] = [];
  const children = new Set<FakeView>();
  const win = {
    isDestroyed: () => false,
    contentView: { addChildView: (view: FakeView) => children.add(view), removeChildView: (view: FakeView) => children.delete(view) },
  };
  const dock = new Dock(
    () => win as never,
    (state) => states.push(state),
    () => undefined,
    () => {
      const view = new FakeView();
      views.push(view);
      return view as never;
    },
  );
  return { dock, views, states, children };
}

const bounds = { x: 0, y: 0, width: 800, height: 600 };

describe("the browser dock", () => {
  it("makes a fresh page after one closes itself, instead of failing until a restart", () => {
    const { dock, views, states, children } = setup();
    dock.show(bounds, "https://example.com/", "shop");
    expect(views).toHaveLength(1);
    expect(views[0].page.loads).toEqual(["https://example.com/"]);

    // The page calls window.close(): Electron destroys it, and its view's webContents goes undefined.
    views[0].page.destroy();
    expect(children.has(views[0])).toBe(false);
    expect(states.at(-1)).toMatchObject({ workspaceId: "shop", error: expect.stringMatching(/closed/) });

    // Everything the panel asks for still works.
    expect(() => dock.command("back")).not.toThrow();
    expect(() => dock.hide("shop")).not.toThrow();
    expect(() => dock.show(bounds, "https://example.com/", "shop")).not.toThrow();
    expect(views).toHaveLength(2);
    expect(views[1].page.loads).toEqual(["https://example.com/"]);
    expect(() => dock.dispose()).not.toThrow();
  });

  it("brings the page back on Try again after it closed itself", () => {
    const { dock, views } = setup();
    dock.show(bounds, "https://example.com/a", "shop");
    views[0].page.destroy();
    dock.command("reload");
    expect(views).toHaveLength(2);
    expect(views[1].page.loads).toEqual(["https://example.com/a"]);
  });

  it("copes with a page gone without a word, and closes the rest when the window goes", async () => {
    const { dock, views } = setup();
    dock.show(bounds, "https://example.com/", "shop");
    dock.show(bounds, "https://example.org/", "notes");
    // Gone, but no "destroyed" was heard.
    views[0].page.destroyed = true;
    expect(() => dock.show(bounds, "https://example.com/", "shop")).not.toThrow();
    expect(views).toHaveLength(3);
    expect(await dock.capture()).toBeNull();
    dock.dispose();
    expect(views[1].page.destroyed).toBe(true);
    expect(views[2].page.destroyed).toBe(true);
  });

  it("locks down the dock session permissions, downloads, and device pickers", () => {
    const { dock, views } = setup();
    dock.show(bounds, "https://example.com/", "shop");
    let mediaAllowed = true;
    sharedDockSession.handlers.request?.(views[0].page, "media", (ok) => {
      mediaAllowed = ok;
    });
    expect(mediaAllowed).toBe(false);
    expect(sharedDockSession.handlers.check?.(views[0].page, "geolocation", "https://example.com")).toBe(false);
    expect(sharedDockSession.handlers.device?.()).toBe(false);
    let streams: unknown = null;
    sharedDockSession.handlers.display?.({}, (value) => {
      streams = value;
    });
    expect(streams).toEqual({});

    const dlEvent = { preventDefault: vi.fn() };
    sharedDockSession.emitter.emit("will-download", dlEvent);
    expect(dlEvent.preventDefault).toHaveBeenCalledTimes(1);

    const btEvent = { preventDefault: vi.fn() };
    const btCb = vi.fn();
    views[0].page.emit("select-bluetooth-device", btEvent, [], btCb);
    expect(btEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(btCb).toHaveBeenCalledWith("");
  });
});
