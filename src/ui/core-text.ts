import { en } from "./i18n/en.js";
import { t, type Key, type Vars } from "./i18n/index.js";

// The main process speaks English: its errors, a routine's issues, why a run stopped. Each such
// sentence has a `core.*` key whose English text is the sentence itself, with {name} where a
// value goes, so the same catalog both recognises a message and translates it.

interface Pattern {
  key: Key;
  names: string[];
  regex: RegExp;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS: Pattern[] = (Object.keys(en) as Key[])
  .filter((key) => key.startsWith("core."))
  .map((key) => {
    const names: string[] = [];
    const source = en[key]
      .split(/\{(\w+)\}/g)
      .map((part, index) => {
        if (index % 2 === 0) return escape(part);
        names.push(part);
        return "(.+?)";
      })
      .join("");
    return { key, names, regex: new RegExp(`^${source}$`, "s") };
  });

/** The key and values for an English message from the main process, or null for one it doesn't know. */
export function matchCoreText(message: string): { key: Key; vars: Vars } | null {
  const text = message.trim();
  for (const pattern of PATTERNS) {
    const found = pattern.regex.exec(text);
    if (found) return { key: pattern.key, vars: Object.fromEntries(pattern.names.map((name, index) => [name, coreText(found[index + 1])])) };
  }
  return null;
}

/** A message from the main process in the chosen language; unknown messages stay as they are. */
export function coreText(message: string): string {
  if (t.language === "en" || !message) return message;
  const found = matchCoreText(message);
  return found ? t(found.key, found.vars) : message;
}
