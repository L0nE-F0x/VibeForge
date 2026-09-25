import type { LayoutNode } from "../shared/api.js";

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
