import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import * as guards from "../../electron/guards.js";
const { permissionAllowed } = guards;

type PermissionRequestFn = (contents: unknown, permission: string, callback: (allow: boolean) => void) => void;
type PermissionCheckFn = (contents: unknown, permission: string, origin: string) => boolean;
type DevicePermissionFn = (details: unknown) => boolean;
type DisplayMediaFn = (request: unknown, callback: (streams: unknown) => void) => void;

function fakeSession() {
  const emitter = new EventEmitter();
  let onRequest: PermissionRequestFn | null = null;
  let onCheck: PermissionCheckFn | null = null;
  let onDevice: DevicePermissionFn | null = null;
  let onDisplay: DisplayMediaFn | null = null;
  return {
    emitter,
    setPermissionRequestHandler: vi.fn((fn: PermissionRequestFn | null) => {
      onRequest = fn;
    }),
    setPermissionCheckHandler: vi.fn((fn: PermissionCheckFn | null) => {
      onCheck = fn;
    }),
    setDevicePermissionHandler: vi.fn((fn: DevicePermissionFn | null) => {
      onDevice = fn;
    }),
    setDisplayMediaRequestHandler: vi.fn((fn: DisplayMediaFn | null) => {
      onDisplay = fn;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    askRequest(contents: unknown, permission: string) {
      let granted: boolean | undefined;
      onRequest?.(contents, permission, (allow) => {
        granted = allow;
      });
      return granted;
    },
    askCheck(contents: unknown, permission: string, origin = "https://example.com") {
      return onCheck?.(contents, permission, origin);
    },
    askDevice(details: unknown) {
      return onDevice?.(details);
    },
    askDisplay() {
      let result: unknown = "unset";
      onDisplay?.({}, (streams) => {
        result = streams;
      });
      return result;
    },
  };
}

describe("what pages may use", () => {
  it("lets every page copy to the clipboard, and only VibeForge's own page notify", () => {
    expect(permissionAllowed(true, "clipboard-sanitized-write")).toBe(true);
    expect(permissionAllowed(false, "clipboard-sanitized-write")).toBe(true);
    expect(permissionAllowed(true, "notifications")).toBe(true);
    expect(permissionAllowed(false, "notifications")).toBe(false);
  });

  it("refuses everything else, the window's page included", () => {
    for (const permission of ["media", "clipboard-read", "geolocation", "openExternal", "fullscreen", "midi", "hid", "fileSystem", ""]) {
      expect(permissionAllowed(true, permission), permission).toBe(false);
      expect(permissionAllowed(false, permission), permission).toBe(false);
    }
  });

  it("locks down permissions, devices, display capture, and device pickers on every session", () => {
    const ownContents = { id: "own" };
    const otherContents = { id: "other" };
    const dockSession = fakeSession();
    guards.guardSession(dockSession, () => false);

    // Dock sessions refuse media, geolocation, notifications, devices, and display capture.
    expect(dockSession.askRequest(otherContents, "media")).toBe(false);
    expect(dockSession.askCheck(otherContents, "media")).toBe(false);
    expect(dockSession.askRequest(otherContents, "geolocation")).toBe(false);
    expect(dockSession.askRequest(otherContents, "notifications")).toBe(false);
    expect(dockSession.askCheck(otherContents, "notifications")).toBe(false);
    expect(dockSession.askRequest(otherContents, "clipboard-sanitized-write")).toBe(true);
    expect(dockSession.askDevice({ deviceType: "hid" })).toBe(false);
    expect(dockSession.askDisplay()).toEqual({});

    // HID, serial (4 args), and USB selection prompts are cancelled cleanly.
    const hidEvent = { preventDefault: vi.fn() };
    const hidCb = vi.fn();
    dockSession.emitter.emit("select-hid-device", hidEvent, { deviceList: [] }, hidCb);
    expect(hidEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(hidCb).toHaveBeenCalledWith("");

    const serialEvent = { preventDefault: vi.fn() };
    const serialCb = vi.fn();
    dockSession.emitter.emit("select-serial-port", serialEvent, [], otherContents, serialCb);
    expect(serialEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(serialCb).toHaveBeenCalledWith("");

    const usbEvent = { preventDefault: vi.fn() };
    const usbCb = vi.fn();
    dockSession.emitter.emit("select-usb-device", usbEvent, { deviceList: [] }, usbCb);
    expect(usbEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(usbCb).toHaveBeenCalledWith("");

    // Guarding the same session again does not double-wire listeners.
    guards.guardSession(dockSession, () => false);
    expect(dockSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(dockSession.on).toHaveBeenCalledTimes(3);

    // App session allows notifications only for its own WebContents, never media or external notifications.
    const appSession = fakeSession();
    guards.guardSession(appSession, (contents) => contents === ownContents);
    expect(appSession.askRequest(ownContents, "notifications")).toBe(true);
    expect(appSession.askRequest(otherContents, "notifications")).toBe(false);
    expect(appSession.askRequest(ownContents, "media")).toBe(false);
    expect(appSession.askCheck(ownContents, "notifications")).toBe(true);
    expect(appSession.askCheck(otherContents, "notifications")).toBe(false);
    expect(appSession.askDevice({ deviceType: "usb" })).toBe(false);
  });

  it("cancels Bluetooth device pickers on every webContents, idempotently", () => {
    const contents = new EventEmitter();
    const onSpy = vi.spyOn(contents, "on");
    guards.guardWebContents(contents);
    guards.guardWebContents(contents);
    expect(onSpy).toHaveBeenCalledTimes(1);

    const btEvent = { preventDefault: vi.fn() };
    const btCb = vi.fn();
    contents.emit("select-bluetooth-device", btEvent, [], btCb);
    expect(btEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(btCb).toHaveBeenCalledWith("");
  });
});
