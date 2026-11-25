// Scenario: a task in its own copy. Execute starts a stand-in CLI in a git worktree, which edits a
// file; the run's Changes show the diff; Discard copy goes at once with Undo on its toast, and Undo
// brings the copy back with its edit; Apply brings the edit into the workspace uncommitted and
// removes the copy.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { type App, launchApp } from "./driver/app.js";

type Task = { id: string; status: string; copy: { path: string; branch: string } | null; lastRun: { live: boolean; status: string } | null };
const taskOf = async (app: App, id: string) => (await app.call<Task[]>("tasks.list")).find((task) => task.id === id);
const toasts = (app: App) => app.text(".toasts");
/** The task's sheet: Tasks remembers an open sheet, so it may already be there. */
async function openTask(app: App, title: string) {
  await app.go("Tasks");
  const open = await app.waitFor(`document.querySelector(".sheet h1")?.textContent === ${JSON.stringify(title)} ? "open" : document.querySelector(".stage .task-card") ? "closed" : null`, { what: "the board or the task's sheet" });
  if (open === "closed") await app.click({ name: new RegExp(`^${title}`), role: "button", within: ".stage" });
  await app.waitFor(`document.querySelector(".sheet h1")?.textContent === ${JSON.stringify(title)}`, { what: `the sheet of "${title}"` });
}

test("a task in its own copy: Execute, the diff, Discard with Undo, then Apply", async () => {
  const app = await launchApp({
    standins: {
      claude: {
        turns: [{ match: "Change the README", say: ["Editing README.md"], files: { "README.md": "changed in the copy\n" }, gate: "edit", after: ["Done."] }],
      },
    },
  });
  const repo = app.repo("site", { "README.md": "first\n" });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", repo);
  const workspaceId = added.workspaces.find((w) => w.path === repo)!.id;
  const agent = await app.call<{ id: string }>("agents.save", { name: "Copier", brief: "Edits files.", engine: "claude", places: [repo] });
  const task = await app.call<{ id: string }>("tasks.save", { title: "Change the README", body: "Change the README to say it changed.", agentId: agent.id, workspaceId, isolated: true });

  // Execute, from the task's sheet.
  await openTask(app, "Change the README");
  await app.click({ name: "Execute", role: "button" });
  await app.waitForGate("edit");
  const running = await app.waitFor(async () => (await taskOf(app, task.id))?.copy, { what: "the task's copy" });
  // The CLI runs in the copy, its output in the sheet's terminal.
  expect(app.standin("claude").calls()[0].cwd).toBe(running.path);
  await app.waitFor(async () => (await app.text(".sheet")).includes("Editing README.md"), { what: "the CLI's output in the task's terminal" });

  app.openGate("edit");
  await app.waitFor(async () => {
    const now = await taskOf(app, task.id);
    return now?.status === "review" && !now.lastRun?.live;
  }, { what: "the task to finish and wait for review" });
  // The edit is in the copy; the workspace is untouched.
  expect(fs.readFileSync(path.join(running.path, "README.md"), "utf8")).toBe("changed in the copy\n");
  expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("first\n");
  await app.waitFor(`Boolean(document.querySelector(".sheet .run-row"))`, { what: "the finished run in the task's sheet" });

  // Review: the run's Changes show what the CLI changed in the copy.
  await app.click({ name: /Change the README/, role: "button", within: ".sheet" });
  await app.click({ name: "Changes", role: "tab" });
  await app.waitFor(async () => (await app.text(".diff")).includes("changed in the copy"), { what: "the diff with the copy's edit" });

  // Discard: at once, no "are you sure", and Undo on the toast.
  await openTask(app, "Change the README");
  await app.click({ name: "Discard copy", role: "button" });
  await app.waitFor(async () => (await toasts(app)).includes('Discarded the copy of "Change the README"'), { what: "the Discarded toast" });
  expect(await app.eval(`Boolean(document.querySelector("[role=alertdialog], .modal"))`)).toBe(false);
  await app.waitFor(async () => !fs.existsSync(running.path), { what: "the copy's folder to go" });
  expect((await taskOf(app, task.id))?.copy).toBeFalsy();

  await app.click({ name: "Undo", role: "button", within: ".toasts" });
  await app.waitFor(async () => (await taskOf(app, task.id))?.copy, { what: "Undo to bring the copy back" });
  expect(fs.readFileSync(path.join(running.path, "README.md"), "utf8")).toBe("changed in the copy\n");

  // Apply: the edit arrives in the workspace, uncommitted, and the copy goes.
  await app.click({ name: "Apply to site", role: "button" });
  await app.waitFor(async () => (await toasts(app)).includes("Applied to site"), { what: "the Applied toast" });
  expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("changed in the copy\n");
  expect(app.git(repo, "status", "--porcelain").trim()).toBe("M README.md");
  await app.waitFor(async () => !fs.existsSync(running.path), { what: "the copy to be removed after Apply" });
  expect((await taskOf(app, task.id))?.copy).toBeFalsy();

  expect(app.pageErrors).toEqual([]);
});
