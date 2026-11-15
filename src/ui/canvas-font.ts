// Chromium 156 (Electron 45.2.3) ignores a canvas font that starts with a space and keeps its
// default, "10px sans-serif". xterm's WebGL renderer draws its glyphs with
// `${italic} ${weight} ${size}px ${family}`, which starts with a space whenever the text isn't
// italic, so every terminal drew tiny proportional letters spread across monospace cells (Electron
// 45.2.1 accepted it). Trimming the font before Chromium reads it keeps the terminal's font, whatever
// a later Chromium does.

const patched = new WeakSet<object>();

/** Makes `font` on this canvas context prototype trim what it is given. False when there was nothing to do. */
export function trimFontSetter(proto: object | undefined): boolean {
  if (!proto || patched.has(proto)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "font");
  const set = descriptor?.set;
  if (!descriptor || !set) return false;
  Object.defineProperty(proto, "font", {
    ...descriptor,
    set(this: unknown, value: unknown) {
      set.call(this, typeof value === "string" ? value.trim() : value);
    },
  });
  patched.add(proto);
  return true;
}

/** Applies the trim to on-screen and offscreen canvases, before any terminal is made. */
export function installCanvasFontTrim(scope: typeof globalThis = globalThis): void {
  trimFontSetter(scope.CanvasRenderingContext2D?.prototype);
  trimFontSetter(scope.OffscreenCanvasRenderingContext2D?.prototype);
}
