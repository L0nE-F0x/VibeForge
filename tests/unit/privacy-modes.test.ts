import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLayout } from "../../src/core/layout.js";
import { LogFile } from "../../src/core/log.js";
import { compressRun } from "../../src/core/run-storage.js";
import { allocateRunDir, writeRunMeta } from "../../src/core/runs.js";
import { Store } from "../../src/core/store.js";
import { RunIndex } from "../../src/core/store/run-index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("private VibeForge folders and files", () => {
  it("tightens pre-existing config, data, runs, and logs directories to 0700 on start", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vf-perms-"));
    tempDirs.push(base);
    const configRoot = path.join(base, "config");
    const dataRoot = path.join(base, "data");
    for (const dir of [
      configRoot,
      dataRoot,
      path.join(configRoot, "agents"),
      path.join(dataRoot, "runs"),
      path.join(dataRoot, "logs"),
    ]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(dir, 0o755);
    }

    ensureLayout(configRoot, dataRoot);

    for (const dir of [
      configRoot,
      dataRoot,
      path.join(configRoot, "agents"),
      path.join(configRoot, "skills"),
      path.join(configRoot, "routines"),
      path.join(configRoot, "tasks"),
      path.join(configRoot, "layouts"),
      path.join(dataRoot, "runs"),
      path.join(dataRoot, "scratch"),
      path.join(dataRoot, "logs"),
    ]) {
      expect(modeOf(dir), dir).toBe(0o700);
    }
  });

  it("creates 0700 run directories and 0600 stores, index, logs, and compressed archives", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vf-files-"));
    tempDirs.push(base);
    const configRoot = path.join(base, "config");
    const dataRoot = path.join(base, "data");
    ensureLayout(configRoot, dataRoot);

    // Pre-existing loose log and SQLite files get tightened to 0600 on open/write.
    const logPath = path.join(dataRoot, "logs", "vibeforge.log");
    fs.writeFileSync(logPath, "old\n", { mode: 0o644 });
    fs.chmodSync(logPath, 0o644);
    const log = new LogFile(logPath);
    log.info("started");
    expect(modeOf(path.dirname(logPath))).toBe(0o700);
    expect(modeOf(logPath)).toBe(0o600);

    const dbPath = path.join(dataRoot, "index.sqlite");
    fs.writeFileSync(dbPath, "", { mode: 0o644 });
    fs.chmodSync(dbPath, 0o644);
    const index = new RunIndex(dataRoot);
    expect(modeOf(dbPath)).toBe(0o600);

    const run = allocateRunDir(dataRoot, new Date("2026-11-24T00:00:00Z"), "test-run");
    expect(modeOf(path.join(dataRoot, "runs"))).toBe(0o700);
    expect(modeOf(run.dir)).toBe(0o700);
    writeRunMeta({
      id: run.id,
      origin: "code",
      title: "Shell",
      agentId: null,
      routineId: null,
      taskId: null,
      chatId: null,
      workspaceId: null,
      engine: "claude",
      argv: [],
      cwd: base,
      prompt: "",
      startedAt: "2026-11-24T00:00:00Z",
      endedAt: "2026-11-24T00:01:00Z",
      status: "exited",
      exitCode: 0,
      signal: null,
      stopRequested: false,
      openedAt: null,
      notifiedAt: null,
      dir: run.dir,
      error: null,
      changes: null,
      gitStart: null,
      continuedFrom: null,
    });
    expect(modeOf(path.join(run.dir, "meta.json"))).toBe(0o600);

    const bigScrollback = path.join(run.dir, "scrollback.txt");
    fs.writeFileSync(bigScrollback, "x".repeat(20_000), { mode: 0o644 });
    await compressRun(run.dir);
    expect(modeOf(`${bigScrollback}.gz`)).toBe(0o600);

    const store = new Store(configRoot, dataRoot);
    store.writeWorkspaces({ lastWorkspaceId: null, workspaces: [] });
    store.writeEngineRows([]);
    store.writeAgent({
      id: "helper",
      name: "Helper",
      engine: "claude",
      brief: "Help.",
      memoryFile: "memory.md",
      places: [],
      skills: [],
      allowRoutines: false,
      goodAt: "",
      tier: "",
      createdAt: "2026-11-24T00:00:00Z",
      updatedAt: "2026-11-24T00:00:00Z",
    });
    store.writeSkill({ id: "review", name: "Review", description: "Check tests.", body: "Check tests." });
    expect(modeOf(path.join(configRoot, "workspaces.json"))).toBe(0o600);
    expect(modeOf(path.join(configRoot, "engines.json"))).toBe(0o600);
    expect(modeOf(path.join(configRoot, "agents", "helper"))).toBe(0o700);
    expect(modeOf(path.join(configRoot, "agents", "helper", "memory.md"))).toBe(0o600);
    expect(modeOf(path.join(configRoot, "agents", "helper", "agent.yaml"))).toBe(0o600);
    expect(modeOf(path.join(configRoot, "skills", "review"))).toBe(0o700);
    expect(modeOf(path.join(configRoot, "skills", "review", "SKILL.md"))).toBe(0o600);

    index.close();
    store.close();
  });
});
