import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Electron's app as an event emitter; quit() counts and emits nothing (the test drives the events).
const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn(), whenReady: async () => undefined });
const powerMonitor = new EventEmitter();
vi.mock("electron", () => ({ app, dialog: {}, powerMonitor }));
vi.mock("../../electron/companion.js", () => ({ stopCompanion: async () => undefined }));

const { Quit } = await import("../../electron/quit.js");
const { secondStartArgs } = await import("../../electron/guards.js");

function willQuit() {
  const event = { preventDefault: vi.fn() };
  app.emit("will-quit", event);
  return event;
}

describe("quitting", () => {
  it("runs one shutdown however many quits arrive while it is under way", async () => {
    app.removeAllListeners();
    let release: () => void = () => undefined;
    const supervisorShutdown = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const service = { prepareShutdown: vi.fn(), whenIdle: async () => undefined, shutdown: vi.fn(), disposeLocalServer: vi.fn(), close: vi.fn() };
    const ctx = { log: { warn: vi.fn() }, supervisor: { shutdown: supervisorShutdown }, service, quitting: false } as never;
    const quit = new Quit(ctx, { voice: { dispose: vi.fn() } });
    quit.handleEvents();
    expect(willQuit().preventDefault).toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    // Quit from the tray again, or a SIGTERM: held, but no second shutdown.
    expect(willQuit().preventDefault).toHaveBeenCalled();
    expect(willQuit().preventDefault).toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisorShutdown).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // The quit that follows goes through.
    expect(willQuit().preventDefault).not.toHaveBeenCalled();
  });

  it("stops the terminals alongside a Syncthing that is slow to end, not after it", async () => {
    app.removeAllListeners();
    app.quit.mockClear();
    const steps: string[] = [];
    let syncEnded: () => void = () => undefined;
    const sync = { stop: () => new Promise<void>((resolve) => (syncEnded = resolve)) };
    const supervisorShutdown = vi.fn(async () => void steps.push("terminals stopped"));
    const service = { prepareShutdown: vi.fn(), whenIdle: async () => undefined, shutdown: vi.fn(), disposeLocalServer: vi.fn(), close: vi.fn(async () => void steps.push("closed")) };
    const ctx = { log: { warn: vi.fn() }, supervisor: { shutdown: supervisorShutdown }, service, quitting: false } as never;
    new Quit(ctx, { voice: { dispose: vi.fn() }, sync }).handleEvents();
    willQuit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(steps).toEqual(["terminals stopped"]);
    syncEnded();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(steps).toEqual(["terminals stopped", "closed"]);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("quits the usual way when the system shuts down, asking it to wait", async () => {
    app.removeAllListeners();
    powerMonitor.removeAllListeners();
    app.quit.mockClear();
    const ctx = { log: { warn: vi.fn(), info: vi.fn() }, supervisor: { shutdown: vi.fn() }, service: null, quitting: false };
    new Quit(ctx as never, { voice: { dispose: vi.fn() } }).handleEvents();
    await new Promise((resolve) => setImmediate(resolve));
    const event = { preventDefault: vi.fn() };
    powerMonitor.emit("shutdown", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ctx.quitting).toBe(true);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("comes back as a window after a start that lost the lock to a quitting copy", () => {
    expect(secondStartArgs(["/usr/lib/electron", "/app", "--hidden"], ["/usr/lib/electron", "/app"])).toEqual(["/app"]);
    expect(secondStartArgs(["/usr/lib/electron", "/app"], ["/usr/lib/electron", "/app", "--hidden"])).toEqual(["/app", "--hidden"]);
  });
});
