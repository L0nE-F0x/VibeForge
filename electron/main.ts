import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, Menu, nativeImage, powerMonitor, session } from "electron";
import { HIDDEN_ARG } from "../src/core/autostart.js";
import { voiceArg } from "../src/core/control.js";
import { defaultRoots, ensureLayout } from "../src/core/layout.js";
import { holdFolders } from "../src/core/folder-lock.js";
import { describeError, LogFile } from "../src/core/log.js";
import { MainText } from "../src/core/main-text.js";
import { TeamService } from "../src/core/team-service.js";
import { iconColors, iconPng, refreshLauncherIcons } from "../src/core/brand-icon.js";
import { resolvePalette, watchOmarchyTheme } from "../src/core/theme.js";
import { INSTALLER_MARK, installKind, RELEASES_URL, updateCommand } from "../src/core/updates.js";
import { savedDockUrl } from "../src/shared/dock-url.js";
import { tildify } from "../src/shared/text.js";
import { syncCompanion } from "./companion.js";
import { watchConfig } from "./config-watch.js";
import { listenControl } from "./control.js";
import { debugSwitch, guardSession, guardWebContents, secondStartArgs, type GuardableWebContents } from "./guards.js";
import { Dock } from "./dock.js";
import { clearOldDownloadCopies } from "./download.js";
import { deskHost, HostLifecycle } from "./host-lifecycle.js";
import { answerTalk, registerIpc } from "./ipc.js";
import { MainContext } from "./main-context.js";
import { desktopNotifier } from "./notify.js";
import { Quit } from "./quit.js";
import { Stats } from "./stats.js";
import { PtySupervisor } from "./supervisor.js";
import { Sync } from "./sync.js";
import { adoptShellPath, osDescription, settleWorkingDir } from "./system.js";
import { Call } from "./call.js";
import { Disposables, startSchedules } from "./timers.js";
import { TrayController } from "./tray-controller.js";
import { UnexpectedErrors } from "./unexpected.js";
import { Updater } from "./updater.js";
import { companionWire, makeVoice } from "./voice-phone.js";
import { MainWindow } from "./window.js";

// The main process's entry: it makes the shared context and each part beside it (window.ts, ipc.ts,
// host-lifecycle.ts, tray-controller.ts, notify.ts, quit.ts, timers.ts and the rest) in a fixed
// order, then starts them once Electron is ready. The order is part of the behaviour: keep it.

const APP_ID = "dev.vibeforge.app";
const roots = defaultRoots();
ensureLayout(roots.configRoot, roots.dataRoot);
const log = new LogFile(path.join(roots.dataRoot, "logs", "vibeforge.log"));
settleWorkingDir(log);

