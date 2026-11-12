import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { de } from "../../src/ui/i18n/de.js";
import { en } from "../../src/ui/i18n/en.js";
import { es } from "../../src/ui/i18n/es.js";
import { fr } from "../../src/ui/i18n/fr.js";
import { ja } from "../../src/ui/i18n/ja.js";
import { pt } from "../../src/ui/i18n/pt.js";
import { zh } from "../../src/ui/i18n/zh.js";

// Settings → Plan limits is off until someone reads its hint and turns it on, so the hint has to name
// every company it then talks to. This reads the services src/core/plans.ts actually asks.

const repo = path.resolve(import.meta.dirname, "..", "..");

/** Who runs each service plans.ts asks, as the hint names them. A new host fails here until it's added. */
const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)anthropic\.com$/, "Anthropic"],
  [/(^|\.)grok\.com$/, "xAI"],
  [/(^|\.)googleapis\.com$/, "Google"],
  [/(^|\.)kimi\.com$/, "Moonshot"],
  [/(^|\.)chatgpt\.com$/, "OpenAI"],
  [/(^|\.)meta\.ai$/, "Meta"],
];

function askedHosts(): string[] {
  const source = fs.readFileSync(path.join(repo, "src", "core", "plans.ts"), "utf8");
  return [...new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()))];
}

describe("the Plan limits hint", () => {
  it("names the company behind every service the plan limits ask, in every language", () => {
    const hosts = askedHosts();
    expect(hosts.length).toBeGreaterThan(0);
    const names = hosts.map((host) => {
      const provider = PROVIDERS.find(([pattern]) => pattern.test(host))?.[1];
      expect(provider, `${host} has no provider name: add it here and to settings.planLimitsHint`).toBeDefined();
      return provider as string;
    });
    for (const [language, catalog] of Object.entries({ en, de, es, fr, ja, pt, zh })) {
      const hint = catalog["settings.planLimitsHint"];
      for (const name of new Set(names)) expect(hint, `${language} leaves out ${name}`).toContain(name);
    }
  });
});
