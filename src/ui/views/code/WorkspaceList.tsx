import { ArrowLeft, ArrowLeftRight, ArrowRight, FolderOpen, FolderPlus, GitBranch, Laptop, ListChecks, ListFilter, MoreHorizontal, Pencil, Search, Square, SquareCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { SyncShare, Workspace } from "../../../shared/api.js";
import { tildify } from "../../../shared/text.js";
import { call, useAppInfo, useLive, useSync } from "../../api.js";
import { useAttention } from "../../attention.js";
import { SidePanel, StripItem } from "../../components/SidePanel.js";
import { SyncNotices } from "../../components/SyncNotices.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Input, Menu, MenuButton, Modal, Popover, type MenuItem } from "../../components/ui.js";
import { workspaceMark, WorkspaceState } from "../../components/WorkspaceState.js";
import { useT } from "../../i18n/index.js";
import { useAction, useNav } from "../../state.js";
import { isShortcut } from "../../shortcuts.js";
import { DEFAULT_WORKSPACE_VIEW, loadWorkspaceView, saveWorkspaceView, viewWorkspaces, type WorkspaceFacts, type WorkspaceFilter, type WorkspaceSort, type WorkspaceView } from "../../workspace-view.js";
import { shareLine, SyncDialog } from "./SyncDialog.js";

const WORKSPACE_MIME = "application/x-vibeforge-workspace";

/**
 * Code's list of workspaces: pick one, drag to reorder, double-click or F2 to rename, ⋯ for the rest.
 * Above it, a search, a filter and sort menu, and Select, which picks several to remove at once.
 */
export function WorkspaceList({
  workspaces,
  currentId,
  onSelect,
  onAdd,
  onRemove,
  onBranch,
}: {
  workspaces: Workspace[];
  currentId: string | null;
  onSelect: (workspace: Workspace) => void;
  onAdd: () => void;
  /** Remove these (one, or several picked), after asking; true once they're gone. */
  onRemove: (workspaces: Workspace[]) => Promise<boolean>;
  /** Open a branch of it beside it, as its own workspace. */
  onBranch: (workspace: Workspace) => void;
}) {
  const t = useT();
  const live = useLive().data ?? [];
  const attention = useAttention();
  const home = useAppInfo().data?.home ?? "";
  const [renaming, setRenaming] = useState<string | null>(null);
  const skipBlurRef = useRef(false);
  const startRename = (id: string) => {
    skipBlurRef.current = false;
    setRenaming(id);
  };
  const [dragWorkspace, setDragWorkspace] = useState<{ id: string; over: number | null } | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{ workspace: Workspace; anchor: HTMLElement } | null>(null);
  const sync = useSync().data;
  const { go } = useNav();
  /** The workspace whose sync is being set up or looked at, and the machine it is with. */
  const [syncing, setSyncing] = useState<{ workspaceId: string; machineId: string } | null>(null);
  /** With the list folded to its strip, what another machine asks is behind a mark there. */
  const [asksOpen, setAsksOpen] = useState(false);
  const asks = (sync?.requests.length ?? 0) + (sync?.offers.length ?? 0);
  const shareOf = (workspaceId: string) => sync?.shares.find((share) => share.workspaceId === workspaceId) ?? null;
  /** Sync in a workspace's menu: its share when it has one, else each paired machine, else the way to set sync up. */
  const syncItems = (workspace: Workspace): MenuItem[] => {
    const share = shareOf(workspace.id);
    if (share) return [{ label: t("sync.menuSettings", { machine: share.machineName }), icon: Laptop, onSelect: () => setSyncing({ workspaceId: workspace.id, machineId: share.machineId }) }];
    if (sync?.running && sync.machines.length) {
      return sync.machines.map((machine) => ({ label: t("sync.menu", { machine: machine.name }), icon: Laptop, onSelect: () => setSyncing({ workspaceId: workspace.id, machineId: machine.id }) }));
    }
    return [{ label: t("sync.menuSetup"), icon: Laptop, onSelect: () => go({ view: "settings", section: "sync" }) }];
  };

  const [renameWorkspace] = useAction(async (workspace: Workspace, name: string) => {
    if (name.trim() && name.trim() !== workspace.name) await call("workspaces.update", workspace.id, { name: name.trim() });
    setRenaming(null);
  }, t("code.renameFailed"));

  const [moveWorkspace] = useAction(async (id: string, toIndex: number) => {
    await call("workspaces.move", id, toIndex);
  }, t("code.moveFailed"));

  const liveCount = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;

  // ------------------------------------------------ search, filter, sort, select
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<WorkspaceView>(loadWorkspaceView);
  const setView = (next: Partial<WorkspaceView>) => {
    const merged = { ...view, ...next };
    setViewState(merged);
    saveWorkspaceView(merged);
  };
  /** Ids picked while Select is on; null while it's off. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [removing, setRemoving] = useState(false);
  const facts = (workspace: Workspace): WorkspaceFacts => ({
    name: workspace.name,
    path: tildify(workspace.path, home),
    open: liveCount(workspace.id) > 0,
    waiting: attention.get(workspace.id) === "waiting",
    synced: shareOf(workspace.id) !== null,
  });
  const narrowed = query.trim() !== "" || view.filter !== "all";
  const shown = viewWorkspaces(workspaces, facts, view, query, t.language);
  // Folded to its strip there is no search or filter to see, so the strip only follows the sort.
  const stripped = view.sort === "manual" ? workspaces : viewWorkspaces(workspaces, facts, { ...view, filter: "all" }, "", t.language);
  // Dragging moves a workspace in your own order, so it's there only while the list shows all of it that way.
  const canDrag = !narrowed && view.sort === "manual" && !selected;
  // Only what is on screen gets removed: a pick that a new search hid stays picked but out of it.
  const picked = selected ? shown.filter((workspace) => selected.has(workspace.id)) : [];
  const toggle = (id: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const removePicked = async () => {
    setRemoving(true);
    try {
      if (await onRemove(picked)) setSelected(null);
    } finally {
      setRemoving(false);
    }
  };
  const filterLabels: Record<WorkspaceFilter, string> = {
    all: t("code.filter.all"),
    open: t("code.filter.open"),
    waiting: t("code.filter.waiting"),
    synced: t("code.filter.synced"),
  };
  const sortLabels: Record<WorkspaceSort, string> = { manual: t("code.sort.manual"), name: t("code.sort.name") };
  const viewItems: Array<MenuItem | "sep"> = [
    ...(Object.keys(filterLabels) as WorkspaceFilter[]).map((filter) => ({ label: filterLabels[filter], checked: view.filter === filter, onSelect: () => setView({ filter }) })),
    "sep",
    ...(Object.keys(sortLabels) as WorkspaceSort[]).map((sort) => ({ label: sortLabels[sort], checked: view.sort === sort, onSelect: () => setView({ sort }) })),
  ];
  const viewChanged = view.filter !== DEFAULT_WORKSPACE_VIEW.filter || view.sort !== DEFAULT_WORKSPACE_VIEW.sort;
  const showTools = workspaces.length > 1 || narrowed || viewChanged || selected !== null;
  const workspaceItems = (workspace: Workspace): Array<MenuItem | "sep"> => [
    { label: t("code.openFolder"), icon: FolderOpen, onSelect: () => void call("app.openPath", workspace.path) },
    { label: t("code.openBranch"), icon: GitBranch, onSelect: () => onBranch(workspace) },
    ...syncItems(workspace),
    { label: t("common.rename"), icon: Pencil, onSelect: () => startRename(workspace.id) },
    "sep",
    { label: t("code.removeWorkspace"), icon: Trash2, danger: true, onSelect: () => void onRemove([workspace]) },
  ];

  return (
    <>
    <SidePanel
      id="workspaces"
      title={t("code.workspaces")}
      defaultWidth={250}
      actions={
        <Button size="sm" icon={FolderPlus} onClick={onAdd} tip={t("code.addTip")}>
          {t("code.add")}
        </Button>
      }
      strip={
        <>
          <StripItem label={t("code.addStrip")} onClick={onAdd}>
            <FolderPlus size={16} />
          </StripItem>
          {asks > 0 && (
            <StripItem label={t("sync.asks")} onClick={() => setAsksOpen(true)} badge={<span className="ws-state waiting in-strip" />}>
              <Laptop size={16} className="accent-text" />
            </StripItem>
          )}
          {stripped.map((workspace) => (
            <StripItem
              key={workspace.id}
              label={`${workspace.name} — ${tildify(workspace.path, home)}`}
              selected={workspace.id === currentId}
              onClick={() => onSelect(workspace)}
              badge={<WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveCount(workspace.id)} strip />}
            >
              <span className="strip-initials">{workspace.name.slice(0, 2).toUpperCase()}</span>
            </StripItem>
          ))}
        </>
      }
    >
      <SyncNotices view={sync} />
      {showTools && (
        <div className="workspace-tools">
          <div className="hstack" style={{ gap: 4 }}>
            <div className="hstack grow" style={{ position: "relative", minWidth: 0 }}>
              <Search size={13} className="faint" style={{ position: "absolute", left: 9, pointerEvents: "none" }} />
              <Input
                placeholder={t("code.search")}
                aria-label={t("code.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (query) setQuery("");
                  else event.currentTarget.blur();
                }}
                style={{ paddingLeft: 28 }}
              />
            </div>
            <MenuButton
              size="sm"
              variant="ghost"
              icon={ListFilter}
              className={viewChanged ? "accent-text" : undefined}
              title={viewChanged ? `${t("code.viewTip")}: ${[view.filter !== "all" ? filterLabels[view.filter] : "", view.sort !== "manual" ? sortLabels[view.sort] : ""].filter(Boolean).join(", ")}` : t("code.viewTip")}
              items={viewItems}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={ListChecks}
              pressed={selected !== null}
              className={selected ? "accent-text" : undefined}
              tip={selected ? t("code.selectDone") : t("code.selectTip")}
              onClick={() => setSelected(selected ? null : new Set())}
            />
          </div>
          {selected && (
            <div className="hstack workspace-picking">
              <span className="faint grow" style={{ whiteSpace: "nowrap" }}>{t.count("code.selected", picked.length)}</span>
              <Button size="sm" variant="ghost" disabled={!shown.length || picked.length === shown.length} onClick={() => setSelected(new Set([...selected, ...shown.map((workspace) => workspace.id)]))}>
                {t("code.selectAll")}
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} busy={removing} disabled={!picked.length} onClick={() => void removePicked()} tip={t("code.removeSelectedTip")}>
                {t("code.removeSelected")}
              </Button>
            </div>
          )}
        </div>
      )}
      <div
        className="list-scroll"
        onKeyDown={(event) => {
          if (event.key === "Escape" && selected && !event.defaultPrevented) {
            event.preventDefault();
            setSelected(null);
          }
        }}
      >
        {workspaces.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("code.addEmpty")}</div>}
        {workspaces.length > 0 && shown.length === 0 && (
          <div className="vstack faint" style={{ padding: "12px 10px", gap: 8, alignItems: "flex-start" }}>
            <span>{t("code.noMatch")}</span>
            <Button
              size="sm"
              onClick={() => {
                setQuery("");
                setView({ filter: "all" });
              }}
            >
              {t("code.clearSearch")}
            </Button>
          </div>
        )}
        {shown.map((workspace, index) => {
          const isPicked = selected?.has(workspace.id) ?? false;
          const over = dragWorkspace && dragWorkspace.id !== workspace.id ? dragWorkspace.over : null;
          return (
            <div
              key={workspace.id}
              className={`row workspace-row${attention.get(workspace.id) === "waiting" ? " needs-you" : ""}${dragWorkspace?.id === workspace.id ? " is-dragging" : ""}${over === index ? " drop-before" : ""}${over === index + 1 ? " drop-after" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={!selected && workspace.id === currentId ? "true" : undefined}
              aria-pressed={selected ? isPicked : undefined}
              draggable={canDrag && renaming !== workspace.id}
              onClick={() => (selected ? toggle(workspace.id) : onSelect(workspace))}
              onDoubleClick={() => {
                if (!selected) startRename(workspace.id);
              }}
              onKeyDown={(event) => {
                if (selected) {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle(workspace.id);
                  }
                  return;
                }
                if (event.key === "Enter") onSelect(workspace);
                if (isShortcut("workspace.rename", event)) startRename(workspace.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selected) setWorkspaceMenu({ workspace, anchor: event.currentTarget });
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
              {selected ? (
                isPicked ? <SquareCheck size={15} className="accent-text" style={{ flex: "none" }} /> : <Square size={15} className="faint" style={{ flex: "none" }} />
              ) : (
                <FolderOpen size={15} className="accent-text" style={{ flex: "none" }} />
              )}
              <span className="vstack grow" style={{ gap: 0 }}>
                {renaming === workspace.id ? (
                  <Input
                    autoFocus
                    defaultValue={workspace.name}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onFocus={(event) => {
                      skipBlurRef.current = false;
                      event.target.select();
                    }}
                    onBlur={(event) => {
                      if (skipBlurRef.current) {
                        skipBlurRef.current = false;
                        return;
                      }
                      void renameWorkspace(workspace, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        skipBlurRef.current = true;
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <span className="row-title truncate">{workspace.name}</span>
                )}
                <span className="row-sub truncate mono">{tildify(workspace.path, home)}</span>
              </span>
              <SyncMark share={shareOf(workspace.id)} onOpen={(share) => setSyncing({ workspaceId: workspace.id, machineId: share.machineId })} />
              <WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveCount(workspace.id)} />
              {!selected && <span className="row-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                <MenuButton size="sm" variant="ghost" icon={MoreHorizontal} title={t("code.workspaceActions")} items={workspaceItems(workspace)} />
              </span>}
            </div>
          );
        })}
      </div>
      {workspaceMenu && (
        <Popover anchor={workspaceMenu.anchor} onClose={() => setWorkspaceMenu(null)} align="end">
          <Menu items={workspaceItems(workspaceMenu.workspace)} onClose={() => setWorkspaceMenu(null)} />
        </Popover>
      )}
      {(() => {
        const workspace = syncing && workspaces.find((item) => item.id === syncing.workspaceId);
        return workspace && syncing && sync ? <SyncDialog workspace={workspace} machineId={syncing.machineId} view={sync} onClose={() => setSyncing(null)} /> : null;
      })()}
    </SidePanel>
      {/* Outside the panel: folded to its strip, the panel draws none of what is inside it. */}
      {asksOpen && asks > 0 && (
        <Modal title={t("sync.asks")} icon={Laptop} onClose={() => setAsksOpen(false)}>
          <SyncNotices view={sync} />
        </Modal>
      )}
    </>
  );
}

/**
 * A synced workspace's mark: an arrow for its direction, coloured by how it stands (in sync,
 * syncing, the other machine away, or something to answer). A click opens its sync.
 */
function SyncMark({ share, onOpen }: { share: SyncShare | null; onOpen: (share: SyncShare) => void }) {
  const t = useT();
  if (!share) return null;
  const Icon = share.mode === "send" ? ArrowRight : share.mode === "receive" ? ArrowLeft : ArrowLeftRight;
  // Someone (or some CLI) working over there while this one is open is worth a look, like a conflict.
  const tone = share.state === "error" || share.conflicts ? "warn" : share.peerLive.length ? "busy" : share.state;
  const tip = [shareLine(t, share), share.peerLive.length ? t("sync.peerLive", { machine: share.machineName, what: share.peerLive.join(", ") }) : ""].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      className={`sync-mark ${tone}`}
      aria-label={tip}
      {...tipProps(tip)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(share);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon size={13} />
    </button>
  );
}
