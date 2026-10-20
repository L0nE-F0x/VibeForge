import { describe, expect, it } from "vitest";
import { MainText } from "../../src/core/main-text.js";
import { quotaNote } from "../../src/core/quota-alerts.js";
import { changesText, parseChanges } from "../../src/shared/changes.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../../src/shared/text.js";
import { changesFor } from "../../src/ui/changes-text.js";
import { textSnippet } from "../../src/ui/fuzzy.js";
import { loadLanguage, translate, translateCount, type Language, type Translator } from "../../src/ui/i18n/index.js";
import { scheduleText } from "../../src/ui/schedule-text.js";

function translator(language: Language): Translator {
  const t = ((key, vars) => translate(language, key, vars)) as Translator;
  t.count = (base, count, vars) => translateCount(language, base, count, vars);
  t.language = language;
  return t;
}

describe("the last English, translated", () => {
  it("reads git's change summaries and says them in the reader's language", async () => {
    expect(parseChanges("2 commits · 3 files changed, 10 insertions(+), 1 deletion(-) · 1 new file")).toEqual([
      { kind: "commits", count: 2 },
      { kind: "files", count: 3, plus: 10, minus: 1 },
      { kind: "new", count: 1 },
    ]);
    expect(parseChanges("1 file changed, 1 deletion(-)")).toEqual([{ kind: "files", count: 1, plus: 0, minus: 1 }]);
    expect(parseChanges("something git never said")).toBeNull();
    await loadLanguage("de");
    expect(changesFor("2 commits · 3 files changed, 10 insertions(+), 1 deletion(-) · 1 new file", translator("de"))).toBe("2 Commits · 3 Dateien +10 −1 · 1 neue Datei");
    expect(changesFor("No changes", translator("de"))).toBe("Keine Änderungen");
    expect(changesFor("1 file touched", translator("en"))).toBe("1 file touched");
    expect(changesText("odd text", { count: () => "x", say: () => "y" })).toBe("odd text");
  });

  it("describes schedules in the window's language, on its clock", async () => {
    await loadLanguage("de");
    await loadLanguage("ja");
    expect(scheduleText({ kind: "every", minutes: 1440 }, translator("en"))).toBe("Every day");
    expect(scheduleText({ kind: "every", minutes: 120 }, translator("de"))).toBe("Alle 2 Stunden");
    expect(scheduleText({ kind: "every", minutes: 15 }, translator("ja"))).toBe("15 分ごと");
    expect(scheduleText({ kind: "cron", expr: "0 18 * * *" }, translator("en"))).toBe("At 06:00 PM");
    expect(scheduleText({ kind: "cron", expr: "0 18 * * *" }, translator("de"))).toBe("Um 18:00");
    expect(scheduleText({ kind: "cron", expr: "not cron" }, translator("de"), "fallback")).toBe("fallback");
  });

  it("puts the core's notification bodies, the menu and plan alerts in the chosen language", async () => {
    const words = new MainText();
    expect(words.coreText("exited with code 2 · 1 file changed, 2 insertions(+)")).toBe("exited with code 2 · 1 file changed, 2 insertions(+)");
    await words.use("de", "en-US");
    expect(words.language).toBe("de");
    expect(words.coreText("exited with code 2 · 1 file changed, 2 insertions(+) · failed 3 times in a row")).toBe("mit Code 2 beendet · 1 Datei +2 −0 · 3-mal in Folge fehlgeschlagen");
    expect(words.coreText("waiting for Claude Code to finish")).toBe("wartet, bis Claude Code fertig ist");
    expect(words.coreText("couldn't start: That folder does not exist any more.")).toBe("konnte nicht starten: Dieser Ordner existiert nicht mehr.");
    expect(words.coreText("A sentence nobody wrote down")).toBe("A sentence nobody wrote down");
    expect(words.count("main.quit", 1)).toBe("1 Terminal läuft noch.");
    expect(words.count("tray.status.running", 3)).toBe("3 laufen");
    expect(quotaNote({ plan: "claude", window: "5-hour", step: 95, percent: 96.4, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }, Date.now(), words.alerts())).toEqual({
      title: "Claude: 96 % des 5-hour-Limits verbraucht",
      body: "Wird in 1h 30m zurückgesetzt.",
    });
    // "system" follows the desktop.
    await words.use("system", "fr-FR");
    expect(words.say("tray.menu.quit")).toBe("Quitter VibeForge");
  });

  it("finds a task, routine or skill by what it says, with the words around it", () => {
    expect(textSnippet("deploy", "Run the tests, then deploy to staging and tell me")).toBe(`Run the tests, then ${SNIPPET_OPEN}deploy${SNIPPET_CLOSE} to staging and tell me`);
    expect(textSnippet("de", "deploy")).toBeNull();
    expect(textSnippet("missing", "deploy")).toBeNull();
    expect(textSnippet("needle", `${"x".repeat(80)} needle ${"y".repeat(80)}`)).toMatch(/^…x+ \u0002needle\u0003 y+…$/);
  });
});
