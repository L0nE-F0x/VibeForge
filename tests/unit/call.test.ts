import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerTo, callWord, echoes, phantom, quickNav, READ_START, Segmenter, speechBegan, spokenAnswer, spokenWord, waitingPlan } from "../../src/core/call.js";
import type { LogFile } from "../../src/core/log.js";
import type { SpeechDetector } from "../../src/core/vad.js";
import type { VoiceSettings } from "../../src/core/types.js";
import { BYTES_PER_SECOND, ECHO_SOURCE, echoCancelConf, rms } from "../../src/core/voice.js";
import type { CallState, OrchestratorTurn } from "../../src/shared/api.js";
import type { VibyWord } from "../../src/shared/orchestrator.js";
import { DEFAULT_DICTATE_KEYS } from "../../src/shared/dictation.js";

// Downloads go through Electron's network stack, which isn't here; nothing in these tests downloads.
vi.mock("electron", () => ({ net: {} }));

const { Call } = await import("../../electron/call.js");
const { Voice } = await import("../../electron/voice.js");
const { startEchoCancel } = await import("../../electron/echo.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await sleep(10);
  expect(done()).toBe(true);
};

const silence = (seconds: number) => Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
/** A loud tone: speech, as far as loudness goes. */
function tone(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND));
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 0.5 * 32_767), i * 2);
  return pcm;
}
const seconds = (pcm: Buffer) => pcm.length / BYTES_PER_SECOND;

describe("a call's microphone, cut into the things said", () => {
  it("hands over what was said once the speaker pauses, with the moment before it", () => {
    const segmenter = new Segmenter();
    expect(segmenter.push(silence(0.6)).utterances).toEqual([]);
    const during = segmenter.push(tone(1.2));
    expect(during.utterances).toEqual([]);
    expect(during.hearing).toBe(true);
    expect(during.level).toBeGreaterThan(0.8);
    const { utterances, hearing } = segmenter.push(silence(1.5));
    expect(hearing).toBe(false);
    expect(utterances).toHaveLength(1);
    const [said] = utterances;
    // The tone, a little of the quiet before it, and a short tail of the pause that ended it.
    expect(seconds(said)).toBeGreaterThan(1.6);
    expect(seconds(said)).toBeLessThan(2.0);
    expect(rms(said, 0, 9600)).toBe(0);
    expect(rms(said, 16_000, 32_000)).toBeGreaterThan(0.3);
  });

  it("hears the same in whatever sizes the recorder writes", () => {
    const audio = Buffer.concat([silence(0.5), tone(1), silence(1.2), tone(0.8), silence(1.2)]);
    const whole = new Segmenter().push(audio).utterances;
    const pieces: Buffer[] = [];
    const segmenter = new Segmenter();
    for (let at = 0; at < audio.length; at += 777) pieces.push(...segmenter.push(audio.subarray(at, at + 777)).utterances);
    expect(whole).toHaveLength(2);
    expect(pieces.map((item) => item.length)).toEqual(whole.map((item) => item.length));
  });

  it("keeps listening through a breath, and through any length of quiet", () => {
    const segmenter = new Segmenter();
    segmenter.push(tone(1));
    expect(segmenter.push(silence(0.5)).utterances).toEqual([]);
    segmenter.push(tone(0.5));
    expect(segmenter.push(silence(1.2)).utterances).toHaveLength(1);
    // Half a minute of nothing is not the end of a call.
    expect(segmenter.push(silence(30)).utterances).toEqual([]);
    segmenter.push(tone(1));
    expect(segmenter.push(silence(1.2)).utterances).toHaveLength(1);
  });

  it("forgets what was half heard, and cuts off a room that never goes quiet", () => {
    const segmenter = new Segmenter();
    segmenter.push(tone(1));
    segmenter.reset();
    expect(segmenter.push(silence(2)).utterances).toEqual([]);

    const noisy = new Segmenter({ maxSeconds: 2 });
    noisy.push(silence(0.3));
    const { utterances } = noisy.push(tone(5));
    expect(utterances.length).toBeGreaterThanOrEqual(1);
    expect(seconds(utterances[0])).toBeCloseTo(2, 1);
  });

  it("peeks at the active utterance without consuming it, and clears once the pause ends it", () => {
    const segmenter = new Segmenter();
    expect(segmenter.peek().length).toBe(0);
    segmenter.push(silence(0.3));
    expect(segmenter.peek().length).toBe(0);
    segmenter.push(tone(0.8));
    const mid = segmenter.peek();
    expect(seconds(mid)).toBeGreaterThan(0.8);
    const done = segmenter.push(silence(1.2));
    expect(done.utterances).toHaveLength(1);
    expect(segmenter.peek().length).toBe(0);
  });

  it("asks for no partial words once a pause has begun, so none is still running when the final arrives", () => {
    // A detector that finds any sound speech: what the Segmenter does with it is what is tested.
    const loud = { probability: (frame: Float32Array) => (frame.some((sample) => Math.abs(sample) > 0.01) ? 1 : 0), reset: () => undefined };
    const segmenter = new Segmenter({ detector: loud as unknown as SpeechDetector });
    segmenter.push(tone(0.8));
    expect(seconds(segmenter.peek())).toBeGreaterThan(0.5);
    segmenter.push(silence(0.3));
    expect(segmenter.peek().length).toBe(0);
    segmenter.push(tone(0.3));
    expect(seconds(segmenter.peek())).toBeGreaterThan(1);
  });
});

