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
});
