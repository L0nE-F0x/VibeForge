import { answerTo, callWord, echoes, phantom, speechBegan, spokenAnswer, spokenWord, TALK_OVER_MS, waitingPlan } from "../src/core/call.js";
import { describeError, type LogFile } from "../src/core/log.js";
import type { MainText } from "../src/core/main-text.js";
import { orchestratorVoiceWords } from "../src/core/orchestrator.js";
import { speakable } from "../src/core/replies.js";
import type { TeamService } from "../src/core/team-service.js";
import type { TalkOver } from "../src/core/types.js";
import type { CallPhase, CallState } from "../src/shared/api.js";
import type { Looking, VibyWord } from "../src/shared/orchestrator.js";
import { vocabularyPrompt } from "../src/shared/dictation.js";
import type { Ear, Voice } from "./voice.js";

/** After Viby stops talking, the room rings on for a moment; the microphone opens after it. */
const AFTER_SPEECH_MS = 250;
const LEVEL_EVERY_MS = 60;

/** What Viby said lately is kept this long, to tell its echo from the person. */
const SPOKEN_KEEP_MS = 60_000;

type CallService = Pick<TeamService, "orchestratorView" | "orchestratorAsk" | "orchestratorRun" | "orchestratorCancel" | "orchestratorCall" | "listAgents" | "listEngines" | "listWorkspaces" | "getSettings">;

/**
 * A call with Viby. The microphone stays open; each thing said is turned into words here and
 * goes to Viby as if typed in its box, and Viby's answer is read aloud. Then it listens again,
 * until it is hung up. One side talks at a time: while Viby thinks or speaks the microphone is
 * not listened to, so Viby never hears itself. A plan still waits for Go as Settings says; said
 * on its own, "go" or "cancel" answers it here without a planning turn.
 *
 * Viby also speaks up by itself: when a CLI it started or told ends its turn, and when a read step
 * has fetched an answer. That waits for a moment when nobody is talking, and never cuts in.
 *
 * Where Viby can't hear itself (PipeWire is cancelling the echo, or Settings say headphones) and
 * the speech detector is listening, the microphone stays open while Viby speaks, and talking over
 * it stops it. What is heard then is checked against what Viby was saying: its own words coming
 * back are never taken for the person's, and one clear case of that ends talking over for the call.
 */
export class Call {
  private ear: Ear | null = null;
  private phase: CallPhase = "listening";
  private level = 0;
  private lastLevelAt = 0;
  private heard = "";
  private said = "";
  private error: string | null = null;
  private waiting = false;
  private spoken = false;
  /** Something said is being answered; what is said meanwhile is not heard. */
  private busy = false;
  /** What Viby has to say by itself, until there is a quiet moment to say it in. */
  private pending: string[] = [];
  /** Settings' word on talking over Viby, as it was when the call began. */
  private mode: TalkOver = "never";
  /** Viby is speaking with the microphone open: talking now stops it. */
  private open = false;
  /** The person talked over Viby in this turn; the rest of what it had to say waits. */
  private interrupted = false;
  /** Viby heard itself in this call: no more talking over it. */
  private heardItself = false;
  /** What Viby said lately and when, to know its own words when they come back through the microphone. */
  private spokenLately: Array<{ line: string; from: number; until: number }> = [];
  /** Goes up when a call ends, so an answer that arrives afterwards is not spoken into the next one. */
  private epoch = 0;

  constructor(
    private readonly opts: {
      voice: Pick<Voice, "openEar" | "transcribe" | "status" | "voiceFor" | "speaker" | "dictating">;
      service: () => CallService | null;
      /** Where the person is in the window, so "this one" means the terminal in front of them. */
      looking: () => Looking | null;
      words: Pick<MainText, "say" | "coreText">;
      log: LogFile;
      send: (state: CallState) => void;
      /** For tests: the pause after Viby speaks. */
      afterSpeechMs?: number;
    },
  ) {}

  get(): CallState {
    return {
      on: this.ear !== null,
      phase: this.phase,
      level: this.level,
      heard: this.heard,
      said: this.said,
      waiting: this.waiting,
      spoken: this.spoken,
      error: this.error,
      talkOver: this.canTalkOver(),
      heardItself: this.heardItself,
    };
  }

  /** Whether talking while Viby speaks stops it, right now. */
  private canTalkOver(): boolean {
    const ear = this.ear;
    if (!ear?.detects || this.heardItself) return false;
    return this.mode === "always" || (this.mode === "auto" && ear.cancelsEcho);
  }

