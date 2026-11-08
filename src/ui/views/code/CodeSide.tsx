import { FolderTree, Globe, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../../../shared/api.js";
import { isDockUrl } from "../../../shared/dock-url.js";
import { call } from "../../api.js";
import { useNarrowStage } from "../../components/SidePanel.js";
import { Button } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { useAction } from "../../state.js";
import { DockPanel } from "./DockPanel.js";
import { FilesPanel } from "./FilesPanel.js";

interface SideState {
  open: boolean;
  tab: "files" | "browser";
  width: number;
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

/** Code's right-hand panel: open or not, which tab, how wide, and the address each workspace's browser shows. */
export function useCodeSide(workspaces: Workspace[]) {
  const t = useT();
  const [side, setSide] = useState(() => readLocal<SideState>("vf.code.side", { open: true, tab: "files", width: 320 }));
  // The address a click or the bar just asked for, shown before the workspace file catches up.
  const [pendingDock, setPendingDock] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => writeLocal("vf.code.side", side), [side]);
  // On a narrow tile the side panel steps aside without forgetting it was open; the button brings it back.
  const narrow = useNarrowStage();
  const [narrowSide, setNarrowSide] = useState(false);
  useEffect(() => {
    if (!narrow) setNarrowSide(false);
  }, [narrow]);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const open = narrow ? narrowSide : side.open;
  const setOpen = (next: boolean) => (narrow ? setNarrowSide(next) : setSide((prev) => ({ ...prev, open: next })));

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
    setSide((prev) => (prev.open && prev.tab === "browser" ? prev : { ...prev, open: true, tab: "browser" }));
    if (narrowRef.current) setNarrowSide(true);
    void setDockUrl(workspaceId, url);
  }

  return {
    side,
    setSide,
    narrow,
    open,
    setOpen,
    /** The address a workspace's browser shows. */
    dockUrl: (workspace: Workspace) => (pendingDock?.id === workspace.id ? pendingDock.url : workspace.dockUrl),
    rememberDock,
    openInBrowser,
    /** A removed workspace's address, if one was on its way. */
    forgetDock: (workspaceId: string) => setPendingDock((prev) => (prev?.id === workspaceId ? null : prev)),
  };
}

/** The panel itself, beside the panes: the workspace's files, or its browser. Drag its edge to resize. */
export function CodeSide({ panel, workspace, active, onInsert }: { panel: CodeSidePanel; workspace: Workspace; active: boolean; onInsert: (path: string) => void }) {
  const t = useT();
  const { side, setSide, narrow } = panel;

  const startResize = (event: React.PointerEvent) => {
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

  return (
    <aside className="side-panel" style={{ width: narrow ? Math.min(side.width, 280) : side.width }}>
      <div className="side-resize" onPointerDown={startResize} />
      <div className="side-tabs">
        <Button size="sm" variant="ghost" icon={FolderTree} pressed={side.tab === "files"} onClick={() => setSide((prev) => ({ ...prev, tab: "files" }))}>
          {t("code.files")}
        </Button>
        <Button size="sm" variant="ghost" icon={Globe} pressed={side.tab === "browser"} onClick={() => setSide((prev) => ({ ...prev, tab: "browser" }))}>
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
