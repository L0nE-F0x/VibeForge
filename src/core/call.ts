import type { OrchestratorTurn, VibyWord } from "../shared/orchestrator.js";
import { speakable } from "./replies.js";
import { floatFrame, VAD_FRAME, VAD_FRAME_BYTES, VAD_FRAME_MS, type SpeechDetector } from "./vad.js";
import { BYTES_PER_SECOND, Endpointer, FRAME_BYTES, meterLevel, rms } from "./voice.js";

// A call with Viby: the microphone stays open, each thing said is cut out of it and sent to Viby,
// and the answer is read aloud. Pure; electron/call.ts runs it and electron/voice.ts holds the mic.

const FRAME_MS = 30;
/** A pause this long ends what is being said. Longer than dictation's: people think mid-sentence when they talk to someone. */
export const CALL_SILENCE_MS = 900;
/** Audio kept from before speech was noticed, so the first syllable isn't lost. */
const PREROLL_MS = 450;
/** Of the pause that ended it, this much stays on the end; whisper needs no more. */
const TAIL_MS = 300;
/** One thing said is cut off here, so a room that never goes quiet can't fill memory. */
export const CALL_MAX_SECONDS = 90;

// With the speech detector: a frame is speech from this likelihood up, and quiet again below the
// lower one (Silero's own two thresholds, so a word's soft end doesn't flicker).
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
/** This much speech makes it someone speaking; less is a click, a key or a cough. */
const SPEECH_CONFIRM_MS = 3 * VAD_FRAME_MS;
/** A sound that never became speech is let go after this much quiet, long before a pause would end it. */
const BLIP_QUIET_MS = 320;

export interface Heard {
  /** Each thing said that ended in this stretch of audio, as 16 kHz mono s16le. */
  utterances: Buffer[];
  /** The loudest frame, for the meter: 0–1. */
  level: number;
  /** Someone is speaking right now. */
  hearing: boolean;
  /** How much speech the detector has heard in what is being said now; 0 when it listens by loudness. */
  speechMs: number;
}

/**
 * Cuts a microphone that never closes into the things said, with a little audio from before each
 * began. Silence between them is dropped as it arrives, so nothing but what was said is ever held.
 *
 * With a `detector` it listens for speech itself (the Silero model, src/core/vad.ts), which a
 * keyboard, a door or music doesn't set off. Without one it goes by loudness above the room's own
 * noise (the Endpointer), as before.
 */
export class Segmenter {
  private endpointer: Endpointer;
  private rest: Buffer = Buffer.alloc(0);
  private preroll: Buffer[] = [];
  private speech: Buffer[] = [];
  /** With the detector: something that may be speech is being kept, how much of it was, and how long it has been quiet since. */
  private talking = false;
  private voicedMs = 0;
  private quietMs = 0;
  private readonly samples = new Float32Array(VAD_FRAME);

  constructor(private readonly opts: { silenceMs?: number; maxSeconds?: number; detector?: SpeechDetector | null } = {}) {
    this.endpointer = this.fresh();
  }

  /** Whether it listens for speech itself, or goes by loudness. */
  get detects(): boolean {
    return Boolean(this.opts.detector);
  }

  private get silenceMs(): number {
    return this.opts.silenceMs ?? CALL_SILENCE_MS;
  }

  private fresh(): Endpointer {
    // A call has no "nobody spoke" timeout: it listens until it is hung up.
    return new Endpointer({ silenceMs: this.silenceMs, noSpeechMs: Number.POSITIVE_INFINITY });
  }

  /** Forget what was heard so far: after Viby has spoken, or while the mic is someone else's. */
  reset(): void {
    this.endpointer = this.fresh();
    this.rest = Buffer.alloc(0);
    this.preroll = [];
    this.speech = [];
    this.talking = false;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.opts.detector?.reset();
  }

  /** What was said, without most of the pause that ended it (`quietMs` of the frames at its end). */
  private take(quietMs: number, frameMs: number): Buffer {
    const drop = Math.max(0, Math.floor((quietMs - TAIL_MS) / frameMs));
    const frames = drop > 0 && this.speech.length > drop ? this.speech.slice(0, this.speech.length - drop) : this.speech;
    const utterance = Buffer.concat(frames);
    this.speech = [];
    this.preroll = [];
    this.talking = false;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.endpointer = this.fresh();
    return utterance;
  }

