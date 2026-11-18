import { describe, expect, it } from "vitest";
import {
  detectWaitingPrompt,
  inspectsQuotas,
  isSafeShellCommand,
  keySequenceFor,
  normalizePreviewUrl,
  parseWorkbenchAction,
  teammateSummary,
} from "../../src/shared/orchestrator-intel.js";
import {
  formatSettingsRules,
  inspectsSettings,
  matchCatalogModel,
  matchCatalogVoice,
  type OrchestratorStep,
  type PlanContext,
  resolveSettingsStep,
  settingsFingerprint,
  stepIssue,
} from "../../src/shared/orchestrator.js";
import { safeInCall } from "../../src/core/orchestrator.js";

describe("orchestrator intelligence: waiting prompts and keys", () => {
  it("detects interactive TUI prompts (folder trust, y/n, numbered menus, sign-in) and ignores normal screens", () => {
    expect(detectWaitingPrompt("")).toBeNull();
    expect(detectWaitingPrompt("   \n  ")).toBeNull();
    expect(detectWaitingPrompt("All 42 tests passed.\n> ")).toBeNull();
    expect(detectWaitingPrompt("╭───╮\n│ Do you trust the files in this folder? │\n│ ❯ 1. Yes, proceed │\n│   2. No, exit │")).toBe(
      "Do you trust the files in this folder?",
    );
    expect(detectWaitingPrompt("Run npm install? [Y/n]")).toBe("Run npm install? [Y/n]");
    expect(detectWaitingPrompt("Overwrite config.json? (y/n)")).toBe("Overwrite config.json? (y/n)");
    expect(detectWaitingPrompt("Allow bash to execute `git status`?")).toBe("Allow bash to execute `git status`?");
    expect(detectWaitingPrompt("Do you want to proceed with these edits?")).toBe("Do you want to proceed with these edits?");
    expect(detectWaitingPrompt("Session expired. Please run /login to continue.")).toBe("Please run /login to continue.");
    expect(detectWaitingPrompt("Pick an action:\n❯ 1. Yes, allow once\n  2. Deny")).toBe("1. Yes, allow once");
  });

  it("maps spoken key actions to exact PTY bytes, adapting yes/no to numbered menus", () => {
    const menu = "Do you trust this project?\n❯ 1. Yes, proceed\n  2. No, cancel";
    expect(keySequenceFor("yes", menu)).toEqual({ data: "\r", label: "Yes" });
    expect(keySequenceFor("no", menu)).toEqual({ data: "2\r", label: "No" });
    expect(keySequenceFor("approve")).toEqual({ data: "y\r", label: "Yes" });
    expect(keySequenceFor("deny")).toEqual({ data: "n\r", label: "No" });
    expect(keySequenceFor("Enter.")).toEqual({ data: "\r", label: "Enter" });
    expect(keySequenceFor("escape")).toEqual({ data: "\x1b", label: "Escape" });
    expect(keySequenceFor("ctrl+c")).toEqual({ data: "\x03", label: "Ctrl+C", interrupts: true });
    expect(keySequenceFor("tab")).toEqual({ data: "\t", label: "Tab" });
    expect(keySequenceFor("up")).toEqual({ data: "\x1b[A", label: "Up" });
    expect(keySequenceFor("down")).toEqual({ data: "\x1b[B", label: "Down" });
    expect(keySequenceFor("2")).toEqual({ data: "2\r", label: "Option 2" });
    expect(keySequenceFor("")).toBeNull();
    expect(keySequenceFor("write an essay")).toBeNull();
  });

  it("distinguishes safe shell commands from destructive ones", () => {
    expect(isSafeShellCommand("")).toBe(true);
    expect(isSafeShellCommand("npm test && npm run typecheck")).toBe(true);
    expect(isSafeShellCommand("mkdir -p src/components")).toBe(true);
    expect(isSafeShellCommand("rm -rf dist")).toBe(false);
    expect(isSafeShellCommand("sudo systemctl restart sshd")).toBe(false);
    expect(isSafeShellCommand("git reset --hard HEAD~1")).toBe(false);
    expect(isSafeShellCommand("git push --force origin main")).toBe(false);
  });

  it("normalizes preview URLs and parses every workbench action", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizePreviewUrl(":3000/api")).toBe("http://localhost:3000/api");
    expect(normalizePreviewUrl("docs.example.com/guide")).toBe("https://docs.example.com/guide");
    expect(normalizePreviewUrl("https://vibeforge.dev")).toBe("https://vibeforge.dev");
    expect(normalizePreviewUrl("")).toBeNull();
    expect(normalizePreviewUrl("not a url")).toBeNull();

    expect(parseWorkbenchAction({ prompt: "mark-reviewed" })).toEqual({ op: "mark-reviewed" });
    expect(parseWorkbenchAction({ prompt: "mkdir", folder: "src/new" })).toEqual({ op: "mkdir", folder: "src/new" });
    expect(parseWorkbenchAction({ prompt: "mkdir docs/adr" })).toEqual({ op: "mkdir", folder: "docs/adr" });
    expect(parseWorkbenchAction({ prompt: "mkdir" })).toBeNull();
    expect(parseWorkbenchAction({ prompt: "branch", branch: "feat/voice" })).toEqual({ op: "branch", branch: "feat/voice" });
    expect(parseWorkbenchAction({ prompt: "branch" })).toBeNull();
    expect(parseWorkbenchAction({ prompt: "reload" })).toEqual({ op: "browser-cmd", command: "reload" });
    expect(parseWorkbenchAction({ prompt: "back" })).toEqual({ op: "browser-cmd", command: "back" });
    expect(parseWorkbenchAction({ prompt: "forward" })).toEqual({ op: "browser-cmd", command: "forward" });
    expect(parseWorkbenchAction({ prompt: "browser-stop" })).toEqual({ op: "browser-cmd", command: "stop" });
    expect(parseWorkbenchAction({ prompt: "files" })).toEqual({ op: "side", tab: "files" });
    expect(parseWorkbenchAction({ prompt: "close-side" })).toEqual({ op: "side", tab: "close" });
    expect(parseWorkbenchAction({ prompt: "browser" })).toEqual({ op: "side", tab: "browser" });
    expect(parseWorkbenchAction({ prompt: "browser", target: "localhost:5173" })).toEqual({ op: "browser-open", url: "http://localhost:5173" });
    expect(parseWorkbenchAction({ prompt: "open localhost:4000" })).toEqual({ op: "browser-open", url: "http://localhost:4000" });
    expect(parseWorkbenchAction({ prompt: "http://127.0.0.1:8080" })).toEqual({ op: "browser-open", url: "http://127.0.0.1:8080" });
    expect(parseWorkbenchAction({ prompt: "split-right" })).toEqual({ op: "pane", action: "split-right" });
    expect(parseWorkbenchAction({ prompt: "split-down" })).toEqual({ op: "pane", action: "split-down" });
    expect(parseWorkbenchAction({ prompt: "zoom" })).toEqual({ op: "pane", action: "zoom" });
    expect(parseWorkbenchAction({ prompt: "close-pane" })).toEqual({ op: "pane", action: "close" });
    expect(parseWorkbenchAction({ prompt: "diff", target: "copy-1" })).toEqual({ op: "diff", target: "copy-1" });
    expect(parseWorkbenchAction({ prompt: "diff" })).toBeNull();
    expect(parseWorkbenchAction({ prompt: "something unknown" })).toBeNull();
  });

  it("recognizes quota inspection queries and trims stiff AI prefixes from teammate summaries", () => {
    expect(inspectsQuotas("limits")).toBe(true);
    expect(inspectsQuotas("token usage")).toBe(true);
    expect(inspectsQuotas("src/index.ts")).toBe(false);

    expect(teammateSummary("")).toBe("");
    expect(teammateSummary("Done! I have fixed the login race in two files.")).toBe("Fixed the login race in two files.");
    expect(teammateSummary("Summary: All 18 unit tests pass.")).toBe("All 18 unit tests pass.");
  });

  it("checks stepIssue across inspect, key, shell and workbench steps", () => {
    const ctx: PlanContext = {
      workspaces: [{ id: "ws-1", name: "VibeForge", folder: "/w/vf", git: true }],
      engines: [{ id: "claude", label: "Claude Code", available: true }],
      running: [{ id: "pty-1", engine: "Claude Code", workspace: "VibeForge", folder: "/w/vf", working: false, orchestrated: true }],
      copies: [{ id: "copy-1", name: "fix-ui", branch: "maestro/fix-ui", workspace: "VibeForge" }],
    };
    const base: OrchestratorStep = {
      id: "s1",
      kind: "inspect",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt: "",
      target: "",
      asked: "",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    };
    const mk = <T extends object>(partial: T): OrchestratorStep => ({ ...base, ...partial });
    expect(stepIssue(mk({ kind: "inspect", prompt: "quotas" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "inspect", target: "pty-1" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "inspect", target: "copy-1" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "inspect", target: "missing" }), ctx)).toBe("target");
    expect(stepIssue(mk({ kind: "inspect", workspaceId: "ws-1" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "inspect", workspaceId: "missing" }), ctx)).toBe("workspace");
    expect(stepIssue(mk({ kind: "inspect" }), ctx)).toBe("workspace");

    expect(stepIssue(mk({ kind: "key", target: "pty-1", prompt: "yes" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "key", target: "missing", prompt: "yes" }), ctx)).toBe("target");
    expect(stepIssue(mk({ kind: "key", target: "pty-1", prompt: "nonsense" }), ctx)).toBe("prompt");

    expect(stepIssue(mk({ kind: "shell", workspaceId: "ws-1", prompt: "ls" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "shell", workspaceId: "missing", prompt: "ls" }), ctx)).toBe("workspace");

    expect(stepIssue(mk({ kind: "workbench", prompt: "unknown" }), ctx)).toBe("prompt");
    expect(stepIssue(mk({ kind: "workbench", prompt: "branch", branch: "feat/a", workspaceId: "missing" }), ctx)).toBe("workspace");
    expect(stepIssue(mk({ kind: "workbench", prompt: "branch", branch: "feat/a", workspaceId: "ws-1" }), ctx)).toBeNull();
    expect(stepIssue(mk({ kind: "workbench", prompt: "mark-reviewed" }), ctx)).toBeNull();
  });
});

