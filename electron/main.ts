import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";
import { whichBin } from "../src/core/engines.js";
import { listDir } from "../src/core/files.js";
import { gitHead, snapshotGit } from "../src/core/vcs.js";
import { defaultRoots, ensureLayout } from "../src/core/layout.js";
import { describeError, LogFile } from "../src/core/log.js";
import { TICK_MS } from "../src/core/routines.js";
import { TeamService, type DeskHost } from "../src/core/team-service.js";
import { resolvePalette, watchOmarchyTheme, type Palette } from "../src/core/theme.js";
import type { Topic } from "../src/core/types.js";
import { INSTALLER_MARK, installKind, RELEASES_URL, updateCommand } from "../src/core/updates.js";
import type { DeskEvents, DeskMethods, Method, MethodArgs, MethodResult } from "../src/shared/api.js";
import { Dock } from "./dock.js";
import { childEnv, loadShellPath, mergePath } from "./shell-env.js";
import { PtySupervisor } from "./supervisor.js";
import { Updater } from "./updater.js";
import { controlSocketPath, voiceArg } from "../src/core/control.js";
import { listenControl } from "./control.js";
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
if (process.env.VIBEFORGE_DEBUG === "1") app.commandLine.appendSwitch("remote-debugging-port", "9223");

const supervisor = new PtySupervisor();
let win: BrowserWindow | null = null;
let service: TeamService | null = null;
let palette: Palette = resolvePalette("omarchy");
let quitting = false;
let shutdownDone = false;
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

function notify(note: { title: string; body: string; runId: string }): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title: note.title, body: note.body, icon: iconPath() });
    notifications.add(notification);
    notification.on("click", () => {
      focusWindow();
      send("open-run", { runId: note.runId });
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
  resolveBin: (bin) => whichBin(bin),
  notify,
  snapshotGit: (cwd, startHead) => snapshotGit(cwd, 5000, startHead),
  gitHead: (cwd) => gitHead(cwd),
};

const dock = new Dock(() => win, (state) => send("dock", state));

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
}

// ------------------------------------------------------------------ IPC

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
      const options = { title: title || "Choose a folder", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
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
    "app.logTail": (lines) => log.tail(Math.min(Math.max(1, Math.floor(lines)), 2000)),

    "updates.get": () => updater.get(),
    "updates.check": () => updater.check(),
    "updates.run": (size) => {
      const command = updater.get().command;
      if (!command) throw new Error("This copy of VibeForge updates some other way, such as its package manager.");
      log.info(`Update started: ${command}`);
      return s().startCommand({ command, title: "VibeForge update", cwd: os.homedir(), ...size });
    },

    "settings.get": () => s().getSettings(),
    "settings.save": (patch) => {
      const next = s().saveSettings(patch);
      if (patch.theme) refreshPalette();
      return next;
    },
    "engines.list": () => s().listEngines(),
    "engines.recheck": async () => {
      const shellPath = await loadShellPath();
      if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
      s().emit("engines", "agents", "routines", "tasks");
      return s().listEngines();
    },
    "engines.save": (rows) => s().saveEngines(rows),

    "workspaces.list": () => s().listWorkspaces(),
    "workspaces.add": (folder) => s().addWorkspace(folder),
    "workspaces.remove": (id) => s().removeWorkspace(id),
    "workspaces.select": (id) => s().selectWorkspace(id),
    "workspaces.update": (id, patch) => s().updateWorkspace(id, patch),
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
    "routines.runNow": (id, size) => s().runRoutineNow(id, size),
    "routines.preview": (schedule) => s().previewSchedule(schedule),

    "tasks.list": () => s().listTasks(),
    "tasks.save": (input) => s().saveTask(input),
    "tasks.delete": (id) => s().deleteTask(id),
    "tasks.execute": (id, size) => s().executeTask(id, size),
    "tasks.continue": (id, size) => s().executeTask(id, size, true),
    "tasks.stop": (id) => s().stopTask(id),
    "tasks.setStatus": (id, status) => s().setTaskStatus(id, status),

    "chats.list": (filter) => s().listChats(filter ?? {}),
    "chats.create": (input) => s().createChat(input),
    "chats.rename": (id, title) => s().renameChat(id, title),
    "chats.setEngine": (id, engine) => s().setChatEngine(id, engine),
    "chats.delete": (id) => s().deleteChat(id),
    "chats.send": (id, text, size) => s().sendChat(id, text, size),
    "chats.continue": (id, size) => s().continueChat(id, size),
    "chats.stop": (id) => s().stopChat(id),

    "code.shell": (opts) => s().startShell(opts),
    "code.engine": (opts) => s().startEngine(opts),

    "runs.list": (query) => s().listRuns(query ?? {}),
    "runs.inbox": () => s().inbox(),
    "runs.get": (id) => s().getRun(id),
    "runs.markOpened": (id, opened) => s().markRunOpened(id, opened ?? true),
    "runs.markAllOpened": () => s().markAllOpened(),
    "runs.stop": (id) => s().stopRun(id),
    "runs.continue": (id, size) => s().continueRun(id, size),
    "runs.diff": (id) => s().runDiff(id),

    "live.list": () => s().listLive(),

    "voice.status": () => voice.status(),
    "voice.start": (opts) => voice.start({ endpoint: Boolean(opts?.endpoint) }),
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

    "dock.show": (bounds, url) => dock.show(bounds, url),
    "dock.hide": () => dock.hide(),
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

async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromPath(iconPath());
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
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
  win.once("ready-to-show", () => win?.show());
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
  win.on("closed", () => {
    dock.dispose();
    win = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => log.error(`The window's page stopped: ${details.reason} (exit code ${details.exitCode})`));
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") log.warn(`Page error: ${event.message}${event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : ""}`);
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(appRoot(), "dist", "index.html"));
}

