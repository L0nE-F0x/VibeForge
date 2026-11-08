import { describe, expect, it } from "vitest";
import type { LayoutNode } from "../../src/shared/api.js";
import { movePane, panesOf, placeSession, removePane, setRatioAt } from "../../src/ui/pane-layout.js";

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

describe("placing a CLI started outside Code", () => {
  const claude = { type: "engine", engineId: "claude" } as const;
  const engine = (id: string, engineId: string): LayoutNode => ({ kind: "pane", id, launch: { type: "engine", engineId } });

  it("gives two CLIs started together a pane each when each placement builds on the last", () => {
    // What Code holds, updated at once: a Maestro plan starts two CLIs in the same workspace.
    let layout: LayoutNode | null = pane("shell");
    let focus = "shell";
    const running = new Set<string>();
    for (const id of ["one", "two"]) {
      const spot = placeSession(layout, claude, { newId: id, focus, idle: (paneId) => !running.has(paneId) });
      layout = spot.layout;
      focus = spot.paneId;
      running.add(spot.paneId);
    }
    expect(ids(layout!)).toEqual(["shell", "one", "two"]);
  });

  it("loses the first pane when the second placement reads the layout from before it", () => {
    // The bug this guards against: both placements start from the same stale layout.
    const stale: LayoutNode = pane("shell");
    placeSession(stale, claude, { newId: "one", focus: "shell" });
    const second = placeSession(stale, claude, { newId: "two", focus: "shell" });
    expect(ids(second.layout)).not.toContain("one");
  });

  it("reuses a pane of the same CLI left idle from last time, once", () => {
    const layout = split("row", pane("shell"), engine("old", "claude"));
    const running = new Set<string>();
    const idle = (paneId: string) => !running.has(paneId);
    const first = placeSession(layout, claude, { newId: "new1", idle });
    expect(first).toEqual({ layout, paneId: "old" });
    running.add(first.paneId);
    const second = placeSession(first.layout, claude, { newId: "new2", idle });
    expect(second.paneId).toBe("new2");
    expect(ids(second.layout)).toEqual(["shell", "new2", "old"]);
    // Another CLI never takes a Claude pane.
    expect(placeSession(layout, { type: "engine", engineId: "codex" }, { newId: "c", idle }).paneId).toBe("c");
  });

  it("opens beside the focused pane, the first when focus is on none, or alone in an empty workspace", () => {
    const layout = split("row", pane("a"), pane("b"));
    expect(placeSession(layout, claude, { newId: "n", focus: "b" }).layout).toEqual(split("row", pane("a"), split("row", pane("b"), engine("n", "claude"))));
    expect(placeSession(layout, claude, { newId: "n", focus: "gone" }).layout).toEqual(split("row", split("row", pane("a"), engine("n", "claude")), pane("b")));
    expect(placeSession(null, claude, { newId: "n" })).toEqual({ layout: engine("n", "claude"), paneId: "n" });
  });
});
