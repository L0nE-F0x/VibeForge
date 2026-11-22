import { useEffect, useRef } from "react";
import type { Workspace } from "../../../shared/api.js";
import { overlayOpen } from "../../overlays.js";
import { panesOf } from "../../pane-layout.js";
import { runShortcut, type ShortcutAction, type ShortcutIdIn } from "../../shortcuts.js";
import type { WorkspacePanes } from "./useWorkspacePanes.js";

/**
 * Ctrl+Shift+D / E open a terminal right / below, W closes the focused one, M maximizes it, and
 * Ctrl+Shift+[ / ] cycle focus between panes while Code is on screen.
 */
export function useCodeShortcuts(active: boolean, current: Workspace | null, panes: WorkspacePanes): void {
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcuts.current = (event: KeyboardEvent) => {
    if (!current) return;
    const cyclePane = (delta: -1 | 1): boolean => {
      const layout = panes.layouts[current.id];
      const list = layout ? panesOf(layout) : [];
      if (list.length < 2) return false;
      const focusedId = panes.focusedPane(current.id).paneId;
      const at = list.findIndex((item) => item.id === focusedId);
      const next = list[((at >= 0 ? at : 0) + delta + list.length) % list.length];
      panes.focusPane(current.id, next.id);
      panes.terminals.current.get(next.id)?.focus();
      return true;
    };
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
      "code.prevPane": () => cyclePane(-1),
      "code.nextPane": () => cyclePane(1),
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
