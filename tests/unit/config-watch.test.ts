import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configTopics, watchConfig } from "../../electron/config-watch.js";
import { noteOwnDelete, writeJson } from "../../src/core/fsx.js";
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Waits for `check`, however long a busy machine takes, up to `ms`. */
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(20);
  };

  /** A folder being watched, once fs.watch has shown it reports (it can take a moment to start). */
  async function watched(subfolder: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-config-watch-"));
    fs.mkdirSync(path.join(dir, subfolder));
    const seen: Topic[][] = [];
    stop = watchConfig(dir, (topics) => seen.push(topics));
    for (let tries = 0; tries < 10 && !seen.length; tries += 1) {
      fs.writeFileSync(path.join(dir, "workspaces.json"), "{}");
      await until(() => seen.length > 0, 1000);
    }
    expect(seen.length).toBeGreaterThan(0);
    await handedOn(seen);
    seen.length = 0;
    return seen;
  }

  /**
   * An edit of its own to viby.md, waited for until it's handed on. Changes are handed on in the
   * order they happen, so by then anything changed before it has been handed on too, or never will
   * be: a condition to wait on in place of a fixed sleep.
   */
  async function handedOn(seen: Topic[][]) {
    const before = seen.length;
    fs.writeFileSync(path.join(dir, "viby.md"), `${Date.now()} ${Math.random()}\n`);
    await until(() => seen.slice(before).some((topics) => topics.includes("orchestrator")));
    expect(seen.slice(before).flat(), "viby.md was handed on").toContain("orchestrator");
  }

  it("hands on a burst of edits once, after they pause", async () => {
    const seen = await watched("routines");
    fs.writeFileSync(path.join(dir, "settings.json"), "{}");
    fs.writeFileSync(path.join(dir, "routines", "r.yaml"), "x: 1\n");
    fs.writeFileSync(path.join(dir, "settings.json.tmp"), "{}");
    await until(() => seen.length > 0);
    // Written after the burst was handed on: had any of the burst come again, it would be before this.
    await handedOn(seen);
    expect(seen).toHaveLength(2);
    expect([...seen[0]].sort()).toEqual(["routines", "settings"]);
    expect(seen[1]).toEqual(["orchestrator"]);
  });

  it("suppresses VibeForge's own atomic saves and noted deletes while still seeing external edits", async () => {
    const seen = await watched("tasks");
    writeJson(path.join(dir, "settings.json"), { notify: true });
    const ownTask = path.join(dir, "tasks", "t1.yaml");
    fs.writeFileSync(ownTask, "title: x\n");
    await until(() => seen.flat().includes("tasks"));
    expect(seen.flat()).not.toContain("settings");
    await handedOn(seen);
    seen.length = 0;

    noteOwnDelete(ownTask);
    fs.rmSync(ownTask, { force: true });
    writeJson(path.join(dir, "settings.json"), { notify: false });
    await handedOn(seen);
    expect(seen).toEqual([["orchestrator"]]);
    seen.length = 0;

    // An external hand-edit right after still triggers normally.
    fs.writeFileSync(path.join(dir, "settings.json"), '{"notify":true}\n');
    await until(() => seen.flat().includes("settings"));
    expect(seen.flat()).toContain("settings");
  });

  it("stops without a word for a folder it can't watch", () => {
    stop = watchConfig(path.join(os.tmpdir(), "vf-no-such-folder", String(Date.now())), () => undefined);
    expect(() => stop()).not.toThrow();
  });
});
