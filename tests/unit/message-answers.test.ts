import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTLE_MS } from "../../src/core/agent-talk.js";
import { setup } from "./fixtures/service-harness.js";

// Waiting for an answer with `tell --wait`: the cases agent-talk.test.ts doesn't reach.

const AT = Date.parse("2026-10-20T09:00:00Z");

/** Argy and Pasty, and Codex: a CLI whose log VibeForge reads, its answers handed out by `answer`. */
async function clis() {
  let at = AT;
  const ctx = setup({ now: () => new Date(at) });
  const rows = JSON.parse(fs.readFileSync(path.join(ctx.configRoot, "engines.json"), "utf8"));
  rows.engines.push({ id: "codex", label: "Codex", bin: "argy", args: [] });
  fs.writeFileSync(path.join(ctx.configRoot, "engines.json"), JSON.stringify(rows));
  const answers: Array<(reply: string) => void> = [];
  ctx.host.watchReply = () => new Promise((resolve) => answers.push(resolve));
  const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
  const a = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
  const b = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "codex" });
  const pass = (ms: number) => (at += ms);
  pass(5000);
  return { ctx, pass, a: a.ptyId, b: b.ptyId, answer: (reply: string) => answers.at(-1)!(reply) };
}

describe("waiting for an answer", () => {
  it("forwards a late answer cleaned, and saves it in a file only when it's long once cleaned", async () => {
    const { ctx, pass, a, answer } = await clis();
    /** Asks Codex, stops waiting, and returns the message its late answer `reply` becomes. */
    const late = async (reply: string) => {
      const asked = ctx.svc.tell({ fromPty: a, to: "codex", text: "Review it", wait: true, timeoutMs: 1000 });
      await ctx.svc.pumpMessages();
      pass(2000);
      await ctx.svc.pumpMessages();
      expect(await asked).toMatchObject({ ok: true, timedOut: true });
      answer(reply);
      await new Promise((resolve) => setTimeout(resolve, 0));
      pass(4000);
      await ctx.svc.pumpMessages();
      const sent = ctx.sent.at(-1)!;
      expect(sent.ptyId).toBe(a);
      pass(4000);
      return sent.text;
    };
    // Long only for the terminal's own bytes in it: it goes in as it is.
    const short = `${"\x07".repeat(300)}Looks fine. ${"a".repeat(7900)}`;
    expect(await late(short)).toContain(`[Message from Codex, sent through VibeForge]\nLooks fine. ${"a".repeat(7900)}`);
    // Long once cleaned: in a file, cleaned too.
    const long = `\x07${"word ".repeat(2000)}`;
    const saved = /saved at (\S+)\. Read it first\./.exec(await late(long))?.[1] ?? "";
    expect(fs.readFileSync(saved, "utf8")).toBe(`${"word ".repeat(2000).trim()}\n`);
    ctx.svc.close();
  });

  it("lets go of the sender's signal once the answer is in", async () => {
    const { ctx, pass, a, b } = await clis();
    ctx.host.screen = async () => "pasty> [Message from Argy]\n\nThe answer is 42.\n\npasty> ";
    const gone = new AbortController();
    const asked = ctx.svc.tell({ fromPty: a, to: "pasty", text: "What is it?", wait: true, gone: gone.signal });
    await ctx.svc.pumpMessages();
    expect(getEventListeners(gone.signal, "abort")).toHaveLength(1);
    ctx.svc.onPtyActivity(b, true);
    pass(2000);
    ctx.svc.onPtyActivity(b, false);
    pass(SETTLE_MS + 100);
    await ctx.svc.pumpMessages();
    expect(await asked).toMatchObject({ ok: true, reply: expect.stringContaining("The answer is 42.") });
    expect(getEventListeners(gone.signal, "abort")).toHaveLength(0);
    ctx.svc.close();
  });
});
