import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDesk, bearerToken, defaultCompanion, isCodingSession, newCompanionToken, normalizeCompanion, normalizeNudges, tailText, tokenMatches, type DeskInput } from "../../src/core/companion.js";
import { startCompanionHttp, type CompanionActions } from "../../src/core/companion-http.js";
import { TeamService, type DeskHost, type SpawnRequest } from "../../src/core/team-service.js";
import type { LiveSession } from "../../src/core/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-phone-"));
}

function live(patch: Partial<LiveSession> & Pick<LiveSession, "ptyId" | "title" | "cwd">): LiveSession {
  return {
    runId: null,
    kind: "run",
    pid: 1,
    startedAt: "2026-10-03T00:00:00.000Z",
    origin: "agent-chat",
    agentId: null,
    chatId: null,
    taskId: null,
    workspaceId: null,
    ...patch,
  };
}

function deskInput(patch: Partial<DeskInput> = {}): DeskInput {
  return {
    workspaces: [
      { id: "notes", name: "Notes", path: "/work/notes" },
      { id: "web", name: "Web", path: "/work/web" },
    ],
    agents: [
      { id: "atlas", name: "Atlas", engine: "claude", places: ["/work/notes"] },
      { id: "mina", name: "Mina", engine: "grok", places: ["/work/web", "/work/notes"] },
    ],
    engines: [
      { id: "claude", label: "Claude" },
      { id: "grok", label: "Grok" },
    ],
    live: [],
    recent: [],
    nudges: ["Keep going."],
    now: Date.parse("2026-10-03T12:00:00.000Z"),
    ...patch,
  };
}

