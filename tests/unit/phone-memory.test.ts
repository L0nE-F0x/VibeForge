import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** The phone page's module for the Orchestrator's view. */
const page = fs.readFileSync(path.join(import.meta.dirname, "../../companion/js/maestro.js"), "utf8");

/** A top-level function of the phone page, as written there, without its `export`. */
function pick(name: string): string {
  const found = page.match(new RegExp(`^(export )?(async )?function ${name}\\([\\s\\S]*?^}$`, "m"))?.[0];
  if (!found) throw new Error(`maestro.js has no function ${name}`);
  return found.replace(/^export /, "");
}

/** The page's own Memory panel, opened against a computer that answers (or doesn't) with `call`. */
function memoryPanel(call: () => Promise<unknown>) {
  const script = [
    `const state = { actionError: "" };`,
    `let updates = 0; let closed = 0; let opened = 0;`,
    `const box = { value: "", disabled: false };`,
    `const save = { disabled: false };`,
    `const parts = { memoryBox: box, memorySave: save, memorySheet: { open() { opened += 1; }, querySelector() { return { click() { closed += 1; } }; } } };`,
    `function update() { updates += 1; }`,
    ...["closeSheet", "openMemorySheet"].map(pick),
    `globalThis.panel = { open: openMemorySheet, seen: () => ({ box, save, error: state.actionError, closed, opened, updates }) };`,
  ].join("\n");
  const context = vm.createContext({ call });
  vm.runInContext(script, context);
  return context.panel as { open(): Promise<void>; seen(): { box: { value: string; disabled: boolean }; save: { disabled: boolean }; error: string; closed: number; opened: number; updates: number } };
}

describe("the phone page's Viby memory panel", () => {
  it("shows what the computer sent, and lets it be edited", async () => {
    const panel = memoryPanel(async () => ({ text: "Prefers small diffs." }));
    await panel.open();
    expect(panel.seen()).toMatchObject({ box: { value: "Prefers small diffs.", disabled: false }, save: { disabled: false }, closed: 0, error: "" });
  });

  it("does not offer an empty box to save over a memory that didn't load", async () => {
    const panel = memoryPanel(async () => {
      throw Object.assign(new Error("The computer is not serving the page."), { offline: true });
    });
    await panel.open();
    const seen = panel.seen();
    // Saving from here would replace the whole memory with whatever was typed in the blank box.
    expect(seen.save.disabled).toBe(true);
    expect(seen.box.disabled).toBe(true);
    expect(seen.closed).toBe(1);
    expect(seen.error).toBe("The computer is not serving the page.");
    expect(seen.updates).toBe(1);
  });
});
