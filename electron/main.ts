import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell } from "electron";
import { HIDDEN_ARG } from "../src/core/autostart.js";
import { whichBin } from "../src/core/engines.js";
import { listDir } from "../src/core/files.js";
import { defaultRoots, ensureLayout } from "../src/core/layout.js";
import { describeError, LogFile, PageErrors } from "../src/core/log.js";
import { TICK_MS } from "../src/core/routines.js";
import { TeamService } from "../src/core/team-service.js";
import { listThemes, resolvePalette, watchOmarchyTheme } from "../src/core/theme.js";
import { INSTALLER_MARK, installKind, RELEASES_URL, updateCommand } from "../src/core/updates.js";
import { UsageScanner } from "../src/core/usage.js";
import { PlanWatcher } from "../src/core/plans.js";
import { quotaNote, QuotaAlerts } from "../src/core/quota-alerts.js";
import { gitActivity, githubActivity, type Activity, type ActivitySource } from "../src/core/activity.js";
import type { Method, MethodArgs, MethodResult } from "../src/shared/api.js";
import { savedDockUrl } from "../src/shared/dock-url.js";
import { watchConfig } from "./config-watch.js";
import { Dock } from "./dock.js";
import { deskHost, HostLifecycle } from "./host-lifecycle.js";
import { desktopNotifier } from "./notify.js";
import { MainContext } from "./main-context.js";
import { isAppPage, relaunchArgs, settleWithin } from "./guards.js";
import { TrayController } from "./tray-controller.js";
import { PtySupervisor } from "./supervisor.js";
import { Updater } from "./updater.js";
import { controlSocketPath, voiceArg, type TalkRequest } from "../src/core/control.js";
import { listenControl } from "./control.js";
import { MainText } from "../src/core/main-text.js";
import { companionStatus, stopCompanion, syncCompanion } from "./companion.js";
import { adoptShellPath, omarchyDoNotDisturb, openPath, osDescription } from "./system.js";
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
const { send, svc, focusWindow, words, install } = ctx;
let shutdownDone = false;
/** Started by the login autostart entry: stay in the tray until opened. */
const startHidden = process.argv.includes(HIDDEN_ARG);
let trayNoticeShown = false;
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

const usage = new UsageScanner(os.homedir(), { ledger: path.join(roots.dataRoot, "usage-days.json") });
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
      notify(quotaNote(alert, Date.now(), words.alerts()));
    }
  }
  return summary;
}

// The graph changes slowly: git is read again after 5 minutes, GitHub after 30.
let activity: { key: string; at: number; value: Promise<Activity> } | null = null;

function activityFor(source: ActivitySource, fresh: boolean): Promise<Activity> | null {
  if (source === "off" || !ctx.service) return null;
  const paths = ctx.service.listWorkspaces().workspaces.map((workspace) => workspace.path);
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

const tray = new TrayController(ctx, () => void quitFromTray());

/** The quit question while it is on screen, so a second close or Quit joins it instead of asking again. */
let quitQuestion: Promise<boolean> | null = null;

/**
 * Asks whether to quit with terminals still running; true to quit. Never the blocking kind of
 * dialog: while one held the main process, terminal output backed up and every CLI stalled.
 */
function askToQuit(live: Array<{ kind: string }>): Promise<boolean> {
  if (quitQuestion) return quitQuestion;
  const runs = live.filter((session) => session.kind === "run").length;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: [words.say("main.quitStop"), words.say("main.quitKeep")],
    defaultId: 1,
    cancelId: 1,
    title: "VibeForge",
    message: words.count("main.quit", live.length),
    detail: words.say(runs ? "main.quitRuns" : "main.quitCloses"),
  };
  quitQuestion = (ctx.win ? dialog.showMessageBox(ctx.win, options) : dialog.showMessageBox(options))
    .then(({ response }) => response === 0)
    .finally(() => {
      quitQuestion = null;
    });
  return quitQuestion;
}

