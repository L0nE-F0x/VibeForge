import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell } from "electron";
import { autostartFile, HIDDEN_ARG, launcherCommand, readAutostart, writeAutostart } from "../src/core/autostart.js";
import { whichBin } from "../src/core/engines.js";
import { listDir } from "../src/core/files.js";
import { gitHead, snapshotGit } from "../src/core/vcs.js";
import { defaultRoots, ensureLayout } from "../src/core/layout.js";
import { describeError, LogFile, PageErrors } from "../src/core/log.js";
import { TICK_MS } from "../src/core/routines.js";
import { TeamService, type DeskHost } from "../src/core/team-service.js";
import { resolvePalette, watchOmarchyTheme, type Palette } from "../src/core/theme.js";
import type { Topic } from "../src/core/types.js";
import { INSTALLER_MARK, installKind, RELEASES_URL, updateCommand } from "../src/core/updates.js";
import { UsageScanner } from "../src/core/usage.js";
import { PlanWatcher } from "../src/core/plans.js";
import { quotaNote, QuotaAlerts } from "../src/core/quota-alerts.js";
import { gitActivity, githubActivity, type Activity, type ActivitySource } from "../src/core/activity.js";
import type { DeskEvents, Method, MethodArgs, MethodResult, TrayWaiter } from "../src/shared/api.js";
import { savedDockUrl } from "../src/shared/dock-url.js";
import { Dock } from "./dock.js";
import { TrayIcon, type TrayState } from "./tray.js";
import { childEnv, loadShellPath, mergePath } from "./shell-env.js";
import { PtySupervisor } from "./supervisor.js";
import { Updater } from "./updater.js";
import { controlSocketPath, voiceArg } from "../src/core/control.js";
import { listenControl } from "./control.js";
import { companionStatus, stopCompanion, syncCompanion } from "./companion.js";
import { Talk } from "./talk.js";
import { Voice } from "./voice.js";

const APP_ID = "dev.vibeforge.app";
const REPO_URL = "https://github.com/L0nE-F0x/VibeForge";
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
let win: BrowserWindow | null = null;
let service: TeamService | null = null;
let palette: Palette = resolvePalette("omarchy");
let quitting = false;
let shutdownDone = false;
/** Started by the login autostart entry: stay in the tray until opened. */
const startHidden = process.argv.includes(HIDDEN_ARG);
/** CLIs and chats waiting for you, as the page counts and names them. */
let waiting = 0;
let waiters: TrayWaiter[] = [];
let trayNoticeShown = false;
const notifications = new Set<Notification>();

function appRoot(): string {
  return app.getAppPath();
}

function iconPath(): string {
  return path.join(appRoot(), "resources", "icon.png");
}

const install = installKind(appRoot(), {
  installerHome: process.env.VIBEFORGE_HOME || path.join(os.homedir(), ".local", "share", "vibeforge-app"),
  marked: fs.existsSync(path.join(appRoot(), INSTALLER_MARK)),
  checkout: fs.existsSync(path.join(appRoot(), ".git")),
});

/** Puts the login shell's PATH ahead of Electron's, so CLIs installed through mise are found. */
async function adoptShellPath(): Promise<void> {
  const shellPath = await loadShellPath();
  if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
  else log.warn(`Could not read PATH from the login shell (${process.env.SHELL || "/bin/bash"}); CLIs found only on that PATH will show as missing`);
}

/** "Omarchy 4.0.4-1 · Linux 7.2.5-3-omarchy" from pacman, os-release and the kernel, for bug reports. */
function osDescription(): string {
  let name = os.type();
  try {
    const release = fs.readFileSync("/etc/os-release", "utf8");
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    if (pretty) name = pretty;
  } catch {
    /* not every system has os-release */
  }
  try {
    // Omarchy ships as a pacman package (omarchy, or omarchy-dev on the edge channel).
    const entry = fs.readdirSync("/var/lib/pacman/local").find((dir) => /^omarchy(-dev)?-\d/.test(dir));
    if (entry) name = `Omarchy ${entry.replace(/^omarchy(-dev)?-/, "")}`;
  } catch {
    /* not an Arch system */
  }
  return `${name} · ${os.type()} ${os.release()}`;
}

function send<K extends keyof DeskEvents>(event: K, payload: DeskEvents[K]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`vf:${event}`, payload);
}

function svc(): TeamService {
  if (!service) throw new Error("VibeForge is still starting.");
  return service;
}

