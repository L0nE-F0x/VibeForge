// What the clipboard keys do in a terminal. Copy and paste work the way people expect outside a
// terminal, and Omarchy's Super+C / Super+V (which send Ctrl+C / Ctrl+V to windows it doesn't
// know as terminals, Ctrl+Insert / Shift+Insert to ones it does) land on them too:
//
// - Ctrl+C copies when text is selected, and is the program's interrupt when nothing is.
// - Ctrl+V pastes text; with only an image on the clipboard it reaches the program, which is
//   how Claude Code pastes images.
// - Ctrl+Shift+C / Ctrl+Shift+V and Ctrl+Insert / Shift+Insert always copy and paste.

import { isShortcut, reachesWindow } from "./shortcuts.js";

export type ClipboardKey = "copy" | "paste" | "paste-or-pass" | null;

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function clipboardKey(event: KeyLike, hasSelection: boolean): ClipboardKey {
  if (event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey && key === "c") return "copy";
  if (event.ctrlKey && event.shiftKey && key === "v") return "paste";
  if (event.ctrlKey && !event.shiftKey && key === "insert") return "copy";
  if (event.shiftKey && !event.ctrlKey && key === "insert") return "paste";
  if (isShortcut("terminal.copy", event)) return hasSelection ? "copy" : null;
  if (isShortcut("terminal.paste", event)) return "paste-or-pass";
  return null;
}

/**
 * App shortcuts that must reach the window instead of the program in the terminal: the ones
 * shortcuts.ts marks for it. Ctrl+Shift+K opens the switcher there; plain Ctrl+K stays the
 * program's (kill to end of line), and so do Alt+← and Alt+→.
 */
export function appShortcut(event: KeyLike): boolean {
  return reachesWindow(event);
}

/** A link a terminal may open: http(s) only. Anything else a program prints (file:, javascript:) is ignored. */
export function isWebLink(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
