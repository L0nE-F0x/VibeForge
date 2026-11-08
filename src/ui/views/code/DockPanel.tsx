import { ArrowLeft, ArrowRight, ExternalLink, Globe, RefreshCw, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DockState } from "../../../shared/api.js";
import { isDockUrl, normalizeDockInput, savedDockUrl } from "../../../shared/dock-url.js";
import { call, errorText, on } from "../../api.js";
import { Button, Input } from "../../components/ui.js";
import { boxOf, clipBox } from "../../floating.js";
import { useT } from "../../i18n/index.js";
import { dockCovered, setDockArea, useDockCovered, useToast } from "../../state.js";

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
  /** The bounds and page last sent with dock.show; null once the view was hidden. */
  const shown = useRef<string | null>(null);
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
      shown.current = null;
      void call("dock.hide").catch(() => undefined);
      return;
    }
    if (!url) {
      setDockArea(null);
      shown.current = null;
      // An empty address tells the dock to stop storing this page, so a later move cannot refill it.
      void call("dock.show", { x: 0, y: 0, width: 0, height: 0 }, "", workspaceId).catch(() => undefined);
      return;
    }
    if (mine?.error) {
      setDockArea(null);
      shown.current = null;
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
      shown.current = null;
      void call("dock.hide", workspaceId).catch(() => undefined);
      return;
    }
    // While covered, the view stays hidden behind its still and comes back at the latest size.
    // Ask the registry, not `covered`: publishing the area can itself make the dock covered.
    if (!dockCovered()) {
      const target = reported.current || url;
      // Already there with this page: nothing to tell the main process.
      const next = `${visibleBox.left} ${visibleBox.top} ${width} ${height} ${workspaceId} ${target}`;
      if (shown.current === next) return;
      shown.current = next;
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
    // Panning the desk moves the placeholder. Only a scroll of something the panel sits in moves
    // it; a terminal or a list scrolling doesn't. A burst of them folds into one frame.
    let frame = 0;
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !event.target.contains(node)) return;
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
      shown.current = null;
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
        fail(error, t("code.urlFailed"));
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
          aria-label={t("dock.address")}
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