async function startHost(): Promise<void> {
  try {
    await supervisor.start(appRoot(), childEnv(process.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    log.error(`The terminal host did not start: ${message}`);
    send("host-crash", message);
  }
}

supervisor.onData.add((event) => send("pty-data", event));
supervisor.onExit.add((event) => {
  log.info(`Terminal ${event.ptyId} ended (${event.signal ? `signal ${event.signal}` : `exit code ${event.exitCode ?? "?"}`})`);
  send("pty-exit", event);
  void service?.onPtyExit(event.ptyId, event.exitCode, event.signal).then(() => talk.exited(event.ptyId));
});
supervisor.onCrash.add((message) => {
  log.error(`The terminal host stopped: ${message}`);
  send("host-crash", message);
  // Every terminal died with the host. Record them, then bring the host back.
  for (const session of service?.listLive() ?? []) void service?.onPtyExit(session.ptyId, null, null);
  setTimeout(() => void startHost(), 1000);
});

async function shutdown(): Promise<void> {
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
    else focusWindow();
  });

  app.whenReady().then(async () => {
    log.info(`VibeForge ${app.getVersion()} starting · Electron ${process.versions.electron} · ${osDescription()} · ${install} copy at ${appRoot()}`);
    Menu.setApplicationMenu(null);
    const shellPath = await loadShellPath();
    if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
    service = new TeamService({
      configRoot: roots.configRoot,
      dataRoot: roots.dataRoot,
      appStartedAt: new Date(),
      now: () => new Date(),
      host,
    });
    service.onChange((topics) => send("changed", topics));
    palette = resolvePalette(service.getSettings().theme);
    registerIpc();
    const hostReady = startHost();
    await createWindow();
    await hostReady;
    const stopThemeWatch = watchOmarchyTheme(refreshPalette);
    const stopConfigWatch = watchConfig();
    const stopControl = listenControl(voice.status().controlSocket, log, (action) => send("voice-command", { action }));
    win?.on("focus", refreshPalette);
    const tick = () =>
      void service?.tick().catch((error: unknown) => {
        console.error(error);
        log.error(`Routine scheduler: ${describeError(error)}`);
      });
    const first = setTimeout(tick, 3000);
    const timer = setInterval(tick, TICK_MS);
    updater.start();
    app.once("will-quit", () => {
      clearTimeout(first);
      clearInterval(timer);
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
      app.quit();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
