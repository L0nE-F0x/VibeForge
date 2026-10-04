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
import { isDockUrl, normalizeDockInput, savedDockUrl } from "../../shared/dock-url.js";
import { tildify } from "../../shared/text.js";
import { call, errorText, on, useAppInfo } from "../api.js";
import { PATH_MIME } from "../components/Terminal.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Input, Skeleton } from "../components/ui.js";
import { boxOf, clipBox } from "../floating.js";
import { t as translate, useT } from "../i18n/index.js";
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
  if (!nodes) return depth === 0 ? <Skeleton rows={5} /> : null;
  if (nodes.length === 0 && depth === 0) return <div className="faint" style={{ padding: 10 }}>{translate("files.empty")}</div>;
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
  const home = useAppInfo().data?.home ?? "";
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <div className="dock-bar">
        <span className="faint truncate grow mono" style={{ fontSize: "var(--fs-xs)" }} {...tipProps(root)}>
          {tildify(root, home)}
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

export function DockPanel({
  workspaceId,
  url,
  onUrl,
  visible,
}: {
  workspaceId: string;
  url: string;
  onUrl: (workspaceId: string, url: string) => void;
  visible: boolean;
}) {
  const t = useT();
  const { fail } = useToast();
  const viewRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(url);
  const [state, setState] = useState<DockState | null>(null);
  const [seenUrl, setSeenUrl] = useState(url);
  const [still, setStill] = useState<string | null>(null);
  const editing = useRef(false);
  const urlRef = useRef(url);
  urlRef.current = url;
  // The address to give the view. `url` is what this workspace last saved; once the page moves,
  // follow that, so a resize does not load the address from before the move.
  const reported = useRef(url);
  const covered = useDockCovered();
  if (seenUrl !== url) {
    setSeenUrl(url);
    reported.current = url;
    if (!editing.current) setDraft(url);
  }
  // The page is a native view drawn above the app. Our own cards (no URL, a load error) take its
  // place; while a menu or dialog lands on it, a still of the page stands in so they can show.
  // State from another workspace is ignored, so its back button cannot flash on this one.
  const mine = state?.workspaceId === workspaceId ? state : null;
  const live = visible && Boolean(url) && !mine?.error;

  useEffect(
    () =>
      on("dock", (next) => {
        // A page that belongs to another workspace must not move this bar.
        const adopted = savedDockUrl(next.workspaceId, workspaceId, next.url, reported.current);
        if (next.workspaceId !== workspaceId) return;
        setState(next);
        // A cleared address stays cleared. A hidden page must not type itself back into the bar.
        if (!urlRef.current || !adopted) return;
        reported.current = adopted;
        if (!editing.current) setDraft(adopted);
      }),
    [workspaceId],
  );

  const place = useCallback(() => {
    const node = viewRef.current;
    if (!node || !visible) {
      setDockArea(null);
      void call("dock.hide").catch(() => undefined);
      return;
    }
    if (!url) {
      setDockArea(null);
      // An empty address tells the dock to stop storing this page, so a later move cannot refill it.
      void call("dock.show", { x: 0, y: 0, width: 0, height: 0 }, "", workspaceId).catch(() => undefined);
      return;
    }
    if (mine?.error) {
      setDockArea(null);
      void call("dock.hide", workspaceId).catch(() => undefined);
      return;
    }
    const rect = node.getBoundingClientRect();
    // The native view is not clipped by the stage's overflow. Pan can push this panel under the
    // rail or past the tile; only the part inside the stage should be drawn.
    const stage = node.closest(".stage");
    const frame = stage instanceof HTMLElement ? stage.getBoundingClientRect() : null;
    const visibleBox = frame ? clipBox(boxOf(rect), boxOf(frame)) : boxOf(rect);
    setDockArea(visibleBox);
    const width = visibleBox ? visibleBox.right - visibleBox.left : 0;
    const height = visibleBox ? visibleBox.bottom - visibleBox.top : 0;
    if (!visibleBox || width < 8 || height < 8) {
      void call("dock.hide", workspaceId).catch(() => undefined);
      return;
    }
    // While covered, the view stays hidden behind its still and comes back at the latest size.
    // Ask the registry, not `covered`: publishing the area can itself make the dock covered.
    if (!dockCovered()) {
      const target = reported.current || url;
      void call("dock.show", { x: visibleBox.left, y: visibleBox.top, width, height }, target, workspaceId).catch(() => undefined);
    }
  }, [visible, url, workspaceId, covered, mine?.error]);

  useEffect(() => {
    place();
    const node = viewRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(node);
    window.addEventListener("resize", place);
    // Panning the desk moves the placeholder. Fold a burst of scroll events into one frame.
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
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
      void call("dock.hide", workspaceId).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [live, covered, workspaceId]);

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
    const next = normalizeDockInput(draft);
    if (next !== url) {
      reported.current = next;
      try {
        onUrl(workspaceId, next);
      } catch (error) {
        fail(error, "That URL did not work");
      }
    } else void call("dock.command", "reload");
  };

  const loading = Boolean(mine?.loading) && live;
  const error = visible && url ? (mine?.error ?? null) : null;

  return (
    <>
      <div className="dock-bar">
        <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={!url || !mine?.canGoBack} onClick={() => void call("dock.command", "back")} title={t("common.back")} />
        <Button size="sm" variant="ghost" icon={ArrowRight} disabled={!url || !mine?.canGoForward} onClick={() => void call("dock.command", "forward")} title={t("dock.forward")} />
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
          onFocus={() => {
            editing.current = true;
          }}
          onKeyDown={(event) => event.key === "Enter" && commit()}
          onBlur={() => {
            // The id is the one this bar was editing, so a blur during a workspace switch cannot
            // write this address onto the workspace being switched to.
            editing.current = false;
            if (normalizeDockInput(draft) !== url) commit();
          }}
        />
        <Button size="sm" variant="ghost" icon={ExternalLink} disabled={!url} onClick={() => void call("app.openExternal", (mine && isDockUrl(mine.url) ? mine.url : url))} title={t("dock.openBrowser")} />
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
