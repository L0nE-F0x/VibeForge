import { describe, expect, it } from "vitest";
import type { LayoutNode } from "../../src/shared/api.js";
import { movePane, panesOf, removePane, setRatioAt } from "../../src/ui/pane-layout.js";

const pane = (id: string): LayoutNode => ({ kind: "pane", id, launch: { type: "shell" } });
const split = (dir: "row" | "col", a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({ kind: "split", dir, ratio, a, b });
const ids = (node: LayoutNode) => panesOf(node).map((item) => item.id);

describe("pane layout", () => {
  // [ a | [ b / c ] ]
  const layout = split("row", pane("a"), split("col", pane("b"), pane("c")), 0.4);

  it("swaps two panes when one is dropped on the other's centre", () => {
    const moved = movePane(layout, "a", "c", "center");
    expect(ids(moved)).toEqual(["c", "b", "a"]);
    expect(moved).toMatchObject({ kind: "split", dir: "row", ratio: 0.4 });
  });

  it("docks a pane on the side of another and closes the gap it left", () => {
    // Drop a on the bottom of c: the root split collapses, c's cell becomes [ c / a ].
    const moved = movePane(layout, "a", "c", "bottom");
    expect(moved).toEqual(split("col", pane("b"), split("col", pane("c"), pane("a"))));
    const left = movePane(layout, "c", "a", "left");
    expect(left).toEqual(split("row", split("row", pane("c"), pane("a")), pane("b"), 0.4));
    const top = movePane(layout, "b", "a", "top");
    expect(top).toEqual(split("row", split("col", pane("b"), pane("a")), pane("c"), 0.4));
  });

  it("ignores drops on the same pane or on panes that are not in the layout", () => {
    expect(movePane(layout, "a", "a", "left")).toBe(layout);
    expect(movePane(layout, "a", "zzz", "right")).toBe(layout);
    expect(movePane(pane("solo"), "solo", "solo", "center")).toEqual(pane("solo"));
  });

  it("removes panes and sets ratios by path", () => {
    expect(removePane(layout, "b")).toEqual(split("row", pane("a"), pane("c"), 0.4));
    expect(removePane(pane("a"), "a")).toBeNull();
    expect(setRatioAt(layout, "b", 0.7)).toEqual(split("row", pane("a"), split("col", pane("b"), pane("c"), 0.7), 0.4));
    expect(setRatioAt(layout, "", 0.25)).toMatchObject({ ratio: 0.25 });
  });
});
