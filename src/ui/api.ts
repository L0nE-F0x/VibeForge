import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeskEvents, Method, MethodArgs, MethodResult, Topic, VibeForgeBridge } from "../shared/api.js";

declare global {
  interface Window {
    vibeforge?: VibeForgeBridge;
  }
}

function bridge(): VibeForgeBridge {
  if (!window.vibeforge) throw new Error("VibeForge's bridge is missing. Open this page through the app.");
  return window.vibeforge;
}

/** Electron wraps errors from the main process; keep only the part a person should read. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': /, "").replace(/^Error: /, "");
}

export function call<K extends Method>(method: K, ...args: MethodArgs<K>): Promise<MethodResult<K>> {
  return bridge().call(method, ...args) as Promise<MethodResult<K>>;
}

export function on<K extends keyof DeskEvents>(event: K, listener: (payload: DeskEvents[K]) => void): () => void {
  return bridge().on(event, listener as (payload: unknown) => void);
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
// Each query is keyed, fetched once for every component that reads it, and refetched
// when the main process reports a change to one of its topics.

interface Entry {
  key: string;
  topics: Topic[];
  fetcher: () => Promise<unknown>;
  data: unknown;
  error: string | null;
  loaded: boolean;
  inflight: Promise<void> | null;
  stale: boolean;
  subscribers: Set<() => void>;
  snapshot: { data: unknown; error: string | null; loaded: boolean };
}

const cache = new Map<string, Entry>();
let changesWired = false;

function publish(entry: Entry): void {
  entry.snapshot = { data: entry.data, error: entry.error, loaded: entry.loaded };
  for (const notify of entry.subscribers) notify();
}

function load(entry: Entry): Promise<void> {
  if (entry.inflight) {
    entry.stale = true;
    return entry.inflight;
  }
  entry.stale = false;
  entry.inflight = entry
    .fetcher()
    .then(
      (data) => {
        entry.data = data;
        entry.error = null;
      },
      (error: unknown) => {
        entry.error = errorText(error);
      },
    )
    .finally(() => {
      entry.loaded = true;
      entry.inflight = null;
      publish(entry);
      if (entry.stale && entry.subscribers.size) void load(entry);
    });
  return entry.inflight;
}

function wireChanges(): void {
  if (changesWired || !window.vibeforge) return;
  changesWired = true;
  on("changed", (topics) => invalidate(topics));
  // Relative times, next fires and the two-day inbox window move on their own.
  setInterval(() => {
    for (const entry of cache.values()) if (entry.subscribers.size) void load(entry);
  }, 30_000);
}

export function invalidate(topics: Topic[]): void {
  for (const entry of cache.values()) {
    if (!entry.topics.some((topic) => topics.includes(topic))) continue;
    if (entry.subscribers.size) void load(entry);
    else entry.loaded = false;
  }
}

function entryFor(key: string, topics: Topic[], fetcher: () => Promise<unknown>): Entry {
  let entry = cache.get(key);
  if (!entry) {
    entry = {
      key,
      topics,
      fetcher,
      data: undefined,
      error: null,
      loaded: false,
      inflight: null,
      stale: false,
      subscribers: new Set(),
      snapshot: { data: undefined, error: null, loaded: false },
    };
    cache.set(key, entry);
  }
  entry.fetcher = fetcher;
  return entry;
}

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

export function useQuery<T>(key: string | null, topics: Topic[], fetcher: () => Promise<T>): Query<T> {
  wireChanges();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const entry = key ? entryFor(key, topics, () => fetcherRef.current()) : null;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!entry) return () => undefined;
      entry.subscribers.add(notify);
      if (!entry.loaded && !entry.inflight) void load(entry);
      return () => entry.subscribers.delete(notify);
    },
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, () => entry?.snapshot ?? EMPTY);
  const reload = useCallback(() => (entry ? load(entry) : Promise.resolve()), [entry]);
  return { data: snapshot.data as T | undefined, error: snapshot.error, loaded: snapshot.loaded, reload };
}

const EMPTY = { data: undefined, error: null, loaded: false };

/** Re-render on an interval, for clocks and relative times. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------ common queries

export const useEngines = () => useQuery("engines", ["engines"], () => call("engines.list"));
export const useSettings = () => useQuery("settings", ["settings"], () => call("settings.get"));
export const useAgents = () => useQuery("agents", ["agents"], () => call("agents.list"));
export const useSkills = () => useQuery("skills", ["skills"], () => call("skills.list"));
export const useRoutines = () => useQuery("routines", ["routines", "runs", "agents", "engines", "live"], () => call("routines.list"));
export const useTasks = () => useQuery("tasks", ["tasks", "runs", "agents", "workspaces", "engines", "live"], () => call("tasks.list"));
export const useWorkspaces = () => useQuery("workspaces", ["workspaces"], () => call("workspaces.list"));
export const useInbox = () => useQuery("inbox", ["runs"], () => call("runs.inbox"));
export const useLive = () => useQuery("live", ["live"], () => call("live.list"));
export const useAppInfo = () => useQuery("app-info", [], () => call("app.info"));
export const useChats = (agentId: string | null | undefined) =>
  useQuery(`chats:${agentId === undefined ? "*" : (agentId ?? "none")}`, ["chats", "runs", "live"], () =>
    call("chats.list", agentId === undefined ? {} : { agentId }),
  );
