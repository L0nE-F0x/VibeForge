import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_AFTER_MS, SoundOutput } from "../../src/ui/sounds.js";

/** Enough of an AudioContext to follow its state. It starts suspended, and resume and suspend land a moment later, as in Chromium. */
class FakeContext {
  state: AudioContextState = "suspended";
  readonly calls: string[] = [];
  resume() {
    this.calls.push("resume");
    return new Promise<void>((done) =>
      setTimeout(() => {
        if (this.state !== "closed") this.state = "running";
        done();
      }, 20),
    );
  }
  suspend() {
    this.calls.push("suspend");
    return new Promise<void>((done) =>
      setTimeout(() => {
        if (this.state !== "closed") this.state = "suspended";
        done();
      }, 10),
    );
  }
  close() {
    this.calls.push("close");
    this.state = "closed";
    return Promise.resolve();
  }
}

function output() {
  const made: FakeContext[] = [];
  const sound = new SoundOutput(() => {
    const context = new FakeContext();
    made.push(context);
    return context as unknown as AudioContext;
  });
  return { sound, made };
}

/** One chime of `ms`, the way play() schedules it. */
function chime(sound: SoundOutput, ms: number) {
  const ctx = sound.open();
  const done = vi.fn();
  sound.started(ms, done);
  return { ctx, done };
}

describe("the sound output", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suspends when a chime has ended and closes after the idle time, so the audio service can stop", async () => {
    const { sound, made } = output();
    const { done } = chime(sound, 400);
    expect(made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(made[0].state).toBe("running");
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toHaveBeenCalledOnce();
    expect(made[0].calls).toContain("suspend");
    await vi.advanceTimersByTimeAsync(20);
    expect(made[0].state).toBe("suspended");
    expect(sound.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(CLOSE_AFTER_MS);
    expect(made[0].state).toBe("closed");
    expect(sound.isOpen).toBe(false);
  });

  it("makes a new output for the next chime after closing, and it plays in full", async () => {
    const { sound, made } = output();
    chime(sound, 300);
    await vi.advanceTimersByTimeAsync(400 + CLOSE_AFTER_MS);
    expect(made[0].state).toBe("closed");
    const { ctx, done } = chime(sound, 300);
    expect(made).toHaveLength(2);
    expect(ctx).toBe(made[1]);
    await vi.advanceTimersByTimeAsync(200);
    expect(made[1].state).toBe("running");
    expect(made[1].calls).not.toContain("suspend");
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toHaveBeenCalledOnce();
  });

  it("resumes a suspended output and keeps it open while chimes overlap", async () => {
    const { sound, made } = output();
    chime(sound, 300);
    await vi.advanceTimersByTimeAsync(400);
    expect(made[0].state).toBe("suspended");
    // Two chimes close together: the first ending doesn't suspend the second.
    chime(sound, 300);
    await vi.advanceTimersByTimeAsync(150);
    chime(sound, 300);
    expect(made[0].calls.filter((call) => call === "resume").length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(made[0].state).toBe("running");
    expect(made[0].calls.filter((call) => call === "suspend")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(made[0].calls.filter((call) => call === "suspend")).toHaveLength(2);
    expect(made).toHaveLength(1);
  });

  it("resumes even when a chime comes while the suspend is still landing", async () => {
    const { sound, made } = output();
    chime(sound, 300);
    await vi.advanceTimersByTimeAsync(325);
    // ended() has asked for a suspend; the state still reads "running".
    expect(made[0].calls.at(-1)).toBe("suspend");
    expect(made[0].state).toBe("running");
    const { done } = chime(sound, 300);
    expect(made[0].calls.at(-1)).toBe("resume");
    await vi.advanceTimersByTimeAsync(50);
    expect(made[0].state).toBe("running");
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toHaveBeenCalledOnce();
  });

  it("counts a chime's length from when the output runs, not from when it was asked for", async () => {
    /** A slow device: running only half a second after it is asked to. */
    class SlowContext extends FakeContext {
      override resume() {
        this.calls.push("resume");
        return new Promise<void>((done) =>
          setTimeout(() => {
            this.state = "running";
            done();
          }, 500),
        );
      }
    }
    let made: SlowContext | null = null;
    const sound = new SoundOutput(() => {
      made = new SlowContext();
      return made as unknown as AudioContext;
    });
    const { done } = chime(sound, 300);
    await vi.advanceTimersByTimeAsync(400);
    expect(done).not.toHaveBeenCalled();
    expect(made!.calls).not.toContain("suspend");
    await vi.advanceTimersByTimeAsync(450);
    expect(done).toHaveBeenCalledOnce();
  });

  it("gives no output, without throwing, where audio can't be made", () => {
    const sound = new SoundOutput(() => {
      throw new Error("no audio device");
    });
    expect(sound.open()).toBeNull();
    expect(sound.isOpen).toBe(false);
  });
});
