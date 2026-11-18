import { describe, expect, it } from "vitest";
import { matchesSearch, viewWorkspaces, type WorkspaceFacts } from "../../src/ui/workspace-view.js";

const item = (name: string, more: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({ name, path: `~/Projects/${name.toLowerCase()}`, open: false, waiting: false, synced: false, ...more });
const list = [item("vibeforge", { open: true }), item("Atlas", { waiting: true, open: true }), item("site-2", { synced: true }), item("site-10"), item("blog")];
const names = (items: WorkspaceFacts[]) => items.map((workspace) => workspace.name);
const same = (workspace: WorkspaceFacts) => workspace;

describe("workspace list view", () => {
  it("keeps your order unless asked to sort by name, which ignores case and reads numbers as numbers", () => {
    expect(names(viewWorkspaces(list, same, { filter: "all", sort: "manual" }, ""))).toEqual(["vibeforge", "Atlas", "site-2", "site-10", "blog"]);
    expect(names(viewWorkspaces(list, same, { filter: "all", sort: "name" }, "", "en"))).toEqual(["Atlas", "blog", "site-2", "site-10", "vibeforge"]);
  });

  it("filters to open, waiting or synced workspaces", () => {
    expect(names(viewWorkspaces(list, same, { filter: "open", sort: "manual" }, ""))).toEqual(["vibeforge", "Atlas"]);
    expect(names(viewWorkspaces(list, same, { filter: "waiting", sort: "manual" }, ""))).toEqual(["Atlas"]);
    expect(names(viewWorkspaces(list, same, { filter: "synced", sort: "manual" }, ""))).toEqual(["site-2"]);
  });

  it("searches names by letters in order and folders by a piece of them, together with the filter and sort", () => {
    expect(names(viewWorkspaces(list, same, { filter: "all", sort: "name" }, "site", "en"))).toEqual(["site-2", "site-10"]);
    expect(names(viewWorkspaces(list, same, { filter: "synced", sort: "manual" }, "site"))).toEqual(["site-2"]);
    expect(matchesSearch("vf", item("vibeforge"))).toBe(true);
    expect(matchesSearch("projects/bl", item("blog"))).toBe(true);
    expect(matchesSearch("zzz", item("blog"))).toBe(false);
    expect(matchesSearch("  ", item("blog"))).toBe(true);
  });
});
