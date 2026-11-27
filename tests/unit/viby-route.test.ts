import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import type { LocalSettings, OrchestratorSettings } from "../../src/core/types.js";
import { defaultLocalServer, localModeRoutesViby, migrateVibyRoute, vibyLocalModel, vibyPlanner, vibyPlannerPatch } from "../../src/shared/local.js";
import { classifyStepRisk } from "../../src/shared/orchestrator-risk.js";
import { formatSettingsRules, resolveSettingsStep, type PlanSettingsContext } from "../../src/shared/orchestrator-settings.js";
import type { OrchestratorStep } from "../../src/shared/orchestrator.js";

// What Viby plans with is its own choice (local.viby), apart from where the coding tools run
// (local.active): Cloud keeps the Viby settings' planner, model and effort; Local plans on the server.

const engines = [
  { id: "claude", bin: "claude", available: true },
  { id: "codex", bin: "codex", available: true },
  { id: "opencode", bin: "opencode", available: true },
];

function local(over: Partial<LocalSettings> = {}): LocalSettings {
  return {
    enabled: true,
    active: true,
    viby: "cloud",
    overrideAgents: false,
    url: "http://127.0.0.1:11434",
    model: "qwen3:27b",
    vibyModel: "",
    harness: "auto",
    server: defaultLocalServer(),
    ...over,
  };
}

const orchestrator: OrchestratorSettings = { engine: "claude", mode: "go", model: "opus", effort: "high", projectsFolder: "", terse: true };

describe("which planner Viby uses (vibyPlanner)", () => {
  const plan = (l: LocalSettings, opts: { ready?: boolean; picked?: string; rows?: typeof engines } = {}) =>
    vibyPlanner({ local: l, localReady: opts.ready ?? true, picked: opts.picked ?? "claude", engines: opts.rows ?? engines });

  it("Local mode on + Viby Cloud: the Viby settings' planner, as if Local mode were off", () => {
    expect(plan(local({ viby: "cloud" }))).toBe("claude");
    expect(plan(local({ viby: "cloud" }), { picked: "codex" })).toBe("codex");
    expect(localModeRoutesViby(local({ viby: "cloud" }))).toBe(false);
  });

  it("Local mode on + Viby Local: the Local server, once it is ready", () => {
    expect(plan(local({ viby: "local" }))).toBe("local");
    expect(localModeRoutesViby(local({ viby: "local" }))).toBe(true);
    // A server or model not set up yet leaves Viby on its own planner rather than on nothing.
    expect(plan(local({ viby: "local" }), { ready: false })).toBe("claude");
  });

  it("Local mode off: the Viby settings' planner whatever local.viby says", () => {
    expect(plan(local({ active: false, viby: "local" }))).toBe("claude");
    expect(plan(local({ active: false, viby: "cloud" }))).toBe("claude");
    // Local AI disabled altogether: a stale active/viby means nothing.
    expect(plan(local({ enabled: false, active: true, viby: "local" }))).toBe("claude");
  });

  it("Viby on Local while coding stays on the cloud: Local picked as Viby's own planner", () => {
    expect(plan(local({ active: false }), { picked: "local" })).toBe("local");
    // With Local mode on and Viby on Cloud, a Local planner picked in the Viby settings is still Viby's planner.
    expect(plan(local({ active: true, viby: "cloud" }), { picked: "local" })).toBe("local");
    // Not ready: the first cloud planner here instead.
    expect(plan(local({ active: false }), { picked: "local", ready: false })).toBe("claude");
    // Local AI disabled: Local isn't offered at all.
    expect(plan(local({ enabled: false, active: false }), { picked: "local" })).toBe("claude");
  });

  it("nothing picked: a cloud planner first, Local only when nothing else here can plan", () => {
    expect(plan(local({ viby: "cloud" }), { picked: "" })).toBe("claude");
    expect(plan(local({ viby: "cloud" }), { picked: "", rows: [{ id: "opencode", bin: "opencode", available: true }] })).toBe("local");
    // A row for the virtual engine itself in the list doesn't count twice or decide readiness.
    expect(plan(local({ viby: "cloud" }), { picked: "", ready: false, rows: [{ id: "local", bin: "local", available: true }] })).toBe("");
  });

  it("Viby's local model is its own pick, else the coding model", () => {
    expect(vibyLocalModel(local())).toBe("qwen3:27b");
    expect(vibyLocalModel(local({ vibyModel: "qwen3:8b" }))).toBe("qwen3:8b");
  });
});

