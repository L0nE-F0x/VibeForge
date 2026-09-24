import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, WebContentsView } from "electron";
import { whichBin, withAvailability } from "../src/core/engines.js";
import { listTree } from "../src/core/files.js";
import { ensureLayout, defaultRoots } from "../src/core/layout.js";
import { codePreamble } from "../src/core/preamble.js";
import { nextFireTimes, TICK_MS } from "../src/core/routines.js";
import { snapshotGit } from "../src/core/git.ts";
import { TeamService, type TeamHost } from "../src/core/team-service.js";
import type { EngineRow, Schedule, Settings } from "../src/core/types.js";
import {
  addWorkspaceRecord,
  readWorkspaces,
  removeWorkspaceRecord,
  selectWorkspaceRecord,
  setDockUrlRecord,
  writeWorkspaces,
} from "../src/core/workspaces.js";
import { PtySupervisor } from "./supervisor.js";

const roots = defaultRoots();
ensureLayout(roots.configRoot, roots.dataRoot);

const supervisor = new PtySupervisor();
const alive = new Set<string>();
let win: BrowserWindow | null = null;
let dock: WebContentsView | null = null;
let dockUrl = "";

function settingsPath(): string {
  return path.join(roots.configRoot, "settings.json");
}

function readSettings(): Settings {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Settings;
}

function enginesPath(): string {
  return path.join(roots.configRoot, "engines.json");
}

function readEngines(): (EngineRow & { available: boolean })[] {
  const raw = JSON.parse(fs.readFileSync(enginesPath(), "utf8")) as { engines: EngineRow[] };
  return withAvailability(raw.engines, whichBin);
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) === "dist-electron") return path.resolve(here, "..");
  return process.cwd();
}

function preloadFile(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["preload.mjs", "preload.js", "preload.cjs"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, "preload.js");
}

