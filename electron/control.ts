import fs from "node:fs";
import net from "node:net";
import { describeError, type LogFile } from "../src/core/log.js";
import { parseControl, type VoiceAction } from "../src/core/control.js";

/** Listens on the control socket for "voice …" lines from `vibeforge --voice …`. */
export function listenControl(socketPath: string, log: LogFile, onVoice: (action: VoiceAction) => void): () => void {
  // A socket left by a crashed run would make listen fail; nothing else could be using this path.
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    /* not there */
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4096) socket.destroy();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const action = parseControl(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (action) onVoice(action);
      }
    });
    socket.on("end", () => {
      const action = parseControl(buffer);
      if (action) onVoice(action);
    });
    socket.on("error", () => undefined);
  });
  server.on("error", (error) => log.warn(`Control socket: ${describeError(error)}`));
  server.listen(socketPath, () => {
    // Only this user may drive the microphone. The runtime folder is private already; this is belt and braces.
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
