import { useEffect, useRef } from "react";
import type { Workspace } from "../../../shared/api.js";
import { overlayOpen } from "../../overlays.js";
import type { WorkspacePanes } from "./useWorkspacePanes.js";

/** Ctrl+Shift+D / E open a terminal right / below, W closes the focused one, M maximizes it; while Code is on screen. */
export function useCodeShortcuts(active: boolean, current: Workspace | null, panes: WorkspacePanes): void {
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcuts.current = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || !current) return;
    const key = event.key.toLowerCase();
    if (key !== "m" && key !== "d" && key !== "e" && key !== "w") return;
    // A menu or dialog is open: the keys mustn't open or close panes behind it.
    if (overlayOpen()) return;
    event.preventDefault();
    // Holding the keys repeats them; one press is one pane.
    if (event.repeat) return;
    const { paneId, pane } = panes.focusedPane(current.id);
    if (key === "m" && paneId) panes.toggleZoom(current.id, paneId);
    else if (key === "d") panes.newTerminal(current, "row");
    else if (key === "e") panes.newTerminal(current, "col");
    else if (key === "w" && pane) void panes.closePane(current, pane);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => shortcuts.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
