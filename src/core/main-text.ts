import { changesText, type ChangeCountKey } from "../shared/changes.js";
import { matchCoreText } from "../ui/core-match.js";
import { en } from "../ui/i18n/en.js";
import { catalog, fill, phoneLanguage, type Catalog, type Key, type PhoneLanguage } from "./companion-text.js";
import type { AlertWords } from "./quota-alerts.js";

// The main process's own words: the tray menu, the quit question, the notices and the desktop
// notifications the core sends, in the language the window speaks. The tray is built synchronously,
// so the catalog is loaded ahead (`use`) and English stands in until it is.

export class MainText {
  private words: Catalog = en;
  private current: PhoneLanguage = "en";

  /** Settings' language, or the desktop's (`locale`) when it says "system". */
  async use(setting: string, locale: string): Promise<void> {
    const language = phoneLanguage(setting, locale);
    const words = await catalog(language);
    this.current = language;
    this.words = words;
  }

  get language(): PhoneLanguage {
    return this.current;
  }

  say(key: Key, vars?: Record<string, string | number>): string {
    return fill(this.words[key] ?? en[key], vars && Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, String(value)])));
  }

  /** A sentence with a number in it, in the plural form this language uses (keys end in .one, .other…). */
  count(base: string, count: number, vars?: Record<string, string | number>): string {
    const form = `${base}.${new Intl.PluralRules(this.current).select(count)}`;
    const key = (form in en ? form : `${base}.other`) as Key;
    return this.say(key, { count, ...vars });
  }

  /** A plan alert's words (src/core/quota-alerts.ts). */
  alerts(): AlertWords {
    return {
      reached: (vars) => this.say("alerts.reached", vars),
      used: (vars) => this.say("alerts.used", vars),
      resets: (vars) => this.say("alerts.resets", vars),
      days: (count) => this.count("alerts.days", count),
    };
  }

  /**
   * A notification body the core wrote in English, part by part (" · "): its own sentences
   * through the same matching the window uses, and git's change summaries.
   */
  coreText(body: string): string {
    if (this.current === "en" || !body) return body;
    const words = { count: (base: ChangeCountKey, n: number) => this.count(base, n), say: (key: "changes.none") => this.say(key) };
    const translate = (text: string): string => {
      const found = matchCoreText(text, translate);
      return found ? fill(this.words[found.key] ?? en[found.key], found.vars) : text;
    };
    return body
      .split(" · ")
      .map((part) => {
        const summary = changesText(part, words);
        return summary !== part ? (summary ?? part) : translate(part);
      })
      .join(" · ");
  }
}
