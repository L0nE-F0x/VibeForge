import fs from "node:fs";
import net from "node:net";
import { describeError, type LogFile } from "../src/core/log.js";
import { parseControl, parseTalkRequest, TALK_REQUEST_MAX, type TalkRequest, type VoiceAction } from "../src/core/control.js";

const VOICE_LINE_MAX = 4096;

/**
 * Listens on the control socket for "voice …" lines from `vibeforge --voice …`, and for one-line
 * JSON requests from `vibeforge tell|who|task`, which get one JSON line back.
 */
export function listenControl(
  socketPath: string,
  log: LogFile,
  onVoice: (action: VoiceAction) => void,
  onTalk: (request: TalkRequest) => Promise<unknown>,
): () => void {
  // A socket left by a crashed run would make listen fail; nothing else could be using this path.
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    /* not there */
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    let answering = false;
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
      const reply = request ? onTalk(request).catch((error: unknown) => ({ ok: false, error: describeError(error) })) : Promise.resolve({ ok: false, error: "That request isn't one VibeForge knows." });
      void reply.then((answer) => {
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
  server.listen(socketPath, () => {
    // Only this user may drive the microphone or talk to the terminals. The runtime folder is private already; this is belt and braces.
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* best effort */
    }
  });
  return () => {
    server.close();
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* already gone */
    }
  };
}
