import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { companionStatus, stopCompanion, syncCompanion, type CompanionWire } from "../../electron/companion.js";
import { newCompanionToken } from "../../src/core/companion.js";
import { startCompanionHttp, type CompanionActions } from "../../src/core/companion-http.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-phone-http-"));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fails the test instead of hanging it: the bug was a close that never came back. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([work, delay(ms).then(() => Promise.reject(new Error(`still waiting after ${ms} ms`)))]);
}

function actions(patch: Partial<CompanionActions> = {}): CompanionActions {
  return {
    desk: () => ({ nudges: [], agents: [], engines: [], workspaces: [] }),
    session: async () => ({ ptyId: "p", runId: "r", title: "", detail: "", state: "waiting", changes: null, screen: "", canSend: true, stop: "end" }),
    send: async () => ({ working: false, ptyId: "p", runId: "r" }),
    stop: async () => undefined,
    launch: async () => ({ ptyId: "p", runId: "r" }),
    plans: async () => null,
    orchestrator: {} as CompanionActions["orchestrator"],
    hear: async () => ({ text: "", empty: "short" }),
    ...patch,
  };
}

type Reply = { status: number } | { error: string };

/** A phone that keeps its connection open between polls, as one behind Tailscale Serve does. */
function phone(port: number) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set<net.Socket>();
  const get = (route: string, token: string) =>
    new Promise<Reply>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: route, agent, headers: { Authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("socket", (socket) => sockets.add(socket));
      req.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
      req.end();
    });
  return { agent, sockets, get };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("stopping the phone page", () => {
  it("cuts a connected phone at once, even one waiting on an answer", async () => {
    const token = newCompanionToken();
    const server = await startCompanionHttp({
      port: 0,
      token,
      root: tempDir(),
      icon: null,
      actions: actions({ session: () => new Promise(() => undefined) }),
    });
    const kept = phone(server.port);
    try {
      expect(await kept.get("/api/plans", token)).toEqual({ status: 200 });
      const hung = kept.get("/api/session?ptyId=p", token);
      await delay(50);
      const started = Date.now();
      await within(2000, server.close());
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await hung).toHaveProperty("error");
      expect(kept.sockets.size).toBe(1);
      for (const socket of kept.sockets) expect(socket.destroyed).toBe(true);
    } finally {
      kept.agent.destroy();
    }
  });

  it("signs a polling phone out the moment a new code is made, and lets the app quit with one still asking", async () => {
    const port = await freePort();
    let settings = { companion: { enabled: true, port, token: newCompanionToken(), nudges: [] }, language: "en" };
    let hang = false;
    const wire = {
      service: { getSettings: () => settings, saveSettings: () => undefined },
      supervisor: {},
      root: tempDir(),
      icon: null,
      log: () => undefined,
      plans: async () => {
        if (hang) await new Promise(() => undefined);
        await delay(20);
        return null;
      },
      hear: async () => ({ text: "", empty: "short", seconds: 0 }),
      canHear: () => false,
    } as unknown as CompanionWire;
    const old = settings.companion.token;
    const polling = phone(port);
    const waiting = phone(port);
    try {
      await within(2000, syncCompanion(wire));
      expect(companionStatus()).toMatchObject({ listening: true, url: `http://127.0.0.1:${port}` });
      // One request the old server never answers, and a phone polling with the old code on another connection.
      hang = true;
      const hung = waiting.get("/api/plans", old);
      await delay(30);
      hang = false;
      let poll = true;
      const seen: Reply[] = [];
      const polls = (async () => {
        while (poll) {
          seen.push(await polling.get("/api/plans", old));
          await delay(5);
        }
      })();
      await delay(100);
      expect(seen.some((reply) => "status" in reply && reply.status === 200)).toBe(true);

      settings = { ...settings, companion: { ...settings.companion, token: newCompanionToken() } };
      await within(2000, syncCompanion(wire));
      expect(await hung).toHaveProperty("error");
      // The old code reaches the new server now, and the new server doesn't know it.
      expect(await polling.get("/api/plans", old)).toEqual({ status: 401 });
      expect(await polling.get("/api/plans", settings.companion.token)).toEqual({ status: 200 });
      poll = false;
      await polls;

      hang = true;
      const quitting = waiting.get("/api/plans", settings.companion.token);
      await delay(30);
      await within(2000, stopCompanion());
      expect(await quitting).toHaveProperty("error");
      expect(companionStatus()).toEqual({ listening: false, url: null, error: null });
    } finally {
      polling.agent.destroy();
      waiting.agent.destroy();
      await stopCompanion();
    }
  });
});
