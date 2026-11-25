// Scenario 1: the first start on an empty profile. Every view opens, the language changes, Ctrl+K
// finds things, a real shell answers, and nothing is asked of the internet.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { launchApp } from "./driver/app.js";

test("an empty profile opens every view, in English and German, and asks nothing of the internet", async () => {
  const app = await launchApp();

  await app.waitFor(`document.querySelector(".stage .main, .stage .view") !== null`, { what: "Home" });
  const views = await app.eval<string[]>(`[...document.querySelectorAll("nav.rail > button.rail-btn[aria-label]")].map((b) => b.getAttribute("aria-label"))`);
  expect(views).toEqual(expect.arrayContaining(["Home", "Code", "Viby", "Agents", "Tasks", "Runs"]));
  for (const view of views) {
    await app.go(view);
    await app.waitFor(`Boolean(document.querySelector(".stage .main, .stage .view, .stage .code-main, .stage .empty"))`, { what: `${view} to render` });
    expect(await app.text(), `${view} rendered its error page`).not.toContain("This view hit a problem");
  }

  // Settings, in German and back.
  await app.eval(`[...document.querySelectorAll(".rail-foot .rail-btn")].at(-1).click(), true`);
  await app.waitFor(`Boolean(document.getElementById("settings-storage"))`, { what: "Settings" });
  await app.call("settings.save", { language: "de" });
  await app.waitFor(`document.documentElement.lang === "de" && document.querySelector(".page-head h1")?.textContent === "Einstellungen"`, { what: "Settings in German" });
  await app.call("settings.save", { language: "en" });
  await app.waitFor(`document.querySelector(".page-head h1")?.textContent === "Settings"`, { what: "Settings in English again" });

  // Ctrl+K finds Settings by part of its name, typed key by key.
  await app.key("Ctrl+K");
  await app.waitFor(`document.activeElement === document.querySelector(".switcher input")`, { what: "the switcher's box to have focus" });
  await app.type("sett");
  await app.waitFor(`document.querySelector(".switcher input")?.value === "sett" && document.querySelectorAll(".switcher-list .row").length > 0`, { what: "a switcher result for what was typed" });
  await app.key("Escape");
  await app.waitFor(`!document.querySelector(".switcher")`, { what: "the switcher to close" });

  // A real shell in a workspace.
  const folder = path.join(app.paths.home, "project");
  fs.mkdirSync(folder, { recursive: true });
  await app.call("workspaces.add", folder);
  const shell = await app.call<{ ptyId: string }>("code.shell", { cwd: folder, cols: 100, rows: 30 });
  await app.terminal(shell.ptyId).waitForText("$");
  await app.call("pty.write", shell.ptyId, "echo E2E-$((20+22))\r");
  await app.terminal(shell.ptyId).waitForText("E2E-42");

  expect(app.blockedRequests).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});
