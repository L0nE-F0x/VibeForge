import os from "node:os";
import { describeError, type LogFile } from "../src/core/log.js";
import { replyLogFor, speakable } from "../src/core/replies.js";
import type { TeamService } from "../src/core/team-service.js";
import type { TalkEvent } from "../src/shared/api.js";
import { watchReply } from "./replies.js";
import type { Voice } from "./voice.js";

interface Expectation {
  /** Null for a CLI typed into a shell: there is no run to report on. */
  runId: string | null;
  who: string;
  voice: string;
  abort: AbortController;
  /** No log to read: say something when the program ends instead. */
  atExit: boolean;
}

/**
 * Agents answering out loud. After something is said to a terminal, waits for the answer in the
 * CLI's session log and reads it (or its first paragraph) in the agent's voice. For CLIs without a
 * readable log, says when the run ends and what changed.
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
    let runId: string | null = null;
    let engineId: string;
    let who: string;
    let voice = "";
    let cwd = session.cwd;
    if (session.kind === "run" && session.runId) {
      const run = service.getRun(session.runId).run;
      const agent = run.agentId ? service.listAgents().find((item) => item.id === run.agentId) : undefined;
      runId = session.runId;
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
    // A shell outlives the CLI in it, so without a log there is nothing to wait for.
    if (!kind && !runId) return false;

    this.forget(ptyId, false);
    const expectation: Expectation = { runId, who, voice, abort: new AbortController(), atExit: !kind };
    this.expecting.set(ptyId, expectation);
    this.opts.send({ ptyId, stage: "waiting", who, text: "" });
    if (!kind) return true;

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

  /** Reads a reply aloud as Settings says (summary, full, or not at all), with events either side. */
  async say(ptyId: string | null, who: string, markdown: string, voice = "", mode = this.opts.service()?.getSettings().voice.talkBack ?? "summary"): Promise<void> {
    const text = speakable(markdown, mode);
    const file = this.opts.voice.voiceFor(voice);
    if (text && file && this.opts.voice.speaker.piper()) {
      this.opts.send({ ptyId, stage: "speaking", who, text });
      await this.opts.voice.speaker.speak(text, file);
    }
    this.opts.send({ ptyId, stage: "done", who, text: speakable(markdown, "summary") });
  }

  /** The program in `ptyId` ended: for one with no log, say so. */
  async exited(ptyId: string): Promise<void> {
    const expectation = this.expecting.get(ptyId);
    if (!expectation) return;
    this.expecting.delete(ptyId);
    expectation.abort.abort();
    if (!expectation.atExit) {
      this.opts.send({ ptyId, stage: "done", who: expectation.who, text: "" });
      return;
    }
    let changes = "";
    try {
      const run = expectation.runId ? this.opts.service()?.getRun(expectation.runId).run : undefined;
      // "1 file changed, 1 insertion(+)" reads better without the signs.
      if (run?.changes) changes = ` ${run.changes.replace(/\s*\([+-]\)/g, "")}.`;
    } catch {
      /* the run is gone */
    }
    await this.say(ptyId, expectation.who, `${expectation.who} has finished.${changes}`, expectation.voice, "full");
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
