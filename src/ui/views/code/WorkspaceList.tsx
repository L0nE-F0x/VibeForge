import { FolderOpen, FolderPlus, GitBranch, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { Workspace } from "../../../shared/api.js";
import { tildify } from "../../../shared/text.js";
import { call, useAppInfo, useLive } from "../../api.js";
import { useAttention } from "../../attention.js";
import { SidePanel, StripItem } from "../../components/SidePanel.js";
import { Button, Input, Menu, MenuButton, Popover, type MenuItem } from "../../components/ui.js";
import { workspaceMark, WorkspaceState } from "../../components/WorkspaceState.js";
import { useT } from "../../i18n/index.js";
import { useAction } from "../../state.js";
import { isShortcut } from "../../shortcuts.js";

const WORKSPACE_MIME = "application/x-vibeforge-workspace";

/** Code's list of workspaces: pick one, drag to reorder, double-click or F2 to rename, ⋯ for the rest. */
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
  onRemove: (workspace: Workspace) => void;
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

  const [renameWorkspace] = useAction(async (workspace: Workspace, name: string) => {
    if (name.trim() && name.trim() !== workspace.name) await call("workspaces.update", workspace.id, { name: name.trim() });
    setRenaming(null);
  }, t("code.renameFailed"));

  const [moveWorkspace] = useAction(async (id: string, toIndex: number) => {
    await call("workspaces.move", id, toIndex);
  }, t("code.moveFailed"));

  const liveCount = (workspaceId: string) => live.filter((session) => session.workspaceId === workspaceId).length;
  const workspaceItems = (workspace: Workspace): Array<MenuItem | "sep"> => [
    { label: t("code.openFolder"), icon: FolderOpen, onSelect: () => void call("app.openPath", workspace.path) },
    { label: t("code.openBranch"), icon: GitBranch, onSelect: () => onBranch(workspace) },
    { label: t("common.rename"), icon: Pencil, onSelect: () => startRename(workspace.id) },
    "sep",
    { label: t("code.removeWorkspace"), icon: Trash2, danger: true, onSelect: () => onRemove(workspace) },
  ];

  return (
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
          {workspaces.map((workspace) => (
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
              aria-current={workspace.id === currentId ? "true" : undefined}
              draggable={renaming !== workspace.id}
              onClick={() => onSelect(workspace)}
              onDoubleClick={() => startRename(workspace.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSelect(workspace);
                if (isShortcut("workspace.rename", event)) startRename(workspace.id);
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
  );
}
