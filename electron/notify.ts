import { spawn } from "node:child_process";
import { Notification } from "electron";
import { openNote, type NoteTarget } from "./guards.js";
import type { MainContext } from "./main-context.js";

/** A desktop notification's words, and where a click on it goes. */
export interface Note extends NoteTarget {
  title: string;
  body: string;
}

export type Notify = (note: Note) => void;

/**
 * Desktop notifications; clicking one brings VibeForge up on the run or workspace it is about.
 * Where Electron can't show them, notify-send does, without the click.
 */
export function desktopNotifier(ctx: MainContext): Notify {
  // Held until closed, so each one's click handler stays alive.
  const notifications = new Set<Notification>();
  return (note) => {
    if (Notification.isSupported()) {
      // VibeForge plays its own sounds, so the desktop's would be a second one for the same moment.
      const silent = Boolean(ctx.service?.getSettings().sounds.on);
      const notification = new Notification({ title: note.title, body: note.body, icon: ctx.iconPath, silent });
      notifications.add(notification);
      notification.on("click", () => {
        ctx.focusWindow();
        openNote(note, ctx.send);
      });
      notification.on("close", () => notifications.delete(notification));
      notification.show();
      return;
    }
    const child = spawn("notify-send", ["-a", "VibeForge", note.title, note.body], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  };
}
