import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setup, tempDir } from "./fixtures/service-harness.js";

// Send to…: a CLI's last answer or its changes into another pane, as a draft for a person to send
// (a selection is in agent-talk.test.ts).

const AT = Date.parse("2026-10-20T09:00:00Z");

function gitRepo(): string {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  return repo;
}

/** Argy and Pasty, and Codex: a CLI whose log VibeForge reads. */
async function clis(folder?: string) {
  let at = AT;
  const ctx = setup({ now: () => new Date(at) });
  const rows = JSON.parse(fs.readFileSync(path.join(ctx.configRoot, "engines.json"), "utf8"));
  rows.engines.push({ id: "codex", label: "Codex", bin: "argy", args: [] });
  fs.writeFileSync(path.join(ctx.configRoot, "engines.json"), JSON.stringify(rows));
  const workspace = ctx.svc.addWorkspace(folder ?? ctx.place).workspaces[0];
  const a = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
  const b = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  const codex = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "codex" });
  // What was there when they started is read as they start, before a real CLI could change anything.
  await Promise.all([...ctx.svc.dirtyAtStart.values()]);
  at += 5000;
  return { ctx, a: a.ptyId, b: b.ptyId, codex: codex.ptyId };
}

describe("send to…", () => {
  it("sends a CLI's last answer: from its log when VibeForge reads it, else the end of its screen", async () => {
    const { ctx, a, b, codex } = await clis();
    ctx.host.screen = async (ptyId) => (ptyId === a ? "argy> what is it?\n\nIt is 42.\n\nargy>   \n\n" : "codex> Read off the screen.\n");
    const asked: string[] = [];
    let logged: string | null = "From the log.\x1b[0m";
    ctx.host.lastReply = async (opts) => {
      asked.push(opts.kind);
      return logged;
    };
    expect(await ctx.svc.sendDraft({ fromPty: codex, toPty: b, what: "reply" })).toEqual({ sent: true });
    expect(ctx.sent.at(-1)).toEqual({ ptyId: b, text: "From Codex:\nFrom the log.[0m", enter: false });
    // Nothing in its log: the end of its screen.
    logged = "  ";
    await ctx.svc.sendDraft({ fromPty: codex, toPty: b, what: "reply" });
    expect(ctx.sent.at(-1)).toEqual({ ptyId: b, text: "From Codex:\ncodex> Read off the screen.", enter: false });
    // A CLI whose log VibeForge doesn't read: its screen, without asking for a log.
    await ctx.svc.sendDraft({ fromPty: a, toPty: b, what: "reply" });
    expect(ctx.sent.at(-1)).toEqual({ ptyId: b, text: "From Argy:\nargy> what is it?\n\nIt is 42.\n\nargy>", enter: false });
    expect(asked).toEqual(["codex", "codex"]);
    ctx.svc.close();
  });

  it("sends a CLI's changes as a saved patch, and won't send to a CLI that isn't there", async () => {
    const repo = gitRepo();
    const { ctx, a, b } = await clis(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    expect(await ctx.svc.sendDraft({ fromPty: a, toPty: b, what: "changes" })).toEqual({ sent: true });
    const patch = /^From Argy:\nMy changes are in (\S+?\.patch) \(a\.txt\)\.$/.exec(ctx.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect(fs.readFileSync(patch, "utf8")).toContain("+two");
    await expect(ctx.svc.sendDraft({ fromPty: a, toPty: "pty-gone", what: "reply" })).rejects.toThrow("That CLI isn't running any more.");
    ctx.svc.close();
  });
});
