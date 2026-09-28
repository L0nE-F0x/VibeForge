import { describe, expect, it } from "vitest";
import { notesBlocks } from "../../src/ui/notes.js";

describe("notesBlocks", () => {
  it("reads the paragraphs, lists and headings release notes are written in", () => {
    const notes = [
      "**A desk that keeps your place.**",
      "",
      "- **Views remember where you were**, even after a restart.",
      "- **Sounds.** Short tones",
      "  made on your machine.",
      "* A star bullet",
      "",
      "## Fixed",
      "See [the changelog](https://example.com/changelog) for the rest,",
      "wrapped onto a second line.",
    ].join("\r\n");
    expect(notesBlocks(notes)).toEqual([
      { kind: "para", text: "**A desk that keeps your place.**" },
      { kind: "list", items: ["**Views remember where you were**, even after a restart.", "**Sounds.** Short tones made on your machine.", "A star bullet"] },
      { kind: "head", text: "Fixed" },
      { kind: "para", text: "See the changelog for the rest, wrapped onto a second line." },
    ]);
  });

  it("starts a new list after a blank line, and gives nothing for empty notes", () => {
    expect(notesBlocks("- one\n\n- two")).toEqual([
      { kind: "list", items: ["one"] },
      { kind: "list", items: ["two"] },
    ]);
    expect(notesBlocks("  \n\n")).toEqual([]);
  });
});
