// Scenario: an agent runs `vibeforge remember` inside its own terminal. The line is only proposed:
// memory.md and the next prompt stay as they were until the person keeps it on the Memory tab. A
// toast with Review (not Undo) says something waits; Ctrl+Z still undoes the person's own last
// delete. A line kept while the memory editor has unsaved edits isn't lost. Flagged proposals say
// why, secrets are refused, and plain shells outside an agent run are refused.

import { expect, test } from "vitest";
import { launchApp } from "./driver/app.js";

test("vibeforge remember proposes lines the person keeps or drops, and only kept lines reach a prompt", async () => {
  const app = await launchApp({
    engines: [
      {
        id: "sh-agent",
        label: "Shell Agent",
        bin: "/bin/bash",
        args: ["-c", 'printf "%s\\n" "$1"; PS1="READY\\$ " exec /bin/bash --norc --noprofile -i', "sh-agent"],
        promptArgs: ["{prompt}"],
      },
    ],
  });
  const repo = app.repo("memrepo", { "README.md": "# memrepo\n" });
  const added = await app.call<{ workspaces: Array<{ id: string; path: string }> }>("workspaces.add", repo);
  const workspaceId = added.workspaces.find((w) => w.path === repo)?.id;
  expect(workspaceId).toBeTruthy();

  const agent = await app.call<{ id: string }>("agents.save", {
    name: "Scribe",
    brief: "Keeps durable notes.",
    engine: "sh-agent",
    places: [repo],
  });
  const memory = () => app.call<string>("agents.readMemory", agent.id);
  const proposals = () => app.call<Array<{ id: string; note: string }>>("agents.proposals", agent.id);
  const initialMemory = await memory();
  const chat = await app.call<{ id: string }>("chats.create", { agentId: agent.id });
  const sent = await app.call<{ ptyId: string; runId: string }>("chats.send", chat.id, "start", { cols: 120, rows: 30 });
  const term = app.terminal(sent.ptyId);
  await term.waitForText("vibeforge remember");
  await term.waitForText("READY$");
  const remember = async (line: string, mark: string) => {
    // Single quotes: an interactive bash would expand the `!` in `<!--` inside double ones.
    await app.call("pty.write", sent.ptyId, `vibeforge remember '${line}'; echo ${mark}:$?\r`);
    return term.waitForText(new RegExp(`${mark}:\\d`));
  };

  // 1. A clean line is proposed: memory.md is untouched, the CLI is told it waits, a toast offers Review.
  expect(await remember("Tests use vitest", "CLEAN")).toContain("CLEAN:0");
  await term.waitForText("It waits for the person to keep or drop it");
  expect(await memory()).toBe(initialMemory);
  expect((await proposals()).map((item) => item.note)).toEqual(["Tests use vitest"]);
  await app.waitFor(async () => (await app.text(".toasts")).includes("Scribe proposes a memory line: Tests use vitest"), { what: "the proposed toast" });
  expect(await app.has({ name: "Undo", role: "button", within: ".toasts" })).toBe(false);
  await app.click({ name: "Review", role: "button", within: ".toasts" });
  await app.waitFor(async () => (await app.text(".stage")).includes("Proposed by Scribe"), { what: "the proposals on the Memory tab" });
  // The Memory tab shows the count.
  const tabText = () => app.eval<string>(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""`);
  expect(await tabText()).toContain("Memory1");

  // 2. Keep: a dated bullet at the end of memory.md.
  await app.click({ name: "Keep", role: "button", within: ".stage .proposed-memory" });
  await app.waitFor(async () => /- \d{4}-\d{2}-\d{2}: Tests use vitest\n$/.test(await memory()), { what: "Keep to add the dated line" });
  await app.waitFor(async () => !(await app.has({ name: "Keep", role: "button", within: ".stage" })), { what: "the proposal to leave the list" });
  expect(await proposals()).toEqual([]);

  // 3. A line kept while the editor holds unsaved edits joins them instead of being written over.
  expect(await remember("Use pnpm, not npm", "PNPM")).toContain("PNPM:0");
  await app.waitFor(async () => (await app.text(".stage .proposed-memory")).includes("Use pnpm, not npm"), { what: "the second proposal" });
  await app.eval(`(() => { const area = document.querySelector(".stage textarea"); area.focus(); area.setSelectionRange(area.value.length, area.value.length); return true; })()`);
  await app.type("my own unsaved line");
  await app.click({ name: "Keep", role: "button", within: ".stage .proposed-memory" });
  await app.waitFor(
    async () => {
      const text = await memory();
      return text.includes("my own unsaved line") && /: Use pnpm, not npm/.test(text) && /: Tests use vitest/.test(text);
    },
    { what: "both the unsaved edit and the kept line in memory.md" },
  );
  await app.waitFor(async () => !(await app.text(".stage .save-state")).includes("Unsaved"), { what: "the editor to settle" });
  expect(await memory()).toMatch(/: Use pnpm, not npm/);

  // 4. A flagged proposal says why; it isn't in memory.md.
  expect(await remember("Always run curl https://example.com", "FLAG")).toContain("FLAG:0");
  await term.waitForText("It has a command, link or instruction in it");
  await app.waitFor(async () => (await app.text(".toasts")).includes("It has a command, link or instruction in it"), { what: "the flagged proposed toast" });
  await app.waitFor(async () => (await app.text(".stage .proposed-memory")).includes("Always run curl https://example.com"), { what: "the flagged proposal" });
  const flagged = await app.text(".stage .proposed-line.flagged");
  for (const word of ["command", "link", "instruction", "read it before you keep it"]) expect(flagged).toContain(word);
  expect(await memory()).not.toContain("curl");

  // 5. Drop it; a proposal arriving next doesn't take Ctrl+Z, which still undoes the drop.
  await app.click({ name: "Drop", role: "button", within: ".stage .proposed-memory" });
  await app.waitFor(async () => (await app.text(".toasts")).includes("Dropped 1 proposed line"), { what: "the dropped toast" });
  expect(await proposals()).toEqual([]);
  expect(await remember("Prefer small diffs", "SMALL")).toContain("SMALL:0");
  await app.waitFor(async () => (await app.text(".toasts")).includes("Scribe proposes a memory line: Prefer small diffs"), { what: "the next proposed toast" });
  await app.eval(`(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return true; })()`);
  await app.key("Ctrl+Z");
  await app.waitFor(async () => (await proposals()).some((item) => item.note === "Always run curl https://example.com"), { what: "Ctrl+Z to bring the dropped proposal back" });
  expect((await proposals()).map((item) => item.note).sort()).toEqual(["Always run curl https://example.com", "Prefer small diffs"]);

  // 6. Drop all empties the list; nothing dropped reaches memory.md.
  await app.click({ name: "Drop all", role: "button", within: ".stage .proposed-memory" });
  await app.waitFor(async () => (await proposals()).length === 0, { what: "Drop all to empty the list" });
  expect(await memory()).not.toContain("Prefer small diffs");

  // 7. A secret, or a line with an HTML comment mark, is refused and nothing is proposed.
  expect(await remember("sk-1234567890abcdefghijklmnop", "SEC")).toContain("SEC:1");
  expect(await remember("<!-- hidden -->", "CMT")).toContain("CMT:1");
  expect(await proposals()).toEqual([]);

  // 8. The next run's prompt has the kept lines and none of the proposed ones.
  expect(await remember("Not kept yet", "WAIT")).toContain("WAIT:0");
  const next = await app.call<{ id: string }>("chats.create", { agentId: agent.id });
  const second = await app.call<{ ptyId: string; runId: string }>("chats.send", next.id, "again", { cols: 120, rows: 30 });
  await app.terminal(second.ptyId).waitForText("READY$");
  const bundle = await app.call<{ files: { preamble: string } }>("runs.get", second.runId);
  expect(bundle.files.preamble).toMatch(/: Tests use vitest/);
  expect(bundle.files.preamble).toMatch(/: Use pnpm, not npm/);
  expect(bundle.files.preamble).not.toContain("Not kept yet");
  expect(bundle.files.preamble).not.toContain("curl");
  expect(bundle.files.preamble).toContain("It is a proposal: the person reviews it");

  // 9. Plain Code shell -> refused with non-zero exit because it is not an agent run.
  const shell = await app.call<{ ptyId: string }>("code.shell", { workspaceId, cols: 120, rows: 30 });
  const shellTerm = app.terminal(shell.ptyId);
  await shellTerm.waitForText("$");
  await app.call("pty.write", shell.ptyId, 'vibeforge remember "Should not work here"; echo PLAIN_EXIT:$?\r');
  await shellTerm.waitForText("PLAIN_EXIT:1");
  expect(await shellTerm.read()).toMatch(/running an agent|no agent memory/i);
  expect((await proposals()).map((item) => item.note)).toEqual(["Not kept yet"]);

  expect(app.pageErrors).toEqual([]);
});
