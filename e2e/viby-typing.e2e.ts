// Scenario: typing to Viby, and "go" said in other words (W21). The founder's report of 2026-11-25:
// keys typed into Viby didn't land, a sent message came back into the box, and "Go, go, go." didn't
// run a plan that was waiting for Go. A stand-in planner answers in place of Claude Code.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { type App, launchApp } from "./driver/app.js";

const BOX = ".viby-view textarea";
const boxValue = (app: App) => app.eval<string>(`document.querySelector(${JSON.stringify(BOX)})?.value ?? null`);
const vibyText = (app: App) => app.text(".viby-view");

test("a sentence typed into Viby lands and sends, and 'Go, go, go.' runs the plan waiting for Go", async () => {
  const app = await launchApp({
    settings: { orchestrator: { engine: "claude", mode: "plan" } },
    standins: {
      claude: {
        plans: [
          {
            match: "make a workspace called viby-made",
            structured: { say: "I'll make a workspace called viby-made.", steps: [{ kind: "workspace", action: "create", name: "viby-made", folder: "$HOME/Projects/viby-made" }] },
          },
        ],
      },
    },
  });
  const made = path.join(app.paths.home, "Projects", "viby-made");

  await app.go("Viby");
  await app.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(BOX)})`, { what: "Viby's message box to have focus" });

  // Key by key, the way a keyboard types: every character lands, none is written back over.
  await app.type("hello there");
  expect(await boxValue(app)).toBe("hello there");
  await app.key("Enter");
  await app.waitFor(async () => (await vibyText(app)).includes("Stand-in answer."), { what: "the stand-in planner's answer" });
  // The sent message doesn't come back into the box (3.6.1's second bug).
  expect(await boxValue(app)).toBe("");

  await app.type("make a workspace called viby-made");
  expect(await boxValue(app)).toBe("make a workspace called viby-made");
  await app.key("Enter");
  await app.waitFor(`Boolean(document.querySelector(".viby-view .viby-confirm"))`, { what: "the plan's card, waiting for Go" });
  expect(await vibyText(app)).toContain("I'll make a workspace called viby-made.");
  // Waiting means nothing has happened yet.
  expect(fs.existsSync(made)).toBe(false);
  expect((await app.call<{ workspaces: Array<{ name: string }> }>("workspaces.list")).workspaces.map((w) => w.name)).not.toContain("viby-made");

  // Said the way the founder said it, punctuation and all.
  expect(await boxValue(app)).toBe("");
  await app.type("Go, go, go.");
  await app.key("Enter");
  await app.waitFor(async () => (await app.call<{ workspaces: Array<{ name: string; path: string }> }>("workspaces.list")).workspaces.find((w) => w.name === "viby-made"), {
    what: "the waiting plan to run and make the workspace",
  });
  expect(fs.existsSync(made)).toBe(true);
  await app.waitFor(`!document.querySelector(".viby-view .viby-confirm")`, { what: "the card to stop waiting" });
  // The answer was taken as Go here, without asking the planner again.
  expect(app.standin("claude").calls().filter((call) => call.mode === "plan")).toHaveLength(2);

  // After leaving Viby and coming back, typing still lands in the box.
  await app.go("Home");
  await app.go("Viby");
  await app.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(BOX)})`, { what: "the box to have focus again" });
  await app.type("back again");
  expect(await boxValue(app)).toBe("back again");

  expect(app.pageErrors).toEqual([]);
});
