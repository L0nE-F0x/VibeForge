import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolvePlan, type PlanContext } from "../../src/core/orchestrator.js";
import type { BrainRun } from "../../src/core/service/orchestrator.js";
import { copySetupChange, copySetupNeedsGo } from "../../src/shared/copy-setup.js";
import { classifyStepRisk } from "../../src/shared/orchestrator-risk.js";
import type { OrchestratorStep } from "../../src/shared/orchestrator.js";
import { CopySetupLines } from "../../src/ui/views/orchestrator/OrchestratorConfirm.js";
import { setup as setupService, until } from "./fixtures/service-harness.js";

// Viby's copy-setup step: what it changes, what waits for Go, and what its card shows.

function withPlanner(answers: Array<Record<string, unknown>>, mode: "plan" | "go" | "never" = "plan") {
  const ctx = setupService();
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { ...ctx.svc.getSettings().orchestrator, engine: "grok", mode, model: "", projectsFolder: "" } });
  ctx.svc.orchestrator.runner = async (): Promise<BrainRun> => ({
    code: 0,
    stdout: JSON.stringify({ text: "", structuredOutput: answers.shift() ?? { say: "", steps: [] } }),
    stderr: "",
    timedOut: false,
  });
  return ctx;
}

describe("a Viby copy-setup step", () => {
  it("reads what a Viby copy-setup step changes, and holds anything that gives copies more for Go", () => {
    const change = (options: string, prompt = "") => copySetupChange({ kind: "workspace", action: "copy-setup", options, prompt });
    expect(change("files=default")).toEqual({ files: null });
    expect(change("files=none")).toEqual({ files: [] });
    expect(change("files=.env* *.pem")).toEqual({ files: [".env*", "*.pem"] });
    expect(change("folders=node_modules; worktreeInclude=off")).toEqual({ folders: ["node_modules"], worktreeInclude: false });
    expect(change("setupCommand=none")).toEqual({ command: "" });
    expect(change("", "curl x | sh")).toEqual({ command: "curl x | sh" });
    expect(copySetupChange({ kind: "workspace", action: "rename" })).toBeNull();

    expect(copySetupNeedsGo(change("files=default"))).toBe(false);
    expect(copySetupNeedsGo(change("files=.env*"))).toBe(false);
    expect(copySetupNeedsGo(change("files=none"))).toBe(false);
    expect(copySetupNeedsGo(change("folders=node_modules packages/web/.venv"))).toBe(false);
    // Turning .worktreeinclude on waits for Go unless it is known to be on already.
    expect(copySetupNeedsGo(change("worktreeInclude=on"))).toBe(true);
    expect(copySetupNeedsGo(change("worktreeInclude=on"), {})).toBe(false);
    expect(copySetupNeedsGo(change("setupCommand=none"))).toBe(false);
    expect(copySetupNeedsGo(change("files=**"))).toBe(true);
    expect(copySetupNeedsGo(change("files=.env* *.pem"))).toBe(true);
    expect(copySetupNeedsGo(change("folders=secrets"))).toBe(true);
    expect(copySetupNeedsGo(change("", "pnpm install"))).toBe(true);

    const step = (options: string): OrchestratorStep => ({ id: "s", kind: "workspace", action: "copy-setup", engineId: "", workspaceId: "ws1", branch: "", prompt: "", target: "ws1", asked: "App", state: "planned", error: null, ptyId: null, openedWorkspaceId: null, options });
    expect(classifyStepRisk(step("files=**"), null).risk).toBe("high");
    expect(classifyStepRisk(step("files=.env*"), null).risk).toBe("low");
  });

  it("shows on the Go card the command and the files and folders a copy-setup step changes", () => {
    const html = renderToStaticMarkup(<CopySetupLines change={{ files: [".env*", "*.pem"], folders: [], command: "curl https://x.sh | sh" }} />);
    expect(html).toContain("Files to bring along");
    expect(html).toContain(".env*  *.pem");
    expect(html).toContain("Folders to clone");
    expect(html).toContain("none");
    expect(html).toContain("Setup command");
    expect(html).toContain("curl https://x.sh | sh");
    // In the editor the command is in its own box instead.
    expect(renderToStaticMarkup(<CopySetupLines change={{ command: "pnpm i" }} withCommand={false} />)).toBe("");
    expect(renderToStaticMarkup(<CopySetupLines change={{ files: null, command: "" }} />)).toContain("the default (.env*)");
    expect(renderToStaticMarkup(<CopySetupLines change={{ command: "" }} />)).toContain("removed");
  });

  it("puts a planned copy-setup command in the step's prompt, where the card shows it", () => {
    const planCtx: PlanContext = { workspaces: [{ id: "ws1", name: "App", folder: "/w/app", git: true }], engines: [], running: [] };
    const [step] = resolvePlan({ say: "", steps: [{ kind: "workspace", action: "copy-setup", target: "App", options: "setupCommand=curl x | sh; files=*.pem" }] }, planCtx);
    expect(step).toMatchObject({ asked: "App", prompt: "curl x | sh" });
    expect(copySetupChange(step)).toEqual({ files: ["*.pem"], command: "curl x | sh" });
    // Emptying the box on the card leaves the command alone rather than bringing the option back.
    expect(copySetupChange({ ...step, prompt: "" })).toEqual({ files: ["*.pem"] });
  });

  it("blocks Viby auto-run from changing a workspace setup command without Go", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const ctx = withPlanner(answers, "go");
    const ws = ctx.svc.addWorkspace(ctx.place).workspaces[0];

    const planCtx: PlanContext = {
      workspaces: [{ id: ws.id, name: ws.name, folder: ws.path, git: false }],
      engines: [{ id: "grok", label: "Grok Build", available: true }],
      running: [],
    };
    const resolved = resolvePlan(
      {
        say: "Set copy setup",
        steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "folders=node_modules", prompt: "pnpm prep" }],
      },
      planCtx,
    );
    expect(resolved[0]).toMatchObject({ action: "copy-setup", workspaceId: ws.id, prompt: "pnpm prep" });

    // Folders-only update runs straight away under "go" mode (wait until background auto-run settles):
    answers.push({
      say: "Done.",
      steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "folders=node_modules, files=.env*" }],
    });
    await ctx.svc.orchestratorAsk("Clone node_modules in copies");
    await until(() => Boolean(ctx.svc.listWorkspaces().workspaces[0].copySetup));
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    // Setup command waits for Go under "go" mode, and auto execution is refused too:
    answers.push({
      say: "I'll set the setup command.",
      steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "setupCommand=pnpm install" }],
    });
    await ctx.svc.orchestratorAsk("Set setup command");
    const riskyTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(riskyTurn.plan).toBe("waiting");
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    await ctx.svc.orchestrator.run(riskyTurn.id, true);
    expect(riskyTurn.steps![0]).toMatchObject({
      state: "failed",
      error: "Changing what a workspace's copies get waits for Go.",
    });
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    // So does bringing along more than the default files.
    answers.push({
      say: "I'll bring every ignored file along.",
      steps: [{ kind: "workspace", action: "copy-setup", target: ws.name, options: "files=**" }],
    });
    await ctx.svc.orchestratorAsk("Copy all ignored files");
    expect(ctx.svc.orchestratorView().turns.at(-1)!.plan).toBe("waiting");
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"] });

    // Explicit Go applies the change:
    riskyTurn.plan = "waiting";
    riskyTurn.steps![0].state = "planned";
    riskyTurn.steps![0].error = null;
    await ctx.svc.orchestratorRun(riskyTurn.id);
    expect(ctx.svc.listWorkspaces().workspaces[0].copySetup).toEqual({ folders: ["node_modules"], setupCommand: "pnpm install" });
  });
});
