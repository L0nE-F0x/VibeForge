import { describe, expect, it } from "vitest";
import { createTask } from "../../src/core/tasks.js";
import type { TaskView } from "../../src/shared/api.js";
import { taskEdited, type TaskFields } from "../../src/ui/views/Tasks.js";

/** A task as the board lists it, saved from what the sheet held. */
function saved(fields: TaskFields): TaskView {
  const task = createTask({ title: fields.title, body: fields.body, agentId: fields.agentId || null, workspaceId: fields.workspaceId || null, isolated: fields.isolated, shareCheckout: fields.shareCheckout });
  return { ...task, lastRun: null, blocker: null, copyOwned: true, writers: [], waiting: null };
}

describe("the task sheet", () => {
  const fields: TaskFields = { title: "Fix the login page", body: "It loops.\n", agentId: "atlas", workspaceId: "web", isolated: false, shareCheckout: false };

  it("has nothing to save once what it holds is saved", () => {
    expect(taskEdited(fields, saved(fields))).toBe(false);
    expect(taskEdited(fields, null)).toBe(true);
    expect(taskEdited({ ...fields, body: "It loops." }, saved(fields))).toBe(true);
    expect(taskEdited({ ...fields, agentId: "" }, saved(fields))).toBe(true);
  });

  it("compares the title the way the core keeps it, so a space typed at its end doesn't stay Unsaved", () => {
    const typed = { ...fields, title: " Fix the login page  " };
    // The core trims the title it saves; the sheet still holds the spaces it was typed with.
    expect(saved(typed).title).toBe("Fix the login page");
    expect(taskEdited(typed, saved(typed))).toBe(false);
    expect(taskEdited({ ...typed, title: "Fix the signup page " }, saved(typed))).toBe(true);
  });
});