function openPath(target: string): void {
  const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

function focusWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Omarchy's shell keeps its Do Not Disturb switch in this file. */
function omarchyDoNotDisturb(): boolean {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(state, "omarchy", "notifications.json"), "utf8")) as { dnd?: unknown };
    return parsed.dnd === true;
  } catch {
    return false;
  }
}

/** A desktop notification; clicking it brings VibeForge up on the run or workspace it is about. */
function notify(note: {
  title: string;
  body: string;
  runId?: string;
  taskId?: string;
  routineId?: string;
  workspaceId?: string | null;
  chatId?: string | null;
  agentId?: string | null;
  route?: unknown;
}): void {
  if (Notification.isSupported()) {
    // VibeForge plays its own sounds, so the desktop's would be a second one for the same moment.
    const silent = Boolean(service?.getSettings().sounds.on);
    const notification = new Notification({ title: note.title, body: note.body, icon: iconPath(), silent });
    notifications.add(notification);
    notification.on("click", () => {
      focusWindow();
      if (note.route) send("open-route", { route: note.route });
      else if (note.taskId) send("open-route", { route: { view: "tasks", taskId: note.taskId } });
      else if (note.routineId) send("open-route", { route: { view: "routines", routineId: note.routineId } });
      else if (note.runId) send("open-run", { runId: note.runId });
      else if (note.chatId) send("open-chat", { chatId: note.chatId, agentId: note.agentId ?? null });
      else if (note.workspaceId) send("open-workspace", { workspaceId: note.workspaceId });
    });
    notification.on("close", () => notifications.delete(notification));
    notification.show();
    return;
  }
  const child = spawn("notify-send", ["-a", "VibeForge", note.title, note.body], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

const host: DeskHost = {
  spawn: async (request) => {
    // The program's name only: the rest of the command line can hold a prompt.
    const program = path.basename(request.argv[0] ?? "?");
    try {
      const spawned = await supervisor.spawn(request);
      log.info(`Terminal ${spawned.ptyId} started: ${program} in ${request.cwd}`);
      return spawned;
    } catch (error) {
      log.error(`Could not start ${program} in ${request.cwd}: ${describeError(error)}`);
      throw error;
    }
  },
  send: (ptyId, text) => supervisor.send(ptyId, text),
  kill: (ptyId) => supervisor.kill(ptyId),
  record: (ptyId, runDir) => supervisor.record(ptyId, runDir),
  resolveBin: (bin) => whichBin(bin),
  notify,
  finished: (run) => send("run-finished", run),
  snapshotGit: (cwd, startHead) => snapshotGit(cwd, 5000, startHead),
  gitHead: (cwd) => gitHead(cwd),
};

const dock = new Dock(
  () => win,
  (state) => send("dock", state),
  (workspaceId, url) => {
    // The view names its workspace, so a page that moves while another workspace is on screen
    // is stored on the one that owns it.
    const row = service?.listWorkspaces().workspaces.find((item) => item.id === workspaceId);
    if (!service || !row) return;
    const next = savedDockUrl(workspaceId, workspaceId, url, row.dockUrl);
    if (!next) return;
    try {
      service.updateWorkspace(workspaceId, { dockUrl: next });
    } catch (error) {
      log.warn(`Could not remember the browser address: ${describeError(error)}`);
    }
  },
);

const usage = new UsageScanner(os.homedir());
const plans = new PlanWatcher({ home: os.homedir(), file: path.join(roots.dataRoot, "plans.json"), agent: `VibeForge/${app.getVersion()}` });
/** What was already announced about plan limits, so each step is told once per window. */
const quotaAlerts = new QuotaAlerts(path.join(roots.dataRoot, "quota-alerts.json"));

async function planSummary(fresh: boolean) {
  const settings = svc().getSettings();
  const local = settings.usage
    ? (await usage.scan()).sources.filter((source) => source.limits.length).map((source) => ({ id: source.id, limits: source.limits, at: source.limitsAt }))
    : [];
  if (!settings.planLimits && !local.length) return null;
  const summary = await plans.summary({ network: settings.planLimits, local, fresh });
  if (settings.quotaAlerts && settings.notify) {
    for (const alert of quotaAlerts.check(summary)) {
      log.info(`Plan alert: ${alert.plan} ${alert.window} at ${Math.floor(alert.percent)}%`);
      notify(quotaNote(alert, Date.now()));
    }
  }
  return summary;
}

// The graph changes slowly: git is read again after 5 minutes, GitHub after 30.
let activity: { key: string; at: number; value: Promise<Activity> } | null = null;

function activityFor(source: ActivitySource, fresh: boolean): Promise<Activity> | null {
  if (source === "off" || !service) return null;
  const paths = service.listWorkspaces().workspaces.map((workspace) => workspace.path);
  // Adding or removing a workspace changes what git counts.
  const key = source === "github" ? source : `${source}:${paths.join("\n")}`;
  const maxAge = source === "github" ? 30 * 60_000 : 5 * 60_000;
  if (!fresh && activity?.key === key && Date.now() - activity.at < maxAge) return activity.value;
  const now = new Date();
  const value =
    source === "github"
      ? githubActivity(now).then((result) => {
          log.info(result.error ? `GitHub activity not read: ${result.error}` : "GitHub activity read");
          return result;
        })
      : gitActivity(paths, now);
  activity = { key, at: Date.now(), value };
  return value;
}

const updater = new Updater({
  current: app.getVersion(),
  install,
  command: updateCommand(install, appRoot(), process.env.VIBEFORGE_UPDATE_COMMAND),
  url: process.env.VIBEFORGE_UPDATE_URL || RELEASES_URL,
  log,
  enabled: () => service?.getSettings().checkUpdates ?? false,
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
    const chosen = service?.getSettings().language ?? "system";
    return (chosen === "system" ? app.getLocale() : chosen).slice(0, 2).toLowerCase();
  },
  controlSocket: controlSocketPath(roots.dataRoot, process.env.XDG_RUNTIME_DIR, process.getuid?.() ?? 0),
  // The installed launcher when it is on PATH (it is a link to scripts/vibeforge), else the script itself.
  launcher: () => (whichBin("vibeforge") ? "vibeforge" : path.join(appRoot(), "scripts", "vibeforge")),
});

const talk = new Talk({ voice, service: () => service, log, send: (event) => send("voice-talk", event) });

function refreshPalette(): void {
  if (!service) return;
  palette = resolvePalette(service.getSettings().theme);
  send("palette", palette);
  if (win && !win.isDestroyed()) win.setBackgroundColor(palette.background);
  tray.recolor(palette.accent2, palette.darkerBackground);
}

// ------------------------------------------------------------------ tray

const autostartPath = autostartFile(process.env, os.homedir());
const launcher = () => launcherCommand(process.env, os.homedir(), `"${process.execPath}" "${appRoot()}"`);

const tray = new TrayIcon(iconPath(), { mark: palette.accent2, outline: palette.darkerBackground }, {
  open: () => focusWindow(),
  goAnywhere: () => {
    focusWindow();
    send("open-switcher", true);
  },
  openWaiter: (index) => {
    const waiter = waiters[index];
    focusWindow();
    if (waiter) send("open-route", { route: waiter.route });
  },
  settings: () => {
    focusWindow();
    send("open-view", { view: "settings" });
  },
  setSounds: (on) => {
    if (service) service.saveSettings({ sounds: { ...service.getSettings().sounds, on } });
  },
  setNotify: (on) => service?.saveSettings({ notify: on }),
  setAutostart: (on) => {
    setAutostart(on);
    syncTray();
  },
  quit: () => void quitFromTray(),
});

function setAutostart(on: boolean): void {
  try {
    writeAutostart(autostartPath, on, launcher());
    log.info(`Start at login ${on ? "on" : "off"} (${autostartPath})`);
  } catch (error) {
    log.warn(`Could not change the autostart entry: ${describeError(error)}`);
  }
}

function trayState(): TrayState {
  const settings = service!.getSettings();
  return { live: service!.liveCount(), waiting, waiters: waiters.map((waiter) => waiter.label), sounds: settings.sounds.on, notify: settings.notify, autostart: readAutostart(autostartPath) };
}

function syncTray(): void {
  if (!service) return;
  try {
    if (service.getSettings().tray) tray.show(trayState());
    // Electron can't take an icon out of the bar's tray while it runs (the entry stays behind,
    // dead), so switching it off applies from the next start; until then it keeps working.
    else if (tray.shown) tray.update(trayState());
  } catch (error) {
    log.warn(`The tray icon: ${describeError(error)}`);
  }
}

/**
 * Whether anything hosts tray icons. Omarchy's bar does; a bar without a tray doesn't, and a window
 * closed to the tray there could only come back by launching VibeForge again.
 */
let trayHost = true;

function findTrayHost(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "dbus-send",
      ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.kde.StatusNotifierWatcher"],
      { timeout: 2000 },
      // Without dbus-send there's no telling, so the settings decide, as before.
      (error, stdout) => resolve(error ? error.code === "ENOENT" : /boolean true/.test(stdout)),
    );
  });
}

