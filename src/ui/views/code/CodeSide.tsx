import { FolderTree, Globe, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../../../shared/api.js";
import { isDockUrl } from "../../../shared/dock-url.js";
import { call } from "../../api.js";
import { useNarrowStage } from "../../components/SidePanel.js";
import { forget, recall, remember } from "../../remember.js";
import { Button } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { useAction } from "../../state.js";
import { DockPanel } from "./DockPanel.js";
import { FilesPanel } from "./FilesPanel.js";

type SideTab = "files" | "browser";

/** Whether a workspace's side panel is open, and on which tab. Each workspace keeps its own. */
interface SidePlace {
  open: boolean;
  tab: SideTab;
}

/** The panel's width, the same for every workspace. Before 3.0.3 this also held one open/tab for all of them. */
interface SideState {
  width: number;
  open?: boolean;
  tab?: SideTab;
}

const SIDE_SCOPE = "code.side";

function isSidePlace(value: unknown): value is SidePlace {
  const place = value as SidePlace | null;
  return Boolean(place && typeof place.open === "boolean" && (place.tab === "files" || place.tab === "browser"));
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

export type CodeSidePanel = ReturnType<typeof useCodeSide>;

/**
 * Code's right-hand panel: open or not and which tab (each workspace its own), how wide (one for
 * all), and the address each workspace's browser shows.
 */
export function useCodeSide(workspaces: Workspace[], currentId: string | null) {
  const t = useT();
  const [saved] = useState(() => readLocal<SideState>("vf.code.side", { width: 320 }));
  const [width, setWidth] = useState(() => (typeof saved.width === "number" ? saved.width : 320));
  // A workspace never seen since 3.0.3 starts as the one shared panel was left, so an update moves nothing.
  const fallback: SidePlace = { open: saved.open ?? true, tab: saved.tab === "browser" ? "browser" : "files" };
  const [, setVersion] = useState(0);
  const placeOf = (workspaceId: string | null): SidePlace => (workspaceId ? (recall(SIDE_SCOPE, workspaceId, isSidePlace) ?? fallback) : fallback);
  const setPlace = (workspaceId: string | null, patch: Partial<SidePlace>) => {
    if (!workspaceId) return;
    const prev = placeOf(workspaceId);
    remember(SIDE_SCOPE, workspaceId, { ...prev, ...patch });
    setVersion((version) => version + 1);
  };
  const place = placeOf(currentId);
  // The address a click or the bar just asked for, shown before the workspace file catches up.
  const [pendingDock, setPendingDock] = useState<{ id: string; url: string } | null>(null);

  // Saved once a drag of its edge ends, not on every step of it.
  const resizing = useRef(false);
  const [dragsDone, setDragsDone] = useState(0);
  useEffect(() => {
    if (!resizing.current) writeLocal("vf.code.side", { ...saved, width });
  }, [saved, width, dragsDone]);
  // On a narrow tile the side panel steps aside without forgetting it was open; the button brings it back.
  const narrow = useNarrowStage();
  const [narrowSide, setNarrowSide] = useState(false);
  useEffect(() => {
    if (!narrow) setNarrowSide(false);
  }, [narrow]);
  // Another workspace on a narrow tile starts with its panel tucked away again.
  useEffect(() => setNarrowSide(false), [currentId]);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const open = narrow ? narrowSide : place.open;
  /** Open or close the panel, for the workspace shown or the one named. */
  const setOpen = (next: boolean, workspaceId: string | null = currentId) => {
    if (narrow && workspaceId === currentId) setNarrowSide(next);
    else setPlace(workspaceId, { open: next });
  };
  /** Switch its tab, for the workspace shown or the one named. */
  const setTab = (tab: SideTab, workspaceId: string | null = currentId) => setPlace(workspaceId, { tab });

  useEffect(() => {
    if (!pendingDock) return;
    const saved = workspaces.find((item) => item.id === pendingDock.id)?.dockUrl ?? "";
    if (saved === pendingDock.url) setPendingDock(null);
  }, [workspaces, pendingDock]);

  const [setDockUrl] = useAction(async (workspaceId: string, url: string) => {
    await call("workspaces.update", workspaceId, { dockUrl: url });
  }, t("code.urlFailed"));

  /** The address bar committed. The id is the workspace the bar was editing. */
  function rememberDock(workspaceId: string, url: string) {
    setPendingDock({ id: workspaceId, url });
    // Stop a hidden page from writing its address back over a bar the person just cleared.
    if (!url) void call("dock.show", { x: 0, y: 0, width: 0, height: 0 }, "", workspaceId).catch(() => undefined);
    void setDockUrl(workspaceId, url);
  }

  /** A link in this workspace's terminal: open its own browser on that address. */
  function openInBrowser(workspaceId: string, url: string) {
    if (!isDockUrl(url)) {
      void call("app.openExternal", url);
      return;
    }
    setPendingDock({ id: workspaceId, url });
    setPlace(workspaceId, { open: true, tab: "browser" });
    if (narrowRef.current && workspaceId === currentId) setNarrowSide(true);
    void setDockUrl(workspaceId, url);
  }

  return {
    /** The shown workspace's tab, and the panel's width. */
    side: { tab: place.tab, width },
    setTab,
    setWidth,
    /** A drag of its edge ended: keep the width it ended on. */
    endResize: () => {
      resizing.current = false;
      setDragsDone((count) => count + 1);
    },
    /** True while its edge is being dragged: the width is saved once the drag ends. */
    resizing,
    narrow,
    open,
    setOpen,
    /** The address a workspace's browser shows. */
    dockUrl: (workspace: Workspace) => (pendingDock?.id === workspace.id ? pendingDock.url : workspace.dockUrl),
    rememberDock,
    openInBrowser,
    /** A removed workspace: drop its address, if one was on its way, and how its panel was left. */
    forgetDock: (workspaceId: string) => {
      setPendingDock((prev) => (prev?.id === workspaceId ? null : prev));
      forget(SIDE_SCOPE, workspaceId);
    },
  };
}

/** The panel itself, beside the panes: the workspace's files, or its browser. Drag its edge to resize. */
export function CodeSide({ panel, workspace, active, onInsert }: { panel: CodeSidePanel; workspace: Workspace; active: boolean; onInsert: (path: string) => void }) {
  const t = useT();
  const { side, setTab, setWidth, narrow } = panel;

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side.width;
    const target = event.currentTarget as HTMLElement;
    target.classList.add("dragging");
    panel.resizing.current = true;
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(900, Math.max(220, startWidth - (moveEvent.clientX - startX)));
      setWidth(width);
    };
    const up = () => {
      target.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // Now the width is kept.
      panel.endResize();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <aside className="side-panel" style={{ width: narrow ? Math.min(side.width, 280) : side.width }}>
      <div className="side-resize" onPointerDown={startResize} />
      <div className="side-tabs">
        <Button size="sm" variant="ghost" icon={FolderTree} pressed={side.tab === "files"} onClick={() => setTab("files")}>
          {t("code.files")}
        </Button>
        <Button size="sm" variant="ghost" icon={Globe} pressed={side.tab === "browser"} onClick={() => setTab("browser")}>
          {t("code.browser")}
        </Button>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={X} tip={t("code.hideSide")} onClick={() => panel.setOpen(false)} />
      </div>
      {side.tab === "files" ? (
        <FilesPanel root={workspace.path} onInsert={onInsert} />
      ) : (
        <DockPanel key={workspace.id} workspaceId={workspace.id} url={panel.dockUrl(workspace)} onUrl={panel.rememberDock} visible={active && panel.open && side.tab === "browser"} />
      )}
    </aside>
  );
}
