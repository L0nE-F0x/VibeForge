import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describeError, type LogFile } from "../src/core/log.js";
import { parseControl, parseTalkRequest, prepareSocketDir, TALK_REQUEST_MAX, type TalkRequest, type VoiceAction } from "../src/core/control.js";

const VOICE_LINE_MAX = 4096;

/**
 * Listens on the control socket for "voice …" lines from `vibeforge --voice …`, and for one-line
 * JSON requests from `vibeforge tell|who|task`, which get one JSON line back.
 */
export function listenControl(
  socketPath: string,
  log: LogFile,
  onVoice: (action: VoiceAction) => void,
  /** `gone` aborts when the asker hangs up before its answer (a CLI's tool timed out, say). */
  onTalk: (request: TalkRequest, gone: AbortSignal) => Promise<unknown>,
): () => void {
  if (!prepareSocketDir(socketPath, process.getuid?.() ?? 0)) {
    log.warn(`Control socket: ${path.dirname(socketPath)} belongs to someone else, so VibeForge doesn't listen there`);
    return () => undefined;
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    let answering = false;
    let answered = false;
    const gone = new AbortController();
    socket.on("close", () => {
      if (!answered) gone.abort();
    });
    socket.setEncoding("utf8");
    const handle = (line: string) => {
      if (!line.trim().startsWith("{")) {
        const action = parseControl(line);
        if (action) onVoice(action);
        return;
      }
      if (answering) return;
      answering = true;
      const request = parseTalkRequest(line);
      const reply = request ? onTalk(request, gone.signal).catch((error: unknown) => ({ ok: false, error: describeError(error) })) : Promise.resolve({ ok: false, error: "That request isn't one VibeForge knows." });
      void reply.then((answer) => {
        answered = true;
        if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
      });
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > (buffer.trimStart().startsWith("{") ? TALK_REQUEST_MAX + 4096 : VOICE_LINE_MAX)) socket.destroy();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handle(line);
      }
    });
    socket.on("end", () => {
      if (buffer.trim()) handle(buffer);
    });
    socket.on("error", () => undefined);
  });
  server.on("error", (error) => log.warn(`Control socket: ${describeError(error)}`));
  let stopped = false;
  let listening = false;
  // A socket file left by a crashed run would make listen fail, so it is cleared first, but only
  // once nothing answers on it: a VibeForge started with another profile and the same data folder
  // would otherwise lose its socket to this one.
  void answers(socketPath).then((taken) => {
    if (stopped) return;
    if (taken) {
      log.warn(`Control socket: another VibeForge is listening at ${socketPath} (the same data folder), so this one doesn't`);
      return;
    }
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* not there */
    }
    listening = true;
    server.listen(socketPath, () => {
      // Only this user may drive the microphone or talk to the terminals. The runtime folder is private already; this is belt and braces.
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        /* best effort */
      }
    });
  });
  return () => {
    stopped = true;
    if (!listening) return;
    server.close();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/** Whether something is listening on a socket path now; false for a file nothing answers on. */
export function answers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect(socketPath);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