function refreshTrayHost(): void {
  void findTrayHost().then((found) => {
    if (found !== trayHost) log.info(found ? "A tray host is back; closing the window keeps VibeForge in the tray" : "Nothing hosts the tray; closing the window quits VibeForge");
    trayHost = found;
  });
}

/** At login the bar can come up after VibeForge, so a missing tray host gets a few seconds to appear. */
async function waitForTrayHost(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!(await findTrayHost())) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

/** Quit from the tray menu; running terminals are asked about first, as when closing the window. */
async function quitFromTray(): Promise<void> {
  const live = service?.listLive() ?? [];
  if (live.length && win) {
    focusWindow();
    const runs = live.filter((session) => session.kind === "run").length;
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Quit and stop them", "Keep working"],
      defaultId: 1,
      cancelId: 1,
      title: "VibeForge",
      message: `${live.length} terminal${live.length === 1 ? " is" : "s are"} still running.`,
      detail: runs ? "Quitting stops them. Every run keeps its transcript and git snapshot." : "Quitting closes them.",
    });
    if (response !== 0) return;
  }
  quitting = true;
  app.quit();
}

// ------------------------------------------------------------------ IPC

/** Run upkeep (compressing ended runs, Settings → Storage) waits for start to settle, then repeats. */
const UPKEEP_FIRST_MS = 2 * 60 * 1000;
const UPKEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** Where the last folder picked sits, so the next folder dialog opens there. */
let pickedBeside: string | null = null;

