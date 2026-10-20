import { changesText } from "../shared/changes.js";
import type { Translator } from "./i18n/index.js";

/** A run's change summary (git's English) in the window's language. */
export function changesFor(text: string | null | undefined, t: Translator): string | null {
  return changesText(text, { count: (base, count) => t.count(base, count), say: (key) => t(key) });
}
