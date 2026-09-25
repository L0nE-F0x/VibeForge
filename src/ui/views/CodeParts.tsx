import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  Globe,
  Link2,
  RefreshCw,
  Square,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DockState, FileNode, LayoutNode } from "../../shared/api.js";
import { call, errorText, on } from "../api.js";
import { PATH_MIME } from "../components/Terminal.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Input, Spinner } from "../components/ui.js";
import { boxOf } from "../floating.js";
import { useT } from "../i18n/index.js";
import { dockCovered, setDockArea, useDockCovered, useToast } from "../state.js";

// ------------------------------------------------------------------ split layout

export function SplitView({
  node,
  onRatio,
  renderPane,
}: {
  node: LayoutNode;
  onRatio: (path: string, ratio: number) => void;
  renderPane: (pane: Extract<LayoutNode, { kind: "pane" }>) => ReactNode;
  path?: string;
}) {
  return <SplitNode node={node} path="" onRatio={onRatio} renderPane={renderPane} />;
}

function SplitNode({
  node,
  path,
  onRatio,
  renderPane,
}: {
  node: LayoutNode;
  path: string;
  onRatio: (path: string, ratio: number) => void;
  renderPane: (pane: Extract<LayoutNode, { kind: "pane" }>) => ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  if (node.kind === "pane") return <>{renderPane(node)}</>;
  const start = (event: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      const ratio = node.dir === "row" ? (moveEvent.clientX - box.left) / box.width : (moveEvent.clientY - box.top) / box.height;
      onRatio(path, Math.min(0.85, Math.max(0.15, ratio)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className={`split dir-${node.dir}`}>
      <div className="split-cell" style={{ flex: `${node.ratio} 1 0` }}>
        <SplitNode node={node.a} path={`${path}a`} onRatio={onRatio} renderPane={renderPane} />
      </div>
      <div
        className={`divider${dragging ? " dragging" : ""}`}
        onPointerDown={start}
        onDoubleClick={() => onRatio(path, 0.5)}
        {...tipProps(t("split.resize"))}
      />
      <div className="split-cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <SplitNode node={node.b} path={`${path}b`} onRatio={onRatio} renderPane={renderPane} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ files

function TreeLevel({
  dir,
  depth,
  onInsert,
  refreshKey,
}: {
  dir: string;
  depth: number;
  onInsert: (path: string) => void;
  refreshKey: number;
}) {
  const t = useT();
  const [nodes, setNodes] = useState<FileNode[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    void call("files.list", dir)
      .then((list) => !cancelled && setNodes(list))
      .catch(() => !cancelled && setNodes([]));
    return () => {
      cancelled = true;
    };
  }, [dir, refreshKey]);
  if (!nodes) return depth === 0 ? <div style={{ padding: 10 }}><Spinner /></div> : null;
  if (nodes.length === 0 && depth === 0) return <div className="faint" style={{ padding: 10 }}>Empty folder.</div>;
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.kind === "dir";
        const expanded = Boolean(open[node.path]);
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-row${node.quiet ? " quiet" : ""}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PATH_MIME, node.path);
                event.dataTransfer.setData("text/plain", node.path);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => (isDir ? setOpen((prev) => ({ ...prev, [node.path]: !expanded })) : onInsert(node.path))}
              onDoubleClick={() => !isDir && void call("app.openPath", node.path)}
              {...tipProps(isDir ? node.name : t("files.insertOpen", { name: node.name }), { side: "left" })}
            >
              {isDir ? (
                expanded ? <ChevronDown size={12} className="faint" /> : <ChevronRight size={12} className="faint" />
              ) : (
                <span style={{ width: 12 }} />
              )}
              {isDir ? (
                expanded ? <FolderOpen size={13} className="accent-text" /> : <Folder size={13} className="accent-text" style={{ opacity: node.quiet ? 0.5 : 1 }} />
              ) : node.kind === "link" ? (
                <Link2 size={13} className="faint" />
              ) : (
                <File size={13} className="faint" />
              )}
              <span className="truncate">{node.name}</span>
              <span className="tree-actions">
                <span
                  role="button"
                  tabIndex={-1}
                  className="btn ghost sm icon"
                  {...tipProps(t("files.insert"), { side: "top" })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onInsert(node.path);
                  }}
                >
                  <Copy size={11} />
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="btn ghost sm icon"
                  {...tipProps(t("files.open"), { side: "top" })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void call("app.openPath", node.path);
                  }}
                >
                  <ExternalLink size={11} />
                </span>
              </span>
            </button>
            {isDir && expanded && <TreeLevel dir={node.path} depth={depth + 1} onInsert={onInsert} refreshKey={refreshKey} />}
          </div>
        );
      })}
    </>
  );
}

export function FilesPanel({ root, onInsert }: { root: string; onInsert: (path: string) => void }) {
  const t = useT();
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <div className="dock-bar">
        <span className="faint truncate grow mono" style={{ fontSize: "var(--fs-xs)" }} {...tipProps(root)}>
          {root}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} title={t("common.refresh")} onClick={() => setRefreshKey((key) => key + 1)} />
        <Button size="sm" variant="ghost" icon={FolderOpen} title={t("common.openFileManager")} onClick={() => void call("app.openPath", root)} />
      </div>
      <div className="tree">
        <TreeLevel key={root} dir={root} depth={0} onInsert={onInsert} refreshKey={refreshKey} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ browser dock

