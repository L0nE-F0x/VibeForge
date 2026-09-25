import { describe, expect, it } from "vitest";
import { de } from "../../src/ui/i18n/de.js";
import { en } from "../../src/ui/i18n/en.js";
import { es } from "../../src/ui/i18n/es.js";
import { fr } from "../../src/ui/i18n/fr.js";
import { LANGUAGES, resolveLanguage, translate, translateCount, type Catalog, type Key } from "../../src/ui/i18n/index.js";
import { ja } from "../../src/ui/i18n/ja.js";
import { pt } from "../../src/ui/i18n/pt.js";
import { zh } from "../../src/ui/i18n/zh.js";

const catalogs: Record<string, Catalog> = { de, es, fr, pt, ja, zh };
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const count = (text: string, mark: string) => text.split(mark).length - 1;

describe("translations", () => {
  it("offers every catalog in the picker", () => {
    expect(LANGUAGES.map((language) => language.code).sort()).toEqual(["en", ...Object.keys(catalogs)].sort());
  });

  it("keep the English placeholders and markup in every language", () => {
    for (const [code, catalog] of Object.entries(catalogs)) {
      for (const key of Object.keys(en) as Key[]) {
        const source = en[key];
        const text = catalog[key];
        expect(text.trim(), `${code} ${key} is empty`).not.toBe("");
        expect(placeholders(text), `${code} ${key} placeholders`).toEqual(placeholders(source));
        expect(count(text, "**") % 2, `${code} ${key} bold markers`).toBe(0);
        expect(count(text, "`") % 2, `${code} ${key} keycap markers`).toBe(0);
        if (count(source, "**")) expect(count(text, "**"), `${code} ${key} keeps its bold`).toBeGreaterThan(0);
      }
    }
  });

  it("picks the setting, else the first system language it has, else English", () => {
    expect(resolveLanguage("system", ["de-DE", "en-US"])).toBe("de");
    expect(resolveLanguage("system", ["nl-NL", "pt-BR"])).toBe("pt");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("system", ["nl-NL"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("fr", ["de-DE"])).toBe("fr");
    expect(resolveLanguage("xx", ["de-DE"])).toBe("en");
  });

  it("fills placeholders and chooses the plural form each language uses", () => {
    expect(translate("en", "help.updateTo", { version: "0.3.0" })).toBe("Update to 0.3.0");
    expect(translate("en", "help.updateTo")).toBe("Update to {version}");
    expect(translateCount("en", "code.running", 1)).toBe("1 terminal running");
    expect(translateCount("en", "code.running", 3)).toBe("3 terminals running");
    expect(translateCount("de", "code.running", 1)).toBe("1 Terminal läuft");
    expect(translateCount("de", "code.running", 2)).toBe("2 Terminals laufen");
    // French treats 0 as singular; Japanese has one form for every number.
    expect(translateCount("fr", "code.running", 0)).toBe("0 terminal en cours");
    expect(translateCount("ja", "code.running", 1)).toBe("1 個のターミナルが稼働中");
  });
});
