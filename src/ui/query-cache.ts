import type { Topic } from "../shared/api.js";

// The shared query cache behind useQuery, kept apart from React and the bridge so it can be
// tested on its own. Each query is keyed, fetched once for every component that reads it, and
// refetched when the main process reports a change to one of the topics its readers follow.

export interface Snapshot {
  data: unknown;
  error: string | null;
  loaded: boolean;
}

export interface QueryOptions {
  /** Kept once nobody reads it (the default). Searches and run bundles say no: one per text or run adds up. */
  keep?: boolean;
  /** Read again by the 30 s refresh (the default). A run's files don't move with the clock. */
  poll?: boolean;
}

/** The topics a query follows, or a choice made from what it read last. */
export type Topics = readonly Topic[] | ((data: unknown) => readonly Topic[]);

export interface Entry {
  key: string;
  /** What the last render asked for, for while nobody is subscribed. */
  topics: readonly Topic[];
  fetcher: () => Promise<unknown>;
  keep: boolean;
  poll: boolean;
  data: unknown;
  error: string | null;
  /** Fresh: no change reported since the last read. */
  loaded: boolean;
  inflight: Promise<void> | null;
  stale: boolean;
  /** Each reader and the topics it follows. */
  subscribers: Map<() => void, readonly Topic[]>;
  snapshot: Snapshot;
}

/** Entries nobody reads that are not kept stay this long, so going back to one doesn't load it again. */
export const IDLE_KEEP = 8;

/**
 * Equal for data that came over IPC: plain objects, arrays and primitives. Anything else counts
 * as changed unless it is the same object, so a reader is never left on old data.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameData(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b) || !isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class QueryCache {
  private readonly entries = new Map<string, Entry>();
  /** Unkept entries nobody reads, oldest first. */
  private readonly idle = new Set<Entry>();

  constructor(private readonly describe: (error: unknown) => string) {}

  /** The entry for `key`, made on first use. The latest render's topics, fetcher and options win. */
  entry(key: string, topics: Topics, fetcher: () => Promise<unknown>, options: QueryOptions = {}): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        topics: [],
        fetcher,
        keep: true,
        poll: true,
        data: undefined,
        error: null,
        loaded: false,
        inflight: null,
        stale: false,
        subscribers: new Map(),
        snapshot: { data: undefined, error: null, loaded: false },
      };
      this.entries.set(key, entry);
    }
    entry.topics = typeof topics === "function" ? topics(entry.snapshot.data) : topics;
    entry.fetcher = fetcher;
    entry.keep = options.keep ?? true;
    entry.poll = options.poll ?? true;
    return entry;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  subscribe(entry: Entry, notify: () => void, topics: readonly Topic[]): () => void {
    this.idle.delete(entry);
    // Dropped while its reader was away for a moment (StrictMode does that): it comes back.
    if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
    entry.subscribers.set(notify, topics);
    if (!entry.loaded && !entry.inflight) void this.load(entry);
    return () => {
      entry.subscribers.delete(notify);
      if (!entry.subscribers.size && !entry.keep) this.rest(entry);
    };
  }

  load(entry: Entry): Promise<void> {
    if (entry.inflight) {
      entry.stale = true;
      return entry.inflight;
    }
    entry.stale = false;
    let changed = false;
    entry.inflight = entry
      .fetcher()
      .then(
        (data) => {
          // Most reads find nothing new. Keeping the old object then spares every reader a render.
          const shown = entry.snapshot;
          changed = !shown.loaded || shown.error !== null || !sameData(shown.data, data);
          if (changed) entry.data = data;
          entry.error = null;
        },
        (error: unknown) => {
          const text = this.describe(error);
          changed = !entry.snapshot.loaded || entry.snapshot.error !== text;
          entry.error = text;
        },
      )
      .finally(() => {
        entry.loaded = true;
        entry.inflight = null;
        if (changed) this.publish(entry);
        if (entry.stale && entry.subscribers.size) void this.load(entry);
      });
    return entry.inflight;
  }

  /** The main process changed these topics: read again what someone follows, mark the rest. */
  invalidate(topics: readonly Topic[]): void {
    for (const entry of this.entries.values()) {
      if (!follows(entry, topics)) continue;
      if (entry.subscribers.size) void this.load(entry);
      else entry.loaded = false;
    }
  }

  /** The periodic refresh: relative times, next fires and the inbox window move on their own. */
  refresh(): void {
    for (const entry of this.entries.values()) if (entry.poll && entry.subscribers.size) void this.load(entry);
  }

  private publish(entry: Entry): void {
    entry.snapshot = { data: entry.data, error: entry.error, loaded: entry.loaded };
    for (const notify of entry.subscribers.keys()) notify();
  }

  private rest(entry: Entry): void {
    this.idle.delete(entry);
    this.idle.add(entry);
    while (this.idle.size > IDLE_KEEP) {
      const oldest = this.idle.values().next().value!;
      this.idle.delete(oldest);
      if (!oldest.subscribers.size && this.entries.get(oldest.key) === oldest) this.entries.delete(oldest.key);
    }
  }
}

/** Whether a change to `topics` concerns the entry: any reader's topics, or the last render's with none. */
function follows(entry: Entry, topics: readonly Topic[]): boolean {
  const lists = entry.subscribers.size ? entry.subscribers.values() : [entry.topics];
  for (const list of lists) if (list.some((topic) => topics.includes(topic))) return true;
  return false;
}
