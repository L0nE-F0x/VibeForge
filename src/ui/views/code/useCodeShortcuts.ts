import { useEffect, useRef } from "react";
import type { Workspace } from "../../../shared/api.js";
import { overlayOpen } from "../../overlays.js";
import { runShortcut, type ShortcutAction, type ShortcutIdIn } from "../../shortcuts.js";
import type { WorkspacePanes } from "./useWorkspacePanes.js";

/**
 * Ctrl+Shift+D / E open a terminal right / below, W closes the focused one, M maximizes it; while
 * Code is on screen. Under a menu or dialog they wait, so a key can't open or close a pane behind
 * it, and holding one down is one press (shortcuts.ts says so).
 */
export function useCodeShortcuts(active: boolean, current: Workspace | null, panes: WorkspacePanes): void {
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcuts.current = (event: KeyboardEvent) => {
    if (!current) return;
    const actions = {
      "code.splitRight": () => panes.newTerminal(current, "row"),
      "code.splitDown": () => panes.newTerminal(current, "col"),
      "code.close": () => {
        const { pane } = panes.focusedPane(current.id);
        if (pane) void panes.closePane(current, pane);
      },
      "code.maximize": () => {
        const { paneId } = panes.focusedPane(current.id);
        if (paneId) panes.toggleZoom(current.id, paneId);
      },
    } satisfies Record<ShortcutIdIn<"code">, ShortcutAction>;
    runShortcut(event, actions, overlayOpen);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => shortcuts.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
