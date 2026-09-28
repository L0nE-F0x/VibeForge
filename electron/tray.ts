import { Menu, nativeImage, Tray, type NativeImage } from "electron";

// VibeForge in the system tray: Omarchy's bar lists it with Steam and the rest, and it can be
// pinned to the bar from there. A left click opens the window; the right-click menu has the few
// switches worth flipping without opening it. The icon gets an amber corner while something is
// waiting for you.

export interface TrayState {
  live: number;
  waiting: number;
  sounds: boolean;
  notify: boolean;
  autostart: boolean;
}

export interface TrayActions {
  open(): void;
  goAnywhere(): void;
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

/** The app icon with a square pixel in the corner, outlined so it reads on any bar. */
function withMark(base: NativeImage, color: string, outline: string): NativeImage {
  const bitmap = Buffer.from(base.toBitmap());
  const [r, g, b] = hexRgb(color);
  const [or, og, ob] = hexRgb(outline);
  for (let y = SIZE - MARK; y < SIZE; y += 1) {
    for (let x = SIZE - MARK; x < SIZE; x += 1) {
      const edge = x === SIZE - MARK || y === SIZE - MARK;
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

function status(state: TrayState): string {
  const parts: string[] = [];
  if (state.waiting) parts.push(`${state.waiting} waiting for you`);
  if (state.live) parts.push(`${state.live} running`);
  return parts.length ? parts.join(" · ") : "Nothing running";
}

export class TrayIcon {
  private tray: Tray | null = null;
  private images: { plain: NativeImage; marked: NativeImage } | null = null;
  private state: TrayState | null = null;

  constructor(
    private iconPath: string,
    private colors: { mark: string; outline: string },
    private actions: TrayActions,
  ) {}

  /** Made on first use: image work waits for the app to be ready. */
  private icons(): { plain: NativeImage; marked: NativeImage } {
    if (!this.images) {
      const plain = nativeImage.createFromPath(this.iconPath).resize({ width: SIZE, height: SIZE, quality: "best" });
      this.images = { plain, marked: plain.isEmpty() ? plain : withMark(plain, this.colors.mark, this.colors.outline) };
    }
    return this.images;
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

  recolor(mark: string, outline: string): void {
    if (mark === this.colors.mark && outline === this.colors.outline) return;
    this.colors = { mark, outline };
    this.images = null;
    if (this.tray && this.state) this.tray.setImage(this.state.waiting ? this.icons().marked : this.icons().plain);
  }

  update(state: TrayState): void {
    const tray = this.tray;
    if (!tray) return;
    const was = this.state;
    this.state = state;
    if (!was || Boolean(was.waiting) !== Boolean(state.waiting)) tray.setImage(state.waiting ? this.icons().marked : this.icons().plain);
    if (was && JSON.stringify(was) === JSON.stringify(state)) return;
    tray.setToolTip(`VibeForge · ${status(state)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open VibeForge", click: () => this.actions.open() },
        { label: status(state), enabled: false },
        { label: "Go to anything…", accelerator: "Ctrl+K", click: () => this.actions.goAnywhere() },
        { type: "separator" },
        { label: "Sounds", type: "checkbox", checked: state.sounds, click: (item) => this.actions.setSounds(item.checked) },
        { label: "Notifications", type: "checkbox", checked: state.notify, click: (item) => this.actions.setNotify(item.checked) },
        { label: "Start at login, in the tray", type: "checkbox", checked: state.autostart, click: (item) => this.actions.setAutostart(item.checked) },
        { type: "separator" },
        { label: "Settings…", click: () => this.actions.settings() },
        { label: "Quit VibeForge", click: () => this.actions.quit() },
      ]),
    );
  }
}
