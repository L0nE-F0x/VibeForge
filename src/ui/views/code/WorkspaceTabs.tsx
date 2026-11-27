import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import type { Workspace, WorkspaceCategory } from "../../../shared/api.js";
import { call } from "../../api.js";
import { tipProps } from "../../components/Tooltip.js";
import { cx, Input, Menu, Popover, type MenuEntry } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { isShortcut } from "../../shortcuts.js";
import { useAction, useDeleted } from "../../state.js";

export const WORKSPACE_MIME = "application/x-vibeforge-workspace";
export const WORKSPACE_CATEGORY_MIME = "application/x-vibeforge-workspace-category";

/**
 * Convert a visual insertion slot `0..length` among custom category tabs (after the pinned All tab)
 * into the `toIndex` expected by `workspaces.moveCategory`, or `null` when the drop is a no-op.
 */
export function categoryReorderTarget(fromIndex: number, overSlot: number, length: number): number | null {
  if (fromIndex < 0 || fromIndex >= length || length < 2) return null;
  const clamped = Math.max(0, Math.min(overSlot, length));
  const toIndex = clamped > fromIndex ? clamped - 1 : clamped;
  return toIndex === fromIndex ? null : toIndex;
}

/**
 * Assign or move a workspace onto a category tab: dragging out of a custom tab moves it unless
 * `copy` is true (holding Alt), while dragging from All adds membership to the target tab.
 */
export async function dropWorkspaceOnCategory(
  workspace: Workspace,
  targetCategoryId: string,
  fromCategoryId: string | null,
  copy = false,
): Promise<void> {
  if (!copy && fromCategoryId && fromCategoryId !== targetCategoryId) {
    const nextCats = [...(workspace.categories ?? []).filter((id) => id !== fromCategoryId), targetCategoryId];
    await call("workspaces.update", workspace.id, { categories: nextCats });
  } else {
    await call("workspaces.setCategory", [workspace.id], targetCategoryId, true);
  }
}

export interface WorkspaceTabsProps {
  categories: readonly WorkspaceCategory[];
  workspaces: readonly Workspace[];
  activeCategory: string | null;
  onSelect: (categoryId: string | null) => void;
  /** External trigger to open the "+ new category" input and optionally assign workspaces on creation. */
  createRequest?: { key: number; workspaceIds: string[] } | null;
  onCreatedFor?: () => void;
  draggingWorkspace?: boolean;
  onDropWorkspace?: (workspaceId: string, targetCategoryId: string, copy?: boolean) => void;
}

/**
 * Sleek horizontal tab strip underneath the workspace search bar: always keeps the stock "All" tab
 * first, lets you add/rename/reorder/delete custom category tabs (without deleting workspaces),
 * accepts workspace drops to categorize them, and shows side-pointing scroll arrows on overflow.
 */