describe("Viby settings awareness and parsing", () => {
  const engines = [
    { id: "grok", label: "Grok Build", available: true, bin: "grok" },
    { id: "claude", label: "Claude Code", available: true, bin: "claude" },
    { id: "codex", label: "Codex", available: false, bin: "codex" },
    { id: "kimi", label: "Kimi Code", available: true, bin: "kimi" },
  ];
  const agents = [{ id: "atlas", name: "Atlas" }];

  it("matches spoken STT model names and Piper voice names against the catalogs", () => {
    expect(matchCatalogModel("parakeet")?.id).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(matchCatalogModel("Parakeet v2")?.id).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(matchCatalogModel("canary")?.id).toBe("canary-180m-flash-int8");
    expect(matchCatalogModel("moonshine tiny")?.id).toBe("moonshine-tiny-en-int8");
    expect(matchCatalogModel("moonshine")?.id).toBe("moonshine-base-en-int8");
    expect(matchCatalogModel("distil")?.id).toBe("distil-small.en");
    expect(matchCatalogModel("small.en q5")?.id).toBe("small.en-q5_1");
    expect(matchCatalogModel("small q5")?.id).toBe("small-q5_1");
    expect(matchCatalogModel("large-v3-turbo")?.id).toBe("large-v3-turbo-q5_0");
    expect(matchCatalogModel("base.en")?.id).toBe("base.en");
    expect(matchCatalogModel("not-a-model")).toBeNull();

    expect(matchCatalogVoice("en_US-lessac-medium")?.id).toBe("en_US-lessac-medium");
    expect(matchCatalogVoice("ryan")?.id).toBe("en_US-ryan-high");
    expect(matchCatalogVoice("unknown-voice")).toBeNull();
  });

  it("resolves Viby self-configuration, voice/STT settings, and VibeForge app settings, flagging invalid choices", () => {
    expect(inspectsSettings("settings")).toBe(true);
    expect(inspectsSettings("voice models")).toBe(true);
    expect(inspectsSettings("themes")).toBe(true);
    expect(inspectsSettings("src/main.ts")).toBe(false);

    // Viby self-configuration
    expect(resolveSettingsStep({ target: "viby", engine: "claude", model: "sonnet", effort: "medium", prompt: "go", folder: "~/Code" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "viby", engine: "claude", model: "sonnet", effort: "medium", mode: "go", projectsFolder: "~/Code" },
    });
    expect(resolveSettingsStep({ target: "viby.engine", prompt: "kimi" }, { engines }).issue).toBe("engine");
    expect(resolveSettingsStep({ target: "viby.engine", prompt: "codex" }, { engines }).issue).toBe("engineMissing");
    expect(resolveSettingsStep({ target: "viby", engine: "claude", effort: "minimal" }, { engines }).issue).toBe("effort");
    expect(resolveSettingsStep({ target: "viby.projectsFolder", prompt: "relative/path" }, { engines }).issue).toBe("folder");

    // Voice & STT
    expect(resolveSettingsStep({ target: "voice.model", prompt: "parakeet v3" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-model", model: "parakeet-tdt-0.6b-v3-int8", downloadId: "parakeet-tdt-0.6b-v3-int8" },
    });
    expect(resolveSettingsStep({ target: "voice.model", prompt: "auto" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-model", model: "" },
    });
    expect(resolveSettingsStep({ target: "voice.download", prompt: "sherpa" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-download", kind: "sherpa", id: "runtime" },
    });
    expect(resolveSettingsStep({ target: "voice.speaker", prompt: "lessac" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-speaker", speaker: "en_US-lessac-medium.onnx", downloadId: "en_US-lessac-medium" },
    });
    expect(resolveSettingsStep({ target: "voice.language", prompt: "German" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { language: "de" } },
    });
    expect(resolveSettingsStep({ target: "voice.talkBack", prompt: "off" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { talkBack: false } },
    });
    expect(resolveSettingsStep({ target: "voice.talkOver", prompt: "headphones" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { talkOver: "always" } },
    });
    expect(resolveSettingsStep({ target: "voice.mouseButton", prompt: "back" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { mouseButton: "back" } },
    });
    expect(resolveSettingsStep({ target: "voice.sendButton", prompt: "always" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { sendButton: "always" } },
    });
    expect(resolveSettingsStep({ target: "voice.agent", prompt: "Atlas" }, { engines, agents })).toMatchObject({
      issue: null,
      action: { op: "voice-patch", patch: { agent: "atlas" } },
    });

    // App settings
    expect(resolveSettingsStep({ target: "defaultEngine", prompt: "claude" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { defaultEngine: "claude" } },
    });
    expect(resolveSettingsStep({ target: "theme", prompt: "Tokyo Night" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { theme: "tokyo-night" } },
    });
    expect(resolveSettingsStep({ target: "terminalFontSize", prompt: "15px" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { terminalFontSize: 15 } },
    });
    expect(resolveSettingsStep({ target: "sounds.volume", prompt: "80%" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { sounds: { volume: 0.8 } } },
    });
    expect(resolveSettingsStep({ target: "autostart", prompt: "on" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", autostart: true },
    });
    expect(resolveSettingsStep({ target: "agentTalk.handOff", prompt: "go" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { agentTalk: { handOff: "go" } } },
    });
    expect(resolveSettingsStep({ target: "keepRuns.days", prompt: "30" }, { engines })).toMatchObject({
      issue: null,
      action: { op: "app-patch", patch: { keepRuns: { days: 30 } } },
    });

    // Call safety: local settings run at once; turning on networked services waits for Go.
    const mkStep = (target: string, prompt: string): OrchestratorStep => ({
      id: "s1",
      kind: "settings",
      engineId: "",
      workspaceId: "",
      branch: "",
      prompt,
      target,
      asked: "",
      state: "planned",
      error: null,
      ptyId: null,
      openedWorkspaceId: null,
    });
    expect(safeInCall(mkStep("voice.model", "parakeet v3"))).toBe(true);
    expect(safeInCall(mkStep("viby.effort", "high"))).toBe(true);
    expect(safeInCall(mkStep("planLimits", "on"))).toBe(false);
    expect(safeInCall(mkStep("planLimits", "off"))).toBe(true);
    expect(safeInCall(mkStep("companion", "on"))).toBe(false);
    expect(safeInCall(mkStep("sync", "on"))).toBe(false);

    // Exercise remaining Viby, voice and app setting targets and reset/validation branches
    expect(resolveSettingsStep({ target: "viby.engine", prompt: "auto" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", engine: "" } });
    expect(resolveSettingsStep({ target: "viby.model", prompt: "opus" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", model: "opus" } });
    expect(resolveSettingsStep({ target: "viby.model", prompt: "default" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", model: "" } });
    expect(resolveSettingsStep({ target: "viby.effort", prompt: "default" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", effort: "" } });
    expect(resolveSettingsStep({ target: "viby.mode", prompt: "plan" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", mode: "plan" } });
    expect(resolveSettingsStep({ target: "viby.projectsFolder", prompt: "~/Repos" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", projectsFolder: "~/Repos" } });
    expect(resolveSettingsStep({ target: "viby", prompt: "claude" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", engine: "claude" } });
    expect(resolveSettingsStep({ target: "viby", prompt: "sonnet" }, { engines })).toMatchObject({ issue: null, action: { op: "viby", model: "sonnet" } });
    expect(resolveSettingsStep({ target: "viby" }, { engines }).issue).toBe("prompt");

    expect(resolveSettingsStep({ target: "voice.model", prompt: "/custom/ggml-medium.bin" }, { engines })).toMatchObject({ issue: null, action: { op: "voice-model", model: "/custom/ggml-medium.bin" } });
    expect(resolveSettingsStep({ target: "voice.download", prompt: "moonshine tiny" }, { engines })).toMatchObject({ issue: null, action: { op: "voice-download", kind: "model", id: "moonshine-tiny-en-int8" } });
    expect(resolveSettingsStep({ target: "voice.download", prompt: "en_US-lessac-medium" }, { engines })).toMatchObject({ issue: null, action: { op: "voice-download", kind: "voice", id: "en_US-lessac-medium" } });
    expect(resolveSettingsStep({ target: "voice.speaker", prompt: "auto" }, { engines })).toMatchObject({ issue: null, action: { op: "voice-speaker", speaker: "" } });
    expect(resolveSettingsStep({ target: "voice.language", prompt: "system" }, { engines })).toMatchObject({ issue: null, action: { op: "voice-patch", patch: { language: "auto" } } });
    expect(resolveSettingsStep({ target: "voice.agent", prompt: "last" }, { engines, agents })).toMatchObject({ issue: null, action: { op: "voice-patch", patch: { agent: "" } } });

    expect(resolveSettingsStep({ target: "defaultShell", prompt: "/bin/zsh" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { defaultShell: "/bin/zsh" } } });
    expect(resolveSettingsStep({ target: "language", prompt: "Japanese" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { language: "ja" } } });
    expect(resolveSettingsStep({ target: "language", prompt: "system" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { language: "system" } } });
    expect(resolveSettingsStep({ target: "terminalFontFamily", prompt: "FiraCode Nerd Font" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { terminalFontFamily: "FiraCode Nerd Font" } } });
    expect(resolveSettingsStep({ target: "notify", prompt: "off" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { notify: false } } });
    expect(resolveSettingsStep({ target: "sounds", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { sounds: { on: true } } } });
    expect(resolveSettingsStep({ target: "sounds.volume", prompt: "soft" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { sounds: { volume: 0.3 } } } });
    expect(resolveSettingsStep({ target: "sounds.volume", prompt: "loud" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { sounds: { volume: 1 } } } });
    expect(resolveSettingsStep({ target: "sounds.inFront", prompt: "true" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { sounds: { inFront: true } } } });
    expect(resolveSettingsStep({ target: "tray", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { tray: true } } });
    expect(resolveSettingsStep({ target: "closeToTray", prompt: "off" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { closeToTray: false } } });
    expect(resolveSettingsStep({ target: "usage", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { usage: true } } });
    expect(resolveSettingsStep({ target: "quotaAlerts", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { quotaAlerts: true } } });
    expect(resolveSettingsStep({ target: "activity", prompt: "github" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { activity: "github" }, networkOn: true } });
    expect(resolveSettingsStep({ target: "checkUpdates", prompt: "off" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { checkUpdates: false } } });
    expect(resolveSettingsStep({ target: "agentTalk", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { agentTalk: { on: true } } } });
    expect(resolveSettingsStep({ target: "agentTalk.lead", prompt: "claude" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { agentTalk: { lead: "claude" } } } });
    expect(resolveSettingsStep({ target: "agentTalk.lead", prompt: "none" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { agentTalk: { lead: "" } } } });
    expect(resolveSettingsStep({ target: "agentTalk.leadApplies", prompt: "on" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { agentTalk: { leadApplies: true } } } });
    expect(resolveSettingsStep({ target: "agentTalk.maxMessages", prompt: "10" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { agentTalk: { maxMessages: 10 } } } });
    expect(resolveSettingsStep({ target: "sync.name", prompt: "ThinkPad" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { sync: { name: "ThinkPad" } } } });
    expect(resolveSettingsStep({ target: "keepRuns.maxMb", prompt: "2048" }, { engines })).toMatchObject({ issue: null, action: { op: "app-patch", patch: { keepRuns: { maxMb: 2048 } } } });
    expect(resolveSettingsStep({ target: "unknownTarget", prompt: "123" }, { engines }).issue).toBe("prompt");
  });

  it("formats settings rules and fingerprints changes", () => {
    const sample: NonNullable<PlanContext["settings"]> = {
      viby: {
        planner: "claude",
        pickedEngine: "claude",
        mode: "plan",
        model: "sonnet",
        effort: "medium",
        projectsFolder: "~/Projects",
        availablePlanners: [{ id: "claude", label: "Claude Code", available: true, models: ["haiku", "sonnet", "opus"], efforts: ["low", "medium", "high"] }],
      },
      voice: {
        ready: true,
        activeModel: "parakeet-tdt-0.6b-v3-int8",
        pickedModel: "",
        installedModels: [{ name: "parakeet-tdt-0.6b-v3-int8", path: "/m/parakeet-tdt-0.6b-v3-int8", backend: "sherpa", englishOnly: false }],
        runtimes: { whisperServer: true, whisperCli: true, sherpa: true, recorder: "pw-record", piper: true },
        language: "auto",
        talkBack: true,
        talkOver: "auto",
        activeSpeaker: "en_US-lessac-medium",
        pickedSpeaker: "",
        installedVoices: [{ name: "en_US-lessac-medium", path: "/v/en_US-lessac-medium.onnx" }],
        mouseButton: "off",
        sendButton: "pointer",
        agent: "",
      },
      app: {
        defaultEngine: "claude",
        defaultShell: "/bin/bash",
        theme: "omarchy",
        availableThemes: ["apex-forge", "tokyo-night"],
        language: "system",
        terminalFontSize: 13,
        terminalFontFamily: "JetBrainsMono Nerd Font",
        notify: true,
        sounds: { on: true, volume: 0.6, voice: true, attention: true, finished: true, routines: false, inFront: false },
        tray: true,
        closeToTray: true,
        autostart: false,
        usage: true,
        planLimits: false,
        quotaAlerts: false,
        activity: "git",
        checkUpdates: true,
        companion: { enabled: false, port: 4318 },
        sync: { enabled: false, name: "" },
        agentTalk: { on: true, lead: "", handOff: "ask", reviewRounds: 1, maxMessages: 6, maxWorking: 3, maxHandOffs: 4, leadApplies: false },
        keepRuns: { days: 0, maxMb: 0 },
      },
    };
    const lines = formatSettingsRules(sample).join("\n");
    expect(lines).toContain("planner=claude, model=sonnet, effort=medium");
    expect(lines).toContain("activeModel=parakeet-tdt-0.6b-v3-int8");
    expect(lines).toContain("parakeet-tdt-0.6b-v3-int8 [installed]");
    expect(settingsFingerprint(sample)).not.toBe(settingsFingerprint({ ...sample, viby: { ...sample.viby, effort: "high" } }));
  });
});
