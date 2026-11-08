import { describe, expect, it } from "vitest";
import { oneAtATime } from "../../electron/guards.js";

describe("the quit question", () => {
  it("is asked once while it is on screen; a second close or Quit gets the same answer", async () => {
    const asked: number[] = [];
    let answer: (yes: boolean) => void = () => undefined;
    const ask = oneAtATime((live: number) => {
      asked.push(live);
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    const first = ask(2);
    const second = ask(3);
    expect(second).toBe(first);
    expect(asked).toEqual([2]);
    answer(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it("is asked again once answered, and after an error", async () => {
    let calls = 0;
    const ask = oneAtATime(async () => {
      calls += 1;
      if (calls === 2) throw new Error("no dialog");
      return calls === 1;
    });
    expect(await ask()).toBe(true);
    await expect(ask()).rejects.toThrow("no dialog");
    expect(await ask()).toBe(false);
    expect(calls).toBe(3);
  });
});
