// @ts-check
// The page's words in the phone's language, from the app's own catalogs (GET /api/text), and
// numbers, times and states said the way the desktop says them.

/** @type {Record<string, string>} */
export let words = {};
export let language = "en";

/** The words for the phone's language. Before they arrive (or if they can't), keys stand in. */
export async function loadWords() {
  try {
    const body = await (await fetch("/api/text")).json();
    words = body.words || {};
    language = body.language || "en";
    document.documentElement.lang = language;
  } catch {
    words = { "phone.offline": "The computer is not serving the page." };
  }
}

/**
 * @param {string} key
 * @param {Record<string, unknown>} [vars]
 */
export function t(key, vars) {
  const text = words[key] || key;
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
