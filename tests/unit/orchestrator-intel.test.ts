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
import { type OrchestratorStep, type PlanContext, stepIssue } from "../../src/shared/orchestrator.js";

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
