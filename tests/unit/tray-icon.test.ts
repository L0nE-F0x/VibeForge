import { describe, expect, it, vi } from "vitest";

// The tray icon with Electron's Tray, Menu and images stood in for: what it shows while a call
// with Viby is on. The microphone is open then whether or not the window is, so the bar says so.

interface FakeImage {
  bitmap: Buffer;
  isEmpty: () => boolean;
  toBitmap: () => Buffer;
  resize: () => FakeImage;
}
const image = (bitmap: Buffer): FakeImage => {
  const made: FakeImage = { bitmap, isEmpty: () => false, toBitmap: () => bitmap, resize: () => made };
  return made;
};
const trays: Array<{ image: FakeImage; tip: string; menu: Array<{ label?: string; click?: () => void }> }> = [];

vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: () => image(Buffer.alloc(32 * 32 * 4)),
    createFromBitmap: (bitmap: Buffer) => image(bitmap),
  },
  Menu: { buildFromTemplate: (template: unknown) => template },
  Tray: class {
    private readonly seen = { image: null as unknown as FakeImage, tip: "", menu: [] as Array<{ label?: string; click?: () => void }> };
    constructor(first: FakeImage) {
      this.seen.image = first;
      trays.push(this.seen);
    }
    on(): void {}
    destroy(): void {}
    setImage(next: FakeImage): void {
      this.seen.image = next;
    }
    setToolTip(tip: string): void {
      this.seen.tip = tip;
    }
    setContextMenu(menu: Array<{ label?: string; click?: () => void }>): void {
      this.seen.menu = menu;
    }
  },
}));

const { TrayIcon } = await import("../../electron/tray.js");

/** The colour of one pixel, as #rrggbb (the bitmap is BGRA). */
function pixel(shown: FakeImage, x: number, y: number): string {
  const at = (y * 32 + x) * 4;
  return `#${[shown.bitmap[at + 2], shown.bitmap[at + 1], shown.bitmap[at]].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

describe("the tray icon during a call", () => {
  const words = {
    say: (key: string) => ({ "tray.status.call": "On a call with Viby: the microphone is open", "tray.status.nothing": "Nothing running", "call.hangUpTip": "Hang up the call with Viby", "tray.menu.open": "Open VibeForge" })[key] ?? key,
    count: (base: string, count: number) => `${count} ${base.split(".").pop()}`,
  };
  const state = { language: "en", live: 0, waiting: 0, waiters: [], sounds: true, notify: true, autostart: false, call: false };

  it("marks the icon, says the microphone is open, and offers Hang up for as long as the call lasts", () => {
    let hungUp = 0;
    const hangUpNow = () => {
      hungUp += 1;
    };
    const actions = { open: () => undefined, hangUp: hangUpNow, goAnywhere: () => undefined, openWaiter: () => undefined, settings: () => undefined, setSounds: () => undefined, setNotify: () => undefined, setAutostart: () => undefined, quit: () => undefined };
    const icon = new TrayIcon("/icon.png", { mark: "#ffaa00", outline: "#000000", call: "#ff5500" }, actions, words as never);
    icon.show(state);
    const tray = trays.at(-1);
    if (!tray) throw new Error("no tray");
    expect(tray.tip).toBe("VibeForge · Nothing running");
    expect(tray.menu.some((item) => item.label === "Hang up the call with Viby")).toBe(false);
    expect(pixel(tray.image, 31, 2)).toBe("#000000");

    icon.update({ ...state, call: true });
    expect(tray.tip).toBe("VibeForge · On a call with Viby: the microphone is open");
    // The upper right corner, in the call's colour; the lower right one is for someone waiting.
    expect(pixel(tray.image, 31, 2)).toBe("#ff5500");
    expect(pixel(tray.image, 31, 30)).toBe("#000000");
    const hangUp = tray.menu.find((item) => item.label === "Hang up the call with Viby");
    hangUp?.click?.();
    expect(hungUp).toBe(1);

    // Someone waiting as well: both corners.
    icon.update({ ...state, call: true, waiting: 1, waiters: ["Claude Code · api"] });
    expect(pixel(tray.image, 31, 2)).toBe("#ff5500");
    expect(pixel(tray.image, 31, 30)).toBe("#ffaa00");
    expect(tray.tip).toBe("VibeForge · On a call with Viby: the microphone is open · 1 waiting");

    icon.update(state);
    expect(pixel(tray.image, 31, 2)).toBe("#000000");
    expect(tray.menu.some((item) => item.label === "Hang up the call with Viby")).toBe(false);
  });
});
