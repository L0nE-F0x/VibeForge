import type { LayoutNode, PaneLaunch } from "../shared/api.js";

// Code mode's pane tree: a binary split of panes. Pure functions, so they can be tested alone.

export type PaneNode = Extract<LayoutNode, { kind: "pane" }>;

export function panesOf(node: LayoutNode): PaneNode[] {
  return node.kind === "pane" ? [node] : [...panesOf(node.a), ...panesOf(node.b)];
}

export function replacePane(node: LayoutNode, id: string, next: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === id ? next : node;
  return { ...node, a: replacePane(node.a, id, next), b: replacePane(node.b, id, next) };
}

export function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === "pane") return node.id === id ? null : node;
  const a = removePane(node.a, id);
  const b = removePane(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/**
 * Where a CLI started outside Code (by a Maestro plan, or a jump to its session) goes in its
 * workspace: the pane that already holds it (`owns`), else a pane of the same CLI with nothing
 * running in it, when `idle` says which those are; else a new pane beside the focused one (the
 * first, when focus is on none of them); or the only pane of an empty workspace. Feed one
 * placement's layout into the next, so two CLIs started together get a pane each.
 */
export function placeSession(
  layout: LayoutNode | null | undefined,
  launch: PaneLaunch,
  opts: { newId: string; focus?: string; idle?: (paneId: string) => boolean; owns?: (paneId: string) => boolean },
): { layout: LayoutNode; paneId: string } {
  const panes = layout ? panesOf(layout) : [];
  const { owns, idle } = opts;
  const owner = owns ? panes.find((pane) => owns(pane.id)) : undefined;
  if (layout && owner) return { layout, paneId: owner.id };
  const free = idle && launch.type === "engine" ? panes.find((pane) => pane.launch.type === "engine" && pane.launch.engineId === launch.engineId && idle(pane.id)) : undefined;
  if (layout && free) return { layout, paneId: free.id };
  const pane: PaneNode = { kind: "pane", id: opts.newId, launch };
  if (!layout) return { layout: pane, paneId: pane.id };
  const beside = panes.find((item) => item.id === opts.focus) ?? panes[0];
  return { layout: replacePane(layout, beside.id, { kind: "split", dir: "row", ratio: 0.5, a: beside, b: pane }), paneId: pane.id };
}

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

/** Drop one pane on another: the centre swaps them, an edge docks the dragged pane on that side. */
export function movePane(layout: LayoutNode, sourceId: string, targetId: string, zone: DropZone): LayoutNode {
  if (sourceId === targetId) return layout;
  const panes = panesOf(layout);
  const source = panes.find((pane) => pane.id === sourceId);
  const target = panes.find((pane) => pane.id === targetId);
  if (!source || !target) return layout;
  if (zone === "center") {
    const swap = (node: LayoutNode): LayoutNode =>
      node.kind === "pane" ? (node.id === sourceId ? target : node.id === targetId ? source : node) : { ...node, a: swap(node.a), b: swap(node.b) };
    return swap(layout);
  }
  const without = removePane(layout, sourceId);
  if (!without) return layout;
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  return replacePane(without, targetId, { kind: "split", dir, ratio: 0.5, a: first ? source : target, b: first ? target : source });
}

/** Set the ratio of the split at `path` ("" is the root, "ab" is root.a.b). */
export function setRatioAt(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.kind === "pane") return node;
  if (path === "") return { ...node, ratio };
  const [head, ...rest] = path;
  return head === "a" ? { ...node, a: setRatioAt(node.a, rest.join(""), ratio) } : { ...node, b: setRatioAt(node.b, rest.join(""), ratio) };
}

/**
 * A maximized pane hides the others, so a workspace whose focus moved to another pane (one split
 * off, one a route or Maestro jumped to, one dragged) is restored. The same object back when
 * nothing changes.
 */
export function unzoomForFocus(zoomed: Record<string, string | null>, focus: Record<string, string>): Record<string, string | null> {
  let next = zoomed;
  for (const [workspaceId, zoomedId] of Object.entries(zoomed)) {
    const focused = focus[workspaceId];
    if (zoomedId && focused && focused !== zoomedId) next = { ...next, [workspaceId]: null };
  }
  return next;
}