// Logged, counted and told (unexpected.ts): VibeForge carries on, but something may be half done.
const unexpected = new UnexpectedErrors();
process.on("uncaughtException", (error) => {
  console.error(error);
  log.error(`Uncaught error in the main process: ${describeError(error)}`);
  unexpected.add();
});
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection in the main process: ${describeError(reason)}`);
  unexpected.add();
});

app.setName("VibeForge");
app.setAppUserModelId(APP_ID);
let ownWebContents: () => GuardableWebContents | null = () => null;
// Lock down every session (default, persist:dock, or any future partition) and disable Chromium's
// spellchecker before any page loads so it never fetches a dictionary from Google.
app.on("session-created", (made) => {
  try {
    made.setSpellCheckerEnabled(false);
    made.setSpellCheckerLanguages([]);
  } catch (error) {
    log.warn(`Could not turn the spellchecker off: ${describeError(error)}`);
  }
  guardSession(made, (contents) => Boolean(contents && contents === ownWebContents()));
});
app.on("web-contents-created", (_event, contents) => {
  guardWebContents(contents);
});
const appRoot = app.getAppPath();
const copyInstall = installKind(appRoot, {
  installerHome: process.env.VIBEFORGE_HOME || path.join(os.homedir(), ".local", "share", "vibeforge-app"),
  marked: fs.existsSync(path.join(appRoot, INSTALLER_MARK)),
  checkout: fs.existsSync(path.join(appRoot, ".git")),
});
if (process.platform === "linux") app.commandLine.appendSwitch("class", "vibeforge");
const dbg = debugSwitch(process.env, copyInstall);
if (dbg && "refused" in dbg) log.warn(dbg.refused);
else if (dbg) {
  if (dbg.value !== undefined) app.commandLine.appendSwitch(dbg.name, dbg.value);
  else app.commandLine.appendSwitch(dbg.name);
}

// ------------------------------------------------------------------ the parts

const supervisor = new PtySupervisor();
const ctx = new MainContext({
  roots,
  log,
  supervisor,
  words: new MainText(),
  appRoot,
  install: copyInstall,
  palette: resolvePalette("omarchy"),
  unexpected,
});
const { send, focusWindow, install } = ctx;
ownWebContents = () => ctx.win?.webContents ?? null;
const notify = desktopNotifier(ctx);

const host = deskHost(ctx, notify, { dock: () => dock, stats: () => stats, voice: () => voice, tray: () => tray, sync: () => sync });
const dock = new Dock(
  () => ctx.win,
  (state) => send("dock", state),
  (workspaceId, url) => {
    // The view names its workspace, so a page that moves while another workspace is on screen
    // is stored on the one that owns it.
    const row = ctx.service?.listWorkspaces().workspaces.find((item) => item.id === workspaceId);
    if (!ctx.service || !row) return;
    const next = savedDockUrl(workspaceId, workspaceId, url, row.dockUrl);
    if (!next) return;
    try {
      ctx.service.updateWorkspace(workspaceId, { dockUrl: next });
    } catch (error) {
      log.warn(`Could not remember the browser address: ${describeError(error)}`);
    }
  },
);

const stats = new Stats(ctx, notify, app.getVersion());
const updater = new Updater({
  current: app.getVersion(),
  install,
  // Built again from each release read, so Update runs that release's own installer, checked against GitHub's digest.
  command: (latest) => updateCommand(install, ctx.appRoot, process.env.VIBEFORGE_UPDATE_COMMAND, latest),
  url: process.env.VIBEFORGE_UPDATE_URL || RELEASES_URL,
  log,
  enabled: () => ctx.service?.getSettings().checkUpdates ?? false,
  changed: () => send("changed", ["updates"]),
});

const voice = makeVoice(ctx);
const viby = new Call({
  voice,
  service: () => ctx.service,
  looking: () => ctx.looking,
  words: ctx.words,
  log,
  send: (state) => {
    send("call", state);
    // The tray says so too: the microphone is open whether or not the window is.
    tray.call(state.on);
  },
});

/** Repaints in the theme Settings name (or Omarchy's own): the page, the window and the tray icon. */
function refreshPalette(): void {
  if (!ctx.service) return;
  ctx.palette = resolvePalette(ctx.service.getSettings().theme);
  send("palette", ctx.palette);
  if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setBackgroundColor(ctx.palette.background);
  drawBrandIcon();
  tray.icon.recolor(ctx.palette.accent2, ctx.palette.darkerBackground, ctx.brandIcon, ctx.palette.accent);
}

/** The colours the icon was last drawn in: a focus or a Settings change that keeps them costs nothing. */
let brandDrawnIn = "";

/**
 * VibeForge's icon in the theme's colours, for notifications and the tray, and the launcher entry's
 * icons redrawn to match, so the desktop shows one logo that changes with the theme.
 */
function drawBrandIcon(): void {
  const colors = iconColors(ctx.palette);
  const key = JSON.stringify(colors);
  if (key === brandDrawnIn) return;
  brandDrawnIn = key;
  try {
    const image = nativeImage.createFromBuffer(iconPng(colors, 256));
    ctx.brandIcon = image.isEmpty() ? null : image;
  } catch (error) {
    ctx.brandIcon = null;
    log.warn(`The icon could not be drawn in the theme's colours: ${describeError(error)}`);
  }
  try {
    if (refreshLauncherIcons(colors).length) log.info(`The launcher's icon now shows ${ctx.palette.name}'s colours`);
  } catch (error) {
    log.warn(`The launcher's icon could not be redrawn: ${describeError(error)}`);
  }
}

const sync = new Sync(ctx, notify);
const quit = new Quit(ctx, { voice, sync });
const tray = new TrayController(
  ctx,
  () => void quit.fromTray(),
  () => viby.stop(),
);
const mainWindow = new MainWindow(ctx, {
  // Started by the login autostart entry: stay in the tray until opened.
  startHidden: process.argv.includes(HIDDEN_ARG),
  tray,
  quit,
  notify,
  dock,
});

