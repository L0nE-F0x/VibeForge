import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whichBin } from "../src/core/engines.js";
import { describeError } from "../src/core/log.js";
import type { DeskHost } from "../src/core/team-service.js";
import { gitHead, snapshotGit } from "../src/core/vcs.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";
import { lastReply, watchReply } from "./replies.js";
import { childEnv } from "./shell-env.js";
import type { Talk } from "./talk.js";
import type { Voice } from "./voice.js";

// The terminal host (electron/pty-host.cjs) owns every terminal. This starts it, relays what it
// says to the page and the core, and brings it back when it crashes, unless it keeps crashing or
// VibeForge is quitting.

/** The core's way to the terminals, git and the desktop. */
export function deskHost(ctx: MainContext, notify: Notify): DeskHost {
  const { supervisor, log, words, send } = ctx;
  return {
    spawn: async (request) => {
      // The program's name only: the rest of the command line can hold a prompt.
      const program = path.basename(request.argv[0] ?? "?");
      try {
        const spawned = await supervisor.spawn(request);
        log.info(`Terminal ${spawned.ptyId} started: ${program} in ${request.cwd}`);
        return spawned;
      } catch (error) {
        log.error(`Could not start ${program} in ${request.cwd}: ${describeError(error)}`);
        throw error;
      }
    },
    send: (ptyId, text, enter) => supervisor.send(ptyId, text, enter),
    screen: (ptyId) => supervisor.screen(ptyId),
    watchReply: (opts) => watchReply({ ...opts, home: os.homedir() }),
    lastReply: async (opts) => lastReply({ ...opts, home: os.homedir() }),
    kill: (ptyId) => supervisor.kill(ptyId),
    record: (ptyId, runDir) => supervisor.record(ptyId, runDir),
    resolveBin: (bin) => whichBin(bin),
    // The core speaks English; its notes are put in the window's language here.
    notify: (note) => notify({ ...note, body: words.coreText(note.body) }),
    finished: (run) => send("run-finished", run),
    snapshotGit: (cwd, startHead) => snapshotGit(cwd, 5000, startHead),
    gitHead: (cwd) => gitHead(cwd),
    // Maestro's show step: the page goes there as it does for a clicked notification.
    show: (route) => {
      send("open-route", { route });
      if (ctx.win && !ctx.win.isDestroyed()) {
        if (!ctx.win.isVisible()) ctx.win.show();
        ctx.win.focus();
      }
    },
  };
}

/**
 * What every terminal starts with: the control socket, and `vibeforge` on PATH (a link to
 * scripts/vibeforge in the data folder), so a CLI in any terminal can run `vibeforge tell`.
 */
export function terminalEnv(ctx: MainContext, controlSocket: string): NodeJS.ProcessEnv {
  const env = childEnv(process.env);
  env.VIBEFORGE_SOCKET = controlSocket;
  const bin = path.join(ctx.roots.dataRoot, "bin");
  const target = path.join(ctx.appRoot, "scripts", "vibeforge");
  try {
    fs.mkdirSync(bin, { recursive: true });
    const link = path.join(bin, "vibeforge");
    let current: string | null = null;
    try {
      current = fs.readlinkSync(link);
    } catch {
      /* not made yet */
    }
    if (fs.existsSync(target) && current !== target) {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(target, link);
    }
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
  } catch (error) {
    ctx.log.warn(`Could not put vibeforge on the terminals' PATH: ${describeError(error)}`);
  }
  return env;
}

/** Lines of the host's stderr logged in a minute. */
const STDERR_PER_MINUTE = 20;

/** When the host last crashed, so one that keeps crashing isn't brought back forever. */
export class CrashCount {
  private crashes: number[] = [];

  constructor(private readonly windowMs = 5 * 60_000) {}

  /** Counts a crash at `now`; how many fell within the window, this one included. */
  add(now: number): number {
    this.crashes = [...this.crashes.filter((at) => now - at < this.windowMs), now];
    return this.crashes.length;
  }
}

export class HostLifecycle {
  private hostError: string | null = null;
  private readonly crashes = new CrashCount();

  constructor(
    private readonly ctx: MainContext,
    private readonly parts: { voice: Pick<Voice, "controlSocket">; talk: Pick<Talk, "exited"> },
  ) {}

  /** Why the terminal host is down, for a page that loads after it happened. */
  get error(): string | null {
    return this.hostError;
  }

  async start(): Promise<void> {
    try {
      await this.ctx.supervisor.start(this.ctx.appRoot, terminalEnv(this.ctx, this.parts.voice.controlSocket));
      this.hostError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      this.ctx.log.error(`The terminal host did not start: ${message}`);
      this.hostError = message;
      this.ctx.send("host-crash", message);
    }
  }

  /** Passes the host's events on to the page and the core, and brings a crashed host back. */
  wire(): void {
    const { ctx } = this;
    const { supervisor, log, send } = ctx;
    // What the host says on stderr goes in the log, so a crash has its reason there; a host that
    // says a lot is cut down to a few lines a minute.
    let said = 0;
    let since = 0;
    supervisor.onStderr.add((line) => {
      const now = Date.now();
      if (now - since > 60_000) {
        since = now;
        said = 0;
      }
      said += 1;
      if (said <= STDERR_PER_MINUTE) log.warn(`Terminal host: ${line}`);
      else if (said === STDERR_PER_MINUTE + 1) log.warn("Terminal host: more on stderr this minute, not logged");
    });
    supervisor.onData.add((event) => send("pty-data", event));
    supervisor.onExit.add((event) => {
      log.info(`Terminal ${event.ptyId} ended (${event.signal ? `signal ${event.signal}` : `exit code ${event.exitCode ?? "?"}`})`);
      send("pty-exit", event);
      this.ended(event.ptyId, event.exitCode, event.signal);
    });
    supervisor.onProgram.add((event) => ctx.service?.onPtyProgram(event.ptyId, event.argv, event.cwd));
    supervisor.onActivity.add((event) => ctx.service?.onPtyActivity(event.ptyId, event.working));
    supervisor.onCrash.add((message) => {
      // The supervisor's message already says so: "The terminal host stopped (SIGKILL)."
      log.error(message);
      // Every terminal died with the host. Record them, then bring the host back.
      for (const session of ctx.service?.listLive() ?? []) {
        log.info(`Terminal ${session.ptyId} ended (the terminal host stopped)`);
        // The page too, or an open pane goes on looking live while every key typed there is lost.
        send("pty-exit", { ptyId: session.ptyId, exitCode: null, signal: null });
        this.ended(session.ptyId, null, null);
      }
      // Once quitting has begun the host stays down: a new one would start halfway through the quit.
      if (ctx.quitting) return;
      const count = this.crashes.add(Date.now());
      if (count > 3) {
        log.error("The terminal host keeps stopping; it stays off until VibeForge restarts");
        this.hostError = `${message} It stopped ${count} times in five minutes, so it stays off: restart VibeForge.`;
        send("host-crash", this.hostError);
        return;
      }
      send("host-crash", message);
      setTimeout(() => {
        if (!ctx.quitting) void this.start();
      }, 1000);
    });
  }

  /** A terminal is over, however it ended: the core records it, then a spoken-answer wait on it ends. */
  private ended(ptyId: string, exitCode: number | null, signal: number | null): void {
    void this.ctx.service?.onPtyExit(ptyId, exitCode, signal).then(() => this.parts.talk.exited(ptyId));
  }
}
