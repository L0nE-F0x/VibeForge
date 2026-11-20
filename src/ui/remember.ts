import { useCallback, useState } from "react";

// Where you were on each thing of a kind: the tab an agent was left on, whether a workspace had its
// side panel open, which part of a run you were reading. Switching to another one and back lands
// where you left it, and it survives a restart. Kept in this window's localStorage, per scope.

const PREFIX = "vf.place.";
/** Enough for every agent, workspace and recent run; the least recently touched drop off first. */
const LIMIT = 300;

const scopes = new Map<string, Map<string, unknown>>();

function load(scope: string): Map<string, unknown> {
  let places = scopes.get(scope);
  if (places) return places;
  places = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + scope) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      for (const entry of raw) if (Array.isArray(entry) && typeof entry[0] === "string") places.set(entry[0], entry[1]);
    }
  } catch {
    /* a broken record only means nothing is remembered yet */
  }
  scopes.set(scope, places);
  return places;
}

function persist(scope: string, places: Map<string, unknown>): void {
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify([...places]));
  } catch {
    /* storage can be unavailable; the place is still kept until the window closes */
  }
}

/** What was remembered for `id` in `scope`, if it passes `valid`. */
export function recall<T>(scope: string, id: string, valid: (value: unknown) => value is T): T | undefined {
  const value = load(scope).get(id);
  return valid(value) ? value : undefined;
}

/** Remember `value` for `id` in `scope`; the most recent stay when there are too many. */
export function remember(scope: string, id: string, value: unknown): void {
  const places = load(scope);
  if (JSON.stringify(places.get(id)) === JSON.stringify(value) && places.has(id)) return;
  places.delete(id);
  places.set(id, value);
  while (places.size > LIMIT) places.delete(places.keys().next().value as string);
  persist(scope, places);
}

/** Drop what was remembered for `id` (it was deleted). */
export function forget(scope: string, id: string): void {
  const places = load(scope);
  if (!places.delete(id)) return;
  persist(scope, places);
}

/** For tests: drop the in-memory copy so the next read comes from storage again. */
export function resetPlaces(): void {
  scopes.clear();
}

/**
 * A piece of view state remembered per thing: `id` picks whose. Changing `id` shows that one's own
 * value (or `fallback` the first time); setting it remembers it for the current `id` only.
 */
export function usePlace<T>(scope: string, id: string | null | undefined, fallback: T, valid: (value: unknown) => value is T): [T, (next: T) => void] {
  // Bumped on every set so the component re-renders; the value itself lives in the store.
  const [, setVersion] = useState(0);
  const value = id ? (recall(scope, id, valid) ?? fallback) : fallback;
  const set = useCallback(
    (next: T) => {
      if (!id) return;
      remember(scope, id, next);
      setVersion((version) => version + 1);
    },
    [scope, id],
  );
  return [value, set];
}