  /** Tells the window, after looking again at what the meter's many updates don't need looked at. */
  private changed(): void {
    const service = this.ear ? this.opts.service() : null;
    this.waiting = Boolean(service && waitingPlan(service.orchestratorView().turns));
    this.spoken = this.voiceFile() !== null;
    this.opts.send(this.get());
  }

  private move(phase: CallPhase): void {
    this.phase = phase;
    this.level = 0;
    this.changed();
  }

  /** The voice Viby speaks in, or null when nothing can be read aloud here. */
  private voiceFile(): string | null {
    const { voice } = this.opts;
    return voice.speaker.piper() && voice.speaker.player() ? voice.voiceFor() : null;
  }

  start(): CallState {
    if (this.ear) return this.get();
    const service = this.opts.service();
    if (!service) throw new Error("VibeForge is still starting.");
    this.heard = "";
    this.said = "";
    this.error = null;
    this.busy = false;
    this.pending = [];
    this.open = false;
    this.interrupted = false;
    this.heardItself = false;
    this.spokenLately = [];
    this.phase = "listening";
    this.level = 0;
    const epoch = this.epoch;
    const events = {
      heard: (pcm: Buffer) => void this.answer(pcm),
      level: (level: number, hearing: boolean, speechMs: number) => {
        if (epoch !== this.epoch) return;
        if (this.busy) {
          // Viby is talking and someone else has started to: it stops and listens.
          if (this.open && !this.interrupted && hearing && speechMs >= TALK_OVER_MS) this.interrupt();
          return;
        }
        const phase: CallPhase = hearing ? "hearing" : "listening";
        const now = Date.now();
        if (phase === this.phase && now - this.lastLevelAt < LEVEL_EVERY_MS) return;
        this.lastLevelAt = now;
        this.phase = phase;
        this.level = level;
        this.opts.send(this.get());
        if (phase === "listening") void this.speakUp();
      },
      closed: (error: string) => {
        if (epoch !== this.epoch) return;
        this.ear = null;
        this.end(error);
      },
    };
    // Echo cancellation is asked for only where it decides whether Viby can be talked over.
    this.mode = service.getSettings().voice.talkOver;
    this.ear = this.opts.voice.openEar(events, this.mode === "auto");
    // What Viby starts or tells during the call comes up on screen, as it would for someone watching,
    // and what it has to say by itself is said here.
    service.orchestratorCall((word) => this.hear(word));
    this.opts.log.info("Call: started");
    this.changed();
    return this.get();
  }

  stop(): void {
    if (!this.ear) return;
    this.ear.close();
    this.ear = null;
    this.end(null);
  }

  private end(error: string | null): void {
    this.epoch += 1;
    this.busy = false;
    this.pending = [];
    this.open = false;
    this.opts.service()?.orchestratorCall(null);
    this.error = error;
    this.phase = "listening";
    this.level = 0;
    // Hanging up cuts Viby off mid-sentence too.
    this.opts.voice.speaker.stop();
    this.opts.log.info(error ? `Call: ended, ${error}` : "Call: ended");
    this.changed();
  }

  /** Names whisper should expect: the ones Viby's own box tells it. */
  private vocabulary(service: CallService): string {
    return vocabularyPrompt([
      "VibeForge",
      ...service.listAgents().map((agent) => agent.name),
      ...service.listEngines().map((engine) => engine.label),
      ...orchestratorVoiceWords(service.listWorkspaces().workspaces.map((item) => item.name)),
    ]);
  }

  /**
   * Viby's turn to do something: the microphone is not listened to until it is over, and what
   * Viby had to say by itself meanwhile is said at its end.
   */
  private async turn(work: (live: () => boolean) => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    const live = () => epoch === this.epoch;
    this.busy = true;
    this.interrupted = false;
    this.ear?.deaf(true);
    try {
      await work(live);
      // Talked over, the rest waits for the next quiet moment.
      while (live() && this.pending.length && !this.interrupted) await this.say(this.pending.shift() ?? "");
    } catch (error) {
      this.opts.log.warn(`Call: ${describeError(error).split("\n")[0]}`);
      if (live()) this.said = error instanceof Error ? error.message : String(error);
    } finally {
      if (live()) {
        this.busy = false;
        this.ear?.deaf(false);
        this.move("listening");
      }
    }
  }