type Handlers = { [K in Method]: (...args: MethodArgs<K>) => MethodResult<K> | Promise<MethodResult<K>> };

function handlers(): Handlers {
  const s = svc;
  return {
    "app.info": () => ({
      version: app.getVersion(),
      configRoot: roots.configRoot,
      dataRoot: roots.dataRoot,
      home: os.homedir(),
      hostRunning: supervisor.running,
      hostError: supervisor.running ? null : hostError,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      os: osDescription(),
      repo: REPO_URL,
      appPath: appRoot(),
      install,
      logFile: log.file,
    }),
    "app.palette": () => palette,
    "app.openPath": (target) => openPath(target),
    "app.openExternal": (url) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    },
    "app.pickFolder": async (title) => {
      // Electron opens dialogs in Downloads unless told where. Projects sit side by side, so start
      // beside the folder picked last, or beside the newest workspace.
      const newest = service?.listWorkspaces().workspaces.at(-1)?.path;
      const start = [pickedBeside, newest && path.dirname(newest)].find((dir): dir is string => Boolean(dir && fs.existsSync(dir)));
      const options = {
        title: title || "Choose a folder",
        defaultPath: start ?? os.homedir(),
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const picked = result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
      if (picked) pickedBeside = path.dirname(picked);
      return picked;
    },
    "app.pathExists": (target) => fs.existsSync(target),
    "app.toggleDevTools": () => win?.webContents.toggleDevTools(),
    "app.restart": () => {
      // The renderer has already asked about running terminals; quitting stops them like any quit.
      log.info("Restarting");
      app.relaunch();
      quitting = true;
      app.quit();
    },
    "app.copyText": (text) => clipboard.writeText(text),
    "app.focus": () => focusWindow(),
    "app.clipboard": async () => ({
      text: await clipboard.readText(),
      // An item's types list what's on offer without fetching the image itself.
      image: (await clipboard.read()).some((item) => item.types.some((type) => type.startsWith("image/"))),
    }),
    "usage.summary": () => (s().getSettings().usage ? usage.scan() : null),
    "plans.summary": (fresh) => planSummary(Boolean(fresh)),
    "activity.get": (fresh) => activityFor(s().getSettings().activity, Boolean(fresh)),
    "app.notify": (note) => {
      if (service?.getSettings().notify) notify({ title: note.title, body: note.body, workspaceId: note.workspaceId, chatId: note.chatId, agentId: note.agentId, route: note.route });
    },
    "app.doNotDisturb": () => omarchyDoNotDisturb(),
    "app.autostart": () => readAutostart(autostartPath),
    "app.setAutostart": (on) => {
      setAutostart(on);
      syncTray();
      return readAutostart(autostartPath);
    },
    "app.attention": (state) => {
      const next = Math.max(0, Math.floor(Number(state?.count) || 0));
      const named = Array.isArray(state?.waiters)
        ? state.waiters.slice(0, 8).map((waiter) => ({ label: String(waiter?.label ?? "").slice(0, 80), route: waiter?.route ?? null }))
        : [];
      if (next === waiting && JSON.stringify(named) === JSON.stringify(waiters)) return;
      waiting = next;
      waiters = named;
      syncTray();
    },
    "app.logTail": (lines) => log.tail(Math.min(Math.max(1, Math.floor(lines)), 2000)),

    "updates.get": () => updater.get(),
    "updates.check": () => updater.check(),
    "updates.run": (size) => {
      const command = updater.get().command;
      if (!command) throw new Error("This copy of VibeForge updates some other way, such as its package manager.");
      // The kind of copy, never the command: a packager's VIBEFORGE_UPDATE_COMMAND can hold a secret.
      log.info(`Update started for the ${install} copy${process.env.VIBEFORGE_UPDATE_COMMAND ? " (VIBEFORGE_UPDATE_COMMAND)" : ""}`);
      return s().startCommand({ command, title: "VibeForge update", cwd: os.homedir(), ...size });
    },

    "settings.get": () => s().getSettings(),
    "settings.save": (patch) => {
      const next = s().saveSettings(patch);
      if (patch.theme) refreshPalette();
      return next;
    },
    "companion.status": () => companionStatus(),
    "engines.list": () => s().listEngines(),
    "engines.recheck": async () => {
      await adoptShellPath();
      s().emit("engines", "agents", "routines", "tasks");
      return s().listEngines();
    },
    "engines.save": (rows) => s().saveEngines(rows),

    "workspaces.list": () => s().listWorkspaces(),
    "workspaces.add": (folder) => s().addWorkspace(folder),
    "workspaces.remove": (id) => s().removeWorkspace(id),
    "workspaces.select": (id) => s().selectWorkspace(id),
    "workspaces.move": (id, toIndex) => s().moveWorkspace(id, toIndex),
    "workspaces.update": (id, patch) => s().updateWorkspace(id, patch),
    "workspaces.branches": (id) => s().listBranches(id),
    "workspaces.openBranch": (id, branch) => s().openBranch(id, branch),
    "layouts.get": (id) => s().getLayout(id),
    "layouts.save": (id, layout) => s().saveLayout(id, layout),
    "files.list": (dir) => listDir(dir),

    "agents.list": () => s().listAgents(),
    "agents.save": (input) => s().saveAgent(input),
    "agents.delete": (id, confirmName) => s().deleteAgent(id, confirmName),
    "agents.readMemory": (id) => s().readMemory(id),
    "agents.writeMemory": (id, text) => s().writeMemory(id, text),

    "skills.list": () => s().listSkills(),
    "skills.save": (input) => s().saveSkill(input),
    "skills.delete": (id) => s().deleteSkill(id),
    "skills.setAgents": (skillId, agentIds) => s().setSkillAgents(skillId, agentIds),

    "routines.list": () => s().listRoutines(),
    "routines.save": (input) => s().saveRoutine(input),
    "routines.delete": (id) => s().deleteRoutine(id),
    "routines.setEnabled": (id, enabled) => s().setRoutineEnabled(id, enabled),
    "routines.runNow": (id, size, now) => s().runRoutineNow(id, size, now),
    "routines.cancelWait": (id) => s().cancelRoutineWait(id),
    "routines.preview": (schedule) => s().previewSchedule(schedule),

    "tasks.list": () => s().listTasks(),
    "tasks.save": (input) => s().saveTask(input),
    "tasks.delete": (id) => s().deleteTask(id),
    "tasks.execute": (id, size, now) => s().executeTask(id, size, now),
    "tasks.continue": (id, size) => s().continueTask(id, size),
    "tasks.cancelWait": (id) => s().cancelTaskWait(id),
    "tasks.handOff": (runId, agentId) => s().handOff(runId, agentId),
    "tasks.stop": (id) => s().stopTask(id),
    "tasks.setStatus": (id, status) => s().setTaskStatus(id, status),
    "tasks.applyCopy": (id) => s().applyTaskCopy(id),
    "tasks.discardCopy": (id) => s().discardTaskCopy(id),

    "chats.list": (filter) => s().listChats(filter ?? {}),
    "chats.create": (input) => s().createChat(input),
    "chats.rename": (id, title) => s().renameChat(id, title),
    "chats.setEngine": (id, engine) => s().setChatEngine(id, engine),
    "chats.delete": (id) => s().deleteChat(id),
    "undo.delete": (token) => s().undoDelete(String(token ?? "")),
    "chats.send": (id, text, size) => s().sendChat(id, text, size),
    "chats.continue": (id, size) => s().continueChat(id, size),
    "chats.stop": (id) => s().stopChat(id),

    "code.shell": (opts) => s().startShell(opts),
    "code.engine": (opts) => s().startEngine(opts),

    "runs.list": (query) => s().listRuns(query ?? {}),
    "runs.inbox": () => s().inbox(),
    "runs.get": (id) => s().loadRun(id),
    "runs.markOpened": (id, opened) => s().markRunOpened(id, opened ?? true),
    "runs.markAllOpened": () => s().markAllOpened(),
    "runs.stop": (id) => s().stopRun(id),
    "runs.continue": (id, size) => s().continueRun(id, size),
    "runs.search": (text, limit) => s().searchRuns(String(text ?? "").slice(0, 200), typeof limit === "number" ? limit : undefined),
    "runs.diff": (id, source) => s().runDiff(id, source === "now" ? "now" : "saved"),
    "runs.markdown": (id) => s().runMarkdown(id),
    "storage.summary": () => s().storageSummary(),
    "storage.tidy": () => s().maintainRuns(),

    "live.list": () => s().liveForView(),

    "voice.status": () => voice.status(),
    "voice.start": () => voice.start(),
    "voice.stop": (prompt) => voice.stop(typeof prompt === "string" ? prompt.slice(0, 1000) : ""),
    "voice.cancel": () => voice.cancel(),
    "voice.download": (kind, id) => voice.startDownload(kind === "voice" ? "voice" : "model", String(id)),
    "voice.stopDownload": () => voice.stopDownload(),
    "voice.speak": (text, voiceFile) => void talk.say(null, "VibeForge", String(text).slice(0, 2000), typeof voiceFile === "string" ? voiceFile : "", "full"),
    "voice.silence": () => voice.speaker.stop(),
    "voice.expect": (ptyId, words) => {
      try {
        return talk.expect(String(ptyId), String(words ?? "").slice(0, 2000));
      } catch (error) {
        log.warn(`Voice: could not wait for an answer: ${describeError(error)}`);
        return false;
      }
    },
    "voice.forget": (ptyId) => talk.forget(typeof ptyId === "string" ? ptyId : undefined),
    "voice.installBindings": () => voice.installBindings(),

    "pty.write": (ptyId, data) => supervisor.write(ptyId, data),
    "pty.send": (ptyId, text) => supervisor.send(ptyId, text),
    "pty.resize": (ptyId, cols, rows) => supervisor.resize(ptyId, cols, rows),
    "pty.snapshot": (ptyId) => supervisor.snapshot(ptyId),
    "pty.kill": (ptyId) => s().killPty(ptyId),

    "dock.show": (bounds, url, workspaceId) => dock.show(bounds, String(url ?? ""), String(workspaceId ?? "")),
    "dock.hide": (workspaceId) => dock.hide(typeof workspaceId === "string" ? workspaceId : undefined),
    "dock.release": (workspaceId) => dock.release(String(workspaceId ?? "")),
    "dock.capture": () => dock.capture(),
    "dock.command": (command) => dock.command(command),
  };
}

