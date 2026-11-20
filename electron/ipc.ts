import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, clipboard, dialog, ipcMain, shell } from "electron";
import type { TalkRequest } from "../src/core/control.js";
import { listDir } from "../src/core/files.js";
import { describeError } from "../src/core/log.js";
import { speakable } from "../src/core/replies.js";
import { listThemes } from "../src/core/theme.js";
import type { Method, MethodArgs, MethodResult } from "../src/shared/api.js";
import type { Looking } from "../src/shared/orchestrator.js";
import { companionStatus } from "./companion.js";
import { phoneReach, serveCommand } from "../src/core/phone-reach.js";
import type { Dock } from "./dock.js";
import { isAppPage, relaunchArgs } from "./guards.js";
import type { HostLifecycle } from "./host-lifecycle.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";
import type { Stats } from "./stats.js";
import type { Sync } from "./sync.js";
import { isSyncMode } from "../src/core/sync/protocol.js";
import { adoptShellPath, omarchyDoNotDisturb, openPath, osDescription } from "./system.js";
import type { Call } from "./call.js";
import type { TrayController } from "./tray-controller.js";
import type { Updater } from "./updater.js";
import type { Voice } from "./voice.js";

// What the window and the terminals may ask of the main process: the window's calls over IPC (the
// table below, behind one check that the call comes from VibeForge's own page), and requests from
// `vibeforge tell|who|task` over the control socket.

const REPO_URL = "https://github.com/L0nE-F0x/VibeForge";

/** The parts of the main process the calls reach. */
export interface IpcParts {
  host: HostLifecycle;
  stats: Stats;
  tray: TrayController;
  updater: Updater;
  voice: Voice;
  call: Call;
  dock: Dock;
  sync: Sync;
  notify: Notify;
  /** Repaints the window, the page and the tray icon in the theme Settings name. */
  refreshPalette: () => void;
}

type Handlers = { [K in Method]: (...args: MethodArgs<K>) => MethodResult<K> | Promise<MethodResult<K>> };

