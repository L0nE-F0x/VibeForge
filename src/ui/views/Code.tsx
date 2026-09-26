import {
  Columns2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Globe,
  GripVertical,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  RotateCcw,
  Rows2,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, LayoutNode, PaneLaunch, Workspace } from "../../shared/api.js";
import { shellQuote, tildify } from "../../shared/text.js";
import { call, useAppInfo, useEngines, useLive, useSettings, useWorkspaces } from "../api.js";
import { estimateTermSize, LiveTerminal, type TerminalHandle } from "../components/Terminal.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { workspaceMark, WorkspaceState } from "../components/WorkspaceState.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Empty, Input, Menu, MenuButton, Popover, type MenuItem } from "../components/ui.js";
import { useT } from "../i18n/index.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { movePane, panesOf, removePane, replacePane, setRatioAt, type DropZone, type PaneNode } from "../pane-layout.js";
import { DockPanel, FilesPanel, SplitView } from "./CodeParts.js";
import { setDictationTarget, type DictationTarget } from "../voice.js";
import { trackLive, useAttention } from "../attention.js";

interface Runtime {
  ptyId: string | null;
  runId: string | null;
  state: "idle" | "starting" | "live" | "exited";
  exitText: string | null;
}

const newPaneId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shellPane = (): PaneNode => ({ kind: "pane", id: newPaneId(), launch: { type: "shell" } });

const PANE_MIME = "application/x-vibeforge-pane";
const WORKSPACE_MIME = "application/x-vibeforge-workspace";

function zoneFor(event: React.DragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const edges: Array<[DropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [zone, distance] = edges.sort((a, b) => a[1] - b[1])[0];
  return distance < 0.28 ? zone : "center";
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return focused;
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable */
  }
}