function registerIpc(): void {
  const table = handlers() as Record<string, (...args: unknown[]) => unknown>;
  ipcMain.handle("vf:call", async (event, method: string, ...args: unknown[]) => {
    if (!win || event.sender !== win.webContents) throw new Error("Not allowed.");
    const handler = table[method];
    if (!handler) throw new Error(`Unknown call ${method}`);
    try {
      return await handler(...args);
    } catch (error) {
      // What the person saw as an error toast, kept for bug reports.
      log.warn(`${method} failed: ${describeError(error).split("\n")[0]}`);
      throw error;
    }
  });
}

// ------------------------------------------------------------------ watching config

function watchConfig(): () => void {
  const pending = new Set<Topic>();
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const map = (file: string): Topic[] => {
    const first = file.split(path.sep)[0];
    if (file.endsWith(".tmp") || first === "layouts") return [];
    if (first === "agents") return ["agents", "routines", "tasks"];
    if (first === "skills") return ["skills", "agents"];
    if (first === "routines") return ["routines"];
    if (first === "tasks") return ["tasks"];
    if (file === "engines.json") return ["engines", "agents", "routines", "tasks"];
    if (file === "settings.json") return ["settings"];
    if (file === "workspaces.json") return ["workspaces"];
    return [];
  };
  try {
    watcher = fs.watch(roots.configRoot, { recursive: true, persistent: false }, (_type, file) => {
      if (!file) return;
      for (const topic of map(String(file))) pending.add(topic);
      if (!pending.size) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const topics = [...pending];
        pending.clear();
        service?.emit(...topics);
        if (topics.includes("settings")) refreshPalette();
      }, 250);
    });
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

