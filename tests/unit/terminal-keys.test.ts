import { describe, expect, it } from "vitest";
import { appShortcut, clipboardKey, isWebLink } from "../../src/ui/terminal-keys.js";

const key = (name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, code = "") => ({
  key: name,
  code,
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

describe("app shortcuts in a terminal", () => {
  it("keeps the app's Ctrl+Shift keys from the program", () => {
    for (const letter of ["I", "B", "M", "D", "E", "W", "K", "O"]) expect(appShortcut(key(letter, { ctrl: true, shift: true }))).toBe(true);
    expect(appShortcut(key("?", { ctrl: true, shift: true }, "Slash"))).toBe(true);
    expect(appShortcut(key("3", { ctrl: true }))).toBe(true);
    expect(appShortcut(key("3", { alt: true }, "Digit3"))).toBe(true);
  });

  it("leaves Ctrl+Shift+L to the program: nothing in the app uses it", () => {
    expect(appShortcut(key("L", { ctrl: true, shift: true }))).toBe(false);
    expect(appShortcut(key("k", { ctrl: true }))).toBe(false);
  });
});

describe("links a terminal opens", () => {
  it("opens http and https only", () => {
    expect(isWebLink("https://github.com/L0nE-F0x/VibeForge/pull/70")).toBe(true);
    expect(isWebLink("http://localhost:5173/")).toBe(true);
    for (const uri of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/x", "not a url", ""]) expect(isWebLink(uri)).toBe(false);
  });
});
