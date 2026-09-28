import { useCallback, useEffect, useRef, useState } from "react";

// Unsaved edits and unsent messages, kept per thing (a chat, a task, an agent's brief) until
// they're saved, sent or discarded. Switching views or quitting doesn't lose them. Kept in
// localStorage, so they stay on this machine and survive a restart.

const PREFIX = "vf.draft.";
const memory = new Map<string, unknown>();

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function readDraft<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as T;
    memory.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

function keepDraft(key: string, value: unknown): void {
  memory.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage can be full or unavailable; memory still has it */
  }
}

export function forgetDraft(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to forget */
  }
}

/**
 * Like useState, for a form or a message box whose saved value is `base`. While the value differs
 * from `base` it is kept under `key`; the same key later starts from it. When `base` changes (a
 * save, or an edit elsewhere) and you hadn't touched it, the value follows. `discard` goes back to
 * `base`. A null key keeps nothing.
 */
export function useDraftState<T>(key: string | null, base: T): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => (key ? (readDraft<T>(key) ?? base) : base));
  const seen = useRef({ key, base });

  useEffect(() => {
    const was = seen.current;
    seen.current = { key, base };
    if (was.key !== key) {
      setValue(key ? (readDraft<T>(key) ?? base) : base);
      return;
    }
    if (!same(was.base, base) && same(value, was.base)) {
      setValue(base);
      return;
    }
    if (!key) return;
    if (same(value, base)) forgetDraft(key);
    else keepDraft(key, value);
  }, [key, base, value]);

  const discard = useCallback(() => {
    if (key) forgetDraft(key);
    setValue(seen.current.base);
  }, [key]);

  return [value, setValue, discard];
}
