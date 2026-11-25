import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, UnreadableError } from "../../src/core/store.js";
import { unreadable } from "../../src/core/store/library.js";
import { allocateRunDir, normalizeRun } from "../../src/core/runs.js";
import type { Agent, Routine, RunMeta, Task } from "../../src/core/types.js";
import { matchCoreText } from "../../src/ui/core-text.js";
import { INTERVAL, setup } from "./fixtures/service-harness.js";

// Agents, skills, routines and tasks that are there but can't be read: a list says so instead of
// passing for empty, one bad file doesn't hide the rest, and what runs in the background neither
// stops nor takes the unreadable ones for deleted.

const asRoot = process.getuid?.() === 0;
const made: string[] = [];
const locked: Array<{ target: string; mode: number }> = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-reads-"));
  made.push(dir);
  return dir;
};

/** No reading `target` until the test is over. */
function lock(target: string): void {
  locked.push({ target, mode: fs.statSync(target).mode & 0o777 });
  fs.chmodSync(target, 0o000);
}

afterEach(() => {
  // The last locked first: a file inside a folder locked after it.
  for (const { target, mode } of locked.splice(0).reverse()) fs.chmodSync(target, mode);
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function agent(id: string, name = id): Agent {
  return { id, name, engine: "claude", brief: "Help.", memoryFile: "memory.md", places: [], skills: [], allowRoutines: true, goodAt: "", tier: "", createdAt: "", updatedAt: "" };
}

function routine(id: string, agentId: string): Routine {
  return { id, name: id, agentId, enabled: true, schedule: { kind: "every", minutes: 5 }, prompt: "Check.", notify: false, lastFiredAt: null, lastMissedAt: null, shareCheckout: false };
}

function store() {
  const config = temp();
  return { config, store: new Store(config, temp()) };
}

describe.skipIf(asRoot)("reading the library", () => {
  it("lists nothing for a folder that doesn't exist yet, and says why for one that can't be read", () => {
    const { config, store: s } = store();
    expect(s.listAgents()).toEqual([]);
    expect(s.listTasks()).toEqual([]);
    s.writeAgent(agent("atlas", "Atlas"));
    lock(path.join(config, "agents"));
    expect(() => s.listAgents()).toThrow(UnreadableError);
    expect(() => s.listAgents()).toThrow(/^Couldn't read .*agents: VibeForge isn't allowed to\. Check its permissions\.$/);
    // Looking one up still answers "not here" for the many callers that only look.
    expect(s.getAgent("atlas")).toBeNull();
    expect(() => s.readAgent("atlas")).toThrow(UnreadableError);
    // The window reads the list's error, not the files a list left out.
    expect(s.unreadableFiles()).toEqual([]);
  });

  it("fails each kind's list on its own unreadable folder", () => {
    const { config, store: s } = store();
    s.writeSkill({ id: "tests", name: "Tests", description: "", body: "Run them." });
    s.writeRoutine(routine("daily", "atlas"));
    s.writeTask(task("t1", []));
    for (const folder of ["skills", "routines", "tasks"]) lock(path.join(config, folder));
    expect(() => s.listSkills()).toThrow(/skills: VibeForge isn't allowed to/);
    expect(() => s.listRoutines()).toThrow(/routines: VibeForge isn't allowed to/);
    expect(() => s.listTasks()).toThrow(/tasks: VibeForge isn't allowed to/);
    expect(s.getSkill("tests")).toBeNull();
    expect(() => s.readSkill("tests")).toThrow(UnreadableError);
  });

  it("lists the files it can read and names the ones it can't, each with why", () => {
    const { config, store: s } = store();
    s.writeAgent(agent("atlas", "Atlas"));
    s.writeAgent(agent("locked", "Locked"));
    s.writeAgent(agent("broken", "Broken"));
    s.writeAgent(agent("empty", "Empty"));
    lock(path.join(config, "agents", "locked", "agent.yaml"));
    fs.writeFileSync(path.join(config, "agents", "broken", "agent.yaml"), "name: [unclosed\n");
    fs.writeFileSync(path.join(config, "agents", "empty", "agent.yaml"), "");
    // A folder with no agent.yaml in it is no agent, as before.
    fs.mkdirSync(path.join(config, "agents", "stray"));
    s.writeTask(task("fine", []));
    fs.writeFileSync(path.join(config, "tasks", "bad.yaml"), "- just\n- a list\n");

    expect(s.listAgents().map((item) => item.id)).toEqual(["atlas"]);
    expect(s.listTasks().map((item) => item.id)).toEqual(["fine"]);
    const files = s.unreadableFiles();
    expect(files.map(({ kind, id }) => `${kind}:${id}`).sort()).toEqual(["agent:broken", "agent:empty", "agent:locked", "task:bad"]);
    const why = Object.fromEntries(files.map((file) => [file.id, file.error]));
    expect(why.locked).toMatch(/^Couldn't read .*locked\/agent\.yaml: VibeForge isn't allowed to\. Check its permissions\.$/);
    expect(why.broken).toMatch(/^Couldn't read .*broken\/agent\.yaml: it isn't valid YAML \(.+\)\.$/);
    expect(why.empty).toMatch(/empty\/agent\.yaml: it doesn't hold any fields\.$/);
    expect(why.bad).toMatch(/bad\.yaml: it doesn't hold any fields\.$/);
    expect(files.find((file) => file.id === "locked")?.file).toBe(path.join(config, "agents", "locked", "agent.yaml"));
  });

  it("throws for a memory or skill that can't be read, and gives nothing only for one not written yet", () => {
    const { config, store: s } = store();
    s.writeAgent(agent("atlas"));
    fs.rmSync(path.join(config, "agents", "atlas", "memory.md"));
    expect(s.readMemory("atlas")).toBe("");
    s.writeMemory("atlas", "- likes tests\n");
    lock(path.join(config, "agents", "atlas", "memory.md"));
    expect(() => s.readMemory("atlas")).toThrow(/memory\.md: VibeForge isn't allowed to/);
    s.writeSkill({ id: "tests", name: "Tests", description: "", body: "Run them." });
    lock(path.join(config, "skills", "tests", "SKILL.md"));
    expect(s.listSkills()).toEqual([]);
    expect(s.unreadableFiles()).toEqual([expect.objectContaining({ kind: "skill", id: "tests" })]);
    expect(s.readSkillRaw("missing")).toBeNull();
  });
});

describe("what the window is told", () => {
  it("shows the path from home, and the reason without the path said twice", () => {
    const file = path.join(os.homedir(), ".config", "vibeforge", "agents");
    const eio = Object.assign(new Error(`EIO: i/o error, scandir '${file}'`), { code: "EIO" });
    expect(unreadable(file, eio).message).toBe("Couldn't read ~/.config/vibeforge/agents: EIO: i/o error");
    expect(unreadable(file, Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })).message).toBe(
      "Couldn't read ~/.config/vibeforge/agents: VibeForge isn't allowed to. Check its permissions.",
    );
  });

  it("has a translation for each way a read can fail", () => {
    expect(matchCoreText("Couldn't read ~/a: VibeForge isn't allowed to. Check its permissions.")).toEqual({ key: "core.readDenied", vars: { path: "~/a" } });
    expect(matchCoreText("Couldn't read ~/a.yaml: it isn't valid YAML (Unexpected end).")?.key).toBe("core.readNotYaml");
    expect(matchCoreText("Couldn't read ~/a.yaml: it doesn't hold any fields.")?.key).toBe("core.readNoFields");
    expect(matchCoreText("Couldn't read ~/a: EIO: i/o error")).toEqual({ key: "core.readFailed", vars: { path: "~/a", detail: "EIO: i/o error" } });
  });
});

describe.skipIf(asRoot)("what runs in the background", () => {
  it("still starts the routines it can read, and drops nothing, when one routine or its agent can't be read", async () => {
    const ctx = setup({ appStartedAt: new Date(0), now: () => new Date(10 * INTERVAL + 1000) });
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    const other = await ctx.svc.saveAgent({ name: "Other", brief: "Other notes.", engine: "argy", places: [ctx.place] });
    for (const id of ["first", "second"]) ctx.svc.store.writeRoutine({ ...routine(id, agent.id), lastFiredAt: new Date(9 * INTERVAL).toISOString() });
    ctx.svc.store.writeRoutine({ ...routine("third", other.id), lastFiredAt: new Date(9 * INTERVAL).toISOString() });
    const second = path.join(ctx.configRoot, "routines", "second.yaml");
    const third = path.join(ctx.configRoot, "routines", "third.yaml");
    const before = [fs.readFileSync(second, "utf8"), fs.readFileSync(third, "utf8")];
    lock(path.join(ctx.configRoot, "agents", other.id, "agent.yaml"));
    fs.chmodSync(second, 0o000);
    try {
      const results = await ctx.svc.tick();
      // The one whose agent can't be read waits, as one whose agent is gone does: nothing is marked missed.
      expect(results.map((item) => `${item.routineId}:${item.decision.action}`)).toEqual(["first:fire", "third:skip"]);
    } finally {
      fs.chmodSync(second, 0o600);
    }
    expect([fs.readFileSync(second, "utf8"), fs.readFileSync(third, "utf8")]).toEqual(before);
    ctx.svc.close();
  });

  it("stops the scheduler's pass, changing nothing, when the routines folder can't be read", async () => {
    const ctx = setup({ appStartedAt: new Date(0), now: () => new Date(10 * INTERVAL + 1000) });
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    ctx.svc.store.writeRoutine({ ...routine("first", agent.id), lastFiredAt: new Date(9 * INTERVAL).toISOString() });
    lock(path.join(ctx.configRoot, "routines"));
    await expect(ctx.svc.tick()).rejects.toThrow(/routines: VibeForge isn't allowed to/);
    expect(ctx.spawns).toEqual([]);
    ctx.svc.close();
  });

  it("removes no runs while a task can't be read, as one of them may be its own", async () => {
    const ctx = setup();
    const when = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const { id, dir } = allocateRunDir(ctx.dataRoot, when, "old");
    const at = when.toISOString();
    const run = ctx.svc.store.saveRun(normalizeRun({ id, dir, origin: "task", status: "exited", startedAt: at, endedAt: at, openedAt: at, title: "Old" }) as RunMeta);
    ctx.svc.store.writeTask(task("mine", [run.id]));
    ctx.svc.saveSettings({ keepRuns: { days: 30, maxMb: 0 } });
    lock(path.join(ctx.configRoot, "tasks", "mine.yaml"));
    expect(await ctx.svc.maintainRuns()).toMatchObject({ removed: 0 });
    expect(ctx.svc.store.getRun(run.id)).not.toBeNull();
    lock(path.join(ctx.configRoot, "tasks"));
    await expect(ctx.svc.maintainRuns()).rejects.toThrow(/tasks: VibeForge isn't allowed to/);
    expect(ctx.svc.store.getRun(run.id)).not.toBeNull();
    ctx.svc.close();
  });

  it("tells Viby which lists couldn't be read instead of leaving them out as empty", async () => {
    const ctx = setup();
    await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    lock(path.join(ctx.configRoot, "agents"));
    const context = await ctx.svc.orchestrator.context(true);
    expect(context.agents).toBeUndefined();
    expect(context.unreadable).toEqual([expect.stringMatching(/agents: VibeForge isn't allowed to/)]);
    ctx.svc.close();
  });

  it("won't start an agent without a skill or memory it can't read, and says why", async () => {
    const ctx = setup();
    ctx.svc.saveSkill({ name: "Tests", description: "", body: "Run them." });
    const agent = await ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place], skills: ["tests"] });
    lock(path.join(ctx.configRoot, "skills", "tests", "SKILL.md"));
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    await expect(ctx.svc.launchAgent(workspace.id, agent.id, "Hello")).rejects.toThrow(/SKILL\.md: VibeForge isn't allowed to/);
    // Saving the agent meanwhile keeps the skill it can't read.
    expect(ctx.svc.saveAgent({ ...agent, skills: ["tests"] }).skills).toEqual(["tests"]);
    expect(ctx.spawns).toEqual([]);
    ctx.svc.close();
  });
});

function task(id: string, runIds: string[]): Task {
  return { id, title: id, body: "", status: "review", agentId: null, workspaceId: null, runIds, isolated: false, copy: null, shareCheckout: false, sourceRunId: null, askedBy: null, createdAt: "", updatedAt: "" };
}