/** Quit from the tray menu; running terminals are asked about first, as when closing the window. */
async function quitFromTray(): Promise<void> {
  const live = ctx.service?.listLive() ?? [];
  if (live.length && ctx.win) {
    focusWindow();
    if (!(await askToQuit(live))) return;
  }
  ctx.quitting = true;
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
      hostError: supervisor.running ? null : hostLife.error,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      os: osDescription(),
      repo: REPO_URL,
      appPath: ctx.appRoot,
      install,
      logFile: log.file,
    }),
    "app.palette": () => ctx.palette,
    "app.themes": () => listThemes(),
    "app.openPath": (target) => openPath(target),
    "app.openExternal": (url) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    },
    "app.pickFolder": async (title) => {
      // Electron opens dialogs in Downloads unless told where. Projects sit side by side, so start
      // beside the folder picked last, or beside the newest workspace.
      const newest = ctx.service?.listWorkspaces().workspaces.at(-1)?.path;
      const start = [pickedBeside, newest && path.dirname(newest)].find((dir): dir is string => Boolean(dir && fs.existsSync(dir)));
      const options = {
        title: title || words.say("main.chooseFolder"),
        defaultPath: start ?? os.homedir(),
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      };
      const result = ctx.win ? await dialog.showOpenDialog(ctx.win, options) : await dialog.showOpenDialog(options);
      const picked = result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
      if (picked) pickedBeside = path.dirname(picked);
      return picked;
    },
    "app.pathExists": (target) => fs.existsSync(target),
    "app.toggleDevTools": () => ctx.win?.webContents.toggleDevTools(),
    "app.restart": () => {
      // The renderer has already asked about running terminals; quitting stops them like any quit.
      log.info("Restarting");
      app.relaunch({ args: relaunchArgs(process.argv) });
      ctx.quitting = true;
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
      if (ctx.service?.getSettings().notify) notify({ title: note.title, body: note.body, workspaceId: note.workspaceId, chatId: note.chatId, agentId: note.agentId, route: note.route });
    },
    "app.doNotDisturb": () => omarchyDoNotDisturb(),
    "app.autostart": () => tray.autostart,
    "app.setAutostart": (on) => {
      tray.setAutostart(on);
      tray.sync();
      return tray.autostart;
    },
    "app.attention": (state) => tray.attention(state),
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
      await adoptShellPath(log);
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
    "agents.delete": (id) => s().deleteAgent(id),
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
    "orchestrator.get": () => s().orchestratorView(),
    "orchestrator.ask": (text) => s().orchestratorAsk(String(text ?? "")),
    "orchestrator.stopThinking": () => s().orchestratorStopThinking(),
    "orchestrator.models": (engineId) => s().orchestratorModels(String(engineId ?? "")),
    "orchestrator.clear": () => s().orchestratorClear(),
    "orchestrator.run": (turnId) => s().orchestratorRun(String(turnId ?? "")),
    "orchestrator.cancel": (turnId) => s().orchestratorCancel(String(turnId ?? "")),
    "orchestrator.editStep": (turnId, stepId, patch) => s().orchestratorEditStep(String(turnId ?? ""), String(stepId ?? ""), patch && typeof patch === "object" ? patch : {}),
    "orchestrator.removeStep": (turnId, stepId) => s().orchestratorRemoveStep(String(turnId ?? ""), String(stepId ?? "")),
    "orchestrator.copyDiff": (copyId) => s().orchestratorCopyDiff(String(copyId ?? "")),
    "orchestrator.applyCopy": (copyId) => s().orchestratorApplyCopy(String(copyId ?? "")),
    "orchestrator.discardCopy": (copyId) => s().orchestratorDiscardCopy(String(copyId ?? "")),

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

    // Anything the window writes is a person: typing, a paste, dictation, the Write box.
    "pty.write": (ptyId, data) => {
      ctx.service?.onHumanInput(ptyId, data);
      return supervisor.write(ptyId, data);
    },
    "pty.send": (ptyId, text) => {
      ctx.service?.onHumanInput(ptyId, "\r");
      return supervisor.send(ptyId, text);
    },
    "talk.sendDraft": (fromPty, toPty, what, selection) => s().sendDraft({ fromPty, toPty, what, selection }),
    "talk.review": (authorPty, reviewerPty) => s().startReview(authorPty, reviewerPty),
    "talk.stop": (ptyId) => s().stopTalk(ptyId),
    "talk.startTasks": (ptyId, taskIds) => s().startHeldTasks(ptyId, taskIds),
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
    // The window's own page only: should anything else ever load in it, it gets no bridge.
    if (!ctx.win || event.sender !== ctx.win.webContents || !isAppPage(event.senderFrame?.url ?? "", ctx.page)) throw new Error("Not allowed.");
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
    (ctx.win && contents === ctx.win.webContents ? PAGE_PERMISSIONS : WEB_PERMISSIONS).has(permission);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
}