describe("phone page settings", () => {
  it("fills in a missing block and keeps a real pairing code", () => {
    expect(normalizeCompanion(undefined)).toEqual(defaultCompanion());
    const token = newCompanionToken();
    const next = normalizeCompanion({ enabled: true, port: 80, token, nudges: ["  Keep going. ", "", "Keep going."] });
    expect(next.port).toBe(defaultCompanion().port);
    expect(next.token).toBe(token);
    expect(next.nudges).toEqual(["Keep going."]);
    expect(normalizeNudges([], [])).toEqual([]);
  });

  it("accepts only the pairing code", () => {
    const token = newCompanionToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token} `)).toBe(false);
    expect(tokenMatches("", token)).toBe(false);
    expect(tokenMatches(token, "vf_short")).toBe(false);
    expect(bearerToken("Bearer vf_abc")).toBe("vf_abc");
    expect(bearerToken("Basic vf_abc")).toBe("");
  });

  it("keeps the tail of a long screen", () => {
    expect(tailText("one\ntwo\nthree", 2, 100)).toBe("two\nthree");
    expect(tailText("abcdef", 5, 3)).toBe("def");
  });
});

describe("phone desk", () => {
  it("groups a live agent and a finished run under the workspace, and says who may start there", () => {
    const desk = buildDesk(
      deskInput({
        live: [
          live({ ptyId: "p1", title: "Claude · Notes", cwd: "/work/notes", agentId: "atlas", workspaceId: "notes", working: true, programEngineId: "claude" }),
          live({ ptyId: "sh", title: "bash", cwd: "/work/notes", kind: "shell", origin: null, workspaceId: "notes" }),
        ],
        recent: [
          {
            id: "r1",
            title: "Grok · Web",
            agentId: "mina",
            engine: "grok",
            cwd: "/work/web",
            workspaceId: "web",
            startedAt: "2026-10-03T10:00:00.000Z",
            endedAt: "2026-10-03T11:00:00.000Z",
            changes: "1 file changed",
            status: "exited",
          },
        ],
      }),
    );
    expect(desk.workspaces.map((workspace) => workspace.name)).toEqual(["Notes", "Web"]);
    expect(desk.workspaces[0].sessions.map((session) => [session.title, session.state, session.detail])).toEqual([["Atlas", "working", "Claude"]]);
    expect(desk.workspaces[1].sessions.map((session) => [session.title, session.state, session.changes])).toEqual([["Mina", "done", "1 file changed"]]);
    expect(desk.agents.find((agent) => agent.id === "atlas")?.workspaceIds).toEqual(["notes"]);
    expect(desk.agents.find((agent) => agent.id === "mina")?.workspaceIds).toEqual(["notes", "web"]);
  });

  it("offers each installed CLI, and never counts a bare shell as a session", () => {
    const desk = buildDesk(deskInput({ engines: [{ id: "claude", label: "Claude", available: true }, { id: "kimi", label: "Kimi", available: false }] }));
    expect(desk.engines).toEqual([{ id: "claude", label: "Claude" }]);
    expect(isCodingSession({ kind: "shell", programEngineId: null })).toBe(false);
    expect(isCodingSession({ kind: "shell", programEngineId: "claude" })).toBe(true);
    expect(isCodingSession({ kind: "run", programEngineId: null })).toBe(true);
  });

  it("puts a session outside every workspace at the end", () => {
    const desk = buildDesk(deskInput({ live: [live({ ptyId: "p", title: "Claude", cwd: "/other", working: false })] }));
    expect(desk.workspaces.at(-1)?.name).toBe("Elsewhere");
    expect(desk.workspaces.at(-1)?.sessions[0].state).toBe("waiting");
  });
});

function actions(patch: Partial<CompanionActions> = {}): CompanionActions {
  return {
    desk: () => ({ nudges: ["Keep going."], agents: [], engines: [], workspaces: [] }),
    session: async () => ({ ptyId: "p", runId: "r", title: "Atlas", detail: "Claude", state: "waiting", changes: null, screen: "hello", canSend: true, stop: "end" }),
    send: async () => ({ working: false, ptyId: "p", runId: "r" }),
    stop: async () => undefined,
    launch: async () => ({ ptyId: "p2", runId: "r2" }),
    ...patch,
  };
}

describe("phone page server", () => {
  it("serves the page and refuses the desk until the code matches", async () => {
    const token = newCompanionToken();
    const server = await startCompanionHttp({
      port: 0,
      token,
      root: path.join(import.meta.dirname, "../../companion"),
      icon: null,
      actions: actions(),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("VibeForge");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect((await fetch(`${base}/app.js`)).status).toBe(200);
      expect((await fetch(`${base}/api/desk`)).status).toBe(401);
      expect((await fetch(`${base}/api/desk`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      const bad = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "nope" }) });
      expect(bad.status).toBe(401);
      const good = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      expect(good.status).toBe(200);
      const working = await fetch(`${base}/api/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ptyId: "p", text: "keep going" }),
      });
      expect(working.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("says when a session is still working", async () => {
    const token = newCompanionToken();
    const server = await startCompanionHttp({
      port: 0,
      token,
      root: tempDir(),
      icon: null,
      actions: actions({ send: async ({ force }) => (force ? { working: false, ptyId: "p", runId: "r" } : { working: true }) }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const refused = await fetch(`${base}/api/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ptyId: "p", text: "go" }),
      });
      expect(refused.status).toBe(409);
      const forced = await fetch(`${base}/api/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ptyId: "p", text: "go", force: true }),
      });
      expect(forced.status).toBe(200);
      expect(await forced.json()).toEqual({ ptyId: "p", runId: "r" });
      const nobody = await fetch(`${base}/api/launch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "w" }),
      });
      expect(nobody.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

function service() {
  const configRoot = tempDir();
  const dataRoot = tempDir();
  const place = tempDir();
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "engines.json"),
    JSON.stringify({
      engines: [
        { id: "argy", label: "Argy", bin: "argy", args: [], promptArgs: ["{prompt}"] },
        { id: "cony", label: "Cony", bin: "cony", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      ],
    }),
  );
  const spawns: SpawnRequest[] = [];
  let n = 0;
  let svc: TeamService;
  const host: DeskHost = {
    async spawn(request) {
      n += 1;
      spawns.push(request);
      return { ptyId: `pty-${n}`, pid: 1000 + n };
    },
    async send() {
      return undefined;
    },
    async kill() {
      return undefined;
    },
    async record() {
      return undefined;
    },
    resolveBin: (bin) => (bin === "argy" || bin === "cony" ? `/usr/bin/${bin}` : null),
    notify: () => undefined,
    snapshotGit: async () => "not a git repo\n",
    gitHead: async () => null,
  };
  svc = new TeamService({ configRoot, dataRoot, appStartedAt: new Date(), now: () => new Date(), host });
  return { svc, spawns, place };
}

describe("launching an agent from the phone", () => {
  it("starts the agent in that workspace with its brief, and refuses a folder it is not allowed in", async () => {
    const ctx = service();
    const agent = ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const started = await ctx.svc.launchAgent(workspace.id, agent.id, "Fix the door.");
    expect(started.ptyId).toBe("pty-1");
    const argv = ctx.spawns[0].argv.join(" ");
    expect(argv).toContain("Keep notes.");
    expect(argv).toContain("Fix the door.");
    expect(argv).toContain("Agent: Notes");
    const elsewhere = tempDir();
    const other = ctx.svc.addWorkspace(elsewhere).workspaces[1];
    await expect(ctx.svc.launchAgent(other.id, agent.id, "no")).rejects.toThrow(/not allowed/);
    await expect(ctx.svc.launchAgent(workspace.id, agent.id, "again")).rejects.toThrow(/already running/);
  });

  it("makes a pairing code when the page is turned on and keeps it when turned off", () => {
    const ctx = service();
    const on = ctx.svc.saveSettings({ companion: { ...ctx.svc.getSettings().companion, enabled: true, token: "" } });
    expect(on.companion.token).toMatch(/^vf_[0-9a-f]{32}$/);
    const off = ctx.svc.saveSettings({ companion: { enabled: false } });
    expect(off.companion.enabled).toBe(false);
    expect(off.companion.token).toBe(on.companion.token);
    expect(off.companion.nudges).toEqual(defaultCompanion().nudges);
  });
});

describe("picking a finished run back up from the phone", () => {
  it("continues a task in the task's place, as its agent, with the next instruction", async () => {
    const ctx = service();
    const agent = ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine: "argy", places: [ctx.place] });
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const task = ctx.svc.saveTask({ title: "Door", body: "Fix the door.", agentId: agent.id, workspaceId: workspace.id });
    const first = await ctx.svc.executeTask(task.id, {}, true);
    if (!("runId" in first)) throw new Error("the task was queued");
    await ctx.svc.onPtyExit(first.ptyId, 0, null);
    await ctx.svc.continueRun(first.runId, {}, "Now oil the hinges.");
    const next = ctx.spawns.at(-1)!;
    expect(next.cwd).toBe(ctx.place);
    expect(next.argv.join(" ")).toContain("Keep notes.");
    expect(next.argv.join(" ")).toContain("Now oil the hinges.");
    expect(ctx.svc.store.getTask(task.id)?.runIds).toHaveLength(2);
  });

  it("types the next instruction once a CLI that continues on its own is ready", async () => {
    const ctx = service();
    const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
    const first = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "cony", prompt: "Look around." });
    await ctx.svc.onPtyExit(first.ptyId, 0, null);
    await ctx.svc.continueRun(first.runId, {}, "Now tidy up.");
    const next = ctx.spawns.at(-1)!;
    expect(next.argv).toContain("--continue");
    expect(next.argv.join(" ")).not.toContain("Now tidy up.");
    expect(next.pasteInput).toBe("Now tidy up.");
  });
});