  push(chunk: Buffer): Heard {
    const detector = this.opts.detector ?? null;
    const frameBytes = detector ? VAD_FRAME_BYTES : FRAME_BYTES;
    const audio = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const whole = audio.length - (audio.length % frameBytes);
    // Copied: the chunk belongs to the stream that handed it over.
    this.rest = Buffer.from(audio.subarray(whole));
    const utterances: Buffer[] = [];
    const maxFrames = Math.floor(((this.opts.maxSeconds ?? CALL_MAX_SECONDS) * BYTES_PER_SECOND) / frameBytes);
    let loudest = 0;
    for (let start = 0; start < whole; start += frameBytes) {
      const frame = Buffer.from(audio.subarray(start, start + frameBytes));
      const loudness = rms(frame);
      loudest = Math.max(loudest, loudness);
      if (detector) {
        this.listen(detector.probability(floatFrame(frame, this.samples)), frame, maxFrames, utterances);
        continue;
      }
      const before = this.endpointer.phase;
      const phase = this.endpointer.push(loudness, FRAME_MS);
      if (phase === "waiting") {
        this.preroll.push(frame);
        if (this.preroll.length > PREROLL_MS / FRAME_MS) this.preroll.shift();
        continue;
      }
      if (before === "waiting") {
        this.speech = this.preroll;
        this.preroll = [];
      }
      this.speech.push(frame);
      if (phase === "ended" || this.speech.length >= maxFrames) utterances.push(this.take(phase === "ended" ? this.silenceMs : 0, FRAME_MS));
    }
    if (detector) {
      const hearing = this.talking && this.voicedMs >= SPEECH_CONFIRM_MS;
      return { utterances, level: meterLevel(loudest), hearing, speechMs: hearing ? this.voicedMs : 0 };
    }
    return { utterances, level: meterLevel(loudest), hearing: this.endpointer.phase === "speaking", speechMs: 0 };
  }

  /** One frame, by how likely the detector finds it to be speech. */
  private listen(likely: number, frame: Buffer, maxFrames: number, utterances: Buffer[]): void {
    const keep = Math.ceil(PREROLL_MS / VAD_FRAME_MS);
    if (!this.talking) {
      if (likely < SPEECH_ON) {
        this.preroll.push(frame);
        if (this.preroll.length > keep) this.preroll.shift();
        return;
      }
      this.talking = true;
      this.speech = this.preroll;
      this.preroll = [];
      this.voicedMs = 0;
      this.quietMs = 0;
    }
    this.speech.push(frame);
    if (likely >= SPEECH_ON) {
      this.voicedMs += VAD_FRAME_MS;
      this.quietMs = 0;
    } else if (likely < SPEECH_OFF) this.quietMs += VAD_FRAME_MS;
    const said = this.voicedMs >= SPEECH_CONFIRM_MS;
    if (!said && this.quietMs >= BLIP_QUIET_MS) {
      // Never became speech: what was kept goes back to being the moment before the next thing said.
      this.preroll = this.speech.slice(-keep);
      this.speech = [];
      this.talking = false;
      this.voicedMs = 0;
      this.quietMs = 0;
      return;
    }
    if ((said && this.quietMs >= this.silenceMs) || this.speech.length >= maxFrames) utterances.push(this.take(this.quietMs, VAD_FRAME_MS));
  }
}

// ------------------------------------------------------------------ words answered at once

/**
 * Said on its own, these never go to the planner: they answer a waiting plan, end the call, or
 * ("hush") only ask Viby to stop talking, which talking over it has already done.
 */
export type CallWord = "go" | "cancel" | "hangup" | "hush";

