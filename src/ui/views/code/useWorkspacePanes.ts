import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine, LayoutNode, LiveSession, PaneLaunch, Workspace } from "../../../shared/api.js";
import { call } from "../../api.js";
import { estimateTermSize, type TerminalHandle } from "../../components/Terminal.js";
import { useT } from "../../i18n/index.js";
import { movePane, panesOf, placeSession, removePane, replacePane, setRatioAt, unzoomForFocus, type DropZone, type PaneNode } from "../../pane-layout.js";
import { useConfirm, useNav, useToast, type Route } from "../../state.js";

// Code's panes: each workspace's pane tree, what runs in each pane, which one has focus, and the
// ways they change. The tree changes themselves are pure functions in pane-layout.ts.

export interface Runtime {
  ptyId: string | null;
  runId: string | null;
  state: "idle" | "starting" | "live" | "exited";
  exitText: string | null;
}

export const newPaneId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A coding CLI: a run VibeForge started, or one typed into a shell (src/core/checkout.ts says the same). */
export function isCodingCli(session: LiveSession): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

/**
 * State whose latest value is in its ref the moment it is set, not a render later. Code that
 * places several panes in a row (two CLIs a plan starts together) reads each one's result.
 */
function useSyncedState<T extends object>(initial: T): [T, { readonly current: T }, (update: (prev: T) => T) => void] {
  const [state, setState] = useState(initial);
  const ref = useRef(state);
  const set = useCallback((update: (prev: T) => T) => {
    ref.current = update(ref.current);
    setState(ref.current);
  }, []);
  return [state, ref, set];
}

export type WorkspacePanes = ReturnType<typeof useWorkspacePanes>;

