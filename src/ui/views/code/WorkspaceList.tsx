import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, FileDiff, FolderOpen, FolderPlus, FolderTree, GitBranch, Laptop, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import type { SyncShare, Workspace } from "../../../shared/api.js";
import { tildify } from "../../../shared/text.js";
import { call, useAppInfo, useLive, useOrchestrator, useSync, useTasks, useWorkspaceStatus } from "../../api.js";
import { useAttention, usePtyAttention } from "../../attention.js";
import { ListTools, NoMatch, PickMark, useSelection, viewMenu, viewTipText, toolsWanted, type ViewChip } from "../../components/ListTools.js";
import { SidePanel, StripItem } from "../../components/SidePanel.js";
import { SyncNotices } from "../../components/SyncNotices.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Input, Menu, MenuButton, Modal, Popover, type MenuItem } from "../../components/ui.js";
import { workspaceMark, WorkspaceState } from "../../components/WorkspaceState.js";
import { useT } from "../../i18n/index.js";
import { useAction, useNav } from "../../state.js";
import { isShortcut } from "../../shortcuts.js";
import {
  activityTime,
  DEFAULT_WORKSPACE_VIEW,
  FILTERS,
  filterCounts,
  groupWorkspaces,
  isDefaultWorkspaceView,
  leafFolder,
  loadWorkspaceView,
  SORTS,
  saveWorkspaceView,
  toggleFilter,
  viewWorkspaces,
  type WorkspaceFacts,
  type WorkspaceFilter,
  type WorkspaceSort,
  type WorkspaceView,
} from "../../workspace-view.js";
import { shareLine, SyncDialog } from "./SyncDialog.js";

const WORKSPACE_MIME = "application/x-vibeforge-workspace";

interface CopyReview {
  name: string;
  open: () => void;
}

