import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("../../src/ui/api.js", () => ({ call: (...args: unknown[]) => call(...args) }));

/** Counts the Web Audio outputs the window makes: each one starts Chromium's audio service. */
let made = 0;
class FakeAudioContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  constructor() {
    made += 1;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (to: unknown) => to, disconnect() {} };
  }
  createOscillator() {
    return { type: "sine", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (to: unknown) => to, start() {}, stop() {} };
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("where a chime plays", () => {
  beforeEach(() => {
    vi.resetModules();
    call.mockReset();
    made = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  it("asks the main process, and makes no Web Audio output when it played the chime", async () => {
    call.mockResolvedValue(true);
    const { previewCue } = await import("../../src/ui/sounds.js");
    previewCue("finished", 0.6);
    previewCue("voiceStart", 0.3);
    await settle();
    expect(call.mock.calls).toEqual([
      ["app.chime", "finished", 0.6],
      ["app.chime", "voiceStart", 0.3],
    ]);
    expect(made).toBe(0);
  });

  it("plays it here when the main process can't, and stops asking", async () => {
    call.mockResolvedValue(false);
    const { previewCue } = await import("../../src/ui/sounds.js");
    previewCue("finished", 0.6);
    await settle();
    expect(made).toBe(1);
    previewCue("routine", 0.6);
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("plays it here when the call itself fails", async () => {
    call.mockRejectedValue(new Error("Unknown call app.chime"));
    const { previewCue } = await import("../../src/ui/sounds.js");
    previewCue("attention", 1);
    await settle();
    expect(made).toBe(1);
  });

  it("plays nothing at volume 0", async () => {
    const { previewCue } = await import("../../src/ui/sounds.js");
    previewCue("finished", 0);
    await settle();
    expect(call).not.toHaveBeenCalled();
    expect(made).toBe(0);
  });

  it("follows the sound settings: off plays nothing, a voice cue goes to the main process", async () => {
    call.mockResolvedValue(true);
    const { cue, setSoundSettings } = await import("../../src/ui/sounds.js");
    setSoundSettings({ on: false, volume: 0.6, voice: true, attention: true, finished: true, routines: true, inFront: true });
    cue("voiceStart");
    setSoundSettings({ on: true, volume: 0.6, voice: false, attention: true, finished: true, routines: true, inFront: true });
    cue("voiceStart");
    await settle();
    expect(call).not.toHaveBeenCalled();
    setSoundSettings({ on: true, volume: 0.3, voice: true, attention: true, finished: true, routines: true, inFront: true });
    cue("voiceStart");
    await settle();
    expect(call.mock.calls).toEqual([["app.chime", "voiceStart", 0.3]]);
  });
});
