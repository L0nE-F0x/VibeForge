import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Store } from "../../src/core/store.js";
import { carryUnknown, formatVersion, shapeOf } from "../../src/core/store/carry.js";
import { SETTINGS_VERSION } from "../../src/core/store/config.js";
import { AGENT_VERSION } from "../../src/core/store/library.js";
import type { Agent } from "../../src/core/types.js";

// After going back a version, saving must not erase what the newer version wrote: settings.json and
// agent.yaml keep every field this version doesn't know through a save.

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function open(): Store {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "vf-carry-")), fs.mkdtempSync(path.join(os.tmpdir(), "vf-carry-")));
  stores.push(store);
  return store;
}

describe("carrying fields this version doesn't know", () => {
  it("adds the unknown fields of the file, nested ones too, and never takes a known one from it", () => {
    const shape = shapeOf({ a: 1, inner: { b: true }, list: [1] });
    shape.inner = { ...(shape.inner as object), optional: true };
    const raw = { a: 9, extra: { deep: [1, 2] }, inner: { b: false, optional: "old", later: "kept" }, list: [7, 8] };
    expect(carryUnknown({ a: 1, inner: { b: true }, list: [1] }, raw, shape)).toEqual({ a: 1, inner: { b: true, later: "kept" }, list: [1], extra: { deep: [1, 2] } });
    // A file that isn't an object, or a known field that has turned into something else, adds nothing.
    expect(carryUnknown({ a: 1 }, null, shape)).toEqual({ a: 1 });
    expect(carryUnknown({ a: 1, inner: { b: true } }, { inner: "flat" }, shape)).toEqual({ a: 1, inner: { b: true } });
  });

  it("keeps a newer version's format number, and writes this one's otherwise", () => {
    expect(formatVersion({ version: 3 }, 1)).toBe(3);
    expect(formatVersion({ version: 1 }, 2)).toBe(2);
    expect(formatVersion({ version: "9" }, 1)).toBe(1);
    expect(formatVersion(null, 1)).toBe(1);
  });
});

describe("settings.json through a save", () => {
  it("keeps what a newer version added, top level and inside a section, and the newer format number", () => {
    const store = open();
    const file = path.join(store.configRoot, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 4,
        defaultEngine: "codex",
        notify: true,
        workbench: { panes: 3, layout: ["a", "b"] },
        orchestrator: { engine: "claude", mode: "plan", model: "opus", effort: "high", projectsFolder: "", voiceStyle: "brief" },
        sync: { enabled: true, name: "desk", relays: false },
      }),
    );
    const read = store.readSettings();
    expect(read).not.toHaveProperty("workbench");
    store.writeSettings({ ...read, notify: false });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved).toMatchObject({
      version: 4,
      defaultEngine: "codex",
      notify: false,
      workbench: { panes: 3, layout: ["a", "b"] },
      orchestrator: { engine: "claude", model: "opus", effort: "high", voiceStyle: "brief" },
      sync: { enabled: true, name: "desk", relays: false },
    });
    // Read back, it's the same settings as before but for the one changed.
    expect(store.readSettings()).toEqual({ ...read, notify: false });

    // A field this version knows and clears stays cleared: the file's old value doesn't come back.
    const { effort: _effort, ...withoutEffort } = store.readSettings().orchestrator;
    store.writeSettings({ ...store.readSettings(), orchestrator: withoutEffort });
    const again = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(again.orchestrator).not.toHaveProperty("effort");
    expect(again.orchestrator.voiceStyle).toBe("brief");
    expect(again.workbench).toEqual({ panes: 3, layout: ["a", "b"] });
  });

  it("starts a new settings.json with this version's format number", () => {
    const store = open();
    store.readSettings();
    const saved = JSON.parse(fs.readFileSync(path.join(store.configRoot, "settings.json"), "utf8"));
    expect(saved.version).toBe(SETTINGS_VERSION);
    store.writeSettings({ ...store.readSettings(), tourDone: true });
    expect(JSON.parse(fs.readFileSync(path.join(store.configRoot, "settings.json"), "utf8"))).toMatchObject({ version: SETTINGS_VERSION, tourDone: true });
  });
});

describe("agent.yaml through a save", () => {
  const agent = (id: string): Agent => ({
    id,
    name: "Reviewer",
    engine: "claude",
    brief: "Review the diff.",
    memoryFile: "memory.md",
    places: [],
    skills: [],
    allowRoutines: true,
    goodAt: "",
    tier: "",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  });

  it("keeps the fields a newer version wrote into it, and its format number", () => {
    const store = open();
    store.writeAgent(agent("reviewer"));
    const file = path.join(store.configRoot, "agents", "reviewer", "agent.yaml");
    expect(parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: AGENT_VERSION, name: "Reviewer" });

    const newer = { ...parse(fs.readFileSync(file, "utf8")), version: 2, effort: "high", hooks: { before: ["lint"] } };
    fs.writeFileSync(file, JSON.stringify(newer));
    const read = store.getAgent("reviewer");
    expect(read).not.toHaveProperty("effort");
    store.writeAgent({ ...(read as Agent), brief: "Review the diff, then the tests." });
    expect(parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 2, brief: "Review the diff, then the tests.", effort: "high", hooks: { before: ["lint"] } });
    expect(store.getAgent("reviewer")?.brief).toBe("Review the diff, then the tests.");
  });
});
