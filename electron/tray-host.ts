import { spawn } from "node:child_process";

// The bar that hosts tray icons can come and go while VibeForge runs: at login Omarchy's bar starts,
// then restarts a second later, and a theme change or a bar reload does the same. A new host only
// knows the icons registered with it, and Electron never registers again, so VibeForge would sit in
// the background with no icon to open it from. This watches the host's name on the session bus and
// says when a new one takes it, so the icon can be made again.

export const TRAY_WATCHER = "org.kde.StatusNotifierWatcher";

/**
 * Reads `dbus-monitor` output for NameOwnerChanged on the tray watcher's name: a signal line, then
 * the name, the old owner and the new owner as string lines. Calls back with the new owner, "" when
 * the host went away.
 */
export function ownerChanges(onOwner: (owner: string) => void): (chunk: string) => void {
  let buffered = "";
  let args: string[] | null = null;
  return (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (/^signal\b/.test(line)) {
        args = /member=NameOwnerChanged\b/.test(line) ? [] : null;
        continue;
      }
      const value = /^\s+string "(.*)"$/.exec(line)?.[1];
      if (!args || value === undefined) continue;
      args.push(value);
      if (args.length < 3) continue;
      if (args[0] === TRAY_WATCHER) onOwner(args[2]);
      args = null;
    }
  };
}

/** Watches for the tray host appearing ("" when it leaves). Returns a stop. Without dbus-monitor it does nothing. */
export function watchTrayHost(onOwner: (owner: string) => void, warn: (message: string) => void): () => void {
  let stopped = false;
  const rule = `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${TRAY_WATCHER}'`;
  const child = spawn("dbus-monitor", ["--session", rule], { stdio: ["ignore", "pipe", "ignore"] });
  const read = ownerChanges(onOwner);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", read);
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") warn(`Watching the tray host: ${error.message}`);
  });
  child.on("exit", (code) => {
    if (!stopped && code) warn(`Watching the tray host stopped (dbus-monitor exited ${code})`);
  });
  return () => {
    stopped = true;
    child.kill();
  };
}
