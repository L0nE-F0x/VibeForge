import fs from "node:fs";
import { answerTo, callWord, echoes, phantom, quickNav, speechBegan, spokenAnswer, spokenWord, TALK_OVER_MS, waitingPlan } from "../src/core/call.js";
import { describeError, type LogFile } from "../src/core/log.js";
import type { MainText } from "../src/core/main-text.js";
import { orchestratorVoiceWords } from "../src/core/orchestrator.js";
import { speakable } from "../src/core/replies.js";
import type { TeamService } from "../src/core/team-service.js";
import type { TalkOver } from "../src/core/types.js";
import type { CallPhase, CallState } from "../src/shared/api.js";
import type { Looking, VibyWord } from "../src/shared/orchestrator.js";
import { BYTES_PER_SECOND } from "../src/core/voice.js";
import { vocabularyPrompt } from "../src/shared/dictation.js";
import type { Ear, Voice } from "./voice.js";

/** After Viby stops talking, the room rings on for a moment; the microphone opens after it. */
const AFTER_SPEECH_MS = 250;
const LEVEL_EVERY_MS = 60;
const LIVE_PEEK_EVERY_MS = 650;
const LIVE_PEEK_MIN_BYTES = Math.round(0.55 * BYTES_PER_SECOND);

/** What Viby said lately is kept this long, to tell its echo from the person. */
const SPOKEN_KEEP_MS = 60_000;

type CallService = Pick<
  TeamService,
  "orchestratorView" | "orchestratorAsk" | "orchestratorRun" | "orchestratorCancel" | "orchestratorCall" | "listAgents" | "listEngines" | "listWorkspaces" | "getSettings"
