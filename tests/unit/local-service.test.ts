import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setup, until } from "./fixtures/service-harness.js";

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
      ANTHROPIC_API_KEY: "local",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder:32b",
    });
    expect(ctx.svc.live.get(launched.ptyId)?.localModel).toBe("qwen3-coder:32b");

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

  it("runs Viby against the local server even without a coding CLI harness, preserves rules for KV cache, and falls back to cloud", async () => {
    const ctx = setup();
    ctx.svc.saveEngines([
      { id: "claude", label: "Claude Code", bin: "claude", args: [], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
    ]);
    ctx.host.resolveBin = (bin) => (bin === "claude" ? "/usr/bin/claude" : null);

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

    await ctx.svc.orchestratorAsk("Follow up");
    expect(localCalls).toHaveLength(2);
    // Rules prompt prefix stays identical across turns for local KV cache reuse.
    expect(localCalls[1].rules).toBe(localCalls[0].rules);

    // Turning Local mode off falls back to Claude without dropping the thread.
    ctx.svc.saveSettings({ local: { active: false } });
    expect(ctx.svc.orchestratorView().engineId).toBe("claude");
    await ctx.svc.orchestratorAsk("Back to cloud");
    expect(cloudCalls).toEqual(["/usr/bin/claude"]);

    // Settings step can switch Local mode back on.
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
    await until(() => ctx.svc.getSettings().local.active === true);
    expect(ctx.svc.getSettings().local.enabled).toBe(true);
    ctx.svc.close();
  });
});
