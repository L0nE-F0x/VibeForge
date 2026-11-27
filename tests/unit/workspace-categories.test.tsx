import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
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
import { HomeWorkspacesSection } from "../../src/ui/views/Home.js";
import { categoryReorderTarget, WorkspaceTabs } from "../../src/ui/views/code/WorkspaceTabs.js";
import { saveWorkspaceCategory } from "../../src/ui/workspace-view.js";
import { setup, tempDir } from "./fixtures/service-harness.js";

describe("workspace categories", () => {
  afterEach(() => saveWorkspaceCategory(null));
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
    expect(customHtml).toContain('data-tab-id="games" class="ws-tab" aria-selected="true" tabindex="0" data-category-index="1" draggable="true"');
    const allButton = customHtml.match(/<button[^>]*data-tab-id="__all__"[^>]*>/)?.[0] ?? "";
    expect(allButton).not.toContain('draggable="true"');
  });

  it("renders shared category tabs on Home, filters workspaces by active tab, and reflects category mutations", () => {
    const workspaces = [
      { id: "api", name: "Core API", path: "/home/me/core-api", dockUrl: "", categories: ["work"] },
      { id: "engine", name: "Game Engine", path: "/home/me/engine", dockUrl: "", categories: ["games", "work"] },
      { id: "ops", name: "Deploy Box", path: "/home/me/ops", dockUrl: "", categories: ["production"] },
      { id: "notes", name: "Scratch Notes", path: "/home/me/notes", dockUrl: "" },
    ];
    const renderHome = (cats: Array<{ id: string; name: string }>, list = workspaces) =>
      renderToStaticMarkup(
        <ToastProvider>
          <HomeWorkspacesSection
            workspaces={list}
            categories={cats}
            home="/home/me"
            live={[]}
            attention={new Map()}
            onOpen={() => undefined}
          />
        </ToastProvider>,
      );

    // No workspaces and no categories: hides the tab strip and shows empty message.
    const emptyBoth = renderHome([], []);
    expect(emptyBoth).not.toContain('role="tablist"');
    expect(emptyBoth).toContain("No workspaces yet.");

    // Shared categories derive tabs in order with All always first and + New category button.
    let categories = [
      { id: "work", name: "Work" },
      { id: "games", name: "Games" },
      { id: "production", name: "Production" },
    ];
    const allHtml = renderHome(categories);
    expect(allHtml).toContain('role="tablist"');
    expect(allHtml).toContain("New category tab");
    expect(allHtml.indexOf('data-tab-id="__all__"')).toBeLessThan(allHtml.indexOf('data-tab-id="work"'));
    expect(allHtml.indexOf('data-tab-id="work"')).toBeLessThan(allHtml.indexOf('data-tab-id="games"'));
    expect(allHtml.indexOf('data-tab-id="games"')).toBeLessThan(allHtml.indexOf('data-tab-id="production"'));
    expect(allHtml).toContain("Core API");
    expect(allHtml).toContain("Game Engine");
    expect(allHtml).toContain("Deploy Box");
    expect(allHtml).toContain("Scratch Notes");

    // Selecting a category filters Home's workspace tiles just like the panel.
    saveWorkspaceCategory("games");
    const gamesHtml = renderHome(categories);
    expect(gamesHtml).toContain('data-tab-id="games" class="ws-tab" aria-selected="true"');
    expect(gamesHtml).toContain("Game Engine");
    expect(gamesHtml).not.toContain("Core API");
    expect(gamesHtml).not.toContain("Deploy Box");
    expect(gamesHtml).not.toContain("Scratch Notes");

    // Renaming and reordering categories immediately reflects in Home's tabs.
    categories = [
      { id: "production", name: "Production" },
      { id: "games", name: "Indie Games" },
      { id: "work", name: "Work" },
    ];
    const reorderedHtml = renderHome(categories);
    expect(reorderedHtml).toContain("Indie Games");
    expect(reorderedHtml.indexOf('data-tab-id="__all__"')).toBeLessThan(reorderedHtml.indexOf('data-tab-id="production"'));
    expect(reorderedHtml.indexOf('data-tab-id="production"')).toBeLessThan(reorderedHtml.indexOf('data-tab-id="games"'));
    expect(reorderedHtml.indexOf('data-tab-id="games"')).toBeLessThan(reorderedHtml.indexOf('data-tab-id="work"'));

    // Empty custom category shows empty-category prompt and Show all button.
    saveWorkspaceCategory("empty-cat");
    const emptyCatHtml = renderHome([...categories, { id: "empty-cat", name: "Empty Cat" }]);
    expect(emptyCatHtml).toContain("No workspaces in Empty Cat yet.");
    expect(emptyCatHtml).toContain("Show all workspaces");

    // Removing the currently selected category falls back to All automatically.
    const removedHtml = renderHome(categories);
    expect(removedHtml).toContain('data-tab-id="__all__" class="ws-tab" aria-selected="true"');
    expect(removedHtml).toContain("Core API");
    expect(removedHtml).toContain("Scratch Notes");

    // Single custom category tab is not draggable (while workspace tiles remain draggable onto it);
    // 2+ custom categories are draggable while All stays un-draggable.
    const singleHtml = renderHome([{ id: "work", name: "Work" }]);
    const singleWorkTab = singleHtml.match(/<button[^>]*data-tab-id="work"[^>]*>/)?.[0] ?? "";
    const singleAllTab = singleHtml.match(/<button[^>]*data-tab-id="__all__"[^>]*>/)?.[0] ?? "";
    expect(singleWorkTab).toContain('draggable="false"');
    expect(singleAllTab).not.toContain('draggable="true"');
    expect(singleHtml).toContain('class="run-row" draggable="true"');

    const multiWorkTab = allHtml.match(/<button[^>]*data-tab-id="work"[^>]*>/)?.[0] ?? "";
    const multiAllTab = allHtml.match(/<button[^>]*data-tab-id="__all__"[^>]*>/)?.[0] ?? "";
    expect(multiWorkTab).toContain('draggable="true"');
    expect(multiAllTab).not.toContain('draggable="true"');
  });

  it("computes valid drag-reorder targets and updates persisted category order", () => {
    expect(categoryReorderTarget(0, 0, 1)).toBeNull();
    expect(categoryReorderTarget(0, 0, 3)).toBeNull();
    expect(categoryReorderTarget(0, 1, 3)).toBeNull();
    expect(categoryReorderTarget(1, 1, 3)).toBeNull();
    expect(categoryReorderTarget(1, 2, 3)).toBeNull();
    expect(categoryReorderTarget(2, 2, 3)).toBeNull();
    expect(categoryReorderTarget(2, 3, 3)).toBeNull();

    // Dragging first tab to the end, and dragging last tab right after All.
    expect(categoryReorderTarget(0, 3, 3)).toBe(2);
    expect(categoryReorderTarget(2, 0, 3)).toBe(0);
    expect(categoryReorderTarget(0, 2, 3)).toBe(1);
    expect(categoryReorderTarget(2, 1, 3)).toBe(1);

    let file = addCategoryRecord({ workspaces: [], lastWorkspaceId: null }, "Work").file;
    file = addCategoryRecord(file, "Games").file;
    file = addCategoryRecord(file, "Production").file;

    // Move "Production" (index 2) to slot 0 (right after All).
    const toFront = categoryReorderTarget(2, 0, file.categories!.length)!;
    file = moveCategoryRecord(file, "production", toFront);
    expect(file.categories?.map((cat) => cat.id)).toEqual(["production", "work", "games"]);

    // Move "Production" (index 0) past "Work" (slot 2 -> index 1).
    const toMiddle = categoryReorderTarget(0, 2, file.categories!.length)!;
    file = moveCategoryRecord(file, "production", toMiddle);
    expect(file.categories?.map((cat) => cat.id)).toEqual(["work", "production", "games"]);
  });
});
