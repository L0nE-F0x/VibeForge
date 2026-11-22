import { useRef, useState, type ReactNode } from "react";
import type { LayoutNode } from "../../../shared/api.js";
import { tipProps } from "../../components/Tooltip.js";
import { useT } from "../../i18n/index.js";
import { computeSplitLayout, spanCss, type FlatDividerBox } from "../../pane-layout.js";

/** `onRatio` follows a divider as it moves, then once more with `done` when it is let go or reset. */
export function SplitView({
  node,
  onRatio,
  renderPane,
}: {
  node: LayoutNode;
  onRatio: (path: string, ratio: number, done: boolean) => void;
  renderPane: (pane: Extract<LayoutNode, { kind: "pane" }>) => ReactNode;
  path?: string;
}) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const layout = computeSplitLayout(node);
  // Keep sibling order independent of tree swaps so swapped panes update CSS coordinates instead of remounting.
  const orderedPanes = [...layout.panes].sort((a, b) => a.pane.id.localeCompare(b.pane.id));

  const startDrag = (div: FlatDividerBox, event: React.PointerEvent) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const boxLeft = stage.left + div.parentX.startPct * stage.width + div.parentX.startPx;
    const boxWidth = div.parentX.sizePct * stage.width + div.parentX.sizePx;
    const boxTop = stage.top + div.parentY.startPct * stage.height + div.parentY.startPx;
    const boxHeight = div.parentY.sizePct * stage.height + div.parentY.sizePx;
    if ((div.dir === "row" ? boxWidth : boxHeight) < 20) return;
    event.preventDefault();
    setDraggingPath(div.path);
    let last: number | null = null;
    const move = (moveEvent: PointerEvent) => {
      const ratio = div.dir === "row" ? (moveEvent.clientX - boxLeft) / boxWidth : (moveEvent.clientY - boxTop) / boxHeight;
      last = Math.min(0.85, Math.max(0.15, ratio));
      onRatio(div.path, last, false);
    };
    const up = () => {
      setDraggingPath(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (last !== null) onRatio(div.path, last, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div ref={stageRef} className={`split-stage${orderedPanes.length > 1 ? " split" : ""}`}>
      {orderedPanes.map((box) => {
        const x = spanCss(box.x);
        const y = spanCss(box.y);
        return (
          <div key={box.pane.id} className="pane-slot" style={{ left: x.start, top: y.start, width: x.size, height: y.size }}>
            {renderPane(box.pane)}
          </div>
        );
      })}
      {layout.dividers.map((div) => {
        const x = spanCss(div.x);
        const y = spanCss(div.y);
        return (
          <div
            key={div.path}
            className={`divider dir-${div.dir}${draggingPath === div.path ? " dragging" : ""}`}
            style={{ left: x.start, top: y.start, width: x.size, height: y.size }}
            onPointerDown={(event) => startDrag(div, event)}
            onDoubleClick={() => onRatio(div.path, 0.5, true)}
            {...tipProps(t("split.resize"))}
          />
        );
      })}
    </div>
  );
}