> &
  Partial<Pick<TeamService, "orchestratorStopThinking" | "orchestratorQuickShow" | "orchestratorQuickAct" | "listTasks" | "listRoutines" | "listSkills">>;

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
  /** Viby is thinking with the microphone open: talking now stops its turn and listens to the new thought. */
  private thinkingOpen = false;
  /** The person muted the call's microphone while keeping the call open. */
  private muted = false;
  /** Current deaf state pushed to `ear`, so repeated transitions don't send redundant signals. */
  private earDeaf = false;
  /** Viby's latest answer asked to end the call once it has been spoken. */
  private hangingUp = false;
  /** The person talked over Viby in this turn; the rest of what it had to say waits. */
  private interrupted = false;
  /** Viby heard itself in this call: no more talking over it. */
  private heardItself = false;
  /** What Viby said lately and when, to know its own words when they come back through the microphone. */
  private spokenLately: Array<{ line: string; from: number; until: number }> = [];
  /** Partial words recognized while the person is still mid-sentence. */
  private liveHeard = "";
  private peeking = false;
  private lastPeekAt = 0;
  private speechStartedAt = 0;
  private speechDurationMs = 0;
  /** Goes up when a call ends, so an answer that arrives afterwards is not spoken into the next one. */
  private epoch = 0;

  constructor(
    private readonly opts: {
      voice: Pick<Voice, "openEar" | "transcribe" | "status" | "voiceFor" | "speaker" | "dictating"> & Partial<Pick<Voice, "transcribeLive">>;
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
      muted: this.muted,
      ...(this.liveHeard ? { liveHeard: this.liveHeard } : {}),
      ...(this.speechStartedAt ? { speechStartedAt: this.speechStartedAt } : {}),
      ...(this.speechDurationMs ? { speechDurationMs: this.speechDurationMs } : {}),
    };
  }

  private setDeaf(deaf: boolean): void {
    const wanted = deaf || this.muted;
    if (this.earDeaf === wanted) return;
    this.earDeaf = wanted;
    this.ear?.deaf(wanted);
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

  /** The voice Viby speaks in, or null when Viby talk-back is off or nothing can be read aloud here. */
  private voiceFile(): string | null {
    if (this.opts.service()?.getSettings().voice.talkBack === false) return null;
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
    this.thinkingOpen = false;
    this.muted = false;
    this.earDeaf = false;
    this.hangingUp = false;
    this.interrupted = false;
    this.heardItself = false;
    this.spokenLately = [];
    this.liveHeard = "";
    this.peeking = false;
    this.lastPeekAt = 0;
    this.speechStartedAt = 0;
    this.speechDurationMs = 0;
    this.phase = "listening";
    this.level = 0;
    const epoch = this.epoch;
    const events = {
      heard: (pcm: Buffer) => void this.answer(pcm),
      level: (level: number, hearing: boolean, speechMs: number) => {
        if (epoch !== this.epoch || this.muted) return;
        if (this.busy) {
          // Viby is thinking or talking and someone else has started to: it stops and listens.
          if ((this.open || this.thinkingOpen) && !this.interrupted && hearing && speechMs >= TALK_OVER_MS) this.interrupt();
          return;
        }
        const phase: CallPhase = hearing ? "hearing" : "listening";
        if (phase === "listening" && this.liveHeard) this.liveHeard = "";
        const now = Date.now();
        if (phase === "hearing") void this.peekWords(epoch);
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
    const voice = this.voiceFile();
    if (voice) this.opts.voice.speaker.warm?.(voice);
    this.opts.voice.speaker.progress?.((info) => {
      if (epoch !== this.epoch) return;
      if (!info) {
        this.speechStartedAt = 0;
        this.speechDurationMs = 0;
        return;
      }
      this.speechStartedAt = info.startedAt;
      this.speechDurationMs = info.durationMs;
      if (this.phase === "speaking" && info.durationMs > 0) this.opts.send(this.get());
    });
    // What Viby starts or tells during the call comes up on screen, as it would for someone watching,
    // and what it has to say by itself is said here.
    service.orchestratorCall((word) => this.hear(word));
    this.opts.log.info("Call: started");
    this.changed();
    return this.get();
  }

  /** Mutes or unmutes the microphone during a call; returns the updated state. */
  mute(on?: boolean): CallState {
    if (!this.ear) return this.get();
    const next = on ?? !this.muted;
    if (next === this.muted) return this.get();
    this.muted = next;
    if (this.muted) {
      this.liveHeard = "";
      this.setDeaf(true);
      if (!this.busy) {
        this.phase = "listening";
        this.level = 0;
      }
    } else {
      const shouldListen = !this.busy || this.open || this.thinkingOpen;
      this.setDeaf(!shouldListen);
    }
    this.changed();
    return this.get();
  }

  /** Applies Voice settings changed mid-call: turning talk-back off silences Viby immediately. */
  syncSettings(): void {
    if (!this.ear) return;
    const service = this.opts.service();
    if (service) this.mode = service.getSettings().voice.talkOver;
    if (this.mode === "never") {
      this.open = false;
      this.thinkingOpen = false;
    }
    if (!this.muted) {
      const shouldListen = !this.busy || this.open || this.thinkingOpen;
      this.setDeaf(!shouldListen);
    }
    const voice = this.voiceFile();
    if (!voice) {
      this.opts.voice.speaker.unwarm?.();
      this.opts.voice.speaker.stop();
    } else {
      this.opts.voice.speaker.warm?.(voice);
    }
    this.changed();
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
    this.thinkingOpen = false;
    this.muted = false;
    this.earDeaf = false;
    this.hangingUp = false;
    this.liveHeard = "";
    this.peeking = false;
    this.speechStartedAt = 0;
    this.speechDurationMs = 0;
    this.opts.service()?.orchestratorCall(null);
    this.opts.voice.speaker.progress?.(null);
    this.error = error;
    this.phase = "listening";
    this.level = 0;
    // Hanging up cuts Viby off mid-sentence too, and lets the standby voice process go.
    this.opts.voice.speaker.unwarm?.();
    this.opts.voice.speaker.stop();
    this.opts.log.info(error ? `Call: ended, ${error}` : "Call: ended");
    this.changed();
  }

  /** Stream partial words while someone is mid-sentence when `whisper-server` is warm. */
  private async peekWords(epoch: number): Promise<void> {
    if (this.peeking || this.busy || this.muted || !this.ear?.peek || !this.opts.voice.transcribeLive) return;
    const now = Date.now();
    if (now - this.lastPeekAt < LIVE_PEEK_EVERY_MS) return;
    const pcm = this.ear.peek();
    if (pcm.length < LIVE_PEEK_MIN_BYTES) return;
    const service = this.opts.service();
    if (!service) return;
    this.peeking = true;
    this.lastPeekAt = now;
    try {
      const text = await this.opts.voice.transcribeLive(pcm, this.vocabulary(service));
      if (epoch !== this.epoch || this.busy || this.muted || this.phase !== "hearing") return;
      if (text && !phantom(text, pcm.length / BYTES_PER_SECOND) && text !== this.liveHeard) {
        this.liveHeard = text;
        this.opts.send(this.get());
      }
    } finally {
      this.peeking = false;
    }
  }

  /** Names whisper should expect: Viby, agents, CLIs, workspaces, branches, tasks, routines, and files in view. */
  private vocabulary(service: CallService): string {
    const workspaces = service.listWorkspaces().workspaces;
    const lookedId = this.opts.looking()?.workspaceId;
    const lookedPath = lookedId ? workspaces.find((item) => item.id === lookedId)?.path : undefined;
    let files: string[] = [];
    if (lookedPath) {
      try {
        files = fs.readdirSync(lookedPath).filter((name) => !name.startsWith(".")).slice(0, 25);
      } catch {
        /* folder unavailable */
      }
    }
    const copies = service.orchestratorView().copies ?? [];
    return vocabularyPrompt([
      "VibeForge",
      "Omarchy",
      "Hyprland",
      ...service.listAgents().map((agent) => agent.name),
      ...service.listEngines().map((engine) => engine.label),
      ...orchestratorVoiceWords(workspaces.map((item) => item.name)),
      ...copies.map((copy) => copy.name),
      ...(service.listTasks?.().slice(0, 15).map((task) => task.title) ?? []),
      ...(service.listRoutines?.().map((routine) => routine.name) ?? []),
      ...(service.listSkills?.().map((skill) => skill.name) ?? []),
      ...files,
    ]);
  }

  /**
   * Viby's turn to do something: the microphone is not listened to until it is over (unless talking
   * over is on), and what Viby had to say by itself meanwhile is said at its end.
   */
  private async turn(work: (live: () => boolean) => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    const live = () => epoch === this.epoch;
    this.busy = true;
    this.interrupted = false;
    this.thinkingOpen = false;
    this.setDeaf(true);
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
        this.thinkingOpen = false;
        this.setDeaf(false);
        this.move("listening");
      }
    }
  }

  private async answer(pcm: Buffer): Promise<void> {
    const service = this.opts.service();
    if (this.busy || !this.ear || !service || this.muted) return;
    const heardAt = Date.now();
    await this.turn(async (live) => {
      this.move("transcribing");
      const dictation = await this.opts.voice.transcribe(pcm, this.vocabulary(service), "call");
      this.liveHeard = "";
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
        if (dictation.text.trim().split(/\s+/).length >= 4) {
          await this.say(this.opts.words.say("call.bye"));
          if (!live() || this.interrupted) return;
        }
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
      if (service.orchestratorQuickAct) {
        const acted = await service.orchestratorQuickAct(dictation.text, this.opts.looking(), {
          going: this.opts.words.say("call.going"),
          cancelled: this.opts.words.say("call.cancelled"),
          opened: (name) => this.opts.words.say("call.opened", { name }),
        });
        if (!live()) return;
        if (acted.handled) {
          if (acted.reply) await this.say(acted.reply);
          return;
        }
      }
      const navTarget = service.orchestratorQuickShow ? quickNav(dictation.text) : null;
      if (navTarget && service.orchestratorQuickShow) {
        const shown = await service.orchestratorQuickShow(navTarget, dictation.text, (name) => this.opts.words.say("call.opened", { name }));
        if (!live()) return;
        if (shown) {
          await this.say(shown);
          return;
        }
      }
      this.hangingUp = false;
      this.thinkingOpen = this.canTalkOver() && !this.muted;
      if (this.thinkingOpen) this.setDeaf(false);
      this.move("thinking");
      await service.orchestratorAsk(dictation.text, this.opts.looking());
      this.thinkingOpen = false;
      if (!live() || this.interrupted) return;
      // No answer: it was stopped from its card or the call's own bar.
      const turn = answerTo(service.orchestratorView().turns);
      if (turn) await this.say(spokenAnswer(turn, { sayGo: this.opts.words.say("call.sayGo"), planReady: this.opts.words.say("call.planReady"), problem: this.opts.words.say("call.problem") }));
      if (live() && this.hangingUp && !this.interrupted) {
        this.hangingUp = false;
        this.stop();
      }
    });
  }

  /** Viby has something to say that nobody asked for just now: a CLI ended its turn, an answer was fetched to read out, or a plan asked to end the call. */
  private hear(word: VibyWord): void {
    if (!this.ear) return;
    if (word.kind === "hangup") {
      if (this.busy) {
        this.hangingUp = true;
      } else {
        this.stop();
      }
      return;
    }
    const { words } = this.opts;
    const line = spokenWord(
      word,
      {
        finished: (who) => words.say("orch.note.finished", who),
        ended: (who) => words.say("orch.note.ended", who),
        waiting: (who) => words.say("orch.note.waiting", who),
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

  /** The person started talking while Viby was thinking or speaking: it stops and listens. */
  private interrupt(): void {
    this.interrupted = true;
    this.hangingUp = false;
    this.opts.log.info("Call: talked over, Viby stopped");
    if (this.phase === "thinking") this.opts.service()?.orchestratorStopThinking?.(true);
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
    // Two quiet minutes let the standby voice go; it is a call still, so it comes back (and stays warm).
    this.opts.voice.speaker.warm?.(voice);
    const epoch = this.epoch;
    // Where Viby can't hear itself, the microphone stays open and talking over it stops it.
    this.open = this.canTalkOver() && !this.muted;
    this.setDeaf(!this.open);
    this.move("speaking");
    // Only what is said with the microphone open can come back through it.
    const spoke = { line, from: Date.now(), until: Number.POSITIVE_INFINITY };
    if (this.open) this.spokenLately.push(spoke);
    try {
      await this.opts.voice.speaker.speak(line, voice);
    } finally {
      spoke.until = Date.now();
      this.speechStartedAt = 0;
      this.speechDurationMs = 0;
    }
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
