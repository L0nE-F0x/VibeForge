import { describe, expect, it } from "vitest";
import { buildPhoneOrchestrator } from "../../src/core/companion-orchestrator.js";
import { type OrchestratorStep, type OrchestratorTurn, type PlanContext, resolvePlan, safeInCall, showWhat, stepIssue } from "../../src/core/orchestrator.js";

// What each of Viby's app-control steps needs before it can run, checked one rule at a time.

function st(patch: Partial<OrchestratorStep> & Pick<OrchestratorStep, "kind">): OrchestratorStep {
  return { id: "s1", engineId: "", workspaceId: "", branch: "", prompt: "", target: "", asked: "", state: "planned", error: null, ptyId: null, openedWorkspaceId: null, ...patch };
}

const ctx: PlanContext = {
  workspaces: [{ id: "ws1", name: "Acme", folder: "/tmp/acme", git: true }],
  engines: [
    { id: "claude", label: "Claude Code", available: true, bin: "claude" },
    { id: "kimi", label: "Kimi", available: false, bin: "kimi" },
  ],
  running: [
    { id: "pty-1", engine: "Claude Code", workspace: "Acme", folder: "/tmp/acme", working: false, orchestrated: false },
    { id: "pty-2", engine: "Codex", workspace: "Acme", folder: "/tmp/acme", working: true, orchestrated: true },
  ],
  copies: [{ id: "cp1", name: "tray-glow", branch: "vibeforge/tray-glow", workspace: "Acme" }],
  agents: [
    { id: "ag1", name: "Atlas", engine: "claude", places: ["/tmp/acme"] },
    { id: "ag2", name: "Scout", engine: "claude" },
  ],
  skills: [{ id: "sk1", name: "Audit" }],
  tasks: [
    { id: "tk1", title: "Fix bug", status: "todo", workspaceId: "ws1", agentId: "ag1" },
    { id: "tk2", title: "Polish copy", status: "todo", agent: "Atlas" },
  ],
  routines: [{ id: "rt1", name: "Daily", schedule: "0 9 * * *", enabled: true, agentId: "ag1" }],
  chats: [
    { id: "ch1", title: "Scratch", engine: "claude", live: false },
    { id: "ch2", title: "Design notes", engine: "claude", agentId: "ag1", live: false },
  ],
  runs: [{ id: "rn1", title: "Nightly sweep", status: "exited", engine: "claude", origin: "task", opened: false }],
};

const issue = (patch: Parameters<typeof st>[0], context: PlanContext = ctx) => stepIssue(st(patch), context);

