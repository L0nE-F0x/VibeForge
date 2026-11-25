import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanQuery,
  damerauSimilarity,
  extractEarlySay,
  fuzzyMatchName,
  matchName,
  normalizePlanCandidate,
  orchestratorVoiceWords,
  phoneticKey,
  readBrainOutput,
  repairJsonObjects,
  repairJsonText,
  resolveLocalReflex,
  resolvePlan,
  resolveSettingsStep,
  STEP_KINDS,
  stripCodeFences,
  type PlanContext,
} from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import { setup, until } from "./fixtures/service-harness.js";

describe("Viby accuracy: fuzzy, phonetic, homophones, and @mentions", () => {
  const workspaces = [
    { id: "vf", name: "VibeForge", folder: "~/Projects/VibeForge", git: true },
    { id: "sl", name: "Star Ledger", folder: "~/Projects/star-ledger", git: true },
    { id: "om", name: "Omarchy Config", folder: "~/Projects/omarchy-config", git: true },
    { id: "hl", name: "Hyprland Dots", folder: "~/Projects/hyprland-dots", git: true },
  ];
  const engines = [
    { id: "claude", label: "Claude Code", available: true, bin: "claude" },
    { id: "codex", label: "Codex", available: true, bin: "codex" },
    { id: "grok", label: "Grok Build", available: true, bin: "grok" },
    { id: "agy", label: "Antigravity CLI", available: true, bin: "agy" },
  ];

  it("matches STT homophones, minor typos, acronyms, and @mentions while refusing ties", () => {
    expect(cleanQuery('  "@VibeForge" ')).toBe("VibeForge");
    expect(damerauSimilarity("", "")).toBe(1);
    expect(damerauSimilarity("abc", "")).toBe(0);
    expect(damerauSimilarity("ab", "ba")).toBe(0.5);
    expect(phoneticKey("Star Ledger")).toBe(phoneticKey("Star Leger"));

    expect(matchName("@VibeForge", workspaces, (w) => [w.name], true)?.id).toBe("vf");
    expect(matchName("VibeForje", workspaces, (w) => [w.name], true)?.id).toBe("vf");
    expect(matchName("Star Leger", workspaces, (w) => [w.name], true)?.id).toBe("sl");
    expect(matchName("oh marchy config", workspaces, (w) => [w.name], true)?.id).toBe("om");
    expect(matchName("hyperland dots", workspaces, (w) => [w.name], true)?.id).toBe("hl");
    expect(matchName("VBF", [{ name: "Vibe Build Flow" }, { name: "Dune" }], (i) => [i.name])?.name).toBe("Vibe Build Flow");

    // Multi-word STT tie-breaking ("Star Leger" with both Star Ledger and Star Map present)
    const starSet = [{ name: "Star Ledger" }, { name: "Star Map" }];
    expect(matchName("Star Leger", starSet, (s) => [s.name], true)?.name).toBe("Star Ledger");
    expect(matchName("Star", starSet, (s) => [s.name], true)).toBeNull();

    // Ambiguous fuzzy candidates refuse to guess silently
    expect(fuzzyMatchName("Alpa", [{ name: "Alpha" }, { name: "Alpah" }], (i) => [i.name])).toBeNull();
    expect(matchName("Cloud", engines, (e) => [e.id, e.label], true)?.id).toBe("claude");
    expect(matchName("Clawd", engines, (e) => [e.id, e.label], true)?.id).toBe("claude");
    expect(matchName("code x", engines, (e) => [e.id, e.label], true)?.id).toBe("codex");
    expect(matchName("Grock", engines, (e) => [e.id, e.label], true)?.id).toBe("grok");
  });

  it("matches homophone engines in settings steps and @mentions in local reflexes", () => {
    const context: PlanContext = {
      workspaces,
      engines,
      running: [],
      agents: [{ id: "ag-1", name: "Reviewer", engine: "claude" }],
    };
    const res = resolveSettingsStep({ target: "viby.engine", engine: "Grock" }, { engines });
    expect(res.action).toMatchObject({ op: "viby", engine: "grok" });
    expect(resolveLocalReflex("switch to @VibeForge", context)).toMatchObject({ kind: "steps", tag: "show", rawSteps: [{ kind: "show", workspace: "vf" }] });
    expect(resolveLocalReflex("switch to VibeForje", context)).toMatchObject({ kind: "steps", tag: "show", rawSteps: [{ kind: "show", workspace: "vf" }] });

    expect(orchestratorVoiceWords(["star-ledger"])).toEqual(["Viby", "Vibey", "star-ledger", "star ledger", "branch", "workspace"]);
    const desktopHints = orchestratorVoiceWords(["star-ledger"], { agents: ["Reviewer"], engines: ["Claude Code"] });
    expect(desktopHints).toContain("Omarchy");
    expect(desktopHints).toContain("Reviewer");
    expect(desktopHints).toContain("Claude Code");
  });

  it("resolves plans with STT-misheard workspace and engine names", () => {
    const context: PlanContext = { workspaces, engines, running: [] };
    const steps = resolvePlan(
      {
        say: "Starting.",
        steps: [{ kind: "start", engine: "Cloud Code", workspace: "Star Leger", branch: "fix-bug", prompt: "Fix bug" }],
      },
      context,
    );
    expect(steps[0]).toMatchObject({ engineId: "claude", workspaceId: "sl", branch: "fix-bug" });
  });
});

