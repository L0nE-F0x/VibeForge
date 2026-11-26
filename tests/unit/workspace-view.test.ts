import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_VIEW,
  filterCounts,
  groupWorkspaces,
  isDefaultWorkspaceView,
  leafFolder,
  loadWorkspaceCategory,
  loadWorkspaceView,
  matchesSearch,
  parentFolder,
  saveWorkspaceCategory,
  saveWorkspaceView,
  toggleFilter,
  viewWorkspaces,
  workspacesInCategory,
  type WorkspaceFacts,
  type WorkspaceView,
} from "../../src/ui/workspace-view.js";

const view = (overrides: Partial<WorkspaceView> = {}): WorkspaceView => ({ ...DEFAULT_WORKSPACE_VIEW, ...overrides });
const item = (name: string, more: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  name,
  path: `~/Projects/${name.toLowerCase()}`,
  open: false,
  working: false,
  waiting: false,
  review: false,
  synced: false,
  git: true,
  branch: "main",
  dirty: 0,
  ahead: 0,
  activityAt: null,
  ...more,
});

const list: WorkspaceFacts[] = [
  item("vibeforge", { path: "~/Projects/ApexForge/vibeforge", open: true, dirty: 3, activityAt: "2026-11-18T12:00:00Z" }),
  item("Atlas", { path: "~/Work/atlas", waiting: true, open: true, dirty: 1, activityAt: "2026-11-18T11:00:00Z" }),
  item("site-2", { path: "~/Projects/site-2", synced: true, ahead: 2, activityAt: "2026-11-18T20:30:00+08:00" }),
  item("site-10", { path: "~/Projects/site-10", review: true, branch: "vibeforge/copy-10" }),
  item("blog", { path: "~/Work/blog", working: true, open: true, synced: true, dirty: 3, activityAt: "2026-11-18T09:00:00Z" }),
  item("notes", { path: "~/notes", git: false, branch: null }),
];

const names = (items: WorkspaceFacts[]) => items.map((workspace) => workspace.name);
const same = (workspace: WorkspaceFacts) => workspace;