describe("stepIssue for Viby's app-control steps", () => {
  it("checks workspace rename and move", () => {
    expect(issue({ kind: "workspace", action: "frobnicate" })).toBe("prompt");
    expect(issue({ kind: "workspace", action: "rename", target: "nope", name: "B" })).toBe("workspace");
    expect(issue({ kind: "workspace", action: "rename", target: "ws1", name: "Better" })).toBeNull();
    expect(issue({ kind: "workspace", action: "rename", target: "ws1", name: "a/b" })).toBe("name");
    expect(issue({ kind: "workspace", action: "move", target: "ws1", status: "top" })).toBeNull();
    expect(issue({ kind: "workspace", action: "move", target: "ws1", options: "index=3" })).toBeNull();
    expect(issue({ kind: "workspace", action: "move", target: "ws1" })).toBe("prompt");
    expect(issue({ kind: "workspace", action: "move", target: "ws1", status: "sideways" })).toBe("prompt");
    expect(issue({ kind: "workspace", action: "remove", target: "ws1" })).toBeNull();
    expect(issue({ kind: "workspace", action: "copy-setup", target: "ws1" })).toBe("prompt");
    expect(issue({ kind: "workspace", action: "copy-setup", target: "ws1", options: "folders=node_modules" })).toBeNull();
    expect(issue({ kind: "workspace", action: "copy-setup", target: "ws1", prompt: "npm i" })).toBeNull();
  });

  it("checks entity inspections and what an inspect target names", () => {
    expect(issue({ kind: "inspect", action: "agent" })).toBe("target");
    expect(issue({ kind: "inspect", action: "agent", target: "ag9" })).toBe("target");
    expect(issue({ kind: "inspect", action: "skill", target: "sk9" })).toBe("target");
    expect(issue({ kind: "inspect", action: "routine", target: "rt9" })).toBe("target");
    expect(issue({ kind: "inspect", action: "task", target: "tk9" })).toBe("target");
    expect(issue({ kind: "inspect", action: "chat", target: "ch9" })).toBe("target");
    expect(issue({ kind: "inspect", action: "run", target: "anything" })).toBeNull();
    expect(issue({ kind: "inspect", action: "agent", target: "ag1" })).toBeNull();
    for (const target of ["pty-1", "cp1", "ag1", "sk1", "rt1", "tk1", "ch1", "rn1"]) expect(issue({ kind: "inspect", target })).toBeNull();
    expect(issue({ kind: "inspect", target: "ghost" })).toBe("target");
    expect(issue({ kind: "inspect", workspaceId: "ws1" })).toBeNull();
    expect(issue({ kind: "inspect", workspaceId: "ws9" })).toBe("workspace");
    expect(issue({ kind: "inspect" })).toBe("workspace");
  });

  it("checks workbench steps that need a workspace", () => {
    expect(issue({ kind: "workbench", prompt: "dance" })).toBe("prompt");
  });

  it("checks saved-agent steps", () => {
    const create = { kind: "agent" as const, action: "create", name: "Nova", engineId: "claude", prompt: "Review things.", places: ["ws1"] };
    expect(issue({ ...create, places: ["/tmp/acme"] })).toBeNull();
    expect(issue({ ...create, name: " " })).toBe("name");
    expect(issue({ ...create, engineId: "nope" })).toBe("engine");
    expect(issue({ ...create, engineId: "kimi" })).toBe("engineMissing");
    expect(issue({ ...create, prompt: "" })).toBe("prompt");
    expect(issue({ ...create, places: [] })).toBe("folder");
    expect(issue({ ...create, places: [""] })).toBe("folder");
    expect(issue({ ...create, places: ["new:w9"] })).toBe("folder");
    expect(issue({ ...create, places: ["/tmp/acme"], skills: ["sk9"] })).toBe("target");
    expect(issue({ kind: "agent", action: "zap", target: "ag1" })).toBe("prompt");
    expect(issue({ kind: "agent", action: "edit", target: "ag9" })).toBe("target");
    expect(issue({ kind: "agent", action: "delete", target: "ag1" })).toBeNull();
    expect(issue({ kind: "agent", action: "memory-append", target: "ag1", prompt: "" })).toBe("prompt");
    expect(issue({ kind: "agent", action: "memory-set", target: "ag1", prompt: "Likes tabs." })).toBeNull();
    expect(issue({ kind: "agent", action: "add-folder", target: "ag1", places: ["/tmp/other"] })).toBeNull();
    expect(issue({ kind: "agent", action: "remove-folder", target: "ag1", places: [] })).toBe("folder");
    expect(issue({ kind: "agent", action: "add-skill", target: "ag1", skills: [] })).toBe("target");
    expect(issue({ kind: "agent", action: "add-skill", target: "ag1", skills: ["sk9"] })).toBe("target");
    expect(issue({ kind: "agent", action: "remove-skill", target: "ag1", skills: ["sk1"] })).toBeNull();
    expect(issue({ kind: "agent", action: "edit", target: "ag1", engineId: "kimi" })).toBe("engineMissing");
    expect(issue({ kind: "agent", action: "edit", target: "ag1", places: ["relative/path"] })).toBe("folder");
    expect(issue({ kind: "agent", action: "edit", target: "ag1", skills: ["sk9"] })).toBe("target");
    expect(issue({ kind: "agent", action: "edit", target: "ag1", engineId: "claude", places: ["~/x"], skills: ["sk1"] })).toBeNull();
  });

  it("checks skill steps", () => {
    expect(issue({ kind: "skill", action: "zap", target: "sk1" })).toBe("prompt");
    expect(issue({ kind: "skill", action: "create", name: "" })).toBe("name");
    expect(issue({ kind: "skill", action: "create", name: "Lint", agents: ["ag9"] })).toBe("engine");
    expect(issue({ kind: "skill", action: "create", name: "Lint", agents: ["ag1"] })).toBeNull();
    expect(issue({ kind: "skill", action: "edit", target: "sk9" })).toBe("target");
    expect(issue({ kind: "skill", action: "edit", target: "sk1" })).toBeNull();
    expect(issue({ kind: "skill", action: "attach", target: "sk1", agents: [] })).toBe("engine");
    expect(issue({ kind: "skill", action: "detach", target: "sk1", agents: ["ag9"] })).toBe("engine");
    expect(issue({ kind: "skill", action: "attach", target: "sk1", agents: ["ag1"] })).toBeNull();
    expect(issue({ kind: "skill", action: "set-agents", target: "sk1" })).toBe("engine");
    expect(issue({ kind: "skill", action: "set-agents", target: "sk1", options: "agents=none" })).toBeNull();
    expect(issue({ kind: "skill", action: "set-agents", target: "sk1", agents: ["ag9"] })).toBe("engine");
    expect(issue({ kind: "skill", action: "set-agents", target: "sk1", agents: ["ag2"] })).toBeNull();
  });

  it("checks routine steps", () => {
    const create = { kind: "routine" as const, action: "create", name: "Evening", agentId: "ag1", schedule: "daily at 6pm", prompt: "Sweep." };
    expect(issue(create)).toBeNull();
    expect(issue({ kind: "routine", action: "zap", target: "rt1" })).toBe("prompt");
    expect(issue({ ...create, taskId: "tk9" })).toBe("target");
    expect(issue({ ...create, name: "" })).toBe("name");
    expect(issue({ ...create, agentId: "" })).toBe("engine");
    expect(issue({ ...create, agentId: "ag9" })).toBe("engine");
    expect(issue({ ...create, schedule: "whenever" })).toBe("schedule");
    expect(issue({ ...create, prompt: "" })).toBe("prompt");
    // A task brings its own title, prompt and agent, even one named but not yet saved.
    expect(issue({ kind: "routine", action: "create", taskId: "tk1", schedule: "hourly" })).toBeNull();
    expect(issue({ kind: "routine", action: "create", taskId: "tk2", schedule: "hourly" })).toBeNull();
    expect(issue({ kind: "routine", action: "edit", target: "rt9" })).toBe("target");
    expect(issue({ kind: "routine", action: "edit", target: "rt1", schedule: "whenever" })).toBe("schedule");
    expect(issue({ kind: "routine", action: "edit", target: "rt1", agentId: "ag9" })).toBe("engine");
    expect(issue({ kind: "routine", action: "edit", target: "rt1", taskId: "tk9" })).toBe("target");
    expect(issue({ kind: "routine", action: "edit", target: "rt1", schedule: "every 2 hours" })).toBeNull();
    expect(issue({ kind: "routine", action: "run", target: "rt1" })).toBeNull();
  });

  it("checks task steps", () => {
    expect(issue({ kind: "task", action: "zap", target: "tk1" })).toBe("prompt");
    expect(issue({ kind: "task", action: "handoff", target: " ", agentId: "ag1" })).toBe("target");
    expect(issue({ kind: "task", action: "handoff", target: "rn1", agentId: "ag9" })).toBe("engine");
    expect(issue({ kind: "task", action: "handoff", target: "rn1", agentId: "ag1" })).toBeNull();
    expect(issue({ kind: "task", action: "create", name: "", prompt: "", workspaceId: "ws1" })).toBe("name");
    expect(issue({ kind: "task", action: "create", name: "New", workspaceId: "ws9" })).toBe("workspace");
    expect(issue({ kind: "task", action: "create", name: "New", agentId: "ag9" })).toBe("engine");
    expect(issue({ kind: "task", action: "create", name: "New" })).toBeNull();
    expect(issue({ kind: "task", action: "create-run", workspaceId: "ws9", agentId: "ag1", prompt: "Go." })).toBe("workspace");
    expect(issue({ kind: "task", action: "create-run", workspaceId: "ws1", prompt: "Go." })).toBe("engine");
    expect(issue({ kind: "task", action: "create-run", workspaceId: "ws1", agentId: "ag1", prompt: "" })).toBe("prompt");
    expect(issue({ kind: "task", action: "create-run", workspaceId: "ws1", agentId: "ag1", prompt: "Go." })).toBeNull();
    expect(issue({ kind: "task", action: "edit", target: "tk9" })).toBe("target");
    expect(issue({ kind: "task", action: "status", target: "tk1", status: "review" })).toBeNull();
    expect(issue({ kind: "task", action: "status", target: "tk1", status: "sideways" })).toBe("prompt");
    expect(issue({ kind: "task", action: "edit", target: "tk1", workspaceId: "ws9" })).toBe("workspace");
    expect(issue({ kind: "task", action: "edit", target: "tk1", agentId: "ag9" })).toBe("engine");
    expect(issue({ kind: "task", action: "edit", target: "tk1", status: "sideways" })).toBe("prompt");
    expect(issue({ kind: "task", action: "edit", target: "tk1", status: "done" })).toBeNull();
    expect(issue({ kind: "task", action: "execute", target: "tk1" })).toBeNull();
  });

  it("checks chat steps", () => {
    expect(issue({ kind: "chat", action: "zap", target: "ch1" })).toBe("prompt");
    expect(issue({ kind: "chat", action: "create", agentId: "ag9" })).toBe("engine");
    expect(issue({ kind: "chat", action: "create", agentId: "ag1" })).toBeNull();
    expect(issue({ kind: "chat", action: "create", engineId: "kimi" })).toBe("engineMissing");
    expect(issue({ kind: "chat", action: "send", target: "ch1", prompt: "" })).toBe("prompt");
    expect(issue({ kind: "chat", action: "send", target: "ch9", prompt: "Hi" })).toBe("target");
    expect(issue({ kind: "chat", action: "send", target: "ch1", prompt: "Hi" })).toBeNull();
    expect(issue({ kind: "chat", action: "send", agentId: "ag9", prompt: "Hi" })).toBe("engine");
    expect(issue({ kind: "chat", action: "send", agentId: "ag1", prompt: "Hi" })).toBeNull();
    expect(issue({ kind: "chat", action: "send", prompt: "Hi" })).toBe("target");
    expect(issue({ kind: "chat", action: "rename", target: "ch9", name: "X" })).toBe("target");
    expect(issue({ kind: "chat", action: "rename", target: "ch1", name: " " })).toBe("name");
    expect(issue({ kind: "chat", action: "rename", target: "ch1", name: "Ideas" })).toBeNull();
    expect(issue({ kind: "chat", action: "set-engine", target: "ch1", engineId: "nope" })).toBe("engine");
    expect(issue({ kind: "chat", action: "stop", target: "ch1" })).toBeNull();
  });

  it("checks run and talk steps", () => {
    expect(issue({ kind: "run", action: "zap" })).toBe("prompt");
    expect(issue({ kind: "run", action: "mark-all-reviewed" })).toBeNull();
    expect(issue({ kind: "run", action: "continue", target: " " })).toBe("target");
    expect(issue({ kind: "run", action: "handoff", target: "rn1" })).toBe("engine");
    expect(issue({ kind: "run", action: "handoff", target: "rn1", agentId: "ag1" })).toBeNull();
    expect(issue({ kind: "talk", action: "zap", target: "pty-1" })).toBe("prompt");
    expect(issue({ kind: "talk", action: "stop", target: "pty-9" })).toBe("target");
    expect(issue({ kind: "talk", action: "review", target: "pty-1", agents: ["pty-1"] })).toBe("target");
    expect(issue({ kind: "talk", action: "send-draft", target: "pty-1" })).toBe("target");
    expect(issue({ kind: "talk", action: "review", target: "pty-1", agents: ["pty-2"] })).toBeNull();
    expect(issue({ kind: "talk", action: "stop", target: "pty-1" })).toBeNull();
  });

  it("checks a show step's view", () => {
    expect(issue({ kind: "show", view: "routines" })).toBeNull();
    expect(issue({ kind: "show", view: "attic" })).toBe("workspace");
    expect(issue({ kind: "show", workspaceId: "ws1" })).toBeNull();
  });
});