function handlers(ctx: MainContext, parts: IpcParts): Handlers {
  const { roots, log, supervisor, words, install, focusWindow } = ctx;
  const { host, stats, tray, updater, voice, call, dock, sync, notify, refreshPalette } = parts;
  /** How a share syncs, from whatever the window sent. */
  const shareOptions = (value: unknown) => {
    const raw = value && typeof value === "object" ? (value as { mode?: unknown; filesOnly?: unknown }) : {};
    return { mode: isSyncMode(raw.mode) ? raw.mode : ("two" as const), filesOnly: raw.filesOnly === true };
  };
  const s = ctx.svc;
  /** Where the last folder picked sits, so the next folder dialog opens there. */
  let pickedBeside: string | null = null;
  return {
    "app.info": () => ({
      version: app.getVersion(),
      configRoot: roots.configRoot,
      dataRoot: roots.dataRoot,
      home: os.homedir(),
      hostRunning: supervisor.running,
      hostError: supervisor.running ? null : host.error,
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
      app.relaunch({ execPath: process.execPath, args: relaunchArgs(process.argv) });
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
    "usage.summary": () => (s().getSettings().usage ? stats.usage.scan() : null),
    "plans.summary": (fresh) => stats.planSummary(Boolean(fresh)),
    "activity.get": (fresh) => stats.activityFor(s().getSettings().activity, Boolean(fresh)),
    "app.notify": (note) => {
      if (note.always === true || ctx.service?.getSettings().notify) {
        notify({ title: note.title, body: note.body, workspaceId: note.workspaceId, chatId: note.chatId, agentId: note.agentId, route: note.route, ...(note.silent === true ? { silent: true } : {}) });
      }
    },
    "app.doNotDisturb": () => omarchyDoNotDisturb(),
    "app.autostart": () => tray.autostart,
    "app.setAutostart": (on) => {
      tray.setAutostart(on);
      tray.sync();
      return tray.autostart;
    },
    "app.attention": (state) => tray.attention(state),
    "app.logTail": (lines) => {
      const safeLines = Number.isFinite(lines) ? Math.floor(lines) : 200;
      const count = Math.max(10, Math.min(2000, safeLines));
      return log.tail(count);
    },

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
    "companion.reach": async () => {
      const port = s().getSettings().companion.port;
      return { ...(await phoneReach(port)), command: serveCommand(port) };
    },
    "engines.list": () => s().listEngines(),
    "engines.recheck": async () => {
      await adoptShellPath(log);
      s().emit("engines", "agents", "routines", "tasks");
      return s().listEngines();
    },
    "engines.save": (rows) => s().saveEngines(rows),

    "workspaces.list": () => s().listWorkspaces(),
    "workspaces.status": () => s().summarizeWorkspaces(),
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
    "orchestrator.ask": (text) => s().orchestratorAsk(String(text ?? ""), ctx.looking),
    "app.looking": (looking) => {
      const text = (value: unknown) => (typeof value === "string" && value.length <= 200 ? value : undefined);
      const view = looking && typeof looking === "object" ? text((looking as Looking).view) : undefined;
      ctx.looking = view ? { view, workspaceId: text((looking as Looking).workspaceId), ptyId: text((looking as Looking).ptyId) } : null;
      ctx.service?.orchestratorLooking(ctx.looking);
    },
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

    "sync.view": () => sync.view(),
    "sync.install": () => sync.install(),
    "sync.addMachine": (code) => sync.addMachine(String(code ?? "").slice(0, 2000)),
    "sync.acceptMachine": (id) => sync.acceptRequest(String(id ?? "")),
    "sync.ignoreMachine": (id) => sync.ignoreRequest(String(id ?? "")),
    "sync.removeMachine": (id) => sync.removeMachine(String(id ?? "")),
    "sync.share": (workspaceId, machineId, options) => sync.share(String(workspaceId ?? ""), String(machineId ?? ""), shareOptions(options)),
    "sync.updateShare": (folderId, options) => sync.updateShare(String(folderId ?? ""), shareOptions(options)),
    "sync.stopShare": (folderId) => sync.stopShare(String(folderId ?? "")),
    "sync.acceptOffer": (folderId, folder) => sync.acceptOffer(String(folderId ?? ""), String(folder ?? "")),
    "sync.declineOffer": (folderId) => sync.declineOffer(String(folderId ?? "")),
    "sync.conflictDiff": (id) => sync.conflictDiff(String(id ?? "")),
    "sync.resolveConflict": (id, keep) => sync.resolveConflict(String(id ?? ""), keep === "mine" ? "mine" : "theirs"),
    "sync.mergeConflict": (id) => sync.mergeConflict(String(id ?? "")),

    "voice.status": () => voice.status(),
    "voice.start": () => voice.start(),
    "voice.stop": (prompt) => voice.stop(typeof prompt === "string" ? prompt.slice(0, 1000) : ""),
    "voice.cancel": () => voice.cancel(),
    "voice.download": (kind, id) => voice.startDownload(kind === "voice" ? "voice" : kind === "sherpa" ? "sherpa" : "model", String(id)),
    "voice.stopDownload": () => voice.stopDownload(),
    "voice.speak": (text) => {
      const line = speakable(String(text).slice(0, 2000), "full");
      const file = voice.voiceFor();
      if (line && file && voice.speaker.piper() && voice.speaker.player()) void voice.speaker.speak(line, file);
    },
    "voice.silence": () => voice.speaker.stop(),
    "voice.installBindings": () => voice.installBindings(),

    "call.get": () => call.get(),
    "call.start": () => call.start(),
    "call.stop": () => call.stop(),
    "call.mute": (muted) => call.mute(typeof muted === "boolean" ? muted : undefined),

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

/** The window's calls into the main process; each one must come from VibeForge's own page in the window. */
export function registerIpc(ctx: MainContext, parts: IpcParts): void {
  const { log } = ctx;
  const table = handlers(ctx, parts) as Record<string, (...args: unknown[]) => unknown>;
  ipcMain.handle("vf:call", async (event, method: string, ...args: unknown[]) => {
    // The window's own page only: should anything else ever load in it, it gets no bridge.
    if (!ctx.win || event.sender !== ctx.win.webContents || !isAppPage(event.senderFrame?.url ?? "", ctx.page)) throw new Error("Not allowed.");
    const handler = Object.hasOwn(table, method) ? table[method] : undefined;
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

/** A request from `vibeforge tell|who|task` in one of the terminals. */
export async function answerTalk(ctx: MainContext, request: TalkRequest, gone: AbortSignal): Promise<unknown> {
  if (!ctx.service) return { ok: false, error: "VibeForge is still starting." };
  if (request.op === "who") return { ok: true, ...ctx.service.whoIsHere(request.pty) };
  if (request.op === "tell") return ctx.service.tell({ fromPty: request.pty, to: request.to, text: request.text, wait: request.wait, timeoutMs: request.timeoutMs, gone });
  if (request.op === "apply") return ctx.service.applyHandedTask({ fromPty: request.pty, task: request.task });
  return ctx.service.handTask({ fromPty: request.pty, agent: request.agent, text: request.text, title: request.title, start: request.start, wait: request.wait, timeoutMs: request.timeoutMs, gone });
}