describe("words a call answers by itself", () => {
  it("takes go, cancel and hang up when they are all that was said", () => {
    expect(callWord("Go.")).toBe("go");
    // Said around the answer, not a different request (the founder's call, 2026-11-25).
    expect(callWord("Yes, go ahead!")).toBe("go");
    expect(callWord("go ahead")).toBe("go");
    expect(callWord("Viby, go ahead.")).toBe("go");
    expect(callWord("Okay go, Vibey")).toBe("go");
    expect(callWord("Never mind.")).toBe("cancel");
    expect(callWord("Don't.")).toBe("cancel");
    expect(callWord("Hang up please")).toBe("hangup");
    expect(callWord("You can end the call now, Viby, thank you.")).toBe("hangup");
    expect(callWord("Alright thanks Vibey, you can hang up now")).toBe("hangup");
    expect(callWord("Auf Wiedersehen")).toBe("hangup");
    expect(callWord("D'accord.")).toBe("go");
    expect(callWord("はい。")).toBe("go");
    expect(callWord("取消")).toBe("cancel");
  });

  it("knows the words that only ask Viby to stop talking", () => {
    expect(callWord("That's enough.")).toBe("hush");
    expect(callWord("Okay, got it")).toBe("hush");
    expect(callWord("Viby, be quiet")).toBe("hush");
    expect(callWord("warte")).toBe("hush");
    // Stop still cancels a waiting plan.
    expect(callWord("stop")).toBe("cancel");
  });

  it("knows Viby's own words when they come back through the microphone", () => {
    const line = "I'll start Claude Code in api-server. Say go, or cancel.";
    expect(echoes("start Claude Code in API server", line)).toEqual({ echo: true, words: 6 });
    // Whisper mishears half of it: still Viby's sentence.
    expect(echoes("I'll start cloud coat in a server", line).echo).toBe(true);
    // Misheard past recognising, it can't be told from something the person said.
    expect(echoes("starting cloud coat", line).echo).toBe(false);
    // A word that is in the sentence can't be told from its echo while the sentence is being said.
    expect(echoes("Go.", line)).toEqual({ echo: true, words: 1 });
    expect(echoes("No, use Grok instead", line).echo).toBe(false);
    expect(echoes("wait", line).echo).toBe(false);
    expect(echoes("", line).echo).toBe(false);
    expect(echoes("go", "").echo).toBe(false);
  });

  it("works out when the speech in something heard began", () => {
    // Two seconds of audio that arrived at 10 s: 0.45 s of it is from before the speech, 0.3 s from after, and 0.7 s of pause ended it.
    expect(speechBegan(10_000, 2)).toBe(10_000 - 700 - 1250);
  });

  it("extracts crisp navigation targets while leaving compound requests to the planner", () => {
    expect(quickNav("Switch to VibeForge.")).toBe("VibeForge");
    expect(quickNav("Hey Viby, open the Tasks view please")).toBe("Tasks");
    expect(quickNav("Show me api-server workspace")).toBe("api-server");
    expect(quickNav("Open Claude in VibeForge and run tests")).toBe(null);
    expect(quickNav("What is running right now?")).toBe(null);
  });

  it("leaves a sentence for Viby", () => {
    expect(callWord("go to the api workspace")).toBe(null);
    expect(callWord("stop the one in docs")).toBe(null);
    expect(callWord("cancel the deploy routine")).toBe(null);
    expect(callWord("")).toBe(null);
  });

  it("drops what whisper makes up for a noise", () => {
    expect(phantom("Thank you.", 0.8)).toBe(true);
    expect(phantom(" you", 1)).toBe(true);
    expect(phantom("...", 1)).toBe(true);
    expect(phantom("Subtitles by the Amara.org community", 6)).toBe(true);
    // Said at length, it was said.
    expect(phantom("Thank you.", 4)).toBe(false);
    expect(phantom("Start Claude in the api workspace", 2)).toBe(false);
    expect(phantom("go", 0.6)).toBe(false);
  });
});

const turn = (part: Partial<OrchestratorTurn>): OrchestratorTurn => ({ id: `t${Math.random()}`, at: "2026-11-18T10:00:00.000Z", from: "vibeforge", text: "", ...part });
const note = { kind: "finished", ptyId: "p1", runId: null, engine: "Claude Code", workspace: "api", workspaceId: null, copyId: null, changes: null } as const;
const lines = { sayGo: "Say go, or cancel.", planReady: "I have a plan.", problem: "That went wrong." };

describe("what Viby says in a call", () => {
  it("is its newest answer to the last thing asked, not a note about a CLI", () => {
    const answer = turn({ text: "Two are running." });
    expect(answerTo([turn({ text: "Old." }), turn({ from: "you", text: "what's running?" }), answer, turn({ note })])).toBe(answer);
    expect(answerTo([turn({ from: "you", text: "what's running?" })])).toBe(null);
    expect(answerTo([turn({ from: "you", text: "what's running?" }), turn({ note })])).toBe(null);
    expect(answerTo([])).toBe(null);
  });

  it("asks for go when a plan waits, and says so when the answer went wrong", () => {
    expect(spokenAnswer(turn({ text: "Two are running." }), lines)).toBe("Two are running.");
    expect(spokenAnswer(turn({ text: "I'll start Claude in api.", plan: "waiting", steps: [] }), lines)).toBe("I'll start Claude in api. Say go, or cancel.");
    expect(spokenAnswer(turn({ plan: "waiting", steps: [] }), lines)).toBe("I have a plan. Say go, or cancel.");
    expect(spokenAnswer(turn({ text: "Starting Claude.", plan: "running", steps: [] }), lines)).toBe("Starting Claude.");
    expect(spokenAnswer(turn({ problem: "timeout" }), lines)).toBe("That went wrong.");
  });

  it("finds the plan a spoken go answers", () => {
    const waiting = turn({ text: "Plan.", plan: "waiting", steps: [] });
    expect(waitingPlan([turn({ plan: "done", steps: [] }), waiting, turn({ note })])).toBe(waiting);
    expect(waitingPlan([turn({ plan: "replaced", steps: [] })])).toBe(null);
    // An unrelated answer (or a new question) after a waiting plan leaves Go unable to fire the old one.
    expect(waitingPlan([waiting, turn({ from: "you", text: "What's running?" }), turn({ text: "Two." })])).toBe(null);
    expect(waitingPlan([waiting, turn({ text: "Two." }), turn({ note })])).toBe(null);
  });

  const wordLines = {
    finished: (who: { engine: string; workspace: string }) => `${who.engine} in ${who.workspace} finished its turn.`,
    ended: (who: { engine: string; workspace: string }) => `${who.engine} in ${who.workspace} closed.`,
    says: (reply: string) => `It says: ${reply}`,
    changes: (summary: string) => summary,
    more: "There is more.",
    fromScreen: "Its terminal is on screen.",
  };

  it("says a note about a CLI: who, what changed, and the start of its answer", () => {
    expect(spokenWord({ kind: "note", note }, wordLines)).toBe("Claude Code in api finished its turn.");
    expect(spokenWord({ kind: "note", note: { ...note, workspace: "api · fix-tray", changes: "2 commits · 3 files changed", reply: "All 12 tests pass." } }, wordLines)).toBe(
      "Claude Code in api, fix-tray finished its turn. 2 commits, 3 files changed. It says: All 12 tests pass.",
    );
    expect(spokenWord({ kind: "note", note: { ...note, kind: "ended" } }, wordLines)).toBe("Claude Code in api closed.");
  });

  it("reads an answer out: its start unless all was asked for, and never a screen", () => {
    const read = { kind: "read", engine: "Claude Code", workspace: "api", all: false, fromScreen: false } as const;
    expect(spokenWord({ ...read, reply: "## Done\n\nAll **12** tests pass.\n\n```\nnpm test\n```" }, wordLines)).toBe("Done. All 12 tests pass. A code block, 1 line.");
    const long = Array.from({ length: 60 }, (_item, index) => `Sentence number ${index} is here.`).join(" ");
    const start = spokenWord({ ...read, reply: long }, wordLines);
    expect(start.endsWith(" There is more.")).toBe(true);
    expect(start.length).toBeLessThanOrEqual(READ_START + " There is more.".length);
    expect(spokenWord({ ...read, reply: long, all: true }, wordLines)).toBe(long);
    // With no voice the call can only show it: the first paragraph.
    expect(spokenWord({ ...read, reply: "First.\n\nSecond." }, wordLines, true)).toBe("First.");
    expect(spokenWord({ ...read, reply: "╭─ prompt ─╮", fromScreen: true }, wordLines)).toBe("Its terminal is on screen.");
  });
});

