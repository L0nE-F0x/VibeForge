import { en } from "./i18n/en.js";

// The main process speaks English: its errors, a routine's issues, why a run stopped. Each such
// sentence has a `core.*` key whose English text is the sentence itself, with {name} where a
// value goes, so the same catalog both recognises a message and translates it. No React here:
// the phone page's server uses this too.

export type CoreKey = Extract<keyof typeof en, `core.${string}`>;

interface Pattern {
  key: CoreKey;
  names: string[];
  regex: RegExp;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS: Pattern[] = (Object.keys(en) as Array<keyof typeof en>)
  .filter((key): key is CoreKey => key.startsWith("core."))
  .map((key) => {
    const names: string[] = [];
    const source = en[key]
      .split(/\{(\w+)\}/g)
      .map((part, index) => {
        if (index % 2 === 0) return escapeRegex(part);
        names.push(part);
        return "(.+?)";
      })
      .join("");
    return { key, names, regex: new RegExp(`^${source}$`, "s") };
  });

/**
 * The key and values for an English message from the main process, or null for one it doesn't
 * know. `inner` translates a value that is itself such a message.
 */
export function matchCoreText(message: string, inner: (value: string) => string = (value) => value): { key: CoreKey; vars: Record<string, string> } | null {
  const text = message.trim();
  for (const pattern of PATTERNS) {
    const found = pattern.regex.exec(text);
    if (found) return { key: pattern.key, vars: Object.fromEntries(pattern.names.map((name, index) => [name, inner(found[index + 1])])) };
  }
  return null;
}