/** Lower case, without punctuation, so "Go ahead." and "go ahead" are the same thing said. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// In each language the window speaks. Whole things said, never words inside a longer sentence:
// "go to the api workspace" is for Viby.
const WORDS: Record<CallWord, string[]> = {
  go: [
    ...["go", "go ahead", "yes", "yes go", "yes please", "yeah", "yep", "do it", "ok", "okay", "ok go", "okay go", "confirm", "sure", "go for it"],
    ...["los", "leg los", "ja", "mach", "mach das", "mach es", "ausführen", "bestätigen"],
    ...["adelante", "sí", "si", "hazlo", "vale", "dale", "confirmar", "de acuerdo"],
    ...["vas-y", "oui", "fais-le", "d'accord", "allez", "confirmer"],
    ...["vai", "sim", "pode ir", "faz isso", "manda"],
    ...["はい", "実行", "実行して", "お願い", "お願いします", "やって", "オーケー"],
    ...["好", "好的", "开始", "执行", "确认", "可以", "是"],
  ],
  cancel: [
    ...["cancel", "cancel that", "no", "nope", "never mind", "nevermind", "forget it", "don't", "stop", "scrap that"],
    ...["abbrechen", "nein", "vergiss es", "stopp", "doch nicht"],
    ...["cancelar", "cancela", "olvídalo", "déjalo"],
    ...["annuler", "annule", "non", "laisse tomber", "oublie"],
    ...["não", "esquece", "deixa"],
    ...["キャンセル", "いいえ", "やめて", "中止", "やめる"],
    ...["取消", "不", "不要", "算了", "停"],
  ],
  hangup: [
    ...["hang up", "end call", "end the call", "goodbye"],
    ...["auflegen", "anruf beenden", "tschüss", "auf wiedersehen"],
    ...["colgar", "cuelga", "terminar llamada", "adiós"],
    ...["raccrocher", "raccroche", "au revoir"],
    ...["desligar", "desliga", "encerrar chamada", "tchau", "adeus"],
    ...["切って", "電話を切って", "通話終了", "さようなら"],
    ...["挂断", "结束通话", "再见"],
  ],
  // None of these is also a way to say cancel: a later list would take the word from an earlier one.
  hush: [
    ...["enough", "thats enough", "ok thats enough", "okay thats enough", "quiet", "be quiet", "shut up", "wait", "hold on", "got it", "ok got it", "okay got it", "stop talking", "stop reading"],
    ...["genug", "das reicht", "ruhe", "sei still", "warte", "moment", "verstanden"],
    ...["basta", "ya basta", "silencio", "cállate", "espera", "entendido"],
    ...["assez", "ça suffit", "silence", "tais-toi", "attends", "compris"],
    ...["chega", "já chega", "silêncio", "cala-te", "espera aí", "entendi"],
    ...["もういい", "静かに", "黙って", "待って", "わかった"],
    ...["够了", "安静", "别说了", "等一下", "知道了"],
  ],
};

const WORD_OF = new Map<string, CallWord>((Object.entries(WORDS) as Array<[CallWord, string[]]>).flatMap(([word, list]) => list.map((item) => [plain(item), word] as [string, CallWord])));

/** Viby's name at either end ("Viby, go ahead", "cancel that, Vibey") is the person being polite, not part of the word. */
const NAME = /^(?:hey |ok |okay )?(?:viby|vibey|vibe|maestro)\s+|\s+(?:viby|vibey|vibe|maestro|please)$/g;

export function callWord(said: string): CallWord | null {
  const text = plain(said);
  return WORD_OF.get(text) ?? WORD_OF.get(text.replace(NAME, "").trim()) ?? null;
}

// Whisper writes these for a cough, a click or a chair: the endings of the videos it learned from.
const PHANTOMS = new Set(
  [
    ...["thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching", "you", "bye", "bye bye", "the", "so", "uh", "um", "hmm", "oh", "i"],
    ...["vielen dank", "danke", "gracias", "merci", "obrigado", "obrigada", "ご視聴ありがとうございました", "谢谢", "谢谢观看", "謝謝"],
  ].map(plain),
);

/** Words whisper made up for a short noise, which a call must not pass on as something said. */
export function phantom(said: string, seconds: number): boolean {
  const text = plain(said);
  if (!text) return true;
  // The credit line of a subtitle file, in whichever language.
  if (/amara org|subtitles by|untertitel/.test(text)) return true;
  return seconds < 3 && PHANTOMS.has(text);
}

// ------------------------------------------------------------------ talking over Viby

/** This much speech while Viby is talking stops it: a word, not a cough or a key. */
export const TALK_OVER_MS = 250;

/**
 * When the speech in something heard began, from when it arrived and how long its audio is: the
 * audio starts a little before the speech and ends a little after it, and it arrived once the
 * pause that ended it was over.
 */
export function speechBegan(heardAt: number, seconds: number, silenceMs = CALL_SILENCE_MS): number {
  return heardAt - seconds * 1000 - (silenceMs - TAIL_MS - PREROLL_MS);
}

/**
 * Whether what was heard is Viby's own voice coming back through the speakers: half or more of
 * its words, in order, are words Viby was saying then (whisper mishears some of an echo). So "go" said over "Say go, or cancel" counts as an
 * echo too, and has to be said again once Viby is quiet; better that than Viby approving its own
 * plan. `words` is how many were heard: three or more in a row are no coincidence.
 */
