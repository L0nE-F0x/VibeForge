import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { tipProps } from "./Tooltip.js";
import { Button, cx } from "./ui.js";

// The list column most views have: resizable by its right edge, collapsible to a slim strip,
// and remembered per panel. Ctrl+Shift+B toggles the primary panel of whatever view is open.

interface PanelState {
  width: number;
  collapsed: boolean;
}

const STRIP = 56;
export const TOGGLE_PANEL_EVENT = "vibeforge:toggle-panel";

function load(id: string, fallback: PanelState): PanelState {
  try {
    const raw = localStorage.getItem(`vf.panel.${id}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return {
      width: typeof parsed.width === "number" ? parsed.width : fallback.width,
      collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : fallback.collapsed,
    };
  } catch {
    return fallback;
  }
}

const GLIDE_MS = 170;

/**
 * When the selected row of a list changes, its highlight slides from the old row to the new one.
 * A copy of the highlight does the moving, above the list and clipped to it; the rows keep their
 * own styles, and the new one's highlight shows again when the copy lands.
 */
function useSelectionGlide(ref: React.RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const find = () => root.querySelector<HTMLElement>('.list-scroll [aria-selected="true"]');
    let last = find();
    const observer = new MutationObserver(() => {
      const next = find();
      const prev = last;
      last = next;
      if (next && prev && next !== prev && prev.isConnected) glide(prev, next);
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
    return () => observer.disconnect();
  }, [ref, enabled]);
}

function glide(prev: HTMLElement, next: HTMLElement): void {
  const list = next.closest<HTMLElement>(".list-scroll");
  if (!list || prev.closest(".list-scroll") !== list) return;
  const box = list.getBoundingClientRect();
  const from = prev.getBoundingClientRect();
  const to = next.getBoundingClientRect();
  // A jump across a long list reads better as a switch than a streak.
  if (!from.height || !to.height || Math.abs(from.top - to.top) > box.height) return;
  const frame = document.createElement("div");
  frame.className = "sel-glide-frame";
  Object.assign(frame.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  const ghost = document.createElement("div");
  ghost.className = "sel-glide";
  ghost.style.left = `${to.left - box.left}px`;
  ghost.style.width = `${to.width}px`;
  frame.appendChild(ghost);
  document.body.appendChild(frame);
  next.dataset.gliding = "";
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // The row's own highlight fades back in as the copy fades out, so the hand-over doesn't blink.
    delete next.dataset.gliding;
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: "forwards" });
    setTimeout(() => frame.remove(), 130);
  };
  const animation = ghost.animate(
    [
      { top: `${from.top - box.top}px`, height: `${from.height}px` },
      { top: `${to.top - box.top}px`, height: `${to.height}px` },
    ],
    { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)", fill: "forwards" },
  );
  animation.onfinish = finish;
  animation.oncancel = finish;
  // A window that gets no frames never finishes an animation; never leave a row without its highlight.
  setTimeout(finish, GLIDE_MS + 120);
}

/** How far each panel's list was scrolled, so switching views and back lands in the same place. */
const scrolled = new Map<string, number>();

function save(id: string, state: PanelState): void {
  try {
    localStorage.setItem(`vf.panel.${id}`, JSON.stringify(state));
  } catch {
    /* storage can be unavailable */
  }
}

export function SidePanel({
  id,
  title,
  actions,
  children,
  strip,
  defaultWidth = 272,
  min = 200,
  max = 520,
  primary = true,
  className,
  scrollKey = id,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** What the collapsed strip shows under its expand button: avatars, initials, a New button. */
  strip?: ReactNode;
  defaultWidth?: number;
  min?: number;
  max?: number;
  /** The primary panel of a view answers Ctrl+Shift+B. */
  primary?: boolean;
  className?: string;
  /** Which remembered scroll position the list uses, when one panel shows different lists. */
  scrollKey?: string;
}) {
  const t = useT();
  const [state, setState] = useState<PanelState>(() => load(id, { width: defaultWidth, collapsed: false }));
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLElement>(null);

  const update = useCallback(
    (patch: Partial<PanelState>) =>
      setState((prev) => {
        const next = { ...prev, ...patch };
        save(id, next);
        return next;
      }),
    [id],
  );

  useEffect(() => {
    if (!primary) return;
    const toggle = () => {
      // Only the panel on screen answers; Code mode stays mounted behind other views.
      if (!ref.current || ref.current.offsetParent === null) return;
      setState((prev) => {
        const next = { ...prev, collapsed: !prev.collapsed };
        save(id, next);
        return next;
      });
    };
    window.addEventListener(TOGGLE_PANEL_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_PANEL_EVENT, toggle);
  }, [id, primary]);

  useLayoutEffect(() => {
    const top = scrolled.get(scrollKey);
    const list = ref.current?.querySelector<HTMLElement>(".list-scroll");
    if (list && top) list.scrollTop = top;
  }, [scrollKey, state.collapsed]);

  const rememberScroll = (event: React.UIEvent) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("list-scroll")) scrolled.set(scrollKey, target.scrollTop);
  };

  // With a row focused (click one, or Tab in), ↑/↓ open the one above or below; Home/End the ends.
  const moveInList = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(".list-scroll :is(.row, .run-row)");
    const list = row?.closest(".list-scroll");
    if (!row || !list) return;
    const rows = [...list.querySelectorAll<HTMLElement>(".row, .run-row")];
    const at = rows.indexOf(row);
    const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1] : rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    event.preventDefault();
    if (!next || next === row) return;
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    next.click();
    // Opening it can focus a message box; stay in the list so the next key keeps moving.
    setTimeout(() => next.isConnected && next.focus({ preventScroll: true }), 0);
  };

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = state.width;
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(max, Math.max(min, startWidth + moveEvent.clientX - startX));
      setState((prev) => ({ ...prev, width }));
    };
    const up = () => {
      setDragging(false);
      setState((prev) => {
        save(id, prev);
        return prev;
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useSelectionGlide(ref, !state.collapsed);

  const collapsed = state.collapsed;
  return (
    <aside
      ref={ref}
      className={cx("list-panel", collapsed && "is-collapsed", dragging && "is-resizing", className)}
      style={{ width: collapsed ? STRIP : state.width }}
      onScrollCapture={rememberScroll}
      onKeyDown={moveInList}
    >
      {collapsed ? (
        <>
          <div className="list-head strip-head">
            <Button variant="ghost" size="sm" icon={PanelLeftOpen} tip={t("panel.show")} kbd={primary ? "Ctrl+Shift+B" : undefined} tipSide="right" onClick={() => update({ collapsed: false })} />
          </div>
          <div className="list-strip">{strip}</div>
        </>
      ) : (
        <>
          <div className="list-head">
            <h2 className="grow truncate">{title}</h2>
            {actions}
            <Button variant="ghost" size="sm" icon={PanelLeftClose} tip={t("panel.collapse")} kbd={primary ? "Ctrl+Shift+B" : undefined} onClick={() => update({ collapsed: true })} />
          </div>
          {children}
          <div
            className="panel-resize"
            onPointerDown={startResize}
            onDoubleClick={() => update({ width: defaultWidth })}
            {...tipProps(t("panel.resize"), { side: "right" })}
          />
        </>
      )}
    </aside>
  );
}

/** A compact button for a collapsed strip: an avatar, initials or icon with a tooltip. */
export function StripItem({
  label,
  selected,
  onClick,
  children,
  badge,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <button type="button" className="strip-item" aria-selected={selected} aria-current={selected || undefined} aria-label={label} onClick={onClick} {...tipProps(label, { side: "right" })}>
      {children}
      {badge}
    </button>
  );
}
