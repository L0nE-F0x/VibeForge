import { useSyncExternalStore } from "react";
import { en } from "./en.js";

// Translations with no dependencies. English (`en.ts`) is the source: its keys are the only
// keys, and every other catalog must have all of them, so a missing translation fails the
// typecheck instead of slipping out in English. Text may use {name} placeholders, **bold** and
// `keycaps` (see Rich.tsx). English is always loaded; another language loads when it's chosen,
// and English stands in for the moment that takes.

export type Key = keyof typeof en;
export type Catalog = { readonly [K in Key]: string };
/** Keys with plural forms: `<base>.one`, `<base>.other`, and any other CLDR category a language needs. */
export type CountKey = PluralBase<Key>;
type PluralBase<K> = K extends `${infer Base}.other` ? Base : never;
export type Vars = Record<string, string | number>;

/** Each language by its own name, as the picker shows it. */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "pt", name: "Português (Brasil)" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "简体中文" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

const LOADERS: Record<Exclude<Language, "en">, () => Promise<Catalog>> = {
  de: () => import("./de.js").then((module) => module.de),
  es: () => import("./es.js").then((module) => module.es),
  fr: () => import("./fr.js").then((module) => module.fr),
  pt: () => import("./pt.js").then((module) => module.pt),
  ja: () => import("./ja.js").then((module) => module.ja),
  zh: () => import("./zh.js").then((module) => module.zh),
};

const CATALOGS: Partial<Record<Language, Catalog>> = { en };
const loading = new Map<Language, Promise<void>>();

/** Fetch a language's catalog, once. Resolves when `translate` can use it. */
export function loadLanguage(language: Language): Promise<void> {
  if (CATALOGS[language]) return Promise.resolve();
  let pending = loading.get(language);
  if (!pending) {
    pending = LOADERS[language as Exclude<Language, "en">]().then((catalog) => {
      CATALOGS[language] = catalog;
      if (language === current) refresh();
    });
    loading.set(language, pending);
  }
  return pending;
}

function known(tag: string): Language | null {
  const base = tag.toLowerCase().split(/[-_.]/)[0];
  return LANGUAGES.find((language) => language.code === base)?.code ?? null;
}

/** The language to show: the one chosen in Settings, else the first system language we have, else English. */
export function resolveLanguage(setting: string, system: readonly string[]): Language {
  if (setting && setting !== "system") return known(setting) ?? "en";
  for (const tag of system) {
    const found = known(tag);
    if (found) return found;
  }
  return "en";
}

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function translate(language: Language, key: Key, vars?: Vars): string {
  return fill(CATALOGS[language]?.[key] ?? en[key], vars);
}

/** A sentence with a number in it, in the plural form the language uses for that number. */
export function translateCount(language: Language, base: CountKey, count: number, vars?: Vars): string {
  const catalog = (CATALOGS[language] ?? en) as Record<string, string>;
  const form = `${base}.${new Intl.PluralRules(language).select(count)}`;
  const key = (form in catalog ? form : `${base}.other`) as Key;
  return translate(language, key, { count, ...vars });
}

// ------------------------------------------------------------------ the current language

export interface Translator {
  (key: Key, vars?: Vars): string;
  count: (base: CountKey, count: number, vars?: Vars) => string;
  language: Language;
}

function systemLanguages(): readonly string[] {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

let current: Language = resolveLanguage("system", systemLanguages());
const listeners = new Set<() => void>();
const translators = new Map<Language, Translator>();

function translatorFor(language: Language): Translator {
  let found = translators.get(language);
  if (!found) {
    const next = ((key: Key, vars?: Vars) => translate(language, key, vars)) as Translator;
    next.count = (base, count, vars) => translateCount(language, base, count, vars);
    next.language = language;
    translators.set(language, next);
    found = next;
  }
  return found;
}

/** Components re-render with the current language's translator: after a switch, or once its catalog arrives. */
function refresh(): void {
  translators.delete(current);
  for (const listener of listeners) listener();
}

let requested: Language = current;
// The system language's catalog starts loading straight away, before Settings are read.
if (current !== "en") void loadLanguage(current);

/** Follow the language setting ("system" or a code). The switch happens once its catalog is here. */
export function applyLanguageSetting(setting: string): void {
  const next = resolveLanguage(setting, systemLanguages());
  if (typeof document !== "undefined") document.documentElement.lang = next;
  requested = next;
  void loadLanguage(next).then(() => {
    if (requested !== next || current === next) return;
    current = next;
    refresh();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `t` for components; they re-render when the language changes. */
export function useT(): Translator {
  return useSyncExternalStore(subscribe, () => translatorFor(current));
}

/** `t` for code outside render (callbacks that raise toasts or confirmations). */
export const t: Translator = Object.assign((key: Key, vars?: Vars) => translate(current, key, vars), {
  count: (base: CountKey, count: number, vars?: Vars) => translateCount(current, base, count, vars),
  get language() {
    return current;
  },
});

/** The name of the language "system" resolves to, for the Settings picker. */
export function systemLanguageName(): string {
  const code = resolveLanguage("system", systemLanguages());
  return LANGUAGES.find((language) => language.code === code)?.name ?? "English";
}
