import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyView,
  defaultView,
  isDefaultView,
  loadView,
  matchesQuery,
  nameOrder,
  runWentWrong,
  saveView,
  timeOf,
  toggleIn,
  viewCounts,
  type ListSpec,
  type ViewRules,
} from "../../src/ui/list-view.js";
import { deleteEach } from "../../src/ui/state.js";

interface Item {
  name: string;
  live: boolean;
  waiting: boolean;
  at: string;
  note?: string;
}

type Filter = "live" | "waiting";
type Sort = "name" | "recent";
const spec: ListSpec<Filter, Sort> = { key: "things", filters: ["live", "waiting"], sorts: ["name", "recent"], defaultSort: "name" };

const items: Item[] = [
  { name: "site-10", live: false, waiting: true, at: "2026-11-18T10:00:00Z" },
  { name: "Atlas", live: true, waiting: true, at: "2026-11-18T09:00:00Z", note: "release notes" },
  { name: "site-2", live: true, waiting: false, at: "2026-11-18T12:00:00Z" },
  { name: "blog", live: false, waiting: false, at: "2026-11-18T12:00:00Z" },
];

const collator = nameOrder("en");
const rules = (query = ""): ViewRules<Item, Filter, Sort> => ({
  test: (filter, item) => item[filter],
  searched: (item) => matchesQuery(query, item.name, item.note),
  compare: (sort, a, b) => (sort === "recent" ? timeOf(b.at) - timeOf(a.at) : collator.compare(a.name, b.name)),
});
const names = (list: Item[]) => list.map((item) => item.name);

describe("list views", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
  });
  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("toggles filters in the menu's order, so equal sets save the same way", () => {
    expect(toggleIn(spec.filters, [], "waiting")).toEqual(["waiting"]);
    expect(toggleIn(spec.filters, ["waiting"], "live")).toEqual(["live", "waiting"]);
    expect(toggleIn(spec.filters, ["live", "waiting"], "live")).toEqual(["waiting"]);
  });

  it("knows the list's own view, and remembers anything else per list", () => {
    expect(defaultView(spec)).toEqual({ filters: [], sort: "name" });
    expect(isDefaultView(spec, { filters: [], sort: "name" })).toBe(true);
    expect(isDefaultView(spec, { filters: [], sort: "recent" })).toBe(false);
    expect(isDefaultView(spec, { filters: ["live"], sort: "name" })).toBe(false);

    saveView(spec, { filters: ["waiting"], sort: "recent" });
    expect(loadView(spec)).toEqual({ filters: ["waiting"], sort: "recent" });
    expect(loadView({ ...spec, key: "other" })).toEqual({ filters: [], sort: "name" });
    // Back to the list's own view leaves nothing behind.
    saveView(spec, defaultView(spec));
    expect(store.has("vf.list.things.view")).toBe(false);
  });

  it("drops what this version doesn't know from a saved view, and survives a broken one", () => {
    store.set("vf.list.things.view", JSON.stringify({ filters: ["gone", "live", 4], sort: "size" }));
    expect(loadView(spec)).toEqual({ filters: ["live"], sort: "name" });
    store.set("vf.list.things.view", "{not json");
    expect(loadView(spec)).toEqual({ filters: [], sort: "name" });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(loadView(spec)).toEqual({ filters: [], sort: "name" });
    expect(() => saveView(spec, { filters: ["live"], sort: "recent" })).not.toThrow();
  });

  it("finds a name by its letters in order, and anything else by the words typed", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("  ", "anything")).toBe(true);
    expect(matchesQuery("atl", "Atlas")).toBe(true);
    expect(matchesQuery("rn", "release-notes")).toBe(true);
    expect(matchesQuery("NOTES", "Atlas", "release notes")).toBe(true);
    expect(matchesQuery("notes", "Atlas", null, undefined)).toBe(false);
    // Outside the name, letters in order are not enough: the words must be there.
    expect(matchesQuery("rn", "Atlas", "release notes")).toBe(false);
  });

  it("sorts, filters and searches together, keeping the list's own order on ties", () => {
    expect(names(applyView(items, { filters: [], sort: "name" }, rules()))).toEqual(["Atlas", "blog", "site-2", "site-10"]);
    // site-2 and blog tie on time: they stay in the order they came in.
    expect(names(applyView(items, { filters: [], sort: "recent" }, rules()))).toEqual(["site-2", "blog", "site-10", "Atlas"]);
    // Every filter on must match.
    expect(names(applyView(items, { filters: ["live"], sort: "name" }, rules()))).toEqual(["Atlas", "site-2"]);
    expect(names(applyView(items, { filters: ["live", "waiting"], sort: "name" }, rules()))).toEqual(["Atlas"]);
    expect(names(applyView(items, { filters: [], sort: "name" }, rules("site")))).toEqual(["site-2", "site-10"]);
    expect(names(applyView(items, { filters: ["waiting"], sort: "name" }, rules("site")))).toEqual(["site-10"]);
    expect(applyView(items, { filters: ["live"], sort: "name" }, rules("blog"))).toEqual([]);
    // The items given are left as they were.
    expect(names(items)).toEqual(["site-10", "Atlas", "site-2", "blog"]);
  });

  it("counts what each filter would show with the search and the other filters on", () => {
    expect(viewCounts(items, spec.filters, [], rules())).toEqual({ all: 4, live: 2, waiting: 2 });
    // With Live on, Waiting counts the live ones that are waiting; Live itself counts as if alone.
    expect(viewCounts(items, spec.filters, ["live"], rules())).toEqual({ all: 4, live: 2, waiting: 1 });
    expect(viewCounts(items, spec.filters, ["live"], rules("site"))).toEqual({ all: 2, live: 1, waiting: 0 });
  });

  it("says which runs went wrong, and reads times and names as a person would", () => {
    expect(runWentWrong({ status: "failed", exitCode: null })).toBe(true);
    expect(runWentWrong({ status: "exited", exitCode: 2 })).toBe(true);
    expect(runWentWrong({ status: "exited", exitCode: 0 })).toBe(false);
    expect(runWentWrong({ status: "stopped", exitCode: null })).toBe(false);
    expect(runWentWrong({ status: "running", exitCode: null })).toBe(false);
    expect(timeOf(null)).toBe(0);
    expect(timeOf("not a date")).toBe(0);
    expect(timeOf("2026-11-18T12:00:00Z")).toBe(Date.parse("2026-11-18T12:00:00Z"));
    expect(["site-10", "Site-2", "atlas"].sort(nameOrder("en").compare)).toEqual(["atlas", "Site-2", "site-10"]);
  });
});

describe("deleting several at once", () => {
  it("deletes each in turn and hands back every undo", async () => {
    const seen: string[] = [];
    const result = await deleteEach(["a", "b", "c"], async (id) => {
      seen.push(id);
      return { undo: `undo-${id}` };
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ gone: ["a", "b", "c"], deleted: [{ undo: "undo-a" }, { undo: "undo-b" }, { undo: "undo-c" }], error: null });
  });

  it("stops at the first that fails, keeping the undo of the ones already gone", async () => {
    const failure = new Error("It is in use.");
    const seen: string[] = [];
    const result = await deleteEach(["a", "b", "c"], async (id) => {
      seen.push(id);
      if (id === "b") throw failure;
      return { undo: `undo-${id}`, copyLeft: id === "a" };
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result).toEqual({ gone: ["a"], deleted: [{ undo: "undo-a", copyLeft: true }], error: failure });
  });
});
