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
  await app.waitFor(`Boolean(document.querySelector(".sheet .run-row .dot.exited") && !document.querySelector(".sheet .xterm") && Math.round(document.querySelector(".sheet")?.getBoundingClientRect().width ?? 0) === 780)`, { what: "the finished run in the task's sheet" });

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

test("reviewing a multi-file task copy: file list, folded lock file, viewed tick, line notes via Send to, and partial Apply", async () => {
  const app = await launchApp({
    standins: {
      claude: {
        turns: [
          {
            match: "Update three files",
            say: ["Editing three files"],
            files: {
              "src/app.ts": "export const count = 2;\n",
              "src/extra.ts": "export const extra = true;\n",
              "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
            },
            after: ["Done."],
          },
          { match: "standby", say: ["Standing by."], gate: "reviewer" },
        ],
      },
    },
  });
  const repo = app.repo("site", {
    "src/app.ts": "export const count = 1;\n",
    "src/extra.ts": "export const extra = false;\n",
    "package-lock.json": "{}\n",
  });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", repo);
  const workspaceId = added.workspaces.find((w) => w.path === repo)!.id;
  const agent = await app.call<{ id: string }>("agents.save", { name: "Copier", brief: "Edits files.", engine: "claude", places: [repo] });
  const task = await app.call<{ id: string }>("tasks.save", {
    title: "Update three files",
    body: "Update three files cleanly.",
    agentId: agent.id,
    workspaceId,
    isolated: true,
  });

  await openTask(app, "Update three files");
  await app.click({ name: "Execute", role: "button" });
  await app.waitFor(async () => {
    const now = await taskOf(app, task.id);
    return now?.status === "review" && !now.lastRun?.live;
  }, { what: "the multi-file task to finish" });

  // Open the review screen inside the task sheet.
  await app.click({ name: "Review changes", role: "button", within: ".sheet" });
  await app.waitFor(`Boolean(document.querySelector(".sheet .review-wrap"))`, { what: "the review screen to open" });

  // File list shows all 3 files; lock file starts folded (lazy); normal code file renders syntax spans.
  const fileList = await app.text(".sheet .review-files");
  expect(fileList).toContain("src/app.ts");
  expect(fileList).toContain("src/extra.ts");
  expect(fileList).toContain("package-lock.json");
  expect(await app.text('.sheet [data-diff-file="package-lock.json"]')).toContain("Lock file folded");
  expect(await app.eval(`Boolean(document.querySelector('.sheet [data-diff-file="src/app.ts"] .tok-kw'))`)).toBe(true);

  // "Viewed" tick folds the file and persists across closing and reopening Review changes.
  await app.click({ name: "Viewed", role: "button", within: '.sheet [data-diff-file="src/app.ts"]' });
  await app.waitFor(async () => (await app.text(".sheet .review-toolbar")).includes("1/3 viewed"), { what: "1/3 viewed count" });
  await app.click({ name: "Review changes", role: "button", within: ".sheet" });
  await app.click({ name: "Review changes", role: "button", within: ".sheet" });
  await app.waitFor(async () => (await app.text(".sheet .review-toolbar")).includes("1/3 viewed"), { what: "remembered viewed state" });
  await app.click({ name: /src\/app\.ts/, role: "button", within: ".sheet .review-files" });
  await app.waitFor(`Boolean(document.querySelector('.sheet [data-diff-file="src/app.ts"] .diff-row.add'))`, { what: "src/app.ts diff rows after jumping from the file list" });

  // Add a note on the added line and send it via Send to… into a live CLI prompt as a draft.
  const reviewer = await app.call<{ ptyId: string }>("code.engine", { workspaceId, engineId: "claude", prompt: "standby", cols: 100, rows: 30 });
  await app.waitForGate("reviewer");
  const rowBox = await app.eval<{ x: number; y: number } | null>(`(() => {
    const el = document.querySelector('.sheet [data-diff-file="src/app.ts"] .diff-row.add');
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  expect(rowBox).not.toBeNull();
  // The file's one note button moves onto the line under the pointer.
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowBox!.x, y: rowBox!.y });
  await app.waitFor(
    `(() => {
      const row = document.querySelector('.sheet [data-diff-file="src/app.ts"] .diff-row.add');
      const button = document.querySelector('.sheet [data-diff-file="src/app.ts"] .diff-note-trigger');
      return Boolean(row && button && Math.abs(row.getBoundingClientRect().top - button.getBoundingClientRect().top) < 1);
    })()`,
    { what: "the note button on the added line" },
  );
  await app.click({ name: "Add a note (src/app.ts:1)", role: "button", within: ".sheet" });
  await app.waitFor(`document.activeElement?.tagName === "TEXTAREA"`, { what: "note composer focus" });
  await app.type("Check count value.");
  await app.click({ name: "Save note", role: "button", within: ".sheet" });
  await app.waitFor(async () => (await app.text(".sheet .review-notes-bar")).includes("1 note"), { what: "notes bar count" });

  await app.click({ name: "Send to…", role: "button", within: ".sheet .review-notes-bar" });
  await app.click({ name: /Claude Code/, role: "menuitem" });
  await app.waitFor(async () => (await toasts(app)).includes("Left in"), { what: "Send to draft toast" });
  await app.terminal(reviewer.ptyId).waitForText("src/app.ts:1");
  await app.terminal(reviewer.ptyId).waitForText("Check count value.");
  app.openGate("reviewer");

  // The run's Changes tab lists the copy's own files, as the sheet does: untick src/extra.ts there
  // and Apply only the 2 ticked files.
  await openTask(app, "Update three files");
  await app.click({ name: /Update three files/, role: "button", within: ".sheet" });
  await app.click({ name: "Changes", role: "tab" });
  await app.waitFor(`Boolean(document.querySelector('.review-files input[type="checkbox"]'))`, { what: "file selection checkboxes on the run's Changes tab" });
  await app.click({ name: "src/extra.ts", role: "checkbox", within: ".review-files" });
  await app.click({ name: "Apply 2 of 3 to site", role: "button" });
  await app.waitFor(async () => (await toasts(app)).includes("1 file stayed in the copy."), { what: "partial Apply toast" });
  expect(fs.readFileSync(path.join(repo, "src/app.ts"), "utf8")).toBe("export const count = 2;\n");
  expect(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")).toContain("lockfileVersion");
  expect(fs.readFileSync(path.join(repo, "src/extra.ts"), "utf8")).toBe("export const extra = false;\n");
  expect((await taskOf(app, task.id))?.copy).toBeTruthy();

  // The copy remembers what went in: the review starts those two unticked and marked applied.
  await app.waitFor(async () => ((await app.text(".review-files")).match(/applied/g) ?? []).length === 2, { what: "the two applied files marked" });
  expect(await app.text(".review-toolbar")).toContain("1/3 selected");
  // Reverted in the workspace since: the rest goes in without bringing it back, and the copy goes.
  app.git(repo, "checkout", "--", "src/app.ts");
  await app.click({ name: "Apply to site", role: "button" });
  await app.waitFor(async () => (await toasts(app)).includes("The copy is gone.") && !(await taskOf(app, task.id))?.copy, { what: "final Apply to finish and remove the copy" });
  expect(fs.readFileSync(path.join(repo, "src/extra.ts"), "utf8")).toBe("export const extra = true;\n");
  expect(fs.readFileSync(path.join(repo, "src/app.ts"), "utf8")).toBe("export const count = 1;\n");
  expect((await taskOf(app, task.id))?.status).toBe("done");

  expect(app.pageErrors).toEqual([]);
});
