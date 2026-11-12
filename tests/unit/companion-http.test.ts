import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { companionStatus, LISTEN_RETRY_MS, stopCompanion, syncCompanion, type CompanionWire } from "../../electron/companion.js";
import { newCompanionToken } from "../../src/core/companion.js";
import { hostAllowed, startCompanionHttp, type CompanionActions } from "../../src/core/companion-http.js";

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
      expect(companionStatus()).toEqual({ listening: false, url: null, error: null, unsigned: 0 });
    } finally {
      polling.agent.destroy();
      waiting.agent.destroy();
      await stopCompanion();
    }
  });
});

/** One request with the Host a browser would send for the address it opened. */
function ask(port: number, route: string, host: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, headers: { ...headers, Host: host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("who the phone page answers", () => {
  it("answers this computer's own names and the tailnet name Tailscale Serve passes on, nothing else", () => {
    for (const host of ["127.0.0.1:4737", "localhost:4737", "[::1]:4737", "LOCALHOST:8080", "studio.tail1234.ts.net", "studio.tail1234.ts.net:8443", "Studio.Tail1234.TS.NET."]) {
      expect(hostAllowed(host), host).toBe(true);
    }
    for (const host of [undefined, "", "evil.example:4737", "ts.net", "studio.tail1234.ts.net.evil.example", "127.0.0.1.evil.example", "localhost.evil.example:4737", "studio_x.ts.net", "studio.ts.net:port", "100.101.102.103:4737"]) {
      expect(hostAllowed(host), String(host)).toBe(false);
    }
  });

  it("refuses a page whose name was pointed at this computer, even with the code", async () => {
    const token = newCompanionToken();
    const server = await startCompanionHttp({ port: 0, token, root: path.join(import.meta.dirname, "../../companion"), icon: null, actions: actions() });
    try {
      const evil = `rebind.evil.example:${server.port}`;
      for (const route of ["/", "/app.js", "/api/text", "/api/desk"]) {
        const refused = await ask(server.port, route, evil, { Authorization: `Bearer ${token}` });
        expect(refused.status, route).toBe(403);
        expect(JSON.parse(refused.body).error).toContain("Tailscale Serve");
      }
      const served = await ask(server.port, "/", "studio.tail1234.ts.net");
      expect(served.status).toBe(200);
      // No other page may frame this one.
      expect(served.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(served.headers["x-frame-options"]).toBe("DENY");
      expect((await ask(server.port, "/api/desk", `localhost:${server.port}`, { Authorization: `Bearer ${token}` })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("says nothing about this computer before the code matches", async () => {
    const token = newCompanionToken();
    const root = tempDir();
    const server = await startCompanionHttp({
      port: 0,
      token,
      root,
      icon: path.join(root, "missing.png"),
      actions: actions({
        session: async () => {
          throw new Error(`That session is gone from ${root}.`);
        },
      }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      // The page's own files are missing here: reading them fails with the folder in the message.
      for (const route of ["/", "/icon.png"]) {
        const failed = await fetch(`${base}${route}`);
        expect(failed.status, route).toBe(500);
        const said = (await failed.json()).error as string;
        expect(said).toBe("Something went wrong.");
        expect(said).not.toContain(root);
      }
      // The page's own refusals still say what they are.
      const bad = await fetch(`${base}/api/pair`, { method: "POST", body: "{ nope" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("That was not valid.");
      // A paired phone hears what the service said.
      const paired = await fetch(`${base}/api/session?ptyId=p`, { headers: { Authorization: `Bearer ${token}` } });
      expect(paired.status).toBe(400);
      expect((await paired.json()).error).toContain("That session is gone from");
    } finally {
      await server.close();
    }
  });
});

describe("the phone page's own files", () => {
  const root = path.join(import.meta.dirname, "../../companion");

  /** app.js and every module it reaches through its imports, as paths under companion/. */
  function pageModules(): string[] {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(path.join(root, file), "utf8");
      for (const [, from] of text.matchAll(/^import [^"]* from "(\.[^"]+)";$/gm)) walk(path.posix.join(path.posix.dirname(file), from));
    };
    walk("app.js");
    return [...seen].sort();
  }

  it("serves app.js and each of its modules as a script under the page's CSP, and nothing else from js/", async () => {
    const modules = pageModules();
    // Every module in js/ is one the page loads: a file left out of the list below would break it.
    expect(modules.filter((file) => file !== "app.js")).toEqual(fs.readdirSync(path.join(root, "js")).map((name) => `js/${name}`).sort());
    const server = await startCompanionHttp({ port: 0, token: newCompanionToken(), root, icon: null, actions: actions() });
    const host = `localhost:${server.port}`;
    try {
      for (const file of modules) {
        const served = await ask(server.port, `/${file}`, host);
        expect(served.status, file).toBe(200);
        expect(served.headers["content-type"], file).toBe("text/javascript; charset=utf-8");
        expect(served.headers["content-security-policy"], file).toContain("script-src 'self'");
        expect(served.headers["cache-control"], file).toBe("no-store");
        expect(served.body, file).toBe(fs.readFileSync(path.join(root, file), "utf8"));
      }
      for (const route of ["/js/", "/js/missing.js", "/js/../app.js.map", "/companion/app.js"]) expect((await ask(server.port, route, host)).status, route).toBe(404);
      // The page asks for all of them at once, not one import after another.
      const html = (await ask(server.port, "/", host)).body;
      const preloaded = [...html.matchAll(/<link rel="modulepreload" href="\/([^"]+)" \/>/g)].map((found) => found[1]).sort();
      expect(preloaded).toEqual(modules.filter((file) => file !== "app.js"));
      expect(html).toContain('<script src="/app.js" type="module"></script>');
    } finally {
      await server.close();
    }
  });
});

/** A request to the page with the code, as the phone sends it, its answer read as raw bytes. */
function request(port: number, route: string, opts: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
  return new Promise<{ status: number; raw: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("what the phone page sends over a slow link", () => {
  it("answers a read the phone already has with 304, and gzips a large one the phone takes gzipped", async () => {
    const token = newCompanionToken();
    let screen = "a".repeat(5000);
    const server = await startCompanionHttp({
      port: 0,
      token,
      root: path.join(import.meta.dirname, "../../companion"),
      icon: null,
      version: "9.9.9",
      actions: actions({ session: async () => ({ ptyId: "p", runId: "r", title: "", detail: "", state: "waiting", changes: null, screen, canSend: true, stop: "end" }) }),
    });
    const auth = { Authorization: `Bearer ${token}` };
    try {
      const first = await request(server.port, "/api/session?ptyId=p&runId=r", { headers: { ...auth, "Accept-Encoding": "gzip, deflate, br" } });
      expect(first.status).toBe(200);
      expect(first.headers["content-encoding"]).toBe("gzip");
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.headers.vary).toBe("Accept-Encoding");
      expect(first.raw.length).toBeLessThan(1000);
      expect(JSON.parse(zlib.gunzipSync(first.raw).toString("utf8")).screen).toBe(screen);
      const etag = String(first.headers.etag);
      expect(etag).toMatch(/^W\/"/);

      // Nothing new: no body at all.
      const same = await request(server.port, "/api/session?ptyId=p&runId=r", { headers: { ...auth, "If-None-Match": etag } });
      expect(same.status).toBe(304);
      expect(same.raw.length).toBe(0);
      // Something new: the whole answer, and its own tag. Without gzip asked for, plain.
      screen += "b";
      const changed = await request(server.port, "/api/session?ptyId=p&runId=r", { headers: { ...auth, "If-None-Match": etag } });
      expect(changed.status).toBe(200);
      expect(changed.headers["content-encoding"]).toBeUndefined();
      expect(changed.headers.etag).not.toBe(etag);
      expect(JSON.parse(changed.raw.toString("utf8")).screen).toBe(screen);
      // gzip refused with q=0, and a small answer, are sent plain.
      expect((await request(server.port, "/api/session?ptyId=p&runId=r", { headers: { ...auth, "Accept-Encoding": "gzip;q=0" } })).headers["content-encoding"]).toBeUndefined();
      const desk = await request(server.port, "/api/desk", { headers: { ...auth, "Accept-Encoding": "gzip" } });
      expect(desk.headers["content-encoding"]).toBeUndefined();
      // The desk says which version the computer runs, so a page from another one loads itself again.
      expect(JSON.parse(desk.raw.toString("utf8")).version).toBe("9.9.9");
      // A refusal is never a 304, whatever the phone sends.
      expect((await request(server.port, "/api/desk", { headers: { "If-None-Match": "*" } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("types only plain words into a terminal: no control characters or paste markers from the phone", async () => {
    const token = newCompanionToken();
    const sent: string[] = [];
    const launched: string[] = [];
    const server = await startCompanionHttp({
      port: 0,
      token,
      root: path.join(import.meta.dirname, "../../companion"),
      icon: null,
      actions: actions({
        send: async (input) => {
          sent.push(input.text);
          return { working: false, ptyId: "p", runId: "r" };
        },
        launch: async (input) => {
          launched.push(input.prompt);
          return { ptyId: "p", runId: "r" };
        },
      }),
    });
    const post = (route: string, body: unknown) => request(server.port, route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      // A paste marker hidden inside another would come back whole after one pass, and end the paste early.
      expect((await post("/api/send", { ptyId: "p", runId: "r", text: "fix it\x1b[20\x1b[201~1~\x03\rrm -rf ~\x07\tnow" })).status).toBe(200);
      // What is left of the marker is plain text: no ESC, so nothing a terminal reads as one.
      expect(sent).toEqual(["fix it[201~\nrm -rf ~\tnow"]);
      await post("/api/launch", { workspaceId: "w", engineId: "claude", prompt: "\x1b[2Jhello\x7f" });
      expect(launched).toEqual(["[2Jhello"]);
      // Only control characters is nothing to send.
      expect((await post("/api/send", { ptyId: "p", runId: "r", text: "\x03\x04" })).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("counts what reached it through a tailnet name without Tailscale's sign-in header (Funnel), and refuses none of it", async () => {
    const token = newCompanionToken();
    const server = await startCompanionHttp({ port: 0, token, root: path.join(import.meta.dirname, "../../companion"), icon: null, actions: actions() });
    try {
      expect((await request(server.port, "/", { host: "studio.tail1234.ts.net", headers: { "Tailscale-User-Login": "me@example.com" } })).status).toBe(200);
      expect((await request(server.port, "/", { host: `127.0.0.1:${server.port}` })).status).toBe(200);
      expect(server.unsigned()).toBe(0);
      expect((await request(server.port, "/", { host: "studio.tail1234.ts.net" })).status).toBe(200);
      expect((await request(server.port, "/api/text", { host: "studio.tail1234.ts.net." })).status).toBe(200);
      expect(server.unsigned()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("tries the port again while the page is on and something else holds it", async () => {
    const port = await freePort();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    const settings = { companion: { enabled: true, port, token: newCompanionToken(), nudges: [] }, language: "en" };
    const wire = {
      service: { getSettings: () => settings, saveSettings: () => undefined },
      supervisor: {},
      root: tempDir(),
      icon: null,
      log: () => undefined,
      plans: async () => null,
      hear: async () => ({ text: "", empty: "short", seconds: 0 }),
      canHear: () => false,
    } as unknown as CompanionWire;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await syncCompanion(wire);
      expect(companionStatus()).toMatchObject({ listening: false });
      expect(companionStatus().error).toBeTruthy();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      await vi.advanceTimersByTimeAsync(LISTEN_RETRY_MS);
      // The retry runs through the same queue as every other change.
      vi.useRealTimers();
      await syncCompanion(wire);
      expect(companionStatus()).toMatchObject({ listening: true, url: `http://127.0.0.1:${port}`, error: null });
    } finally {
      vi.useRealTimers();
      holder.close();
      await stopCompanion();
    }
  });
});
