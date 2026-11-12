// Whether this copy of VibeForge was updated on disk while it runs. The page keeps running the old
// version until a restart, and the files it would load later (a view opened for the first time, a
// language) now belong to the new one, so the way forward is a restart.

import { useSyncExternalStore } from "react";

let updated = false;
const listeners = new Set<() => void>();

/** The update finished (its command exited cleanly), or a file of the old version has gone. */
export function markUpdated(): void {
  if (updated) return;
  updated = true;
  for (const listener of [...listeners]) listener();
}

export function wasUpdated(): boolean {
  return updated;
}

/** True once this copy was updated under the running window: the update dialog offers Restart. */
export function useUpdated(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => updated,
  );
}

/**
 * A part of the page that could not be loaded because its file is gone: an update replaced the
 * folder this window was started from, and the new version names its files differently.
 */
export function isStaleChunk(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(text);
}

/**
 * Load every part of the page that otherwise loads the first time it is needed, once the window
 * has a quiet moment. After an update replaces the files on disk, the old window still has them.
 * A hidden window gets no frames, so idle callbacks also run after `timeoutMs` at the latest.
 */
export function preloadWhenIdle(loaders: ReadonlyArray<() => Promise<unknown>>, timeoutMs = 4000): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    for (const load of loaders) void load().catch(() => undefined);
  };
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: timeoutMs });
  else setTimeout(run, timeoutMs);
  return () => {
    cancelled = true;
  };
}
