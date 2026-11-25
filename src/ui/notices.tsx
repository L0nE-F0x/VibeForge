import { useEffect, useRef } from "react";
import type { DeskNotice } from "../shared/api.js";
import { call, on } from "./api.js";
import { useCopyDiagnostics } from "./components/Help.js";
import { t } from "./i18n/index.js";
import { useToast } from "./state.js";
import { placeInCode } from "./views/code/useWorkspacePanes.js";

// What the main process tells the person once (DeskNotice): the window came back after its page
// stopped, terminals were cut off by the terminal host stopping, the host stopped or started
// answering again, and errors nothing handled. Notices said while no page was there (the page that
// crashed, say) are taken when this one loads.

export function MainNotices() {
  const { push, dismiss, fail } = useToast();
  const copyDiagnostics = useCopyDiagnostics();
  // The newest, for the listeners set up once below.
  const copy = useRef(copyDiagnostics);
  copy.current = copyDiagnostics;

  useEffect(() => {
    // The "isn't answering" toast on screen, cleared when the host answers again.
    let stalled: number | null = null;
    const show = (notice: DeskNotice) => {
      if (notice.id === "window-reloaded") {
        push("info", t("app.notice.windowReloaded"), t("app.notice.windowReloadedBody"));
      } else if (notice.id === "host-stalled") {
        stalled = push("error", t("app.notice.hostStalled"), t("app.notice.hostStalledBody"));
      } else if (notice.id === "host-answering") {
        if (stalled !== null) dismiss(stalled);
        stalled = null;
        push("success", t("app.notice.hostAnswering"));
      } else if (notice.id === "errors") {
        push("error", t("app.notice.errors"), t.count("app.notice.errorsBody", notice.count), {
          label: t("diagnostics.copy"),
          run: () => void copy.current(),
        });
      } else if (notice.id === "host-stopped") {
        const runs = notice.runIds;
        const body = notice.terminals ? t.count("app.notice.hostStoppedBody", notice.terminals) : t("app.notice.hostStoppedNone");
        push(
          "error",
          t("app.notice.hostStopped"),
          runs.length ? `${body} ${t("app.notice.hostStoppedContinue")}` : body,
          runs.length
            ? {
                label: t("app.notice.continueAll"),
                run: () =>
                  void (async () => {
                    // Each run picks its own session up; one that can't doesn't hold the others back.
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
                  })(),
              }
            : undefined,
          // It says what was cut off and offers Continue all: it stays until it is closed.
          { stay: true },
        );
      }
    };
    const off = on("notice", show);
    void call("app.notices")
      .then((missed) => missed.forEach(show))
      .catch(() => undefined);
    return off;
  }, [push, dismiss, fail]);

  return null;
}
