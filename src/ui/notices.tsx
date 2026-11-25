import { useEffect, useRef } from "react";
import type { DeskNotice } from "../shared/api.js";
import { call, on } from "./api.js";
import { useCopyDiagnostics } from "./components/Help.js";
import { t } from "./i18n/index.js";
import { useToast, type ToastExtra, type ToastKind } from "./state.js";
import { placeInCode } from "./views/code/useWorkspacePanes.js";

// What the main process tells the person once (DeskNotice): the window came back after its page
// stopped, terminals were cut off by the terminal host stopping, the host stopped or started
// answering again, and errors nothing handled. Notices said while no page was there (the page that
// crashed, say) are taken when this one loads.

/** The toast a notice raises. It has no `action`: that is the button Ctrl+Z presses, and none of these is an Undo. */
export interface NoticeToast {
  kind: ToastKind;
  title: string;
  body?: string;
  extra?: ToastExtra;
}

/**
 * The toast for a notice that has one of its own, its buttons running `buttons`. Null for the host
 * stalling and answering again, which MainNotices pairs up itself. Its buttons go under the text
 * (`more`): the one beside a toast is what Ctrl+Z presses, as Undo, and none of these is an Undo. A
 * Ctrl+Z meant to undo a delete must not continue every run the host cut off.
 */
export function noticeToast(notice: DeskNotice, buttons: { copyDiagnostics: () => void; continueAll: (runIds: string[]) => void }): NoticeToast | null {
  if (notice.id === "window-reloaded") return { kind: "info", title: t("app.notice.windowReloaded"), body: t("app.notice.windowReloadedBody") };
  if (notice.id === "errors") {
    return { kind: "error", title: t("app.notice.errors"), body: t.count("app.notice.errorsBody", notice.count), extra: { more: [{ label: t("diagnostics.copy"), run: buttons.copyDiagnostics }] } };
  }
  if (notice.id === "host-stopped") {
    const runs = notice.runIds;
    const body = notice.terminals ? t.count("app.notice.hostStoppedBody", notice.terminals) : t("app.notice.hostStoppedNone");
    return {
      kind: "error",
      title: t("app.notice.hostStopped"),
      body: runs.length ? `${body} ${t("app.notice.hostStoppedContinue")}` : body,
      // It says what was cut off and offers Continue all: it stays until it is closed.
      extra: { stay: true, ...(runs.length ? { more: [{ label: t("app.notice.continueAll"), run: () => buttons.continueAll(runs) }] } : {}) },
    };
  }
  return null;
}

export function MainNotices() {
  const { push, dismiss, fail } = useToast();
  const copyDiagnostics = useCopyDiagnostics();
  // The newest, for the listeners set up once below.
  const copy = useRef(copyDiagnostics);
  copy.current = copyDiagnostics;

  useEffect(() => {
    // The "isn't answering" toast on screen, cleared when the host answers again.
    let stalled: number | null = null;
    // Each run picks its own session up; one that can't doesn't hold the others back.
    const continueAll = (runs: string[]) =>
      void (async () => {
        let failed: unknown = null;
        let continued = 0;
        for (const runId of runs) {
          try {
            const next = await call("runs.continue", runId);
            // A chat's or a task's run continues in its own place; one from Code goes back in its pane.
            if (!next.chatId && !next.taskId) placeInCode(next.ptyId);
            continued += 1;
          } catch (error) {
            failed ??= error;
          }
        }
        if (continued) push("success", t.count("app.notice.continued", continued));
        if (failed) fail(failed, t("app.notice.continueFailed"));
      })();
    const show = (notice: DeskNotice) => {
      if (notice.id === "host-stalled") {
        stalled = push("error", t("app.notice.hostStalled"), t("app.notice.hostStalledBody"));
        return;
      }
      if (notice.id === "host-answering") {
        if (stalled !== null) dismiss(stalled);
        stalled = null;
        push("success", t("app.notice.hostAnswering"));
        return;
      }
      const toast = noticeToast(notice, { copyDiagnostics: () => void copy.current(), continueAll });
      if (!toast) return;
      // Pressed, a button takes its toast away, as the one beside a toast does: Continue all runs once.
      let id = 0;
      const more = toast.extra?.more?.map((button) => ({
        ...button,
        run: () => {
          dismiss(id);
          button.run();
        },
      }));
      id = push(toast.kind, toast.title, toast.body, undefined, { ...toast.extra, more });
    };
    const off = on("notice", show);
    void call("app.notices")
      .then((missed) => missed.forEach(show))
      .catch(() => undefined);
    return off;
  }, [push, dismiss, fail]);

  return null;
}
