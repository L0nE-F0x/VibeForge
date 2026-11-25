import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine, LayoutNode, LiveSession, PaneLaunch, Workspace } from "../../../shared/api.js";
import { call } from "../../api.js";
import { estimateTermSize, type TerminalHandle } from "../../components/Terminal.js";
import { useT } from "../../i18n/index.js";
import { movePane, panesOf, placeSession, reattachPanes, removePane, replacePane, setRatioAt, unzoomForFocus, type DropZone, type PaneNode, type PaneTerminal } from "../../pane-layout.js";
import { useConfirm, useNav, useToast, type Route } from "../../state.js";

// Code's panes: each workspace's pane tree, what runs in each pane, which one has focus, and the
// ways they change. The tree changes themselves are pure functions in pane-layout.ts.

export interface Runtime {
  ptyId: string | null;
  runId: string | null;
  state: "idle" | "starting" | "live" | "exited";
  exitText: string | null;
}

/** Where each pane's terminal is remembered for this window: sessionStorage outlives a reload of the page, not a restart. */
const PANE_TERMINALS = "vibeforge:pane-terminals";

function rememberedTerminals(): Record<string, PaneTerminal> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(PANE_TERMINALS) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, PaneTerminal>) : {};
  } catch {
    return {};
  }
}

/** Terminals started outside Code that should still get a pane there, as Maestro's do: runs continued after the terminal host stopped. */
const toPlace = new Set<string>();

