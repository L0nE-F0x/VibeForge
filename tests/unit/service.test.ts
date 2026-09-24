import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureLayout } from "../../src/core/layout.js";
import { createRunFiles } from "../../src/core/runs.js";
import { TeamService, type TeamHost } from "../../src/core/team-service.js";
import { writeWorkspaces } from "../../src/core/workspaces.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forgedesk-svc-"));
}

function setup() {
  const configRoot = tempDir();
  const dataRoot = tempDir();
  const place = tempDir();
  ensureLayout(configRoot, dataRoot);
  fs.writeFileSync(
    path.join(configRoot, "engines.json"),
    JSON.stringify({
      engines: [
        { id: "bash", label: "Bash", bin: "bash", args: [] },
        { id: "sh", label: "Sh", bin: "sh", args: [] },
      ],
    }),
  );
  const calls: { initialInput: string }[] = [];
  const alive = new Set<string>();
  let n = 0;
  const host: TeamHost = {
    async spawnPty(request) {
      n += 1;
      calls.push({ initialInput: request.initialInput });
      const ptyId = `pty-${n}`;
      alive.add(ptyId);
      return { ptyId };
    },
    writePty() {},
    killPty(ptyId) {
      alive.delete(ptyId);
    },
    isPtyAlive(ptyId) {
      return alive.has(ptyId);
    },
    resolveBin(bin) {
      if (bin === "bash") return "/bin/bash";
      if (bin === "sh") return "/bin/sh";
      return null;
    },
    notify() {},
    async snapshotGit() {
      return "not a git repo\n";
    },
  };
  const interval = 5 * 60 * 1000;
  const appStartedAt = new Date(9 * interval);
  const svc = new TeamService({ configRoot, dataRoot, appStartedAt, now: () => new Date(), host });
  return { configRoot, dataRoot, place, calls, alive, host, svc, interval };
}

