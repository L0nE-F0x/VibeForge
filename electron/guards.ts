import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIDDEN_ARG } from "../src/core/autostart.js";
import type { InstallKind } from "../src/core/updates.js";
import type { TrayWaiter } from "../src/shared/api.js";
import type { Send } from "./main-context.js";

// Small rules the main process keeps, pure so the tests can reach them without Electron.

/** Where VibeForge's own page lives: the built index.html, or the Vite dev server while developing. */
export interface AppPage {
  file: string;
  devUrl?: string;
}

/**
 * Whether `url` is VibeForge's own page. Only that page may run with the preload's bridge, so any
 * other file, even one beside it, is not: the dev server matches by origin, the build by its exact file.
 */
export function isAppPage(url: string, page: AppPage): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (page.devUrl) {
    try {
      const dev = new URL(page.devUrl);
      return /^https?:$/.test(dev.protocol) && parsed.origin === dev.origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== "file:") return false;
  try {
    return fileURLToPath(parsed) === path.resolve(page.file);
  } catch {
    // A host other than localhost, or an encoded slash.
    return false;
  }
}

/**
 * The arguments a restart starts with: this copy's own, minus --hidden, so a copy started at login
 * comes back as a window rather than in the tray.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter((arg) => arg !== HIDDEN_ARG);
}

/**
 * The arguments to come back with when VibeForge was started again while quitting: this copy's
 * own, opened as a window unless the new start came from login (--hidden).
 */
export function secondStartArgs(own: readonly string[], second: readonly string[]): string[] {
  return [...relaunchArgs(own), ...(second.includes(HIDDEN_ARG) ? [HIDDEN_ARG] : [])];
}

/** Waits for `work` for at most `ms`: true when it settled in time, false when it didn't. Never rejects. */
export function settleWithin(work: Promise<unknown>, ms: number, failed: (error: unknown) => void = () => undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        failed(error);
        resolve(true);
      },
    );
  });
}

/** What a desktop notification is about: a click opens the most specific place it names. */
export interface NoteTarget {
  runId?: string;
  taskId?: string;
  routineId?: string;
  workspaceId?: string | null;
  chatId?: string | null;
  agentId?: string | null;
  /** Handed back to the page as it came, in "open-route". */
  route?: unknown;
}

/** Tells the page to open what a clicked notification is about. */
export function openNote(note: NoteTarget, send: Send): void {
  if (note.route) send("open-route", { route: note.route });
  else if (note.taskId) send("open-route", { route: { view: "tasks", taskId: note.taskId } });
  else if (note.routineId) send("open-route", { route: { view: "routines", routineId: note.routineId } });
  else if (note.runId) send("open-run", { runId: note.runId });
  else if (note.chatId) send("open-chat", { chatId: note.chatId, agentId: note.agentId ?? null });
  else if (note.workspaceId) send("open-workspace", { workspaceId: note.workspaceId });
}

/** Who is waiting, as the page reported it: a whole count, and at most eight names of 80 characters. */
export function attentionFrom(state: { count: number; waiters: TrayWaiter[] } | null | undefined): { count: number; waiters: TrayWaiter[] } {
  const count = Math.max(0, Math.floor(Number(state?.count) || 0));
  const waiters = Array.isArray(state?.waiters)
    ? state.waiters.slice(0, 8).map((waiter) => ({ label: String(waiter?.label ?? "").slice(0, 80), route: waiter?.route ?? null }))
    : [];
  return { count, waiters };
}

/**
 * dbus-send's answer to whether the tray watcher's name has an owner. Without dbus-send there's
 * no telling, so the settings decide, as before.
 */
export function trayHostAnswer(error: { code?: unknown } | null, stdout: string): boolean {
  return error ? error.code === "ENOENT" : /boolean true/.test(stdout);
}

/** Asks one at a time: a call while an answer is still out gets that answer instead of a second question. */
export function oneAtATime<A extends unknown[], T>(ask: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let pending: Promise<T> | null = null;
  return (...args) => {
    if (pending) return pending;
    pending = ask(...args).finally(() => {
      pending = null;
    });
    return pending;
  };
}

