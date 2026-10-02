import { matchCoreText } from "../ui/core-match.js";
import { en } from "../ui/i18n/en.js";

// The phone page's words come from the app's own catalogs (its `phone.*` and `plans.*` keys), so
// a language that is missing one fails the typecheck like the rest of the app. The page asks for
// them once; errors the server sends back are translated here.

type Key = keyof typeof en;
type Catalog = { readonly [K in Key]: string };

export const PHONE_LANGUAGES = ["en", "de", "es", "fr", "pt", "ja", "zh"] as const;
export type PhoneLanguage = (typeof PHONE_LANGUAGES)[number];

const LOADERS: Record<Exclude<PhoneLanguage, "en">, () => Promise<Catalog>> = {
  de: () => import("../ui/i18n/de.js").then((module) => module.de),
  es: () => import("../ui/i18n/es.js").then((module) => module.es),
  fr: () => import("../ui/i18n/fr.js").then((module) => module.fr),
  pt: () => import("../ui/i18n/pt.js").then((module) => module.pt),
  ja: () => import("../ui/i18n/ja.js").then((module) => module.ja),
  zh: () => import("../ui/i18n/zh.js").then((module) => module.zh),
};

const catalogs = new Map<PhoneLanguage, Promise<Catalog>>([["en", Promise.resolve(en)]]);

function catalog(language: PhoneLanguage): Promise<Catalog> {
  let found = catalogs.get(language);
  if (!found) {
    found = LOADERS[language as Exclude<PhoneLanguage, "en">]().catch(() => en);
    catalogs.set(language, found);
  }
  return found;
}

function known(tag: string): PhoneLanguage | null {
  const base = tag.trim().toLowerCase().split(/[-_.;]/)[0];
  return PHONE_LANGUAGES.find((code) => code === base) ?? null;
}

/** The language chosen in Settings; with "system", the first the phone's browser asks for that the app has. */
export function phoneLanguage(setting: string, acceptLanguage: string | undefined): PhoneLanguage {
  if (setting && setting !== "system") return known(setting) ?? "en";
  for (const tag of (acceptLanguage ?? "").split(",")) {
    const found = known(tag);
    if (found) return found;
  }
  return "en";
}

function fill(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

/** Every word the page shows, in one language, English where a catalog has none. */
export async function phoneWords(language: PhoneLanguage): Promise<Record<string, string>> {
  const chosen = await catalog(language);
  const words: Record<string, string> = {};
  for (const key of Object.keys(en) as Key[]) {
    if (key.startsWith("phone.") || key.startsWith("plans.")) words[key] = chosen[key] ?? en[key];
  }
  return words;
}

/** A `phone.*` sentence in the phone's language. */
export async function phoneSay(language: PhoneLanguage, key: Key, vars?: Record<string, string>): Promise<string> {
  return fill((await catalog(language))[key] ?? en[key], vars);
}

/** A sentence the service threw, in the phone's language when the app knows it; as it was otherwise. */
export async function phoneCoreText(language: PhoneLanguage, message: string): Promise<string> {
  if (language === "en" || !message) return message;
  const chosen = await catalog(language);
  const translate = (text: string): string => {
    const found = matchCoreText(text, translate);
    return found ? fill(chosen[found.key] ?? en[found.key], found.vars) : text;
  };
  return translate(message);
}