describe("picking a planner in Viby's pickers (vibyPlannerPatch)", () => {
  it("Local mode on: Local only moves Viby, and the cloud planner, model and effort stay saved", () => {
    expect(vibyPlannerPatch("local", local({ viby: "cloud" }), orchestrator)).toEqual({ local: { viby: "local" } });
    expect(vibyPlannerPatch("local", local({ viby: "local" }), orchestrator)).toEqual({});
  });

  it("Local mode on: the saved cloud planner brings Viby back with its model and effort", () => {
    expect(vibyPlannerPatch("claude", local({ viby: "local" }), orchestrator)).toEqual({ local: { viby: "cloud" } });
  });

  it("Local mode on: another cloud planner is picked fresh and brings Viby back to Cloud", () => {
    expect(vibyPlannerPatch("codex", local({ viby: "local" }), orchestrator)).toEqual({
      orchestrator: { ...orchestrator, engine: "codex", model: "", effort: "" },
      local: { viby: "cloud" },
    });
    expect(vibyPlannerPatch("codex", local({ viby: "cloud" }), orchestrator)).toEqual({
      orchestrator: { ...orchestrator, engine: "codex", model: "", effort: "" },
    });
  });

  it("Local mode off: Local becomes Viby's own planner and coding is left alone", () => {
    expect(vibyPlannerPatch("local", local({ active: false }), orchestrator)).toEqual({
      orchestrator: { ...orchestrator, engine: "local", model: "", effort: "" },
    });
    expect(vibyPlannerPatch("claude", local({ active: false }), orchestrator)).toEqual({});
  });
});

describe("settings.json from before local.viby (3.12.0's useForViby)", () => {
  it("reads the route from what was saved", () => {
    expect(migrateVibyRoute({ viby: "local" })).toBe("local");
    expect(migrateVibyRoute({ viby: "cloud", useForViby: true, enabled: true, active: true })).toBe("cloud");
    // useForViby: false was a choice someone made: Viby on Cloud.
    expect(migrateVibyRoute({ useForViby: false, enabled: true, active: true })).toBe("cloud");
    // Someone in Local mode now, whose Viby already planned locally, keeps it.
    expect(migrateVibyRoute({ useForViby: true, enabled: true, active: true })).toBe("local");
    // Everyone else (useForViby: true was only ever the default) starts on Cloud.
    expect(migrateVibyRoute({ useForViby: true, enabled: true, active: false })).toBe("cloud");
    expect(migrateVibyRoute({ useForViby: true, enabled: false, active: true })).toBe("cloud");
    expect(migrateVibyRoute({})).toBe("cloud");
    expect(migrateVibyRoute(null)).toBe("cloud");
    expect(migrateVibyRoute({ viby: "sideways", useForViby: false })).toBe("cloud");
  });

  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });
  function openWith(settings: unknown): { store: Store; file: string } {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "vf-viby-")), fs.mkdtempSync(path.join(os.tmpdir(), "vf-viby-")));
    stores.push(store);
    const file = path.join(store.configRoot, "settings.json");
    fs.writeFileSync(file, JSON.stringify(settings));
    return { store, file };
  }
  const saved312 = (localPart: Record<string, unknown>) => ({
    version: 1,
    defaultEngine: "claude",
    orchestrator: { engine: "claude", mode: "go", model: "opus", effort: "high", projectsFolder: "~/Code", terse: false },
    local: { enabled: true, url: "http://127.0.0.1:11434", model: "qwen3:27b", vibyModel: "qwen3:8b", harness: "opencode", overrideAgents: true, ...localPart },
  });

  it("keeps someone in Local mode on Local, and a save writes local.viby and drops useForViby", () => {
    const { store, file } = openWith(saved312({ active: true, useForViby: true }));
    expect(store.readSettings().local).toMatchObject({ enabled: true, active: true, viby: "local", vibyModel: "qwen3:8b", overrideAgents: true });
    store.writeSettings({ ...store.readSettings(), notify: false });
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { local: Record<string, unknown>; orchestrator: unknown };
    expect(written.local.viby).toBe("local");
    expect("useForViby" in written.local).toBe(false);
  });

  it("moves an explicit Cloud choice over, and never touches the saved Viby planner, model or effort", () => {
    const before = saved312({ active: true, useForViby: false });
    const { store, file } = openWith(before);
    const read = store.readSettings();
    expect(read.local.viby).toBe("cloud");
    expect(read.orchestrator).toEqual(before.orchestrator);
    store.writeSettings(read);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { local: Record<string, unknown>; orchestrator: unknown };
    expect(written.orchestrator).toEqual(before.orchestrator);
    expect(written.local).toMatchObject({ viby: "cloud", url: "http://127.0.0.1:11434", model: "qwen3:27b", vibyModel: "qwen3:8b", harness: "opencode", overrideAgents: true });
  });

  it("starts someone not in Local mode on Cloud, and reads the same again after the save", () => {
    const { store } = openWith(saved312({ active: false, useForViby: true }));
    expect(store.readSettings().local.viby).toBe("cloud");
    store.writeSettings(store.readSettings());
    const again = new Store(store.configRoot, store.dataRoot);
    stores.push(again);
    expect(again.readSettings().local).toMatchObject({ active: false, viby: "cloud" });
  });

  it("starts a settings.json with no local section on Cloud", () => {
    const { store } = openWith({ version: 1, defaultEngine: "claude" });
    expect(store.readSettings().local).toMatchObject({ enabled: false, active: false, viby: "cloud" });
  });
});