/** What web pages may use: copying to the clipboard, as any browser lets them. */
const WEB_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
/** VibeForge's own page also shows notifications. */
const PAGE_PERMISSIONS = new Set([...WEB_PERMISSIONS, "notifications"]);

/**
 * Electron grants every permission unless told otherwise, so a page in the browser dock could open
 * the microphone or read the clipboard without asking. Everything else is refused.
 */
export function permissionAllowed(ownPage: boolean, permission: string): boolean {
  return (ownPage ? PAGE_PERMISSIONS : WEB_PERMISSIONS).has(permission);
}

/** Narrow shapes of Electron's Session and WebContents so session guards run in unit tests too. */
export interface GuardableWebContents {
  on?(event: "select-bluetooth-device", listener: (event: { preventDefault(): void }, ...rest: unknown[]) => void): unknown;
}

export interface GuardableSession {
  setPermissionRequestHandler?(
    handler: ((contents: GuardableWebContents | null, permission: string, callback: (allow: boolean) => void) => void) | null,
  ): void;
  setPermissionCheckHandler?(
    handler: ((contents: GuardableWebContents | null, permission: string, origin: string) => boolean) | null,
  ): void;
  setDevicePermissionHandler?(handler: ((details: unknown) => boolean) | null): void;
  setDisplayMediaRequestHandler?(handler: ((request: unknown, callback: (streams: Record<string, never>) => void) => void) | null): void;
  on?(event: string, listener: (event: { preventDefault(): void }, ...rest: unknown[]) => void): unknown;
}

const guardedSessions = new WeakSet<object>();
const guardedContents = new WeakSet<object>();

function cancelDeviceSelect(event: { preventDefault(): void }, ...rest: unknown[]): void {
  event.preventDefault();
  const callback = rest.at(-1);
  if (typeof callback === "function") (callback as (id: string) => void)("");
}

/**
 * Lock down permissions, hardware device grants, display capture, and device pickers on an Electron
 * session (defaultSession, `persist:dock`, or any future partition). Idempotent per session object.
 */
export function guardSession(target: GuardableSession | null | undefined, isOwn: (contents: GuardableWebContents | null) => boolean): void {
  if (!target || guardedSessions.has(target)) return;
  guardedSessions.add(target);
  const allowed = (contents: GuardableWebContents | null, permission: string) => permissionAllowed(isOwn(contents), permission);
  target.setPermissionRequestHandler?.((contents, permission, callback) => callback(allowed(contents, permission)));
  target.setPermissionCheckHandler?.((contents, permission) => allowed(contents, permission));
  target.setDevicePermissionHandler?.(() => false);
  target.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
  if (typeof target.on === "function") {
    for (const event of ["select-hid-device", "select-serial-port", "select-usb-device"]) {
      target.on(event, cancelDeviceSelect);
    }
  }
}

/** Cancel Bluetooth device selection on a WebContents (a WebContents event rather than a Session one in Electron). */
export function guardWebContents(contents: GuardableWebContents | null | undefined): void {
  if (!contents || guardedContents.has(contents)) return;
  guardedContents.add(contents);
  contents.on?.("select-bluetooth-device", cancelDeviceSelect);
}

export type DebugSwitch = { name: "remote-debugging-pipe"; value?: undefined } | { name: "remote-debugging-port"; value: string } | { refused: string };

/**
 * Resolves Chromium's debugging switch. Pipe mode works over inherited fds without opening a local
 * TCP port, so it is allowed everywhere; port debugging is limited to developer git checkouts.
 */
export function debugSwitch(env: NodeJS.ProcessEnv, install: InstallKind): DebugSwitch | null {
  if (env.VIBEFORGE_DEBUG === "pipe") return { name: "remote-debugging-pipe" };
  if (env.VIBEFORGE_DEBUG !== "1") return null;
  if (install !== "checkout") {
    return { refused: `Ignoring VIBEFORGE_DEBUG=1 on ${install} copy; use VIBEFORGE_DEBUG=pipe instead.` };
  }
  return { name: "remote-debugging-port", value: env.VIBEFORGE_DEBUG_PORT || "9223" };
}
