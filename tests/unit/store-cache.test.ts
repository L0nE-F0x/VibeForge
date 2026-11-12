import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/core/store.js";
import { createTask } from "../../src/core/tasks.js";
import type { Agent } from "../../src/core/types.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-cache-"));

/** Back-date a file, as if it last changed a minute ago: the cache keeps only files that hold still. */
function settle(file: string): void {
  const then = Date.now() / 1000 - 60;
  fs.utimesSync(file, then, then);
}

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    engine: "claude",
    brief: "",
    memoryFile: "memory.md",
    places: [],
    skills: [],
    allowRoutines: true,
    voice: "",
    goodAt: "",
    tier: "",
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
  };
}

/** A store with settings, engines and one agent on disk, all settled, and a count of each file's reads. */
function settledStore() {
  const config = tempDir();
  const store = new Store(config, tempDir());
  const files = {
    settings: path.join(config, "settings.json"),
    engines: path.join(config, "engines.json"),
    agent: path.join(config, "agents", "ada", "agent.yaml"),
  };
  store.readSettings();
  store.readEngineRows();
  store.writeAgent(agent("ada", "Ada"));
  for (const file of Object.values(files)) settle(file);
  const read = vi.spyOn(fs, "readFileSync");
  const reads = (file: string) => read.mock.calls.filter(([name]) => name === file).length;
  return { store, files, reads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("store read cache", () => {
  it("parses settings, engines and an agent once while their files hold still", () => {
    const { store, files, reads } = settledStore();
    for (let round = 0; round < 5; round += 1) {
      expect(store.readSettings().defaultEngine).toBe("claude");
      expect(store.readEngineRows().some((row) => row.id === "claude")).toBe(true);
      expect(store.getAgent("ada")?.name).toBe("Ada");
    }
    expect(store.listAgents().map((item) => item.name)).toEqual(["Ada"]);
    expect([reads(files.settings), reads(files.engines), reads(files.agent)]).toEqual([1, 1, 1]);
  });

  it("notices a hand edit, even one that keeps the size and the modified time", () => {
    const { store, files } = settledStore();
    expect(store.getAgent("ada")?.name).toBe("Ada");
    const before = fs.statSync(files.agent);
    fs.writeFileSync(files.agent, fs.readFileSync(files.agent, "utf8").replace("name: Ada", "name: Bob"));
    fs.utimesSync(files.agent, before.atime, before.mtime);
    expect(fs.statSync(files.agent).size).toBe(before.size);
    expect(store.getAgent("ada")?.name).toBe("Bob");

    expect(store.readSettings().notify).toBe(true);
    const settings = JSON.parse(fs.readFileSync(files.settings, "utf8"));
    fs.writeFileSync(files.settings, JSON.stringify({ ...settings, notify: false }));
    expect(store.readSettings().notify).toBe(false);

    expect(store.readEngineRows().find((row) => row.id === "claude")?.label).not.toBe("Hand-made");
    const engines = JSON.parse(fs.readFileSync(files.engines, "utf8"));
    engines.engines = engines.engines.map((row: { id: string }) => (row.id === "claude" ? { ...row, label: "Hand-made" } : row));
    fs.writeFileSync(files.engines, JSON.stringify(engines));
    expect(store.readEngineRows().find((row) => row.id === "claude")?.label).toBe("Hand-made");

    fs.rmSync(path.dirname(files.agent), { recursive: true });
    expect(store.getAgent("ada")).toBeNull();
  });

  it("sees the store's own writes at once", () => {
    const { store } = settledStore();
    store.writeSettings({ ...store.readSettings(), terminalFontSize: 17 });
    expect(store.readSettings().terminalFontSize).toBe(17);
    store.writeEngineRows(store.readEngineRows().filter((row) => row.id !== "codex"));
    expect(store.readEngineRows().some((row) => row.id === "codex")).toBe(false);
    store.writeAgent({ ...agent("ada", "Ada"), goodAt: "tests" });
    expect(store.getAgent("ada")?.goodAt).toBe("tests");
    // Deleting goes through the trash (library.ts): the folder is moved away, and the next read sees it gone.
    fs.rmSync(path.join(store.configRoot, "agents", "ada"), { recursive: true });
    expect(store.getAgent("ada")).toBeNull();
  });

  it("hands each caller its own copy", () => {
    const { store } = settledStore();
    const first = store.getAgent("ada")!;
    first.name = "Changed";
    first.places.push("/somewhere");
    const settings = store.readSettings();
    settings.rail.order.push("tasks");
    store.readEngineRows()[0].args.push("--extra");
    expect(store.getAgent("ada")).toMatchObject({ name: "Ada", places: [] });
    expect(store.readSettings().rail.order).toEqual([]);
    expect(store.readEngineRows()[0].args).not.toContain("--extra");
  });

  it("parses a file that changed a moment ago on every read", () => {
    const { store, files, reads } = settledStore();
    fs.appendFileSync(files.agent, "\n");
    store.getAgent("ada");
    store.getAgent("ada");
    expect(reads(files.agent)).toBe(2);
  });

  it("parses tasks, routines, workspaces and chats once while they hold still, and sees its own writes at once", () => {
    const config = tempDir();
    const data = tempDir();
    const store = new Store(config, data);
    const task = createTask({ title: "Tidy", body: "", agentId: null, workspaceId: null, now: new Date("2026-11-08T10:00:00Z") });
    store.writeTask(task);
    store.writeWorkspaces({ workspaces: [{ id: "shop", name: "Shop", path: "/tmp/shop", dockUrl: "" }], lastWorkspaceId: "shop" });
    store.writeChat({ id: "c1", title: "Hi", agentId: null, engine: "claude", cwd: "/tmp", runIds: [], createdAt: "", updatedAt: "" });
    const files = {
      task: path.join(config, "tasks", `${task.id}.yaml`),
      workspaces: path.join(config, "workspaces.json"),
      chats: path.join(data, "chats.json"),
    };
    for (const file of Object.values(files)) settle(file);
    const read = vi.spyOn(fs, "readFileSync");
    const reads = (file: string) => read.mock.calls.filter(([name]) => name === file).length;
    for (let round = 0; round < 5; round += 1) {
      expect(store.listTasks().map((item) => item.title)).toEqual(["Tidy"]);
      expect(store.getTask(task.id)?.title).toBe("Tidy");
      expect(store.readWorkspaces().workspaces[0].name).toBe("Shop");
      expect(store.getChat("c1")?.title).toBe("Hi");
    }
    expect([reads(files.task), reads(files.workspaces), reads(files.chats)]).toEqual([1, 1, 1]);
    store.writeTask({ ...task, title: "Tidy up" });
    store.writeWorkspaces({ workspaces: [{ id: "shop", name: "Store", path: "/tmp/shop", dockUrl: "" }], lastWorkspaceId: "shop" });
    store.writeChat({ id: "c1", title: "Hello", agentId: null, engine: "claude", cwd: "/tmp", runIds: [], createdAt: "", updatedAt: "" });
    expect(store.getTask(task.id)?.title).toBe("Tidy up");
    expect(store.readWorkspaces().workspaces[0].name).toBe("Store");
    expect(store.getChat("c1")?.title).toBe("Hello");
    store.deleteTask(task.id);
    expect(store.getTask(task.id)).toBeNull();
    expect(store.listTasks()).toEqual([]);
    store.close();
  });
});
