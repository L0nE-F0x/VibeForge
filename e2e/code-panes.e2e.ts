// Scenario 2: shells in Code. Split a pane, type into each, close one: the other keeps running with
// its output. The layout is saved, and after a restart the same panes come back with shells in them.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { type App, launchApp } from "./driver/app.js";

type Live = { ptyId: string; kind: string; workspaceId?: string | null };
const shellsIn = async (app: App, workspaceId: string) => (await app.call<Live[]>("live.list")).filter((s) => s.kind === "shell" && s.workspaceId === workspaceId);
const panes = (app: App) => app.eval<string[]>(`[...document.querySelectorAll(".stage .pane[data-pane]")].map((p) => p.getAttribute("data-pane"))`);
const focusedPane = (app: App) => app.eval<string | null>(`document.querySelector(".stage .pane.focused")?.getAttribute("data-pane") ?? null`);
type Layout = { kind: "split"; dir: string; a: Layout; b: Layout } | { kind: "pane"; launch?: { type: string } } | null;
/** The shape of a saved layout: splits and panes, without ids or sizes. */
const shape = (node: Layout): unknown => (node?.kind === "split" ? { dir: node.dir, a: shape(node.a), b: shape(node.b) } : node ? node.launch?.type : null);

/** Click into a pane's terminal, so typing goes to its shell. */
async function focusTerminal(app: App, paneId: string) {
  const point = await app.waitFor(
    `(() => { const el = document.querySelector('.pane[data-pane="${paneId}"] .xterm-screen'); if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`,
    { what: `pane ${paneId}'s terminal` },
  );
  const { x, y } = point as { x: number; y: number };
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await app.waitFor(`document.activeElement?.closest('.pane[data-pane="${paneId}"]') !== null && document.activeElement?.classList.contains("xterm-helper-textarea")`, { what: `pane ${paneId}'s terminal to have focus` });
}

test("split, type, close one pane, and the layout comes back after a restart", async () => {
  const app = await launchApp();
  const folder = path.join(app.paths.home, "Projects", "panes");
  fs.mkdirSync(folder, { recursive: true });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", folder);
  const workspaceId = added.workspaces.find((w) => w.path === folder)!.id;

  await app.go("Code");
  await app.click({ name: "New terminal", role: "button", within: ".stage" });
  const [first] = await app.waitFor(async () => ((await panes(app)).length === 1 ? await panes(app) : null), { what: "one pane in the new workspace" });
  const [left] = await app.waitFor(async () => ((await shellsIn(app, workspaceId)).length === 1 ? await shellsIn(app, workspaceId) : null), { what: "its shell to start" });
  await app.terminal(left.ptyId).waitForText("$");
  await focusTerminal(app, first);
  // Typed through the terminal itself; the shell's answer is upper case, so it isn't the echo of what was typed.
  await app.type("echo left pane | tr a-z A-Z\n");
  await app.terminal(left.ptyId).waitForText("LEFT PANE");

  // Split right: a second pane with a shell of its own, focused.
  await app.key("Ctrl+Shift+D");
  const two = await app.waitFor(async () => ((await panes(app)).length === 2 ? await panes(app) : null), { what: "a second pane" });
  const second = two.find((id) => id !== first)!;
  const right = (await app.waitFor(async () => ((await shellsIn(app, workspaceId)).length === 2 ? await shellsIn(app, workspaceId) : null), { what: "the second shell" })).find((s) => s.ptyId !== left.ptyId)!;
  await app.waitFor(async () => (await focusedPane(app)) === second, { what: "the new pane to have focus" });
  await app.terminal(right.ptyId).waitForText("$");
  await focusTerminal(app, second);
  await app.type("echo right pane | tr a-z A-Z\n");
  await app.terminal(right.ptyId).waitForText("RIGHT PANE");
  expect(await app.terminal(left.ptyId).read()).not.toContain("RIGHT PANE");

  // Close the right one. A shell's question says what stops; Close terminal answers it.
  await app.key("Ctrl+Shift+W");
  await app.waitFor(async () => (await app.text("[role=dialog], [role=alertdialog]")).includes("Close this terminal?"), { what: "the question about closing the shell" });
  await app.click({ name: "Close terminal", role: "button" });
  await app.waitFor(async () => (await panes(app)).length === 1, { what: "the pane to close" });
  expect(await panes(app)).toEqual([first]);
  await app.waitFor(async () => (await shellsIn(app, workspaceId)).map((s) => s.ptyId).join() === left.ptyId, { what: "only the left shell to run" });
  // The one left keeps its shell and what it printed, and still answers.
  expect(await app.terminal(left.ptyId).read()).toContain("LEFT PANE");
  await focusTerminal(app, first);
  await app.type("echo still here | tr a-z A-Z\n");
  await app.terminal(left.ptyId).waitForText("STILL HERE");

  // Split down, then restart: the layout is read back and each pane gets a shell again.
  await app.key("Ctrl+Shift+E");
  await app.waitFor(async () => (await panes(app)).length === 2, { what: "two panes again" });
  const saved = await app.waitFor(async () => {
    const layout = await app.call<Layout>("layouts.get", workspaceId);
    return layout?.kind === "split" ? layout : null;
  }, { what: "the split layout to be saved" });
  expect(shape(saved)).toEqual({ dir: "col", a: "shell", b: "shell" });

  await app.restart();
  expect(shape(await app.call<Layout>("layouts.get", workspaceId))).toEqual(shape(saved));
  await app.go("Code");
  await app.waitFor(async () => (await panes(app)).length === 2, { what: "both panes after the restart" });
  const after = await app.waitFor(async () => ((await shellsIn(app, workspaceId)).length === 2 ? await shellsIn(app, workspaceId) : null), { what: "a shell in each pane after the restart" });
  await app.terminal(after[0].ptyId).waitForText("$");
  await app.terminal(after[1].ptyId).waitForText("$");

  expect(app.pageErrors).toEqual([]);
});
