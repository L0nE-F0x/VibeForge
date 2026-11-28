// A CLI typed into a Code shell survives VibeForge quitting: its exact session is read from its
// own session log while it runs, and after the next start its pane offers "Continue its session",
// which types the CLI back into the shell with that session.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { claudeProjectDir } from "../src/core/replies.js";
import { type App, launchApp } from "./driver/app.js";

type Live = { ptyId: string; kind: string; workspaceId: string | null; runId: string | null; programEngineId?: string | null };
type Run = { id: string; engine: string; cwd: string; resumeArgs?: string[]; cutOff?: string; paneId?: string };
const SESSION = "0f8e0a52-1c2d-4e3f-9a8b-7c6d5e4f3a2b";
const shellIn = async (app: App, workspaceId: string) => (await app.call<Live[]>("live.list")).find((s) => s.kind === "shell" && s.workspaceId === workspaceId);

test("a CLI cut off by a quit is offered back in its pane, and Continue reopens its exact session", async () => {
  const app = await launchApp({
    standins: {
      claude: {
        turns: [
          { match: "--resume", say: ["Picked the session back up"], gate: "resumed" },
          { match: "--model", say: ["Working on it"], gate: "never" },
        ],
      },
    },
  });
  const folder = path.join(app.paths.home, "Projects", "cut");
  fs.mkdirSync(folder, { recursive: true });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", folder);
  const workspaceId = added.workspaces.find((w) => w.path === folder)!.id;

  await app.go("Code");
  await app.click({ name: "New terminal", role: "button", within: ".stage" });
  const shell = await app.waitFor(() => shellIn(app, workspaceId), { what: "the shell" });
  await app.terminal(shell.ptyId).waitForText("$");
  await app.call("pty.write", shell.ptyId, "claude --model opus 'tidy up'\r");
  await app.terminal(shell.ptyId).waitForText("Working on it");
  const run = await app.waitFor(async () => (await app.call<Run[]>("runs.list", {})).find((r) => r.engine === "claude" && r.cwd === folder), { what: "a run for the typed claude" });

  // Claude Code's session log for this folder, as the real one writes it while it works.
  const logDir = claudeProjectDir(app.paths.home, folder);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", cwd: folder, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: "user", content: "tidy up" } })}\n`);
  await app.waitFor(async () => (await app.call<{ run: Run }>("runs.get", run.id)).run.resumeArgs?.includes(SESSION), { what: "the run to know its session", timeoutMs: 20_000 });

  await app.restart();
  const offered = await app.call<{ reason: string; runs: Array<{ runId: string; exact: boolean; paneId: string | null }> } | null>("runs.cutOff");
  expect(offered).toMatchObject({ reason: "quit", runs: [{ runId: run.id, exact: true }] });
  // The start-up notice says so, with Continue all.
  await app.waitFor(async () => (await app.text("body")).includes("1 CLI was cut off when VibeForge closed"), { what: "the notice about the cut-off CLI" });

  await app.go("Code");
  await app.waitFor(async () => (await app.text(".stage .pane")).includes("Claude Code was working here when VibeForge closed."), { what: "the pane to offer its session back" });
  await app.click({ name: "Continue its session", role: "button", within: ".stage .pane" });
  await app.waitForGate("resumed");
  const resumed = app.standin("claude").calls().at(-1);
  expect(resumed?.argv).toEqual(["--model", "opus", "--resume", SESSION]);
  // Picked back up: the new run continues the old one, and nothing is offered any more.
  const again = await app.waitFor(async () => (await app.call<Array<Run & { continuedFrom: string | null }>>("runs.list", {})).find((r) => r.continuedFrom === run.id), { what: "the continued run" });
  expect(again.engine).toBe("claude");
  expect(await app.call("runs.cutOff")).toBeNull();
  expect(await app.text(".stage .pane")).not.toContain("was working here when VibeForge closed");

  expect(app.pageErrors).toEqual([]);
});
