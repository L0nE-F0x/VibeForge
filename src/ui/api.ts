import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clockNow, subscribeClock } from "./clock.js";
import { coreText } from "./core-text.js";
import { QueryCache, type QueryOptions, type Topics } from "./query-cache.js";
import type { DeskEvents, Method, MethodArgs, MethodResult, PlanSummary, Topic, UsageSummary, VibeForgeBridge } from "../shared/api.js";

declare global {
  interface Window {
    vibeforge?: VibeForgeBridge;
  }
}

function bridge(): VibeForgeBridge {
  if (!window.vibeforge) throw new Error("VibeForge's bridge is missing. Open this page through the app.");
  return window.vibeforge;
}

/** Electron wraps errors from the main process; keep only the part a person should read, in their language. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return coreText(raw.replace(/^Error invoking remote method '[^']+': /, "").replace(/^Error: /, ""));
}

export function call<K extends Method>(method: K, ...args: MethodArgs<K>): Promise<MethodResult<K>> {
  return bridge().call(method, ...args) as Promise<MethodResult<K>>;
}

export function on<K extends keyof DeskEvents>(event: K, listener: (payload: DeskEvents[K]) => void): () => void {
  return bridge().on(event, listener as (payload: unknown) => void);
}

/** Whether the VibeForge window has the keyboard. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return focused;
}

/** Mark <html> with `unfocused` while the window doesn't have the keyboard: the glow holds still then. */
export function markWindowFocus(): void {
  const mark = () => document.documentElement.classList.toggle("unfocused", !document.hasFocus());
  mark();
  window.addEventListener("focus", mark);
  window.addEventListener("blur", mark);
}

export function pathForFile(file: File): string {
  try {
    return bridge().pathForFile(file);
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ PTY fan-out
// One IPC listener for all terminal output, routed to the terminals that care.

type DataListener = (event: DeskEvents["pty-data"]) => void;
type ExitListener = (event: DeskEvents["pty-exit"]) => void;
const dataListeners = new Map<string, Set<DataListener>>();
const exitListeners = new Map<string, Set<ExitListener>>();
const exitedPtys = new Map<string, DeskEvents["pty-exit"]>();
let ptyWired = false;

function wirePty(): void {
  if (ptyWired || !window.vibeforge) return;
  ptyWired = true;
  on("pty-data", (event) => {
    for (const listener of dataListeners.get(event.ptyId) ?? []) listener(event);
  });
  on("pty-exit", (event) => {
    exitedPtys.set(event.ptyId, event);
    if (exitedPtys.size > 500) exitedPtys.delete(exitedPtys.keys().next().value!);
    for (const listener of exitListeners.get(event.ptyId) ?? []) listener(event);
  });
}

export function onPtyData(ptyId: string, listener: DataListener): () => void {
  wirePty();
  const set = dataListeners.get(ptyId) ?? new Set();
  set.add(listener);
  dataListeners.set(ptyId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) dataListeners.delete(ptyId);
  };
}

export function onPtyExit(ptyId: string, listener: ExitListener): () => void {
  wirePty();
  const known = exitedPtys.get(ptyId);
  if (known) queueMicrotask(() => listener(known));
  const set = exitListeners.get(ptyId) ?? new Set();
  set.add(listener);
  exitListeners.set(ptyId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) exitListeners.delete(ptyId);
  };
}

export function ptyExitInfo(ptyId: string): DeskEvents["pty-exit"] | null {
  return exitedPtys.get(ptyId) ?? null;
}

// ------------------------------------------------------------------ shared query cache
// Each query is keyed, fetched once for every component that reads it, and refetched when the
// main process reports a change to one of the topics its readers follow (query-cache.ts).

const cache = new QueryCache(errorText);
let changesWired = false;

function wireChanges(): void {
  if (changesWired || !window.vibeforge) return;
  changesWired = true;
  on("changed", (topics) => invalidate(topics));
  // Relative times, next fires and the two-day inbox window move on their own.
  setInterval(() => cache.refresh(), 30_000);
}

export function invalidate(topics: Topic[]): void {
  cache.invalidate(topics);
}

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

/**
 * Read `key` through the shared cache. `topics` can depend on what was read last (a run follows
 * its terminal only while it runs); the query is read again when one of them changes.
 */