function notify(title: string, body: string): void {
  if (!readSettings().notify) return;
  const child = spawn("notify-send", [title, body], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

const runDirByPty = new Map<string, string>();

const host: TeamHost = {
  async spawnPty(request) {
    const result = await supervisor.spawn({
      cwd: request.cwd,
      argv: request.argv,
      runDir: request.runDir,
    });
    const ptyId = String(result.ptyId);
    alive.add(ptyId);
    runDirByPty.set(ptyId, request.runDir);
    if (request.initialInput) await supervisor.write(ptyId, request.initialInput);
    return { ptyId };
  },
  writePty(ptyId, data) {
    void supervisor.write(ptyId, data);
  },
  killPty(ptyId) {
    void supervisor.kill(ptyId, runDirByPty.get(ptyId) ?? null);
  },
  isPtyAlive(ptyId) {
    return alive.has(ptyId);
  },
  resolveBin: whichBin,
  notify,
  snapshotGit,
};

const team = new TeamService({
  configRoot: roots.configRoot,
  dataRoot: roots.dataRoot,
  appStartedAt: new Date(),
  now: () => new Date(),
  host,
});

function track(ptyId: string): void {
  alive.add(ptyId);
}

supervisor.onExitHandlers.push((event) => {
  alive.delete(event.ptyId);
  win?.webContents.send("pty:exit", { ptyId: event.ptyId, exitCode: event.exitCode, status: event.status });
  void team.notePtyExit(event.ptyId, event.exitCode);
});

supervisor.onDataHandlers.push((event) => {
  win?.webContents.send("pty:data", event);
});

function workspaceById(id: string) {
  return readWorkspaces(roots.configRoot).workspaces.find((item) => item.id === id);
}

function registerIpc(): void {
  ipcMain.handle("paths", () => roots);
  ipcMain.handle("workspaces:list", () => readWorkspaces(roots.configRoot));
  ipcMain.handle("workspaces:add", (_event, folderPath: string) => {
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw new Error("Choose an existing folder.");
    }
    const next = addWorkspaceRecord(readWorkspaces(roots.configRoot), folderPath);
    writeWorkspaces(roots.configRoot, next);
    return next;
  });
  ipcMain.handle("workspaces:remove", (_event, id: string) => {
    const next = removeWorkspaceRecord(readWorkspaces(roots.configRoot), id);
    writeWorkspaces(roots.configRoot, next);
    return next;
  });
  ipcMain.handle("workspaces:select", (_event, id: string) => {
    writeWorkspaces(roots.configRoot, selectWorkspaceRecord(readWorkspaces(roots.configRoot), id));
  });
  ipcMain.handle("dialog:pick", async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? win ?? undefined;
    const result = await dialog.showOpenDialog(parent!, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("path:exists", (_event, folderPath: string) => {
    try {
      return fs.statSync(folderPath).isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle("engines:list", () => readEngines());
  ipcMain.handle("engines:save", (_event, rows: EngineRow[]) => {
    const clean = rows.map((row) => ({
      id: row.id.trim(),
      label: row.label.trim() || row.id.trim(),
      bin: row.bin.trim(),
      args: row.args ?? [],
    }));
    fs.writeFileSync(enginesPath(), JSON.stringify({ engines: clean }, null, 2));
    return withAvailability(clean, whichBin);
  });
  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:save", (_event, settings: Settings) => {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    return settings;
  });
  ipcMain.handle("pty:snapshot", async (_event, ptyId: string) => {
    const snap = await supervisor.snapshot(ptyId);
    return { text: String(snap.text ?? ""), seq: Number(snap.seq ?? 0), alive: Boolean(snap.alive) };
  });
  ipcMain.handle("pty:create", async (_event, opts: { cwd: string; argv?: string[]; cols?: number; rows?: number }) => {
    const result = await supervisor.spawn(opts);
    const ptyId = String(result.ptyId);
    track(ptyId);
    return { ptyId };
  });
  ipcMain.handle("pty:write", async (_event, ptyId: string, data: string) => {
    await supervisor.write(ptyId, data);
  });
  ipcMain.handle("pty:resize", async (_event, ptyId: string, cols: number, rows: number) => {
    await supervisor.resize(ptyId, cols, rows);
  });
  ipcMain.handle("pty:kill", async (_event, ptyId: string) => {
    await supervisor.kill(ptyId);
  });
  ipcMain.handle("pty:list", async () => supervisor.list().then((result) => result.ptys ?? []));
  ipcMain.handle("pty:count", () => alive.size);
  ipcMain.handle("code:shell", async (_event, opts: { workspaceId: string }) => {
    const workspace = workspaceById(opts.workspaceId);
    if (!workspace) throw new Error("Open a workspace first.");
    const shell = readSettings().defaultShell || process.env.SHELL || "/bin/bash";
    const result = await supervisor.spawn({ cwd: workspace.path, argv: [shell] });
    const ptyId = String(result.ptyId);
    track(ptyId);
    return { ptyId };
  });
  ipcMain.handle("code:launch", async (_event, opts: { workspaceId: string; engineId: string; prompt?: string }) => {
    const workspace = workspaceById(opts.workspaceId);
    if (!workspace) throw new Error("Open a workspace first.");
    const engine = readEngines().find((item) => item.id === opts.engineId);
    if (!engine?.available) throw new Error("That engine is not on PATH.");
    const bin = whichBin(engine.bin);
    if (!bin) throw new Error("That engine is not on PATH.");
    const argv = [bin, ...engine.args];
    if (!opts.prompt?.trim()) {
      const result = await supervisor.spawn({ cwd: workspace.path, argv });
      const ptyId = String(result.ptyId);
      track(ptyId);
      return { ptyId };
    }
    const result = await supervisor.startPrompted({
      dataRoot: roots.dataRoot,
      cwd: workspace.path,
      argv,
      preamble: codePreamble(workspace.path, opts.prompt),
      origin: "code",
      slug: "code",
      meta: { prompt: opts.prompt, engine: engine.id, cwd: workspace.path, origin: "code" },
    });
    const ptyId = String(result.ptyId);
    track(ptyId);
    return { ptyId, runId: String(result.runId) };
  });
  ipcMain.handle("files:tree", (_event, root: string) => listTree(root));
  ipcMain.handle("files:open", (_event, folderPath: string) => {
    const child = spawn("xdg-open", [folderPath], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  });
  ipcMain.handle("dock:get", (_event, workspaceId: string) => workspaceById(workspaceId)?.dockUrl ?? "");
  ipcMain.handle("dock:set", async (_event, workspaceId: string, url: string) => {
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\//.test(trimmed)) throw new Error("Enter a full URL including http://");
    writeWorkspaces(roots.configRoot, setDockUrlRecord(readWorkspaces(roots.configRoot), workspaceId, trimmed));
    dockUrl = trimmed;
    if (dock && trimmed) {
      try {
        await dock.webContents.loadURL(trimmed);
      } catch (error) {
        win?.webContents.send("dock:fail", {
          description: error instanceof Error ? error.message : "Could not load that URL.",
          url: trimmed,
        });
      }
    }
  });
  ipcMain.handle(
    "dock:bounds",
    async (
      _event,
      bounds: { x: number; y: number; width: number; height: number; visible: boolean; url?: string },
    ) => {
      if (!win) return;
      if (!dock) {
        dock = new WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        win.contentView.addChildView(dock);
        dock.webContents.on("did-fail-load", (_event2, code, description, url, isMainFrame) => {
          if (!isMainFrame || code === -3) return;
          win?.webContents.send("dock:fail", { description, url });
        });
      }
      if (!bounds.visible || bounds.width < 8 || bounds.height < 8) {
        dock.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      dock.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
      const next = bounds.url?.trim() || dockUrl;
      if (next && next !== dock.webContents.getURL()) {
        dockUrl = next;
        try {
          await dock.webContents.loadURL(next);
        } catch (error) {
          win.webContents.send("dock:fail", {
            description: error instanceof Error ? error.message : "Could not load that URL.",
            url: next,
          });
        }
      }
    },
  );

  const wrap = (channel: string, fn: (...args: never[]) => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };
  wrap("agents:list", () => team.listAgents());
  wrap("agents:save", (draft) => team.saveAgent(draft));
  wrap("agents:delete", (id, confirmName) => team.deleteAgent(id, confirmName));
  wrap("agents:readMemory", (id) => team.readMemory(id));
  wrap("agents:writeMemory", (id, text) => team.writeMemory(id, text));
  wrap("skills:list", () => team.listSkills());
  wrap("skills:save", (draft) => team.saveSkill(draft));
  wrap("skills:delete", (id) => team.deleteSkill(id));
  wrap("routines:list", () => team.listRoutines());
  wrap("routines:save", (draft) => team.saveRoutine(draft));
  wrap("routines:delete", (id) => team.deleteRoutine(id));
  wrap("routines:run", (id) => team.runRoutineNow(id));
  wrap("routines:enabled", (id, enabled) => team.setRoutineEnabled(id, enabled));
  wrap("routines:preview", (schedule: Schedule) => nextFireTimes(schedule, new Date(), 3).map((when) => when.toISOString()));
  wrap("runs:list", () => team.listRuns());
  wrap("runs:get", (id) => team.getRun(id));
  wrap("runs:open", (id) => team.markRunOpened(id));
  wrap("runs:inbox", () => team.listInboxRuns());
  wrap("chats:startAgent", (agentId: string) => team.startAgentChat(agentId));
  wrap("chats:sendAgent", (agentId: string, chatId: string, text: string) => team.sendAgentChat(agentId, chatId, text));
  wrap("tasks:list", () => team.listTasks());
  wrap("tasks:save", (draft) => team.saveTask(draft));
  wrap("tasks:execute", (id) => team.executeTask(id));
  wrap("tasks:stop", (id) => team.stopTask(id));
  wrap("tasks:status", (id, status) => team.setTaskStatus(id, status));
  wrap("chats:list", () => team.listChats());
  wrap("chats:start", (engineId: string) => team.startChat(engineId));
  wrap("chats:rename", (id, name) => team.renameChat(id, name));
  wrap("chats:delete", (id) => team.deleteChat(id));
  wrap("chats:send", (chatId: string, text: string) => team.sendChat(chatId, text));
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "ForgeDesk",
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setTitle("ForgeDesk");
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(projectRoot(), "dist", "index.html"));
  win.on("closed", () => {
    dock = null;
    win = null;
  });
}

if (process.env.FORGEDESK_DEBUG === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}
app.setName("ForgeDesk");
app.setAppUserModelId("dev.forgedesk.app");
if (process.platform === "linux") app.commandLine.appendSwitch("class", "forgedesk");

app.whenReady().then(async () => {
  registerIpc();
  try {
    await supervisor.start(projectRoot());
  } catch (error) {
    console.error(error);
  }
  await createWindow();
  const tick = () => {
    team.tick().catch((error) => console.error(error));
  };
  setTimeout(tick, 1000);
  setInterval(tick, TICK_MS);
});

app.on("window-all-closed", () => {
  supervisor.shutdown();
  app.quit();
});
