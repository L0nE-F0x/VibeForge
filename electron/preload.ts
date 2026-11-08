import { contextBridge, ipcRenderer, webUtils } from "electron";

const EVENTS = new Set(["changed", "pty-data", "pty-exit", "palette", "dock", "open-run", "open-workspace", "open-chat", "open-route", "open-view", "open-switcher", "run-finished", "host-crash", "voice", "voice-talk", "voice-command"]);

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

// A file dropped anywhere but a terminal, a composer or a pane is refused here, so it can never be
// opened as the page. Electron's navigateOnDragDrop is off as well; this is the second lock. The
// page's own drop targets run first and cancel dragover themselves, so they still take drops.
window.addEventListener("dragover", (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => event.preventDefault());