export function WorkspaceTabs({
  categories,
  workspaces,
  activeCategory,
  onSelect,
  createRequest,
  onCreatedFor,
  draggingWorkspace = false,
  onDropWorkspace,
}: WorkspaceTabsProps) {
  const t = useT();
  const deleted = useDeleted();
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ any: false, left: false, right: false });
  const [adding, setAdding] = useState(false);
  const [pendingWorkspaceIds, setPendingWorkspaceIds] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [dragCategory, setDragCategory] = useState<{ id: string; over: number | null } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ category: WorkspaceCategory; index: number; anchor: HTMLElement } | null>(null);
  const skipRenameBlurRef = useRef(false);
  const skipAddBlurRef = useRef(false);
  const handledCreateKeyRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const any = el.scrollWidth > el.clientWidth + 1;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.any === any && prev.left === left && prev.right === right ? prev : { any, left, right }));
  }, []);

  useLayoutEffect(measure, [measure, categories, workspaces.length, adding, renaming]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (!draggingWorkspace) setDropOver(null);
  }, [draggingWorkspace]);

  // Ensure the active tab stays visible when selected from keyboard or after creation.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const key = activeCategory ?? "__all__";
    const target = track.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(key)}"]`);
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeCategory, categories.length]);

  useEffect(() => {
    if (!createRequest || createRequest.key === handledCreateKeyRef.current) return;
    handledCreateKeyRef.current = createRequest.key;
    setPendingWorkspaceIds(createRequest.workspaceIds);
    setRenaming(null);
    setAdding(true);
  }, [createRequest]);

  useEffect(() => {
    if (!adding) return;
    const track = trackRef.current;
    if (track) track.scrollLeft = track.scrollWidth;
  }, [adding]);

  const [createCategory] = useAction(async (raw: string, assignIds: readonly string[]) => {
    const { category } = await call("workspaces.addCategory", raw);
    if (assignIds.length) await call("workspaces.setCategory", [...assignIds], category.id, true);
    onSelect(category.id);
    if (assignIds.length) onCreatedFor?.();
  }, t("code.categoryAddFailed"));

  const [renameCategory] = useAction(async (id: string, name: string) => {
    await call("workspaces.renameCategory", id, name);
  }, t("code.renameFailed"));

  const [moveCategory] = useAction(async (id: string, toIndex: number) => {
    await call("workspaces.moveCategory", id, toIndex);
  }, t("code.moveFailed"));

  const [deleteCategory] = useAction(async (id: string) => call("workspaces.deleteCategory", id), t("code.categoryDeleteFailed"));

  const startAdd = () => {
    skipAddBlurRef.current = false;
    setPendingWorkspaceIds([]);
    setRenaming(null);
    setAdding(true);
  };

  const cancelAdd = () => {
    setAdding(false);
    setPendingWorkspaceIds([]);
  };

  const commitAdd = async (raw: string) => {
    const clean = raw.replace(/\s+/g, " ").trim();
    const ids = pendingWorkspaceIds;
    setAdding(false);
    setPendingWorkspaceIds([]);
    if (!clean) return;
    await createCategory(clean, ids);
  };

  const startRename = (id: string) => {
    skipRenameBlurRef.current = false;
    setAdding(false);
    setRenaming(id);
  };

  const commitRename = async (category: WorkspaceCategory, raw: string) => {
    const clean = raw.replace(/\s+/g, " ").trim();
    setRenaming(null);
    if (!clean || clean === category.name) return;
    await renameCategory(category.id, clean);
  };

  const removeCategory = async (category: WorkspaceCategory) => {
    const res = await deleteCategory(category.id);
    if (!res) return;
    if (activeCategory === category.id) onSelect(null);
    deleted(t("code.categoryDeleted", { name: category.name }), res);
  };

  const scrollByDir = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const step = Math.max(96, Math.round(el.clientWidth * 0.7));
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  const onTrackWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el || !overflow.any) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && event.deltaY !== 0) {
      el.scrollLeft += event.deltaY;
      measure();
    }
  };

  const onTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const values: Array<string | null> = [null, ...categories.map((cat) => cat.id)];
    const at = values.indexOf(activeCategory);
    const to =
      event.key === "ArrowRight"
        ? Math.min(values.length - 1, at + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? values.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    if (to === at) return;
    const next = values[to];
    onSelect(next);
    const btn = trackRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next ?? "__all__")}"]`);
    btn?.focus();
    btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const categoryMenuItems = (category: WorkspaceCategory, index: number): MenuEntry[] => [
    { label: t("common.rename"), icon: Pencil, onSelect: () => startRename(category.id) },
    ...(index > 0 ? [{ label: t("code.categoryMoveLeft"), icon: ArrowLeft, onSelect: () => void moveCategory(category.id, index - 1) }] : []),
    ...(index < categories.length - 1 ? [{ label: t("code.categoryMoveRight"), icon: ArrowRight, onSelect: () => void moveCategory(category.id, index + 1) }] : []),
    "sep",
    { label: t("code.categoryDelete"), icon: Trash2, danger: true, onSelect: () => void removeCategory(category) },
  ];

  const countIn = (categoryId: string) => workspaces.filter((workspace) => workspace.categories?.includes(categoryId)).length;

  const slotAtClientX = (clientX: number, target: EventTarget | null): number => {
    const tabs = [...(trackRef.current?.querySelectorAll<HTMLElement>(".ws-tab[data-category-index]") ?? [])];
    if (tabs.length > 0 && tabs.some((tab) => tab.getBoundingClientRect().width > 0)) {
      for (let i = 0; i < tabs.length; i += 1) {
        const rect = tabs[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          const idx = Number(tabs[i].dataset.categoryIndex);
          return Number.isFinite(idx) ? idx : i;
        }
      }
      return categories.length;
    }
    const el = target as HTMLElement | null;
    const tab = el?.closest<HTMLElement>("[data-category-index]");
    if (tab) return Number(tab.dataset.categoryIndex) || 0;
    if (el?.closest('[data-tab-id="__all__"]')) return 0;
    return categories.length;
  };

  const dragFrom = dragCategory ? categories.findIndex((item) => item.id === dragCategory.id) : -1;
  const activeDropSlot =
    dragCategory && dragCategory.over !== null && categoryReorderTarget(dragFrom, dragCategory.over, categories.length) !== null
      ? dragCategory.over
      : null;

  return (
    <div
      className="ws-tabs"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_CATEGORY_MIME) || categories.length < 2) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const track = trackRef.current;
        if (overflow.any && track) {
          const trackRect = track.getBoundingClientRect();
          if (event.clientX < trackRect.left + 24) track.scrollLeft -= 12;
          else if (event.clientX > trackRect.right - 24) track.scrollLeft += 12;
        }
        const at = slotAtClientX(event.clientX, event.target);
        setDragCategory((prev) => (prev ? (prev.over === at ? prev : { ...prev, over: at }) : { id: "", over: at }));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragCategory((prev) => (prev && prev.id ? { ...prev, over: null } : null));
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_CATEGORY_MIME)) return;
        event.preventDefault();
        const draggedId = event.dataTransfer.getData(WORKSPACE_CATEGORY_MIME) || dragCategory?.id || "";
        const slot = dragCategory?.over ?? slotAtClientX(event.clientX, event.target);
        setDragCategory(null);
        const from = categories.findIndex((item) => item.id === draggedId);
        const to = categoryReorderTarget(from, slot, categories.length);
        if (draggedId && to !== null) void moveCategory(draggedId, to);
      }}
    >
      {overflow.any && (
        <button
          type="button"
          className="ws-tab-arrow"
          disabled={!overflow.left}
          aria-label={t("code.categoryScrollLeft")}
          {...tipProps(t("code.categoryScrollLeft"))}
          onClick={() => scrollByDir(-1)}
        >
          <ChevronLeft size={13} />
        </button>
      )}
      <div
        ref={trackRef}
        className="ws-tabs-track"
        role="tablist"
        aria-label={t("code.categoriesHeading")}
        onScroll={measure}
        onWheel={onTrackWheel}
        onKeyDown={onTrackKeyDown}
      >
        <button
          type="button"
          role="tab"
          data-tab-id="__all__"
          className="ws-tab"
          aria-selected={activeCategory === null}
          tabIndex={activeCategory === null ? 0 : -1}
          {...tipProps(t("code.categoryAllTip"))}
          onClick={() => onSelect(null)}
        >
          <span className="truncate">{t("code.categoryAll")}</span>
          <span className="ws-tab-count">{workspaces.length}</span>
        </button>
        {categories.map((category, index) => {
          const selected = activeCategory === category.id;
          const count = countIn(category.id);
          if (renaming === category.id) {
            return (
              <Input
                key={category.id}
                autoFocus
                defaultValue={category.name}
                maxLength={60}
                aria-label={t("common.rename")}
                className="ws-tab-input"
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onFocus={(event) => {
                  skipRenameBlurRef.current = false;
                  event.target.select();
                }}
                onBlur={(event) => {
                  if (skipRenameBlurRef.current) {
                    skipRenameBlurRef.current = false;
                    return;
                  }
                  void commitRename(category, event.target.value);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    skipRenameBlurRef.current = true;
                    setRenaming(null);
                  }
                }}
              />
            );
          }
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              data-tab-id={category.id}
              className={cx(
                "ws-tab",
                dropOver === category.id && "is-drop-target",
                dragCategory?.id === category.id && "is-dragging",
                activeDropSlot === index && "drop-before",
                activeDropSlot === categories.length && index === categories.length - 1 && "drop-after",
              )}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-category-index={index}
              draggable={categories.length > 1}
              onClick={() => onSelect(category.id)}
              onDoubleClick={() => startRename(category.id)}
              onKeyDown={(event) => {
                if (isShortcut("workspace.rename", event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  startRename(category.id);
                } else if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  event.stopPropagation();
                  void removeCategory(category);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ category, index, anchor: event.currentTarget });
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData(WORKSPACE_CATEGORY_MIME, category.id);
                event.dataTransfer.effectAllowed = "move";
                setTabMenu(null);
                setDragCategory({ id: category.id, over: null });
              }}
              onDragEnd={() => setDragCategory(null)}
              onDragOver={(event) => {
                if (!onDropWorkspace || !event.dataTransfer.types.includes(WORKSPACE_MIME)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dropOver !== category.id) setDropOver(category.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropOver === category.id) setDropOver(null);
              }}
              onDrop={(event) => {
                if (!onDropWorkspace || !event.dataTransfer.types.includes(WORKSPACE_MIME)) return;
                event.preventDefault();
                setDropOver(null);
                const id = event.dataTransfer.getData(WORKSPACE_MIME);
                if (id) onDropWorkspace(id, category.id, event.altKey);
              }}
            >
              <span className="truncate">{category.name}</span>
              <span className="ws-tab-count">{count}</span>
              {selected && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="ws-tab-more"
                  aria-label={t("code.workspaceActions")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setTabMenu((prev) => (prev?.category.id === category.id ? null : { category, index, anchor: event.currentTarget }));
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal size={12} />
                </span>
              )}
            </button>
          );
        })}
        {adding && (
          <Input
            autoFocus
            maxLength={60}
            placeholder={t("code.categoryPlaceholder")}
            aria-label={t("code.categoryPlaceholder")}
            className="ws-tab-input is-new"
            onClick={(event) => event.stopPropagation()}
            onFocus={() => {
              skipAddBlurRef.current = false;
            }}
            onBlur={(event) => {
              if (skipAddBlurRef.current) {
                skipAddBlurRef.current = false;
                return;
              }
              void commitAdd(event.target.value);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                skipAddBlurRef.current = true;
                cancelAdd();
              }
            }}
          />
        )}
      </div>
      {overflow.any && (
        <button
          type="button"
          className="ws-tab-arrow"
          disabled={!overflow.right}
          aria-label={t("code.categoryScrollRight")}
          {...tipProps(t("code.categoryScrollRight"))}
          onClick={() => scrollByDir(1)}
        >
          <ChevronRight size={13} />
        </button>
      )}
      {!adding && (
        <button
          type="button"
          className={cx("ws-tab-add", categories.length === 0 && "is-labeled")}
          aria-label={t("code.categoryAdd")}
          {...tipProps(t("code.categoryAdd"))}
          onClick={startAdd}
        >
          <Plus size={12} />
          {categories.length === 0 && <span>{t("code.categoryNewShort")}</span>}
        </button>
      )}
      {tabMenu && (
        <Popover anchor={tabMenu.anchor} onClose={() => setTabMenu(null)} align="start">
          <Menu items={categoryMenuItems(tabMenu.category, tabMenu.index)} onClose={() => setTabMenu(null)} />
        </Popover>
      )}
    </div>
  );
}
