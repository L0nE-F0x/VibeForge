import type { Key } from "./i18n/index.js";

// Every keyboard shortcut, and the few mouse gestures the shortcut sheet lists, in one place. The
// window's handlers (App, Code), the overlay stack's Escape, what a terminal lets through to the
// window, the other key handlers and the shortcut sheet all read it, so a shortcut added here is
// on the sheet and reaches through terminals without a second list to keep in step.

/** A key and the modifiers it needs. A modifier left out may be up or down. */
export interface Chord {
  /** `event.key`, any case; a pattern for a range of keys or when case matters. */
  readonly key?: string | RegExp;
  /** `event.code`, the key's place on the keyboard: for keys whose character moves with the layout. */
  readonly code?: string | RegExp;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

/** Whose listener acts on it. */
export type ShortcutScope =
  /** The window, in any view, with menus and dialogs open too (App.tsx). */
  | "app"
  /** Code, while it is on screen (views/code/useCodeShortcuts.ts). */
  | "code"
  /** The overlay stack: menus, sheets, dialogs, the switcher (overlays.ts). */
  | "overlay"
  /** A terminal itself (components/Terminal.tsx, terminal-keys.ts). */
  | "terminal"
  /** Dictation, ahead of everything else (voice.tsx). */
  | "voice"
  /** The Runs view. */
  | "runs"
  /** An open editor: an agent, skill, task or routine. */
  | "form"
  /** A message with an Undo button (state.tsx). */
  | "toast"
  /** A list panel with a row focused (components/SidePanel.tsx). */
  | "list";

export interface Shortcut {
  /** How the handlers and the tests name it. */
  readonly id: string;
  /** Its keycaps for the sheet and tooltips, joined with "+". */
  readonly keys?: string;
  /** A mouse gesture instead of keys, said in words. */
  readonly gesture?: Key;
  /** What it does, on the sheet. */
  readonly label: Key;
  /** Its heading on the sheet. Headings come in the order they first appear here. */
  readonly group: Key;
  readonly scope: ShortcutScope;
  /**
   * When it waits: never (navigation works over menus and dialogs), while a menu or dialog is open,
   * or while you type in a box or a terminal (its handler looks at what has focus).
   */
  readonly paused: "never" | "overlay" | "typing";
  /** Holding the keys is one press, not one per repeat. */
  readonly once?: boolean;
  /** The key events it is. Left out on a gesture, and on a row that tells what the same keys do elsewhere. */
  readonly chord?: Chord;
  /**
   * In a terminal: "window" when the terminal lets it through to the window instead of giving it
   * to the program, "first" when a listener takes it before the terminal sees it, "own" when the
   * terminal acts on it itself. Left out, the program in the terminal gets it.
   */
  readonly terminal?: "window" | "first" | "own";
  /** What else a "window" shortcut needs inside a terminal, where the program keeps the rest: plain Ctrl+K is its kill-line. */
  readonly inTerminal?: Chord;
}

const ctrlShift = (key: string): Chord => ({ ctrl: true, shift: true, alt: false, key });

const LIST = [
  // ---------------------------------------------------------------- anywhere
  { id: "app.switcher", keys: "Ctrl+K", label: "shortcuts.switcher", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { ctrl: true, alt: false, key: "k" }, terminal: "window", inTerminal: { shift: true } },
  { id: "app.orchestrator", keys: "Ctrl+Shift+O", label: "shortcuts.orchestrator", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: ctrlShift("o"), terminal: "window" },
  { id: "app.views", keys: "Ctrl+1…9", label: "shortcuts.switchViews", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { ctrl: true, alt: false, shift: false, key: /^[1-9]$/ }, terminal: "window" },
  // By the key's place, so Alt+1 is Alt+1 on a layout where that key types something else.
  { id: "app.workspaces", keys: "Alt+1…9", label: "shortcuts.workspaces", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { alt: true, ctrl: false, shift: false, code: /^Digit[1-9]$/ }, terminal: "window" },
  { id: "app.settings", keys: "Ctrl+,", label: "shortcuts.settings", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { ctrl: true, alt: false, key: "," }, terminal: "window" },
  // In a terminal Alt+←/→ move by words, so they stay the program's.
  { id: "app.back", keys: "Alt+←", label: "shortcuts.back", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { alt: true, key: "ArrowLeft" } },
  { id: "app.forward", keys: "Alt+→", label: "shortcuts.forward", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { alt: true, key: "ArrowRight" } },
  { id: "app.sideButtons", gesture: "shortcuts.sideButtons", label: "shortcuts.backForward", group: "shortcuts.anywhere", scope: "app", paused: "never" },
  { id: "list.move", keys: "↑/↓", label: "shortcuts.listMove", group: "shortcuts.anywhere", scope: "list", paused: "never", chord: { ctrl: false, shift: false, alt: false, meta: false, key: /^(ArrowUp|ArrowDown|Home|End)$/ } },
  { id: "app.panel", keys: "Ctrl+Shift+B", label: "shortcuts.panel", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { ctrl: true, shift: true, key: "b" }, terminal: "window", inTerminal: { alt: false } },
  { id: "app.shortcuts", keys: "Ctrl+Shift+/", label: "shortcuts.list", group: "shortcuts.anywhere", scope: "app", paused: "never", chord: { ctrl: true, shift: true, code: "Slash" }, terminal: "window", inTerminal: { alt: false } },
  { id: "overlay.close", keys: "Esc", label: "shortcuts.closeDialog", group: "shortcuts.anywhere", scope: "overlay", paused: "never", chord: { key: "Escape" } },
  // A terminal sends the same byte for Shift+Esc as for Esc, so no CLI waits for it.
  { id: "overlay.closeFromTerminal", keys: "Shift+Esc", label: "shortcuts.closeFromTerminal", group: "shortcuts.anywhere", scope: "overlay", paused: "never", chord: { key: "Escape", shift: true }, terminal: "first" },

  // ---------------------------------------------------------------- Code
  { id: "code.splitRight", keys: "Ctrl+Shift+D", label: "shortcuts.splitRight", group: "shortcuts.code", scope: "code", paused: "overlay", once: true, chord: ctrlShift("d"), terminal: "window" },
  { id: "code.splitDown", keys: "Ctrl+Shift+E", label: "shortcuts.splitDown", group: "shortcuts.code", scope: "code", paused: "overlay", once: true, chord: ctrlShift("e"), terminal: "window" },
  { id: "code.close", keys: "Ctrl+Shift+W", label: "shortcuts.closePane", group: "shortcuts.code", scope: "code", paused: "overlay", once: true, chord: ctrlShift("w"), terminal: "window" },
  { id: "code.maximize", keys: "Ctrl+Shift+M", label: "shortcuts.maximize", group: "shortcuts.code", scope: "code", paused: "overlay", once: true, chord: ctrlShift("m"), terminal: "window" },
  { id: "code.maximizeTitle", gesture: "shortcuts.doubleClick", label: "shortcuts.maximizeTitle", group: "shortcuts.code", scope: "code", paused: "never" },
  { id: "code.movePane", gesture: "shortcuts.drag", label: "shortcuts.movePane", group: "shortcuts.code", scope: "code", paused: "never" },
  { id: "code.moveWorkspace", gesture: "shortcuts.drag", label: "shortcuts.moveWorkspace", group: "shortcuts.code", scope: "code", paused: "never" },
  { id: "code.renameWorkspace", gesture: "shortcuts.doubleClick", label: "shortcuts.renameWorkspace", group: "shortcuts.code", scope: "code", paused: "never" },

  // ---------------------------------------------------------------- terminals
  { id: "terminal.copy", keys: "Ctrl+C", label: "shortcuts.copy", group: "shortcuts.terminals", scope: "terminal", paused: "never", chord: { ctrl: true, shift: false, alt: false, meta: false, key: "c" }, terminal: "own" },
  { id: "terminal.paste", keys: "Ctrl+V", label: "shortcuts.paste", group: "shortcuts.terminals", scope: "terminal", paused: "never", chord: { ctrl: true, shift: false, alt: false, meta: false, key: "v" }, terminal: "own" },
  // What Ctrl+C does with nothing selected: the copy above lets it go to the program.
  { id: "terminal.interrupt", keys: "Ctrl+C", label: "shortcuts.interrupt", group: "shortcuts.terminals", scope: "terminal", paused: "never" },
  { id: "terminal.drop", gesture: "shortcuts.dropFile", label: "shortcuts.drop", group: "shortcuts.terminals", scope: "terminal", paused: "never" },
  { id: "terminal.write", keys: "Ctrl+Shift+Enter", label: "shortcuts.write", group: "shortcuts.terminals", scope: "terminal", paused: "never", chord: { ctrl: true, shift: true, alt: false, key: "Enter" }, terminal: "own" },

  // ---------------------------------------------------------------- voice
  { id: "voice.dictate", keys: "Ctrl+Shift+Space", label: "shortcuts.dictate", group: "shortcuts.voice", scope: "voice", paused: "never", chord: { ctrl: true, shift: true, alt: false, meta: false, code: "Space" }, terminal: "first" },
  { id: "voice.cancel", keys: "Esc", label: "shortcuts.dictateCancel", group: "shortcuts.voice", scope: "voice", paused: "never", chord: { key: "Escape" }, terminal: "first" },

  // ---------------------------------------------------------------- editing
  { id: "form.save", keys: "Ctrl+S", label: "shortcuts.save", group: "shortcuts.editing", scope: "form", paused: "never", chord: { ctrl: true, key: "s" } },
  { id: "toast.undo", keys: "Ctrl+Z", label: "shortcuts.undo", group: "shortcuts.editing", scope: "toast", paused: "typing", chord: { ctrl: true, shift: false, alt: false, meta: false, key: "z" } },
  { id: "app.devtools", keys: "Ctrl+Shift+I", label: "shortcuts.devtools", group: "shortcuts.editing", scope: "app", paused: "never", chord: { ctrl: true, shift: true, key: "i" }, terminal: "window", inTerminal: { alt: false } },

  // ---------------------------------------------------------------- runs
  { id: "runs.next", keys: "J", label: "shortcuts.nextRun", group: "shortcuts.runs", scope: "runs", paused: "typing", chord: { ctrl: false, shift: false, alt: false, meta: false, key: /^j$/ } },
  { id: "runs.prev", keys: "K", label: "shortcuts.prevRun", group: "shortcuts.runs", scope: "runs", paused: "typing", chord: { ctrl: false, shift: false, alt: false, meta: false, key: /^k$/ } },
] as const satisfies readonly Shortcut[];

type Entry = (typeof LIST)[number];
export type ShortcutId = Entry["id"];
/** The keyed shortcuts a scope's handler acts on. */
export type ShortcutIdIn<S extends ShortcutScope> = Extract<Entry, { scope: S; chord: object }>["id"];

export const SHORTCUTS: readonly Shortcut[] = LIST;
const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

/** A key event as the matchers read it; the overlay stack's tests hand in only some of it. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

function same(want: string | RegExp, got: string | undefined): boolean {
  return typeof want === "string" ? (got ?? "").toLowerCase() === want.toLowerCase() : want.test(got ?? "");
}

function pressed(chord: Chord, event: KeyLike): boolean {
  if (chord.ctrl !== undefined && Boolean(event.ctrlKey) !== chord.ctrl) return false;
  if (chord.shift !== undefined && Boolean(event.shiftKey) !== chord.shift) return false;
  if (chord.alt !== undefined && Boolean(event.altKey) !== chord.alt) return false;
  if (chord.meta !== undefined && Boolean(event.metaKey) !== chord.meta) return false;
  if (chord.key !== undefined && !same(chord.key, event.key)) return false;
  if (chord.code !== undefined && !same(chord.code, event.code)) return false;
  return true;
}

function entry(id: ShortcutId): Shortcut {
  return BY_ID.get(id) as Shortcut;
}

/** Whether a key event is this shortcut's keys. */
export function isShortcut(id: ShortcutId, event: KeyLike): boolean {
  const chord = entry(id).chord;
  return Boolean(chord && pressed(chord, event));
}

/** Its keycaps, for a tooltip or a hint: "Ctrl+Shift+D". */
export function shortcutKeys(id: ShortcutId): string {
  return entry(id).keys ?? "";
}

/** Every keyed shortcut a key event is, in the registry's order. */
export function shortcutsFor(event: KeyLike): ShortcutId[] {
  return SHORTCUTS.filter((item) => item.chord && pressed(item.chord, event)).map((item) => item.id as ShortcutId);
}

/** Whether a terminal hands this key to the window instead of the program in it. */
export function reachesWindow(event: KeyLike): boolean {
  return SHORTCUTS.some((item) => item.terminal === "window" && item.chord && pressed({ ...item.chord, ...item.inTerminal }, event));
}

/** What a shortcut does. Returning false says it doesn't apply just now: the key then goes on as if it weren't one. */
export type ShortcutAction = (event: KeyboardEvent) => unknown;

/**
 * Runs the first of `actions` whose keys these are, tried in the order they are listed, and takes
 * the key (preventDefault). One that waits under a menu or dialog does nothing while
 * `overlayOpen()` says one is open, and leaves the key alone; one held down runs once.
 */
export function runShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "preventDefault">,
  actions: Partial<Record<ShortcutId, ShortcutAction>>,
  overlayOpen: () => boolean,
): boolean {
  for (const [id, action] of Object.entries(actions) as Array<[ShortcutId, ShortcutAction | undefined]>) {
    const item = entry(id);
    if (!action || !item.chord || !pressed(item.chord, event)) continue;
    if (item.paused === "overlay" && overlayOpen()) return false;
    if (!(item.once && event.repeat) && action(event as KeyboardEvent) === false) return false;
    event.preventDefault();
    return true;
  }
  return false;
}

/** The shortcut sheet's sections: each heading with its rows, keys or a gesture, in the registry's order. */
export function shortcutSheet(): Array<{ group: Key; rows: Array<{ id: ShortcutId; keys?: string; gesture?: Key; text: Key }> }> {
  const sections = new Map<Key, Array<{ id: ShortcutId; keys?: string; gesture?: Key; text: Key }>>();
  for (const item of SHORTCUTS) {
    const rows = sections.get(item.group) ?? [];
    rows.push({ id: item.id as ShortcutId, keys: item.keys, gesture: item.gesture, text: item.label });
    sections.set(item.group, rows);
  }
  return [...sections].map(([group, rows]) => ({ group, rows }));
}
