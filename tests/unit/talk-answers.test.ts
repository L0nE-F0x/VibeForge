import { describe, expectTypeOf, it } from "vitest";
import type { TalkAnswers, TalkRefusal } from "../../src/core/control.js";
import type { TaskResult, TellResult, WhoResult } from "../../src/core/service/messages.js";
import type { TeamService } from "../../src/core/team-service.js";

// scripts/talk.mjs (`vibeforge tell|who|task|apply`) reads the window's answers as TalkAnswers.
// These hold that type to what the service hands the control socket, so the two can't drift
// apart; they fail in `npm run typecheck`, not at run time.
describe("the answers vibeforge tell|who|task|apply read", () => {
  it("are what the team service returns", () => {
    // `who` gets ok: true added in electron/main.ts; a window still starting refuses any request.
    expectTypeOf<({ ok: true } & WhoResult) | TalkRefusal>().toExtend<TalkAnswers["who"]>();
    expectTypeOf<TellResult>().toExtend<TalkAnswers["tell"]>();
    expectTypeOf<TaskResult>().toExtend<TalkAnswers["task"]>();
    expectTypeOf<Awaited<ReturnType<TeamService["applyHandedTask"]>>>().toExtend<TalkAnswers["apply"]>();
  });
});