/** Give this terminal a pane in its workspace once it is live: the idle pane of the same CLI, else a new one. */
export function placeInCode(ptyId: string): void {
  toPlace.add(ptyId);
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
  const { replace } = useNav();
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
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  /** Workspaces whose saved layout is being read, so two paths never load or populate one twice. */
  const loadingLayouts = useRef(new Map<string, Promise<LayoutNode | null>>());
  /** Workspaces loaded in the background before Code opened, whose saved shells still wait to start. */
  const unstartedShells = useRef(new Set<string>());

  // What the page before this one left, read before the effect below writes this page's (empty) list.
  const remembered = useRef<Record<string, PaneTerminal> | null>(null);
  if (remembered.current === null) remembered.current = rememberedTerminals();
  // A CLI the Orchestrator started gets a pane once; a terminal put back after a reload counts as placed.
  const placed = useRef(new Set<string>());
  // Each live pane's terminal, so a page that crashed and was reloaded puts them back (reattachPanes).
  useEffect(() => {
    const live: Record<string, PaneTerminal> = {};
    for (const [paneId, state] of Object.entries(runtime)) if (state.state === "live" && state.ptyId) live[paneId] = { ptyId: state.ptyId, runId: state.runId };
    try {
      sessionStorage.setItem(PANE_TERMINALS, JSON.stringify(live));
    } catch {
      /* no storage: a reload starts the panes' shells afresh, as a restart does */
    }
  }, [runtime]);

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

  const loadWorkspaceLayout = useCallback(
    (workspace: Workspace): Promise<LayoutNode | null> => {
      if (workspace.id in layoutsRef.current) return Promise.resolve(layoutsRef.current[workspace.id] ?? null);
      const inflight = loadingLayouts.current.get(workspace.id);
      if (inflight) return inflight;
      const left = remembered.current ?? {};
      // Only a page that was reloaded remembers terminals; it asks which of them still run.
      const running = Object.keys(left).length ? call("live.list").then((live) => new Set(live.map((item) => item.ptyId))) : Promise.resolve(new Set<string>());
      const promise = Promise.all([call("layouts.get", workspace.id).catch(() => null), running.catch(() => new Set<string>())])
        .then(([saved, stillRunning]) => {
          loadingLayouts.current.delete(workspace.id);
          if (!workspacesRef.current.some((item) => item.id === workspace.id)) return null;
          if (!(workspace.id in layoutsRef.current)) {
            setLayouts((prev) => ({ ...prev, [workspace.id]: saved }));
            const panes = saved ? panesOf(saved) : [];
            const first = panes[0];
            if (first) setFocus((prev) => ({ ...prev, [workspace.id]: prev[workspace.id] ?? first.id }));
            // Terminals that went on running while the page was away go back in their panes.
            const back = reattachPanes(panes, left, stillRunning);
            for (const [paneId, terminal] of back) {
              placed.current.add(terminal.ptyId);
              patchRuntime(paneId, { ...terminal, state: "live", exitText: null });
            }
            const fresh = panes.filter((pane) => pane.launch.type === "shell" && !back.has(pane.id));
            if (openedRef.current) {
              for (const pane of fresh) void startPane(workspace, pane);
            } else if (fresh.length) {
              unstartedShells.current.add(workspace.id);
            }
          }
          return layoutsRef.current[workspace.id] ?? null;
        });
      loadingLayouts.current.set(workspace.id, promise);
      return promise;
    },
    [layoutsRef, setLayouts, setFocus, startPane, patchRuntime],
  );

  // Load the current workspace's layout. Nothing saved stays empty, so New terminal
  // is the way in. A layout left open from last time brings its shells back.
  useEffect(() => {
    if (!opened || !current) return;
    if (!(current.id in layoutsRef.current)) {
      void loadWorkspaceLayout(current);
      return;
    }
    if (unstartedShells.current.delete(current.id)) {
      const saved = layoutsRef.current[current.id];
      for (const pane of saved ? panesOf(saved) : []) {
        if (pane.launch.type === "shell" && (runtimeRef.current[pane.id]?.state ?? "idle") === "idle") void startPane(current, pane);
      }
    }
  }, [opened, current, loadWorkspaceLayout, layoutsRef, runtimeRef, startPane]);

  function engineOfTitle(title: string): string {
    return engines.find((engine) => title.startsWith(engine.label))?.id ?? defaultEngine ?? "";
  }

  // A CLI the Orchestrator started gets a pane in its workspace (the new branch's), whether or
  // not Code is on screen, so it is there when the person goes to look. Each one once (`placed`).

  /**
   * Give `ptyId` a pane in `workspace`, or reuse the one that already holds it: an idle pane of
   * the same CLI when there is one, else a new pane beside the focused pane.
   */
  function showSession(workspace: Workspace, ptyId: string, runId: string | null, launch: PaneLaunch, opts: { focus?: boolean } = {}): string {
    placed.current.add(ptyId);
    const owns = (paneId: string) => runtimeRef.current[paneId]?.ptyId === ptyId;
    const idle = (paneId: string) => {
      const state = runtimeRef.current[paneId]?.state ?? "idle";
      return state === "idle" || state === "exited";
    };
    const spot = placeSession(layoutsRef.current[workspace.id], launch, {
      newId: newPaneId(),
      focus: focusRef.current[workspace.id],
      owns,
      idle,
    });
    if (spot.layout !== layoutsRef.current[workspace.id]) updateLayout(workspace.id, spot.layout);
    if (runtimeRef.current[spot.paneId]?.ptyId !== ptyId || runtimeRef.current[spot.paneId]?.state !== "live") {
      patchRuntime(spot.paneId, { ptyId, runId, state: "live", exitText: null });
    }
    // A pane placed on its own (a CLI Maestro started) doesn't take focus from the one being typed
    // in; it is focused only in a workspace that has no focused pane yet.
    const focus = opts.focus ?? true;
    setFocus((prev) => (focus || !prev[workspace.id] ? { ...prev, [workspace.id]: spot.paneId } : prev));
    return spot.paneId;
  }

  // Jumping here for a specific session: focus its pane, or give it one. The switch to the
  // route's workspace lands a render later, so until then `current` is the one being left.
  useEffect(() => {
    if (!route?.ptyId || !current) return;
    if (route.workspaceId && route.workspaceId !== current.id) return;
    const layout = layoutsRef.current[current.id];
    if (layout === undefined) return;
    const owner = (layout ? panesOf(layout) : []).find((pane) => runtimeRef.current[pane.id]?.ptyId === route.ptyId);
    if (owner) {
      setFocus((prev) => ({ ...prev, [current.id]: owner.id }));
      const handle = terminals.current.get(owner.id);
      if (handle) handle.focus();
      else setTimeout(() => terminals.current.get(owner.id)?.focus(), 0);
      replace({ view: "code", workspaceId: current.id });
      return;
    }
    const session = live.find((item) => item.ptyId === route.ptyId);
    if (!session) return;
    if (!route.workspaceId && session.workspaceId && session.workspaceId !== current.id && workspaces.some((item) => item.id === session.workspaceId)) {
      replace({ view: "code", workspaceId: session.workspaceId, ptyId: route.ptyId });
      return;
    }
    if (Object.values(runtimeRef.current).some((state) => state.ptyId === session.ptyId)) {
      replace({ view: "code", workspaceId: current.id });
      return;
    }
    const paneId = showSession(
      current,
      session.ptyId,
      session.runId,
      session.kind === "shell" ? { type: "shell" } : { type: "engine", engineId: session.programEngineId || engineOfTitle(session.title) },
      { focus: true },
    );
    setTimeout(() => terminals.current.get(paneId)?.focus(), 0);
    replace({ view: "code", workspaceId: current.id });
    // Adoption runs once per requested session.
  }, [route?.ptyId, route?.workspaceId, current?.id, layouts[current?.id ?? ""], live, workspaces, replace]);

  useEffect(() => {
    for (const session of live) {
      if (!(session.orchestrated || toPlace.has(session.ptyId)) || !session.workspaceId || placed.current.has(session.ptyId)) continue;
      toPlace.delete(session.ptyId);
      const workspace = workspaces.find((item) => item.id === session.workspaceId);
      if (!workspace) continue;
      placed.current.add(session.ptyId);
      if (Object.values(runtimeRef.current).some((state) => state.ptyId === session.ptyId)) continue;
      const launch: PaneLaunch = session.kind === "shell" ? { type: "shell" } : { type: "engine", engineId: session.programEngineId || engineOfTitle(session.title) };
      if (workspace.id in layoutsRef.current) {
        showSession(workspace, session.ptyId, session.runId, launch, { focus: false });
        continue;
      }
      // Not loaded yet: load its saved panes first (and start their shells, as opening it would).
      void loadWorkspaceLayout(workspace).then(() => {
        if (!workspacesRef.current.some((item) => item.id === workspace.id)) return;
        if (Object.values(runtimeRef.current).some((state) => state.ptyId === session.ptyId)) return;
        showSession(workspace, session.ptyId, session.runId, launch, { focus: false });
      });
    }
    // Only new sessions matter; the rest is read through refs.
  }, [live, workspaces, loadWorkspaceLayout]);

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
    const shared = Boolean(state?.ptyId && Object.entries(runtimeRef.current).some(([id, other]) => id !== pane.id && other.ptyId === state.ptyId && other.state === "live"));
    if (state?.state === "live" && state.ptyId && !shared) {
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
    loadingLayouts.current.delete(workspaceId);
    unstartedShells.current.delete(workspaceId);
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