// ------------------------------------------------------------------ the call itself

const log = { info: () => undefined, warn: () => undefined } as unknown as LogFile;

/** A call with a stand-in microphone, whisper, Piper and Viby. */
function call(opts: {
  hears: string[];
  voiced?: boolean;
  talkBack?: boolean;
  answer?: (text: string, turns: OrchestratorTurn[]) => void;
  /** Settings' word on talking over Viby, and what the microphone can do. */
  talkOver?: "auto" | "always" | "never";
  detects?: boolean;
  cancelsEcho?: boolean;
  /** Viby's speech lasts until it is stopped (or `finishSpeaking` is called), instead of no time at all. */
  slowSpeech?: boolean;
}) {
  const turns: OrchestratorTurn[] = [];
  const hears = [...opts.hears];
  const spoken: string[] = [];
  const states: CallState[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const cancelled: string[] = [];
  const deaf: boolean[] = [];
  const looked: unknown[] = [];
  const follows: boolean[] = [];
  let dictating = false;
  let talkBack = opts.talkBack ?? true;
  let talkOver: "auto" | "always" | "never" = opts.talkOver ?? "auto";
  /** How long each thing heard is said to be. */
  let seconds = 2;
  let heard: ((word: VibyWord) => void) | null = null;
  let events: { heard: (pcm: Buffer) => void; level: (level: number, hearing: boolean, speechMs: number) => void; closed: (error: string) => void } | null = null;
  let open = false;
  const echoAsked: boolean[] = [];
  let speaking: (() => void) | null = null;
  let stops = 0;
  const warmed: string[] = [];
  let unwarmed = 0;
  const voice = {
    openEar: (on: NonNullable<typeof events>, cancelEcho: boolean) => {
      events = on;
      open = true;
      echoAsked.push(cancelEcho);
      return {
        deaf: (value: boolean) => void deaf.push(value),
        close: () => {
          open = false;
        },
        detects: opts.detects ?? false,
        cancelsEcho: opts.cancelsEcho ?? false,
      };
    },
    transcribe: async () => ({ text: hears.shift() ?? "", seconds, tookMs: 1, empty: null }),
    status: () => ({ ready: true }),
    get dictating() {
      return dictating;
    },
    voiceFor: () => (opts.voiced === false ? null : "/voices/amy.onnx"),
    speaker: {
      piper: () => "/usr/bin/piper",
      player: () => ({ label: "pw-play", argv: () => [] }),
      warm: (file: string) => void warmed.push(file),
      unwarm: () => {
        unwarmed += 1;
      },
      speak: (text: string) => {
        spoken.push(text);
        if (!opts.slowSpeech) return Promise.resolve();
        return new Promise<void>((resolve) => {
          speaking = resolve;
        });
      },
      stop: () => {
        stops += 1;
        speaking?.();
        speaking = null;
      },
    },
  };
  const service = {
    orchestratorView: () => ({ turns }),
    orchestratorCall: (listener: ((word: VibyWord) => void) | null) => {
      heard = listener;
      follows.push(listener !== null);
    },
    orchestratorAsk: async (text: string, looking: unknown) => {
      asked.push(text);
      looked.push(looking);
      turns.push(turn({ from: "you", text }));
      (opts.answer ?? ((_text, list) => void list.push(turn({ text: "Two are running." }))))(text, turns);
    },
    orchestratorRun: async (id: string) => void ran.push(id),
    orchestratorCancel: (id: string) => void cancelled.push(id),
    getSettings: () => ({ voice: { talkBack, talkOver } }),
    listAgents: () => [{ name: "Atlas" }],
    listEngines: () => [{ label: "Claude Code" }],
    listWorkspaces: () => ({ workspaces: [{ name: "api-server" }] }),
  };
  const lines: Record<string, string> = {
    "call.sayGo": "Say go, or cancel.",
    "call.planReady": "I have a plan.",
    "call.problem": "That went wrong.",
    "call.going": "Going.",
    "call.cancelled": "Cancelled.",
    "call.bye": "Talk soon.",
    "call.opened": "Opened {name}.",
    "orch.note.finished": "{engine} in {workspace} finished its turn.",
    "orch.note.ended": "{engine} in {workspace} closed.",
    "call.itSays": "It says: {reply}",
    "call.readMore": "There is more.",
    "call.readScreen": "Its terminal is on screen.",
  };
  const words = {
    say: (key: string, vars: Record<string, string> = {}) => (lines[key] ?? key).replace(/\{(\w+)\}/g, (_all, name: string) => vars[name] ?? ""),
    coreText: (text: string) => text,
  };
  const instance = new Call({
    voice: voice as never,
    service: () => service as never,
    looking: () => ({ view: "code", workspaceId: "w1", ptyId: "pty-3" }),
    words: words as never,
    log,
    send: (state) => void states.push(state),
    afterSpeechMs: 0,
  });
  const say = async () => {
    const before = states.length;
    events?.heard(tone(1));
    // Answered when it is listening again, or the call has ended.
    await until(() => states.length > before && (!states.at(-1)?.on || (states.at(-1)?.phase === "listening" && deaf.at(-1) === false)));
  };
  return {
    instance,
    turns,
    spoken,
    states,
    asked,
    ran,
    cancelled,
    deaf,
    looked,
    follows,
    say,
    isOpen: () => open,
    events: () => events,
    /** Viby has something to say by itself: a note, or an answer a read step fetched. */
    word: (word: VibyWord) => heard?.(word),
    dictate: (on: boolean) => {
      dictating = on;
    },
    echoAsked,
    stops: () => stops,
    warmed,
    unwarmed: () => unwarmed,
    setTalkBack: (on: boolean) => {
      talkBack = on;
    },
    setTalkOver: (mode: "auto" | "always" | "never") => {
      talkOver = mode;
    },
    isSpeaking: () => speaking !== null,
    finishSpeaking: () => {
      speaking?.();
      speaking = null;
    },
    hear: () => events?.heard(tone(1)),
    lasting: (value: number) => {
      seconds = value;
    },
  };
}

describe("a call with Viby", () => {
  it("sends what it hears to Viby, reads the answer aloud, and listens again", async () => {
    const desk = call({ hears: ["what's running?"] });
    expect(desk.instance.start()).toMatchObject({ on: true, phase: "listening", spoken: true });
    await desk.say();
    expect(desk.asked).toEqual(["what's running?"]);
    expect(desk.spoken).toEqual(["Two are running."]);
    expect(desk.states.map((state) => state.phase)).toEqual(["listening", "transcribing", "thinking", "speaking", "listening"]);
    expect(desk.states.at(-1)).toMatchObject({ on: true, heard: "what's running?", said: "Two are running.", waiting: false });
    // Nothing is heard while Viby works out the answer and says it.
    expect(desk.deaf).toEqual([true, false]);
    // Viby is told what is in front of the person, and the window follows what it does meanwhile.
    expect(desk.looked).toEqual([{ view: "code", workspaceId: "w1", ptyId: "pty-3" }]);
    expect(desk.follows).toEqual([true]);
    desk.instance.stop();
    expect(desk.follows).toEqual([true, false]);
    expect(desk.isOpen()).toBe(false);
    expect(desk.states.at(-1)).toMatchObject({ on: false, error: null });
  });

  it("asks for go on a plan that waits, and a spoken go runs it without another turn", async () => {
    const plan = turn({ text: "I'll start Claude in api.", plan: "waiting", steps: [] });
    const desk = call({ hears: ["start claude in api", "Go."], answer: (_text, turns) => void turns.push(plan) });
    desk.instance.start();
    await desk.say();
    expect(desk.spoken).toEqual(["I'll start Claude in api. Say go, or cancel."]);
    expect(desk.states.at(-1)?.waiting).toBe(true);
    await desk.say();
    expect(desk.ran).toEqual([plan.id]);
    expect(desk.asked).toEqual(["start claude in api"]);
    expect(desk.spoken.at(-1)).toBe("Going.");
  });

  it("does not run an older waiting plan on a bare go after an unrelated answer", async () => {
    const oldPlan = turn({ text: "I'll start Claude in api.", plan: "waiting", steps: [] });
    const desk = call({
      hears: ["start claude in api", "what's running?", "Go."],
      answer: (text, turns) => void turns.push(text.includes("start") ? oldPlan : turn({ text: "Two are running." })),
    });
    desk.instance.start();
    await desk.say();
    expect(desk.states.at(-1)?.waiting).toBe(true);
    await desk.say();
    expect(desk.states.at(-1)?.waiting).toBe(false);
    await desk.say();
    expect(desk.ran).toEqual([]);
    expect(desk.asked).toEqual(["start claude in api", "what's running?", "Go."]);
  });

  it("cancels a waiting plan on a spoken cancel, and passes the word on when nothing waits", async () => {
    const plan = turn({ text: "I'll stop it.", plan: "waiting", steps: [] });
    const desk = call({ hears: ["stop the one in docs", "Cancel.", "cancel"], answer: (_text, turns) => void (turns.some((item) => item === plan) ? turns.push(turn({ text: "Cancel what?" })) : turns.push(plan)) });
    desk.instance.start();
    await desk.say();
    await desk.say();
    expect(desk.cancelled).toEqual([plan.id]);
    expect(desk.spoken.at(-1)).toBe("Cancelled.");
    plan.plan = "cancelled";
    await desk.say();
    expect(desk.asked).toEqual(["stop the one in docs", "cancel"]);
  });

  it("hangs up when asked, and never passes on a noise", async () => {
    const desk = call({ hears: ["Thank you.", "", "Hang up."] });
    desk.instance.start();
    await desk.say();
    await desk.say();
    expect(desk.asked).toEqual([]);
    expect(desk.spoken).toEqual([]);
    await desk.say();
    expect(desk.isOpen()).toBe(false);
    expect(desk.instance.get().on).toBe(false);
  });

  it("speaks up by itself when a CLI ends its turn, once nobody is talking", async () => {
    const desk = call({ hears: ["what's running?"] });
    desk.instance.start();
    const done: VibyWord = { kind: "note", note: { ...note, reply: "All 12 tests pass." } };
    // Quiet: said at once, with the microphone not listened to meanwhile.
    desk.word(done);
    await until(() => desk.spoken.length === 1 && desk.deaf.at(-1) === false);
    expect(desk.spoken).toEqual(["Claude Code in api finished its turn. It says: All 12 tests pass."]);
    expect(desk.deaf).toEqual([true, false]);
    expect(desk.states.map((state) => state.phase)).toContain("speaking");
    // The person is mid-sentence: it waits, and comes after the answer to what they said.
    desk.events()?.level(0.6, true, 0);
    desk.word({ kind: "note", note: { ...note, kind: "ended" } });
    await sleep(20);
    expect(desk.spoken).toHaveLength(1);
    await desk.say();
    expect(desk.spoken.slice(1)).toEqual(["Two are running.", "Claude Code in api closed."]);
    // They stopped without saying anything: the room going quiet lets it speak.
    desk.events()?.level(0.6, true, 0);
    desk.word({ kind: "read", engine: "Claude Code", workspace: "api", reply: "It is done.", all: false, fromScreen: false });
    await sleep(20);
    expect(desk.spoken).toHaveLength(3);
    desk.events()?.level(0, false, 0);
    await until(() => desk.spoken.length === 4);
    expect(desk.spoken.at(-1)).toBe("It is done.");
  });

  it("never speaks into a dictation, and says nothing once hung up", async () => {
    const desk = call({ hears: [] });
    desk.instance.start();
    desk.dictate(true);
    desk.word({ kind: "note", note });
    await sleep(20);
    expect(desk.spoken).toEqual([]);
    desk.dictate(false);
    desk.events()?.level(0, false, 0);
    await until(() => desk.spoken.length === 1);
    desk.instance.stop();
    desk.word({ kind: "note", note });
    await sleep(20);
    expect(desk.spoken).toHaveLength(1);
  });

  it("stops talking when it is talked over, and listens to what is said", async () => {
    const desk = call({ hears: ["what's running?", "No, tell me about the tasks."], detects: true, cancelsEcho: true, slowSpeech: true });
    expect(desk.instance.start()).toMatchObject({ talkOver: true, heardItself: false });
    // Echo cancellation is asked for where it decides this.
    expect(desk.echoAsked).toEqual([true]);
    desk.hear();
    await until(() => desk.isSpeaking());
    // The microphone is open again while Viby speaks.
    expect(desk.deaf).toEqual([true, false]);
    // A cough, or the first syllable: not yet.
    desk.events()?.level(0.5, true, 96);
    expect(desk.stops()).toBe(0);
    desk.events()?.level(0.5, true, 288);
    expect(desk.stops()).toBe(1);
    await until(() => desk.instance.get().phase === "listening");
    // What they said over it is answered like anything else.
    desk.hear();
    await until(() => desk.asked.length === 2);
    expect(desk.asked).toEqual(["what's running?", "No, tell me about the tasks."]);
  });

  it("never takes its own voice for the person's, and stops being talked over once it has", async () => {
    const desk = call({ hears: ["what's running?", "Two are running", "and the tasks?"], detects: true, cancelsEcho: true, slowSpeech: true });
    desk.instance.start();
    desk.hear();
    await until(() => desk.isSpeaking());
    // The speakers' sound reaches the microphone: Viby is cut off, and whisper hears Viby's own words.
    desk.events()?.level(0.5, true, 320);
    await until(() => desk.instance.get().phase === "listening");
    desk.hear();
    await until(() => desk.instance.get().heardItself);
    await until(() => desk.instance.get().phase === "listening");
    expect(desk.asked).toEqual(["what's running?"]);
    expect(desk.instance.get()).toMatchObject({ heard: "what's running?", talkOver: false });
    // From here on one side talks at a time: the microphone stays closed while Viby speaks.
    const before = desk.deaf.length;
    desk.hear();
    await until(() => desk.isSpeaking());
    expect(desk.deaf.slice(before)).toEqual([true]);
    desk.events()?.level(0.5, true, 600);
    expect(desk.stops()).toBe(1);
    desk.finishSpeaking();
    await until(() => desk.instance.get().phase === "listening");
    expect(desk.asked).toEqual(["what's running?", "and the tasks?"]);
  });

  it("takes a word said over it for the interruption it was, not for a request", async () => {
    const plan = turn({ text: "I'll start Claude in api.", plan: "waiting", steps: [] });
    const desk = call({ hears: ["what's running?", "Okay.", "That's enough.", "start claude", "Go."], detects: true, talkOver: "always", slowSpeech: true, answer: (text, turns) => void turns.push(text === "start claude" ? plan : turn({ text: "Two are running." })) });
    desk.instance.start();
    // Headphones, as Settings say: no echo cancellation is asked for, and Viby can be talked over.
    expect(desk.echoAsked).toEqual([false]);
    expect(desk.instance.get().talkOver).toBe(true);
    const talkOver = async () => {
      await until(() => desk.isSpeaking());
      desk.events()?.level(0.5, true, 320);
      await until(() => desk.instance.get().phase === "listening");
      desk.hear();
      await until(() => desk.states.at(-1)?.phase === "transcribing");
      await until(() => desk.instance.get().phase === "listening" || desk.isSpeaking());
    };
    desk.hear();
    await talkOver();
    // "Okay." answered nothing, as no plan was waiting; it only stopped Viby.
    expect(desk.asked).toEqual(["what's running?"]);
    // Said in the quiet, "that's enough" goes nowhere either.
    desk.hear();
    await until(() => desk.states.at(-1)?.phase === "transcribing");
    await until(() => desk.instance.get().phase === "listening");
    expect(desk.asked).toEqual(["what's running?"]);
    // A plan is read out to its end. "Go", begun a moment after Viby went quiet, is Go.
    desk.hear();
    await until(() => desk.isSpeaking());
    desk.finishSpeaking();
    await until(() => desk.instance.get().phase === "listening" && desk.instance.get().waiting);
    desk.lasting(0.5);
    await sleep(700);
    desk.hear();
    await until(() => desk.ran.length === 1);
    expect(desk.ran).toEqual([plan.id]);
  });

  it("keeps one side talking at a time where Viby would hear itself", async () => {
    for (const setup of [{ detects: true, cancelsEcho: false }, { detects: false, cancelsEcho: true }, { detects: true, cancelsEcho: true, talkOver: "never" as const }]) {
      const desk = call({ hears: ["what's running?"], slowSpeech: true, ...setup });
      expect(desk.instance.start().talkOver).toBe(false);
      desk.hear();
      await until(() => desk.isSpeaking());
      expect(desk.deaf).toEqual([true]);
      desk.events()?.level(0.5, true, 600);
      expect(desk.stops()).toBe(0);
      desk.finishSpeaking();
      await until(() => desk.instance.get().phase === "listening");
      expect(desk.deaf).toEqual([true, false]);
    }
  });

  it("shows the answer when there is no voice to read it in", async () => {
    const desk = call({ hears: ["what's running?"], voiced: false });
    expect(desk.instance.start().spoken).toBe(false);
    await desk.say();
    expect(desk.spoken).toEqual([]);
    expect(desk.states.map((state) => state.phase)).not.toContain("speaking");
    expect(desk.instance.get().said).toBe("Two are running.");
  });

  it("stays silent when Viby talk-back is turned off, and stops immediately if toggled off mid-call", async () => {
    const quiet = call({ hears: ["what's running?"], talkBack: false });
    expect(quiet.instance.start().spoken).toBe(false);
    expect(quiet.warmed).toEqual([]);
    await quiet.say();
    expect(quiet.spoken).toEqual([]);
    expect(quiet.states.map((state) => state.phase)).not.toContain("speaking");
    expect(quiet.instance.get().said).toBe("Two are running.");
    quiet.word({ kind: "read", engine: "Claude Code", workspace: "api", reply: "All tests pass.", all: false, fromScreen: false });
    await sleep(20);
    expect(quiet.spoken).toEqual([]);
    expect(quiet.instance.get().said).toBe("All tests pass.");
    quiet.instance.stop();

    // Turning talk-back off mid-speech cuts Viby off at once; turning it back on resumes speaking.
    const live = call({ hears: ["first", "second", "third"], slowSpeech: true });
    expect(live.instance.start().spoken).toBe(true);
    expect(live.warmed).toEqual(["/voices/amy.onnx"]);
    live.hear();
    await until(() => live.isSpeaking());
    expect(live.spoken).toEqual(["Two are running."]);
    live.setTalkBack(false);
    live.instance.syncSettings();
    expect(live.stops()).toBe(1);
    expect(live.unwarmed()).toBe(1);
    await until(() => live.instance.get().phase === "listening");
    expect(live.instance.get().spoken).toBe(false);
    await live.say();
    expect(live.spoken).toEqual(["Two are running."]);
    expect(live.instance.get().said).toBe("Two are running.");
    live.setTalkBack(true);
    live.instance.syncSettings();
    expect(live.instance.get().spoken).toBe(true);
    expect(live.warmed).toEqual(["/voices/amy.onnx", "/voices/amy.onnx", "/voices/amy.onnx"]);
    live.hear();
    await until(() => live.isSpeaking());
    expect(live.spoken).toEqual(["Two are running.", "Two are running."]);
    live.finishSpeaking();
    await until(() => live.instance.get().phase === "listening");
    live.instance.stop();
  });

  it("says what went wrong, shows the meter, and ends when the microphone closes", async () => {
    const desk = call({
      hears: ["what's running?"],
      answer: () => {
        throw new Error("Viby is still answering. Wait for it, or stop it.");
      },
    });
    desk.instance.start();
    desk.events()?.level(0.5, true, 0);
    expect(desk.states.at(-1)).toMatchObject({ phase: "hearing", level: 0.5 });
    await desk.say();
    expect(desk.instance.get()).toMatchObject({ on: true, phase: "listening", said: "Viby is still answering. Wait for it, or stop it." });
    desk.events()?.closed("pw-record exited with code 1");
    expect(desk.instance.get()).toMatchObject({ on: false, error: "pw-record exited with code 1" });
    // A call started again starts clean.
    expect(desk.instance.start()).toMatchObject({ on: true, error: null, said: "" });
  });

  it("mutes and unmutes the microphone without ending the call, and hangs up politely on a full goodbye sentence or plan hangup", async () => {
    const desk = call({ hears: ["You can end the call now, Viby, thank you."] });
    desk.instance.start();
    expect(desk.instance.mute()).toMatchObject({ on: true, muted: true });
    expect(desk.deaf.at(-1)).toBe(true);
    // Speech while muted is ignored.
    desk.hear();
    await sleep(30);
    expect(desk.spoken).toEqual([]);
    expect(desk.instance.mute(false)).toMatchObject({ on: true, muted: false });
    expect(desk.deaf.at(-1)).toBe(false);
    // Spoken polite goodbye says bye and hangs up.
    await desk.say();
    expect(desk.spoken).toEqual(["Talk soon."]);
    expect(desk.instance.get().on).toBe(false);

    // A planner turn with hangup: true speaks its sign-off, then ends the call.
    const byPlan = call({
      hears: ["start claude and then hang up thanks"],
      answer: (_text, list) => {
        list.push(turn({ text: "On it — talk soon!", hangup: true }));
        byPlan.word({ kind: "hangup" });
      },
    });
    byPlan.instance.start();
    await byPlan.say();
    expect(byPlan.spoken).toEqual(["On it — talk soon!"]);
    expect(byPlan.instance.get().on).toBe(false);
  });

  it("lets the person barge in while Viby is still thinking", async () => {
    let releasePlan: (() => void) | null = null;
    let aborted = 0;
    const desk = call({
      hears: ["start codex here", "actually use claude instead"],
      detects: true,
      cancelsEcho: true,
      answer: (text, list) => {
        if (text === "start codex here") return;
        list.push(turn({ text: "Starting Claude." }));
      },
    });
    const origAsk = (desk.instance as unknown as { opts: { service: () => Record<string, unknown> } }).opts.service();
    const origFn = origAsk.orchestratorAsk as (t: string, l: unknown) => Promise<void>;
    origAsk.orchestratorStopThinking = () => {
      aborted += 1;
      releasePlan?.();
    };
    origAsk.orchestratorAsk = async (text: string, looking: unknown) => {
      if (text === "start codex here") {
        await new Promise<void>((resolve) => {
          releasePlan = resolve;
        });
        return;
      }
      await origFn(text, looking);
    };
    desk.instance.start();
    desk.hear();
    await until(() => desk.instance.get().phase === "thinking");
    // Barge in mid-thinking: stops the in-flight plan and listens to the corrected instruction.
    desk.events()?.level(0.6, true, 320);
    await until(() => aborted === 1 && desk.instance.get().phase === "listening");
    await desk.say();
    expect(desk.spoken).toEqual(["Starting Claude."]);
  });

  it("streams liveHeard while the person speaks and reports Piper's synthesized speech duration", async () => {
    let earEvents = null as { heard: (pcm: Buffer) => void; level: (l: number, h: boolean, ms: number) => void; closed: (e: string) => void } | null;
    let progressCb = null as ((info: { text: string; startedAt: number; durationMs: number } | null) => void) | null;
    let releaseSpeak = null as (() => void) | null;
    const states: CallState[] = [];
    const instance = new Call({
      voice: {
        openEar: (ev: typeof earEvents) => {
          earEvents = ev;
          return { deaf: () => undefined, close: () => undefined, peek: () => tone(0.8), detects: true, cancelsEcho: false };
        },
        transcribeLive: async () => "start codex in",
        transcribe: async () => ({ text: "start codex in VibeForge", seconds: 1.4, tookMs: 40, empty: null }),
        status: () => ({ ready: true } as never),
        voiceFor: () => "/tmp/voice.onnx",
        dictating: false,
        speaker: {
          piper: () => "/usr/bin/piper",
          player: () => ({ label: "pw-play", argv: () => ["pw-play"] }),
          warm: () => undefined,
          unwarm: () => undefined,
          stop: () => releaseSpeak?.(),
          progress: (fn: typeof progressCb) => {
            progressCb = fn;
          },
          speak: () =>
            new Promise<void>((resolve) => {
              releaseSpeak = resolve;
              progressCb?.({ text: "Starting Codex.", startedAt: 1000, durationMs: 1450 });
            }),
        },
      } as never,
      service: () =>
        ({
          orchestratorView: () => ({ turns: [{ id: "t1", at: "now", from: "you", text: "hi" }, { id: "t2", at: "now", from: "vibeforge", text: "Starting Codex." }] }),
          orchestratorCall: () => undefined,
          orchestratorAsk: async () => undefined,
          orchestratorRun: async () => undefined,
          orchestratorCancel: () => undefined,
          getSettings: () => ({ voice: { talkOver: "never" } }),
          listAgents: () => [],
          listEngines: () => [],
          listWorkspaces: () => ({ workspaces: [] }),
        }) as never,
      looking: () => ({ view: "orchestrator" }),
      words: { say: (k: string) => k, coreText: (s: string) => s } as never,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      send: (state) => void states.push(state),
      afterSpeechMs: 0,
    });

    instance.start();
    earEvents!.level(0.5, true, 650);
    await until(() => instance.get().liveHeard === "start codex in");
    expect(states.some((s) => s.liveHeard === "start codex in")).toBe(true);

    earEvents!.heard(tone(1.4));
    await until(() => instance.get().phase === "speaking" && instance.get().speechDurationMs === 1450);
    expect(instance.get().liveHeard).toBeUndefined();
    expect(instance.get().speechStartedAt).toBe(1000);
    releaseSpeak?.();
    await until(() => instance.get().phase === "listening");
    expect(instance.get().speechDurationMs).toBeUndefined();
    instance.stop();
  });
});

// ------------------------------------------------------------------ the open microphone

describe("the microphone a call holds open", () => {
  const before = process.env.VIBEFORGE_VOICE_RECORDER;
  afterEach(() => {
    if (before === undefined) delete process.env.VIBEFORGE_VOICE_RECORDER;
    else process.env.VIBEFORGE_VOICE_RECORDER = before;
  });

  function voice(opts: { appRoot?: string; bins?: Record<string, string> } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-call-"));
    fs.mkdirSync(path.join(dataRoot, "models"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "models", "ggml-base.en.bin"), Buffer.alloc(1_000_001));
    const settings: VoiceSettings = { model: "", language: "auto", talkBack: false, speaker: "", agent: "", keys: { ...DEFAULT_DICTATE_KEYS }, mouseButton: "off", sendButton: "pointer", talkOver: "auto" };
    const instance = new Voice({
      log,
      home: fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-call-home-")),
      dataRoot,
      settings: () => settings,
      // whisper-cli is only looked for here; nothing in these tests transcribes.
      resolveBin: (name) => (name === "whisper-cli" ? "/bin/true" : (opts.bins?.[name] ?? null)),
      ...(opts.appRoot ? { appRoot: opts.appRoot } : {}),
      state: () => undefined,
      changed: () => undefined,
      speaking: () => undefined,
      language: () => "en",
      controlSocket: path.join(dataRoot, "control.sock"),
      launcher: () => "vibeforge",
    });
    return { instance, dataRoot };
  }

  it("hands over each thing said, hears nothing while deaf, and closes its recorder", async () => {
    const { instance, dataRoot } = voice();
    const audio = path.join(dataRoot, "mic.raw");
    fs.writeFileSync(audio, Buffer.concat([silence(0.5), tone(1), silence(1.5)]));
    // The stand-in microphone: says it once, then again each time the file beside it grows. One
    // process (the shell execs it), so closing the microphone leaves nothing running.
    const pipe = path.join(dataRoot, "again");
    fs.writeFileSync(pipe, "");
    const mic = path.join(dataRoot, "mic.cjs");
    fs.writeFileSync(
      mic,
      `const fs = require("node:fs");
const audio = fs.readFileSync(${JSON.stringify(audio)});
let seen = 0;
process.stdout.write(audio);
setInterval(() => {
  const size = fs.statSync(${JSON.stringify(pipe)}).size;
  if (size > seen) process.stdout.write(audio);
  seen = size;
}, 25);
`,
    );
    process.env.VIBEFORGE_VOICE_RECORDER = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mic)}`;
    const heard: Buffer[] = [];
    const levels: Array<[number, boolean]> = [];
    try {
      const ear = instance.openEar({ heard: (pcm) => void heard.push(pcm), level: (level, hearing) => void levels.push([level, hearing]), closed: () => undefined });
      expect(() => instance.openEar({ heard: () => undefined, level: () => undefined, closed: () => undefined })).toThrow("already listening");
      await until(() => heard.length === 1);
      expect(seconds(heard[0])).toBeGreaterThan(1.3);
      expect(levels.some(([level, hearing]) => hearing && level > 0.8)).toBe(true);

      ear.deaf(true);
      fs.appendFileSync(pipe, "again\n");
      await sleep(600);
      expect(heard).toHaveLength(1);

      ear.deaf(false);
      fs.appendFileSync(pipe, "again\n");
      await until(() => heard.length === 2);

      // Words dictated during a call are the dictation's: the call hears none of them.
      instance.start();
      fs.appendFileSync(pipe, "again\n");
      await sleep(600);
      expect(heard).toHaveLength(2);
      await instance.cancel();
      fs.appendFileSync(pipe, "again\n");
      await until(() => heard.length === 3);
      ear.close();
      // Closed on purpose is not the recorder failing, and the microphone can be opened again.
      instance.openEar({ heard: () => undefined, level: () => undefined, closed: () => undefined }).close();
    } finally {
      instance.dispose();
    }
  });

  const repo = path.resolve(import.meta.dirname, "..", "..");
  const speech = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "speech.raw"));
  const none = { heard: () => undefined, level: () => undefined, closed: () => undefined };

  /** A stand-in recorder that plays `audio` once and stays open, as one node process. */
  function recorderPlaying(dataRoot: string, audio: Buffer): string {
    const file = path.join(dataRoot, "mic.raw");
    fs.writeFileSync(file, audio);
    const mic = path.join(dataRoot, "mic.cjs");
    fs.writeFileSync(mic, `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(file)}));\nsetInterval(() => undefined, 1000);\n`);
    return `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mic)}`;
  }

  it("listens for speech itself with the detector VibeForge ships: a voice is heard, a loud tone is not", async () => {
    const { instance, dataRoot } = voice({ appRoot: repo });
    // A tone first, which loudness alone would take for someone speaking, then a person.
    process.env.VIBEFORGE_VOICE_RECORDER = recorderPlaying(dataRoot, Buffer.concat([silence(0.5), tone(1), silence(1.5), speech, silence(1.5)]));
    const heard: Buffer[] = [];
    try {
      const ear = instance.openEar({ heard: (pcm) => void heard.push(pcm), level: () => undefined, closed: () => undefined });
      expect(ear).toMatchObject({ detects: true, cancelsEcho: false });
      await until(() => heard.length === 1);
      await sleep(300);
      expect(heard).toHaveLength(1);
      // The speech, not the tone before it: the clip is 2.6 s, the tone and its silences 3 s more.
      expect(seconds(heard[0])).toBeGreaterThan(2.2);
      expect(seconds(heard[0])).toBeLessThan(2.9);
    } finally {
      instance.dispose();
    }
  });

  it("goes by loudness when the detector's file can't be read", () => {
    const { instance } = voice({ appRoot: path.join(repo, "tests") });
    process.env.VIBEFORGE_VOICE_RECORDER = "exec sleep 5";
    try {
      expect(instance.openEar(none).detects).toBe(false);
    } finally {
      instance.dispose();
    }
  });

  it("records from PipeWire's echo-cancelled microphone when asked, and ends the canceller with the call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-echo-"));
    const script = (name: string, body: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require("node:fs");\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const up = path.join(dir, "up");
    const args = path.join(dir, "args");
    const bins = {
      // PipeWire's client: up until it is ended, and it says with which configuration.
      pipewire: script("pipewire", `fs.writeFileSync(${JSON.stringify(up)}, process.argv.slice(2).join(" "));\nprocess.on("SIGTERM", () => { fs.rmSync(${JSON.stringify(up)}); process.exit(0); });\nsetInterval(() => undefined, 1000);`),
      "pw-cli": script("pw-cli", `if (fs.existsSync(${JSON.stringify(up)})) console.log('\\t\\tnode.name = "vibeforge.call.microphone"');`),
      // Written whole, then renamed: the test reads it the moment it exists.
      "pw-record": script("pw-record", `fs.writeFileSync(${JSON.stringify(args)} + ".part", process.argv.slice(2).join(" "));\nfs.renameSync(${JSON.stringify(args)} + ".part", ${JSON.stringify(args)});\nsetInterval(() => undefined, 1000);`),
    };
    const { instance, dataRoot } = voice({ bins });
    try {
      const ear = instance.openEar(none, true);
      expect(ear.cancelsEcho).toBe(false);
      await until(() => fs.existsSync(args));
      expect(fs.readFileSync(args, "utf8")).toBe("--target vibeforge.call.microphone --rate 16000 --channels 1 --format s16 --raw -");
      expect(ear.cancelsEcho).toBe(true);
      const conf = fs.readFileSync(up, "utf8").replace(/^-c /, "");
      expect(conf).toBe(path.join(dataRoot, "voice", "echo-cancel.conf"));
      expect(fs.readFileSync(conf, "utf8")).toBe(echoCancelConf());
      ear.close();
      // The canceller removes its file as it exits; VibeForge hears of the exit a moment later.
      await until(() => !fs.existsSync(up) && !ear.cancelsEcho);

      // Not asked for (Settings say headphones, or never): the microphone as it is.
      fs.rmSync(args);
      const plain = instance.openEar(none);
      await until(() => fs.existsSync(args));
      expect(fs.readFileSync(args, "utf8")).toBe("--rate 16000 --channels 1 --format s16 --raw -");
      expect(fs.existsSync(up)).toBe(false);
      expect(plain.cancelsEcho).toBe(false);
    } finally {
      instance.dispose();
    }
  });

  it("goes on without echo cancellation when PipeWire doesn't offer it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-echo-"));
    const pipewire = path.join(dir, "pipewire");
    fs.writeFileSync(pipewire, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const quiet = { info: () => undefined, warn: () => undefined } as unknown as LogFile;
    // Its client ends at once (no such module): given up on without waiting out the time.
    const started = Date.now();
    expect(await startEchoCancel({ resolveBin: (name) => (name === "pipewire" ? pipewire : "/bin/true"), dir, log: quiet, readyMs: 5000 })).toBe(null);
    expect(Date.now() - started).toBeLessThan(3000);
    // No PipeWire here at all.
    expect(await startEchoCancel({ resolveBin: () => null, dir, log: quiet })).toBe(null);
    expect(echoCancelConf()).toContain("monitor.mode = true");
    expect(echoCancelConf()).toContain(`node.name = "${ECHO_SOURCE}"`);
  });

  it("says so when the recorder stops by itself", async () => {
    const { instance } = voice();
    process.env.VIBEFORGE_VOICE_RECORDER = "echo 'no such device' >&2; exit 3";
    const closed: string[] = [];
    try {
      instance.openEar({ heard: () => undefined, level: () => undefined, closed: (error) => void closed.push(error) });
      await until(() => closed.length === 1);
      expect(closed[0]).toBe("no such device");
    } finally {
      instance.dispose();
    }
  });
});