// ------------------------------------------------------------------ window

/** What web pages may use: copying to the clipboard, as any browser lets them. */
const WEB_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
/** VibeForge's own page also shows notifications. */
const PAGE_PERMISSIONS = new Set([...WEB_PERMISSIONS, "notifications"]);

/**
 * Electron grants every permission unless told otherwise, so a page in the browser dock could open
 * the microphone or read the clipboard without asking. Everything else is refused.
 */
function guardPermissions(): void {
  const allowed = (contents: Electron.WebContents | null, permission: string) =>
    (win && contents === win.webContents ? PAGE_PERMISSIONS : WEB_PERMISSIONS).has(permission);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
}

async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromPath(iconPath());
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    // A tiling window manager will give this window whatever slice is left. These floors stay
    // under a quarter of a laptop screen so the page actually becomes that size. The desk then
    // pans sideways (see --screen-floor) instead of drawing past the edge of the tile.
    minWidth: 280,
    minHeight: 220,
    title: "VibeForge",
    backgroundColor: palette.background,
    icon: icon.isEmpty() ? undefined : icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(appRoot(), "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => {
    if (!(startHidden && service?.getSettings().tray)) {
      win?.show();
      return;
    }
    // From the login autostart entry, the window waits in the tray, once something hosts one.
    void waitForTrayHost(10_000).then((found) => {
      trayHost = found;
      if (found) return;
      log.info("Started hidden, but nothing hosts the tray; showing the window");
      win?.show();
    });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith("file://")) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  win.on("close", (event) => {
    if (quitting || !service) return;
    if (tray.shown && trayHost && service.getSettings().tray && service.getSettings().closeToTray) {
      event.preventDefault();
      win?.hide();
      if (!trayNoticeShown && service.getSettings().notify) {
        trayNoticeShown = true;
        notify({ title: "VibeForge is still running", body: "It's in the tray with your terminals and routines. Quit from its menu." });
      }
      return;
    }
    const live = service.listLive();
    const runs = live.filter((session) => session.kind === "run").length;
    if (live.length === 0) return;
    const choice = dialog.showMessageBoxSync(win!, {
      type: "question",
      buttons: ["Quit and stop them", "Keep working"],
      defaultId: 1,
      cancelId: 1,
      title: "VibeForge",
      message: `${live.length} terminal${live.length === 1 ? " is" : "s are"} still running.`,
      detail: runs
        ? "Quitting stops them. Every run keeps its transcript and git snapshot."
        : "Quitting closes them.",
    });
    if (choice === 1) event.preventDefault();
    else quitting = true;
  });
  const pageErrors = new PageErrors((line) => log.warn(`Page error: ${line}`));
  win.on("closed", () => {
    pageErrors.flush();
    dock.dispose();
    win = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => log.error(`The window's page stopped: ${details.reason} (exit code ${details.exitCode})`));
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") pageErrors.report(`${event.message}${event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : ""}`);
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(appRoot(), "dist", "index.html"));
}

