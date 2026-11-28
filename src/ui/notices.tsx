import { useEffect, useRef } from "react";
import type { DeskNotice } from "../shared/api.js";
import { call, on } from "./api.js";
import { useCopyDiagnostics } from "./components/Help.js";
import { t } from "./i18n/index.js";
import { useNav, useToast } from "./state.js";
import { placeInCode } from "./views/code/useWorkspacePanes.js";
import { continueInPanes, cutOffNote, inPane, settleCutOff } from "./cut-off.js";
import type { CutOffRun } from "../shared/api.js";

/** Said once per window: a reload of the page doesn't offer the same cut-off CLIs again. */
const CUT_OFF_SAID = "vibeforge:cut-off-said";

/**
 * Pick each cut-off run back up: one from a Code pane in that pane, a chat's or a task's in its own
 * place, any other in a new pane. One that can't doesn't hold the others back. How many went.
 */
async function continueCutOff(asked: readonly CutOffRun[]): Promise<{ continued: number; failed: unknown }> {
  // Only those still offered (one may have been continued since the notice came up). Of two of one
  // CLI in one folder whose sessions aren't known exactly, one: both would open the folder's latest.
  const current = await cutOffNote();
  const seen = new Set<string>();
  const runs = asked.filter((run) => {
    if (!current?.runs.some((item) => item.runId === run.runId)) return false;
    if (run.exact) return true;
    const key = `${run.engine}\u0000${run.workspaceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const panes = runs.filter(inPane);
  continueInPanes(panes.map((run) => run.runId));
  let failed: unknown = null;
  let continued = panes.length;
  for (const run of runs.filter((item) => !inPane(item))) {
    try {
      const next = await call("runs.continue", run.runId);
      if (!next.chatId && !next.taskId) placeInCode(next.ptyId);
      settleCutOff([run.runId]);
      continued += 1;
    } catch (error) {
      failed ??= error;
    }
  }
  return { continued, failed };
}

// What the main process tells the person once (DeskNotice): the window came back after its page
// stopped, terminals were cut off by the terminal host stopping, the host stopped or started
// answering again, and errors nothing handled. Notices said while no page was there (the page that
// crashed, say) are taken when this one loads.

export function MainNotices() {
  const { push, dismiss, fail } = useToast();
  const { go } = useNav();
  const copyDiagnostics = useCopyDiagnostics();
  // The newest, for the listeners set up once below.
  const copy = useRef(copyDiagnostics);
  copy.current = copyDiagnostics;
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    // The "isn't answering" toast on screen, cleared when the host answers again.
    let stalled: number | null = null;
    // The proposed-memory toast on screen: only the newest, so a burst can't crowd out the others.
    let proposed: number | null = null;
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
      } else if (notice.id === "memory-proposed") {
        // A nudge, not a question: the proposal waits on the agent's Memory tab either way, counted
        // on the agent. Review is not an undo, so Ctrl+Z leaves it alone.
        if (proposed !== null) dismiss(proposed);
        const note = notice.note.length > 140 ? `${notice.note.slice(0, 139).trimEnd()}…` : notice.note;
        proposed = push(
          "info",
          t("agents.proposedToast", { name: notice.agentName, note }),
          notice.flagged ? t("agents.proposedFlaggedToast") : t.count("agents.proposedWaiting", notice.waiting),
          {
            label: t("agents.review"),
            notUndo: true,
            run: () => goRef.current({ view: "agents", agentId: notice.agentId, tab: "memory" }),
          },
        );
      }
    };
    const off = on("notice", show);
    void call("app.notices")
      .then((missed) => missed.forEach(show))
      .catch(() => undefined);
    return off;
  }, [push, dismiss, fail]);

  // CLIs the last close cut off: after an update the ones whose exact session is known reopen by
  // themselves; the rest (or all, after a quit or crash) are offered with Continue all.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(CUT_OFF_SAID)) return;
    } catch {
      /* no storage: said each load */
    }
    void cutOffNote().then(async (note) => {
      if (!note?.runs.length) return;
      try {
        sessionStorage.setItem(CUT_OFF_SAID, "1");
      } catch {
        /* said again after a reload, then */
      }
      const auto = note.reason === "update" ? note.runs.filter((run) => run.exact) : [];
      const offered = note.runs.filter((run) => !auto.includes(run));
      if (auto.length) {
        const { continued, failed } = await continueCutOff(auto);
        if (continued) push("success", t.count("app.notice.reopened", continued), t("app.notice.reopenedBody"));
        if (failed) fail(failed, t("app.notice.continueFailed"));
      }
      if (!offered.length) return;
      push(
        "info",
        t.count(note.reason === "crash" ? "app.notice.cutOffCrash" : note.reason === "update" ? "app.notice.cutOffUpdate" : "app.notice.cutOffQuit", offered.length),
        offered.every((run) => run.exact) ? t("app.notice.cutOffBody") : t("app.notice.cutOffBodyLatest"),
        {
          label: t("app.notice.continueAll"),
          notUndo: true,
          run: () =>
            void continueCutOff(offered).then(({ continued, failed }) => {
              if (continued) push("success", t.count("app.notice.continued", continued));
              if (failed) fail(failed, t("app.notice.continueFailed"));
            }),
        },
        { stay: true },
      );
    });
  }, [push, fail]);

  return null;
}
