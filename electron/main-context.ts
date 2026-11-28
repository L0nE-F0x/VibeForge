import path from "node:path";
import type { BrowserWindow, NativeImage } from "electron";
import type { Roots } from "../src/core/layout.js";
import type { LogFile } from "../src/core/log.js";
import type { MainText } from "../src/core/main-text.js";
import type { TeamService } from "../src/core/team-service.js";
import type { Palette } from "../src/core/theme.js";
import type { InstallKind } from "../src/core/updates.js";
import type { DeskEvents, DeskNotice } from "../src/shared/api.js";
import type { Looking } from "../src/shared/orchestrator.js";
import type { AppPage } from "./guards.js";
import type { PtySupervisor } from "./supervisor.js";
import { UnexpectedErrors } from "./unexpected.js";

// What the main process's parts share. main.ts makes one and hands it to each module beside it,
// so the window, the core and the quit flag each have this one owner instead of a copy per file.

/** How many "proposed a memory line" notices wait for the page: one per agent, the newest few. */
const PROPOSED_HELD = 5;

/**
 * The notices waiting for the next page, with `notice` added. Each kind waits once (the newest);
 * memory proposals wait once per agent and only the newest few, so a burst of them never pushes
 * out a host-stopped or errors notice.
 */
export function holdNotice(held: readonly DeskNotice[], notice: DeskNotice): DeskNotice[] {
  const kind = (item: DeskNotice) => (item.id === "memory-proposed" ? `${item.id}:${item.agentId}` : item.id);
  const next = [...held.filter((item) => kind(item) !== kind(notice)), notice];
  const proposed = next.filter((item) => item.id === "memory-proposed");
  const drop = new Set<DeskNotice>(proposed.slice(0, Math.max(0, proposed.length - PROPOSED_HELD)));
  return next.filter((item) => !drop.has(item));
}

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
  /** Made before anything else in main.ts, so an error during start counts too. */
  unexpected?: UnexpectedErrors;
}

export class MainContext {
  readonly roots: Roots;
  readonly log: LogFile;
  readonly supervisor: PtySupervisor;
  readonly words: MainText;
  readonly appRoot: string;
  readonly install: InstallKind;
  readonly iconPath: string;
  /** Errors nothing handled, counted and told (unexpected.ts). */
  readonly unexpected: UnexpectedErrors;
  /** The icon in the theme's colours (src/core/brand-icon.ts), once drawn; until then iconPath. */
  brandIcon: NativeImage | null = null;
  /** The one page that runs with the preload's bridge. */
  readonly page: AppPage;
  /** The window, from createWindow until it closes. */
  win: BrowserWindow | null = null;
  /** The core: made once Electron is ready, gone again after shutdown. */
  service: TeamService | null = null;
  palette: Palette;
  /** Where the person is in the window (its view, and in Code the workspace and terminal), as the page last said. */
  looking: Looking | null = null;
  /** A quit has begun: the window closes without asking, and the terminal host stays down. */
  quitting = false;
  /** Why this quit is happening, when it is a restart to finish an update; else an ordinary quit. */
  closeReason: "update" | null = null;
  /** Notices said while no page was listening, for the next one; one of each kind, the newest. */
  private pendingNotices: DeskNotice[] = [];
  /** A page has taken its notices since it last loaded, so it hears new ones as they happen. */
  private pageListening = false;

  constructor(options: MainContextOptions) {
    this.roots = options.roots;
    this.log = options.log;
    this.supervisor = options.supervisor;
    this.words = options.words;
    this.appRoot = options.appRoot;
    this.install = options.install;
    this.palette = options.palette;
    this.unexpected = options.unexpected ?? new UnexpectedErrors();
    this.unexpected.attach(this.notice);
    this.iconPath = path.join(options.appRoot, "resources", "icon.png");
    this.page = { file: path.join(options.appRoot, "dist", "index.html"), devUrl: process.env.VITE_DEV_SERVER_URL };
  }

  // Arrow functions, so they can be handed around as callbacks.

  readonly send: Send = (event, payload) => {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(`vf:${event}`, payload);
  };

  /** Tells the person something once: now, when a page listens, or as the next page loads. */
  readonly notice = (notice: DeskNotice): void => {
    if (this.pageListening && this.win && !this.win.isDestroyed()) {
      this.send("notice", notice);
      return;
    }
    this.pendingNotices = holdNotice(this.pendingNotices, notice);
  };

  /** The page's first call: what it missed. From now on it hears notices as they happen. */
  readonly takeNotices = (): DeskNotice[] => {
    this.pageListening = true;
    const missed = this.pendingNotices;
    this.pendingNotices = [];
    return missed;
  };

  /** The page went (crashed, reloading, closed): notices wait for the next one. */
  readonly pageGone = (): void => {
    this.pageListening = false;
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
