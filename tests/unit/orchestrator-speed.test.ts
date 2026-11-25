import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Segmenter } from "../../src/core/call.js";
import { brainArgs } from "../../src/core/orchestrator.js";
import { spawnBrain } from "../../src/core/service/orchestrator.js";
import { claudeStreamArgs, claudeStreamUserLine, PlannerSessionPool } from "../../src/core/service/planner-session.js";
import type { SpeechDetector } from "../../src/core/vad.js";
import { BYTES_PER_SECOND, trimSilence } from "../../src/core/voice.js";
import { setup, tempDir, until } from "./fixtures/service-harness.js";

const { Speaker } = await import("../../electron/speech.js");

const silence = (seconds: number) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
function tone(seconds: number, amplitude = 0.5): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * amplitude * 32_767), i * 2);
  return pcm;
}

describe("Viby speed: audio silence trimming and fast command endpointing", () => {
  it("trims leading and trailing silence while keeping padding and leaving short clips intact", () => {
    const padded = Buffer.concat([silence(1.0), tone(0.5), silence(1.0)]);
    const trimmed = trimSilence(padded, 160);
    expect(trimmed.length).toBeLessThan(padded.length * 0.5);
    expect(trimmed.length).toBeGreaterThan(0.5 * BYTES_PER_SECOND);

    const short = Buffer.concat([silence(0.2), tone(0.3), silence(0.2)]);
    expect(trimSilence(short).length).toBe(short.length);

    const silentAll = silence(1.2);
    expect(trimSilence(silentAll).length).toBe(silentAll.length);
    expect(trimSilence(Buffer.alloc(32001)).length).toBe(32000);
  });

  it("endpoints crisp short voice commands after deep silence faster than long clauses", () => {
    const detector: SpeechDetector = {
      probability: (frame: Float32Array) => (frame.some((s) => Math.abs(s) > 0.01) ? 0.95 : 0.02),
      reset: () => undefined,
    } as unknown as SpeechDetector;

    const seg = new Segmenter({ detector });
    seg.push(tone(0.6));
    // First trailing frame overlaps tone tail -> total deep quiet <= 544 ms (< 580 ms): stays open.
    const partial = seg.push(silence(0.55));
    expect(partial.utterances).toHaveLength(0);
    // +96 ms crosses 580 ms crisp-command threshold before 700 ms standard silence window.
    const ended = seg.push(silence(0.096));
    expect(ended.utterances).toHaveLength(1);
  });
});