describe("Viby changing local.viby and local.vibyModel itself", () => {
  const ctx = { engines: [{ id: "claude", label: "Claude Code", available: true, bin: "claude" }] };
  const resolve = (target: string, prompt: string) => resolveSettingsStep({ target, prompt }, ctx).action;

  it("reads Cloud, Local and a named local model", () => {
    expect(resolve("local.viby", "cloud")).toMatchObject({ op: "app-patch", patch: { local: { viby: "cloud" } } });
    expect(resolve("local.viby", "off")).toMatchObject({ patch: { local: { viby: "cloud" } } });
    expect(resolve("local.viby", "local")).toMatchObject({ patch: { local: { viby: "local" } }, networkOn: true });
    expect(resolve("local.viby", "local qwen3:8b")).toMatchObject({ patch: { local: { viby: "local", vibyModel: "qwen3:8b" } } });
    expect(resolve("vibyRoute", "qwen3:8b")).toMatchObject({ patch: { local: { viby: "local", vibyModel: "qwen3:8b" } } });
    expect(resolveSettingsStep({ target: "local.viby", prompt: "" }, ctx)).toMatchObject({ action: null, issue: "prompt" });
    expect(resolveSettingsStep({ target: "local.viby", prompt: "--evil" }, ctx)).toMatchObject({ action: null, issue: "prompt" });
  });

  it("sets or clears Viby's own local model", () => {
    expect(resolve("local.vibyModel", "qwen3:8b")).toMatchObject({ patch: { local: { vibyModel: "qwen3:8b" } } });
    expect(resolve("local.vibyModel", "same")).toMatchObject({ patch: { local: { vibyModel: "" } } });
    expect(resolve("local.vibyModel", "default")).toMatchObject({ patch: { local: { vibyModel: "" } } });
  });

  it("holds sending Viby to Local for Go, and lets Cloud run straight away", () => {
    const settingsStep = (prompt: string) => ({ id: "s1", kind: "settings", target: "local.viby", prompt }) as OrchestratorStep;
    expect(classifyStepRisk(settingsStep("local"), null)).toMatchObject({ risk: "high", category: "broad-settings" });
    expect(classifyStepRisk(settingsStep("cloud"), null)).toMatchObject({ risk: "low" });
  });

  it("turning Local mode on leaves Viby's route alone", () => {
    expect(resolve("local", "on")).toMatchObject({ patch: { local: { enabled: true, active: true } } });
    const on = resolve("local", "on");
    expect(on?.op === "app-patch" ? on.patch.local : null).not.toHaveProperty("viby");
  });

  it("the settings summary says what Viby uses, apart from the coding tools", () => {
    const summary = (l: Partial<NonNullable<PlanSettingsContext["local"]>>, planner = "claude") =>
      formatSettingsRules({
        viby: { planner, pickedEngine: "claude", mode: "go", model: "opus", effort: "high", projectsFolder: "", availablePlanners: [] },
        local: { enabled: true, active: true, overrideAgents: false, url: "http://x", model: "qwen3:27b", vibyModel: "", viby: "cloud", harness: "auto", ...l },
        voice: {
          ready: false,
          activeModel: "",
          pickedModel: "",
          installedModels: [],
          runtimes: { whisperServer: false, whisperCli: false, sherpa: false, recorder: null, piper: false },
          language: "auto",
          talkBack: true,
          talkOver: "auto",
          activeSpeaker: "",
          pickedSpeaker: "",
          installedVoices: [],
          mouseButton: "off",
          sendButton: "pointer",
          agent: "",
        },
        app: {
          defaultEngine: "claude",
          defaultShell: "/bin/bash",
          theme: "omarchy",
          language: "system",
          terminalFontSize: 13,
          terminalFontFamily: "JetBrainsMono Nerd Font",
          notify: true,
          sounds: { on: true, volume: 0.6, voice: true, attention: true, finished: true, routines: false, inFront: false },
          tray: true,
          closeToTray: true,
          usage: false,
          planLimits: false,
          quotaAlerts: false,
          activity: "git",
          checkUpdates: true,
          companion: { enabled: false, port: 4318 },
          sync: { enabled: false, name: "" },
          agentTalk: { on: true, lead: "", handOff: "ask", reviewRounds: 1, maxMessages: 6, maxWorking: 3, maxHandOffs: 4, leadApplies: false },
          keepRuns: { days: 30, maxMb: 1000 },
        },
      }).join("\n");
    const cloud = summary({});
    expect(cloud).toContain("coding tools run on Local");
    expect(cloud).toContain("local.viby=cloud");
    expect(cloud).toContain("on your own planner");
    const onLocal = summary({ viby: "local" }, "local");
    expect(onLocal).toContain("local.viby=local");
    expect(onLocal).toContain("right now you are on Local");
  });
});