describe("workspace list view", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  });

  it("extracts parent and leaf folders cleanly across home, root and nested paths", () => {
    expect(parentFolder("~/Projects/ApexForge/vibeforge")).toBe("~/Projects/ApexForge");
    expect(parentFolder("~/Projects/site-2/")).toBe("~/Projects");
    expect(parentFolder("~/notes")).toBe("~");
    expect(parentFolder("~")).toBe("~");
    expect(parentFolder("/opt/service")).toBe("/opt");
    expect(parentFolder("/opt")).toBe("/");
    expect(parentFolder("/")).toBe("/");

    expect(leafFolder("~/Projects/ApexForge/vibeforge")).toBe("vibeforge");
    expect(leafFolder("~/notes/")).toBe("notes");
    expect(leafFolder("~")).toBe("~");
  });

  it("sorts by manual order, name, parent folder, recent activity and uncommitted changes stably", () => {
    expect(names(viewWorkspaces(list, same, view({ sort: "manual" }), ""))).toEqual(["vibeforge", "Atlas", "site-2", "site-10", "blog", "notes"]);
    expect(names(viewWorkspaces(list, same, view({ sort: "name" }), "", "en"))).toEqual(["Atlas", "blog", "notes", "site-2", "site-10", "vibeforge"]);
    expect(names(viewWorkspaces(list, same, view({ sort: "parent" }), "", "en"))).toEqual(["notes", "site-2", "site-10", "vibeforge", "Atlas", "blog"]);

    // Recent: blog is actively working right now; site-2 is 20:30+08:00 (= 12:30Z, newer than vibeforge's 12:00Z);
    // site-10 and notes have no timestamp and stay in their relative manual order.
    expect(names(viewWorkspaces(list, same, view({ sort: "recent" }), ""))).toEqual(["blog", "site-2", "vibeforge", "Atlas", "site-10", "notes"]);

    // Uncommitted changes: vibeforge and blog tie at dirty=3 and keep manual order; then Atlas (dirty=1),
    // site-10 (copy waiting for review), site-2 (ahead=2, git repo), notes (not a git repo).
    expect(names(viewWorkspaces(list, same, view({ sort: "changes" }), ""))).toEqual(["vibeforge", "blog", "Atlas", "site-10", "site-2", "notes"]);

    // Equal names preserve original manual order.
    const dupes = [item("app", { path: "~/one/app" }), item("app", { path: "~/two/app" })];
    expect(viewWorkspaces(dupes, same, view({ sort: "name" }), "", "en").map((w) => w.path)).toEqual(["~/one/app", "~/two/app"]);
  });

  it("filters by every facet and composes multiple filters sensibly", () => {
    expect(names(viewWorkspaces(list, same, view({ filters: ["open"] }), ""))).toEqual(["vibeforge", "Atlas", "blog"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["working"] }), ""))).toEqual(["blog"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["waiting"] }), ""))).toEqual(["Atlas"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["review"] }), ""))).toEqual(["site-10"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["dirty"] }), ""))).toEqual(["vibeforge", "Atlas", "blog"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["synced"] }), ""))).toEqual(["site-2", "blog"]);

    // Composed filters (ANDed) in canonical order.
    const combined = toggleFilter(toggleFilter([], "synced"), "open");
    expect(combined).toEqual(["open", "synced"]);
    expect(names(viewWorkspaces(list, same, view({ filters: combined }), ""))).toEqual(["blog"]);
    expect(toggleFilter(combined, "open")).toEqual(["synced"]);

    // Faceted counts reflect what selecting each filter alongside active ones yields.
    const baseCounts = filterCounts(list, same);
    expect(baseCounts).toEqual({ all: 6, open: 3, working: 1, waiting: 1, review: 1, dirty: 3, synced: 2 });
    const openCounts = filterCounts(list, same, ["open"]);
    expect(openCounts).toEqual({ all: 6, open: 3, working: 1, waiting: 1, review: 0, dirty: 3, synced: 1 });
  });

  it("groups by parent folder while respecting sort, filters and search", () => {
    const manualGroups = groupWorkspaces(list, same, view({ group: "parent", sort: "manual" }), "", "en");
    expect(manualGroups.map((g) => [g.folder, names(g.items)])).toEqual([
      ["~/Projects/ApexForge", ["vibeforge"]],
      ["~/Work", ["Atlas", "blog"]],
      ["~/Projects", ["site-2", "site-10"]],
      ["~", ["notes"]],
    ]);
    // Flat shown order matches the grouped visual order.
    expect(names(viewWorkspaces(list, same, view({ group: "parent", sort: "manual" }), "", "en"))).toEqual([
      "vibeforge",
      "Atlas",
      "blog",
      "site-2",
      "site-10",
      "notes",
    ]);

    // Grouping + name sort orders both folders and items alphabetically.
    const nameGroups = groupWorkspaces(list, same, view({ group: "parent", sort: "name" }), "", "en");
    expect(nameGroups.map((g) => [g.folder, names(g.items)])).toEqual([
      ["~", ["notes"]],
      ["~/Projects", ["site-2", "site-10"]],
      ["~/Projects/ApexForge", ["vibeforge"]],
      ["~/Work", ["Atlas", "blog"]],
    ]);

    // Grouping + recent activity leads with the folder of the most active workspace.
    const recentGroups = groupWorkspaces(list, same, view({ group: "parent", sort: "recent" }), "", "en");
    expect(recentGroups.map((g) => [g.folder, names(g.items)])).toEqual([
      ["~/Work", ["blog", "Atlas"]],
      ["~/Projects", ["site-2", "site-10"]],
      ["~/Projects/ApexForge", ["vibeforge"]],
      ["~", ["notes"]],
    ]);

    // Empty match returns no groups.
    expect(groupWorkspaces(list, same, view({ group: "parent", filters: ["waiting", "synced"] }), "", "en")).toEqual([]);
  });

  it("searches names by letters in order, folders by substring, and git branches", () => {
    expect(names(viewWorkspaces(list, same, view({ sort: "name" }), "site", "en"))).toEqual(["site-2", "site-10"]);
    expect(names(viewWorkspaces(list, same, view({ filters: ["synced"] }), "site"))).toEqual(["site-2"]);
    expect(matchesSearch("vf", item("vibeforge"))).toBe(true);
    expect(matchesSearch("projects/bl", item("blog"))).toBe(true);
    expect(matchesSearch("copy-10", list[3])).toBe(true);
    expect(matchesSearch("zzz", item("blog"))).toBe(false);
    expect(matchesSearch("  ", item("blog"))).toBe(true);
  });

  it("persists view state and migrates legacy single-filter records", () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => store.set(key, val),
      },
    });

    expect(loadWorkspaceView()).toEqual(DEFAULT_WORKSPACE_VIEW);
    expect(isDefaultWorkspaceView(DEFAULT_WORKSPACE_VIEW)).toBe(true);

    // Legacy 2.22 format: { filter: "open", sort: "name" }
    store.set("vf.workspaces.view", JSON.stringify({ filter: "open", sort: "name" }));
    expect(loadWorkspaceView()).toEqual({ filters: ["open"], sort: "name", group: "none" });

    // Rich view format
    const custom: WorkspaceView = { filters: ["dirty", "open"], sort: "recent", group: "parent" };
    saveWorkspaceView({ ...custom, filters: toggleFilter(["dirty"], "open") });
    const loaded = loadWorkspaceView();
    expect(loaded).toEqual({ filters: ["open", "dirty"], sort: "recent", group: "parent" });
    expect(isDefaultWorkspaceView(loaded)).toBe(false);

    // Corrupt JSON falls back cleanly.
    store.set("vf.workspaces.view", "{bad");
    expect(loadWorkspaceView()).toEqual(DEFAULT_WORKSPACE_VIEW);
  });

  it("narrows workspaces by category tab, composes with search/sort/group, and persists the selected tab", () => {
    const tagged: Array<WorkspaceFacts & { categories?: string[] }> = [
      { ...list[0], categories: ["work"] },
      { ...list[1], categories: ["work", "clients"] },
      { ...list[2], categories: ["games"] },
      { ...list[3] },
    ];
    expect(names(workspacesInCategory(tagged, null))).toEqual(["vibeforge", "Atlas", "site-2", "site-10"]);
    const workOnly = workspacesInCategory(tagged, "work");
    expect(names(workOnly)).toEqual(["vibeforge", "Atlas"]);
    expect(names(viewWorkspaces(workOnly, same, view({ sort: "name" }), "at", "en"))).toEqual(["Atlas"]);

    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => store.set(key, val),
        removeItem: (key: string) => store.delete(key),
      },
    });
    expect(loadWorkspaceCategory()).toBeNull();
    saveWorkspaceCategory("games");
    expect(loadWorkspaceCategory()).toBe("games");
    saveWorkspaceCategory(null);
    expect(loadWorkspaceCategory()).toBeNull();
  });
});
