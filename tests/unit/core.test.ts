import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { whichBin, withAvailability } from "../../src/core/engines.js";
import { shellQuote } from "../../src/core/files.js";
import { snapshotGit } from "../../src/core/git.js";
import { ensureLayout, defaultRoots } from "../../src/core/layout.js";
import { cwdAllowed, isPathInside } from "../../src/core/places.js";
import { buildPreamble } from "../../src/core/preamble.js";
import {
  decideRoutineTick,
  decideRunNow,
  mostRecentSlot,
  nextFireTimes,
} from "../../src/core/routines.js";
import { assignTask, createTask, markExited, markStopped, requestExecute } from "../../src/core/tasks.js";
import { addWorkspaceRecord, removeWorkspaceRecord, writeWorkspaces, readWorkspaces } from "../../src/core/workspaces.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forgedesk-"));
}

describe("places", () => {
  it("treats a folder as inside itself and rejects a shared prefix", () => {
    expect(isPathInside("/tmp/proj", "/tmp/proj")).toBe(true);
    expect(isPathInside("/tmp/proj", "/tmp/proj/src")).toBe(true);
    expect(cwdAllowed("/tmp/proj/src", ["/tmp/proj"])).toBe(true);
    expect(isPathInside("/tmp/proj", "/tmp/proj-other")).toBe(false);
    expect(isPathInside("/tmp/proj", "/tmp")).toBe(false);
    expect(cwdAllowed("/tmp/other", ["/tmp/proj"])).toBe(false);
  });
});

describe("preamble", () => {
  it("includes the brief, memory, skills, places, and prompt, and leaves prior transcripts out", () => {
    const text = buildPreamble({
      agentName: "Release notes",
      places: ["/work/repo"],
      brief: "Draft notes. Do not publish.",
      memory: "MEMORY_SENTINEL prefers bullets",
      skills: [{ name: "notes", body: "SKILL_SENTINEL verify every claim" }],
      prompt: "Summarize the last weekday.",
      priorTranscript: "PRIOR_TRANSCRIPT_SENTINEL",
    });
    expect(text).toContain("Agent: Release notes");
    expect(text).toContain("- /work/repo");
    expect(text).toContain("Draft notes. Do not publish.");
    expect(text).toContain("MEMORY_SENTINEL prefers bullets");
    expect(text).toContain("SKILL_SENTINEL verify every claim");
    expect(text).toContain("Summarize the last weekday.");
    expect(text).not.toContain("PRIOR_TRANSCRIPT_SENTINEL");
  });
});

describe("engines", () => {
  it("marks a row available only when the resolver finds a binary", () => {
    const rows = withAvailability(
      [
        { id: "sh", label: "sh", bin: "sh", args: [] },
        { id: "missing", label: "Missing", bin: "forgedesk-missing-bin-xyz", args: [] },
      ],
      (bin) => (bin === "sh" ? "/bin/sh" : null),
    );
    expect(rows.find((row) => row.id === "sh")?.available).toBe(true);
    expect(rows.find((row) => row.id === "missing")?.available).toBe(false);
  });

  it("resolves real PATH entries and misses unknown names", () => {
    expect(whichBin("bash") || whichBin("/bin/sh")).toBeTruthy();
    expect(whichBin("forgedesk-missing-bin-xyz")).toBeNull();
  });
});

describe("routines", () => {
  const interval = 5 * 60 * 1000;
  const slot = 10 * interval;

  function fireInput(over: Partial<Parameters<typeof decideRoutineTick>[0]> = {}) {
    return {
      now: new Date(slot + 1000),
      appStartedAt: new Date(slot - 1000),
      enabled: true,
      allowRoutines: true,
      engineAvailable: true,
      schedule: { kind: "every" as const, minutes: 5 },
      lastFiredAt: null,
      previousStillRunning: false,
      ...over,
    };
  }

  it("fires a slot that arrived while the app was already running", () => {
    expect(mostRecentSlot({ kind: "every", minutes: 5 }, new Date(slot + 1000))?.toISOString()).toBe(
      new Date(slot).toISOString(),
    );
    expect(decideRoutineTick(fireInput())).toEqual({ action: "fire", scheduledAt: new Date(slot).toISOString() });
  });

  it("records a slot that passed while the process was closed and does not treat it as due", () => {
    const decision = decideRoutineTick(
      fireInput({ appStartedAt: new Date(slot + 500), now: new Date(slot + 1000) }),
    );
    expect(decision).toEqual({ action: "miss", scheduledAt: new Date(slot).toISOString() });
  });

  it("does not overlap a run that is still going", () => {
    const decision = decideRoutineTick(fireInput({ previousStillRunning: true }));
    expect(decision).toEqual({ action: "skip", reason: "still-running" });
  });

  it("suppresses scheduled fires while paused", () => {
    expect(decideRoutineTick(fireInput({ enabled: false }))).toEqual({ action: "skip", reason: "disabled" });
  });

  it("lets run now proceed while paused and refuses a missing engine, a disallowed agent, or an overlap", () => {
    expect(decideRunNow({ allowRoutines: true, engineAvailable: true, previousStillRunning: false })).toEqual({
      ok: true,
    });
    expect(decideRunNow({ allowRoutines: false, engineAvailable: true, previousStillRunning: false })).toEqual({
      ok: false,
      reason: "disallowed",
    });
    expect(decideRunNow({ allowRoutines: true, engineAvailable: false, previousStillRunning: false })).toEqual({
      ok: false,
      reason: "engine-missing",
    });
    expect(decideRunNow({ allowRoutines: true, engineAvailable: true, previousStillRunning: true })).toEqual({
      ok: false,
      reason: "still-running",
    });
  });

  it("previews later cron fires on weekdays at the requested hour", () => {
    const from = new Date(2026, 8, 25, 9, 0, 0, 0);
    const next = nextFireTimes({ kind: "cron", expr: "0 9 * * 1-5" }, from, 3);
    expect(next).toHaveLength(3);
    for (const when of next) {
      expect(when.getTime()).toBeGreaterThan(from.getTime());
      expect(when.getHours()).toBe(9);
      expect(when.getMinutes()).toBe(0);
      expect(when.getDay()).not.toBe(0);
      expect(when.getDay()).not.toBe(6);
    }
  });
});

