import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configTopics, watchConfig } from "../../electron/config-watch.js";
import type { Topic } from "../../src/core/types.js";

describe("what a config file change touches", () => {
  it("maps each file to the views that show it", () => {
    expect(configTopics(path.join("agents", "reviewer", "agent.md"))).toEqual(["agents", "routines", "tasks"]);
    expect(configTopics(path.join("skills", "lint", "SKILL.md"))).toEqual(["skills", "agents"]);
    expect(configTopics(path.join("routines", "nightly.yaml"))).toEqual(["routines"]);
    expect(configTopics(path.join("tasks", "t1.md"))).toEqual(["tasks"]);
    expect(configTopics("engines.json")).toEqual(["engines", "agents", "routines", "tasks"]);
    expect(configTopics("settings.json")).toEqual(["settings"]);
    expect(configTopics("workspaces.json")).toEqual(["workspaces"]);
  });

  it("ignores layouts, half-written files and anything else", () => {
    expect(configTopics(path.join("layouts", "w1.json"))).toEqual([]);
    expect(configTopics("settings.json.tmp")).toEqual([]);
    expect(configTopics(path.join("agents", "a.md.tmp"))).toEqual([]);
    expect(configTopics("notes.txt")).toEqual([]);
    // Only the top-level file counts: a settings.json inside an agent is that agent's.
    expect(configTopics(path.join("other", "settings.json"))).toEqual([]);
  });
});

describe("watching the config folder", () => {
  let dir = "";
  let stop: () => void = () => {};
  afterEach(() => {
    stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands on a burst of edits once, after they pause", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-config-watch-"));
    fs.mkdirSync(path.join(dir, "routines"));
    const seen: Topic[][] = [];
    stop = watchConfig(dir, (topics) => seen.push(topics));
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (check: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(20);
    };
    // fs.watch can take a moment to start reporting: an edit it hands on shows it has, however
    // long a busy machine takes.
    for (let tries = 0; tries < 10 && !seen.length; tries += 1) {
      fs.writeFileSync(path.join(dir, "workspaces.json"), "{}");
      await until(() => seen.length > 0, 1000);
    }
    expect(seen.length).toBeGreaterThan(0);
    seen.length = 0;
    fs.writeFileSync(path.join(dir, "settings.json"), "{}");
    fs.writeFileSync(path.join(dir, "routines", "r.yaml"), "x: 1\n");
    fs.writeFileSync(path.join(dir, "settings.json.tmp"), "{}");
    await until(() => seen.length > 0, 10_000);
    // Twice the pause it waits for, so a second hand-on would have come by now.
    await sleep(500);
    expect(seen).toHaveLength(1);
    expect([...seen[0]].sort()).toEqual(["routines", "settings"]);
  });

  it("stops without a word for a folder it can't watch", () => {
    stop = watchConfig(path.join(os.tmpdir(), "vf-no-such-folder", String(Date.now())), () => undefined);
    expect(() => stop()).not.toThrow();
  });
});
