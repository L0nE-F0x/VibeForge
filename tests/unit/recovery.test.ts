import { describe, expect, it } from "vitest";
import { PAGE_RELOADS, PageRecovery } from "../../electron/page-recovery.js";
import { UNEXPECTED_NOTICE_MS, UnexpectedErrors } from "../../electron/unexpected.js";
import type { DeskNotice } from "../../src/shared/api.js";

describe("a window whose page stops", () => {
  it("is reloaded up to three times in five minutes, then the person is asked", () => {
    const recovery = new PageRecovery();
    expect(PAGE_RELOADS).toBe(3);
    expect(recovery.gone("crashed", 0)).toBe("reload");
    expect(recovery.gone("oom", 60_000)).toBe("reload");
    expect(recovery.gone("killed", 120_000)).toBe("reload");
    expect(recovery.gone("crashed", 180_000)).toBe("ask");
    // Five minutes after the first, it has room again.
    expect(recovery.gone("crashed", 400_000)).toBe("reload");
  });

  it("is left alone when it closed normally", () => {
    const recovery = new PageRecovery();
    for (let time = 0; time < 10; time += 1) expect(recovery.gone("clean-exit", time)).toBe("ignore");
    expect(recovery.gone("crashed", 10)).toBe("reload");
  });
});

describe("errors nothing handled", () => {
  it("are counted, and told at most once in ten minutes with the count so far", () => {
    let now = 0;
    const errors = new UnexpectedErrors(() => now);
    const told: DeskNotice[] = [];
    errors.attach((notice) => told.push(notice));
    errors.add();
    errors.add();
    now = UNEXPECTED_NOTICE_MS - 1;
    errors.add();
    expect(errors.count).toBe(3);
    expect(told).toEqual([{ id: "errors", count: 1 }]);
    now = UNEXPECTED_NOTICE_MS;
    errors.add();
    expect(told).toEqual([
      { id: "errors", count: 1 },
      { id: "errors", count: 4 },
    ]);
  });

  it("that came before anyone could be told are told once someone can", () => {
    const errors = new UnexpectedErrors(() => 0);
    errors.add();
    const told: DeskNotice[] = [];
    errors.attach((notice) => told.push(notice));
    expect(told).toEqual([{ id: "errors", count: 1 }]);
  });
});