export function echoes(heard: string, spoken: string): { echo: boolean; words: number } {
  const said = plain(heard).split(" ").filter(Boolean);
  const line = plain(spoken).split(" ").filter(Boolean);
  if (!said.length || !line.length) return { echo: false, words: said.length };
  // The longest run of heard words found in order in the line (a subsequence).
  const best = new Array<number>(line.length + 1).fill(0);
  for (const word of said) {
    let before = 0;
    for (let j = 1; j <= line.length; j += 1) {
      const kept = best[j];
      best[j] = word === line[j - 1] ? before + 1 : Math.max(best[j], best[j - 1]);
      before = kept;
    }
  }
  return { echo: best[line.length] / said.length >= 0.5, words: said.length };
}

// ------------------------------------------------------------------ what Viby says

export interface CallLines {
  /** After a plan that waits: "Say go, or cancel." */
  sayGo: string;
  /** A plan with nothing said about it. */
  planReady: string;
  /** The planner's answer went wrong. */
  problem: string;
}

/**
 * Viby's answer to the last thing the person said: the newest of its turns after theirs, leaving
 * out VibeForge's own notes about a CLI. Null when there is none (the answer was stopped).
 */
export function answerTo(turns: readonly OrchestratorTurn[]): OrchestratorTurn | null {
  const asked = turns.findLastIndex((turn) => turn.from === "you");
  if (asked < 0) return null;
  return (
    turns
      .slice(asked + 1)
      .filter((turn) => turn.from === "vibeforge" && !turn.note)
      .at(-1) ?? null
  );
}

/** The plan that a spoken "go" or "cancel" answers: the one still waiting. */
export function waitingPlan(turns: readonly OrchestratorTurn[]): OrchestratorTurn | null {
  return turns.findLast((turn) => turn.plan === "waiting") ?? null;
}

/** An answer as it is said out loud: its words, and how to answer a plan that waits for Go. */
export function spokenAnswer(turn: OrchestratorTurn, lines: CallLines): string {
  if (turn.problem) return lines.problem;
  const text = turn.text.trim();
  if (turn.plan === "waiting") return `${text || lines.planReady} ${lines.sayGo}`;
  return text;
}

// ------------------------------------------------------------------ what Viby says by itself

/** The start of an answer that is read out unless all of it was asked for: about a minute of speech. */
export const READ_START = 900;

export interface WordLines {
  /** "{engine} in {workspace} finished its turn." and "… closed." */
  finished: (who: { engine: string; workspace: string }) => string;
  ended: (who: { engine: string; workspace: string }) => string;
  /** "It says: {reply}" */
  says: (reply: string) => string;
  /** A git summary ("2 commits · 3 files changed") in the person's language. */
  changes: (summary: string) => string;
  /** After the start of an answer that goes on: how to hear the rest. */
  more: string;
  /** In place of an answer that could only be taken from a CLI's screen, which has more on it than the answer. */
  fromScreen: string;
}

/** "VibeForge · fix-tray" as it is said: the dot between the parts is a pause, not a word. */
const aloud = (text: string) => text.replace(/\s+·\s+/g, ", ");

/**
 * What Viby says without being asked, as one thing to say: a note about a CLI with the start of
 * its answer, or the answer a read step fetched (its start, or within reason all of it). With
 * `brief`, for a call that can only show its words, an answer is cut to its first paragraph.
 */
export function spokenWord(word: VibyWord, lines: WordLines, brief = false): string {
  if (word.kind === "note") {
    const who = { engine: word.note.engine, workspace: aloud(word.note.workspace) };
    const parts = [word.note.kind === "finished" ? lines.finished(who) : lines.ended(who)];
    if (word.note.changes) parts.push(`${aloud(lines.changes(word.note.changes))}.`);
    if (word.note.reply) parts.push(lines.says(word.note.reply));
    return parts.join(" ");
  }
  // A screen holds the CLI's frame and prompt box too: that is for the eye, on the plan's card.
  if (word.fromScreen) return lines.fromScreen;
  if (brief) return speakable(word.reply, "summary");
  const all = speakable(word.reply, "full");
  const said = word.all ? all : speakable(word.reply, "full", READ_START);
  return said.length < all.length ? `${said} ${lines.more}` : said;
}
