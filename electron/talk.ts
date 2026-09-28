import os from "node:os";
import { describeError, type LogFile } from "../src/core/log.js";
import { replyLogFor, speakable, type TalkBack } from "../src/core/replies.js";
import type { TeamService } from "../src/core/team-service.js";
import type { TalkEvent } from "../src/shared/api.js";
import { watchReply } from "./replies.js";
import type { Voice } from "./voice.js";

interface Expectation {
  who: string;
  voice: string;
  abort: AbortController;
}

/**
 * Agents answering out loud. After a dictated message is sent to a terminal, waits for the answer
 * in the CLI's session log and reads its first paragraph in the agent's voice. A program with no
 * readable log stays quiet.
 */
export class Talk {
  private expecting = new Map<string, Expectation>();

  constructor(
    private readonly opts: {
      voice: Voice;
      service: () => TeamService | null;
      log: LogFile;
      send: (event: TalkEvent) => void;
    },
  ) {}

  expect(ptyId: string, words: string): boolean {
    const service = this.opts.service();
    const session = service?.listLive().find((item) => item.ptyId === ptyId);
    if (!service || !session) return false;
    let engineId: string;
    let who: string;
    let voice = "";
    let cwd = session.cwd;
    if (session.kind === "run" && session.runId) {
      const run = service.getRun(session.runId).run;
      const agent = run.agentId ? service.listAgents().find((item) => item.id === run.agentId) : undefined;
      engineId = run.engine;
      who = agent?.name ?? session.title;
      voice = agent?.voice ?? "";
    } else if (session.kind === "shell" && session.programEngineId) {
      // `claude` typed at a shell prompt answers in the same session log as one VibeForge started.
      engineId = session.programEngineId;
      who = session.program ?? session.title;
      cwd = session.programCwd ?? session.cwd;
    } else {
      return false;
    }
    const engine = service.listEngines().find((item) => item.id === engineId);
    const kind = replyLogFor(engineId, engine?.bin ?? engineId);
    // Without a session log there is nothing to read, so stay quiet. "Has finished" is a notification already.
    if (!kind) return false;

    this.forget(ptyId, false);
    const expectation: Expectation = { who, voice, abort: new AbortController() };
    this.expecting.set(ptyId, expectation);
    this.opts.send({ ptyId, stage: "waiting", who, text: "" });

    const since = Date.now() - 2000;
    void watchReply({ kind, home: os.homedir(), cwd, since, words, signal: expectation.abort.signal })
      .then(async (reply) => {
        if (this.expecting.get(ptyId) !== expectation) return;
        this.expecting.delete(ptyId);
        if (reply === null) {
          this.opts.send({ ptyId, stage: "done", who, text: "" });
          return;
        }
        this.opts.log.info(`Voice: ${kind} answered in ${session.title} (${reply.length} characters)`);
        await this.say(ptyId, who, reply, expectation.voice);
      })
      .catch((error: unknown) => {
        this.opts.log.warn(`Voice: waiting for an answer failed: ${describeError(error)}`);
        this.opts.send({ ptyId, stage: "done", who, text: "" });
      });
    return true;
  }

  /** Reads a reply aloud: the first paragraph when talk-back is on, unless `mode` says otherwise. */
  async say(ptyId: string | null, who: string, markdown: string, voice = "", mode?: TalkBack): Promise<void> {
    const chosen = mode ?? (this.opts.service()?.getSettings().voice.talkBack ? "summary" : "off");
    const text = speakable(markdown, chosen);
    const file = this.opts.voice.voiceFor(voice);
    if (text && file && this.opts.voice.speaker.piper()) {
      this.opts.send({ ptyId, stage: "speaking", who, text });
      await this.opts.voice.speaker.speak(text, file);
    }
    this.opts.send({ ptyId, stage: "done", who, text: speakable(markdown, "summary") });
  }

  /** The program in `ptyId` ended before its log had an answer: stop waiting, and don't invent one. */
  async exited(ptyId: string): Promise<void> {
    const expectation = this.expecting.get(ptyId);
    if (!expectation) return;
    this.expecting.delete(ptyId);
    expectation.abort.abort();
    this.opts.send({ ptyId, stage: "done", who: expectation.who, text: "" });
  }

  forget(ptyId?: string, announce = true): void {
    for (const [id, expectation] of this.expecting) {
      if (ptyId && id !== ptyId) continue;
      expectation.abort.abort();
      this.expecting.delete(id);
      if (announce) this.opts.send({ ptyId: id, stage: "done", who: expectation.who, text: "" });
    }
  }

  dispose(): void {
    this.forget(undefined, false);
  }
}
