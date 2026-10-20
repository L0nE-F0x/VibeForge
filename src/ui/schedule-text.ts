import cronstrue from "cronstrue";
import "cronstrue/locales/de";
import "cronstrue/locales/es";
import "cronstrue/locales/fr";
import "cronstrue/locales/ja";
import "cronstrue/locales/pt_BR";
import "cronstrue/locales/zh_CN";
import type { Schedule } from "../shared/api.js";
import type { Translator } from "./i18n/index.js";

// A routine's schedule in words, in the window's language: intervals from the catalogs, cron
// expressions through cronstrue's own translations, with the clock the language uses.

const CRON_LOCALE: Record<string, string> = { en: "en", de: "de", es: "es", fr: "fr", ja: "ja", pt: "pt_BR", zh: "zh_CN" };

/** Whether the language writes times on a 24-hour clock, as Intl formats them. */
function twentyFourHours(language: string): boolean {
  try {
    return !new Intl.DateTimeFormat(language, { hour: "numeric" }).resolvedOptions().hour12;
  } catch {
    return true;
  }
}

export function scheduleText(schedule: Schedule, t: Translator, fallback = ""): string {
  if (schedule.kind === "every") {
    const minutes = schedule.minutes;
    if (!(minutes > 0)) return fallback;
    if (minutes % 1440 === 0) return t.count("schedule.everyDays", minutes / 1440);
    if (minutes % 60 === 0) return t.count("schedule.everyHours", minutes / 60);
    return t.count("schedule.everyMinutes", minutes);
  }
  try {
    return cronstrue.toString(schedule.expr, { locale: CRON_LOCALE[t.language] ?? "en", use24HourTimeFormat: twentyFourHours(t.language), verbose: false });
  } catch {
    return fallback || schedule.expr;
  }
}
