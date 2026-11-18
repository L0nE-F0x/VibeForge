import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describeError, type LogFile } from "../src/core/log.js";
import { ECHO_SOURCE, echoCancelConf } from "../src/core/voice.js";

/** How long PipeWire gets to offer the echo-cancelled microphone before a call goes on without it. */
const READY_MS = 3000;
const POLL_MS = 100;

export interface EchoCancel {
  /** The node to record from. */
  target: string;
  /** Still running: PipeWire's canceller can end by itself (the sound server restarted). */
  readonly running: boolean;
  stop(): void;
}

/**
 * Echo cancellation for a call, by PipeWire itself: a `pipewire` client of our own that runs the
 * echo-cancel module (src/core/voice.ts, echoCancelConf) for as long as the call lasts. Null when
 * this machine can't (no PipeWire, no such module, or it didn't come up in time); the call then
 * records the microphone as it is.
 *
 * The client ends when the call does. A small guard beside it waits on a pipe from us and ends it
 * if VibeForge itself is killed, so nothing is left holding the microphone.
 */
export async function startEchoCancel(opts: { resolveBin: (bin: string) => string | null; dir: string; log: LogFile; readyMs?: number }): Promise<EchoCancel | null> {
  const pipewire = opts.resolveBin("pipewire");
  const pwCli = opts.resolveBin("pw-cli");
  if (!pipewire || !pwCli) return null;
  const conf = path.join(opts.dir, "echo-cancel.conf");
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    fs.writeFileSync(conf, echoCancelConf());
  } catch (error) {
    opts.log.warn(`Voice: echo cancellation not started: ${describeError(error)}`);
    return null;
  }
  const started = Date.now();
  const client = spawn(pipewire, ["-c", conf], { stdio: "ignore" });
  let running = client.pid !== undefined;
  // Ends the client if VibeForge is killed: it waits on a pipe from us, which closes when we go.
  const guard = running ? spawn("/bin/sh", ["-c", 'cat >/dev/null; kill "$0" 2>/dev/null', String(client.pid)], { stdio: ["pipe", "ignore", "ignore"] }) : null;
  guard?.on("error", () => undefined);
  guard?.stdin?.on("error", () => undefined);
  const ended = () => {
    if (!running) return;
    running = false;
    // The guard goes first, so it can't end some later process that got the client's number.
    guard?.kill("SIGKILL");
    guard?.stdin?.destroy();
  };
  client.on("error", ended);
  client.on("exit", ended);
  const stop = () => {
    if (running) client.kill("SIGTERM");
  };
  const offered = () =>
    new Promise<boolean>((resolve) => {
      execFile(pwCli, ["ls", "Node"], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(!error && String(stdout).includes(`node.name = "${ECHO_SOURCE}"`)));
    });
  while (running && Date.now() - started < (opts.readyMs ?? READY_MS)) {
    if (await offered()) {
      opts.log.info(`Voice: echo cancellation ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return {
        target: ECHO_SOURCE,
        get running() {
          return running;
        },
        stop,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  opts.log.warn(`Voice: echo cancellation did not start (${running ? "PipeWire didn't offer it in time" : "its PipeWire client ended"})`);
  stop();
  return null;
}
