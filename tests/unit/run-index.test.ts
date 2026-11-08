import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { allocateRunDir, normalizeRun } from "../../src/core/runs.js";
import { Store } from "../../src/core/store.js";
import type { RunMeta } from "../../src/core/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-index-"));
}

/** A data folder with one finished run in it, indexed once and closed. */
function dataWithRun(): { configRoot: string; dataRoot: string; id: string; index: string } {
  const configRoot = tempDir();
  const dataRoot = tempDir();
  const store = new Store(configRoot, dataRoot);
  const { id, dir } = allocateRunDir(dataRoot, new Date("2026-11-01T09:00:00Z"), "Notes");
  store.saveRun(normalizeRun({ id, dir, origin: "routine", status: "exited", startedAt: "2026-11-01T09:00:00.000Z", title: "Notes", routineId: "daily" }) as RunMeta);
  store.close();
  return { configRoot, dataRoot, id, index: path.join(dataRoot, "index.sqlite") };
}

describe("the run index", () => {
  it("sets aside an index that isn't a database and builds it again from the run folders", () => {
    const { configRoot, dataRoot, id, index } = dataWithRun();
    fs.writeFileSync(index, "not sqlite at all\n".repeat(300));
    const store = new Store(configRoot, dataRoot);
    expect(store.queryRuns({ routineId: "daily" }).map((run) => run.id)).toEqual([id]);
    store.close();
    expect(fs.readFileSync(`${index}.broken`, "utf8")).toMatch(/^not sqlite at all/);
  });

  it("does the same for a damaged one, keeping an earlier broken copy too", () => {
    const { configRoot, dataRoot, id, index } = dataWithRun();
    fs.writeFileSync(`${index}.broken`, "an older one");
    // A real header with its pages overwritten: SQLite opens it, then finds it malformed.
    const bytes = fs.readFileSync(index);
    expect(bytes.length).toBeGreaterThan(4096);
    bytes.fill(0x5a, 4096);
    fs.writeFileSync(index, bytes);
    expect(() => new DatabaseSync(index).prepare("SELECT id FROM runs").all()).toThrow(/malformed/);
    const store = new Store(configRoot, dataRoot);
    expect(store.getRun(id)?.title).toBe("Notes");
    store.close();
    expect(fs.readFileSync(`${index}.broken`, "utf8")).toBe("an older one");
    expect(fs.readdirSync(dataRoot).filter((name) => /^index\.sqlite\.broken-\d+$/.test(name))).toHaveLength(1);
  });

  it("still fails on a problem that setting the file aside wouldn't fix", () => {
    const configRoot = tempDir();
    const dataRoot = tempDir();
    fs.mkdirSync(path.join(dataRoot, "index.sqlite"));
    expect(() => new Store(configRoot, dataRoot)).toThrow();
    expect(fs.existsSync(path.join(dataRoot, "index.sqlite.broken"))).toBe(false);
  });

  it("matches a %, _ or \\ typed in the search as itself, not as a wildcard", () => {
    const store = storeWithRuns(["100% done", "1000 left", "my_file", "myXfile", "back\\slash", "backslash"]);
    const titles = (search: string) => store.queryRuns({ search }).map((run) => run.title);
    expect(titles("100%")).toEqual(["100% done"]);
    expect(titles("my_file")).toEqual(["my_file"]);
    expect(titles("back\\slash")).toEqual(["back\\slash"]);
    store.close();
  });

  it("reads a limit that isn't a whole number, or is below zero, as the default", () => {
    const store = storeWithRuns(["Notes one", "Notes two", "Notes three"]);
    for (const limit of [Number.NaN, -3, 1.5, Number.POSITIVE_INFINITY]) {
      expect(store.queryRuns({ limit })).toHaveLength(3);
      expect(store.searchRuns("notes", limit)).toHaveLength(3);
    }
    expect(store.queryRuns({ limit: 2 }).map((run) => run.title)).toEqual(["Notes three", "Notes two"]);
    expect(store.queryRuns({ limit: 0 })).toHaveLength(1);
    expect(store.searchRuns("notes", 1)).toHaveLength(1);
    store.close();
  });
});

/** A store with one finished run per title, a minute apart, the first title oldest. */
function storeWithRuns(titles: string[]): Store {
  const dataRoot = tempDir();
  const store = new Store(tempDir(), dataRoot);
  titles.forEach((title, n) => {
    const startedAt = new Date(Date.UTC(2026, 10, 1, 9, n));
    const { id, dir } = allocateRunDir(dataRoot, startedAt, title);
    store.saveRun(normalizeRun({ id, dir, origin: "code", status: "exited", startedAt: startedAt.toISOString(), title }) as RunMeta);
  });
  return store;
}
