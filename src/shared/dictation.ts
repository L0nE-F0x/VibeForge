// Dictated words on their way into a box: shared by the window and the main process.

/**
 * An initial prompt that nudges whisper toward the names on this desk (agents, CLIs, files).
 * Written as sentences: a bare list of words makes whisper drop punctuation.
 */
export function vocabularyPrompt(words: readonly string[], maxLength = 400): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of words) {
    const word = raw.replace(/\s+/g, " ").trim();
    const key = word.toLowerCase();
    if (!word || word.length > 60 || seen.has(key)) continue;
    if (length + word.length + 2 > maxLength) break;
    seen.add(key);
    kept.push(word);
    length += word.length + 2;
  }
  return kept.length ? `Names that may come up: ${kept.join(", ")}.` : "";
}

/** Dictated words joined onto what is already in a box, with one space between. */
export function joinDictation(before: string, words: string): string {
  if (!before.trim()) return words;
  return /\s$/.test(before) ? before + words : `${before} ${words}`;
}

// ------------------------------------------------------------------ the keys and buttons that dictate

/** The keys held to dictate: a key by its place on the keyboard (`event.code`) and its modifiers. */
export interface DictateKeys {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Super. */
  meta: boolean;
}

/** A mouse button that dictates the way the mic does: hold it to talk, or click it to start and again to finish. */
export type DictateButton = "off" | "back" | "forward" | "middle";

/** When a Send button comes up over a terminal with dictated words in it. */
export type SendButton = "off" | "pointer" | "always";

export const DEFAULT_DICTATE_KEYS: DictateKeys = { code: "Space", ctrl: true, shift: true, alt: false, meta: false };

/** `MouseEvent.button` for each choice. */
export const DICTATE_BUTTONS: Record<Exclude<DictateButton, "off">, number> = { middle: 1, back: 3, forward: 4 };

const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|NumLock|Fn)(Left|Right)?$/;
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** Why these keys can't dictate, or null when they can. */
export function dictateKeysProblem(keys: DictateKeys): "modifier" | "escape" | "needsModifier" | null {
  if (!/^[A-Za-z0-9]+$/.test(keys.code) || MODIFIER_CODE.test(keys.code)) return "modifier";
  // Esc drops the recording.
  if (keys.code === "Escape") return "escape";
  // Shift alone, or nothing, would take a key that types.
  if (!keys.ctrl && !keys.alt && !keys.meta && !FUNCTION_KEY.test(keys.code)) return "needsModifier";
  return null;
}

export function normalizeDictateKeys(value: unknown): DictateKeys {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const keys: DictateKeys = {
    code: typeof raw.code === "string" ? raw.code : "",
    ctrl: raw.ctrl === true,
    shift: raw.shift === true,
    alt: raw.alt === true,
    meta: raw.meta === true,
  };
  return dictateKeysProblem(keys) ? { ...DEFAULT_DICTATE_KEYS } : keys;
}

export function sameDictateKeys(a: DictateKeys, b: DictateKeys): boolean {
  return a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;
}

const KEY_NAMES: Record<string, string> = {
  // Not "`": keycaps in the window's text are written between backticks.
  Backquote: "Backtick",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Delete: "Del",
  Insert: "Ins",
  Backspace: "Backspace",
};

/** The key itself, as on its keycap: "KeyD" is "D". */
export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const pad = /^Numpad(.+)$/.exec(code);
  if (pad) return `Num ${pad[1]}`;
  return code;
}

/** "Ctrl+Shift+Space", in the order the shortcut sheet writes keys. */
export function dictateKeysLabel(keys: DictateKeys): string {
  return [keys.ctrl && "Ctrl", keys.shift && "Shift", keys.alt && "Alt", keys.meta && "Super", keyName(keys.code)].filter(Boolean).join("+");
}
