import { describe, expect, it } from "vitest";
import { installCanvasFontTrim, trimFontSetter } from "../../src/ui/canvas-font.js";

/** A context whose font setter behaves like Chromium 156's: a leading space and the font is ignored. */
function strictContext() {
  class Context {
    #font = "10px sans-serif";
    get font() {
      return this.#font;
    }
    set font(value: string) {
      if (/^\s/.test(value)) return;
      this.#font = value;
    }
  }
  return Context;
}

describe("canvas font trim", () => {
  it("keeps the font xterm's WebGL renderer asks for, which starts with a space", () => {
    const Context = strictContext();
    const before = new Context();
    before.font = ' normal 16.25px "JetBrainsMono Nerd Font", monospace';
    expect(before.font).toBe("10px sans-serif");

    expect(trimFontSetter(Context.prototype)).toBe(true);
    const after = new Context();
    after.font = ' normal 16.25px "JetBrainsMono Nerd Font", monospace';
    expect(after.font).toBe('normal 16.25px "JetBrainsMono Nerd Font", monospace');
    after.font = "italic bold 13px monospace";
    expect(after.font).toBe("italic bold 13px monospace");
  });

  it("wraps each prototype once and leaves ones without a font setter alone", () => {
    const Context = strictContext();
    expect(trimFontSetter(Context.prototype)).toBe(true);
    expect(trimFontSetter(Context.prototype)).toBe(false);
    const context = new Context();
    context.font = "  13px monospace  ";
    expect(context.font).toBe("13px monospace");
    expect(trimFontSetter({})).toBe(false);
    expect(trimFontSetter(undefined)).toBe(false);
  });

  it("covers on-screen and offscreen canvases, and is fine where neither exists", () => {
    const OnScreen = strictContext();
    const Offscreen = strictContext();
    installCanvasFontTrim({ CanvasRenderingContext2D: OnScreen, OffscreenCanvasRenderingContext2D: Offscreen } as unknown as typeof globalThis);
    for (const Context of [OnScreen, Offscreen]) {
      const context = new Context();
      context.font = " 13px monospace";
      expect(context.font).toBe("13px monospace");
    }
    expect(() => installCanvasFontTrim({} as typeof globalThis)).not.toThrow();
  });
});