export function useWorkspacePanes({
  opened,
  current,
  route,
  workspaces,
  live,
  engines,
  defaultEngine,
  fontSize,
}: {
  /** Code has been on screen once: nothing starts before that. */
  opened: boolean;
  current: Workspace | null;
  route: Extract<Route, { view: "code" }> | null;
  workspaces: Workspace[];
  live: LiveSession[];
  engines: Engine[];
  defaultEngine: string | undefined;
  fontSize: number;
}) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const confirm = useConfirm();
  // Per workspace: its pane tree, null once every pane has been closed, missing until loaded.
  const [layouts, layoutsRef, setLayouts] = useSyncedState<Record<string, LayoutNode | null>>({});
  const [runtime, runtimeRef, setRuntime] = useSyncedState<Record<string, Runtime>>({});
  const [focus, focusRef, setFocus] = useSyncedState<Record<string, string>>({});
  const [zoomed, setZoomed] = useState<Record<string, string | null>>({});
  // A maximized pane hides the others, so focus moving to another pane (a new one split off, one
  // a route or Maestro jumps to, one dragged) restores the layout instead of focusing a hidden pane.
  useEffect(() => setZoomed((prev) => unzoomForFocus(prev, focus)), [focus]);
  const terminals = useRef(new Map<string, TerminalHandle>());
  const starting = useRef(new Set<string>());
  const fontSizeRef = useRef(13);
  fontSizeRef.current = fontSize;

  const patchRuntime = useCallback(
    (paneId: string, patch: Partial<Runtime>) => {
      setRuntime((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? { ptyId: null, runId: null, state: "idle", exitText: null }), ...patch } }));
    },
    [setRuntime],
  );

  const updateLayout = useCallback(
    (workspaceId: string, next: LayoutNode | null) => {
      setLayouts((prev) => ({ ...prev, [workspaceId]: next }));
      void call("layouts.save", workspaceId, next).catch(() => undefined);
    },
    [setLayouts],
  );

  /** Start a pane's terminal; its id, or null when it didn't start (the toast says why). */
  const startPane = useCallback(
    async (workspace: Workspace, pane: PaneNode, opts: { continueSession?: boolean } = {}): Promise<string | null> => {
      if (starting.current.has(pane.id)) return null;
      starting.current.add(pane.id);
      patchRuntime(pane.id, { state: "starting", ptyId: null, runId: null, exitText: null });
      // Measure after React has laid the new pane out. A window on a hidden workspace gets no
      // frames, so don't wait on one forever.
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
        setTimeout(resolve, 100);
      });
      const size = estimateTermSize(document.querySelector<HTMLElement>(`[data-pane="${pane.id}"]`), fontSizeRef.current, 34);
      // The pane can be closed while its terminal is still starting.
      const stillThere = () => {
        const layout = layoutsRef.current[workspace.id];
        return Boolean(layout && panesOf(layout).some((item) => item.id === pane.id));
      };
      try {
        const started =
          pane.launch.type === "shell"
            ? { ...(await call("code.shell", { workspaceId: workspace.id, ...size })), runId: null }
            : await call("code.engine", {
                workspaceId: workspace.id,
                engineId: pane.launch.engineId,
                continueSession: opts.continueSession,
                ...size,
              });
        if (!stillThere()) {
          // Closed while it started: what started goes too, instead of running on with no pane.
          void call("pty.kill", started.ptyId).catch(() => undefined);
          return null;
        }
        patchRuntime(pane.id, { ptyId: started.ptyId, runId: started.runId, state: "live" });
        setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
        return started.ptyId;
      } catch (error) {
        if (!stillThere()) return null;
        patchRuntime(pane.id, { state: "idle" });
        fail(error, t("code.startFailed"));
        return null;
      } finally {
        starting.current.delete(pane.id);
      }
    },
    [fail, patchRuntime, setFocus, layoutsRef],
  );

  // Load the current workspace's layout. Nothing saved stays empty, so New terminal
  // is the way in. A layout left open from last time brings its shells back.
  useEffect(() => {
    if (!opened || !current || current.id in layoutsRef.current) return;
    let cancelled = false;
    void call("layouts.get", current.id)
      .catch(() => null)
      .then((saved) => {
        if (cancelled || current.id in layoutsRef.current) return;
        setLayouts((prev) => ({ ...prev, [current.id]: saved }));
        if (!saved) return;
        const panes = panesOf(saved);
        const first = panes[0];
        if (first) setFocus((prev) => ({ ...prev, [current.id]: prev[current.id] ?? first.id }));
        for (const pane of panes) if (pane.launch.type === "shell") void startPane(current, pane);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, current, startPane, setLayouts, setFocus]);

  // Jumping here for a specific session: focus its pane, or give it one. The switch to the
  // route's workspace lands a render later, so until then `current` is the one being left.
  useEffect(() => {
    if (!route?.ptyId || !current) return;
    if (route.workspaceId && route.workspaceId !== current.id) return;
    const layout = layouts[current.id];
    if (layout === undefined) return;
    const owner = (layout ? panesOf(layout) : []).find((pane) => runtime[pane.id]?.ptyId === route.ptyId);
    if (owner) {
      setFocus((prev) => ({ ...prev, [current.id]: owner.id }));
      terminals.current.get(owner.id)?.focus();
      return;
    }
    const session = live.find((item) => item.ptyId === route.ptyId);
    if (!session) return;
    adopt(current, session.ptyId, session.runId, session.kind === "shell" ? { type: "shell" } : { type: "engine", engineId: engineOfTitle(session.title) });
    go({ view: "code", workspaceId: current.id });
    // Adoption runs once per requested session.
  }, [route?.ptyId, route?.workspaceId, current?.id, layouts[current?.id ?? ""]]);

  function engineOfTitle(title: string): string {
    return engines.find((engine) => title.startsWith(engine.label))?.id ?? defaultEngine ?? "";
  }

  /** Give a session that is already running a pane: a new one beside the focused pane. */
  function adopt(workspace: Workspace, ptyId: string, runId: string | null, launch: PaneLaunch) {
    show(workspace, ptyId, runId, placeSession(layoutsRef.current[workspace.id], launch, { newId: newPaneId(), focus: focusRef.current[workspace.id] }));
  }

  function show(workspace: Workspace, ptyId: string, runId: string | null, spot: { layout: LayoutNode; paneId: string }) {
    if (spot.layout !== layoutsRef.current[workspace.id]) updateLayout(workspace.id, spot.layout);
    patchRuntime(spot.paneId, { ptyId, runId, state: "live", exitText: null });
    setFocus((prev) => ({ ...prev, [workspace.id]: spot.paneId }));
  }

  // A CLI the Orchestrator started gets a pane in its workspace (the new branch's), whether or
  // not Code is on screen, so it is there when the person goes to look. Each one once.
  const placed = useRef(new Set<string>());
  useEffect(() => {
    for (const session of live) {
      if (!session.orchestrated || !session.workspaceId || placed.current.has(session.ptyId)) continue;
      const workspace = workspaces.find((item) => item.id === session.workspaceId);
      if (!workspace) continue;
      placed.current.add(session.ptyId);
      if (Object.values(runtimeRef.current).some((state) => state.ptyId === session.ptyId)) continue;
      const launch: PaneLaunch = { type: "engine", engineId: engineOfTitle(session.title) };
      if (workspace.id in layoutsRef.current) {
        place(workspace, session, launch);
        continue;
      }
      // Not loaded yet: load its saved panes first (and start their shells, as opening it would).
      void call("layouts.get", workspace.id)
        .catch(() => null)
        .then((saved) => {
          if (!(workspace.id in layoutsRef.current)) {
            setLayouts((prev) => ({ ...prev, [workspace.id]: saved }));
            for (const pane of saved ? panesOf(saved) : []) if (pane.launch.type === "shell") void startPane(workspace, pane);
          }
          place(workspace, session, launch);
        });
    }
    // Only new sessions matter; the rest is read through refs.
  }, [live, workspaces]);

  /** Into a pane of the same CLI that has nothing running (left from last time), or a new one beside. */
  function place(workspace: Workspace, session: LiveSession, launch: PaneLaunch) {
    const idle = (paneId: string) => {
      const state = runtimeRef.current[paneId]?.state ?? "idle";
      return state === "idle" || state === "exited";
    };
    show(workspace, session.ptyId, session.runId, placeSession(layoutsRef.current[workspace.id], launch, { newId: newPaneId(), focus: focusRef.current[workspace.id], idle }));
  }

  /** The first pane of a workspace whose panes were all closed. */
  function openFirst(workspace: Workspace, launch: PaneLaunch) {
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch };
    updateLayout(workspace.id, pane);
    setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
    void startPane(workspace, pane);
  }

  function splitPane(workspace: Workspace, paneId: string, dir: "row" | "col", launch: PaneLaunch) {
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    const existing = panesOf(layout).find((pane) => pane.id === paneId);
    if (!existing) return;
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch };
    updateLayout(workspace.id, replacePane(layout, paneId, { kind: "split", dir, ratio: 0.5, a: existing, b: pane }));
    setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
    void startPane(workspace, pane);
  }

  async function closePane(workspace: Workspace, pane: PaneNode) {
    const state = runtime[pane.id];
    if (state?.state === "live" && state.ptyId) {
      const ok = await confirm({
        title: t("code.close.title"),
        body: state.runId || live.find((session) => session.ptyId === state.ptyId)?.runId ? t("code.close.bodyRun") : t("code.close.bodyShell"),
        confirm: t("code.close.confirm"),
      });
      if (!ok) return;
      void call("pty.kill", state.ptyId).catch(() => undefined);
    }
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    // Closing the last pane leaves the workspace empty; it does not start a new shell in its place.
    const next = removePane(layout, pane.id);
    updateLayout(workspace.id, next);
    setRuntime((prev) => {
      const copy = { ...prev };
      delete copy[pane.id];
      return copy;
    });
    terminals.current.delete(pane.id);
    const remaining = next ? panesOf(next) : [];
    setFocus((prev) => {
      const copy = { ...prev };
      if (remaining.length) copy[workspace.id] = remaining[remaining.length - 1].id;
      else delete copy[workspace.id];
      return copy;
    });
    setZoomed((prev) => (prev[workspace.id] === pane.id ? { ...prev, [workspace.id]: null } : prev));
  }

  function launchHere(workspace: Workspace, pane: PaneNode, launch: PaneLaunch, opts: { continueSession?: boolean } = {}) {
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    const next: PaneNode = { ...pane, launch };
    updateLayout(workspace.id, replacePane(layout, pane.id, next));
    void startPane(workspace, next, opts);
  }

  /** A new shell beside the focused pane, or the first one in an empty workspace. */
  function newTerminal(workspace: Workspace, dir: "row" | "col") {
    const layout = layoutsRef.current[workspace.id];
    if (layout === null) openFirst(workspace, { type: "shell" });
    else if (layout) splitPane(workspace, focusRef.current[workspace.id] ?? panesOf(layout)[0].id, dir, { type: "shell" });
  }

  /** Review with a new CLI here: `engineId` in a new pane beside `paneId`; its terminal once it runs. */
  function startReviewer(workspace: Workspace, paneId: string, engineId: string): Promise<string | null> {
    const layout = layoutsRef.current[workspace.id];
    const existing = layout ? panesOf(layout).find((pane) => pane.id === paneId) : undefined;
    if (!layout || !existing) return Promise.resolve(null);
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch: { type: "engine", engineId } };
    updateLayout(workspace.id, replacePane(layout, paneId, { kind: "split", dir: "row", ratio: 0.5, a: existing, b: pane }));
    return startPane(workspace, pane);
  }

  /** Maximize a pane, or restore it when it is the maximized one. */
  function toggleZoom(workspaceId: string, paneId: string) {
    setZoomed((prev) => ({ ...prev, [workspaceId]: prev[workspaceId] === paneId ? null : paneId }));
  }

  function focusPane(workspaceId: string, paneId: string) {
    setFocus((prev) => (prev[workspaceId] === paneId ? prev : { ...prev, [workspaceId]: paneId }));
  }

  /** A divider moved. Saved once it is let go (or reset), not on every step of the drag. */
  function setRatio(workspaceId: string, path: string, ratio: number, done: boolean) {
    const node = layoutsRef.current[workspaceId];
    if (!node) return;
    const next = setRatioAt(node, path, ratio);
    if (done) updateLayout(workspaceId, next);
    else setLayouts((prev) => ({ ...prev, [workspaceId]: next }));
  }

  /** A pane dropped on another: swapped, or docked on the side it landed on. */
  function dropPane(workspaceId: string, sourceId: string, targetId: string, zone: DropZone) {
    const latest = layoutsRef.current[workspaceId];
    if (latest) updateLayout(workspaceId, movePane(latest, sourceId, targetId, zone));
    setFocus((prev) => ({ ...prev, [workspaceId]: sourceId }));
  }

  /** A removed workspace's panes. */
  function forget(workspaceId: string) {
    setLayouts((prev) => {
      const copy = { ...prev };
      delete copy[workspaceId];
      return copy;
    });
  }

  /** A workspace's focused pane, as of now rather than the last render: its id, and the pane while it is still there. */
  function focusedPane(workspaceId: string): { paneId: string | undefined; pane: PaneNode | undefined } {
    const layout = layoutsRef.current[workspaceId];
    const paneId = focusRef.current[workspaceId];
    return { paneId, pane: layout && paneId ? panesOf(layout).find((item) => item.id === paneId) : undefined };
  }

  function livePty(paneId: string): string | null {
    const state = runtimeRef.current[paneId];
    return state?.state === "live" ? state.ptyId : null;
  }

  return {
    layouts,
    runtime,
    focus,
    zoomed,
    terminals,
    setFocus,
    patchRuntime,
    engineOfTitle,
    openFirst,
    newTerminal,
    closePane,
    launchHere,
    startReviewer,
    toggleZoom,
    focusPane,
    setRatio,
    dropPane,
    forget,
    focusedPane,
    livePty,
  };
}
