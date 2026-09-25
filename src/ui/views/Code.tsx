import {
  Columns2,
  FolderOpen,
  FolderPlus,
  Globe,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  RotateCcw,
  Rows2,
  Rocket,
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
import { Button, Empty, Input, MenuButton, Select, type MenuItem } from "../components/ui.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { DockPanel, FilesPanel, SplitView } from "./CodeParts.js";

type PaneNode = Extract<LayoutNode, { kind: "pane" }>;

interface Runtime {
  ptyId: string | null;
  runId: string | null;
  state: "idle" | "starting" | "live" | "exited";
  exitText: string | null;
}

const newPaneId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shellPane = (): PaneNode => ({ kind: "pane", id: newPaneId(), launch: { type: "shell" } });

function panesOf(node: LayoutNode): PaneNode[] {
  return node.kind === "pane" ? [node] : [...panesOf(node.a), ...panesOf(node.b)];
}

function replacePane(node: LayoutNode, id: string, next: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === id ? next : node;
  return { ...node, a: replacePane(node.a, id, next), b: replacePane(node.b, id, next) };
}

function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === "pane") return node.id === id ? null : node;
  const a = removePane(node.a, id);
  const b = removePane(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

function setRatioAt(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.kind === "pane") return node;
  if (path === "") return { ...node, ratio };
  const [head, ...rest] = path;
  return head === "a" ? { ...node, a: setRatioAt(node.a, rest.join(""), ratio) } : { ...node, b: setRatioAt(node.b, rest.join(""), ratio) };
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
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [side, setSide] = useState(() => readLocal<{ open: boolean; tab: "files" | "browser"; width: number }>("vf.code.side", { open: true, tab: "files", width: 320 }));
  const [engineId, setEngineId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const terminals = useRef(new Map<string, TerminalHandle>());
  const starting = useRef(new Set<string>());
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  const fontSizeRef = useRef(13);
  fontSizeRef.current = settings?.terminalFontSize ?? 13;

  const current = workspaces.find((item) => item.id === currentId) ?? null;
  const available = engines.filter((engine) => engine.available);
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

  useEffect(() => {
    if (engineId && available.some((engine) => engine.id === engineId)) return;
    const preferred = available.find((engine) => engine.id === settings?.defaultEngine) ?? available[0];
    if (preferred) setEngineId(preferred.id);
  }, [available, settings, engineId]);

  useEffect(() => writeLocal("vf.code.side", side), [side]);

  // ---------------------------------------------------------------- panes

  const patchRuntime = useCallback((paneId: string, patch: Partial<Runtime>) => {
    setRuntime((prev) => ({ ...prev, [paneId]: { ...(prev[paneId] ?? { ptyId: null, runId: null, state: "idle", exitText: null }), ...patch } }));
  }, []);

  const updateLayout = useCallback((workspaceId: string, next: LayoutNode) => {
    setLayouts((prev) => ({ ...prev, [workspaceId]: next }));
    void call("layouts.save", workspaceId, next).catch(() => undefined);
  }, []);

  const startPane = useCallback(
    async (workspace: Workspace, pane: PaneNode, opts: { prompt?: string; continueSession?: boolean } = {}) => {
      if (starting.current.has(pane.id)) return;
      starting.current.add(pane.id);
      patchRuntime(pane.id, { state: "starting", ptyId: null, runId: null, exitText: null });
      // Measure after React has laid the new pane out.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const size = estimateTermSize(document.querySelector<HTMLElement>(`[data-pane="${pane.id}"]`), fontSizeRef.current, 34);
      try {
        if (pane.launch.type === "shell") {
          const { ptyId } = await call("code.shell", { workspaceId: workspace.id, ...size });
          patchRuntime(pane.id, { ptyId, runId: null, state: "live" });
        } else {
          const result = await call("code.engine", {
            workspaceId: workspace.id,
            engineId: pane.launch.engineId,
            prompt: opts.prompt,
            continueSession: opts.continueSession,
            ...size,
          });
          patchRuntime(pane.id, { ptyId: result.ptyId, runId: result.runId, state: "live" });
        }
        setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
      } catch (error) {
        patchRuntime(pane.id, { state: "idle" });
        fail(error, "Could not start the terminal");
      } finally {
        starting.current.delete(pane.id);
      }
    },
    [fail, patchRuntime],
  );

  // Load (or create) the current workspace's layout, then bring its shells back.
  useEffect(() => {
    if (!opened || !current || layoutsRef.current[current.id]) return;
    let cancelled = false;
    void call("layouts.get", current.id)
      .catch(() => null)
      .then((saved) => {
        if (cancelled || layoutsRef.current[current.id]) return;
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
    if (!layout) return;
    const owner = panesOf(layout).find((pane) => runtime[pane.id]?.ptyId === route.ptyId);
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
    return engines.find((engine) => title.startsWith(engine.label))?.id ?? engineId;
  }

  function adopt(workspace: Workspace, ptyId: string, runId: string | null, launch: PaneLaunch) {
    const layout = layoutsRef.current[workspace.id] ?? shellPane();
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch };
    const target = focus[workspace.id] ?? panesOf(layout)[0].id;
    updateLayout(workspace.id, replacePane(layout, target, { kind: "split", dir: "row", ratio: 0.5, a: panesOf(layout).find((item) => item.id === target) ?? layout, b: pane }));
    patchRuntime(pane.id, { ptyId, runId, state: "live" });
    setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
  }

  function splitPane(workspace: Workspace, paneId: string, dir: "row" | "col", launch: PaneLaunch, opts: { prompt?: string } = {}) {
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    const existing = panesOf(layout).find((pane) => pane.id === paneId);
    if (!existing) return;
    const pane: PaneNode = { kind: "pane", id: newPaneId(), launch };
    updateLayout(workspace.id, replacePane(layout, paneId, { kind: "split", dir, ratio: 0.5, a: existing, b: pane }));
    setFocus((prev) => ({ ...prev, [workspace.id]: pane.id }));
    void startPane(workspace, pane, opts);
  }

  async function closePane(workspace: Workspace, pane: PaneNode) {
    const state = runtime[pane.id];
    if (state?.state === "live" && state.ptyId) {
      const ok = await confirm({
        title: "Close this terminal?",
        body: state.runId ? "The process is stopped. Its run keeps the transcript and a git snapshot." : "The shell and anything running in it are stopped.",
        confirm: "Close terminal",
      });
      if (!ok) return;
      void call("pty.kill", state.ptyId).catch(() => undefined);
    }
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    const next = removePane(layout, pane.id) ?? shellPane();
    updateLayout(workspace.id, next);
    setRuntime((prev) => {
      const copy = { ...prev };
      delete copy[pane.id];
      return copy;
    });
    terminals.current.delete(pane.id);
    const remaining = panesOf(next);
    setFocus((prev) => ({ ...prev, [workspace.id]: remaining[remaining.length - 1].id }));
    if (next.kind === "pane" && !runtime[next.id] && next.launch.type === "shell") void startPane(workspace, next);
  }

  function launchHere(workspace: Workspace, pane: PaneNode, launch: PaneLaunch, opts: { continueSession?: boolean; prompt?: string } = {}) {
    const layout = layoutsRef.current[workspace.id];
    if (!layout) return;
    const next: PaneNode = { ...pane, launch };
    updateLayout(workspace.id, replacePane(layout, pane.id, next));
    void startPane(workspace, next, opts);
  }

  async function launchFromBar() {
    if (!current || !engineId) return;
    const layout = layouts[current.id];
    if (!layout) return;
    const text = prompt.trim();
    const focusedId = focus[current.id] ?? panesOf(layout)[0].id;
    const focused = panesOf(layout).find((pane) => pane.id === focusedId) ?? panesOf(layout)[0];
    const state = runtime[focused.id]?.state ?? "idle";
    setPrompt("");
    if (state === "idle" || state === "exited") {
      launchHere(current, focused, { type: "engine", engineId }, { prompt: text || undefined });
      return;
    }
    splitPane(current, focused.id, "row", { type: "engine", engineId }, { prompt: text || undefined });
  }

  function insertPath(target: string) {
    if (!current) return;
    const paneId = focus[current.id];
    const handle = paneId ? terminals.current.get(paneId) : undefined;
    if (!handle) {
      push("info", "Focus a terminal first", "Click a terminal, then click a file to insert its path.");
      return;
    }
    handle.paste(`${shellQuote(target)} `);
  }

  // ---------------------------------------------------------------- workspaces

  const [addWorkspace] = useAction(async () => {
    const folder = await call("app.pickFolder", "Open a project folder");
    if (!folder) return;
    const next = await call("workspaces.add", folder);
    if (next.lastWorkspaceId) {
      setCurrentId(next.lastWorkspaceId);
      void call("workspaces.select", next.lastWorkspaceId);
    }
  }, "Could not add the workspace");

  const [removeWorkspace] = useAction(async (workspace: Workspace) => {
    const running = live.filter((session) => session.workspaceId === workspace.id).length;
    const ok = await confirm({
      title: `Remove ${workspace.name} from VibeForge?`,
      body: (
        <>
          The folder stays on disk. {running ? `${running} terminal${running === 1 ? "" : "s"} running here will be stopped. ` : ""}Tasks that point at it will
          need a new workspace.
        </>
      ),
      confirm: "Remove workspace",
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
  }, "Could not remove the workspace");

  const [renameWorkspace] = useAction(async (workspace: Workspace, name: string) => {
    if (name.trim() && name.trim() !== workspace.name) await call("workspaces.update", workspace.id, { name: name.trim() });
    setRenaming(null);
  }, "Could not rename");

  const [setDockUrl] = useAction(async (url: string) => {
    if (current) await call("workspaces.update", current.id, { dockUrl: url });
  }, "Could not set the URL");

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
  const quick = available.slice(0, 4);

  return (
    <div className="view" hidden={!active}>
      <div className="code-view">
        <aside className="list-panel">
          <div className="list-head">
            <h2 className="grow">Workspaces</h2>
            <Button size="sm" icon={FolderPlus} onClick={() => void addWorkspace()} title="Open a project folder">
              Add
            </Button>
          </div>
          <div className="list-scroll">
            {workspaces.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>Add a project folder to get terminals in it.</div>}
            {workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="row workspace-row"
                role="button"
                tabIndex={0}
                aria-selected={workspace.id === currentId}
                onClick={() => select(workspace)}
                onKeyDown={(event) => event.key === "Enter" && select(workspace)}
              >
                <FolderOpen size={15} className="accent-text" style={{ flex: "none" }} />
                <span className="vstack grow" style={{ gap: 0 }}>
                  {renaming === workspace.id ? (
                    <Input
                      autoFocus
                      defaultValue={workspace.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => void renameWorkspace(workspace, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void renameWorkspace(workspace, (event.target as HTMLInputElement).value);
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="row-title truncate">{workspace.name}</span>
                  )}
                  <span className="row-sub truncate mono">{tildify(workspace.path, home)}</span>
                </span>
                {liveCount(workspace.id) > 0 && <span className="ws-live">{liveCount(workspace.id)}</span>}
                <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <MenuButton
                    size="sm"
                    variant="ghost"
                    icon={MoreHorizontal}
                    title="Workspace actions"
                    items={[
                      { label: "Open folder", icon: FolderOpen, onSelect: () => void call("app.openPath", workspace.path) },
                      { label: "Rename", icon: Pencil, onSelect: () => setRenaming(workspace.id) },
                      "sep",
                      { label: "Remove from VibeForge", icon: Trash2, danger: true, onSelect: () => void removeWorkspace(workspace) },
                    ]}
                  />
                </span>
              </div>
            ))}
          </div>
        </aside>

        {!current ? (
          <Empty
            icon={SquareTerminal}
            title="A folder, then real terminals"
            actions={
              <Button variant="primary" icon={FolderPlus} onClick={() => void addWorkspace()}>
                Open a project folder
              </Button>
            }
          >
            Code mode runs your shells and CLIs side by side in a project, with its files and a browser for the dev server next to them. Layouts are remembered
            per workspace.
          </Empty>
        ) : (
          <div className="code-main">
            <div className="code-toolbar">
              <div className="vstack grow" style={{ gap: 0 }}>
                <strong className="truncate" style={{ fontSize: "var(--fs-md)" }}>
                  {current.name}
                </strong>
                <button type="button" className="faint mono truncate" style={{ fontSize: "var(--fs-xs)", textAlign: "left" }} onClick={() => void call("app.openPath", current.path)} title="Open in the file manager">
                  {tildify(current.path, home)}
                </button>
              </div>
              {quick.map((engine) => (
                <Button
                  key={engine.id}
                  size="sm"
                  icon={Play}
                  title={`Open ${engine.label} in a new pane`}
                  onClick={() => {
                    const layout = layouts[current.id];
                    if (!layout) return;
                    const target = focus[current.id] ?? panesOf(layout)[0].id;
                    const pane = panesOf(layout).find((item) => item.id === target);
                    const state = pane ? runtime[pane.id]?.state : undefined;
                    if (pane && (state === "idle" || state === "exited")) launchHere(current, pane, { type: "engine", engineId: engine.id });
                    else splitPane(current, target, "row", { type: "engine", engineId: engine.id });
                  }}
                >
                  {engine.label}
                </Button>
              ))}
              <Button
                size="sm"
                icon={Columns2}
                title="Split right with a shell"
                onClick={() => {
                  const layout = layouts[current.id];
                  if (layout) splitPane(current, focus[current.id] ?? panesOf(layout)[0].id, "row", { type: "shell" });
                }}
              />
              <Button
                size="sm"
                icon={Rows2}
                title="Split down with a shell"
                onClick={() => {
                  const layout = layouts[current.id];
                  if (layout) splitPane(current, focus[current.id] ?? panesOf(layout)[0].id, "col", { type: "shell" });
                }}
              />
              <Button size="sm" icon={PanelRight} pressed={side.open && side.tab === "files"} title="Files" onClick={() => setSide((prev) => ({ ...prev, open: !(prev.open && prev.tab === "files"), tab: "files" }))} />
              <Button size="sm" icon={Globe} pressed={side.open && side.tab === "browser"} title="Browser" onClick={() => setSide((prev) => ({ ...prev, open: !(prev.open && prev.tab === "browser"), tab: "browser" }))} />
            </div>

            <div className="code-work">
              {workspaces.map((workspace) => {
                const layout = layouts[workspace.id];
                if (!layout) return null;
                const visible = workspace.id === current.id;
                return (
                  <div key={workspace.id} className="canvas" style={visible ? undefined : { display: "none" }}>
                    <SplitView
                      node={layout}
                      onRatio={(path, ratio) => setLayouts((prev) => ({ ...prev, [workspace.id]: setRatioAt(prev[workspace.id], path, ratio) }))}
                      renderPane={(pane) => (
                        <PaneView
                          key={pane.id}
                          pane={pane}
                          runtime={runtime[pane.id]}
                          engines={engines}
                          active={active && visible}
                          focused={focus[workspace.id] === pane.id}
                          onFocus={() => setFocus((prev) => (prev[workspace.id] === pane.id ? prev : { ...prev, [workspace.id]: pane.id }))}
                          register={(handle) => {
                            if (handle) terminals.current.set(pane.id, handle);
                            else terminals.current.delete(pane.id);
                          }}
                          onExit={(text) => patchRuntime(pane.id, { state: "exited", exitText: text })}
                          onStart={(launch, continueSession) => launchHere(workspace, pane, launch, { continueSession })}
                          onSplit={(dir) => splitPane(workspace, pane.id, dir, { type: "shell" })}
                          onClose={() => void closePane(workspace, pane)}
                          onReview={() => runtime[pane.id]?.runId && go({ view: "runs", runId: runtime[pane.id].runId! })}
                        />
                      )}
                    />
                  </div>
                );
              })}
              {side.open && (
                <aside className="side-panel" style={{ width: side.width }}>
                  <div className="side-resize" onPointerDown={startSideResize} />
                  <div className="side-tabs">
                    <Button size="sm" variant="ghost" icon={PanelRight} pressed={side.tab === "files"} onClick={() => setSide((prev) => ({ ...prev, tab: "files" }))}>
                      Files
                    </Button>
                    <Button size="sm" variant="ghost" icon={Globe} pressed={side.tab === "browser"} onClick={() => setSide((prev) => ({ ...prev, tab: "browser" }))}>
                      Browser
                    </Button>
                    <span className="grow" />
                    <Button size="sm" variant="ghost" icon={X} title="Hide" onClick={() => setSide((prev) => ({ ...prev, open: false }))} />
                  </div>
                  {side.tab === "files" ? (
                    <FilesPanel root={current.path} onInsert={insertPath} />
                  ) : (
                    <DockPanel url={current.dockUrl} onUrl={(url) => void setDockUrl(url)} visible={active && side.open && side.tab === "browser"} />
                  )}
                </aside>
              )}
            </div>

            <div className="launch-bar">
              <div style={{ width: 170, flex: "none" }}>
                <Select value={engineId} onChange={(event) => setEngineId(event.target.value)} disabled={!available.length}>
                  {available.length === 0 && <option value="">No CLIs on PATH</option>}
                  {available.map((engine) => (
                    <option key={engine.id} value={engine.id}>
                      {engine.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Input
                value={prompt}
                placeholder={`Ask ${engineLabel(engineId)} to do something in ${current.name} — or leave empty to just open it`}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void launchFromBar();
                }}
              />
              <Button variant="primary" icon={Rocket} disabled={!engineId} onClick={() => void launchFromBar()}>
                Launch
              </Button>
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
  engines,
  active,
  focused,
  onFocus,
  register,
  onExit,
  onStart,
  onSplit,
  onClose,
  onReview,
}: {
  pane: PaneNode;
  runtime: Runtime | undefined;
  engines: Engine[];
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  register: (handle: TerminalHandle | null) => void;
  onExit: (text: string) => void;
  onStart: (launch: PaneLaunch, continueSession?: boolean) => void;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
  onReview: () => void;
}) {
  const state = runtime?.state ?? "idle";
  const engine = pane.launch.type === "engine" ? engines.find((item) => item.id === (pane.launch as { engineId: string }).engineId) : null;
  const title = pane.launch.type === "shell" ? "Shell" : (engine?.label ?? (pane.launch as { engineId: string }).engineId);
  const available = engines.filter((item) => item.available);
  const launchItems: MenuItem[] = [
    { label: "Shell", icon: TerminalSquare, onSelect: () => onStart({ type: "shell" }) },
    ...available.map((item) => ({ label: item.label, icon: Play, onSelect: () => onStart({ type: "engine", engineId: item.id }) })),
  ];

  return (
    <div className={`pane${focused ? " focused" : ""}`} data-pane={pane.id} onMouseDown={onFocus}>
      <div className="pane-head">
        {state === "live" ? <span className="dot running" /> : state === "exited" ? <span className="dot stopped" /> : <span className="dot" />}
        <span className="pane-title truncate">{title}</span>
        {runtime?.runId && (
          <button type="button" className="faint" style={{ fontSize: "var(--fs-xs)" }} onClick={onReview} title="Open this run">
            run
          </button>
        )}
        <span className="grow" />
        <div className="pane-actions">
          <MenuButton size="sm" variant="ghost" icon={Play} title="Start something here" items={launchItems} />
          <Button size="sm" variant="ghost" icon={Columns2} title="Split right" onClick={() => onSplit("row")} />
          <Button size="sm" variant="ghost" icon={Rows2} title="Split down" onClick={() => onSplit("col")} />
          <Button size="sm" variant="ghost" icon={X} title="Close" onClick={onClose} />
        </div>
      </div>
      {runtime?.ptyId && state !== "idle" ? (
        <>
          <LiveTerminal
            key={runtime.ptyId}
            ref={register}
            ptyId={runtime.ptyId}
            active={active}
            autoFocus={focused}
            onFocus={onFocus}
            onExit={(info) => onExit(info.signal ? `stopped (signal ${info.signal})` : `exited with code ${info.exitCode ?? "?"}`)}
          />
          {state === "exited" && (
            <div className="pane-exit">
              <span className="grow truncate">
                {title} {runtime.exitText}
              </span>
              {pane.launch.type === "engine" && engine?.continueArgs?.length ? (
                <Button size="sm" icon={RotateCcw} onClick={() => onStart(pane.launch, true)}>
                  Continue
                </Button>
              ) : null}
              <Button size="sm" icon={Play} onClick={() => onStart(pane.launch)}>
                Restart
              </Button>
              <Button size="sm" variant="ghost" icon={X} onClick={onClose}>
                Close
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="pane-idle">
          {state === "starting" ? (
            <span className="hstack">
              <span className="spinner" /> Starting {title}…
            </span>
          ) : pane.launch.type === "engine" ? (
            <>
              <span>
                {title} was open here last time.
                {engine && !engine.available ? " It is not on PATH right now." : ""}
              </span>
              <div className="launchers">
                {engine?.continueArgs?.length ? (
                  <Button variant="primary" icon={RotateCcw} disabled={!engine?.available} onClick={() => onStart(pane.launch, true)}>
                    Continue its session
                  </Button>
                ) : null}
                <Button icon={Play} disabled={!engine?.available} onClick={() => onStart(pane.launch)}>
                  Start {title}
                </Button>
                <Button icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  Shell instead
                </Button>
              </div>
            </>
          ) : (
            <>
              <span>Nothing running in this pane.</span>
              <div className="launchers">
                <Button variant="primary" icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  Shell
                </Button>
                {available.slice(0, 5).map((item) => (
                  <Button key={item.id} icon={Play} onClick={() => onStart({ type: "engine", engineId: item.id })}>
                    {item.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
