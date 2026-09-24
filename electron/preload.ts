import { contextBridge, ipcRenderer } from "electron";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  paths: () => invoke("paths"),
  listWorkspaces: () => invoke("workspaces:list"),
  addWorkspace: (folderPath: string) => invoke("workspaces:add", folderPath),
  removeWorkspace: (id: string) => invoke("workspaces:remove", id),
  selectWorkspace: (id: string) => invoke("workspaces:select", id),
  pickDirectory: () => invoke("dialog:pick"),
  pathExists: (folderPath: string) => invoke("path:exists", folderPath),
  listEngines: () => invoke("engines:list"),
  recheckEngines: () => invoke("engines:list"),
  saveEngines: (engines: unknown) => invoke("engines:save", engines),
  ptySnapshot: (ptyId: string) => invoke("pty:snapshot", ptyId),
  createPty: (opts: unknown) => invoke("pty:create", opts),
  writePty: (ptyId: string, data: string) => invoke("pty:write", ptyId, data),
  resizePty: (ptyId: string, cols: number, rows: number) => invoke("pty:resize", ptyId, cols, rows),
  killPty: (ptyId: string) => invoke("pty:kill", ptyId),
  listPtys: () => invoke("pty:list"),
  onPtyData: (cb: (event: never) => void) => listen("pty:data", cb),
  onPtyExit: (cb: (event: never) => void) => listen("pty:exit", cb),
  onDockFail: (cb: (event: never) => void) => listen("dock:fail", cb),
  startShell: (opts: unknown) => invoke("code:shell", opts),
  startCodeSession: (opts: unknown) => invoke("code:launch", opts),
  listTree: (root: string) => invoke("files:tree", root),
  openPath: (folderPath: string) => invoke("files:open", folderPath),
  getDockUrl: (workspaceId: string) => invoke("dock:get", workspaceId),
  setDockUrl: (workspaceId: string, url: string) => invoke("dock:set", workspaceId, url),
  setDockBounds: (bounds: unknown) => invoke("dock:bounds", bounds),
  getSettings: () => invoke("settings:get"),
  saveSettings: (settings: unknown) => invoke("settings:save", settings),
  liveCount: () => invoke("pty:count"),
  listAgents: () => invoke("agents:list"),
  saveAgent: (draft: unknown) => invoke("agents:save", draft),
  deleteAgent: (id: string, confirmName: string) => invoke("agents:delete", id, confirmName),
  readMemory: (id: string) => invoke("agents:readMemory", id),
  writeMemory: (id: string, text: string) => invoke("agents:writeMemory", id, text),
  listSkills: () => invoke("skills:list"),
  saveSkill: (draft: unknown) => invoke("skills:save", draft),
  deleteSkill: (id: string) => invoke("skills:delete", id),
  listRoutines: () => invoke("routines:list"),
  saveRoutine: (draft: unknown) => invoke("routines:save", draft),
  deleteRoutine: (id: string) => invoke("routines:delete", id),
  runRoutineNow: (id: string) => invoke("routines:run", id),
  setRoutineEnabled: (id: string, enabled: boolean) => invoke("routines:enabled", id, enabled),
  previewRoutine: (schedule: unknown) => invoke("routines:preview", schedule),
  listRuns: () => invoke("runs:list"),
  getRun: (id: string) => invoke("runs:get", id),
  markRunOpened: (id: string) => invoke("runs:open", id),
  listInbox: () => invoke("runs:inbox"),
  startAgentChat: (agentId: string) => invoke("chats:startAgent", agentId),
  sendAgentChat: (agentId: string, chatId: string, text: string) => invoke("chats:sendAgent", agentId, chatId, text),
  listTasks: () => invoke("tasks:list"),
  saveTask: (draft: unknown) => invoke("tasks:save", draft),
  executeTask: (id: string) => invoke("tasks:execute", id),
  stopTask: (id: string) => invoke("tasks:stop", id),
  setTaskStatus: (id: string, status: unknown) => invoke("tasks:status", id, status),
  listChats: () => invoke("chats:list"),
  startChat: (engineId: string) => invoke("chats:start", engineId),
  renameChat: (id: string, name: string) => invoke("chats:rename", id, name),
  deleteChat: (id: string) => invoke("chats:delete", id),
  sendChat: (chatId: string, text: string) => invoke("chats:send", chatId, text),
};

contextBridge.exposeInMainWorld("forgedesk", api);