describe("TeamService", () => {
  it("does not spawn when a task is created or assigned", async () => {
    const { svc, calls, place, configRoot } = setup();
    const agent = await svc.saveAgent({
      name: "Notes",
      brief: "Keep notes.",
      engine: "bash",
      places: [place],
    });
    writeWorkspaces(configRoot, {
      workspaces: [{ id: "work", name: "Work", path: place, dockUrl: "" }],
      lastWorkspaceId: "work",
    });
    const task = await svc.saveTask({ title: "Dim lamp", body: "Warm it" });
    await svc.assignTask(task.id, agent.id, "work");
    expect(calls).toHaveLength(0);
    expect(svc.listTasks().find((item) => item.id === task.id)?.status).toBe("todo");
  });

  it("starts one fresh routine run and does not overlap or replay a missed slot", async () => {
    const { svc, calls, place, dataRoot, interval, alive, configRoot, host } = setup();
    const agent = await svc.saveAgent({
      name: "Notes",
      brief: "BRIEF_SENTINEL draft only. Do not publish.",
      engine: "bash",
      places: [place],
    });
    await svc.writeMemory(agent.id, "MEMORY_SENTINEL likes bullets");
    await svc.saveSkill({
      id: "notes",
      name: "notes",
      description: "notes",
      body: "SKILL_SENTINEL check the diff",
    });
    await svc.saveAgent({ ...agent, skills: ["notes"] });
    const old = createRunFiles({
      dataRoot,
      slug: "old",
      preamble: "old",
      meta: {
        origin: "routine",
        cwd: place,
        prompt: "old",
        agentId: null,
        routineId: null,
        taskId: null,
        chatId: null,
        engine: "bash",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "exited",
        openedAt: null,
        notifiedAt: null,
      },
    });
    fs.writeFileSync(path.join(old.dir, "scrollback.txt"), "OLD_SCROLLBACK_SENTINEL");
    const routine = await svc.saveRoutine({
      name: "Weekday",
      agentId: agent.id,
      schedule: { kind: "every", minutes: 5 },
      prompt: "PROMPT_SENTINEL draft the notes. Do not publish.",
      enabled: true,
    });

    await svc.tick(new Date(10 * interval + 1000));
    expect(calls).toHaveLength(1);
    const preamble = calls[0]?.initialInput ?? "";
    expect(preamble).toContain("Notes");
    expect(preamble).toContain(place);
    expect(preamble).toContain("BRIEF_SENTINEL");
    expect(preamble).toContain("MEMORY_SENTINEL");
    expect(preamble).toContain("SKILL_SENTINEL");
    expect(preamble).toContain("PROMPT_SENTINEL");
    expect(preamble).not.toContain("OLD_SCROLLBACK_SENTINEL");

    await svc.tick(new Date(11 * interval + 1000));
    expect(calls).toHaveLength(1);

    await svc.setRoutineEnabled(routine.id, false);
    await svc.tick(new Date(12 * interval + 1000));
    expect(calls).toHaveLength(1);
    alive.clear();
    const manual = await svc.runRoutineNow(routine.id);
    expect(manual.ok).toBe(true);
    expect(calls).toHaveLength(2);
    await svc.setRoutineEnabled(routine.id, true);

    const closed = new TeamService({
      configRoot,
      dataRoot,
      appStartedAt: new Date(13 * interval + 500),
      now: () => new Date(),
      host,
    });
    const before = calls.length;
    await closed.tick(new Date(13 * interval + 1000));
    expect(calls).toHaveLength(before);
    const missed = closed.listRoutines().find((item) => item.id === routine.id);
    expect(missed?.lastMissedAt).toBe(new Date(13 * interval).toISOString());
    closed.close();
    svc.close();
  });

  it("refuses run now when routines are disallowed or the engine cannot be resolved", async () => {
    const { svc, place, host } = setup();
    const agent = await svc.saveAgent({
      name: "Quiet",
      brief: "Stay put.",
      engine: "bash",
      places: [place],
      allowRoutines: false,
    });
    const routine = await svc.saveRoutine({
      name: "Nope",
      agentId: agent.id,
      schedule: { kind: "every", minutes: 5 },
      prompt: "Do not send this.",
    });
    const blocked = await svc.runRoutineNow(routine.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("disallowed");
    await svc.saveAgent({ ...agent, allowRoutines: true, engine: "bash" });
    host.resolveBin = () => null;
    const missing = await svc.runRoutineNow(routine.id);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("engine-missing");
    svc.close();
  });

  it("keeps the brief and memory file when the engine changes", async () => {
    const { svc, place, configRoot } = setup();
    const agent = await svc.saveAgent({
      name: "Notes",
      brief: "Keep the brief.",
      engine: "bash",
      places: [place],
    });
    const memoryPath = path.join(configRoot, "agents", agent.id, "memory.md");
    const before = fs.readFileSync(memoryPath, "utf8");
    await svc.saveAgent({ ...agent, engine: "sh" });
    const after = svc.listAgents().find((item) => item.id === agent.id);
    expect(after?.brief).toBe("Keep the brief.");
    expect(after?.engine).toBe("sh");
    expect(fs.readFileSync(memoryPath, "utf8")).toBe(before);
    svc.close();
  });

  it("moves an executed task to review when the run exits, and only after execute", async () => {
    const { svc, calls, place, configRoot, dataRoot } = setup();
    const agent = await svc.saveAgent({
      name: "Notes",
      brief: "Edit the lamp.",
      engine: "bash",
      places: [place],
    });
    writeWorkspaces(configRoot, {
      workspaces: [{ id: "work", name: "Work", path: place, dockUrl: "" }],
      lastWorkspaceId: "work",
    });
    const task = await svc.saveTask({ title: "Lamp", body: "Make it warm", agentId: agent.id, workspaceId: "work" });
    expect(calls).toHaveLength(0);
    const started = await svc.executeTask(task.id);
    expect(started.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.initialInput).toContain("Make it warm");
    expect(svc.listTasks().find((item) => item.id === task.id)?.status).toBe("running");
    expect(fs.existsSync(path.join(dataRoot, "index.sqlite"))).toBe(true);
    await svc.notePtyExit(started.ptyId ?? "");
    expect(svc.listTasks().find((item) => item.id === task.id)?.status).toBe("review");
    const stopped = await svc.saveTask({ title: "Other", body: "leave it" });
    await svc.assignTask(stopped.id, agent.id, "work");
    expect(calls).toHaveLength(1);
    const running = await svc.executeTask(stopped.id);
    await svc.stopTask(stopped.id);
    expect(svc.listTasks().find((item) => item.id === stopped.id)?.status).toBe("review");
    const run = await svc.getRun(running.runId ?? "");
    expect(fs.existsSync(path.join(run.meta.dir, "scrollback.txt"))).toBe(true);
    svc.close();
  });
});
