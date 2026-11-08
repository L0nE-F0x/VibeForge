import { describe, expect, it } from "vitest";
import { setup } from "./fixtures/service-harness.js";

// Review with…: starting one, and the ways one ends besides its last round (see agent-talk.test.ts for the rounds).

const AT = Date.parse("2026-10-20T09:00:00Z");

async function threeClis() {
  let at = AT;
  const ctx = setup({ now: () => new Date(at) });
  const workspace = ctx.svc.addWorkspace(ctx.place).workspaces[0];
  const author = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });
  const reviewer = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  const third = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "pasty" });
  at += 10_000;
  const review = (ptyId: string) => ctx.svc.liveForView().find((item) => item.ptyId === ptyId)?.talk?.review ?? null;
  return { ctx, author: author.ptyId, reviewer: reviewer.ptyId, third: third.ptyId, review };
}

describe("review with…", () => {
  it("needs two different CLIs that are running", async () => {
    const { ctx, author } = await threeClis();
    await expect(ctx.svc.startReview(author, author)).rejects.toThrow("Pick another CLI to review the changes.");
    await expect(ctx.svc.startReview(author, "pty-gone")).rejects.toThrow("That CLI isn't running any more.");
    expect(ctx.svc.liveForView().every((item) => item.talk === null)).toBe(true);
    ctx.svc.close();
  });

  it("is replaced by the author's next one, and ends on Stop or once a CLI in it is gone", async () => {
    const { ctx, author, reviewer, third, review } = await threeClis();
    await ctx.svc.startReview(author, reviewer);
    expect(review(reviewer)).toMatchObject({ role: "reviewer", phase: "author", round: 1 });
    // Asked again with another reviewer: one review per author.
    await ctx.svc.startReview(author, third);
    expect(review(reviewer)).toBeNull();
    expect(review(third)).toMatchObject({ role: "reviewer" });
    // Stop on the reviewer ends it.
    ctx.svc.stopTalk(third);
    expect(review(author)).toBeNull();
    // A reviewer that quits ends it at the next look.
    await ctx.svc.startReview(author, reviewer);
    expect(review(author)).toMatchObject({ role: "author" });
    await ctx.exit(reviewer);
    await ctx.svc.pumpMessages();
    expect(review(author)).toBeNull();
    ctx.svc.close();
  });
});