/** Resolves once the page has painted what was just rendered (or after a short wait if frames stall). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 80);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      }),
    );
  });
}

export function DockPanel({ url, onUrl, visible }: { url: string; onUrl: (url: string) => void; visible: boolean }) {
  const t = useT();
  const { fail } = useToast();
  const viewRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(url);
  const [state, setState] = useState<DockState | null>(null);
  // The page is a native view drawn above the app. Our own cards (no URL, a load error) take its
  // place; while a menu or dialog lands on it, a still of the page stands in so they can show.
  const live = visible && Boolean(url) && !state?.error;
  const covered = useDockCovered();
  const [still, setStill] = useState<string | null>(null);

  useEffect(() => setDraft(url), [url]);
  useEffect(() => on("dock", setState), []);

  const place = useCallback(() => {
    const node = viewRef.current;
    if (!node || !live) {
      setDockArea(null);
      void call("dock.hide").catch(() => undefined);
      return;
    }
    const rect = node.getBoundingClientRect();
    setDockArea(boxOf(rect));
    // While covered, the view stays hidden behind its still and comes back at the latest size.
    // Ask the registry, not `covered`: publishing the area can itself make the dock covered.
    if (!dockCovered()) void call("dock.show", { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, url).catch(() => undefined);
  }, [live, covered, url]);

  useEffect(() => {
    place();
    const node = viewRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(node);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  // Something landed on the page: capture it, paint the still in its place, then hide the view.
  useEffect(() => {
    if (!live || !covered) return;
    let cancelled = false;
    void (async () => {
      const src = await call("dock.capture").catch(() => null);
      if (cancelled) return;
      if (src) {
        // Wait for load, not decode(): decode() settles with the next frame, and frames can stall.
        const loaded = await new Promise<boolean>((resolve) => {
          const image = new Image();
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = src;
        });
        if (cancelled) return;
        if (loaded) {
          setStill(src);
          await nextPaint();
          if (cancelled) return;
        }
      }
      // Without a still (the page never painted), the panel's own background shows instead.
      void call("dock.hide").catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [live, covered]);

  // Once the view is back, give it time to repaint over the still before dropping the still.
  useEffect(() => {
    if (!still || (live && covered)) return;
    const timer = window.setTimeout(() => setStill(null), 250);
    return () => window.clearTimeout(timer);
  }, [still, live, covered]);

  useEffect(
    () => () => {
      setDockArea(null);
      void call("dock.hide").catch(() => undefined);
    },
    [],
  );

  const commit = () => {
    let next = draft.trim();
    if (next && !/^https?:\/\//i.test(next)) next = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(next) ? `http://${next}` : `https://${next}`;
    if (next !== url) {
      try {
        onUrl(next);
      } catch (error) {
        fail(error, "That URL did not work");
      }
    } else void call("dock.command", "reload");
  };

  const loading = Boolean(state?.loading) && live;
  const error = visible && url ? state?.error : null;

  return (
    <>
      <div className="dock-bar">
        <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={!state?.canGoBack} onClick={() => void call("dock.command", "back")} title={t("common.back")} />
        <Button size="sm" variant="ghost" icon={ArrowRight} disabled={!state?.canGoForward} onClick={() => void call("dock.command", "forward")} title={t("dock.forward")} />
        <Button
          size="sm"
          variant="ghost"
          icon={loading ? Square : RefreshCw}
          disabled={!url}
          onClick={() => void call("dock.command", loading ? "stop" : "reload")}
          title={loading ? t("dock.stop") : t("dock.reload")}
        />
        <Input
          value={draft}
          placeholder="http://127.0.0.1:5173"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && commit()}
          onBlur={() => draft.trim() !== url && commit()}
        />
        <Button size="sm" variant="ghost" icon={ExternalLink} disabled={!url} onClick={() => void call("app.openExternal", state?.url || url)} title={t("dock.openBrowser")} />
        <Button size="sm" variant="ghost" icon={Wrench} disabled={!url} onClick={() => void call("dock.command", "devtools")} title={t("dock.devtools")} />
      </div>
      <div ref={viewRef} className="dock-view">
        {still && live && <img className="dock-still" src={still} alt="" decoding="sync" draggable={false} />}
        {!url && (
          <div className="dock-message">
            <Globe size={26} className="accent-text" />
            <strong style={{ color: "var(--fg)" }}>{t("dock.empty.title")}</strong>
            <span>{t("dock.empty.body")}</span>
          </div>
        )}
        {error && (
          <div className="dock-message" style={{ background: "var(--bg-deep)", zIndex: 1 }}>
            <Globe size={26} style={{ color: "var(--red)" }} />
            <strong style={{ color: "var(--fg)" }}>{t("dock.error.title")}</strong>
            <span className="mono selectable" style={{ fontSize: "var(--fs-sm)" }}>{errorText(error)}</span>
            <Button size="sm" icon={RefreshCw} onClick={() => void call("dock.command", "reload")}>
              {t("common.tryAgain")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