async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromPath(ctx.iconPath);
  ctx.win = new BrowserWindow({
    width: 1480,
    height: 920,
    // A tiling window manager will give this window whatever slice is left. These floors stay
    // under a quarter of a laptop screen so the page actually becomes that size. The desk then
    // pans sideways (see --screen-floor) instead of drawing past the edge of the tile.
    minWidth: 280,
    minHeight: 220,
    title: "VibeForge",
    backgroundColor: ctx.palette.background,
    icon: icon.isEmpty() ? undefined : icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ctx.appRoot, "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  ctx.win.once("ready-to-show", () => {
    if (!(startHidden && ctx.service?.getSettings().tray)) {
      ctx.win?.show();
      return;
    }
    // From the login autostart entry, the window waits in the tray, once something hosts one.
    void tray.waitForHost(10_000).then((found) => {
      if (found) return;
      log.info("Started hidden, but nothing hosts the tray; showing the window");
      ctx.win?.show();
    });
  });
  ctx.win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window shows VibeForge's page and nothing else: a link or a script that points it at another
  // page, a file:// one included, is refused, and web links open in the browser instead.
  ctx.win.webContents.on("will-navigate", (event, url) => {
    if (isAppPage(url, ctx.page)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // Frames inside the page too (it has none of its own).
  ctx.win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || isAppPage(event.url, ctx.page)) return;
    event.preventDefault();
  });
  ctx.win.on("close", (event) => {
    if (ctx.quitting || !ctx.service) return;
    if (tray.icon.shown && tray.host && ctx.service.getSettings().tray && ctx.service.getSettings().closeToTray) {
      event.preventDefault();
      ctx.win?.hide();
      if (!trayNoticeShown && ctx.service.getSettings().notify) {
        trayNoticeShown = true;
        notify({ title: words.say("main.stillRunning"), body: words.say("main.stillRunningBody") });
      }
      return;
    }
    const live = ctx.service.listLive();
    if (live.length === 0) return;
    // The window stays while the question is up; a yes quits, which closes it.
    event.preventDefault();
    void askToQuit(live).then((quit) => {
      if (!quit) return;
      ctx.quitting = true;
      app.quit();
    });
  });
  const pageErrors = new PageErrors((line) => log.warn(`Page error: ${line}`));
  ctx.win.on("closed", () => {
    pageErrors.flush();
    dock.dispose();
    ctx.win = null;
  });
  ctx.win.webContents.on("render-process-gone", (_event, details) => log.error(`The window's page stopped: ${details.reason} (exit code ${details.exitCode})`));
  ctx.win.webContents.on("console-message", (event) => {
    if (event.level === "error") pageErrors.report(`${event.message}${event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : ""}`);
  });
  const page = ctx.page;
  if (page.devUrl) await ctx.win.loadURL(page.devUrl);
  else await ctx.win.loadFile(page.file);
}

