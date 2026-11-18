import type { Key } from "../src/core/companion-text.js";
import { Menu, nativeImage, Tray, type NativeImage } from "electron";

// VibeForge in the system tray: Omarchy's bar lists it with Steam and the rest, and it can be
// pinned to the bar from there. A left click opens the window; the right-click menu has the few
// switches worth flipping without opening it. The icon gets an amber corner while something is
// waiting for you.

export interface TrayState {
  /** The language the menu is in; a change rebuilds it. */
  language: string;
  live: number;
  waiting: number;
  /** Who is waiting, by name, at most a few: each opens where it waits. */
  waiters: string[];
  sounds: boolean;
  notify: boolean;
  autostart: boolean;
  /** A call with Viby is on: the microphone is open, whether or not the window is. */
  call: boolean;
}

export interface TrayActions {
  open(): void;
  hangUp(): void;
  goAnywhere(): void;
  openWaiter(index: number): void;
  settings(): void;
  setSounds(on: boolean): void;
  setNotify(on: boolean): void;
  setAutostart(on: boolean): void;
  quit(): void;
}

const SIZE = 32;
const MARK = 11;

function hexRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  const value = match ? parseInt(match[1], 16) : 0xf5a524;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * The app icon with a square pixel in a corner, outlined so it reads on any bar: the lower right
 * one for someone waiting, the upper right one (`top`) for an open microphone.
 */
function withMark(base: NativeImage, color: string, outline: string, top = false): NativeImage {
  const bitmap = Buffer.from(base.toBitmap());
  const [r, g, b] = hexRgb(color);
  const [or, og, ob] = hexRgb(outline);
  const from = top ? 0 : SIZE - MARK;
  for (let y = from; y < from + MARK; y += 1) {
    for (let x = SIZE - MARK; x < SIZE; x += 1) {
      const edge = x === SIZE - MARK || y === (top ? MARK - 1 : SIZE - MARK);
      const at = (y * SIZE + x) * 4;
      // Chromium bitmaps are BGRA.
      bitmap[at] = edge ? ob : b;
      bitmap[at + 1] = edge ? og : g;
      bitmap[at + 2] = edge ? or : r;
      bitmap[at + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: SIZE, height: SIZE });
}

/** The menu's words, in the window's language (src/core/main-text.ts). */
export interface TrayWords {
  say(key: Key): string;
  count(base: string, count: number): string;
}

function status(state: TrayState, words: TrayWords): string {
  const parts: string[] = [];
  if (state.call) parts.push(words.say("tray.status.call"));
  if (state.waiting) parts.push(words.count("tray.status.waiting", state.waiting));
  if (state.live) parts.push(words.count("tray.status.running", state.live));
  return parts.length ? parts.join(" · ") : words.say("tray.status.nothing");
}

export class TrayIcon {
  private tray: Tray | null = null;
  private images: { plain: NativeImage; marked: NativeImage; calling: NativeImage; both: NativeImage } | null = null;
  private state: TrayState | null = null;
  /** The icon in the theme's colours; without it, the one at iconPath. */
  private base: NativeImage | null = null;

  constructor(
    private iconPath: string,
    private colors: { mark: string; outline: string; call: string },
    private actions: TrayActions,
    private words: TrayWords,
  ) {}

  /** Made on first use: image work waits for the app to be ready. */
  private icons(): { plain: NativeImage; marked: NativeImage; calling: NativeImage; both: NativeImage } {
    if (!this.images) {
      const plain = (this.base ?? nativeImage.createFromPath(this.iconPath)).resize({ width: SIZE, height: SIZE, quality: "best" });
      if (plain.isEmpty()) this.images = { plain, marked: plain, calling: plain, both: plain };
      else {
        const marked = withMark(plain, this.colors.mark, this.colors.outline);
        this.images = { plain, marked, calling: withMark(plain, this.colors.call, this.colors.outline, true), both: withMark(marked, this.colors.call, this.colors.outline, true) };
      }
    }
    return this.images;
  }

  /** The icon for what is going on: someone waiting, a call, both or neither. */
  private imageFor(state: TrayState): NativeImage {
    const icons = this.icons();
    return state.call ? (state.waiting ? icons.both : icons.calling) : state.waiting ? icons.marked : icons.plain;
  }

  get shown(): boolean {
    return this.tray !== null;
  }

  show(state: TrayState): void {
    if (!this.tray) {
      this.tray = new Tray(this.icons().plain);
      this.tray.on("click", () => this.actions.open());
      this.state = null;
    }
    this.update(state);
  }

  /** A new tray host doesn't know the old icon, and Electron won't register it again: make it anew. */
  remake(): void {
    if (!this.tray || !this.state) return;
    const state = this.state;
    this.tray.destroy();
    this.tray = null;
    this.show(state);
  }

  recolor(mark: string, outline: string, base: NativeImage | null = this.base, call: string = this.colors.call): void {
    if (mark === this.colors.mark && outline === this.colors.outline && call === this.colors.call && base === this.base) return;
    this.colors = { mark, outline, call };
    this.base = base && !base.isEmpty() ? base : null;
    this.images = null;
    if (this.tray && this.state) this.tray.setImage(this.imageFor(this.state));
  }

  update(state: TrayState): void {
    const tray = this.tray;
    if (!tray) return;
    const was = this.state;
    this.state = state;
    if (!was || Boolean(was.waiting) !== Boolean(state.waiting) || was.call !== state.call) tray.setImage(this.imageFor(state));
    if (was && JSON.stringify(was) === JSON.stringify(state)) return;
    const say = (key: Key) => this.words.say(key);
    tray.setToolTip(`VibeForge · ${status(state, this.words)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: say("tray.menu.open"), click: () => this.actions.open() },
        // While the microphone is open, the way to close it is here too, window or no window.
        ...(state.call ? [{ label: say("call.hangUpTip"), click: () => this.actions.hangUp() }] : []),
        ...state.waiters.map((label, index) => ({ label, click: () => this.actions.openWaiter(index) })),
        { label: status(state, this.words), enabled: false },
        { label: say("tray.menu.goAnywhere"), accelerator: "Ctrl+K", click: () => this.actions.goAnywhere() },
        { type: "separator" },
        { label: say("tray.menu.sounds"), type: "checkbox", checked: state.sounds, click: (item) => this.actions.setSounds(item.checked) },
        { label: say("tray.menu.notify"), type: "checkbox", checked: state.notify, click: (item) => this.actions.setNotify(item.checked) },
        { label: say("tray.login"), type: "checkbox", checked: state.autostart, click: (item) => this.actions.setAutostart(item.checked) },
        { type: "separator" },
        { label: say("tray.menu.settings"), click: () => this.actions.settings() },
        { label: say("tray.menu.quit"), click: () => this.actions.quit() },
      ]),
    );
  }
}