export const DIVIDER_PX = 10;

export interface AxisSpan {
  startPct: number;
  startPx: number;
  sizePct: number;
  sizePx: number;
}

export interface FlatPaneBox {
  pane: PaneNode;
  x: AxisSpan;
  y: AxisSpan;
}

export interface FlatDividerBox {
  path: string;
  dir: "row" | "col";
  x: AxisSpan;
  y: AxisSpan;
  parentX: AxisSpan;
  parentY: AxisSpan;
}

function splitAxis(span: AxisSpan, ratio: number, gapPx: number): [AxisSpan, AxisSpan, AxisSpan] {
  const netPx = span.sizePx - gapPx;
  const aSizePct = span.sizePct * ratio;
  const aSizePx = netPx * ratio;
  const divStartPct = span.startPct + aSizePct;
  const divStartPx = span.startPx + aSizePx;
  return [
    { startPct: span.startPct, startPx: span.startPx, sizePct: aSizePct, sizePx: aSizePx },
    { startPct: divStartPct, startPx: divStartPx, sizePct: 0, sizePx: gapPx },
    { startPct: divStartPct, startPx: divStartPx + gapPx, sizePct: span.sizePct * (1 - ratio), sizePx: netPx * (1 - ratio) },
  ];
}

/**
 * Flatten a binary split tree into absolute `(pct, px)` boxes and divider slots so React can keep
 * every `<PaneView key={pane.id}>` at constant tree depth across splits, closes, and swaps.
 */
export function computeSplitLayout(node: LayoutNode, gapPx = DIVIDER_PX): { panes: FlatPaneBox[]; dividers: FlatDividerBox[] } {
  const panes: FlatPaneBox[] = [];
  const dividers: FlatDividerBox[] = [];
  const full: AxisSpan = { startPct: 0, startPx: 0, sizePct: 1, sizePx: 0 };
  const walk = (cur: LayoutNode, x: AxisSpan, y: AxisSpan, path: string): void => {
    if (cur.kind === "pane") {
      panes.push({ pane: cur, x, y });
      return;
    }
    if (cur.dir === "row") {
      const [ax, dx, bx] = splitAxis(x, cur.ratio, gapPx);
      dividers.push({ path, dir: "row", x: dx, y, parentX: x, parentY: y });
      walk(cur.a, ax, y, `${path}a`);
      walk(cur.b, bx, y, `${path}b`);
    } else {
      const [ay, dy, by] = splitAxis(y, cur.ratio, gapPx);
      dividers.push({ path, dir: "col", x, y: dy, parentX: x, parentY: y });
      walk(cur.a, x, ay, `${path}a`);
      walk(cur.b, x, by, `${path}b`);
    }
  };
  walk(node, full, full, "");
  return { panes, dividers };
}

function formatAxis(pct: number, px: number): string {
  const p = Number((pct * 100).toFixed(4));
  const x = Number(px.toFixed(2));
  if (p === 0 && x === 0) return "0px";
  if (x === 0) return `${p}%`;
  if (p === 0) return `${x}px`;
  return `calc(${p}% ${x < 0 ? "-" : "+"} ${Math.abs(x)}px)`;
}

export function spanCss(span: AxisSpan): { start: string; size: string } {
  return { start: formatAxis(span.startPct, span.startPx), size: formatAxis(span.sizePct, span.sizePx) };
}

/** The terminal a pane showed: kept for the window's page only, so it outlives a reload but not a restart. */
export type PaneTerminal = { ptyId: string; runId: string | null };

/**
 * After the page reloads (it crashed and came back), which panes get their terminal back: each
 * pane whose remembered terminal is still running, and only one pane per terminal. The rest start
 * as they would after a restart.
 */
export function reattachPanes(panes: readonly PaneNode[], remembered: Readonly<Record<string, PaneTerminal>>, running: ReadonlySet<string>): Map<string, PaneTerminal> {
  const back = new Map<string, PaneTerminal>();
  const taken = new Set<string>();
  for (const pane of panes) {
    const terminal = remembered[pane.id];
    if (!terminal || !running.has(terminal.ptyId) || taken.has(terminal.ptyId)) continue;
    taken.add(terminal.ptyId);
    back.set(pane.id, terminal);
  }
  return back;
}
