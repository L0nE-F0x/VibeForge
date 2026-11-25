// Scenario: a list that can't be read says so, in place, instead of looking empty (3.7.1). The main
// process is made to refuse the window's reads of agents and tasks, as a folder it isn't allowed to
// read would; Try again reads them once it can.

import { expect, test } from "vitest";
import { launchApp } from "./driver/app.js";

const REASON = "EACCES: permission denied, scandir '/home/someone/.config/vibeforge/agents'";

test("agents and tasks that can't be read say so, keep what's there, and come back with Try again", async () => {
  const app = await launchApp({ mainProcess: true, standins: { claude: {} }, allowErrors: [/EACCES: permission denied/] });
  await app.call("agents.save", { name: "Atlas", brief: "Helps.", engine: "claude", places: [app.paths.home] });

  await app.refuse(["agents.list", "tasks.list"], REASON);
  await app.reload();

  await app.go("Agents");
  await app.waitFor(`Boolean(document.querySelector(".stage .load-failed"))`, { what: "the in-place error in Agents" });
  const agents = await app.text();
  expect(agents).toContain("Couldn't read your agents.");
  expect(agents).toContain(REASON);
  expect(agents).toContain("This doesn't mean there's nothing here");
  expect(agents).not.toContain("No agents yet");

  await app.go("Tasks");
  await app.waitFor(`[...document.querySelectorAll(".stage .load-failed")].some((n) => n.innerText.includes("Couldn't read your tasks."))`, { what: "the in-place error in Tasks" });
  expect(await app.text()).not.toContain("Nothing queued.");

  // Readable again: Try again reads the board, and an empty one says so.
  await app.refuse([]);
  await app.click({ name: "Try again", role: "button", within: ".stage .load-failed" });
  await app.waitFor(`!document.querySelector(".stage .load-failed")`, { what: "the Tasks error to go" });
  expect(await app.text()).toContain("Nothing queued.");

  // Agents may still show its error, or may have read again on its own (the 30-second refresh):
  // either way, one press of its Try again, if it is there, brings Atlas back.
  await app.go("Agents");
  await app.eval(`[...document.querySelectorAll(".stage .load-failed button")].find((b) => b.innerText.includes("Try again"))?.click(), true`);
  await app.waitFor(async () => (await app.text()).includes("Atlas") && !(await app.eval(`Boolean(document.querySelector(".stage .load-failed"))`)), { what: "Atlas listed once agents read" });
});
