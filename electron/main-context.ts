import path from "node:path";
import type { BrowserWindow } from "electron";
import type { Roots } from "../src/core/layout.js";
import type { LogFile } from "../src/core/log.js";
import type { MainText } from "../src/core/main-text.js";
import type { TeamService } from "../src/core/team-service.js";
import type { Palette } from "../src/core/theme.js";
import type { InstallKind } from "../src/core/updates.js";
import type { DeskEvents } from "../src/shared/api.js";
import type { AppPage } from "./guards.js";
import type { PtySupervisor } from "./supervisor.js";

// What the main process's parts share. main.ts makes one and hands it to each module beside it,
// so the window, the core and the quit flag each have this one owner instead of a copy per file.

/** Sends an event to the window's page, when there is one. */
export type Send = <K extends keyof DeskEvents>(event: K, payload: DeskEvents[K]) => void;

export interface MainContextOptions {
  roots: Roots;
  log: LogFile;
  supervisor: PtySupervisor;
  /** The main process's own words, in the window's language. */
  words: MainText;
  /** Where the app runs from (app.getAppPath()). */
  appRoot: string;
  install: InstallKind;
  palette: Palette;
}

export class MainContext {
  readonly roots: Roots;
  readonly log: LogFile;
  readonly supervisor: PtySupervisor;
  readonly words: MainText;
  readonly appRoot: string;
  readonly install: InstallKind;
  readonly iconPath: string;
  /** The one page that runs with the preload's bridge. */
  readonly page: AppPage;
  /** The window, from createWindow until it closes. */
  win: BrowserWindow | null = null;
  /** The core: made once Electron is ready, gone again after shutdown. */
  service: TeamService | null = null;
  palette: Palette;
  /** A quit has begun: the window closes without asking, and the terminal host stays down. */
  quitting = false;

  constructor(options: MainContextOptions) {
    this.roots = options.roots;
    this.log = options.log;
    this.supervisor = options.supervisor;
    this.words = options.words;
    this.appRoot = options.appRoot;
    this.install = options.install;
    this.palette = options.palette;
    this.iconPath = path.join(options.appRoot, "resources", "icon.png");
    this.page = { file: path.join(options.appRoot, "dist", "index.html"), devUrl: process.env.VITE_DEV_SERVER_URL };
  }

  // Arrow functions, so they can be handed around as callbacks.

  readonly send: Send = (event, payload) => {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(`vf:${event}`, payload);
  };

  readonly svc = (): TeamService => {
    if (!this.service) throw new Error("VibeForge is still starting.");
    return this.service;
  };

  readonly focusWindow = (): void => {
    const win = this.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
}
