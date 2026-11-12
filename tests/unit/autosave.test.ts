import { describe, expect, it } from "vitest";
import { autosaveDue, oneLine } from "../../src/ui/autosave.js";

describe("autosave", () => {
  it("saves a change once, and doesn't try the same value again and again", () => {
    expect(autosaveDue('"a"', null, true, true)).toBe(true);
    // Saved (or refused): the same value stays put until it changes.
    expect(autosaveDue('"a"', '"a"', true, true)).toBe(false);
    expect(autosaveDue('"ab"', '"a"', true, true)).toBe(true);
    expect(autosaveDue('"ab"', null, false, true)).toBe(false);
    expect(autosaveDue('"ab"', null, true, false)).toBe(false);
  });

  it("compares Good at the way the core stores it, so two spaces don't keep it unsaved", () => {
    expect(oneLine("  small   edits\n and icons ")).toBe("small edits and icons");
    expect(oneLine("x".repeat(200))).toHaveLength(160);
  });
});