export function useQuery<T>(
  key: string | null,
  topics: Topic[] | ((data: T | undefined) => Topic[]),
  fetcher: () => Promise<T>,
  options?: QueryOptions,
): Query<T> {
  wireChanges();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const entry = key ? cache.entry(key, topics as Topics, () => fetcherRef.current(), options) : null;
  const wanted = entry?.topics ?? NO_TOPICS;
  const follow = wanted.join(" ");
  // A new key or a new set of topics subscribes again.
  const subscribe = useCallback((notify: () => void) => (entry ? cache.subscribe(entry, notify, wanted) : () => undefined), [key, follow]);
  const snapshot = useSyncExternalStore(subscribe, () => entry?.snapshot ?? EMPTY);
  const reload = useCallback(() => (entry ? cache.load(entry) : Promise.resolve()), [entry]);
  return { data: snapshot.data as T | undefined, error: snapshot.error, loaded: snapshot.loaded, reload };
}

const EMPTY = { data: undefined, error: null, loaded: false };
const NO_TOPICS: readonly Topic[] = [];

/** `value`, once it has stopped changing for `ms`: for search boxes that ask the main process. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Re-render on an interval, for clocks and relative times. */
export function useNow(intervalMs = 15_000): number {
  // One shared clock per interval (clock.ts), however many of these are on screen.
  const subscribe = useCallback((listener: () => void) => subscribeClock(intervalMs, listener), [intervalMs]);
  return useSyncExternalStore(subscribe, () => clockNow(intervalMs));
}

// ------------------------------------------------------------------ common queries

export const useEngines = () => useQuery("engines", ["engines"], () => call("engines.list"));
export const useSettings = () => useQuery("settings", ["settings"], () => call("settings.get"));
export const useAgents = () => useQuery("agents", ["agents"], () => call("agents.list"));
export const useSkills = () => useQuery("skills", ["skills"], () => call("skills.list"));
// A CLI going busy or quiet ("working") changes who a task or routine waits behind, and the live list.
export const useRoutines = () => useQuery("routines", ["routines", "runs", "agents", "engines", "live", "working"], () => call("routines.list"));
export const useTasks = () => useQuery("tasks", ["tasks", "runs", "agents", "workspaces", "engines", "live", "working"], () => call("tasks.list"));
export const useWorkspaces = () => useQuery("workspaces", ["workspaces"], () => call("workspaces.list"));
export const useInbox = () => useQuery("inbox", ["runs"], () => call("runs.inbox"));
export const useLive = () => useQuery("live", ["live", "working"], () => call("live.list"));
// Polled: most of it is fixed while VibeForge runs, but whether the terminal host is up isn't.
export const useAppInfo = () => useQuery("app-info", [], () => call("app.info"));
export const useUpdate = () => useQuery("updates", ["updates"], () => call("updates.get"));
export const useActivity = () => useQuery("activity", ["settings", "workspaces"], () => call("activity.get"));

/**
 * Reload a query every minute, with one timer for the key however many components read it. The
 * cache's own 30-second refresh is off for these (poll: false), so each is read once a minute.
 */
const minuteReloads = new Map<string, { readers: number; reload: () => Promise<void>; timer: ReturnType<typeof setInterval> }>();

function useEveryMinute(key: string, reload: () => Promise<void>): void {
  useEffect(() => {
    let shared = minuteReloads.get(key);
    if (!shared) {
      const made = { readers: 0, reload, timer: setInterval(() => void made.reload(), 60_000) };
      minuteReloads.set(key, made);
      shared = made;
    }
    shared.readers += 1;
    shared.reload = reload;
    const mine = shared;
    return () => {
      mine.readers -= 1;
      if (mine.readers > 0) return;
      clearInterval(mine.timer);
      minuteReloads.delete(key);
    };
  }, [key, reload]);
}

/** Token usage from the CLIs' logs, read again every minute and whenever a run ends. */
export function useUsage(): Query<UsageSummary | null> {
  const query = useQuery("usage", ["settings", "runs"], () => call("usage.summary"), { poll: false });
  useEveryMinute("usage", query.reload);
  return query;
}
/**
 * How much of each coding plan is used, checked every minute and whenever a run ends. The main
 * process asks the providers at most every few minutes; `refresh` asks them now.
 */
export function usePlans(): Query<PlanSummary | null> & { refresh: () => Promise<void> } {
  const query = useQuery("plans", ["settings", "runs"], () => call("plans.summary"), { poll: false });
  const { reload } = query;
  useEveryMinute("plans", reload);
  const refresh = useCallback(async () => {
    await call("plans.summary", true);
    await reload();
  }, [reload]);
  return { ...query, refresh };
}
export const useChats = (agentId: string | null | undefined) =>
  useQuery(`chats:${agentId === undefined ? "*" : (agentId ?? "none")}`, ["chats", "runs", "live"], () =>
    call("chats.list", agentId === undefined ? {} : { agentId }),
  );
