import { describe, expect, it } from "vitest";
import { covers, overlaps, placeTip, toastRight, type Box } from "../../src/ui/floating.js";

// The default window with the browser dock open in a 420px side panel, above the launch bar.
const view = { width: 1480, height: 920 };
const dock: Box = { left: 1061, top: 124, right: 1480, bottom: 862 };
const boxAt = (spot: { left: number; top: number }, size: { width: number; height: number }): Box => ({
  left: spot.left,
  top: spot.top,
  right: spot.left + size.width,
  bottom: spot.top + size.height,
});

describe("floating layers", () => {
  it("counts overlap only when two boxes share area", () => {
    expect(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
    expect(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(overlaps({ left: 5, top: 5, right: 5, bottom: 9 }, { left: 0, top: 0, right: 10, bottom: 10 })).toBe(false);
  });

  it("finds the layers that land on the dock", () => {
    expect(covers(["window"], dock)).toBe(true);
    expect(covers(["window"], null)).toBe(false);
    expect(covers([{ left: 64, top: 600, right: 330, bottom: 860 }], dock)).toBe(false);
    expect(covers([{ left: 64, top: 600, right: 330, bottom: 860 }, { left: 1000, top: 300, right: 1200, bottom: 400 }], dock)).toBe(true);
  });
});

describe("tooltip placement", () => {
  const tip = { width: 60, height: 26 };

  it("uses the preferred side, or the opposite one when the window runs out", () => {
    const anchor = { left: 400, top: 300, right: 424, bottom: 324 };
    expect(placeTip(anchor, tip, "bottom", view)).toEqual({ left: 382, top: 332 });
    const low = { left: 400, top: 880, right: 424, bottom: 904 };
    expect(placeTip(low, tip, "bottom", view)).toEqual({ left: 382, top: 846 });
  });

  it("goes above the dock's own toolbar instead of onto the page", () => {
    const back = { left: 1069, top: 92, right: 1095, bottom: 118 };
    const spot = placeTip(back, tip, "bottom", view, dock);
    expect(spot).toEqual({ left: 1052, top: 58 });
    expect(overlaps(boxAt(spot, tip), dock)).toBe(false);
  });

  it("slides along its side to clear the dock when it can stay beside the anchor", () => {
    const paneButton = { left: 1030, top: 132, right: 1054, bottom: 156 };
    const wide = { width: 200, height: 26 };
    const spot = placeTip(paneButton, wide, "bottom", view, dock);
    expect(spot).toEqual({ left: 857, top: 164 });
    expect(overlaps(boxAt(spot, wide), dock)).toBe(false);
  });

  it("keeps a margin from the dock, not just a touching edge", () => {
    // A pane's close button just above the dock's corner: its tooltip would end 1px above the page.
    const close = { left: 1150, top: 74, right: 1174, bottom: 98 };
    const size = { width: 110, height: 30 };
    const spot = placeTip(close, size, "bottom", view, { ...dock, left: 1193, top: 137 });
    expect(spot).toEqual({ left: 1079, top: 106 });
  });

  it("turns to a perpendicular side when both the window and the dock are in the way", () => {
    const launch = { left: 1400, top: 874, right: 1470, bottom: 906 };
    const size = { width: 150, height: 26 };
    const spot = placeTip(launch, size, "bottom", view, dock);
    expect(spot).toEqual({ left: 1242, top: 877 });
    expect(overlaps(boxAt(spot, size), dock)).toBe(false);
  });

  it("falls back to the usual spot when nothing keeps clear", () => {
    const everywhere = { left: 0, top: 0, right: view.width, bottom: view.height };
    const anchor = { left: 400, top: 300, right: 424, bottom: 324 };
    expect(placeTip(anchor, tip, "bottom", view, everywhere)).toEqual({ left: 382, top: 332 });
  });
});

describe("toast stack", () => {
  const stack = { width: 380, height: 60 };

  it("stays in the corner unless it would land on the dock", () => {
    expect(toastRight(stack, view, null)).toBe(16);
    expect(toastRight(stack, view, { ...dock, bottom: 800 })).toBe(16);
    expect(toastRight({ width: 380, height: 0 }, view, dock)).toBe(16);
  });

  it("moves just left of the dock when there is room", () => {
    const right = toastRight(stack, view, dock);
    expect(right).toBe(435);
    expect(view.width - right).toBeLessThanOrEqual(dock.left - 16);
  });

  it("keeps the corner when the dock leaves no room beside it", () => {
    expect(toastRight(stack, view, { ...dock, left: 300 })).toBe(16);
  });
});
