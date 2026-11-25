import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildPhoneOrchestrator } from "../../src/core/companion-orchestrator.js";
import { PHONE_LANGUAGES, catalog, phoneWords } from "../../src/core/companion-text.js";
import type { OrchestratorTurn } from "../../src/core/orchestrator.js";
import { CONFIRMED_KEY, type PlanConfirmed } from "../../src/shared/orchestrator.js";
import { en } from "../../src/ui/i18n/en.js";

// When the planner hears a yes to a waiting plan, the turn carries `confirmed` and English text.
// The desktop shows the sentence in the person's language; the phone page does the same, from the
// words GET /api/text sends it.

const maestro = fs.readFileSync(path.join(import.meta.dirname, "../../companion/js/maestro.js"), "utf8");

/** A top-level function or one-line `const` of maestro.js, as written there. */
function pick(name: string): string {
  const found = maestro.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, "m"))?.[0] ?? maestro.match(new RegExp(`^const ${name} = .*$`, "m"))?.[0];
  if (!found) throw new Error(`maestro.js has no ${name}`);
  return found;
}

/** The page's own saidText(), run with the words a computer sent. */
function saidText(words: Record<string, string>): (turn: Partial<OrchestratorTurn>) => string {
  const context = vm.createContext({ words });
  vm.runInContext(`${pick("CONFIRMED_KEY")}\n${pick("saidText")}\nglobalThis.saidText = saidText;`, context);
  return context.saidText as (turn: Partial<OrchestratorTurn>) => string;
}

const WHYS = Object.keys(CONFIRMED_KEY) as PlanConfirmed[];

describe("Viby's answer to a yes, on the phone", () => {
  it("names the same words as the desktop for each kind of yes", () => {
    const page = vm.runInNewContext(`${pick("CONFIRMED_KEY")}; CONFIRMED_KEY`) as Record<string, string>;
    expect({ ...page }).toEqual(CONFIRMED_KEY);
  });

  it("sends those words to the phone in its language", async () => {
    for (const language of PHONE_LANGUAGES) {
      const [words, chosen] = await Promise.all([phoneWords(language), catalog(language)]);
      for (const key of Object.values(CONFIRMED_KEY)) expect(words[key], `${language} ${key}`).toBe(chosen[key]);
    }
    const de = await phoneWords("de");
    for (const key of Object.values(CONFIRMED_KEY)) expect(de[key]).not.toBe(en[key]);
  });

  it("keeps the kind of yes on the turns the phone gets, plan or not", () => {
    const turns: OrchestratorTurn[] = [
      { id: "t1", at: "", from: "vibeforge", text: en["core.orchConfirmedRan"], confirmed: "ran" },
      { id: "t2", at: "", from: "vibeforge", text: en["core.orchConfirmedRisky"], confirmed: "risky", plan: "waiting", steps: [] },
    ];
    const phone = buildPhoneOrchestrator({ view: { engineId: "claude", engineReady: true, mode: "plan", thinking: false, turns, copies: [] }, engines: [], workspaces: [], live: [], hear: false });
    expect(phone.turns.map((turn) => turn.confirmed)).toEqual(["ran", "risky"]);
  });

  it("shows each one in the phone's language, as the desktop does", async () => {
    for (const language of ["de", "ja", "fr"] as const) {
      const words = await phoneWords(language);
      const said = saidText(words);
      for (const why of WHYS) {
        expect(said({ from: "vibeforge", text: en[CONFIRMED_KEY[why]], confirmed: why })).toBe(words[CONFIRMED_KEY[why]]);
      }
    }
    expect(saidText(await phoneWords("de"))({ text: en["core.orchConfirmedRead"], confirmed: "read" })).toMatch(/^Dieser Plan ist noch nicht gelaufen: .*Los/);
  });

  it("shows the planner's own words as they were, and the saved English when the computer sent no such word", async () => {
    const said = saidText(await phoneWords("de"));
    expect(said({ from: "vibeforge", text: "On it." })).toBe("On it.");
    // An older computer, or a page still on the few English words it falls back on.
    const older = saidText({ "phone.back": "Zurück" });
    expect(older({ from: "vibeforge", text: en["core.orchConfirmedFix"], confirmed: "fix" })).toBe(en["core.orchConfirmedFix"]);
    // A kind of yes this page doesn't know yet.
    expect(said({ from: "vibeforge", text: "Something new.", confirmed: "later" as PlanConfirmed })).toBe("Something new.");
  });
});