describe("showWhat's deep links", () => {
  it("opens a settings section, an agent tab, a task, or a bare view", () => {
    expect(showWhat({ kind: "show", target: "settings", options: "section=voice" }, ctx)).toMatchObject({ view: "settings", route: { view: "settings", section: "voice" } });
    expect(showWhat({ kind: "show", target: "agents", agent: "Atlas", options: "tab=memory" }, ctx)).toMatchObject({ route: { view: "agents", agentId: "ag1", tab: "memory" }, asked: "Atlas · memory" });
    expect(showWhat({ kind: "show", target: "agents", agent: "Atlas" }, ctx)).toMatchObject({ route: { view: "agents", agentId: "ag1" }, asked: "Atlas" });
    expect(showWhat({ kind: "show", target: "tasks", task: "Fix bug" }, ctx)).toMatchObject({ route: { view: "tasks", taskId: "tk1" }, asked: "Fix bug" });
    expect(showWhat({ kind: "show", target: "tasks", task: "nothing like it" }, ctx)).toMatchObject({ view: "tasks", asked: "Tasks" });
    expect(showWhat({ kind: "show", target: "orchestrator" }, ctx)).toMatchObject({ view: "orchestrator", asked: "Viby" });
  });

  it("finds an agent, task, routine, skill, chat, copy or run by name", () => {
    expect(showWhat({ kind: "show", target: "Atlas", options: "tab=skills" }, ctx)).toMatchObject({ view: "agents", route: { view: "agents", agentId: "ag1", tab: "skills" }, asked: "Atlas · skills" });
    expect(showWhat({ kind: "show", target: "Fix bug" }, ctx)).toMatchObject({ view: "tasks", route: { view: "tasks", taskId: "tk1" } });
    expect(showWhat({ kind: "show", target: "Daily" }, ctx)).toMatchObject({ view: "routines", route: { view: "routines", routineId: "rt1" } });
    expect(showWhat({ kind: "show", target: "Audit" }, ctx)).toMatchObject({ view: "skills", route: { view: "skills", skillId: "sk1" } });
    expect(showWhat({ kind: "show", target: "Scratch" }, ctx)).toMatchObject({ view: "chat", route: { view: "chat", chatId: "ch1" } });
    expect(showWhat({ kind: "show", target: "Design notes" }, ctx)).toMatchObject({ view: "agents", route: { view: "agents", agentId: "ag1", tab: "chats", chatId: "ch2" } });
    expect(showWhat({ kind: "show", target: "tray-glow" }, ctx)).toMatchObject({ view: "orchestrator", route: { view: "orchestrator", copyId: "cp1" } });
    expect(showWhat({ kind: "show", target: "Nightly sweep" }, ctx)).toMatchObject({ view: "runs", route: { view: "runs", runId: "rn1" } });
    expect(showWhat({ kind: "show", target: "zzzz qqqq" }, ctx)).toEqual({ target: "", workspaceId: "", asked: "zzzz qqqq" });
  });
});