/** Why the terminal host is down, for a page that loads after it happened. */
let hostError: string | null = null;

async function startHost(): Promise<void> {
  try {
    await supervisor.start(appRoot(), childEnv(process.env));
    hostError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    log.error(`The terminal host did not start: ${message}`);
    hostError = message;
    send("host-crash", message);
  }
}

supervisor.onData.add((event) => send("pty-data", event));
supervisor.onExit.add((event) => {
  log.info(`Terminal ${event.ptyId} ended (${event.signal ? `signal ${event.signal}` : `exit code ${event.exitCode ?? "?"}`})`);
  send("pty-exit", event);
  void service?.onPtyExit(event.ptyId, event.exitCode, event.signal).then(() => talk.exited(event.ptyId));
});
supervisor.onProgram.add((event) => service?.onPtyProgram(event.ptyId, event.argv, event.cwd));
supervisor.onActivity.add((event) => service?.onPtyActivity(event.ptyId, event.working));
/** When the host last crashed, so one that keeps crashing isn't brought back forever. */
let hostCrashes: number[] = [];

supervisor.onCrash.add((message) => {
  log.error(`The terminal host stopped: ${message}`);
  // Every terminal died with the host. Record them, then bring the host back.
  for (const session of service?.listLive() ?? []) void service?.onPtyExit(session.ptyId, null, null);
  const now = Date.now();
  hostCrashes = [...hostCrashes.filter((at) => now - at < 5 * 60_000), now];
  if (hostCrashes.length > 3) {
    log.error("The terminal host keeps stopping; it stays off until VibeForge restarts");
    hostError = `${message} It stopped ${hostCrashes.length} times in five minutes, so it stays off: restart VibeForge.`;
    send("host-crash", hostError);
    return;
  }
  send("host-crash", message);
  setTimeout(() => void startHost(), 1000);
});

