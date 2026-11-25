// Scenarios 3 and 4: what a CLI does is recorded as a run. A stand-in `claude` typed at a shell's
// prompt becomes a run with its transcript and diff; and a CLI that floods its terminal and exits
// keeps its last line on screen and in the transcript (W02's lost-tail bug, end to end).

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { type App, launchApp } from "./driver/app.js";

type Run = { id: string; engine: string; status: string; cwd: string; origin: string };
type Bundle = { run: Run & { exitCode: number | null }; files: { transcript: string; screen: string } };
const runs = (app: App) => app.call<Run[]>("runs.list", {});

test("claude typed into a shell is recorded as a run, with its transcript and diff", async () => {
  const app = await launchApp({
    standins: {
      claude: { turns: [{ match: "fix the readme", say: ["Working on the README"], files: { "README.md": "fixed by claude\n" }, gate: "typed", after: ["All done."] }] },
    },
  });
  const repo = app.repo("typed", { "README.md": "broken\n" });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", repo);
  const workspaceId = added.workspaces.find((w) => w.path === repo)!.id;

  await app.go("Code");
  await app.click({ name: "New terminal", role: "button", within: ".stage" });
  const shell = await app.waitFor(async () => (await app.call<Array<{ ptyId: string; kind: string; workspaceId: string }>>("live.list")).find((s) => s.kind === "shell" && s.workspaceId === workspaceId), {
    what: "the shell",
  });
  await app.terminal(shell.ptyId).waitForText("$");
  await app.call("pty.write", shell.ptyId, "claude 'fix the readme'\r");
  await app.waitForGate("typed");

  // Recognised while it runs: the pane names it, and Runs has it.
  await app.waitFor(async () => (await app.text(".stage .pane .pane-head")).includes("Claude Code"), { what: "the pane to name Claude Code" });
  const run = await app.waitFor(async () => (await runs(app)).find((r) => r.engine === "claude" && r.cwd === repo), { what: "a run for the typed claude" });
  expect(run.status).toBe("running");

  app.openGate("typed");
  await app.terminal(shell.ptyId).waitForText("All done.");
  const done = await app.waitFor(async () => {
    const bundle = await app.call<Bundle>("runs.get", run.id);
    return bundle.run.status !== "running" ? bundle : null;
  }, { what: "the run to end when claude exits" });
  expect(done.files.transcript).toContain("Working on the README");
  expect(done.files.transcript).toContain("All done.");

  // Its review in Runs: the transcript, then the diff of what it changed.
  await app.go("Runs");
  // Listed by its workspace's name, then the CLI and what changed.
  await app.click({ name: /^typed\b.*Claude Code/, role: "button", within: ".stage" });
  await app.click({ name: "Transcript", role: "tab" });
  await app.waitFor(async () => (await app.text(".stage")).includes("All done."), { what: "the transcript in Runs" });
  await app.click({ name: "Changes", role: "tab" });
  await app.waitFor(async () => (await app.text(".diff")).includes("fixed by claude"), { what: "the diff in Runs" });

  expect(app.pageErrors).toEqual([]);
});

test("a CLI that floods its terminal and exits keeps its last line on screen and in the transcript", async () => {
  // 500,000 lines (3.4 MB), then the last one; the host is behind when the program ends.
  const app = await launchApp({
    engines: [{ id: "flood", label: "Flood CLI", bin: "/bin/sh", args: ["-c", "seq 1 500000; echo FLOOD-END-$((6*7))"] }],
  });
  const folder = path.join(app.paths.home, "Projects", "flood");
  fs.mkdirSync(folder, { recursive: true });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", folder);
  const workspaceId = added.workspaces.find((w) => w.path === folder)!.id;

  await app.go("Code");
  const started = await app.call<{ runId: string; ptyId: string }>("code.engine", { workspaceId, engineId: "flood", cols: 100, rows: 30 });
  const done = await app.waitFor(async () => {
    const bundle = await app.call<Bundle>("runs.get", started.runId);
    return bundle.run.status !== "running" ? bundle : null;
  }, { what: "the flood to end", timeoutMs: 30_000 });
  expect(done.run.exitCode ?? 0).toBe(0);
  expect(done.files.transcript.trimEnd().split("\n").at(-1)?.trim()).toBe("FLOOD-END-42");
  // The transcript keeps the end of a long output, without a gap before the last line.
  expect(done.files.transcript).toMatch(/499999\r?\n500000\r?\nFLOOD-END-42/);
  expect(done.files.screen).toContain("FLOOD-END-42");

  expect(app.pageErrors).toEqual([]);
});