describe("Viby accuracy: tolerant JSON repair, aliases, and auto-repair retry", () => {
  it("repairs fenced JSON, trailing commas, control newlines, truncated objects, and field aliases", () => {
    expect(stripCodeFences("```json\n{\"say\":\"hi\",\"steps\":[]}\n```")).toBe('{"say":"hi","steps":[]}');
    expect(repairJsonText('{"say":"line1\nline2\t!", "steps":[],}')).toBe('{"say":"line1\\nline2\\t!", "steps":[]}');

    const noisy = [
      "Here is the plan:",
      "```json",
      "{",
      '  "plan": {',
      '    "message": "Hello',
      'world",',
      '    "actions": [',
      '      { "type": "START", "cli": "claude", "project": "VibeForge", "after": "true", },',
      '      { "kind": "agent", "action": "create", "name": "Ops", "places": "~/Projects/a, ~/Projects/b" },',
      "    ],",
      '    "hangup": "false",',
      "  },",
      "}",
      "```",
    ].join("\n");

    const parsed = readBrainOutput(noisy);
    expect(parsed.plan).toEqual({
      say: "Hello\nworld",
      steps: [
        {
          kind: "start",
          engine: "claude",
          workspace: "VibeForge",
          branch: undefined,
          prompt: undefined,
          target: undefined,
          folder: undefined,
          git: false,
          model: undefined,
          effort: undefined,
          inPlace: false,
          after: true,
        },
        {
          kind: "agent",
          action: "create",
          name: "Ops",
          engine: undefined,
          workspace: undefined,
          branch: undefined,
          prompt: undefined,
          target: undefined,
          folder: undefined,
          git: false,
          model: undefined,
          effort: undefined,
          inPlace: false,
          after: false,
          places: ["~/Projects/a", "~/Projects/b"],
        },
      ],
    });

    // Truncated JSON missing closing brackets
    const truncated = repairJsonObjects('{"say":"Hi there.","steps":[{"kind":"show","target":"home"');
    expect(truncated).toHaveLength(1);
    expect(normalizePlanCandidate(truncated[0], STEP_KINDS)).toMatchObject({ say: "Hi there.", steps: [{ kind: "show" }] });

    // Early say extraction from plain JSON and Claude stream-json deltas
    expect(extractEarlySay('{"say":"Starting \\"Claude\\" now.","steps":[')).toBe('Starting "Claude" now.');
    const stream = [
      '{"type":"stream_event","event":{"delta":{"partial_json":"{\\"say\\":\\"Warming up."}}}',
      '{"type":"stream_event","event":{"delta":{"partial_json":"\\",\\"steps\\":["}}}',
    ].join("\n");
    expect(extractEarlySay(stream)).toBe("Warming up.");
    expect(extractEarlySay('{"say":"still typing')).toBeNull();
  });

  it("retries once on malformed output or unsupported step kinds and succeeds when repaired", async () => {
    const ctx = setup();
    ctx.host.show = () => undefined;
    const file = path.join(ctx.configRoot, "engines.json");
    const enginesJson = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    enginesJson.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
    fs.writeFileSync(file, JSON.stringify(enginesJson));
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "plan", model: "", projectsFolder: "" } });

    const seenPrompts: string[] = [];
    const answers = [
      "Sorry, I forgot to format this as JSON!",
      JSON.stringify({ structuredOutput: { say: "Opened tasks.", steps: [{ kind: "show", target: "tasks" }] } }),
      JSON.stringify({ structuredOutput: { say: "Telepathing.", steps: [{ kind: "telepath", target: "tasks" }] } }),
      JSON.stringify({ structuredOutput: { say: "Showing tasks instead.", steps: [{ kind: "show", target: "tasks" }] } }),
    ];
    ctx.svc.orchestrator.runner = async (argv): Promise<BrainRun> => {
      seenPrompts.push(argv[argv.indexOf("-p") + 1] ?? "");
      return { code: 0, stdout: answers.shift() ?? "", stderr: "", timedOut: false };
    };

    await ctx.svc.orchestratorAsk("open tasks please");
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[1]).toContain("Respond ONLY with a single JSON object");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({
      text: "Opened tasks.",
      plan: "done",
      steps: [{ kind: "show", view: "tasks", state: "done" }],
    });

    await ctx.svc.orchestratorAsk("do the unsupported thing");
    expect(seenPrompts).toHaveLength(4);
    expect(seenPrompts[3]).toContain("unsupported step kind(s): telepath");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(ctx.svc.orchestratorView().turns.at(-1)).toMatchObject({
      text: "Showing tasks instead.",
      plan: "done",
    });

    ctx.svc.close();
  });
});
