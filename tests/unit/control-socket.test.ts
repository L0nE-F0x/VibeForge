import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { answers, listenControl } from "../../electron/control.js";
import { controlSocketPath, fallbackSocketDir, parseTalkRequest, prepareSocketDir } from "../../src/core/control.js";
import { defaultRoots } from "../../src/core/layout.js";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0" },
  clipboard: {},
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
}));

const uid = process.getuid?.() ?? 0;
const data = "/home/me/.local/share/vibeforge";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sock-"));
}

const mode = (dir: string) => fs.statSync(dir).mode & 0o777;

/**
 * scripts/vibeforge's control_sock(), run in bash. With `tmp`, its /tmp is swapped for that folder
 * so the test never makes anything in the real /tmp.
 */
function controlSock(env: { runtime?: string; tmp?: string; vars?: Record<string, string> }): { out: string; err: string; status: number | null } {
  const script = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", "vibeforge"), "utf8");
  let fn = /^control_sock\(\) \{\n[\s\S]*?^\}\n/m.exec(script)?.[0] ?? "";
  expect(fn).toContain('dir="/tmp/vibeforge-$(id -u)"');
  if (env.tmp) fn = fn.replace('dir="/tmp/vibeforge-', `dir="${env.tmp}/vibeforge-`);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\ncontrol_sock`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/home/me", ...(env.vars ?? { VIBEFORGE_DATA: data }), ...(env.runtime ? { XDG_RUNTIME_DIR: env.runtime } : {}) },
  });
  return { out: result.stdout.trim(), err: result.stderr.trim(), status: result.status };
}

describe("the control socket's path", () => {
  it("sits in the runtime folder, or else in a private folder in /tmp, the same in TypeScript and bash", () => {
    expect(controlSocketPath(data, "/run/user/1000", 1000)).toMatch(/^\/run\/user\/1000\/vibeforge-[0-9a-f]{8}\.sock$/);
    expect(controlSocketPath(data, undefined, 42)).toMatch(/^\/tmp\/vibeforge-42\/vibeforge-[0-9a-f]{8}\.sock$/);
    expect(path.dirname(controlSocketPath(data, "", 42))).toBe(fallbackSocketDir(42));

    const runtime = tempDir();
    expect(controlSock({ runtime })).toEqual({ out: controlSocketPath(data, runtime, uid), err: "", status: 0 });
    const tmp = tempDir();
    expect(controlSock({ tmp }).out).toBe(controlSocketPath(data, undefined, uid, tmp));
    expect(mode(fallbackSocketDir(uid, tmp))).toBe(0o700);
  });

  it("is the same in bash when XDG_DATA_HOME or HOME ends in a slash", () => {
    const runtime = tempDir();
    const cases: Array<Record<string, string>> = [{ XDG_DATA_HOME: "/home/me/.local/share/" }, { XDG_DATA_HOME: "/data//me" }, { HOME: "/home/me/" }];
    for (const vars of cases) {
      vi.stubEnv("HOME", vars.HOME ?? "/home/me");
      try {
        expect(controlSock({ runtime, vars }).out, JSON.stringify(vars)).toBe(controlSocketPath(defaultRoots(vars).dataRoot, runtime, uid));
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("makes the /tmp folder private, and closes up one of its own that was left open", () => {
    const tmp = tempDir();
    const socket = controlSocketPath(data, undefined, uid, tmp);
    expect(prepareSocketDir(socket, uid, tmp)).toBe(true);
    expect(mode(path.dirname(socket))).toBe(0o700);
    fs.chmodSync(path.dirname(socket), 0o755);
    expect(prepareSocketDir(socket, uid, tmp)).toBe(true);
    expect(mode(path.dirname(socket))).toBe(0o700);

    const shared = tempDir();
    fs.mkdirSync(fallbackSocketDir(uid, shared), { mode: 0o777 });
    fs.chmodSync(fallbackSocketDir(uid, shared), 0o777);
    expect(controlSock({ tmp: shared }).out).toBe(controlSocketPath(data, undefined, uid, shared));
    expect(mode(fallbackSocketDir(uid, shared))).toBe(0o700);
  });

  it("won't use a /tmp folder that someone else made, or a link or file in its place", () => {
    // Someone else's folder: the same check, seen as a user it doesn't belong to.
    const tmp = tempDir();
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid + 1, tmp), uid + 1, tmp)).toBe(false);

    const linked = tempDir();
    fs.symlinkSync(tempDir(), fallbackSocketDir(uid, linked));
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid, linked), uid, linked)).toBe(false);
    expect(controlSock({ tmp: linked })).toMatchObject({ out: "", status: 0 });
    expect(controlSock({ tmp: linked }).err).toContain("isn't yours");

    const file = tempDir();
    fs.writeFileSync(fallbackSocketDir(uid, file), "");
    expect(prepareSocketDir(controlSocketPath(data, undefined, uid, file), uid, file)).toBe(false);
    expect(controlSock({ tmp: file }).out).toBe("");
  });

  it("leaves a runtime folder alone", () => {
    const runtime = tempDir();
    fs.chmodSync(runtime, 0o755);
    expect(prepareSocketDir(controlSocketPath(data, runtime, uid), uid)).toBe(true);
    expect(mode(runtime)).toBe(0o755);
  });
});

describe("listening on the control socket", () => {
  const ask = (socket: string, line: string) =>
    new Promise<string>((resolve, reject) => {
      const client = net.connect(socket, () => client.end(`${line}\n`));
      let out = "";
      client.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      client.on("end", () => resolve(out));
      client.on("error", reject);
    });
  const log = () => {
    const warned: string[] = [];
    return { warned, log: { warn: (line: string) => warned.push(line), info: () => undefined, error: () => undefined } as never };
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let tries = 0; tries < 100 && !(await check()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it("takes over a socket file a crashed run left, and leaves one another VibeForge is using", async () => {
    const dir = tempDir();
    const socket = path.join(dir, "vf.sock");
    // Left by a crash: a socket file nothing listens on.
    const crashed = net.createServer().listen(socket);
    await new Promise((resolve) => crashed.once("listening", resolve));
    await new Promise((resolve) => {
      crashed.close(resolve);
      fs.writeFileSync(socket, "");
    });
    const first = log();
    const stopFirst = listenControl(socket, first.log, () => undefined, async () => ({ ok: true, from: "first" }));
    await until(async () => (await answers(socket)) === true);
    expect(await ask(socket, JSON.stringify({ op: "who", pty: null }))).toContain('"from":"first"');

    // A second VibeForge on the same data folder: it neither steals nor deletes the socket.
    const second = log();
    const stopSecond = listenControl(socket, second.log, () => undefined, async () => ({ ok: true, from: "second" }));
    await until(() => second.warned.length > 0);
    expect(second.warned[0]).toContain("another VibeForge is listening");
    stopSecond();
    expect(await ask(socket, JSON.stringify({ op: "who", pty: null }))).toContain('"from":"first"');
    stopFirst();
    expect(fs.existsSync(socket)).toBe(false);
  });

  it("rejects symlinked runtime dirs and socket paths, and parses ptyToken", () => {
    const base = tempDir();
    const targetDir = tempDir();
    const symRuntime = path.join(base, "rt-link");
    fs.symlinkSync(targetDir, symRuntime);
    expect(prepareSocketDir(controlSocketPath(data, symRuntime, uid), uid)).toBe(false);

    const realRuntime = tempDir();
    const sock = controlSocketPath(data, realRuntime, uid);
    fs.symlinkSync("/tmp/elsewhere.sock", sock);
    expect(prepareSocketDir(sock, uid)).toBe(false);

    expect(parseTalkRequest(JSON.stringify({ op: "who", pty: "p1", ptyToken: "secret-hex" }))).toEqual({ op: "who", pty: "p1", ptyToken: "secret-hex" });
  });

  it("caps simultaneous control socket connections and rate-limits callers per pty and outside", async () => {
    const dir = tempDir();
    const socket = path.join(dir, "cap.sock");
    let holdOpen: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holdOpen = resolve;
    });
    let inTalk = 0;
    const stop = listenControl(
      socket,
      log().log,
      () => undefined,
      async () => {
        inTalk += 1;
        await held;
        return { ok: true };
      },
      { maxConnections: 1 },
    );
    await until(async () => (await answers(socket)) === true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // One live connection takes the single slot; a second concurrent connection is dropped by maxConnections=1.
    const first = net.connect(socket, () => first.write(`${JSON.stringify({ op: "who", pty: null })}\n`));
    first.on("error", () => undefined);
    await until(() => inTalk === 1);
    const secondOutcome = await new Promise<string>((resolve) => {
      const second = net.connect(socket, () => {
        second.write(`${JSON.stringify({ op: "who", pty: null })}\n`);
      });
      const timer = setTimeout(() => {
        second.destroy();
        resolve("timedout");
      }, 400);
      second.on("close", () => {
        clearTimeout(timer);
        resolve("closed");
      });
      second.on("error", () => {
        clearTimeout(timer);
        resolve("closed");
      });
      second.on("data", () => {
        clearTimeout(timer);
        resolve("data");
      });
    });
    expect(secondOutcome).toBe("closed");
    holdOpen();
    first.destroy();
    stop();

    // Token bucket rate limiter isolates outside callers from per-PTY buckets and refills over time.
    const control = await import("../../src/core/control.js");
    let now = 1000;
    const limiter = new control.TalkRateLimiter({ outsideCapacity: 2, outsideRefillPerSec: 1, ptyCapacity: 3, ptyRefillPerSec: 1, now: () => now });
    expect(limiter.take(null)).toBe(true);
    expect(limiter.take(null)).toBe(true);
    expect(limiter.take(null)).toBe(false);
    // Authenticated PTYs keep their own budget.
    expect(limiter.take("pty-1")).toBe(true);
    expect(limiter.take("pty-1")).toBe(true);
    expect(limiter.take("pty-1")).toBe(true);
    expect(limiter.take("pty-1")).toBe(false);
    now += 1000;
    expect(limiter.take(null)).toBe(true);

    // LRU bucket eviction skips "outside" so heavy PTY churn never resets unauthenticated throttling.
    const capped = new control.TalkRateLimiter({ outsideCapacity: 2, ptyCapacity: 1, maxBuckets: 8, now: () => 0 });
    expect(capped.take(null)).toBe(true);
    expect(capped.take("pty-0")).toBe(true);
    expect(capped.take("pty-0")).toBe(false);
    for (let i = 1; i <= 8; i += 1) expect(capped.take(`pty-${i}`)).toBe(true);
    expect(capped.take("pty-0")).toBe(true);
    expect(capped.take(null)).toBe(true);
    expect(capped.take(null)).toBe(false);

    // answerTalk fails closed on a live PTY that has no registered token and enforces the limiter.
    const { answerTalk } = await import("../../electron/ipc.js");
    const live = new Map([["pty-live", { ptyId: "pty-live" }]]);
    const ptyTokens = new Map([["pty-authed", "good-token"]]);
    const ctx = {
      service: {
        live,
        ptyTokens,
        whoIsHere: () => ({ you: null, clis: [], agents: [] }),
        tell: vi.fn(async () => ({ ok: true })),
        handTask: vi.fn(async () => ({ ok: true })),
        applyHandedTask: vi.fn(async () => ({ ok: true })),
      },
    } as never;

    const unregistered = await answerTalk(ctx, { op: "who", pty: "pty-live" }, new AbortController().signal);
    expect(unregistered).toMatchObject({ ok: false, error: expect.stringMatching(/session|token|active/i) });

    // Unregistered probe spent 1 of 10 outside tokens, so 9 more succeed and the 10th is throttled.
    const results: unknown[] = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(await answerTalk(ctx, { op: "who", pty: null }, new AbortController().signal));
    }
    expect(results.slice(0, 9).every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(results[9]).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/i) });
    expect(await answerTalk(ctx, { op: "who", pty: "pty-authed", ptyToken: "good-token" }, new AbortController().signal)).toMatchObject({ ok: true });
  });
});
