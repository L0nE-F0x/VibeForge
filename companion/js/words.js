// @ts-check
// The page's words in the phone's language, from the app's own catalogs (GET /api/text), and
// numbers, times and states said the way the desktop says them.

import { state } from "./state.js";

/** @type {Record<string, string>} */
export let words = {};
export let language = "en";
let loaded = false;

/** How long the page waits for its words before it shows itself with the ones below. */
const WORDS_TIMEOUT_MS = 8000;
/** The words as a computer last sent them, for a page that opens while none can be asked. */
const WORDS_KEY = "vibeforge-words";

/**
 * The words the first pages need, in English, for when the computer's don't arrive (a slow link, an
 * old computer): the page still reads, and the poll asks for the real ones again.
 * @type {Record<string, string>}
 */
const FALLBACK = {
  "phone.offline": "The computer is not serving the page.",
  "phone.timedOut": "The computer didn't answer in time. It may still be doing it: look before you try again.",
  "phone.pairLead": "Enter the pairing code from Settings → Phone on the computer.",
  "phone.pairLeadNamed": "Enter the pairing code from Settings → Phone on {name}.",
  "phone.computers": "Computers",
  "phone.back": "Back",
  "phone.code": "Pairing code",
  "phone.codeShow": "Show",
  "phone.codeHide": "Hide",
  "phone.continue": "Continue",
  "phone.codeWrong": "That code did not match.",
  "phone.error.failed": "Something went wrong.",
  "phone.credit": "Created by {name}",
  "common.close": "Close",
  "common.cancel": "Cancel",
};

/** Whether the computer's words arrived. */
export function wordsLoaded() {
  return loaded;
}

/**
 * The words for the phone's language. Until they arrive, or if they can't, the English ones above
 * and the keys stand in. True once they are here.
 */
export async function loadWords() {
  const abort = new AbortController();
  const limit = window.setTimeout(() => abort.abort(), WORDS_TIMEOUT_MS);
  try {
    // From the computer on show: the one the page came from may be off, with the page out of the phone's own copy.
    const response = await fetch(`${state.base}/api/text`, { signal: abort.signal, cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    words = body.words || {};
    language = body.language || "en";
    document.documentElement.lang = language;
    loaded = true;
    try {
      localStorage.setItem(WORDS_KEY, JSON.stringify({ language, words }));
    } catch {
      // No room to keep them: the page asks again next time, as before.
    }
  } catch {
    if (!loaded) lastWords();
  } finally {
    window.clearTimeout(limit);
  }
  return loaded;
}

/**
 * The computer didn't send the page's words (it is off, and the page came from the phone's own
 * copy): the ones it sent last time stand in, and the English few when there are none.
 */
function lastWords() {
  words = { ...FALLBACK };
  try {
    const kept = JSON.parse(localStorage.getItem(WORDS_KEY) || "null");
    if (!kept || typeof kept.words !== "object" || !kept.words) return;
    words = { ...FALLBACK, ...kept.words };
    language = typeof kept.language === "string" ? kept.language : "en";
    document.documentElement.lang = language;
  } catch {
    // Unreadable: the English few.
  }
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} [vars]
 */
export function t(key, vars) {
  const text = words[key] || FALLBACK[key] || key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

/**
 * A sentence with a number in it, in the plural form the phone's language uses (translateCount on the desktop).
 * @param {string} base
 * @param {number} count
 * @param {Record<string, unknown>} [vars]
 */
export function tCount(base, count, vars) {
  const form = `${base}.${new Intl.PluralRules(language).select(count)}`;
  return t(form in words ? form : `${base}.other`, { count, ...vars });
}

/**
 * @param {number} value
 * @param {string} name
 */
function unit(value, name) {
  return new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
}

/**
 * How long, the way the desktop's plan limits say it: "45m", "3h 20m", "2d 4h".
 * @param {number} ms
 */
export function span(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}` : unit(hours, "hour");
  return hours % 24 ? `${unit(Math.floor(hours / 24), "day")} ${unit(hours % 24, "hour")}` : unit(hours / 24, "day");
}

/** @param {string | null | undefined} iso */
export function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return t("plans.justNow");
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  return unit(Math.floor(seconds / 86400), "day");
}

/** @param {string} state */
export function stateLabel(state) {
  if (state === "working") return t("phone.working");
  if (state === "waiting") return t("phone.waiting");
  return t("phone.finished");
}
