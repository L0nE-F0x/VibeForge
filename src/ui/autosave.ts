// When an autosaving editor saves on its own. Kept apart from the views so it can be tested.

/**
 * Whether the editor should save `key` (what is being edited, as text) on its own: there is
 * something unsaved, it may save now, and this exact value hasn't been tried already. A save that
 * the core turns into something else (spaces folded) or that fails is not tried again and again;
 * the next change, Ctrl+S or leaving the page tries again.
 */
export function autosaveDue(key: string, attempted: string | null, dirty: boolean, ready: boolean): boolean {
  return dirty && ready && key !== attempted;
}

/** An agent's "Good at" line as the core keeps it: one line, spaces folded, at most 160 characters. */
export function oneLine(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