describe("resolvePlan for entity inspections and hand-offs", () => {
  it("names the entity an inspect step reads, explicitly or by what it is called", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "inspect", action: "routine", target: "Daily" },
          { kind: "inspect", action: "task", target: "Fix bug" },
          { kind: "inspect", action: "chat", target: "Scratch" },
          { kind: "inspect", action: "run", target: "Nightly sweep" },
          { kind: "inspect", action: "run", target: "run-unknown" },
          { kind: "inspect", target: "Atlas" },
          { kind: "inspect", target: "Audit" },
          { kind: "inspect", target: "Daily" },
          { kind: "inspect", target: "Fix bug" },
          { kind: "inspect", target: "Scratch" },
          { kind: "inspect", target: "Nightly sweep" },
        ],
      },
      ctx,
    );
    expect(steps.map((s) => [s.action, s.target])).toEqual([
      ["routine", "rt1"],
      ["task", "tk1"],
      ["chat", "ch1"],
      ["run", "rn1"],
      ["run", "run-unknown"],
      ["agent", "ag1"],
      ["skill", "sk1"],
      ["routine", "rt1"],
      ["task", "tk1"],
      ["chat", "ch1"],
      ["run", "rn1"],
    ]);
  });

  it("hands a run to an agent and leaves a task that's only named as itself", () => {
    const steps = resolvePlan(
      {
        say: "",
        steps: [
          { kind: "task", action: "handoff", target: "Nightly sweep", agent: "Scout" },
          { kind: "task", target: "Fix bug" },
        ],
      },
      ctx,
    );
    expect(steps[0]).toMatchObject({ target: "rn1", agentId: "ag2" });
    expect(steps[1]).toMatchObject({ target: "tk1", prompt: "", asked: "Fix bug" });
  });

  it("keeps closing a pane, or starting over uncommitted edits in place, from going at once in a call", () => {
    expect(safeInCall(st({ kind: "workbench", prompt: "close-pane" }), ctx)).toBe(false);
    expect(safeInCall(st({ kind: "workbench", prompt: "split" }), ctx)).toBe(true);
    expect(safeInCall(st({ kind: "start", engineId: "claude", workspaceId: "ws1", prompt: "Fix it.", dirty: 3 }), ctx)).toBe(false);
    expect(safeInCall(st({ kind: "start", engineId: "claude", workspaceId: "ws1", branch: "fix-it", prompt: "Fix it.", dirty: 3 }), ctx)).toBe(true);
  });
});

describe("the phone's Viby card", () => {
  it("checks a waiting plan's task steps against the board", () => {
    const turns: OrchestratorTurn[] = [
      {
        id: "t1",
        at: "",
        from: "vibeforge",
        text: "On it.",
        plan: "waiting",
        steps: [st({ id: "a", kind: "task", action: "edit", target: "tk1", status: "done" }), st({ id: "b", kind: "task", action: "edit", target: "tk9" })],
      },
    ];
    const phone = buildPhoneOrchestrator({
      view: { engineId: "claude", engineReady: true, mode: "plan", thinking: false, turns },
      engines: [{ id: "claude", label: "Claude Code", bin: "claude", available: true }],
      workspaces: [{ id: "ws1", name: "Acme", path: "/tmp/acme" }],
      live: [],
      hear: false,
      tasks: [
        { id: "tk1", title: "Fix bug", status: "todo", agentId: "ag1", workspaceId: "ws1" },
        { id: "tk3", title: "Loose", status: "todo", agentId: null, workspaceId: null },
      ],
    });
    expect(phone.turns.at(-1)?.steps?.map((item) => item.issue)).toEqual([null, "target"]);
  });
});
