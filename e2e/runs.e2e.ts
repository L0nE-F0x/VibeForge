// Scenarios 3 and 4: what a CLI does is recorded as a run. A stand-in `claude` typed at a shell's
// prompt becomes a run with its transcript and diff; and a CLI that floods its terminal and exits
// keeps its last line on screen and in the transcript (W02's lost-tail bug, end to end).

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { type App, launchApp } from "./driver/app.js";

type Run = { id: string; engine: string; status: string; cwd: string; origin: string };
type Bundle = { run: Run & { exitCode: number | null; dir: string }; files: { transcript: string; screen: string }; restore?: string };
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

/**
 * The run menu's "Put files back" item once it is laid out and shows `note`. Read as textContent:
 * innerText is "" until the menu has its layout, the moment it first becomes visible.
 */
function menuItem(note: string): string {
  return `(() => {
    const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((el) => (el.textContent ?? "").includes("Put files back as before this run"));
    if (!item || getComputedStyle(item).visibility === "hidden" || !item.getBoundingClientRect().width) return null;
    const text = item.textContent ?? "";
    return text.includes(${JSON.stringify(note)}) ? { disabled: Boolean(item.disabled), text } : null;
  })()`;
}

test("putting a real-folder run's files back leaves later edits alone and can be undone", async () => {
  const app = await launchApp({
    standins: {
      claude: {
        turns: [
          {
            say: ["Editing files"],
            files: {
              "README.md": "after run\n",
              "keep.txt": "changed by run\n",
              "created.txt": "made by run\n",
            },
            gate: "undo-run",
            after: ["Done."],
          },
        ],
      },
    },
  });
  const repo = app.repo("undoable", {
    "README.md": "before run\n",
    "keep.txt": "before run\n",
  });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", repo);
  const workspaceId = added.workspaces.find((w) => w.path === repo)!.id;

  const started = await app.call<{ runId: string; ptyId: string }>("code.engine", { workspaceId, engineId: "claude", cols: 100, rows: 30 });
  await app.waitForGate("undo-run");

  await app.go("Runs");
  await app.click({ name: "All", role: "button", within: ".stage" });
  await app.click({ name: /Claude Code/, role: "button", within: ".stage .list-scroll" });
  await app.click({ name: "More for this run", role: "button" });
  const runningItem = await app.waitFor<{ disabled: boolean; text: string }>(menuItem("Available once this run finishes."), {
    what: "the disabled restore menu item while running",
  });
  expect(runningItem.disabled).toBe(true);
  expect(runningItem.text).toContain("Available once this run finishes.");
  await app.key("Escape");

  app.openGate("undo-run");
  const done = await app.waitFor(async () => {
    const bundle = await app.call<Bundle>("runs.get", started.runId);
    return bundle.run.status !== "running" ? bundle : null;
  }, { what: "the run to finish" });

  fs.writeFileSync(path.join(repo, "keep.txt"), "edited after run\n");

  await app.click({ name: "More for this run", role: "button" });
  await app.click({ name: "Put files back as before this run", role: "menuitem" });

  const modalText = await app.waitFor<string>(
    `(() => {
      const text = document.querySelector(".modal")?.innerText ?? "";
      return text.includes("Put files back as before this run?") && text.includes("keep.txt") ? text : null;
    })()`,
    { what: "the restore confirmation dialog" },
  );
  expect(modalText).toContain("2 files will be put back as before this run.");
  expect(modalText).toContain("1 file will be left alone.");
  expect(modalText).toContain("README.md");
  expect(modalText).toContain("created.txt");
  expect(modalText).toContain("keep.txt");
  expect(modalText).toContain("Anything changed in this folder while the run went, by you or another CLI, goes back too.");

  await app.click({ name: "Put files back", role: "button", within: ".modal" });
  await app.waitFor(
    `(() => {
      const text = document.querySelector(".toasts")?.innerText ?? "";
      return text.includes("Put 2 files back") && text.includes("Undo");
    })()`,
    { what: "the restore toast with Undo" },
  );

  expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("before run\n");
  expect(fs.existsSync(path.join(repo, "created.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(repo, "keep.txt"), "utf8")).toBe("edited after run\n");

  await app.click({ name: "Undo", role: "button", within: ".toasts" });
  await app.waitFor(`(document.querySelector(".toasts")?.innerText ?? "").includes("Put the run's changes back")`, {
    what: "the undo confirmation toast",
  });

  expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("after run\n");
  expect(fs.readFileSync(path.join(repo, "created.txt"), "utf8")).toBe("made by run\n");
  expect(fs.readFileSync(path.join(repo, "keep.txt"), "utf8")).toBe("edited after run\n");

  fs.rmSync(path.join(done.run.dir, "snapshots.json"), { force: true });
  await app.reload();
  if (!(await app.has({ name: "More for this run", role: "button" }))) {
    await app.go("Runs");
    await app.click({ name: "All", role: "button", within: ".stage" });
    await app.click({ name: /Claude Code/, role: "button", within: ".stage .list-scroll" });
  }
  await app.click({ name: "More for this run", role: "button" });
  const missingItem = await app.waitFor<{ disabled: boolean; text: string }>(menuItem("No before-and-after snapshot was saved for this run."), {
    what: "the disabled restore menu item when snapshots are missing",
  });
  expect(missingItem.disabled).toBe(true);
  expect(missingItem.text).toContain("No before-and-after snapshot was saved for this run.");
  await app.key("Escape");

  expect(app.pageErrors).toEqual([]);
});