describe("Viby speed: warm planner sessions, early-say streaming, and lookahead TTS", () => {
  it("reuses one warm stream-json process across multiple turns and streams early say before exit", async () => {
    const dir = tempDir();
    const pidLog = path.join(dir, "pids.log");
    const script = path.join(dir, "fake-claude.cjs");
    fs.writeFileSync(
      script,
      `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content.find((c) => c.type === "text").text;
  const reply = "Heard: " + text;
  process.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { partial_json: '{\\"say\\":' + JSON.stringify(reply) + ',"st' } } }) + "\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", session_id: "s-warm", structured_output: { say: reply, steps: [] } }) + "\\n");
  }, 20);
});
`,
      { mode: 0o755 },
    );

    const row = { id: "claude", label: "Claude Code", bin: script, args: [] };
    const args = claudeStreamArgs(row, { text: "", rules: "RULES", sessionId: "s1", resume: false });
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages"]));
    expect(JSON.parse(claudeStreamUserLine("hi").trim())).toMatchObject({ type: "user", message: { role: "user" } });

    const pool = new PlannerSessionPool(10_000);
    const early: string[] = [];
    const r1 = await pool.runTurn({
      binPath: script,
      row,
      opts: { text: "turn one", rules: "RULES", sessionId: "s1", resume: false },
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      onEarlySay: (s) => early.push(s),
    });
    const firstPid = pool.activePid;
    expect(firstPid).not.toBeNull();
    expect(early).toEqual(["Heard: turn one"]);
    expect(r1?.code).toBe(0);

    const r2 = await pool.runTurn({
      binPath: script,
      row,
      opts: { text: "turn two", rules: "RULES", sessionId: "s1", resume: false },
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      onEarlySay: (s) => early.push(s),
    });
    expect(r2?.code).toBe(0);
    expect(pool.activePid).toBe(firstPid);
    expect(early).toEqual(["Heard: turn one", "Heard: turn two"]);
    expect(fs.readFileSync(pidLog, "utf8").trim().split("\n")).toHaveLength(1);

    // spawnBrain also surfaces onEarlySay when streaming progressively
    const streamBin = path.join(dir, "stream-say.sh");
    fs.writeFileSync(
      streamBin,
      `#!/bin/bash\nprintf '{"say":"Early hi.",'\nsleep 0.03\nprintf '"steps":[]}\\n'\n`,
      { mode: 0o755 },
    );
    const seenEarly: string[] = [];
    const spawned = await spawnBrain([streamBin], dir, new AbortController().signal, 5000, 500, undefined, (s) => seenEarly.push(s));
    expect(spawned.code).toBe(0);
    expect(seenEarly).toEqual(["Early hi."]);

    pool.dispose();
    expect(pool.activePid).toBeNull();
    expect(brainArgs({ id: "kimi", label: "Kimi", bin: "kimi", args: [] }, { text: "", rules: "", sessionId: "", resume: false })).toBeNull();
    expect(claudeStreamArgs({ id: "grok", label: "Grok", bin: "grok", args: [] }, { text: "", rules: "", sessionId: "", resume: false })).toBeNull();
  });

  it("caches voice rates and prefetches sentence chunk N+1 while chunk N plays", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-prefetch-"));
    const voiceFile = path.join(dir, "voice.onnx");
    const rateReads = path.join(dir, "piper-calls.log");
    const playLog = path.join(dir, "play.log");
    fs.writeFileSync(voiceFile, "onnx");
    fs.writeFileSync(`${voiceFile}.json`, JSON.stringify({ audio: { sample_rate: 16000 } }));

    const fakePiper = path.join(dir, "piper");
    fs.writeFileSync(
      fakePiper,
      `#!${process.execPath}
const fs = require("node:fs");
let text = "";
process.stdin.on("data", (d) => { text += d.toString(); });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(rateReads)}, text.trim() + "\\n");
  process.stdout.write(Buffer.alloc(320));
});
`,
      { mode: 0o755 },
    );
    const prevPiper = process.env.VIBEFORGE_PIPER;
    const prevPlayer = process.env.VIBEFORGE_VOICE_PLAYER;
    process.env.VIBEFORGE_PIPER = fakePiper;
    process.env.VIBEFORGE_VOICE_PLAYER = `cat > /dev/null; echo "$RATE" >> ${JSON.stringify(playLog)}; sleep 0.04`;
    const spokenEvents: Array<string | null> = [];
    const speaker = new Speaker({
      log: { info: () => undefined, warn: () => undefined } as never,
      resolveBin: (bin) => (bin === fakePiper ? fakePiper : null),
      speaking: (text) => void spokenEvents.push(text),
    });
    const c1 =
      "First detailed update sentence with plenty of extra helpful context about the build status and all unit tests passing cleanly right now in the workspace.";
    const c2 =
      "Second detailed update sentence with plenty of extra helpful context about the workspace copy and isolated branch creation ready for careful engineering review.";
    const c3 =
      "Third detailed update sentence with plenty of extra helpful context about next action items and verification test results available for the team right now.";
    try {
      await speaker.speak(`${c1} ${c2} ${c3}`, voiceFile);
      expect(spokenEvents).toEqual([c1, c2, c3, null]);
      // Chunk N+1 is synthesized while chunk N plays, so the first two can reach Piper in either order.
      expect(fs.readFileSync(rateReads, "utf8").trim().split("\n").sort()).toEqual([c1, c2, c3].sort());
      expect(fs.readFileSync(playLog, "utf8").trim().split("\n")).toEqual(["16000", "16000", "16000"]);
      // Second utterance reuses cached sample rate from memory even if the sidecar json is gone.
      fs.rmSync(`${voiceFile}.json`);
      await speaker.speak("Short cached follow up.", voiceFile);
      expect(fs.readFileSync(playLog, "utf8").trim().split("\n")).toEqual(["16000", "16000", "16000", "16000"]);
      // Barge-in stop mid-utterance drops the prefetched chunk cleanly and resolves.
      const interrupted = speaker.speak(`${c1} ${c2}`, voiceFile);
      await new Promise((r) => setTimeout(r, 15));
      speaker.stop();
      await interrupted;
    } finally {
      speaker.dispose();
      if (prevPiper === undefined) delete process.env.VIBEFORGE_PIPER;
      else process.env.VIBEFORGE_PIPER = prevPiper;
      if (prevPlayer === undefined) delete process.env.VIBEFORGE_VOICE_PLAYER;
      else process.env.VIBEFORGE_VOICE_PLAYER = prevPlayer;
    }
  });

  it("executes multiple independent start steps in parallel within one wave", async () => {
    const repoA = path.join(tempDir(), "repo-a");
    const repoB = path.join(tempDir(), "repo-b");
    for (const r of [repoA, repoB]) {
      fs.mkdirSync(r, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: r });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: r });
    }
    const ctx = setup();
    const file = path.join(ctx.configRoot, "engines.json");
    const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
    engines.engines.push({ id: "grok", label: "Grok Build", bin: "argy", args: [] });
    fs.writeFileSync(file, JSON.stringify(engines));
    ctx.svc.saveSettings({ orchestrator: { engine: "grok", mode: "go", model: "", projectsFolder: "" } });

    ctx.svc.addWorkspace(repoA);
    ctx.svc.addWorkspace(repoB);

    let inFlight = 0;
    let peakInFlight = 0;
    const origSpawn = ctx.host.spawn;
    ctx.host.spawn = async (req) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      try {
        return await origSpawn(req);
      } finally {
        inFlight -= 1;
      }
    };

    ctx.svc.orchestrator.runner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        structuredOutput: {
          say: "Starting both.",
          steps: [
            { kind: "start", engine: "argy", workspace: "repo-a", branch: "feat-a", prompt: "do a" },
            { kind: "start", engine: "argy", workspace: "repo-b", branch: "feat-b", prompt: "do b" },
          ],
        },
      }),
      stderr: "",
      timedOut: false,
    });

    await ctx.svc.orchestratorAsk("start both");
    await until(() => ctx.svc.orchestratorView().turns.at(-1)?.plan === "done");
    expect(peakInFlight).toBe(2);
    expect(ctx.spawns).toHaveLength(2);
    ctx.svc.close();
  });
});
