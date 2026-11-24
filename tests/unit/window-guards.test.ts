import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { debugSwitch, isAppPage, relaunchArgs, settleWithin } from "../../electron/guards.js";

const registered = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0" },
  clipboard: {},
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      registered.set(channel, fn);
    },
  },
  shell: {},
}));

describe("the window's own page", () => {
  const file = "/opt/Vibe Forge/dist/index.html";
  const built = { file };
  const own = pathToFileURL(file).href;

  it("lets the built index.html through, with or without a hash or query", () => {
    expect(own).toBe("file:///opt/Vibe%20Forge/dist/index.html");
    expect(isAppPage(own, built)).toBe(true);
    expect(isAppPage(`${own}#/settings`, built)).toBe(true);
    expect(isAppPage(`${own}?x=1`, built)).toBe(true);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/%69ndex.html", built)).toBe(true);
  });

  it("refuses every other file, a dropped page or one beside it", () => {
    expect(isAppPage("file:///tmp/evil.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/other.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/index.html.evil", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/../dist/index.html/", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist%2Findex.html", built)).toBe(false);
    expect(isAppPage("file://elsewhere/opt/Vibe%20Forge/dist/index.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe Forge/dist", built)).toBe(false);
  });

  it("refuses web pages, odd schemes and nonsense", () => {
    for (const url of ["https://example.com/index.html", "http://localhost:5173/", "data:text/html,<p>hi</p>", "about:blank", "javascript:alert(1)", "", "not a url"]) {
      expect(isAppPage(url, built), url).toBe(false);
    }
  });

  it("matches the dev server by origin, and only it, while developing", () => {
    const dev = { file, devUrl: "http://localhost:5173/" };
    expect(isAppPage("http://localhost:5173/", dev)).toBe(true);
    expect(isAppPage("http://localhost:5173/src/main.tsx?t=1", dev)).toBe(true);
    expect(isAppPage("http://localhost:5174/", dev)).toBe(false);
    expect(isAppPage("http://localhost.evil.com:5173/", dev)).toBe(false);
    expect(isAppPage("https://localhost:5173/", dev)).toBe(false);
    // The build isn't loaded in development, so its file isn't the page then.
    expect(isAppPage(own, dev)).toBe(false);
    // A file:// "dev server" has no origin to match.
    expect(isAppPage("file:///tmp/evil.html", { file, devUrl: "file:///tmp/" })).toBe(false);
  });
});

describe("restarting", () => {
  it("comes back as a window, even when this copy started hidden at login", () => {
    expect(relaunchArgs(["/usr/lib/electron/electron", "/opt/vibeforge", "--hidden"])).toEqual(["/opt/vibeforge"]);
    expect(relaunchArgs(["/usr/lib/electron/electron", "/opt/vibeforge", "--ozone-platform=wayland"])).toEqual(["/opt/vibeforge", "--ozone-platform=wayland"]);
    expect(relaunchArgs(["/usr/lib/electron/electron"])).toEqual([]);
  });
});

describe("quitting", () => {
  it("waits for a step only so long, and never lets its error stop the quit", async () => {
    expect(await settleWithin(Promise.resolve(), 1000)).toBe(true);
    const errors: unknown[] = [];
    expect(await settleWithin(Promise.reject(new Error("closed twice")), 1000, (error) => errors.push(error))).toBe(true);
    expect(String(errors[0])).toContain("closed twice");
    const started = Date.now();
    expect(await settleWithin(new Promise(() => undefined), 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("IPC method lookup", () => {
  it("rejects Object.prototype property names like constructor and toString", async () => {
    const { registerIpc } = await import("../../electron/ipc.js");
    const file = "/opt/Vibe Forge/dist/index.html";
    const webContents = { id: 1 };
    const ctx = {
      win: { webContents },
      page: { file },
      log: { warn: () => undefined },
    } as unknown as Parameters<typeof registerIpc>[0];
    registerIpc(ctx, {} as Parameters<typeof registerIpc>[1]);
    const handler = registered.get("vf:call")!;
    const event = { sender: webContents, senderFrame: { url: pathToFileURL(file).href } };
    for (const method of ["constructor", "toString", "__proto__"]) {
      await expect(handler(event, method), method).rejects.toThrow(`Unknown call ${method}`);
    }
  });

  it("refuses updates.run on an installer copy when no verified command exists", async () => {
    const { registerIpc } = await import("../../electron/ipc.js");
    const file = "/opt/Vibe Forge/dist/index.html";
    const webContents = { id: 1 };
    const startCommand = vi.fn();
    const check = vi.fn(async () => ({ available: true, current: "3.6.0", latest: null, command: null, error: null }));
    const ctx = {
      win: { webContents },
      page: { file },
      install: "installer",
      svc: () => ({ startCommand }),
      log: { warn: () => undefined, info: () => undefined },
    } as unknown as Parameters<typeof registerIpc>[0];
    const parts = {
      updater: {
        get: () => ({ available: true, current: "3.6.0", latest: { tag: "v3.7.0" }, command: null, error: null }),
        check,
      },
    } as unknown as Parameters<typeof registerIpc>[1];
    registerIpc(ctx, parts);
    const handler = registered.get("vf:call")!;
    const event = { sender: webContents, senderFrame: { url: pathToFileURL(file).href } };
    await expect(handler(event, "updates.run")).rejects.toThrow("SHA-256");
    expect(check).toHaveBeenCalledTimes(1);
    expect(startCommand).not.toHaveBeenCalled();
  });

  it("allows remote-debugging-pipe everywhere and restricts remote-debugging-port to checkouts", () => {
    expect(debugSwitch({}, "checkout")).toBeNull();
    expect(debugSwitch({ VIBEFORGE_DEBUG: "pipe" }, "checkout")).toEqual({ name: "remote-debugging-pipe" });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "pipe" }, "installer")).toEqual({ name: "remote-debugging-pipe" });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "pipe" }, "other")).toEqual({ name: "remote-debugging-pipe" });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "1" }, "checkout")).toEqual({ name: "remote-debugging-port", value: "9223" });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "1", VIBEFORGE_DEBUG_PORT: "9333" }, "checkout")).toEqual({ name: "remote-debugging-port", value: "9333" });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "1" }, "installer")).toEqual({ refused: expect.stringContaining("VIBEFORGE_DEBUG=1") });
    expect(debugSwitch({ VIBEFORGE_DEBUG: "1" }, "other")).toEqual({ refused: expect.stringContaining("VIBEFORGE_DEBUG=1") });
  });
});