const hostLife = new HostLifecycle(ctx, { voice });
hostLife.wire();

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // `vibeforge --voice start` from a keybinding reaches the window here when the control socket can't.
  app.on("second-instance", (_event, argv) => {
    // Started again while this copy is on its way out (a CLI taking its seconds to end): the new
    // start lost the lock to this one, so come back once this one has gone.
    if (ctx.quitting) {
      if (!voiceArg(argv)) app.relaunch({ execPath: process.execPath, args: secondStartArgs(process.argv, argv) });
      return;
    }
    const action = voiceArg(argv);
    if (action) send("voice-command", { action });
    // A second autostart at login shouldn't pull the window up.
    else if (!argv.includes(HIDDEN_ARG)) focusWindow();
  });

  app.whenReady().then(async () => {
    // One VibeForge per folder: a copy with another profile on the same folders stops here, before
    // it could settle the other copy's runs as ended or start a second Syncthing on the same data.
    const hold = await holdFolders([roots.dataRoot, roots.configRoot]).catch((error: unknown) => {
      log.warn(`Could not hold the config and data folders for this copy: ${describeError(error)}`);
      return null;
    });
    if (hold && !hold.ok) return quit.folderInUse(tildify(hold.folder, os.homedir()));
    if (hold) app.once("quit", hold.release);
    log.info(`VibeForge ${app.getVersion()} starting · Electron ${process.versions.electron} · ${osDescription()} · ${install} copy at ${ctx.appRoot}`);
    Menu.setApplicationMenu(null);
    await adoptShellPath(log);
    ctx.service = new TeamService({
      configRoot: roots.configRoot,
      dataRoot: roots.dataRoot,
      appStartedAt: new Date(),
      now: () => new Date(),
      host,
    });
    ctx.service.onChange((topics) => {
      send("changed", topics);
      if (topics.includes("settings") || topics.includes("live")) tray.sync();
      if (topics.includes("settings")) refreshPalette();
      if (topics.includes("settings")) syncCompanion(companionWire(ctx, stats, voice));
      if (topics.includes("settings")) tray.syncWords();
      if (topics.includes("settings")) viby.syncSettings();
      // Sync starts and stops with its switch, and tells the paired machines what runs here.
      if (topics.includes("settings")) void sync.apply();
      if (topics.includes("live") || topics.includes("working") || topics.includes("workspaces")) sync.liveChanged();
      // A synced agent or skill changed here (or what its folders and CLI are found by): the other machines hear.
      if (topics.includes("agents") || topics.includes("skills") || topics.includes("engines") || topics.includes("workspaces")) sync.libraryChanged();
    });
    ctx.palette = resolvePalette(ctx.service.getSettings().theme);
    syncCompanion(companionWire(ctx, stats, voice));
    mainWindow.guardPermissions();
    registerIpc(ctx, { host: hostLife, stats, tray, updater, voice, call: viby, dock, sync, notify, refreshPalette });
    drawBrandIcon();
    tray.icon.recolor(ctx.palette.accent2, ctx.palette.darkerBackground, ctx.brandIcon, ctx.palette.accent);
    // Watching before the icon is made, so a bar that restarts right after (as Omarchy's does at
    // login) gets the icon again instead of leaving VibeForge running with nothing to open it from.
    const stopTrayWatch = tray.watchHost();
    tray.sync();
    tray.syncWords();
    const hostReady = hostLife.start();
    await mainWindow.create();
    await hostReady;
    // Earlier versions left a copy of every model and voice download in the HTTP cache; cleared once.
    void clearOldDownloadCopies({ profile: app.getPath("userData"), clearCache: () => session.defaultSession.clearCache(), log });
    const stopThemeWatch = watchOmarchyTheme(refreshPalette);
    const stopConfigWatch = watchConfig(roots.configRoot, (topics) => {
      ctx.service?.emit(...topics);
      if (topics.includes("settings")) refreshPalette();
    });
    const stopControl = listenControl(voice.controlSocket, log, (action) => send("voice-command", { action }), (request, gone) => answerTalk(ctx, request, gone));
    ctx.win?.on("focus", refreshPalette);
    // Checked again whenever the window comes forward, so it's current before a close.
    tray.refreshHost();
    ctx.win?.on("focus", () => tray.refreshHost());
    const timers = new Disposables();
    startSchedules(ctx, timers);
    const onResume = () => void ctx.service?.tick().catch(() => undefined);
    powerMonitor.on("resume", onResume);
    updater.start();
    // Only when Settings have it on; until then nothing is started and nothing listens.
    void sync.apply();
    // Stopped in this order at quit.
    timers.add(() => powerMonitor.removeListener("resume", onResume), () => updater.stop(), stopThemeWatch, stopConfigWatch, stopControl, stopTrayWatch);
    app.once("will-quit", () => timers.dispose());
  }).catch((error: unknown) => quit.startFailed(error));

  quit.handleEvents();
}
