import { useRef, useState, type ReactNode } from "react";
import type { LayoutNode } from "../../../shared/api.js";
import { tipProps } from "../../components/Tooltip.js";
import { useT } from "../../i18n/index.js";

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
  return <SplitNode node={node} path="" onRatio={onRatio} renderPane={renderPane} />;
}

function SplitNode({
  node,
  path,
  onRatio,
  renderPane,
}: {
  node: LayoutNode;
  path: string;
  onRatio: (path: string, ratio: number, done: boolean) => void;
  renderPane: (pane: Extract<LayoutNode, { kind: "pane" }>) => ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  if (node.kind === "pane") return <>{renderPane(node)}</>;
  const start = (event: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    setDragging(true);
    let last: number | null = null;
    const move = (moveEvent: PointerEvent) => {
      const ratio = node.dir === "row" ? (moveEvent.clientX - box.left) / box.width : (moveEvent.clientY - box.top) / box.height;
      last = Math.min(0.85, Math.max(0.15, ratio));
      onRatio(path, last, false);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (last !== null) onRatio(path, last, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div ref={ref} className={`split dir-${node.dir}`}>
      <div className="split-cell" style={{ flex: `${node.ratio} 1 0` }}>
        <SplitNode node={node.a} path={`${path}a`} onRatio={onRatio} renderPane={renderPane} />
      </div>
      <div
        className={`divider${dragging ? " dragging" : ""}`}
        onPointerDown={start}
        onDoubleClick={() => onRatio(path, 0.5, true)}
        {...tipProps(t("split.resize"))}
      />
      <div className="split-cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <SplitNode node={node.b} path={`${path}b`} onRatio={onRatio} renderPane={renderPane} />
      </div>
    </div>
  );
}