function companionWire() {
  return {
    service: svc(),
    supervisor,
    root: path.join(appRoot(), "companion"),
    icon: iconPath(),
    log: (line: string) => log.info(line),
    plans: () => planSummary(false),
  };
}

async function shutdown(): Promise<void> {
  await stopCompanion();
  talk.dispose();
  voice.dispose();
  if (!service) return;
  service.prepareShutdown();
  await supervisor.shutdown(7000);
  await Promise.race([service.whenIdle(), new Promise((resolve) => setTimeout(resolve, 4000))]);
  service.shutdown();
  service.close();
  service = null;
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
    log.info(`VibeForge ${app.getVersion()} starting · Electron ${process.versions.electron} · ${osDescription()} · ${install} copy at ${appRoot()}`);
    Menu.setApplicationMenu(null);
    await adoptShellPath();
    service = new TeamService({
      configRoot: roots.configRoot,
      dataRoot: roots.dataRoot,
      appStartedAt: new Date(),
      now: () => new Date(),
      host,
    });
    service.onChange((topics) => {
      send("changed", topics);
      if (topics.includes("settings") || topics.includes("live")) syncTray();
      if (topics.includes("settings")) syncCompanion(companionWire());
    });
    palette = resolvePalette(service.getSettings().theme);
    syncCompanion(companionWire());
    guardPermissions();
    registerIpc();
    tray.recolor(palette.accent2, palette.darkerBackground);
    syncTray();
    const hostReady = startHost();
    await createWindow();
    await hostReady;
    const stopThemeWatch = watchOmarchyTheme(refreshPalette);
    const stopConfigWatch = watchConfig();
    const stopControl = listenControl(voice.status().controlSocket, log, (action) => send("voice-command", { action }));
    win?.on("focus", refreshPalette);
    // Checked again whenever the window comes forward, so it's current before a close.
    refreshTrayHost();
    win?.on("focus", refreshTrayHost);
    const tick = () =>
      void service
        ?.tick()
        .then((results) => {
          for (const result of results) if (result.error) log.warn(`Routine ${result.routineId} could not start: ${result.error}`);
        })
        .catch((error: unknown) => {
          console.error(error);
          log.error(`Routine scheduler: ${describeError(error)}`);
        });
    const first = setTimeout(tick, 3000);
    const timer = setInterval(tick, TICK_MS);
    // Compress finished runs and apply Settings → Storage: shortly after start, then a few times a day.
    const upkeep = () =>
      void service
        ?.maintainRuns()
        .then((done) => {
          if (done.compressed || done.removed) log.info(`Runs tidied: ${done.compressed} compressed, ${done.removed} removed, ${Math.round(done.freed / 1024 / 1024)} MB freed`);
        })
        .catch((error: unknown) => log.warn(`Run upkeep: ${describeError(error)}`));
    const firstUpkeep = setTimeout(upkeep, UPKEEP_FIRST_MS);
    const upkeepTimer = setInterval(upkeep, UPKEEP_EVERY_MS);
    updater.start();
    app.once("will-quit", () => {
      clearTimeout(first);
      clearInterval(timer);
      clearTimeout(firstUpkeep);
      clearInterval(upkeepTimer);
      updater.stop();
      stopThemeWatch();
      stopConfigWatch();
      stopControl();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    void shutdown().finally(() => {
      shutdownDone = true;
      // On the next turn: with no terminal host to wait for, shutdown settles while Electron is
      // still inside this event, where a quit is ignored and the app would stay on, windowless.
      setImmediate(() => app.quit());
    });
  });

  app.on("window-all-closed", () => app.quit());
}
