import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BURST_MS, Chimes, chimeVersion } from "../../electron/chimes.js";
import { CUES, PEAK, SHAPES, cueLength, isCue, renderCue, wavBytes } from "../../src/shared/chimes.js";

/** Enough of a child process for Chimes: it starts (or fails) on the next tick and exits when told. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new EventEmitter();
  killed: string[] = [];
  constructor(fail?: Error) {
    super();
    setImmediate(() => (fail ? this.emit("error", fail) : this.emit("spawn")));
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
  finish(code = 0, stderr = "") {
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

describe("rendering chimes", () => {
  it("knows its cues", () => {
    expect(CUES).toEqual(Object.keys(SHAPES));
    expect(isCue("finished")).toBe(true);
    expect(isCue("nope")).toBe(false);
    expect(isCue(3)).toBe(false);
  });

  it("renders each cue at its length, never louder than the peak allows, silent at the end", () => {
    for (const name of CUES) {
      const samples = renderCue(name, 8000);
      expect(samples.length).toBe(Math.ceil(cueLength(name) * 8000));
      let loudest = 0;
      for (const value of samples) loudest = Math.max(loudest, Math.abs(value));
      expect(loudest).toBeGreaterThan(PEAK * 0.3);
      expect(loudest).toBeLessThanOrEqual(PEAK * SHAPES[name].length + 1e-6);
      expect(Math.abs(samples[samples.length - 1])).toBeLessThan(0.001);
      expect(Math.abs(samples[0])).toBeLessThan(0.001);
    }
  });

  it("glides a note's pitch, and a triangle note sounds different from a sine one", () => {
    const zeroCrossings = (samples: Float32Array, from: number, to: number) => {
      let count = 0;
      for (let i = from + 1; i < to; i += 1) if (Math.sign(samples[i]) !== Math.sign(samples[i - 1])) count += 1;
      return count;
    };
    // voiceCancel glides 294 Hz down to 247 Hz.
    const cancel = renderCue("voiceCancel", 48_000);
    const early = zeroCrossings(cancel, 400, 1360);
    const late = zeroCrossings(cancel, 4000, 4960);
    expect(early).toBeGreaterThan(late);
  });

  it("writes a 16-bit mono WAV file", () => {
    const bytes = wavBytes(new Float32Array([0, 1, -1, 2]), 48_000);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(bytes.length).toBe(52);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32767, 32767]);
  });
});

describe("playing chimes through pw-play", () => {
  let dir: string;
  let clock: number;
  let spawned: Array<{ bin: string; args: string[]; child: FakeChild }>;
  let logged: string[];
  let failNext: Error | null;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-chimes-")), "chimes");
    clock = 1000;
    spawned = [];
    logged = [];
    failNext = null;
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  function chimes(bin: string | null = "/usr/bin/pw-play") {
    return new Chimes({
      dir,
      resolveBin: (name) => (name === "pw-play" ? bin : null),
      log: { info: (message) => logged.push(message), warn: (message) => logged.push(`warn: ${message}`) },
      now: () => clock,
      spawn: (command, args) => {
        const child = new FakeChild(failNext ?? undefined);
        failNext = null;
        spawned.push({ bin: command, args, child });
        return child as unknown as ChildProcess;
      },
    });
  }

  it("renders every chime once, owner-only, and plays the one asked for at its volume", async () => {
    const player = chimes();
    expect(await player.play("finished", 0.6)).toBe(true);
    expect(spawned).toHaveLength(1);
    const { bin, args } = spawned[0];
    expect(bin).toBe("/usr/bin/pw-play");
    expect(args).toEqual(expect.arrayContaining(["--volume", "0.600", "--latency", "20ms", "--media-role", "Notification"]));
    const file = args.at(-1) as string;
    expect(file).toBe(path.join(dir, `finished-${chimeVersion()}.wav`));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(CUES.map((name) => `${name}-${chimeVersion()}.wav`).sort());
    for (const name of files) expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).size).toBe(44 + 2 * Math.ceil(cueLength("finished") * 48_000));
    expect(logged).toEqual(["Sounds: chimes play through pw-play"]);
  });

  it("keeps rendered files, rewrites a cut-short or open one, and removes an older version's", async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const finished = path.join(dir, `finished-${chimeVersion()}.wav`);
    const routine = path.join(dir, `routine-${chimeVersion()}.wav`);
    fs.writeFileSync(finished, "short", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "finished-old.wav"), "old");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    const first = chimes();
    await first.play("routine", 1);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(finished).size).toBeGreaterThan(5);
    expect(fs.existsSync(path.join(dir, "finished-old.wav"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
    const routineTime = fs.statSync(routine).mtimeMs;
    fs.chmodSync(finished, 0o644);
    const second = chimes();
    await second.play("routine", 1);
    expect(fs.statSync(routine).mtimeMs).toBe(routineTime);
    expect(fs.statSync(finished).mode & 0o777).toBe(0o600);
  });

  it("starts one pw-play for a burst of chimes, and a later chime plays beside one still ringing", async () => {
    const player = chimes();
    expect(await player.play("attention", 0.5)).toBe(true);
    clock += 50;
    expect(await player.play("finished", 0.5)).toBe(true);
    clock += 50;
    expect(await player.play("routine", 0.5)).toBe(true);
    expect(spawned).toHaveLength(1);
    clock += BURST_MS;
    expect(await player.play("voiceStart", 0.5)).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].child.killed).toEqual([]);
    spawned[0].child.finish(0);
    spawned[1].child.finish(0);
    clock += BURST_MS;
    expect(await player.play("voiceStop", 0.5)).toBe(true);
    expect(spawned).toHaveLength(3);
    expect(logged.filter((line) => line.startsWith("warn"))).toEqual([]);
  });

  it("says the window should play it when there is no pw-play, the cue is unknown, or the volume is off", async () => {
    expect(await chimes(null).play("finished", 0.6)).toBe(false);
    const player = chimes();
    expect(player.available).toBe(true);
    expect(await player.play("bogus", 0.6)).toBe(false);
    expect(await player.play("finished", 0)).toBe(true);
    expect(await player.play("finished", Number.NaN)).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(await player.play("finished", 4)).toBe(true);
    expect(spawned[0].args).toContain("1.000");
  });

  it("hands chimes back to the window once pw-play can't start, or PipeWire isn't running", async () => {
    const missing = chimes();
    failNext = Object.assign(new Error("spawn pw-play ENOENT"), { code: "ENOENT" });
    expect(await missing.play("finished", 0.6)).toBe(false);
    expect(await missing.play("finished", 0.6)).toBe(false);
    expect(spawned).toHaveLength(1);

    const noServer = chimes();
    expect(await noServer.play("routine", 0.6)).toBe(true);
    spawned[1].child.finish(1, "pw-play: can't connect: Host is down\n");
    expect(noServer.available).toBe(false);
    expect(await noServer.play("routine", 0.6)).toBe(false);
    expect(logged.filter((line) => line.startsWith("warn"))).toEqual([
      "warn: Sounds: pw-play failed to start: spawn pw-play ENOENT; the window plays chimes itself from now on",
      "warn: Sounds: pw-play exited with code 1: pw-play: can't connect: Host is down; the window plays chimes itself from now on",
    ]);
  });

  it("hands chimes back when the folder can't be written", async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, "a file where the folder goes");
    const player = chimes();
    expect(await player.play("finished", 0.6)).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(logged[0]).toMatch(/^warn: Sounds: could not write the chimes/);
  });

  it("stops chimes still playing at quit, and pw-play's exit code then is no failure", async () => {
    const player = chimes();
    await player.play("finished", 0.6);
    clock += BURST_MS;
    await player.play("failed", 0.6);
    spawned[0].child.finish(0);
    // pw-play catches SIGTERM and exits 1 rather than by the signal.
    spawned[1].child.kill = function (this: FakeChild, signal: NodeJS.Signals = "SIGTERM") {
      this.killed.push(signal);
      this.finish(1);
      return true;
    };
    player.dispose();
    expect(spawned[0].child.killed).toEqual([]);
    expect(spawned[1].child.killed).toEqual(["SIGTERM"]);
    player.dispose();
    expect(spawned[1].child.killed).toEqual(["SIGTERM"]);
    expect(player.available).toBe(true);
  });

  it("stops a pw-play that runs far past its chime", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const player = chimes();
      await player.play("routine", 0.6);
      vi.advanceTimersByTime(cueLength("routine") * 1000 + 5000);
      expect(spawned[0].child.killed).toEqual(["SIGTERM"]);
      expect(player.available).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