describe("tasks", () => {
  it("create and assign stay in todo and do not gain a run", () => {
    const created = createTask({ id: "t1", title: "Dim lamp", body: "Warm the lamp" });
    expect(created.status).toBe("todo");
    expect(created.runIds).toEqual([]);
    const assigned = assignTask(created, "agent", "workspace");
    expect(assigned.status).toBe("todo");
    expect(assigned.runIds).toEqual([]);
    expect(assigned.agentId).toBe("agent");
  });

  it("rejects execute outside allowed folders and moves a finished run to review", () => {
    const task = createTask({ id: "t2", title: "Fix", agentId: null, workspaceId: null });
    expect(requestExecute(task, { hasAgent: false, workspacePath: "/work", agentPlaces: ["/work"] }).ok).toBe(false);
    const withAgent = { ...task, agentId: "a", workspaceId: "w" };
    const outside = requestExecute(withAgent, {
      hasAgent: true,
      workspacePath: "/work-other",
      agentPlaces: ["/work"],
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(task.status).toBe("todo");
    const ok = requestExecute(withAgent, { hasAgent: true, workspacePath: "/work", agentPlaces: ["/work"] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.status).toBe("running");
      expect(markExited(ok.task).status).toBe("review");
      expect(markStopped(ok.task).status).toBe("review");
    }
  });
});

describe("workspace records", () => {
  it("removes a workspace from the list and leaves the folder on disk", () => {
    const folder = tempDir();
    fs.writeFileSync(path.join(folder, "keep.txt"), "still here");
    const config = tempDir();
    const added = addWorkspaceRecord({ workspaces: [], lastWorkspaceId: null }, folder);
    writeWorkspaces(config, added);
    const removed = removeWorkspaceRecord(added, added.lastWorkspaceId!);
    writeWorkspaces(config, removed);
    expect(readWorkspaces(config).workspaces).toEqual([]);
    expect(fs.readFileSync(path.join(folder, "keep.txt"), "utf8")).toBe("still here");
  });
});

describe("layout", () => {
  it("seeds engines and both roots without touching the home config", () => {
    const config = tempDir();
    const data = tempDir();
    ensureLayout(config, data);
    const engines = JSON.parse(fs.readFileSync(path.join(config, "engines.json"), "utf8")) as {
      engines: { id: string }[];
    };
    expect(engines.engines.map((engine) => engine.id)).toEqual([
      "grok",
      "claude",
      "codex",
      "cursor-agent",
      "gemini",
      "copilot",
      "opencode",
    ]);
    expect(fs.existsSync(path.join(data, "runs"))).toBe(true);
    const roots = defaultRoots();
    expect(roots.configRoot.endsWith(`${path.sep}.config${path.sep}forgedesk`)).toBe(true);
    expect(roots.dataRoot.endsWith(`${path.sep}.local${path.sep}share${path.sep}forgedesk`)).toBe(true);
  });
});

describe("git snapshot", () => {
  it("writes status and diff for a repo and a plain message otherwise", async () => {
    const dir = tempDir();
    expect((await snapshotGit(dir)).trim()).toBe("not a git repo");
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "desk@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Desk"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "note.txt"), "one\n");
    execFileSync("git", ["add", "note.txt"], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: dir });
    fs.appendFileSync(path.join(dir, "note.txt"), "two\n");
    const text = await snapshotGit(dir);
    expect(text).toContain("git status --short");
    expect(text).toContain("note.txt");
    expect(text).toContain("git diff --stat");
  });
});

describe("shell quote", () => {
  it("quotes spaces and single quotes", () => {
    expect(shellQuote("/tmp/my file")).toBe("'/tmp/my file'");
    expect(shellQuote("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
  });
});
