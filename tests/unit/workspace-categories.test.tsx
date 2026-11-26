import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import {
  addCategoryRecord,
  addWorkspaceRecord,
  moveCategoryRecord,
  removeCategoryRecord,
  renameCategoryRecord,
  setWorkspaceCategoryRecord,
  updateWorkspaceRecord,
} from "../../src/core/workspaces.js";
import { ToastProvider } from "../../src/ui/state.js";
import { WorkspaceTabs } from "../../src/ui/views/code/WorkspaceTabs.js";
import { setup, tempDir } from "./fixtures/service-harness.js";

describe("workspace categories", () => {
  it("adds, renames, reorders, assigns and deletes categories without removing any workspaces", () => {
    const dirA = tempDir();
    const dirB = tempDir();
    let file = addWorkspaceRecord({ workspaces: [], lastWorkspaceId: null }, dirA);
    file = addWorkspaceRecord(file, dirB);
    const [wsA, wsB] = file.workspaces;

    // Adding a tab named "All" uses a safe non-colliding id, and duplicates disambiguate.
    const stockNamed = addCategoryRecord(file, "All");
    expect(stockNamed.category).toEqual({ id: "category", name: "All" });

    const games = addCategoryRecord(file, "Games");
    const work = addCategoryRecord(games.file, "Work Projects");
    const gamesDup = addCategoryRecord(work.file, "Games");
    expect(games.category.id).toBe("games");
    expect(work.category.id).toBe("work-projects");
    expect(gamesDup.category.id).toBe("games-2");

    file = renameCategoryRecord(gamesDup.file, gamesDup.category.id, "  Fun   Stuff ");
    expect(file.categories?.find((cat) => cat.id === "games-2")?.name).toBe("Fun Stuff");

    file = moveCategoryRecord(file, "games-2", 0);
    expect(file.categories?.map((cat) => cat.id)).toEqual(["games-2", "games", "work-projects"]);

    file = setWorkspaceCategoryRecord(file, [wsA.id, wsB.id], "games", true);
    file = setWorkspaceCategoryRecord(file, [wsA.id], "work-projects", true);
    expect(file.workspaces.find((w) => w.id === wsA.id)?.categories).toEqual(["games", "work-projects"]);
    expect(file.workspaces.find((w) => w.id === wsB.id)?.categories).toEqual(["games"]);

    // Adding an existing folder with a categoryId tags it automatically.
    file = addWorkspaceRecord(file, dirB, "games-2");
    expect(file.workspaces.find((w) => w.id === wsB.id)?.categories).toEqual(["games", "games-2"]);

    // Removing a category leaves all workspaces intact and omits empty categories arrays.
    file = removeCategoryRecord(file, "games");
    expect(file.workspaces.map((w) => w.id)).toEqual([wsA.id, wsB.id]);
    expect(file.workspaces.find((w) => w.id === wsA.id)?.categories).toEqual(["work-projects"]);

    file = removeCategoryRecord(file, "work-projects");
    file = removeCategoryRecord(file, "games-2");
    expect(file.categories).toBeUndefined();
    expect(file.workspaces.every((w) => !("categories" in w))).toBe(true);
    expect(updateWorkspaceRecord(file, wsA.id, { categories: ["nonexistent"] }).workspaces[0]).not.toHaveProperty("categories");
  });

  it("persists categories in workspaces.json and strips dangling category references", () => {
    const config = tempDir();
    const data = tempDir();
    const store = new Store(config, data);
    const folder = tempDir();
    const filePath = path.join(config, "workspaces.json");

    store.writeWorkspaces({
      workspaces: [{ id: "game-1", name: "Game", path: folder, dockUrl: "", categories: ["games", "stale-id"] }],
      lastWorkspaceId: "game-1",
      categories: [{ id: "games", name: "Games" }, { id: "all", name: "Ignored" }],
    });
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      categories?: Array<{ id: string; name: string }>;
      workspaces: Array<{ id: string; categories?: string[] }>;
    };
    expect(saved.categories).toEqual([{ id: "games", name: "Games" }]);
    expect(saved.workspaces[0].categories).toEqual(["games"]);

    const store2 = new Store(config, data);
    expect(store2.readWorkspaces()).toEqual({
      workspaces: [{ id: "game-1", name: "Game", path: folder, dockUrl: "", categories: ["games"] }],
      lastWorkspaceId: "game-1",
      categories: [{ id: "games", name: "Games" }],
    });
    store.close();
    store2.close();
  });

  it("supports category CRUD, undo on deleteCategory, and undo on removeWorkspace in TeamService", async () => {
    const ctx = setup();
    const second = tempDir();
    const { category: games } = ctx.svc.addCategory("Games");
    const { category: work } = ctx.svc.addCategory("Work");
    const ws1 = ctx.svc.addWorkspace(ctx.place, games.id).workspaces[0];
    const ws2 = ctx.svc.addWorkspace(second).workspaces[1];
    ctx.svc.setWorkspaceCategory([ws1.id, ws2.id], work.id, true);
    ctx.svc.renameCategory(games.id, "Indie Games");
    ctx.svc.moveCategory(work.id, 0);
    expect(ctx.svc.listWorkspaces().categories).toEqual([
      { id: "work", name: "Work" },
      { id: "games", name: "Indie Games" },
    ]);

    ctx.svc.updateWorkspace(ws2.id, { categories: [games.id, work.id] });
    expect(ctx.svc.listWorkspaces().workspaces[1].categories).toEqual([games.id, work.id]);
    ctx.svc.updateWorkspace(ws2.id, { categories: [work.id] });
    expect(() => ctx.svc.addCategory("   ")).toThrow("Enter a category name.");
    expect(() => ctx.svc.renameCategory(work.id, " ")).toThrow("Enter a category name.");
    expect(() => ctx.svc.deleteCategory("missing")).toThrow("That category is gone.");

    // Deleting a category keeps all workspaces and supports Undo with memberships restored.
    const delCat = ctx.svc.deleteCategory(games.id);
    expect(ctx.svc.listWorkspaces().categories).toEqual([{ id: "work", name: "Work" }]);
    expect(ctx.svc.listWorkspaces().workspaces.map((w) => w.id)).toEqual([ws1.id, ws2.id]);
    expect(ctx.svc.listWorkspaces().workspaces[0].categories).toEqual(["work"]);

    ctx.svc.undoDelete(delCat.undo);
    expect(ctx.svc.listWorkspaces().categories).toEqual([
      { id: "work", name: "Work" },
      { id: "games", name: "Indie Games" },
    ]);
    expect(ctx.svc.listWorkspaces().workspaces[0].categories).toEqual(["work", "games"]);

    // Removing a workspace and undoing preserves its category memberships.
    const delWs = await ctx.svc.removeWorkspace(ws1.id);
    ctx.svc.undoDelete(delWs.undo);
    expect(ctx.svc.listWorkspaces().workspaces[0].categories).toEqual(["work", "games"]);
    ctx.svc.close();
  });

  it("renders WorkspaceTabs with stock All tab, custom category tabs, counts and add button", () => {
    const workspaces = [
      { id: "a", name: "A", path: "/tmp/a", dockUrl: "", categories: ["work"] },
      { id: "b", name: "B", path: "/tmp/b", dockUrl: "", categories: ["games", "work"] },
      { id: "c", name: "C", path: "/tmp/c", dockUrl: "" },
    ];
    const emptyHtml = renderToStaticMarkup(
      <ToastProvider>
        <WorkspaceTabs
          categories={[]}
          workspaces={workspaces}
          activeCategory={null}
          onSelect={() => undefined}
          draggingWorkspace={false}
          onDropWorkspace={() => undefined}
        />
      </ToastProvider>,
    );
    expect(emptyHtml).toContain('role="tablist"');
    expect(emptyHtml).toContain("All");
    expect(emptyHtml).toContain(">3<");
    expect(emptyHtml).toContain("Category");

    const customHtml = renderToStaticMarkup(
      <ToastProvider>
        <WorkspaceTabs
          categories={[
            { id: "work", name: "Work" },
            { id: "games", name: "Games" },
          ]}
          workspaces={workspaces}
          activeCategory="games"
          onSelect={() => undefined}
          draggingWorkspace={false}
          onDropWorkspace={() => undefined}
        />
      </ToastProvider>,
    );
    expect(customHtml).toContain("Work");
    expect(customHtml).toContain(">2<");
    expect(customHtml).toContain("Games");
    expect(customHtml).toContain(">1<");
    expect(customHtml).toContain('data-tab-id="games" class="ws-tab" aria-selected="true"');
    expect(customHtml).toContain('class="ws-tab-more"');
  });
});
