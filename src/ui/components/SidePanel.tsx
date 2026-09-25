import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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

  const collapsed = state.collapsed;
  return (
    <aside
      ref={ref}
      className={cx("list-panel", collapsed && "is-collapsed", dragging && "is-resizing", className)}
      style={{ width: collapsed ? STRIP : state.width }}
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
    <button type="button" className="strip-item" aria-selected={selected} aria-label={label} onClick={onClick} {...tipProps(label, { side: "right" })}>
      {children}
      {badge}
    </button>
  );
}