/** A request from `vibeforge tell|who|task` in one of the terminals. */
async function answerTalk(request: TalkRequest, gone: AbortSignal): Promise<unknown> {
  if (!ctx.service) return { ok: false, error: "VibeForge is still starting." };
  if (request.op === "who") return { ok: true, ...ctx.service.whoIsHere(request.pty) };
  if (request.op === "tell") return ctx.service.tell({ fromPty: request.pty, to: request.to, text: request.text, wait: request.wait, timeoutMs: request.timeoutMs, gone });
  if (request.op === "apply") return ctx.service.applyHandedTask({ fromPty: request.pty, task: request.task });
  return ctx.service.handTask({ fromPty: request.pty, agent: request.agent, text: request.text, title: request.title, start: request.start, wait: request.wait, timeoutMs: request.timeoutMs });
}

const hostLife = new HostLifecycle(ctx, { voice, talk });
hostLife.wire();

function companionWire() {
  return {
    service: svc(),
    supervisor,
    root: path.join(ctx.appRoot, "companion"),
    icon: ctx.iconPath,
    log: (line: string) => log.info(line),
    plans: () => planSummary(false),
    hear: (pcm: Buffer, prompt: string) => voice.transcribe(pcm, prompt),
    canHear: () => voice.canTranscribe(),
  };
}

/** How long a quit waits for the phone page's server to close before going on without it. */
const COMPANION_STOP_MS = 2000;

async function shutdown(): Promise<void> {
  const stopped = await settleWithin(stopCompanion(), COMPANION_STOP_MS, (error) => log.warn(`The phone page did not stop cleanly: ${describeError(error)}`));
  if (!stopped) log.warn("The phone page did not stop in time; quitting without waiting for it");
  talk.dispose();
  voice.dispose();
  if (!ctx.service) return;
  ctx.service.prepareShutdown();
  await supervisor.shutdown(7000);
  await Promise.race([ctx.service.whenIdle(), new Promise((resolve) => setTimeout(resolve, 4000))]);
  ctx.service.shutdown();
  ctx.service.close();
  ctx.service = null;
}

/**
 * Start failed: say why and where the log is, then exit. Staying on with no window and no tray
 * would keep the single-instance lock, and every later launch would quietly do nothing.
 */
async function startFailed(error: unknown): Promise<void> {
  console.error(error);
  const detail = describeError(error);
  log.error(`VibeForge could not start: ${detail}`);
  try {
    await words.use(ctx.service?.getSettings().language ?? "system", app.getLocale());
  } catch {
    /* English, then */
  }
  dialog.showErrorBox(words.say("main.startFailed"), words.say("main.startFailedBody", { error: detail.split("\n")[0], log: log.file }));
  app.exit(1);
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
    guardPermissions();
    registerIpc();
    tray.icon.recolor(ctx.palette.accent2, ctx.palette.darkerBackground);
    // Watching before the icon is made, so a bar that restarts right after (as Omarchy's does at
    // login) gets the icon again instead of leaving VibeForge running with nothing to open it from.
    const stopTrayWatch = tray.watchHost();
    tray.sync();
    tray.syncWords();
    const hostReady = hostLife.start();
    await createWindow();
    await hostReady;
    const stopThemeWatch = watchOmarchyTheme(refreshPalette);
    const stopConfigWatch = watchConfig(roots.configRoot, (topics) => {
      ctx.service?.emit(...topics);
      if (topics.includes("settings")) refreshPalette();
    });
    const stopControl = listenControl(voice.status().controlSocket, log, (action) => send("voice-command", { action }), answerTalk);
    ctx.win?.on("focus", refreshPalette);
    // Checked again whenever the window comes forward, so it's current before a close.
    tray.refreshHost();
    ctx.win?.on("focus", () => tray.refreshHost());
    const tick = () =>
      void ctx.service
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
      void ctx.service
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
      stopTrayWatch();
    });
  }).catch(startFailed);

  app.on("before-quit", () => {
    ctx.quitting = true;
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