/**
 * Code's list of workspaces: pick one, drag to reorder, double-click or F2 to rename, ⋯ for the rest.
 * Above it, a search, a composable filter/sort/group menu, active view pills, and Select to remove several.
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
  const ptyAttention = usePtyAttention();
  const workspaceStatus = useWorkspaceStatus();
  const statuses = workspaceStatus.data;
  const copies = useOrchestrator().data?.copies ?? [];
  const tasks = useTasks().data ?? [];
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
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));

  /** A Viby copy or isolated task copy waiting for review on this workspace. */
  const copyReviewFor = (workspaceId: string): CopyReview | null => {
    const ownCopy = copies.find((copy) => copy.openedWorkspaceId === workspaceId);
    if (ownCopy) return { name: ownCopy.name, open: () => go({ view: "orchestrator", copyId: ownCopy.id }) };
    const sourceCopy = copies.find((copy) => (!copy.openedWorkspaceId || !workspaceIds.has(copy.openedWorkspaceId)) && copy.workspaceId === workspaceId);
    if (sourceCopy) return { name: sourceCopy.name, open: () => go({ view: "orchestrator", copyId: sourceCopy.id }) };
    const taskCopy = tasks.find((task) => task.workspaceId === workspaceId && task.status === "review" && Boolean(task.copy));
    if (taskCopy) return { name: taskCopy.title, open: () => go({ view: "tasks", taskId: taskCopy.id }) };
    return null;
  };

  const activityOf = (workspaceId: string): number => {
    const status = statuses?.[workspaceId];
    let latest = Math.max(activityTime(status?.lastRunAt), activityTime(status?.lastCommitAt));
    for (const session of live) {
      if (session.workspaceId !== workspaceId) continue;
      latest = Math.max(latest, activityTime(session.quietAt), activityTime(session.cliSince), activityTime(session.startedAt));
    }
    for (const mark of ptyAttention.values()) {
      if (mark.workspaceId === workspaceId) latest = Math.max(latest, activityTime(mark.since));
    }
    for (const copy of copies) {
      if (copy.openedWorkspaceId === workspaceId || copy.workspaceId === workspaceId) latest = Math.max(latest, activityTime(copy.at));
    }
    for (const task of tasks) {
      if (task.workspaceId !== workspaceId) continue;
      latest = Math.max(latest, activityTime(task.updatedAt), activityTime(task.lastRun?.endedAt), activityTime(task.lastRun?.startedAt));
    }
    return latest;
  };

  // ------------------------------------------------ search, filter, sort, group, select
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<WorkspaceView>(loadWorkspaceView);
  const setView = (next: Partial<WorkspaceView>) => {
    const merged = { ...view, ...next };
    setViewState(merged);
    saveWorkspaceView(merged);
  };
  const [removing, setRemoving] = useState(false);
  const factsCache = new Map<string, WorkspaceFacts>();
  const facts = (workspace: Workspace): WorkspaceFacts => {
    const cached = factsCache.get(workspace.id);
    if (cached) return cached;
    const sessions = live.filter((session) => session.workspaceId === workspace.id);
    const status = statuses?.[workspace.id];
    const ownCopy = copies.find((copy) => copy.openedWorkspaceId === workspace.id);
    const computed: WorkspaceFacts = {
      name: workspace.name,
      path: tildify(workspace.path, home),
      open: sessions.length > 0,
      working: sessions.some((session) => Boolean(session.working)),
      waiting: attention.get(workspace.id) === "waiting",
      review: copyReviewFor(workspace.id) !== null,
      synced: shareOf(workspace.id) !== null,
      git: status?.git ?? Boolean(ownCopy),
      branch: status?.branch ?? ownCopy?.branch ?? null,
      dirty: status?.dirty ?? 0,
      ahead: status?.ahead ?? 0,
      activityAt: activityOf(workspace.id),
    };
    factsCache.set(workspace.id, computed);
    return computed;
  };

  const hasQuery = query.trim() !== "";
  const hasFilters = view.filters.length > 0;
  const narrowed = hasQuery || hasFilters;
  const viewChanged = !isDefaultWorkspaceView(view);
  const groups = groupWorkspaces(workspaces, facts, view, query, t.language);
  const shown = groups.flatMap((group) => group.items);
  const selection = useSelection(shown, (workspace) => workspace.id);
  const selecting = selection.selecting;
  const counts = filterCounts(workspaces, facts, view.filters, query);
  // Folded to its strip there is no search or filter to see, so the strip only follows the sort and grouping.
  const stripped = view.sort === "manual" && view.group === "none" ? workspaces : viewWorkspaces(workspaces, facts, { ...view, filters: [] }, "", t.language);
  // Dragging moves a workspace in your own order, so it's there only while the list shows all of it flat that way.
  const canDrag = !narrowed && view.sort === "manual" && view.group === "none" && !selecting;
  // Only what is on screen gets removed: a pick that a new search hid stays picked but out of it.
  const picked = selection.picked;
  const toggle = selection.toggle;
  const removePicked = async () => {
    setRemoving(true);
    try {
      if (await onRemove(picked)) selection.setSelecting(false);
    } finally {
      setRemoving(false);
    }
  };

  const filterLabels: Record<WorkspaceFilter, string> = {
    open: t("code.filter.open"),
    working: t("code.filter.working"),
    waiting: t("code.filter.waiting"),
    review: t("code.filter.review"),
    dirty: t("code.filter.dirty"),
    synced: t("code.filter.synced"),
  };
  const sortLabels: Record<WorkspaceSort, string> = {
    manual: t("code.sort.manual"),
    name: t("code.sort.name"),
    parent: t("code.sort.parent"),
    recent: t("code.sort.recent"),
    changes: t("code.sort.changes"),
  };
  const sortShortLabels: Record<Exclude<WorkspaceSort, "manual">, string> = {
    name: t("code.sortShort.name"),
    parent: t("code.sortShort.parent"),
    recent: t("code.sortShort.recent"),
    changes: t("code.sortShort.changes"),
  };

  const filterOptions = FILTERS.map((filter) => ({ id: filter, label: filterLabels[filter] }));
  const viewItems = viewMenu(t, {
    filters: filterOptions,
    active: view.filters,
    counts,
    onFilters: (filters) => setView({ filters }),
    sorts: SORTS.map((sort) => ({ id: sort, label: sortLabels[sort] })),
    sort: view.sort,
    onSort: (sort) => setView({ sort }),
    more: [
      "sep",
      { heading: t("code.view.groupHeading") },
      {
        label: t("code.group.parent"),
        role: "menuitemcheckbox",
        checked: view.group === "parent",
        keepOpen: true,
        onSelect: () => setView({ group: view.group === "parent" ? "none" : "parent" }),
      },
    ],
    changed: viewChanged,
    onReset: () => setView(DEFAULT_WORKSPACE_VIEW),
  });
  const chips: ViewChip[] = [
    ...view.filters.map((filter) => ({ key: filter, label: filterLabels[filter], accent: true, onRemove: () => setView({ filters: toggleFilter(view.filters, filter) }) })),
    ...(view.sort !== "manual" ? [{ key: "__sort", label: sortShortLabels[view.sort], icon: ArrowUpDown, onRemove: () => setView({ sort: "manual" }) }] : []),
    ...(view.group === "parent" ? [{ key: "__group", label: t("code.group.parentShort"), icon: FolderTree, onRemove: () => setView({ group: "none" }) }] : []),
  ];

  const viewTip = viewTipText(
    t,
    [...view.filters.map((filter) => filterLabels[filter]), view.sort !== "manual" ? sortLabels[view.sort] : "", view.group === "parent" ? t("code.group.parent") : ""].filter(Boolean),
  );
  const showTools = toolsWanted(workspaces.length, narrowed, viewChanged, selecting);

  const emptyMessage =
    !hasQuery && view.filters.length === 1
      ? t(`code.emptyFilter.${view.filters[0]}`)
      : !hasQuery && view.filters.length > 1
        ? t("code.noMatchFilters")
        : t("code.noMatch");

  const workspaceItems = (workspace: Workspace): Array<MenuItem | "sep"> => [
    { label: t("code.openFolder"), icon: FolderOpen, onSelect: () => void call("app.openPath", workspace.path) },
    { label: t("code.openBranch"), icon: GitBranch, onSelect: () => onBranch(workspace) },
    ...syncItems(workspace),
    { label: t("common.rename"), icon: Pencil, onSelect: () => startRename(workspace.id) },
    "sep",
    { label: t("code.removeWorkspace"), icon: Trash2, danger: true, onSelect: () => void onRemove([workspace]) },
  ];

  let flatIndex = -1;

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
          <ListTools
            query={query}
            onQuery={setQuery}
            placeholder={t("code.search")}
            shown={shown.length}
            total={workspaces.length}
            menu={viewItems}
            changed={viewChanged}
            viewTip={viewTip}
            filterCount={view.filters.length}
            chips={chips}
            selecting={selecting}
            onSelecting={selection.setSelecting}
            selectTip={t("code.selectTip")}
            picked={picked.length}
            onPickAll={selection.pickAll}
            actions={
              <Button size="sm" variant="danger" icon={Trash2} busy={removing} disabled={!picked.length} onClick={() => void removePicked()} tip={t("code.removeSelectedTip")}>
                {t("code.removeSelected")}
              </Button>
            }
          />
        )}
        <div className="list-scroll" onKeyDown={selection.onKeyDown}>
          {workspaces.length === 0 && (
            <div className="faint" style={{ padding: "12px 10px" }}>
              {t("code.addEmpty")}
            </div>
          )}
          {/* Before git has answered every workspace looks clean and branchless: no "nothing matches" (or a button that drops the saved filter) yet. */}
          {workspaces.length > 0 && shown.length === 0 && workspaceStatus.loaded && (
            <NoMatch
              hasQuery={hasQuery}
              filters={view.filters.map((filter) => filterLabels[filter])}
              message={emptyMessage}
              onClear={() => {
                if (hasQuery) setQuery("");
                if (hasFilters) setView({ filters: [] });
              }}
            />
          )}
          {groups.map((group) => (
            <Fragment key={group.folder || "__all__"}>
              {view.group === "parent" && (
                <div className="workspace-group">
                  <FolderOpen size={11} style={{ flex: "none" }} />
                  <span className="mono truncate grow">{group.folder}</span>
                  <span className="mono">{group.items.length}</span>
                </div>
              )}
              {group.items.map((workspace) => {
                flatIndex += 1;
                const index = flatIndex;
                const known = facts(workspace);
                const leaf = leafFolder(known.path);
                const subLine =
                  view.group === "parent"
                    ? leaf !== workspace.name
                      ? [leaf, known.branch].filter(Boolean).join(" · ")
                      : (known.branch ?? leaf)
                    : known.path;
                const isPicked = selection.isPicked(workspace.id);
                const over = dragWorkspace && dragWorkspace.id !== workspace.id ? dragWorkspace.over : null;
                return (
                  <div
                    key={workspace.id}
                    className={`row workspace-row${attention.get(workspace.id) === "waiting" ? " needs-you" : ""}${dragWorkspace?.id === workspace.id ? " is-dragging" : ""}${over === index ? " drop-before" : ""}${over === index + 1 ? " drop-after" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-current={!selecting && workspace.id === currentId ? "true" : undefined}
                    aria-pressed={selecting ? isPicked : undefined}
                    draggable={canDrag && renaming !== workspace.id}
                    onClick={() => (selecting ? toggle(workspace.id) : onSelect(workspace))}
                    onDoubleClick={() => {
                      if (!selecting) startRename(workspace.id);
                    }}
                    onKeyDown={(event) => {
                      if (selecting) {
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
                      if (!selecting) setWorkspaceMenu({ workspace, anchor: event.currentTarget });
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
                    {selecting ? <PickMark picked={isPicked} /> : <FolderOpen size={15} className="accent-text" style={{ flex: "none" }} />}
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
                      <span className="row-sub truncate mono">{subLine}</span>
                    </span>
                    <span className="workspace-marks">
                      <DirtyMark dirty={known.dirty ?? 0} branch={known.branch ?? null} />
                      <ReviewMark review={copyReviewFor(workspace.id)} />
                      <SyncMark share={shareOf(workspace.id)} onOpen={(share) => setSyncing({ workspaceId: workspace.id, machineId: share.machineId })} />
                      <WorkspaceState mark={workspaceMark(workspace.id, live, attention)} count={liveCount(workspace.id)} />
                    </span>
                    {!selecting && (
                      <span className="row-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                        <MenuButton size="sm" variant="ghost" icon={MoreHorizontal} title={t("code.workspaceActions")} items={workspaceItems(workspace)} />
                      </span>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
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

/** Quiet count of uncommitted files in a workspace's git checkout; hidden when clean. */
function DirtyMark({ dirty, branch }: { dirty: number; branch: string | null }) {
  const t = useT();
  if (dirty <= 0) return null;
  const tip = branch ? t.count("code.dirtyBranchTip", dirty, { branch, count: dirty }) : t.count("code.dirtyTip", dirty, { count: dirty });
  return (
    <span className="git-dirty-mark" role="img" aria-label={tip} {...tipProps(tip)}>
      ±{dirty}
    </span>
  );
}

/** Mark on a workspace that is (or holds) a copy waiting for review; clicking opens its diff sheet. */
function ReviewMark({ review }: { review: CopyReview | null }) {
  const t = useT();
  if (!review) return null;
  const tip = t("code.reviewCopyTip", { name: review.name });
  return (
    <button
      type="button"
      className="review-mark"
      aria-label={tip}
      {...tipProps(tip)}
      onClick={(event) => {
        event.stopPropagation();
        review.open();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <FileDiff size={13} />
    </button>
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
