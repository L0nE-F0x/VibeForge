import { execFile } from "node:child_process";
import os from "node:os";
import { app } from "electron";
import { autostartFile, launcherCommand, readAutostart, writeAutostart } from "../src/core/autostart.js";
import { describeError } from "../src/core/log.js";
import type { MethodArgs, TrayWaiter } from "../src/shared/api.js";
import { attentionFrom, trayHostAnswer } from "./guards.js";
import type { MainContext } from "./main-context.js";
import { TrayIcon, type TrayState } from "./tray.js";
import { watchTrayHost } from "./tray-host.js";

// The tray icon and what it shows: who is waiting, the menu's switches, the login autostart entry,
// and whether the bar hosts tray icons at all, which decides what closing the window does.

export class TrayController {
  readonly icon: TrayIcon;
  /** CLIs and chats waiting for you, as the page counts and names them. */
  private waiting = 0;
  private waiters: TrayWaiter[] = [];
  /**
   * Whether anything hosts tray icons. Omarchy's bar does; a bar without a tray doesn't, and a window
   * closed to the tray there could only come back by launching VibeForge again.
   */
  private hosted = true;
  private readonly autostartPath = autostartFile(process.env, os.homedir());

  constructor(
    private readonly ctx: MainContext,
    quit: () => void,
  ) {
    const { focusWindow, send } = ctx;
    this.icon = new TrayIcon(
      ctx.iconPath,
      { mark: ctx.palette.accent2, outline: ctx.palette.darkerBackground },
      {
        open: () => focusWindow(),
        goAnywhere: () => {
          focusWindow();
          send("open-switcher", true);
        },
        openWaiter: (index) => {
          const waiter = this.waiters[index];
          focusWindow();
          if (waiter) send("open-route", { route: waiter.route });
        },
        settings: () => {
          focusWindow();
          send("open-view", { view: "settings" });
        },
        setSounds: (on) => {
          if (ctx.service) ctx.service.saveSettings({ sounds: { ...ctx.service.getSettings().sounds, on } });
        },
        setNotify: (on) => ctx.service?.saveSettings({ notify: on }),
        setAutostart: (on) => {
          this.setAutostart(on);
          this.sync();
        },
        quit,
      },
      ctx.words,
    );
  }

  /** Whether the bar hosts tray icons, as last checked. */
  get host(): boolean {
    return this.hosted;
  }

  /** Whether VibeForge starts at login. */
  get autostart(): boolean {
    return readAutostart(this.autostartPath);
  }

  setAutostart(on: boolean): void {
    try {
      writeAutostart(this.autostartPath, on, this.launcher());
      this.ctx.log.info(`Start at login ${on ? "on" : "off"} (${this.autostartPath})`);
    } catch (error) {
      this.ctx.log.warn(`Could not change the autostart entry: ${describeError(error)}`);
    }
  }

  private launcher(): string {
    return launcherCommand(process.env, os.homedir(), `"${process.execPath}" "${this.ctx.appRoot}"`);
  }

  /** Who the page says is waiting; the menu changes only when that does. */
  attention(state: MethodArgs<"app.attention">[0]): void {
    const { count, waiters } = attentionFrom(state);
    if (count === this.waiting && JSON.stringify(waiters) === JSON.stringify(this.waiters)) return;
    this.waiting = count;
    this.waiters = waiters;
    this.sync();
  }

  private state(): TrayState {
    const settings = this.ctx.service!.getSettings();
    return {
      language: this.ctx.words.language,
      live: this.ctx.service!.liveCount(),
      waiting: this.waiting,
      waiters: this.waiters.map((waiter) => waiter.label),
      sounds: settings.sounds.on,
      notify: settings.notify,
      autostart: readAutostart(this.autostartPath),
    };
  }

  /** Shows the icon when Settings want it and brings its menu up to date. */
  sync(): void {
    const { service } = this.ctx;
    if (!service) return;
    try {
      if (service.getSettings().tray) this.icon.show(this.state());
      // Electron can't take an icon out of the bar's tray while it runs (the entry stays behind,
      // dead), so switching it off applies from the next start; until then it keeps working.
      else if (this.icon.shown) this.icon.update(this.state());
    } catch (error) {
      this.ctx.log.warn(`The tray icon: ${describeError(error)}`);
    }
  }

  /** Follow Settings' language (or the desktop's), then rebuild the tray menu in it. */
  syncWords(): void {
    const { service, words, log } = this.ctx;
    if (!service) return;
    void words
      .use(service.getSettings().language, app.getLocale())
      .then(() => this.sync())
      .catch((error: unknown) => log.warn(`Translations: ${describeError(error)}`));
  }

  private findHost(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        "dbus-send",
        ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.kde.StatusNotifierWatcher"],
        { timeout: 2000 },
        (error, stdout) => resolve(trayHostAnswer(error, stdout)),
      );
    });
  }

  /** Checks again whether anything hosts the tray, saying so in the log when that changed. */
  refreshHost(): void {
    void this.findHost().then((found) => {
      if (found !== this.hosted) this.ctx.log.info(found ? "A tray host is back; closing the window keeps VibeForge in the tray" : "Nothing hosts the tray; closing the window quits VibeForge");
      this.hosted = found;
    });
  }

  /** At login the bar can come up after VibeForge, so a missing tray host gets a few seconds to appear. */
  async waitForHost(ms: number): Promise<boolean> {
    const found = await this.untilHost(ms);
    this.hosted = found;
    return found;
  }

  private async untilHost(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (!(await this.findHost())) {
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return true;
  }

  /** Makes the icon again for each new tray host, as a bar restart needs. Returns a stop. */
  watchHost(): () => void {
    const { log } = this.ctx;
    return watchTrayHost(
      (owner) => {
        this.hosted = owner !== "";
        if (!owner || !this.icon.shown) return;
        log.info("A new tray host; adding the icon to it");
        try {
          this.icon.remake();
        } catch (error) {
          log.warn(`The tray icon: ${describeError(error)}`);
        }
      },
      (message) => log.warn(message),
    );
  }
}
