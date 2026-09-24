import { useCallback, useEffect, useRef, useState } from "react";
import type { FileNode } from "../core/files.js";
import { shellQuote } from "../core/files.js";
import type { Engine, Workspace } from "../shared/api.js";
import { TerminalView } from "../components/TerminalView.js";

interface Pane {
  id: string;
  ptyId: string | null;
  title: string;
  exited: boolean;
}

type LayoutNode = { kind: "pane"; id: string } | { kind: "split"; dir: "row" | "col"; a: LayoutNode; b: LayoutNode };

let seq = 1;
const uid = () => `p${seq++}`;

function replaceNode(node: LayoutNode, id: string, next: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === id ? next : node;
  return { ...node, a: replaceNode(node.a, id, next), b: replaceNode(node.b, id, next) };
}

function removeNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === "pane") return node.id === id ? null : node;
  const a = removeNode(node.a, id);
  const b = removeNode(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

export function CodeMode({ active }: { active: boolean }) {
  const api = window.forgedesk;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [engineId, setEngineId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(true);
  const [showDock, setShowDock] = useState(false);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [dockUrl, setDockUrl] = useState("");
  const [dockError, setDockError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void }>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const current = workspaces.find((item) => item.id === currentId) ?? null;
  const layout = currentId ? layouts[currentId] : undefined;

  const refreshWorkspaces = useCallback(async () => {
    const file = await api.listWorkspaces();
    setWorkspaces(file.workspaces);
    setCurrentId((prev) => prev ?? file.lastWorkspaceId ?? file.workspaces[0]?.id ?? null);
  }, [api]);

  useEffect(() => {
    void refreshWorkspaces();
    void api.listEngines().then((rows) => {
      setEngines(rows);
      const first = rows.find((row) => row.available);
      if (first) setEngineId(first.id);
    });
    return api.onDockFail((event) => setDockError(event.description || "This URL did not load."));
  }, [api, refreshWorkspaces]);

  useEffect(() => {
    if (!current) return;
    setDockUrl(current.dockUrl || "");
    void api.listTree(current.path).then(setTree).catch(() => setTree([]));
  }, [api, current]);

  const openShell = useCallback(
    async (workspace: Workspace, paneId: string) => {
      const { ptyId } = await api.startShell({ workspaceId: workspace.id });
      setPanes((prev) => ({
        ...prev,
        [paneId]: { id: paneId, ptyId, title: "shell", exited: false },
      }));
      setFocus(paneId);
    },
    [api],
  );

  useEffect(() => {
    if (!current || layouts[current.id]) return;
    const id = uid();
    setLayouts((prev) => ({ ...prev, [current.id]: { kind: "pane", id } }));
    void openShell(current, id).catch((reason: unknown) => setError(String(reason)));
  }, [current, layouts, openShell]);

  useEffect(() => {
    const node = dockRef.current;
    if (!node) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      void api.setDockBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: active && showDock && rect.width > 8,
        url: dockUrl,
      });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (!active) void api.setDockBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [api, active, showDock, dockUrl, currentId]);

  async function addWorkspace() {
    setError(null);
    const folder = await api.pickDirectory();
    if (!folder) return;
    const file = await api.addWorkspace(folder);
    setWorkspaces(file.workspaces);
    setCurrentId(file.lastWorkspaceId);
  }

  function removeWorkspace(workspace: Workspace) {
    setConfirm({
      text: `Remove ${workspace.name} from the desk? The folder stays on disk.`,
      run: () => {
        void api.removeWorkspace(workspace.id).then((file) => {
          setWorkspaces(file.workspaces);
          setCurrentId(file.lastWorkspaceId);
          setLayouts((prev) => {
            const next = { ...prev };
            delete next[workspace.id];
            return next;
          });
        });
      },
    });
  }

  async function select(id: string) {
    setCurrentId(id);
    await api.selectWorkspace(id);
  }

  function split(dir: "row" | "col") {
    if (!current || !focus || !layout) return;
    const id = uid();
    setLayouts((prev) => ({
      ...prev,
      [current.id]: replaceNode(layout, focus, {
        kind: "split",
        dir,
        a: { kind: "pane", id: focus },
        b: { kind: "pane", id },
      }),
    }));
    void openShell(current, id);
  }

  function closePane(pane: Pane) {
    if (!current || !layout) return;
    const finish = () => {
      if (pane.ptyId) void api.killPty(pane.ptyId);
      setPanes((prev) => {
        const next = { ...prev };
        delete next[pane.id];
        return next;
      });
      const collapsed = removeNode(layout, pane.id);
      if (!collapsed) {
        const id = uid();
        setLayouts((prev) => ({ ...prev, [current.id]: { kind: "pane", id } }));
        void openShell(current, id);
        return;
      }
      setLayouts((prev) => ({ ...prev, [current.id]: collapsed }));
    };
    if (pane.ptyId && !pane.exited) {
      setConfirm({ text: "Close this pane and stop its process?", run: finish });
      return;
    }
    finish();
  }

  async function launch() {
    if (!current || !engineId) return;
    setError(null);
    try {
      const text = prompt.trim();
      if (text) {
        const result = await api.startCodeSession({ workspaceId: current.id, engineId, prompt: text });
        const id = uid();
        const engine = engines.find((item) => item.id === engineId);
        setPanes((prev) => ({
          ...prev,
          [id]: { id, ptyId: result.ptyId, title: engine?.label ?? engineId, exited: false },
        }));
        setLayouts((prev) => {
          const base = prev[current.id] ?? { kind: "pane" as const, id };
          if (!focus || base.kind === "pane") {
            return {
              ...prev,
              [current.id]: { kind: "split", dir: "row", a: base, b: { kind: "pane", id } },
            };
          }
          return { ...prev, [current.id]: replaceNode(base, focus, { kind: "split", dir: "row", a: { kind: "pane", id: focus }, b: { kind: "pane", id } }) };
        });
        setFocus(id);
        setPrompt("");
        return;
      }
      const target = focus ? panes[focus] : undefined;
      const spawnInto = async (paneId: string) => {
        if (target?.ptyId && paneId === focus) await api.killPty(target.ptyId);
        const result = await api.startCodeSession({ workspaceId: current.id, engineId, prompt: "" });
        const engine = engines.find((item) => item.id === engineId);
        setPanes((prev) => ({
          ...prev,
          [paneId]: { id: paneId, ptyId: result.ptyId, title: engine?.label ?? engineId, exited: false },
        }));
        setFocus(paneId);
      };
      if (target && (target.exited || !target.ptyId)) {
        await spawnInto(target.id);
        return;
      }
      if (target?.ptyId) {
        setConfirm({ text: "Replace the process in the focused pane?", run: () => void spawnInto(target.id) });
        return;
      }
      const id = uid();
      setLayouts((prev) => ({ ...prev, [current.id]: { kind: "pane", id } }));
      await spawnInto(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function insertPath(filePath: string) {
    const pane = focus ? panes[focus] : undefined;
    if (!pane?.ptyId) return;
    void api.writePty(pane.ptyId, `${shellQuote(filePath)} `);
  }

  async function saveDock(url: string) {
    if (!current) return;
    setDockError(null);
    try {
      await api.setDockUrl(current.id, url);
      setDockUrl(url);
      setWorkspaces((prev) => prev.map((item) => (item.id === current.id ? { ...item, dockUrl: url } : item)));
    } catch (reason) {
      setDockError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="fd-fill">
      <aside className="fd-sidebar">
        <div className="fd-row" style={{ padding: 8 }}>
          <button className="fd-btn-primary" type="button" onClick={() => void addWorkspace()}>
            Add workspace
          </button>
        </div>
        <div className="fd-side-scroll">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className="fd-agentbtn"
              type="button"
              aria-pressed={workspace.id === currentId}
              onClick={() => void select(workspace.id)}
            >
              {workspace.name}
            </button>
          ))}
          {workspaces.length === 0 && <p className="fd-muted" style={{ padding: 8 }}>No folders yet.</p>}
        </div>
      </aside>
      <section className="fd-main">
        <div className="fd-toolbar">
          <select className="fd-input" style={{ width: 180 }} value={engineId} onChange={(event) => setEngineId(event.target.value)}>
            {engines.filter((engine) => engine.available).map((engine) => (
              <option key={engine.id} value={engine.id}>{engine.label}</option>
            ))}
            {engines.every((engine) => !engine.available) && <option value="">No engines on PATH</option>}
          </select>
          <input
            className="fd-input"
            placeholder="Prompt for a new pane, or leave empty to open the engine here"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void launch();
            }}
          />
          <button className="fd-btn-primary" type="button" onClick={() => void launch()} disabled={!current || !engineId}>
            Launch
          </button>
          <button className="fd-btn" type="button" onClick={() => split("row")} disabled={!current}>Split</button>
          <button className="fd-btn" type="button" onClick={() => split("col")} disabled={!current}>Stack</button>
          <button className="fd-btn" type="button" onClick={() => setShowFiles((value) => !value)}>Files</button>
          <button className="fd-btn" type="button" onClick={() => setShowDock((value) => !value)}>Browser</button>
        </div>
        {error && <p className="fd-error" style={{ padding: "0 10px" }}>{error}</p>}
        <div className="fd-canvas">
          {!current && (
            <div className="fd-empty">
              <p className="fd-kicker">Code</p>
              <h2>A folder, then a real shell.</h2>
              <p className="fd-muted">Add a project folder. Terminals and engines open there, and a browser can sit beside them.</p>
            </div>
          )}
          {current && layout && (
            <LayoutView
              node={layout}
              panes={panes}
              focus={focus}
              onFocus={(id) => {
                setFocus(id);
                const pane = panes[id];
                if (pane) setPanes((prev) => ({ ...prev, [id]: { ...pane, exited: false } }));
              }}
              onClose={closePane}
            />
          )}
          {showFiles && current && (
            <aside className="fd-files">
              <div className="fd-pane-bar">
                <span>Files</span>
                <button className="fd-btn" type="button" onClick={() => void api.openPath(current.path)}>Open</button>
              </div>
              <div className="fd-tree">
                <Tree nodes={tree} depth={0} onPick={insertPath} />
              </div>
            </aside>
          )}
          {showDock && current && (
            <aside className="fd-dock">
              <div className="fd-pane-bar">
                <input
                  className="fd-input"
                  value={dockUrl}
                  placeholder="http://127.0.0.1:5177"
                  onChange={(event) => setDockUrl(event.target.value)}
                  onBlur={() => void saveDock(dockUrl)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveDock(dockUrl);
                  }}
                />
              </div>
              {dockError && <p className="fd-error" style={{ padding: "0 8px" }}>{dockError}</p>}
              {!dockUrl && <p className="fd-muted" style={{ padding: 8 }}>Set a URL</p>}
              <div ref={dockRef} className="fd-dock-view" />
            </aside>
          )}
        </div>
      </section>
      {confirm && (
        <div className="fd-modal-back">
          <div className="fd-panel fd-modal">
            <p>{confirm.text}</p>
            <div className="fd-row">
              <button className="fd-btn" type="button" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="fd-btn-primary"
                type="button"
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  run();
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LayoutView({
  node,
  panes,
  focus,
  onFocus,
  onClose,
}: {
  node: LayoutNode;
  panes: Record<string, Pane>;
  focus: string | null;
  onFocus: (id: string) => void;
  onClose: (pane: Pane) => void;
}) {
  if (node.kind === "split") {
    return (
      <div className={node.dir === "row" ? "fd-split-row" : "fd-split-col"}>
        <LayoutView node={node.a} panes={panes} focus={focus} onFocus={onFocus} onClose={onClose} />
        <LayoutView node={node.b} panes={panes} focus={focus} onFocus={onFocus} onClose={onClose} />
      </div>
    );
  }
  const pane = panes[node.id];
  return (
    <div className={focus === node.id ? "fd-pane focus" : "fd-pane"} onMouseDown={() => onFocus(node.id)}>
      <div className="fd-pane-bar">
        <span>{pane?.title ?? "shell"}{pane?.exited ? " · exited" : ""}</span>
        {pane && (
          <button className="fd-iconbtn" type="button" onClick={() => onClose(pane)}>Close</button>
        )}
      </div>
      {pane?.ptyId ? <TerminalView ptyId={pane.ptyId} /> : <div className="fd-xterm" />}
    </div>
  );
}

function Tree({ nodes, depth, onPick }: { nodes: FileNode[]; depth: number; onPick: (filePath: string) => void }) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <button className={node.kind === "dir" ? "fd-dir" : ""} type="button" style={{ paddingLeft: 4 + depth * 12 }} onClick={() => onPick(node.path)}>
            {node.kind === "dir" ? `${node.name}/` : node.name}
          </button>
          {node.children && <Tree nodes={node.children} depth={depth + 1} onPick={onPick} />}
        </div>
      ))}
    </>
  );
}
