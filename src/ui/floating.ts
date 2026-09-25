// Geometry for things that float above the page. The browser dock is a native view that
// Electron draws over everything the page draws, so a tooltip or toast placed on it is hidden.
// Tooltips and toasts use these helpers to keep clear of it; menus and dialogs that cannot are
// registered in state.tsx, and the dock steps aside while one of them covers it.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Side = "top" | "bottom" | "left" | "right";

/** A layer's footprint: a box, or "window" for a dialog whose scrim covers everything. */
export type Layer = Box | "window";

interface Size {
  width: number;
  height: number;
}

export function boxOf(rect: Box): Box {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

export function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** True when two boxes share some area. Touching edges and empty boxes don't count. */
export function overlaps(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

/** True when any layer lands on `area`. */
export function covers(layers: Iterable<Layer>, area: Box | null): boolean {
  if (!area) return false;
  for (const layer of layers) if (layer === "window" || overlaps(layer, area)) return true;
  return false;
}

const GAP = 8;
const MARGIN = 4;

const SIDES: Record<Side, Side[]> = {
  bottom: ["bottom", "top", "right", "left"],
  top: ["top", "bottom", "right", "left"],
  right: ["right", "left", "bottom", "top"],
  left: ["left", "right", "bottom", "top"],
};

/**
 * Where a tooltip goes beside `anchor`: the preferred side when it fits in the window, else the
 * opposite side, else a perpendicular one. A spot that lands on `avoid` first slides along its
 * side to clear it (staying level with the anchor), then gives way to the next side. When no
 * side is clear it falls back to the first that fits, and the caller has to deal with the overlap.
 */
export function placeTip(anchor: Box, size: Size, side: Side, viewport: Size, avoid: Box | null = null): { left: number; top: number } {
  const { width, height } = size;
  const clampX = (left: number) => Math.min(Math.max(MARGIN, left), viewport.width - width - MARGIN);
  const clampY = (top: number) => Math.min(Math.max(MARGIN, top), viewport.height - height - MARGIN);
  const midX = (anchor.left + anchor.right) / 2 - width / 2;
  const midY = (anchor.top + anchor.bottom) / 2 - height / 2;
  const spotOn = (s: Side) => {
    if (s === "right") return { left: anchor.right + GAP, top: clampY(midY) };
    if (s === "left") return { left: anchor.left - GAP - width, top: clampY(midY) };
    if (s === "top") return { left: clampX(midX), top: anchor.top - GAP - height };
    return { left: clampX(midX), top: anchor.bottom + GAP };
  };
  const inView = (spot: { left: number; top: number }) =>
    spot.left >= MARGIN && spot.top >= MARGIN && spot.left + width <= viewport.width - MARGIN && spot.top + height <= viewport.height - MARGIN;
  // Keep a margin from the avoided box too, so the tooltip's short entry nudge never dips into it.
  const keepOut = avoid && { left: avoid.left - MARGIN, top: avoid.top - MARGIN, right: avoid.right + MARGIN, bottom: avoid.bottom + MARGIN };
  const clear = (spot: { left: number; top: number }) =>
    !keepOut || !overlaps({ left: spot.left, top: spot.top, right: spot.left + width, bottom: spot.top + height }, keepOut);

  const order = SIDES[side];
  for (const s of order) {
    const spot = spotOn(s);
    if (!inView(spot)) continue;
    if (clear(spot)) return spot;
    if (!keepOut) continue;
    const across = s === "top" || s === "bottom";
    const slides = across
      ? [keepOut.left - width, keepOut.right].map((left) => ({ left, top: spot.top }))
      : [keepOut.top - height, keepOut.bottom].map((top) => ({ left: spot.left, top }));
    for (const slid of slides) {
      const level = across
        ? slid.left < anchor.right && slid.left + width > anchor.left
        : slid.top < anchor.bottom && slid.top + height > anchor.top;
      if (level && inView(slid) && clear(slid)) return slid;
    }
  }
  const fallback = order.map(spotOn).find(inView) ?? spotOn(side);
  return { left: clampX(fallback.left), top: clampY(fallback.top) };
}

/**
 * The toast stack's distance from the right edge: `edge` as usual, or far enough left to clear
 * `avoid` when the stack would land on it and there is room beside it.
 */
export function toastRight(stack: Size, viewport: Size, avoid: Box | null, edge = 16): number {
  if (!avoid || stack.height <= 0) return edge;
  const usual = {
    left: viewport.width - edge - stack.width,
    top: viewport.height - edge - stack.height,
    right: viewport.width - edge,
    bottom: viewport.height - edge,
  };
  if (!overlaps(usual, avoid)) return edge;
  const right = viewport.width - avoid.left + edge;
  return viewport.width - right - stack.width >= edge ? right : edge;
}
