import { contextBridge, ipcRenderer, webUtils } from "electron";

const EVENTS = new Set(["changed", "pty-data", "pty-exit", "palette", "dock", "open-run", "host-crash", "voice", "voice-talk", "voice-command"]);

contextBridge.exposeInMainWorld("vibeforge", {
  call(method: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke("vf:call", method, ...args);
  },
  on(event: string, listener: (payload: unknown) => void): () => void {
    if (!EVENTS.has(event)) throw new Error(`Unknown event ${event}`);
    const channel = `vf:${event}`;
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** Dropped files lose `File.path` under context isolation; this gets the real path back. */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
});
