import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import { INTERVAL, setup, started, tempDir, until } from "./fixtures/service-harness.js";

describe("Local AI across ServiceCore, engines, workspaces, agents, and Viby", () => {
  it("exposes a virtual local engine only when enabled and excludes it from engines.json", () => {
    const ctx = setup();
    ctx.host.resolveBin = (bin) => (bin === "argy" || bin === "pasty" || bin === "opencode" ? `/usr/bin/${bin}` : null);

    expect(ctx.svc.listEngines().some((e) => e.id === "local")).toBe(false);

    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: false,
        overrideAgents: false,
        url: "http://127.0.0.1:8080",
        model: "bonsai-2.5-27b",
        vibyModel: "",
        harness: "auto",
      },
    });

    const withLocal = ctx.svc.listEngines();
    const localEngine = withLocal.find((e) => e.id === "local");
    expect(localEngine).toMatchObject({
      id: "local",
      available: true,
      local: true,
      bin: "opencode",
      path: "/usr/bin/opencode",
    });
    expect(localEngine?.label).toContain("Local");

    // Passing `local` back into saveEngines never writes it to engines.json.
    ctx.svc.saveEngines(withLocal.map((e) => ({ id: e.id, label: e.label, bin: e.bin, args: e.args })));
    const persisted = JSON.parse(fs.readFileSync(path.join(ctx.configRoot, "engines.json"), "utf8")) as {
      engines: Array<{ id: string }>;
    };
    expect(persisted.engines.some((e) => e.id === "local")).toBe(false);
    ctx.svc.close();
  });

  it("forwards ephemeral env and extraArgs per spawn without duplicating --model", async () => {
    const ctx = setup();
    ctx.host.resolveBin = (bin) => (bin === "argy" || bin === "claude" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];

    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        url: "http://mac-mini.local:11434/v1",
        model: "qwen3-coder:32b",
        vibyModel: "",
        harness: "claude",
      },
    });

    const launched = await ctx.svc.startEngine({
      workspaceId: ws.id,
      engineId: "local",
      prompt: "Refactor foo",
    });

    expect(ctx.spawns).toHaveLength(1);
    const spawnReq = ctx.spawns[0];
    expect(spawnReq.argv[0]).toBe("/usr/bin/claude");
    expect(spawnReq.argv.filter((a) => a === "--model")).toHaveLength(1);
    expect(spawnReq.argv).toContain("qwen3-coder:32b");
    expect(spawnReq.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://mac-mini.local:11434",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "local",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder:32b",
    });
    const settingsIdx = spawnReq.argv.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(0);
    expect(JSON.parse(spawnReq.argv[settingsIdx + 1] ?? "{}")).toEqual({ env: spawnReq.env });
    expect(ctx.svc.live.get(launched.ptyId)?.localModel).toBe("qwen3-coder:32b");

    // Unlisted local models are stripped, while server-probed models are accepted by resolveLaunchTarget.
    expect(ctx.svc.resolveLaunchTarget({ engineId: "local", model: "unlisted-model" })).toEqual({ engineId: "local" });
    ctx.svc.recordLocalProbe({
      url: "http://mac-mini.local:11434/v1",
      reachable: true,
      kind: "ollama",
      isLoopback: false,
      models: [{ id: "llama3.3:70b" }],
      contextLength: 32768,
      error: null,
    });
    expect(ctx.svc.resolveLaunchTarget({ engineId: "local", model: "llama3.3:70b" })).toEqual({
      engineId: "local",
      model: "llama3.3:70b",
    });

    // Passing an explicit cloud `model` hint through `launch()` never adds a second `--model` flag to local spawns.
    const resolvedLocal = ctx.svc.requireEngine("local");
    await ctx.svc.launch({
      origin: "code",
      title: resolvedLocal.row.label,
      engine: resolvedLocal,
      cwd: ws.path,
      prompt: "Second check",
      promptText: "Second check",
      workspaceId: ws.id,
      model: "ignored-cloud-model",
    });
    expect(ctx.spawns[1].argv.filter((a) => a === "--model")).toHaveLength(1);
    expect(ctx.spawns[1].argv).not.toContain("ignored-cloud-model");
    ctx.svc.close();
  });

  it("switches default chats/workspaces to local in Local mode while respecting overrideAgents for saved Agents", async () => {
    const ctx = setup();
    ctx.host.resolveBin = (bin) => (bin === "argy" || bin === "opencode" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];
    const agent = await ctx.svc.saveAgent({ name: "Reviewer", brief: "Review PRs.", engine: "argy", places: [ctx.place] });

    ctx.svc.saveSettings({
      defaultEngine: "argy",
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        url: "http://127.0.0.1:8080",
        model: "bonsai-2.5-27b",
        vibyModel: "",
        harness: "opencode",
      },
    });

    // Default workspaces & chats use local.
    const defaultStart = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "" });
    expect(defaultStart.ptyId).toBeTruthy();
    expect(ctx.spawns[0].argv[0]).toBe("/usr/bin/opencode");

    const defaultChat = ctx.svc.createChat({});
    expect(defaultChat.engine).toBe("local");

    // Saved agent keeps its own cloud CLI when overrideAgents is off.
    const chat1 = ctx.svc.createChat({ agentId: agent.id });
    await ctx.svc.sendChat(chat1.id, "Check 1");
    expect(ctx.spawns[1].argv[0]).toBe("/usr/bin/argy");

    // Enabling overrideAgents routes saved Agents to local without modifying agent.yaml.
    ctx.svc.saveSettings({ local: { overrideAgents: true } });
    const chat2 = ctx.svc.createChat({ agentId: agent.id });
    await ctx.svc.sendChat(chat2.id, "Check 2");
    expect(ctx.spawns[2].argv[0]).toBe("/usr/bin/opencode");
    expect(ctx.svc.getAgent(agent.id)?.engine).toBe("argy");
    const agentYaml = fs.readFileSync(path.join(ctx.configRoot, "agents", agent.id, "agent.yaml"), "utf8");
    expect(agentYaml).toContain("engine: argy");
    ctx.svc.close();
  });

  it("drops cloud model aliases such as opus when overrideAgents redirects a saved Agent or start step to local", async () => {
    const ctx = setup();
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" || bin === "opencode" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];
    const agent = await ctx.svc.saveAgent({ name: "Reviewer", brief: "Review PRs.", engine: "claude", places: [ctx.place] });

    ctx.svc.saveSettings({
      orchestrator: { engine: "claude", mode: "never", terse: true, model: "", effort: "", projectsFolder: "" },
      local: {
        enabled: true,
        active: true,
        overrideAgents: true,
        url: "http://127.0.0.1:8080",
        model: "bonsai-2.5-27b",
        vibyModel: "",
        harness: "opencode",
      },
    });

    expect(ctx.svc.resolveLaunchTarget({ engineId: "claude", fromAgent: true, model: "opus" })).toEqual({ engineId: "local" });

    ctx.svc.orchestrator.localRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        say: "Starting Reviewer.",
        steps: [{ kind: "start", engine: "claude", agent: agent.id, workspace: ws.id, model: "opus", prompt: "Fix bug" }],
      }),
      stderr: "",
      timedOut: false,
    });

    await ctx.svc.orchestratorAsk("Have Reviewer fix the bug with opus");
    await until(() => ctx.spawns.length === 1);
    expect(ctx.spawns[0].argv[0]).toBe("/usr/bin/opencode");
    expect(ctx.spawns[0].argv).not.toContain("opus");
    const ocCfg = JSON.parse(ctx.spawns[0].env?.OPENCODE_CONFIG_CONTENT ?? "{}") as { model?: string };
    expect(ocCfg.model).toBe("vibeforge-local/bonsai-2.5-27b");
    await ctx.exit("pty-1");
    ctx.svc.close();
  });

  it("routes Tasks, Routines, and tick() via overrideAgents without mutating agent.yaml", async () => {
    const ctx = setup({ appStartedAt: new Date(9 * INTERVAL), now: () => new Date(9 * INTERVAL) });
    ctx.svc.saveEngines([
      { id: "argy", label: "Argy", bin: "argy", args: ["--flag"], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "argy" || bin === "opencode" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];
    const agent = await ctx.svc.saveAgent({
      name: "Worker",
      brief: "Do work.",
      engine: "argy",
      places: [ctx.place],
      allowRoutines: true,
    });
    const task = ctx.svc.saveTask({ title: "Tidy", body: "Tidy files", agentId: agent.id, workspaceId: ws.id });
    const routine = ctx.svc.saveRoutine({
      name: "Every5",
      agentId: agent.id,
      schedule: { kind: "every", minutes: 5 },
      prompt: "Check logs",
    });
    ctx.svc.store.writeRoutine({ ...ctx.svc.store.getRoutine(routine.id)!, lastFiredAt: null });

    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        url: "http://127.0.0.1:8080",
        model: "bonsai-2.5-27b",
        vibyModel: "",
        harness: "opencode",
      },
    });

    const t1 = started(await ctx.svc.executeTask(task.id));
    expect(ctx.spawns[0].argv[0]).toBe("/usr/bin/argy");
    await ctx.exit(t1.ptyId);

    const r1 = started(await ctx.svc.runRoutineNow(routine.id));
    expect(ctx.spawns[1].argv[0]).toBe("/usr/bin/argy");
    await ctx.exit(r1.ptyId);

    await ctx.svc.tick(new Date(10 * INTERVAL + 1000));
    expect(ctx.spawns).toHaveLength(3);
    expect(ctx.spawns[2].argv[0]).toBe("/usr/bin/argy");
    await ctx.exit("pty-3");

    ctx.svc.saveSettings({ local: { overrideAgents: true } });

    const t2 = started(await ctx.svc.executeTask(task.id));
    expect(ctx.spawns[3].argv[0]).toBe("/usr/bin/opencode");
    await ctx.exit(t2.ptyId);

    const r2 = started(await ctx.svc.runRoutineNow(routine.id));
    expect(ctx.spawns[4].argv[0]).toBe("/usr/bin/opencode");
    await ctx.exit(r2.ptyId);

    await ctx.svc.tick(new Date(11 * INTERVAL + 1000));
    expect(ctx.spawns).toHaveLength(6);
    expect(ctx.spawns[5].argv[0]).toBe("/usr/bin/opencode");
    await ctx.exit("pty-6");

    const agentYaml = fs.readFileSync(path.join(ctx.configRoot, "agents", agent.id, "agent.yaml"), "utf8");
    expect(agentYaml).toContain("engine: argy");
    ctx.svc.close();
  });

  it("rebuilds fresh Viby rules every local turn so live CLIs become visible, and requires Go for local: on", async () => {
    const ctx = setup();
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" ? "/usr/bin/claude" : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];

    // No coding CLI harness for local (opencode missing), yet Viby still runs locally.
    ctx.svc.saveSettings({
      orchestrator: { engine: "claude", mode: "go", terse: true, model: "", effort: "", projectsFolder: "" },
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        url: "http://127.0.0.1:11434",
        model: "qwen3:32b",
        vibyModel: "qwen3:14b",
        harness: "opencode",
      },
    });

    const localCalls: Array<{ url: string; model: string; rules: string }> = [];
    ctx.svc.orchestrator.localRunner = async (req) => {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      localCalls.push({ url: req.url, model: req.model, rules: sys });
      return { code: 0, stdout: JSON.stringify({ say: "Local reply.", steps: [] }), stderr: "", timedOut: false };
    };

    const cloudCalls: string[] = [];
    ctx.svc.orchestrator.runner = async (argv) => {
      cloudCalls.push(argv[0]);
      return { code: 0, stdout: JSON.stringify({ say: "Cloud reply.", steps: [] }), stderr: "", timedOut: false };
    };

    await ctx.svc.orchestratorAsk("Hi Viby");
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0].model).toBe("qwen3:14b");
    expect(localCalls[0].url).toBe("http://127.0.0.1:11434");
    expect(localCalls[0].rules).toContain("- Local AI: on (Local mode active)");

    // Start a live CLI between Turn 1 and Turn 2: fresh rules rebuild must show it on Turn 2 and Turn 3.
    const live = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "claude" });
    await ctx.svc.orchestratorAsk("What is running?");
    await ctx.svc.orchestratorAsk("Follow up");
    expect(localCalls).toHaveLength(3);
    expect(localCalls.map((c) => c.rules.includes(live.ptyId))).toEqual([false, true, true]);
    await ctx.exit(live.ptyId);

    // Turning Local mode off falls back to Claude without dropping the thread.
    ctx.svc.saveSettings({ local: { active: false } });
    expect(ctx.svc.orchestratorView().engineId).toBe("claude");
    await ctx.svc.orchestratorAsk("Back to cloud");
    expect(cloudCalls).toEqual(["/usr/bin/claude"]);

    // Settings step enabling Local mode requires Go under mode: "go" and enables useForViby on approval.
    ctx.svc.orchestrator.runner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        say: "Switching Local mode on.",
        steps: [{ kind: "settings", target: "local", prompt: "on" }],
      }),
      stderr: "",
      timedOut: false,
    });
    await ctx.svc.orchestratorAsk("Turn on local mode");
    expect(ctx.svc.getSettings().local.active).toBe(false);
    const waitingTurn = ctx.svc.orchestratorView().turns.at(-1);
    expect(waitingTurn?.plan).toBe("waiting");

    await ctx.svc.orchestratorRun(waitingTurn!.id);
    expect(ctx.svc.getSettings().local.active).toBe(true);
    expect(ctx.svc.getSettings().local.enabled).toBe(true);
    expect(ctx.svc.getSettings().local.useForViby).toBe(true);
    ctx.svc.close();
  });

  it("refuses bare continue flags across local/cloud or harness switches and persists localHarness/localModel across RunIndex reload", async () => {
    let nowMs = 1_700_000_000_000;
    const ctx = setup({
      now: () => {
        nowMs += 1000;
        return new Date(nowMs);
      },
    });
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" || bin === "opencode" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];
    const agent = await ctx.svc.saveAgent({ name: "ClaudeAgent", brief: "Help", engine: "claude", places: [ctx.place] });

    // (a1) Workspace: Cloud Claude run followed by Local Claude run -> continuing older Cloud run must not pass --continue.
    const cloudRun = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "claude", prompt: "Cloud task" });
    await ctx.exit(cloudRun.ptyId);

    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        url: "http://127.0.0.1:11434",
        model: "qwen3-coder:32b",
        vibyModel: "",
        harness: "claude",
      },
    });
    const localRun = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "local", prompt: "Local task" });
    await ctx.exit(localRun.ptyId);

    ctx.svc.saveSettings({ local: { active: false } });
    const continuedCloud = await ctx.svc.continueRun(cloudRun.runId);
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/claude");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(continuedCloud.ptyId);

    // (a2) Chat: Agent cloud chat run followed by newer Local Claude run in same folder -> continueChat drops --continue.
    const chat = ctx.svc.createChat({ agentId: agent.id });
    const chatRes = await ctx.svc.sendChat(chat.id, "Cloud chat msg");
    await ctx.exit(chatRes.ptyId);

    ctx.svc.saveSettings({ local: { active: true, overrideAgents: true, harness: "claude", model: "qwen3-coder:32b" } });
    const newerLocal = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "local", prompt: "Newer local run" });
    await ctx.exit(newerLocal.ptyId);

    ctx.svc.saveSettings({ local: { overrideAgents: false } });
    const continuedChat = await ctx.svc.continueChat(chat.id);
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/claude");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(continuedChat.ptyId);

    // (b) Harness switch: Local Claude run -> switch harness to opencode -> continueRun starts fresh without --continue.
    ctx.svc.saveSettings({ local: { active: true, harness: "claude", model: "qwen3-coder:32b" } });
    const harnessRun = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "local", prompt: "Claude harness" });
    await ctx.exit(harnessRun.ptyId);

    ctx.svc.saveSettings({ local: { harness: "opencode" } });
    const switchedHarness = await ctx.svc.continueRun(harnessRun.runId);
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/opencode");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(switchedHarness.ptyId);

    // (c) Persist localHarness and localModel in meta.json and across Store / RunIndex v4 reload + reindex.
    const metaDir = ctx.svc.getRun(harnessRun.runId)?.run.dir;
    expect(metaDir).toBeTruthy();
    const metaJson = JSON.parse(fs.readFileSync(path.join(metaDir!, "meta.json"), "utf8")) as {
      localHarness?: string;
      localModel?: string;
    };
    expect(metaJson.localHarness).toBe("claude");
    expect(metaJson.localModel).toBe("qwen3-coder:32b");

    await ctx.svc.close();
    const freshStore = new Store(ctx.configRoot, ctx.dataRoot);
    expect(freshStore.getRun(harnessRun.runId)).toMatchObject({
      localHarness: "claude",
      localModel: "qwen3-coder:32b",
    });
    freshStore.reindex();
    expect(freshStore.getRun(harnessRun.runId)).toMatchObject({
      localHarness: "claude",
      localModel: "qwen3-coder:32b",
    });
    freshStore.close();
  });

  it("keeps coding on Local while picking a cloud Viby planner via useForViby, and restores useForViby when re-enabling local.active", async () => {
    const ctx = setup();
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" || bin === "opencode" ? `/usr/bin/${bin}` : null);
    ctx.svc.addWorkspace(ctx.place);
    const ws = ctx.svc.listWorkspaces().workspaces[0];

    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        useForViby: true,
        url: "http://127.0.0.1:11434",
        model: "qwen3:32b",
        vibyModel: "qwen3:14b",
        harness: "opencode",
      },
    });
    expect(ctx.svc.orchestratorView().engineId).toBe("local");

    const cur = ctx.svc.getSettings();
    ctx.svc.saveSettings({
      orchestrator: { ...cur.orchestrator, engine: "claude" },
      local: { useForViby: false },
    });
    expect(ctx.svc.orchestratorView().engineId).toBe("claude");
    expect(ctx.svc.getSettings().local.active).toBe(true);
    expect(ctx.svc.getSettings().local.useForViby).toBe(false);

    const codeRun = await ctx.svc.startEngine({ workspaceId: ws.id, engineId: "" });
    expect(ctx.spawns[0].argv[0]).toBe("/usr/bin/opencode");
    await ctx.exit(codeRun.ptyId);

    ctx.svc.saveSettings({ local: { active: false } });
    ctx.svc.saveSettings({ local: { active: true } });
    expect(ctx.svc.getSettings().local.useForViby).toBe(true);
    expect(ctx.svc.orchestratorView().engineId).toBe("local");
    ctx.svc.close();
  });

  it("surfaces localContextWarning when the probed context window is smaller than Local Viby needs", () => {
    const ctx = setup();
    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        useForViby: true,
        url: "http://127.0.0.1:11434",
        model: "qwen3:32b",
        vibyModel: "qwen3:14b",
        harness: "auto",
      },
    });

    ctx.svc.recordLocalProbe({
      url: "http://127.0.0.1:11434",
      reachable: true,
      kind: "ollama",
      isLoopback: true,
      models: [{ id: "qwen3:14b", contextLength: 4096 }],
      contextLength: 4096,
      error: null,
    });
    const warned = ctx.svc.orchestratorView().localContextWarning;
    expect(warned).toBeTruthy();
    expect(warned?.contextLength).toBe(4096);
    expect(warned!.neededTokens).toBeGreaterThan(4096);

    ctx.svc.recordLocalProbe({
      url: "http://127.0.0.1:11434",
      reachable: true,
      kind: "ollama",
      isLoopback: true,
      models: [{ id: "qwen3:14b", contextLength: 65536 }],
      contextLength: 65536,
      error: null,
    });
    expect(ctx.svc.orchestratorView().localContextWarning).toBeUndefined();
    ctx.svc.close();
  });

  it("loads legacy settings.json without a local key using safe defaults and preserves unknown fields", () => {
    const configRoot = tempDir();
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, "settings.json"),
      JSON.stringify({ version: 1, defaultEngine: "argy", futureField: "keep-me" }),
    );
    const ctx = setup({ configRoot });

    expect(ctx.svc.getSettings().local).toMatchObject({
      enabled: false,
      active: false,
      overrideAgents: false,
      useForViby: true,
      model: "",
      vibyModel: "",
      harness: "auto",
    });

    ctx.svc.saveSettings({ notify: false });
    const persisted = JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(persisted.futureField).toBe("keep-me");
    expect(persisted.notify).toBe(false);
    expect(persisted.defaultEngine).toBe("argy");
    expect(persisted.local).toMatchObject({ useForViby: true });
    ctx.svc.close();
  });

  it("preserves bare continueArgs in Code when previous is null while still guarding mode and harness changes", async () => {
    let nowMs = 1_700_000_100_000;
    const ctx = setup({
      now: () => {
        nowMs += 1000;
        return new Date(nowMs);
      },
    });
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
      { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" || bin === "opencode" ? `/usr/bin/${bin}` : null);

    // 1. No prior VibeForge runs at all: Code Continue keeps main's bare --continue behavior.
    const dir1 = tempDir();
    ctx.svc.addWorkspace(dir1);
    const ws1 = ctx.svc.listWorkspaces().workspaces.find((w) => w.path === dir1)!;
    const noRunsCode = await ctx.svc.startEngine({ workspaceId: ws1.id, engineId: "claude", continueSession: true });
    expect(ctx.spawns.at(-1)?.argv.at(-1)).toBe("--continue");
    await ctx.exit(noRunsCode.ptyId);

    // 2. Folder previously used only via a Cloud Task (no prior "code" run): Code Continue still passes --continue.
    const dir2 = tempDir();
    ctx.svc.addWorkspace(dir2);
    const ws2 = ctx.svc.listWorkspaces().workspaces.find((w) => w.path === dir2)!;
    const agent2 = await ctx.svc.saveAgent({ name: "CloudWorker", brief: "Work", engine: "claude", places: [dir2] });
    const task2 = ctx.svc.saveTask({ title: "Cloud task", body: "Check", agentId: agent2.id, workspaceId: ws2.id });
    const taskRun2 = started(await ctx.svc.executeTask(task2.id));
    await ctx.exit(taskRun2.ptyId);

    const afterTaskCode = await ctx.svc.startEngine({ workspaceId: ws2.id, engineId: "claude", continueSession: true });
    expect(ctx.spawns.at(-1)?.argv.at(-1)).toBe("--continue");
    await ctx.exit(afterTaskCode.ptyId);

    // 3. Opposite mode in folder with no prior Cloud "code" run (previous === null): block bare --continue.
    const dir3 = tempDir();
    ctx.svc.addWorkspace(dir3);
    const ws3 = ctx.svc.listWorkspaces().workspaces.find((w) => w.path === dir3)!;
    ctx.svc.saveSettings({
      local: {
        enabled: true,
        active: true,
        overrideAgents: false,
        useForViby: true,
        url: "http://127.0.0.1:11434",
        model: "qwen3-coder:32b",
        vibyModel: "",
        harness: "claude",
      },
    });
    const localRun3 = await ctx.svc.startEngine({ workspaceId: ws3.id, engineId: "local", prompt: "Local session" });
    await ctx.exit(localRun3.ptyId);

    ctx.svc.saveSettings({ local: { active: false } });
    const blockedCrossMode = await ctx.svc.startEngine({ workspaceId: ws3.id, engineId: "claude", continueSession: true });
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/claude");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(blockedCrossMode.ptyId);

    // 4. Different local harness in folder with previous === null (only a Local claude chat ran): block bare --continue on opencode.
    const dir4 = tempDir();
    ctx.svc.addWorkspace(dir4);
    const ws4 = ctx.svc.listWorkspaces().workspaces.find((w) => w.path === dir4)!;
    const agent4 = await ctx.svc.saveAgent({ name: "ChatWorker", brief: "Chat", engine: "claude", places: [dir4] });
    ctx.svc.saveSettings({ local: { active: true, overrideAgents: true, harness: "claude", model: "qwen3-coder:32b" } });
    const chat4 = ctx.svc.createChat({ agentId: agent4.id });
    const chatRun4 = await ctx.svc.sendChat(chat4.id, "Local claude chat");
    await ctx.exit(chatRun4.ptyId);

    ctx.svc.saveSettings({ local: { harness: "opencode" } });
    const blockedHarnessSwitch = await ctx.svc.startEngine({ workspaceId: ws4.id, engineId: "local", continueSession: true });
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/opencode");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(blockedHarnessSwitch.ptyId);

    // 5. Brand-new plain chat still starts fresh without --continue.
    ctx.svc.saveSettings({ local: { active: false, overrideAgents: false } });
    const freshChat = ctx.svc.createChat({ engine: "claude" });
    const freshChatRun = await ctx.svc.sendChat(freshChat.id, "Brand new chat");
    expect(ctx.spawns.at(-1)?.argv[0]).toBe("/usr/bin/claude");
    expect(ctx.spawns.at(-1)?.argv).not.toContain("--continue");
    await ctx.exit(freshChatRun.ptyId);

    await ctx.svc.close();
  });
});
