import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, Menu } from "electron";
import { HIDDEN_ARG } from "../src/core/autostart.js";
import { controlSocketPath, voiceArg } from "../src/core/control.js";
import { whichBin } from "../src/core/engines.js";
import { defaultRoots, ensureLayout } from "../src/core/layout.js";
import { describeError, LogFile } from "../src/core/log.js";
import { MainText } from "../src/core/main-text.js";
import { TeamService } from "../src/core/team-service.js";
import { resolvePalette, watchOmarchyTheme } from "../src/core/theme.js";
import { INSTALLER_MARK, installKind, RELEASES_URL, updateCommand } from "../src/core/updates.js";
import { savedDockUrl } from "../src/shared/dock-url.js";
import { syncCompanion } from "./companion.js";
import { watchConfig } from "./config-watch.js";
import { listenControl } from "./control.js";
import { Dock } from "./dock.js";
import { deskHost, HostLifecycle } from "./host-lifecycle.js";
import { answerTalk, registerIpc } from "./ipc.js";
import { MainContext } from "./main-context.js";
import { desktopNotifier } from "./notify.js";
import { Quit } from "./quit.js";
import { Stats } from "./stats.js";
import { PtySupervisor } from "./supervisor.js";
import { adoptShellPath, osDescription } from "./system.js";
import { Talk } from "./talk.js";
import { Disposables, startSchedules } from "./timers.js";
import { TrayController } from "./tray-controller.js";
import { Updater } from "./updater.js";
import { Voice } from "./voice.js";
import { MainWindow } from "./window.js";

const APP_ID = "dev.vibeforge.app";
const roots = defaultRoots();
ensureLayout(roots.configRoot, roots.dataRoot);
const log = new LogFile(path.join(roots.dataRoot, "logs", "vibeforge.log"));

process.on("uncaughtException", (error) => {
  console.error(error);
  log.error(`Uncaught error in the main process: ${describeError(error)}`);
});
process.on("unhandledRejection", (reason) => log.warn(`Unhandled rejection in the main process: ${describeError(reason)}`));

app.setName("VibeForge");
app.setAppUserModelId(APP_ID);
if (process.platform === "linux") app.commandLine.appendSwitch("class", "vibeforge");
if (process.env.VIBEFORGE_DEBUG === "1") app.commandLine.appendSwitch("remote-debugging-port", process.env.VIBEFORGE_DEBUG_PORT || "9223");

const supervisor = new PtySupervisor();
const appRoot = app.getAppPath();
const ctx = new MainContext({
  roots,
  log,
  supervisor,
  words: new MainText(),
  appRoot,
  install: installKind(appRoot, {
    installerHome: process.env.VIBEFORGE_HOME || path.join(os.homedir(), ".local", "share", "vibeforge-app"),
    marked: fs.existsSync(path.join(appRoot, INSTALLER_MARK)),
    checkout: fs.existsSync(path.join(appRoot, ".git")),
  }),
  palette: resolvePalette("omarchy"),
});
const { send, svc, focusWindow, install } = ctx;
const notify = desktopNotifier(ctx);

const host = deskHost(ctx, notify);

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
  command: updateCommand(install, ctx.appRoot, process.env.VIBEFORGE_UPDATE_COMMAND),
  url: process.env.VIBEFORGE_UPDATE_URL || RELEASES_URL,
  log,
  enabled: () => ctx.service?.getSettings().checkUpdates ?? false,
  changed: () => send("changed", ["updates"]),
});

const voice = new Voice({
  log,
  home: os.homedir(),
  dataRoot: roots.dataRoot,
  settings: () => svc().getSettings().voice,
  resolveBin: (bin) => whichBin(bin),
  state: (state) => send("voice", state),
  changed: () => send("changed", ["voice"]),
  speaking: () => send("changed", ["voice"]),
  // Settings' language, or the desktop's: a voice in it is preferred.
  language: () => {
    const chosen = ctx.service?.getSettings().language ?? "system";
    return (chosen === "system" ? app.getLocale() : chosen).slice(0, 2).toLowerCase();
  },
  controlSocket: controlSocketPath(roots.dataRoot, process.env.XDG_RUNTIME_DIR, process.getuid?.() ?? 0),
  // The installed launcher when it is on PATH (it is a link to scripts/vibeforge), else the script itself.
  launcher: () => (whichBin("vibeforge") ? "vibeforge" : path.join(ctx.appRoot, "scripts", "vibeforge")),
});