  private async answer(pcm: Buffer): Promise<void> {
    const service = this.opts.service();
    if (this.busy || !this.ear || !service) return;
    const heardAt = Date.now();
    await this.turn(async (live) => {
      this.move("transcribing");
      const dictation = await this.opts.voice.transcribe(pcm, this.vocabulary(service), "call");
      if (!live() || !dictation.text || phantom(dictation.text, dictation.seconds)) return;
      // Begun while Viby was still speaking: its own words coming back are not the person's.
      const over = this.saidSince(speechBegan(heardAt, dictation.seconds));
      if (over) {
        const { echo, words } = echoes(dictation.text, over);
        if (echo) {
          this.opts.log.warn(`Call: heard Viby's own voice (${words} word${words === 1 ? "" : "s"}), not passed on`);
          if (words >= 3) this.heardItself = true;
          return;
        }
      }
      this.heard = dictation.text;
      const word = callWord(dictation.text);
      if (word === "hangup") {
        this.stop();
        return;
      }
      const plan = word ? waitingPlan(service.orchestratorView().turns) : null;
      // Only asked Viby to stop talking, which talking over it did; or answered a plan that isn't there.
      if (word === "hush" || (over && word && !plan)) return;
      if (plan && word === "go") {
        // The plan runs on its card as if Go were pressed; a step that fails says so there.
        void service.orchestratorRun(plan.id).catch((error: unknown) => this.opts.log.warn(`Call: the plan did not run: ${describeError(error)}`));
        await this.say(this.opts.words.say("call.going"));
        return;
      }
      if (plan && word === "cancel") {
        service.orchestratorCancel(plan.id);
        await this.say(this.opts.words.say("call.cancelled"));
        return;
      }
      this.move("thinking");
      await service.orchestratorAsk(dictation.text, this.opts.looking());
      if (!live()) return;
      // No answer: it was stopped from its card or the call's own bar.
      const turn = answerTo(service.orchestratorView().turns);
      if (turn) await this.say(spokenAnswer(turn, { sayGo: this.opts.words.say("call.sayGo"), planReady: this.opts.words.say("call.planReady"), problem: this.opts.words.say("call.problem") }));
    });
  }

  /** Viby has something to say that nobody asked for just now: a CLI ended its turn, or an answer was fetched to read out. */
  private hear(word: VibyWord): void {
    if (!this.ear) return;
    const { words } = this.opts;
    const line = spokenWord(
      word,
      {
        finished: (who) => words.say("orch.note.finished", who),
        ended: (who) => words.say("orch.note.ended", who),
        says: (reply) => words.say("call.itSays", { reply }),
        changes: (summary) => words.coreText(summary),
        more: words.say("call.readMore"),
        fromScreen: words.say("call.readScreen"),
      },
      this.voiceFile() === null,
    );
    if (!line) return;
    this.pending.push(line);
    void this.speakUp();
  }

  /** Says what is waiting to be said, once nobody is talking: not over the person, nor into their dictation. */
  private async speakUp(): Promise<void> {
    if (this.busy || !this.ear || !this.pending.length || this.phase !== "listening" || this.opts.voice.dictating) return;
    await this.turn(async () => undefined);
  }

  /** The person started talking while Viby was: it stops mid-sentence and listens. */
  private interrupt(): void {
    this.interrupted = true;
    this.opts.log.info("Call: talked over, Viby stopped");
    this.opts.voice.speaker.stop();
  }

  /** What Viby was saying at or after `since` (a time in ms), or "" when it had been quiet. */
  private saidSince(since: number): string {
    const now = Date.now();
    this.spokenLately = this.spokenLately.filter((item) => now - item.until < SPOKEN_KEEP_MS);
    return this.spokenLately
      .filter((item) => item.until > since)
      .map((item) => item.line)
      .join(" ");
  }

  /** Viby says it: aloud when there is a voice to say it in, and on the call's bar either way. */
  private async say(text: string): Promise<void> {
    const line = speakable(text, "full");
    this.said = line;
    const voice = this.voiceFile();
    if (!line || !voice) {
      this.changed();
      return;
    }
    const epoch = this.epoch;
    // Where Viby can't hear itself, the microphone stays open and talking over it stops it.
    this.open = this.canTalkOver();
    if (this.open) this.ear?.deaf(false);
    this.move("speaking");
    // Only what is said with the microphone open can come back through it.
    const spoke = { line, from: Date.now(), until: Number.POSITIVE_INFINITY };
    if (this.open) this.spokenLately.push(spoke);
    await this.opts.voice.speaker.speak(line, voice);
    spoke.until = Date.now();
    const open = this.open;
    this.open = false;
    if (epoch !== this.epoch || this.interrupted) return;
    // The microphone was closed: the room rings on for a moment before it opens. Open, it hears that anyway.
    if (!open) await new Promise((resolve) => setTimeout(resolve, this.opts.afterSpeechMs ?? AFTER_SPEECH_MS));
  }

  dispose(): void {
    this.stop();
  }
}