export function CodeView({ active, route }: { active: boolean; route: Extract<Route, { view: "code" }> | null }) {
  const t = useT();
  const { go } = useNav();
  const { push, fail } = useToast();
  const confirm = useConfirm();
  const file = useWorkspaces();
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const live = useLive().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const workspaces = useMemo(() => file.data?.workspaces ?? [], [file.data]);

  const [currentId, setCurrentId] = useState<string | null>(null);
  // Per workspace: its pane tree, null once every pane has been closed, missing until loaded.
  const [layouts, setLayouts] = useState<Record<string, LayoutNode | null>>({});
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [side, setSide] = useState(() => readLocal<{ open: boolean; tab: "files" | "browser"; width: number }>("vf.code.side", { open: true, tab: "files", width: 320 }));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<Record<string, string | null>>({});
  const [dragPane, setDragPane] = useState<string | null>(null);
  const [dragWorkspace, setDragWorkspace] = useState<{ id: string; over: number | null } | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{ workspace: Workspace; anchor: HTMLElement } | null>(null);
  const terminals = useRef(new Map<string, TerminalHandle>());
  const starting = useRef(new Set<string>());
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const liveRef = useRef(live);
  liveRef.current = live;
  const fontSizeRef = useRef(13);
  fontSizeRef.current = settings?.terminalFontSize ?? 13;
  const attention = useAttention();
  const windowFocused = useWindowFocused();

  const current = workspaces.find((item) => item.id === currentId) ?? null;
  // The view stays mounted so terminals survive mode switches, but nothing starts until it is opened.
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  const engineLabel = (id: string) => engines.find((engine) => engine.id === id)?.label ?? id;

  // ---------------------------------------------------------------- choose the workspace

  useEffect(() => {
    if (route?.workspaceId && route.workspaceId !== currentId && workspaces.some((item) => item.id === route.workspaceId)) {
      setCurrentId(route.workspaceId);
      return;
    }
    if (currentId && workspaces.some((item) => item.id === currentId)) return;
    const next = file.data?.lastWorkspaceId ?? workspaces[0]?.id ?? null;
    if (next !== currentId) setCurrentId(next);
  }, [route?.workspaceId, workspaces, file.data, currentId]);

  useEffect(() => writeLocal("vf.code.side", side), [side]);

  // A CLI that goes quiet or finishes out of sight flags its workspace; looking at it clears that.
  const onScreen = active && windowFocused ? (current?.id ?? null) : null;
  useEffect(() => {
    for (const note of trackLive(live, onScreen)) {
      if (windowFocused) continue;
      const name = workspaces.find((workspace) => workspace.id === note.workspaceId)?.name ?? "";
      void call("app.notify", {
        title: t(note.attention === "waiting" ? "notify.waiting" : "notify.done", { label: note.label }),
        body: name,
        workspaceId: note.workspaceId,
      }).catch(() => undefined);
    }
  }, [live, onScreen]);

  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => shortcuts.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // ---------------------------------------------------------------- panes

  const patchRuntime = useCallback((paneId: string, patch: Partial<Runtime>) => {
    setRuntime((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? { ptyId: null, runId: null, state: "idle", exitText: null }), ...patch } }));
  }, []);

  const updateLayout = useCallback((workspaceId: string, next: LayoutNode | null) => {
    setLayouts((prev) => ({ ...prev, [workspaceId]: next }));
    void call("layouts.save", workspaceId, next).catch(() => undefined);
  }, []);

  const startPane = useCallback(
    async (workspace: Workspace, pane: PaneNode, opts: { continueSession?: boolean } = {}) => {
      if (starting.current.has(pane.id)) return;
      starting.current.add(pane.id);
      patchRuntime(pane.id, { state: "starting", ptyId: null, runId: null, exitText: null });
      // Measure after React has laid the new pane out. A window on a hidden workspace gets no
      // frames, so don't wait on one forever.
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
        setTimeout(resolve, 100);
      });
      const size = estimateTermSize(document.querySelector<HTMLElement>(`[data-pane="${pane.id}"]`), fontSizeRef.current, 34);
      try {
        if (pane.launch.type === "shell") {
          const { ptyId } = await call("code.shell", { workspaceId: workspace.id, ...size });
          patchRuntime(pane.id, { ptyId, runId: null, state: "live" });
        } else {
          const result = await call("code.engine", {
            workspaceId: workspace.id,
            engineId: pane.launch.engineId,
            continueSession: opts.continueSession,
            ...size,
          });
          patchRuntime(pane.id, { ptyId: result.ptyId, runId: result.runId, state: "live" });
        }
        setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
      } catch (error) {
        patchRuntime(pane.id, { state: "idle" });
        fail(error, t("code.startFailed"));
      } finally {
        starting.current.delete(pane.id);
      }
    },
    [fail, patchRuntime],
  );

  // Load (or create) the current workspace's layout, then bring its shells back.
  useEffect(() => {
    if (!opened || !current || current.id in layoutsRef.current) return;
    let cancelled = false;
    void call("layouts.get", current.id)
      .catch(() => null)
      .then((saved) => {
        if (cancelled || current.id in layoutsRef.current) return;
        const layout = saved ?? shellPane();
        setLayouts((prev) => ({ ...prev, [current.id]: layout }));
        const panes = panesOf(layout);
        setFocus((prev) => ({ ...prev, [current.id]: prev[current.id] ?? panes[0].id }));
        for (const pane of panes) if (pane.launch.type === "shell") void startPane(current, pane);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, current, startPane]);

  // Jumping here for a specific session: focus its pane, or give it one.
  useEffect(() => {
    if (!route?.ptyId || !current) return;
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
  }, [route?.ptyId, current?.id, layouts[current?.id ?? ""]]);

  function engineOfTitle(title: string): string {
    return engines.find((engine) => title.startsWith(engine.label))?.id ?? settings?.defaultEngine ?? "";
  }

  function adopt(workspace: Workspace, ptyId: string, runId: string | null, launch: PaneLaunch) {
    const layout = layoutsRef.current[workspace.id];
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch };
    if (!layout) updateLayout(workspace.id, pane);
    else {
      const target = focus[workspace.id] ?? panesOf(layout)[0].id;
      updateLayout(workspace.id, replacePane(layout, target, { kind: "split", dir: "row", ratio: 0.5, a: panesOf(layout).find((item) => item.id === target) ?? layout, b: pane }));
    }
    patchRuntime(pane.id, { ptyId, runId, state: "live" });
    setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
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

  shortcuts.current = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || !current) return;
    const key = event.key.toLowerCase();
    const layout = layoutsRef.current[current.id];
    const paneId = focusRef.current[current.id];
    const pane = layout && paneId ? panesOf(layout).find((item) => item.id === paneId) : undefined;
    if (key === "m" && paneId) setZoomed((prev) => ({ ...prev, [current.id]: prev[current.id] === paneId ? null : paneId }));
    else if (key === "d") newTerminal(current, "row");
    else if (key === "e") newTerminal(current, "col");
    else if (key === "w" && pane) void closePane(current, pane);
    else return;
    event.preventDefault();
  };

  // ---------------------------------------------------------------- dictation

  /** Names whisper should expect in a workspace: its own name and what sits at its top level. */
  const workspaceWords = async (workspace: Workspace) => [workspace.name, ...(await call("files.list", workspace.path)).slice(0, 60).map((node) => node.name)];

  /** A pane as a place for dictated words: pasted into its terminal, or into the launch bar while it has none. */
  function paneTarget(workspace: Workspace, pane: PaneNode): DictationTarget {
    const title = pane.launch.type === "shell" ? t("common.shell") : engineLabel(pane.launch.engineId);
    return {
      label: `${title} · ${workspace.name}`,
      element: () => document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane.id)}"]`),
      insert: (text) => terminals.current.get(pane.id)?.paste(text),
      submit: (text) => {
        const ptyId = livePty(pane.id);
        const handle = terminals.current.get(pane.id);
        if (!ptyId || !handle) return;
        void call("pty.send", ptyId, text).catch(() => undefined);
        handle.focus();
      },
      send: () => {
        const ptyId = livePty(pane.id);
        if (ptyId) void call("pty.write", ptyId, "\r").catch(() => undefined);
      },
      // Ctrl+U empties a shell's input line, and Claude Code's.
      clear: () => {
        const ptyId = livePty(pane.id);
        if (ptyId) void call("pty.write", ptyId, "\x15").catch(() => undefined);
      },
      // Esc interrupts a coding CLI, including one typed into a shell; a plain shell wants Ctrl+C.
      interrupt: () => {
        const ptyId = livePty(pane.id);
        if (!ptyId) return;
        const cli = pane.launch.type === "engine" || Boolean(liveRef.current.find((session) => session.ptyId === ptyId)?.programEngineId);
        void call("pty.write", ptyId, cli ? "\x1b" : "\x03").catch(() => undefined);
      },
      resume: () => {
        const latest = panesOf(layoutsRef.current[workspace.id] ?? pane).find((item) => item.id === pane.id) ?? pane;
        if (runtimeRef.current[pane.id]?.state === "exited" && latest.launch.type === "engine") launchHere(workspace, latest, latest.launch, { continueSession: true });
        else if (livePty(pane.id)) void call("pty.send", livePty(pane.id)!, "Continue.").catch(() => undefined);
      },
      ptyId: () => livePty(pane.id),
      words: () => workspaceWords(workspace),
    };
  }

  function livePty(paneId: string): string | null {
    const state = runtimeRef.current[paneId];
    return state?.state === "live" ? state.ptyId : null;
  }

  function insertPath(target: string) {
    if (!current) return;
    const paneId = focus[current.id];
    const handle = paneId ? terminals.current.get(paneId) : undefined;
    if (!handle) {
      push("info", t("code.focusFirst"), t("code.focusFirstBody"));
      return;
    }
    handle.paste(`${shellQuote(target)} `);
  }

  // ---------------------------------------------------------------- workspaces

  const [addWorkspace] = useAction(async () => {
    const folder = await call("app.pickFolder", t("code.empty.action"));
    if (!folder) return;
    const next = await call("workspaces.add", folder);
    if (next.lastWorkspaceId) {
      setCurrentId(next.lastWorkspaceId);
      void call("workspaces.select", next.lastWorkspaceId);
    }
  }, t("code.addFailed"));

  const [removeWorkspace] = useAction(async (workspace: Workspace) => {
    const running = live.filter((session) => session.workspaceId === workspace.id).length;
    const ok = await confirm({
      title: t("code.removeTitle", { name: workspace.name }),
      body: [t("code.removeBody"), running ? t.count("code.removeRunning", running) : ""].filter(Boolean).join(" "),
      confirm: t("code.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    await call("workspaces.remove", workspace.id);
    setLayouts((prev) => {
      const copy = { ...prev };
      delete copy[workspace.id];
      return copy;
    });
    if (currentId === workspace.id) setCurrentId(null);
  }, t("code.removeFailed"));

  const [renameWorkspace] = useAction(async (workspace: Workspace, name: string) => {
    if (name.trim() && name.trim() !== workspace.name) await call("workspaces.update", workspace.id, { name: name.trim() });
    setRenaming(null);
  }, t("code.renameFailed"));

  const [setDockUrl] = useAction(async (url: string) => {
    if (current) await call("workspaces.update", current.id, { dockUrl: url });
  }, t("code.urlFailed"));

  const [moveWorkspace] = useAction(async (id: string, toIndex: number) => {
    await call("workspaces.move", id, toIndex);
  }, t("code.moveFailed"));

  function select(workspace: Workspace) {
    setCurrentId(workspace.id);
    void call("workspaces.select", workspace.id).catch(() => undefined);
    if (route?.workspaceId && route.workspaceId !== workspace.id) go({ view: "code", workspaceId: workspace.id });
  }

  // ---------------------------------------------------------------- side panel resize

  const startSideResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side.width;
    const target = event.currentTarget as HTMLElement;
    target.classList.add("dragging");
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(900, Math.max(220, startWidth - (moveEvent.clientX - startX)));
      setSide((prev) => ({ ...prev, width }));
    };
    const up = () => {
      target.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------------------------------------------------------------- render

  const liveCount = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;
  const workspaceItems = (workspace: Workspace): Array<MenuItem | "sep"> => [
    { label: t("code.openFolder"), icon: FolderOpen, onSelect: () => void call("app.openPath", workspace.path) },
    { label: t("common.rename"), icon: Pencil, onSelect: () => setRenaming(workspace.id) },
    "sep",
    { label: t("code.removeWorkspace"), icon: Trash2, danger: true, onSelect: () => void removeWorkspace(workspace) },
  ];

  return (
    <div className="view" hidden={!active}>
      <div className="code-view">
        <SidePanel
          id="workspaces"
          title={t("code.workspaces")}
          defaultWidth={250}
          actions={
            <Button size="sm" icon={FolderPlus} onClick={() => void addWorkspace()} tip={t("code.addTip")}>
              {t("code.add")}
            </Button>
          }
          strip={
            <>
              <StripItem label={t("code.addStrip")} onClick={() => void addWorkspace()}>
                <FolderPlus size={16} />
              </StripItem>
              {workspaces.map((workspace) => (
                <StripItem
                  key={workspace.id}
                  label={`${workspace.name} — ${tildify(workspace.path, home)}`}
                  selected={workspace.id === currentId}
                  onClick={() => select(workspace)}
                  badge={<WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveCount(workspace.id)} strip />}
                >
                  <span className="strip-initials">{workspace.name.slice(0, 2).toUpperCase()}</span>
                </StripItem>
              ))}
            </>
          }
        >
          <div className="list-scroll">
            {workspaces.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("code.addEmpty")}</div>}
            {workspaces.map((workspace, index) => {
              const over = dragWorkspace && dragWorkspace.id !== workspace.id ? dragWorkspace.over : null;
              return (
                <div
                  key={workspace.id}
                  className={`row workspace-row${attention.get(workspace.id) === "waiting" ? " needs-you" : ""}${dragWorkspace?.id === workspace.id ? " is-dragging" : ""}${over === index ? " drop-before" : ""}${over === index + 1 ? " drop-after" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-selected={workspace.id === currentId}
                  draggable={renaming !== workspace.id}
                  onClick={() => select(workspace)}
                  onDoubleClick={() => setRenaming(workspace.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") select(workspace);
                    if (event.key === "F2") setRenaming(workspace.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setWorkspaceMenu({ workspace, anchor: event.currentTarget });
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(WORKSPACE_MIME, workspace.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragWorkspace({ id: workspace.id, over: null });
                  }}
                  onDragEnd={() => setDragWorkspace(null)}
                  onDragOver={(event) => {
                    if (!dragWorkspace || !event.dataTransfer.types.includes(WORKSPACE_MIME)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const at = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                    if (dragWorkspace.over !== at) setDragWorkspace({ ...dragWorkspace, over: at });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const drag = dragWorkspace;
                    setDragWorkspace(null);
                    if (!drag || drag.over === null) return;
                    const from = workspaces.findIndex((item) => item.id === drag.id);
                    const to = drag.over > from ? drag.over - 1 : drag.over;
                    if (from >= 0 && to !== from) void moveWorkspace(drag.id, to);
                  }}
                >
                  <FolderOpen size={15} className="accent-text" style={{ flex: "none" }} />
                  <span className="vstack grow" style={{ gap: 0 }}>
                    {renaming === workspace.id ? (
                      <Input
                        autoFocus
                        defaultValue={workspace.name}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onFocus={(event) => event.target.select()}
                        onBlur={(event) => void renameWorkspace(workspace, event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") void renameWorkspace(workspace, (event.target as HTMLInputElement).value);
                          if (event.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="row-title truncate">{workspace.name}</span>
                    )}
                    <span className="row-sub truncate mono">{tildify(workspace.path, home)}</span>
                  </span>
                  <WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveCount(workspace.id)} />
                  <span className="row-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    <MenuButton size="sm" variant="ghost" icon={MoreHorizontal} title={t("code.workspaceActions")} items={workspaceItems(workspace)} />
                  </span>
                </div>
              );
            })}
          </div>
          {workspaceMenu && (
            <Popover anchor={workspaceMenu.anchor} onClose={() => setWorkspaceMenu(null)} align="end">
              <Menu items={workspaceItems(workspaceMenu.workspace)} onClose={() => setWorkspaceMenu(null)} />
            </Popover>
          )}
        </SidePanel>

        {!current ? (
          <Empty
            icon={SquareTerminal}
            title={t("code.empty.title")}
            actions={
              <Button variant="primary" icon={FolderPlus} onClick={() => void addWorkspace()}>
                {t("code.empty.action")}
              </Button>
            }
          >
            {t("code.empty.body")}
          </Empty>
        ) : (
          <div className="code-main">
            <div className="code-toolbar">
              <div className="vstack grow" style={{ gap: 0 }}>
                <strong className="truncate" style={{ fontSize: "var(--fs-md)" }}>
                  {current.name}
                </strong>
                <button type="button" className="faint mono truncate" style={{ fontSize: "var(--fs-xs)", textAlign: "left" }} onClick={() => void call("app.openPath", current.path)} {...tipProps(t("common.openFileManager"))}>
                  {tildify(current.path, home)}
                </button>
              </div>
              <Button size="sm" variant="ghost" icon={Columns2} tip={t("code.splitRight")} kbd="Ctrl+Shift+D" onClick={() => newTerminal(current, "row")} />
              <Button size="sm" variant="ghost" icon={Rows2} tip={t("code.splitDown")} kbd="Ctrl+Shift+E" onClick={() => newTerminal(current, "col")} />
              <span className="toolbar-sep" />
              <Button size="sm" variant="ghost" icon={PanelRight} pressed={side.open} tip={t("code.sideTip")} onClick={() => setSide((prev) => ({ ...prev, open: !prev.open }))} />
            </div>

            <div className="code-work">
              {workspaces.map((workspace) => {
                const layout = layouts[workspace.id];
                const visible = workspace.id === current.id;
                if (layout === null && visible) {
                  return (
                    <div key={workspace.id} className="canvas">
                      <Empty
                        icon={SquareTerminal}
                        title={t("code.noPanes.title")}
                        actions={
                          <Button variant="primary" icon={TerminalSquare} kbd="Ctrl+Shift+D" onClick={() => openFirst(workspace, { type: "shell" })}>
                            {t("code.newTerminal")}
                          </Button>
                        }
                      >
                        {t("code.noPanes.body")}
                      </Empty>
                    </div>
                  );
                }
                if (!layout) return null;
                const paneCount = panesOf(layout).length;
                const zoomedPane = zoomed[workspace.id] && panesOf(layout).some((pane) => pane.id === zoomed[workspace.id]) ? zoomed[workspace.id] : null;
                return (
                  <div key={workspace.id} className={`canvas${zoomedPane ? " has-zoom" : ""}`} style={visible ? undefined : { display: "none" }}>
                    <SplitView
                      node={layout}
                      onRatio={(path, ratio) =>
                        setLayouts((prev) => {
                          const node = prev[workspace.id];
                          return node ? { ...prev, [workspace.id]: setRatioAt(node, path, ratio) } : prev;
                        })
                      }
                      renderPane={(pane) => {
                        const session = live.find((item) => item.ptyId === runtime[pane.id]?.ptyId);
                        // A launched CLI is its own run; a shell has one while a CLI typed into it is recorded.
                        const runId = runtime[pane.id]?.runId ?? session?.runId ?? null;
                        return (
                          <PaneView
                            key={pane.id}
                            pane={pane}
                            runtime={runtime[pane.id]}
                            runId={runId}
                            program={session?.program ?? null}
                            engines={engines}
                            active={active && visible}
                            focused={focus[workspace.id] === pane.id}
                            onFocus={() => {
                              setDictationTarget(paneTarget(workspace, pane));
                              setFocus((prev) => (prev[workspace.id] === pane.id ? prev : { ...prev, [workspace.id]: pane.id }));
                            }}
                            register={(handle) => {
                              if (handle) terminals.current.set(pane.id, handle);
                              else terminals.current.delete(pane.id);
                            }}
                            onExit={(text) => patchRuntime(pane.id, { state: "exited", exitText: text })}
                            onStart={(launch, continueSession) => launchHere(workspace, pane, launch, { continueSession })}
                            canZoom={paneCount > 1}
                            onClose={() => void closePane(workspace, pane)}
                            onReview={() => runId && go({ view: "runs", runId })}
                            canMove={paneCount > 1 && !zoomedPane}
                            dragging={dragPane}
                            onDragPane={setDragPane}
                            onDropPane={(sourceId, zone) => {
                              setDragPane(null);
                              const latest = layoutsRef.current[workspace.id];
                              if (latest) updateLayout(workspace.id, movePane(latest, sourceId, pane.id, zone));
                              setFocus((prev) => ({ ...prev, [workspace.id]: sourceId }));
                            }}
                            zoomed={zoomedPane === pane.id}
                            onZoom={() => setZoomed((prev) => ({ ...prev, [workspace.id]: prev[workspace.id] === pane.id ? null : pane.id }))}
                          />
                        );
                      }}
                    />
                  </div>
                );
              })}
              {side.open && (
                <aside className="side-panel" style={{ width: side.width }}>
                  <div className="side-resize" onPointerDown={startSideResize} />
                  <div className="side-tabs">
                    <Button size="sm" variant="ghost" icon={FolderTree} pressed={side.tab === "files"} onClick={() => setSide((prev) => ({ ...prev, tab: "files" }))}>
                      {t("code.files")}
                    </Button>
                    <Button size="sm" variant="ghost" icon={Globe} pressed={side.tab === "browser"} onClick={() => setSide((prev) => ({ ...prev, tab: "browser" }))}>
                      {t("code.browser")}
                    </Button>
                    <span className="grow" />
                    <Button size="sm" variant="ghost" icon={X} tip={t("code.hideSide")} onClick={() => setSide((prev) => ({ ...prev, open: false }))} />
                  </div>
                  {side.tab === "files" ? (
                    <FilesPanel root={current.path} onInsert={insertPath} />
                  ) : (
                    <DockPanel url={current.dockUrl} onUrl={(url) => void setDockUrl(url)} visible={active && side.open && side.tab === "browser"} />
                  )}
                </aside>
              )}
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

function PaneView({
  pane,
  runtime,
  runId,
  program,
  engines,
  active,
  focused,
  onFocus,
  register,
  onExit,
  onStart,
  canZoom,
  onClose,
  onReview,
  canMove,
  dragging,
  onDragPane,
  onDropPane,
  zoomed,
  onZoom,
}: {
  pane: PaneNode;
  runtime: Runtime | undefined;
  /** The run this pane is recording, if any. */
  runId: string | null;
  /** What a shell is running in its foreground, when it isn't at its prompt. */
  program: string | null;
  engines: Engine[];
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  register: (handle: TerminalHandle | null) => void;
  onExit: (text: string) => void;
  onStart: (launch: PaneLaunch, continueSession?: boolean) => void;
  canZoom: boolean;
  onClose: () => void;
  onReview: () => void;
  canMove: boolean;
  dragging: string | null;
  onDragPane: (paneId: string | null) => void;
  onDropPane: (sourceId: string, zone: DropZone) => void;
  zoomed: boolean;
  onZoom: () => void;
}) {
  const t = useT();
  const state = runtime?.state ?? "idle";
  const [zone, setZone] = useState<DropZone | null>(null);
  const engine = pane.launch.type === "engine" ? engines.find((item) => item.id === (pane.launch as { engineId: string }).engineId) : null;
  const title = pane.launch.type === "shell" ? t("common.shell") : (engine?.label ?? (pane.launch as { engineId: string }).engineId);
  // A shell running something shows that instead: `claude` typed at the prompt reads "Claude Code".
  const shown = state === "live" && program ? program : title;

  return (
    <div className={`pane${focused ? " focused" : ""}${zoomed ? " is-zoomed" : ""}${dragging === pane.id ? " is-dragging" : ""}`} data-pane={pane.id} onMouseDown={onFocus}>
      <div
        className={`pane-head${canMove ? " can-move" : ""}`}
        draggable={canMove}
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_MIME, pane.id);
          event.dataTransfer.effectAllowed = "move";
          onDragPane(pane.id);
        }}
        onDragEnd={() => onDragPane(null)}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button") || !(canZoom || zoomed)) return;
          onZoom();
        }}
      >
        {canMove && (
          <span className="pane-grip" {...tipProps(t("pane.drag"))}>
            <GripVertical size={13} />
          </span>
        )}
        {state === "live" ? (
          <span className="dot running" {...tipProps(t("pane.running"))} />
        ) : state === "exited" ? (
          <span className="dot stopped" {...tipProps(t("pane.exited"))} />
        ) : (
          <span className="dot" {...tipProps(t("pane.idle"))} />
        )}
        <span className="pane-title truncate">{shown}</span>
        {shown !== title && <span className="pane-sub truncate">{title}</span>}
        {runId && (
          <button type="button" className="pane-run-link" onClick={onReview} {...tipProps(t("pane.openRun"))}>
            {t("pane.run")}
          </button>
        )}
        {zoomed && <span className="chip accent">{t("pane.maximized")}</span>}
        <span className="grow" />
        <div className="pane-actions">
          {(canZoom || zoomed) && (
            <Button size="sm" variant="ghost" icon={zoomed ? Minimize2 : Maximize2} tip={zoomed ? t("pane.restore") : t("pane.maximize")} kbd="Ctrl+Shift+M" onClick={onZoom} />
          )}
          <Button size="sm" variant="ghost" icon={X} tip={t("pane.close")} kbd="Ctrl+Shift+W" onClick={onClose} />
        </div>
      </div>
      {dragging && dragging !== pane.id && (
        <div
          className="pane-drop"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(PANE_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const next = zoneFor(event);
            setZone((prev) => (prev === next ? prev : next));
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setZone(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = event.dataTransfer.getData(PANE_MIME);
            const where = zone ?? "center";
            setZone(null);
            if (source) onDropPane(source, where);
          }}
        >
          {zone && (
            <div className={`drop-zone zone-${zone}`}>
              <span>{zone === "center" ? t("pane.swap") : t(`pane.dock.${zone}`)}</span>
            </div>
          )}
        </div>
      )}
      {runtime?.ptyId && state !== "idle" ? (
        <>
          <LiveTerminal
            key={runtime.ptyId}
            ref={register}
            ptyId={runtime.ptyId}
            active={active}
            autoFocus={focused}
            onFocus={onFocus}
            onExit={(info) => onExit(info.signal ? t("pane.exitSignal", { signal: info.signal }) : t("pane.exitCode", { code: info.exitCode ?? "?" }))}
          />
          {state === "exited" && (
            <div className="pane-exit">
              <span className="grow truncate">
                {title} {runtime.exitText}
              </span>
              {pane.launch.type === "engine" && engine?.continueArgs?.length ? (
                <Button size="sm" icon={RotateCcw} onClick={() => onStart(pane.launch, true)}>
                  {t("common.continue")}
                </Button>
              ) : null}
              <Button size="sm" icon={Play} onClick={() => onStart(pane.launch)}>
                {t("common.restart")}
              </Button>
              <Button size="sm" variant="ghost" icon={X} onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="pane-idle">
          {state === "starting" ? (
            <span className="hstack">
              <span className="spinner" /> {t("pane.starting", { title })}
            </span>
          ) : pane.launch.type === "engine" ? (
            <>
              <span>
                {t("pane.lastTime", { title })}
                {engine && !engine.available ? ` ${t("pane.notOnPath")}` : ""}
              </span>
              <div className="launchers">
                {engine?.continueArgs?.length ? (
                  <Button variant="primary" icon={RotateCcw} disabled={!engine?.available} onClick={() => onStart(pane.launch, true)}>
                    {t("pane.continueSession")}
                  </Button>
                ) : null}
                <Button icon={Play} disabled={!engine?.available} onClick={() => onStart(pane.launch)}>
                  {t("pane.startEngine", { title })}
                </Button>
                <Button icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  {t("pane.shellInstead")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <span>{t("pane.nothing")}</span>
              <div className="launchers">
                <Button variant="primary" icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  {t("code.newTerminal")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