const talk = new Talk({ voice, service: () => ctx.service, log, send: (event) => send("voice-talk", event) });

function refreshPalette(): void {
  if (!ctx.service) return;
  ctx.palette = resolvePalette(ctx.service.getSettings().theme);
  send("palette", ctx.palette);
  if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setBackgroundColor(ctx.palette.background);
  tray.icon.recolor(ctx.palette.accent2, ctx.palette.darkerBackground);
}

// ------------------------------------------------------------------ tray

const quit = new Quit(ctx, { talk, voice });
const tray = new TrayController(ctx, () => void quit.fromTray());
const mainWindow = new MainWindow(ctx, {
  // Started by the login autostart entry: stay in the tray until opened.
  startHidden: process.argv.includes(HIDDEN_ARG),
  tray,
  quit,
  notify,
  dock,
});

const hostLife = new HostLifecycle(ctx, { voice, talk });
hostLife.wire();

function companionWire() {
  return {
    service: svc(),
    supervisor,
    root: path.join(ctx.appRoot, "companion"),
    icon: ctx.iconPath,
    log: (line: string) => log.info(line),
    plans: () => stats.planSummary(false),
    hear: (pcm: Buffer, prompt: string) => voice.transcribe(pcm, prompt),
    canHear: () => voice.canTranscribe(),
  };
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // `vibeforge --voice start` from a keybinding reaches the window here when the control socket can't.
  app.on("second-instance", (_event, argv) => {
    const action = voiceArg(argv);
    if (action) send("voice-command", { action });
    // A second autostart at login shouldn't pull the window up.
    else if (!argv.includes(HIDDEN_ARG)) focusWindow();
  });

  app.whenReady().then(async () => {
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
      if (topics.includes("settings")) syncCompanion(companionWire());
      if (topics.includes("settings")) tray.syncWords();
    });
    ctx.palette = resolvePalette(ctx.service.getSettings().theme);
    syncCompanion(companionWire());
    mainWindow.guardPermissions();
    registerIpc(ctx, { host: hostLife, stats, tray, updater, voice, talk, dock, notify, refreshPalette });
    tray.icon.recolor(ctx.palette.accent2, ctx.palette.darkerBackground);
    // Watching before the icon is made, so a bar that restarts right after (as Omarchy's does at
    // login) gets the icon again instead of leaving VibeForge running with nothing to open it from.
    const stopTrayWatch = tray.watchHost();
    tray.sync();
    tray.syncWords();
    const hostReady = hostLife.start();
    await mainWindow.create();
    await hostReady;
    const stopThemeWatch = watchOmarchyTheme(refreshPalette);
    const stopConfigWatch = watchConfig(roots.configRoot, (topics) => {
      ctx.service?.emit(...topics);
      if (topics.includes("settings")) refreshPalette();
    });
    const stopControl = listenControl(voice.status().controlSocket, log, (action) => send("voice-command", { action }), (request, gone) => answerTalk(ctx, request, gone));
    ctx.win?.on("focus", refreshPalette);
    // Checked again whenever the window comes forward, so it's current before a close.
    tray.refreshHost();
    ctx.win?.on("focus", () => tray.refreshHost());
    const timers = new Disposables();
    startSchedules(ctx, timers);
    updater.start();
    // Stopped in this order at quit.
    timers.add(() => updater.stop(), stopThemeWatch, stopConfigWatch, stopControl, stopTrayWatch);
    app.once("will-quit", () => timers.dispose());
  }).catch((error: unknown) => quit.startFailed(error));

  quit.handleEvents();
}

