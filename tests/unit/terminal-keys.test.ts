import { describe, expect, it } from "vitest";
import { clipboardKey } from "../../src/ui/terminal-keys.js";

const key = (name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key: name,
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  altKey: Boolean(mods.alt),
  metaKey: Boolean(mods.meta),
});

describe("terminal clipboard keys", () => {
  it("copies with Ctrl+C only while text is selected, so an unselected Ctrl+C still interrupts", () => {
    expect(clipboardKey(key("c", { ctrl: true }), true)).toBe("copy");
    expect(clipboardKey(key("c", { ctrl: true }), false)).toBeNull();
  });

  it("pastes with Ctrl+V, leaving an image-only clipboard to the program", () => {
    expect(clipboardKey(key("v", { ctrl: true }), false)).toBe("paste-or-pass");
  });

  it("takes Omarchy's terminal keys and the shifted ones too", () => {
    expect(clipboardKey(key("Insert", { ctrl: true }), true)).toBe("copy");
    expect(clipboardKey(key("Insert", { shift: true }), false)).toBe("paste");
    expect(clipboardKey(key("C", { ctrl: true, shift: true }), false)).toBe("copy");
    expect(clipboardKey(key("V", { ctrl: true, shift: true }), false)).toBe("paste");
  });

  it("leaves everything else to the program", () => {
    expect(clipboardKey(key("x", { ctrl: true }), true)).toBeNull();
    expect(clipboardKey(key("c", { ctrl: true, alt: true }), true)).toBeNull();
    expect(clipboardKey(key("c"), true)).toBeNull();
  });
});
