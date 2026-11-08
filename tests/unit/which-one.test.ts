import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aboutPlace, WHICH_ONE } from "../../src/ui/components/WhichOne.js";
import { en } from "../../src/ui/i18n/en.js";
import { VIEWS } from "../../src/ui/rail.js";
import { SETTINGS_SECTIONS } from "../../src/ui/settings-sections.js";

// "Which one do I use?" is a reference card shown in the tour, in Help and in the README.
// The window's copy is checked when the built app is driven; these keep its rows honest and the
// README's table the same as the window's.

/** Table or catalog text as plain words: no bold, keycaps or links. */
const plain = (text: string) =>
  text
    .replace(/<kbd>(.*?)<\/kbd>/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .trim();

describe("which one do I use", () => {
  it("fits one screen", () => {
    expect(WHICH_ONE.length).toBeGreaterThanOrEqual(8);
    expect(WHICH_ONE.length).toBeLessThanOrEqual(10);
    expect(new Set(WHICH_ONE.map((row) => row.want)).size).toBe(WHICH_ONE.length);
  });

  it("names each place as the rail or Settings does", () => {
    for (const row of WHICH_ONE) {
      for (const place of row.places) {
        const { label, icon } = aboutPlace(place);
        expect(icon, row.want).toBeTruthy();
        if (place.view === "settings") {
          const section = SETTINGS_SECTIONS.find((item) => item.id === place.section);
          expect(label, row.want).toEqual(["rail.settings", section?.label]);
        } else {
          expect(label, row.want).toEqual([VIEWS.find((item) => item.view === place.view)?.label]);
        }
        for (const key of label) expect(en[key], key).toBeTruthy();
      }
    }
  });

  it("is the same table in the README", () => {
    const readme = fs.readFileSync(path.join(import.meta.dirname, "../../README.md"), "utf8");
    const section = readme.split("## Which one do I use?")[1]?.split("\n## ")[0] ?? "";
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| You want") && !line.startsWith("| ---"))
      .map((line) => line.slice(2, -2).split(" | ").map(plain));
    expect(rows.map(([want]) => want)).toEqual(WHICH_ONE.map((row) => plain(en[row.want])));
    rows.forEach(([, use], at) => {
      const names = WHICH_ONE[at].places.map((place) => aboutPlace(place).label.map((key) => en[key]).join(" → ")).join(" · ");
      expect(use.startsWith(names), `${use} starts with ${names}`).toBe(true);
    });
  });
});
