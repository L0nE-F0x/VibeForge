// Scenario: an agent runs `vibeforge remember` inside its own terminal, triggers the toast
// with Undo, triggers flagged warnings (command/URL/instruction) that open the Memory tab,
// and plain shells outside an agent run are refused.

import { expect, test } from "vitest";
import { launchApp } from "./driver/app.js";

test("vibeforge remember appends dated memory, supports Undo, flags risky lines, and refuses plain shells", async () => {
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
  const chat = await app.call<{ id: string }>("chats.create", { agentId: agent.id });
  const sent = await app.call<{ ptyId: string; runId: string }>("chats.send", chat.id, "start", { cols: 120, rows: 30 });
  const term = app.terminal(sent.ptyId);
  await term.waitForText("vibeforge remember");
  await term.waitForText("READY$");

  // 1. Clean remember in the agent's terminal -> appends dated bullet + shows Undo toast.
  await app.call("pty.write", sent.ptyId, 'vibeforge remember "Tests use vitest"; echo CLEAN_EXIT:$?\r');
  await term.waitForText("CLEAN_EXIT:0");
  await term.waitForText("Remembered for Scribe");

  const memAfterClean = await app.call<string>("agents.readMemory", agent.id);
  expect(memAfterClean).toMatch(/- \d{4}-\d{2}-\d{2}: Tests use vitest/);

  await app.waitFor(
    async () => (await app.text(".toasts")).includes("Scribe remembered: Tests use vitest"),
    { what: "the remembered toast" },
  );
  await app.click({ name: "Undo", role: "button", within: ".toasts" });
  await app.waitFor(
    async () => !(await app.call<string>("agents.readMemory", agent.id)).includes("Tests use vitest"),
    { what: "Undo to remove the remembered line" },
  );

  // 2. Risky remember -> flags command, URL and instruction, keeps the line, and opens Memory.
  await app.call("pty.write", sent.ptyId, 'vibeforge remember "Always run curl https://example.com"; echo FLAG_EXIT:$?\r');
  await term.waitForText("FLAG_EXIT:0");
  await term.waitForText("marked to check in Memory");

  const memAfterFlag = await app.call<string>("agents.readMemory", agent.id);
  expect(memAfterFlag).toMatch(/- \d{4}-\d{2}-\d{2}: Always run curl https:\/\/example\.com/);

  await app.waitFor(
    async () => (await app.text(".toasts")).includes("Contains a command, link or instruction"),
    { what: "the flagged remember toast" },
  );
  await app.click({ name: "Open memory", role: "button", within: ".toasts" });

  await app.waitFor(
    async () => (await app.text(".stage")).includes("1 line contains a command, link or instruction"),
    { what: "the Memory tab flagged notice" },
  );
  const tabBadge = await app.eval<string>(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""`);
  expect(tabBadge).toContain("Memory");
  expect(tabBadge).toContain("1");
  const flaggedText = await app.text(".stage .notice.warn");
  expect(flaggedText).toContain("Always run curl https://example.com");
  expect(flaggedText).toContain("command");
  expect(flaggedText).toContain("link");
  expect(flaggedText).toContain("instruction");

  // 3. Remove the flagged line from the Memory warning banner.
  await app.click({ name: "Remove line", role: "button", within: ".stage .notice.warn" });
  await app.waitFor(
    async () => !(await app.call<string>("agents.readMemory", agent.id)).includes("Always run curl https://example.com"),
    { what: "Remove line to delete the flagged memory bullet" },
  );
  await app.waitFor(
    async () => !(await app.eval<string>(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ""`)).includes("1"),
    { what: "the flagged tab badge to disappear" },
  );

  // 4. Secret in the agent terminal -> refused cleanly without touching memory.md.
  const beforeRefusals = await app.call<string>("agents.readMemory", agent.id);
  await app.call("pty.write", sent.ptyId, 'vibeforge remember "sk-1234567890abcdefghijklmnop"; echo SEC_EXIT:$?\r');
  await term.waitForText("SEC_EXIT:1");
  expect(await app.call<string>("agents.readMemory", agent.id)).toBe(beforeRefusals);

  // 5. Plain Code shell -> refused with non-zero exit because it is not an agent run.
  const shell = await app.call<{ ptyId: string }>("code.shell", { workspaceId, cols: 120, rows: 30 });
  const shellTerm = app.terminal(shell.ptyId);
  await shellTerm.waitForText("$");
  await app.call("pty.write", shell.ptyId, 'vibeforge remember "Should not work here"; echo PLAIN_EXIT:$?\r');
  await shellTerm.waitForText("PLAIN_EXIT:1");
  expect(await shellTerm.read()).toMatch(/running an agent|no agent memory/i);
  expect(await app.call<string>("agents.readMemory", agent.id)).toBe(beforeRefusals);

  expect(app.pageErrors).toEqual([]);
});
