import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServerRunner } from "../../src/core/local-server.js";
import { probeLocalServer } from "../../src/core/local.js";
import { defaultLocalServer, localServerPlan, localServerWanted, normalizeLocalServer, splitArgs, type LocalServerPlan } from "../../src/shared/local.js";
import type { LocalServerSettings } from "../../src/core/types.js";

const HOME = "/home/fox";
const bins: Record<string, string> = {
  "llama-server": "/usr/bin/llama-server",
  ollama: "/usr/bin/ollama",
  lms: "/usr/bin/lms",
  "/home/fox/AI/llama-server": "/home/fox/AI/llama-server",
};
const resolve = (bin: string) => bins[bin] ?? null;
const server = (over: Partial<LocalServerSettings>): LocalServerSettings => ({ ...defaultLocalServer(), ...over });

describe("splitArgs", () => {
  it("splits like a shell without expanding anything", () => {
    expect(splitArgs(`-ngl 99  -c 65536 --alias "my model" --x 'a b' c\\ d $HOME`)).toEqual(["-ngl", "99", "-c", "65536", "--alias", "my model", "--x", "a b", "c d", "$HOME"]);
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs(`--a ""`)).toEqual(["--a", ""]);
    expect(splitArgs(`--a "open`)).toBeNull();
  });
});

describe("normalizeLocalServer", () => {
  it("keeps known kinds and one-line text, and drops the rest", () => {
    expect(normalizeLocalServer(undefined)).toEqual(defaultLocalServer());
    expect(normalizeLocalServer({ kind: "vllm" as never, models: "a\nb", command: "  ~/run.sh  ", withLocalMode: "yes" as never })).toEqual({
      ...defaultLocalServer(),
      command: "~/run.sh",
    });
    expect(normalizeLocalServer({ kind: "llamacpp", withLocalMode: true }).kind).toBe("llamacpp");
  });

  it("carries 3.15.0's settings over: a server picked to run means VibeForge starts it", () => {
    expect(normalizeLocalServer({ kind: "llamacpp", models: "~/AI/models" }).managed).toBe(true);
    expect(normalizeLocalServer({}).managed).toBe(false);
    expect(normalizeLocalServer({ kind: "ollama", managed: false }).managed).toBe(false);
  });
});

describe("localServerPlan", () => {
  it("runs llama-server in router mode over a models folder, on this computer only", () => {
    const worked = localServerPlan(server({ kind: "llamacpp", models: "~/AI/models", presets: "~/AI/models/models.ini", extraArgs: "-ngl 99 --jinja" }), "", resolve, HOME);
    expect(worked.problem).toBeNull();
    expect(worked.plan).toMatchObject({
      bin: "/usr/bin/llama-server",
      args: ["--models-dir", "/home/fox/AI/models", "--models-preset", "/home/fox/AI/models/models.ini", "--models-max", "1", "--host", "127.0.0.1", "--port", "8080", "-ngl", "99", "--jinja"],
      url: "http://127.0.0.1:8080",
      oneShot: false,
      stop: null,
    });
    expect(worked.plan?.shown).toBe("/usr/bin/llama-server --models-dir /home/fox/AI/models --models-preset /home/fox/AI/models/models.ini --models-max 1 --host 127.0.0.1 --port 8080 -ngl 99 --jinja");
  });

  it("loads a single .gguf with -m, and takes the port from a server address on this computer", () => {
    const worked = localServerPlan(server({ kind: "llamacpp", program: "~/AI/llama-server", models: "/m/one.gguf" }), "http://localhost:9090/v1", resolve, HOME);
    expect(worked.plan?.bin).toBe("/home/fox/AI/llama-server");
    expect(worked.plan?.args).toEqual(["-m", "/m/one.gguf", "--host", "127.0.0.1", "--port", "9090"]);
    expect(worked.plan?.url).toBe("http://127.0.0.1:9090");
  });

  it("ignores the port of a server on another machine", () => {
    expect(localServerPlan(server({ kind: "llamacpp", models: "/m" }), "http://mac-mini:9090", resolve, HOME).plan?.url).toBe("http://127.0.0.1:8080");
  });

  it("says what is missing", () => {
    expect(localServerPlan(server({}), "", resolve, HOME).problem).toBe("noKind");
    expect(localServerPlan(server({ kind: "llamacpp" }), "", resolve, HOME).problem).toBe("noModels");
    expect(localServerPlan(server({ kind: "llamacpp", models: "/m", program: "/nope/llama-server" }), "", resolve, HOME).problem).toBe("noProgram");
    expect(localServerPlan(server({ kind: "llamacpp", models: "/m", extraArgs: `--alias "x` }), "", resolve, HOME).problem).toBe("badArgs");
    expect(localServerPlan(server({ kind: "command" }), "", resolve, HOME).problem).toBe("noCommand");
    expect(localServerPlan(server({ kind: "ollama" }), "", () => null, HOME).problem).toBe("noProgram");
  });

  it("starts Ollama on its port, and LM Studio with lms (which stops it too)", () => {
    expect(localServerPlan(server({ kind: "ollama" }), "", resolve, HOME).plan).toMatchObject({
      bin: "/usr/bin/ollama",
      args: ["serve"],
      env: { OLLAMA_HOST: "127.0.0.1:11434" },
      url: "http://127.0.0.1:11434",
    });
    expect(localServerPlan(server({ kind: "lmstudio" }), "", resolve, HOME).plan).toMatchObject({
      bin: "/usr/bin/lms",
      args: ["server", "start", "--port", "1234"],
      oneShot: true,
      stop: { bin: "/usr/bin/lms", args: ["server", "stop"] },
      url: "http://127.0.0.1:1234",
    });
  });

  it("runs your own command in a shell, at the server address you gave", () => {
    expect(localServerPlan(server({ kind: "command", command: "~/AI/run-bonsai.sh -c 65536" }), "http://127.0.0.1:8081", resolve, HOME).plan).toMatchObject({
      bin: "/bin/sh",
      args: ["-c", "~/AI/run-bonsai.sh -c 65536"],
      url: "http://127.0.0.1:8081",
      shown: "~/AI/run-bonsai.sh -c 65536",
    });
  });
});

describe("localServerWanted", () => {
  it("is wanted in Local mode, or while Viby plans on Local, and never with Local AI off", () => {
    expect(localServerWanted({ enabled: true, active: true }, false)).toBe(true);
    expect(localServerWanted({ enabled: true, active: false }, true)).toBe(true);
    expect(localServerWanted({ enabled: true, active: false }, false)).toBe(false);
    expect(localServerWanted({ enabled: false, active: true }, true)).toBe(false);
  });
});

// ------------------------------------------------------------------ the runner, with a real process

const dirs: string[] = [];
const runners: LocalServerRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-local-server-"));
  dirs.push(dir);
  return dir;
}

/** A free port on this computer. */
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** A pretend Local AI server: says something, then answers /v1/models after `delayMs`. */
function fakeServer(dir: string, port: number, delayMs: number): LocalServerPlan {
  const script = path.join(dir, "server.cjs");
  fs.writeFileSync(
    script,
    `console.log("loading model");
setTimeout(() => {
  require("node:http").createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "tiny", object: "model" }] }));
  }).listen(${port}, "127.0.0.1", () => console.log("listening"));
}, ${delayMs});
process.on("SIGTERM", () => { console.log("bye"); process.exit(0); });`,
  );
  return { kind: "command", bin: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" }, url: `http://127.0.0.1:${port}`, oneShot: false, stop: null, shown: "fake" };
}

function runner(dir: string, readyWithinMs = 10_000): { run: LocalServerRunner; ready: string[] } {
  const ready: string[] = [];
  const run = new LocalServerRunner({
    logFile: path.join(dir, "logs", "local-server.log"),
    probe: async (url) => (await probeLocalServer(url, { timeoutMs: 300 })).reachable,
    onChange: () => undefined,
    onReady: (url) => ready.push(url),
    pollMs: 50,
    readyWithinMs,
    stopGraceMs: 2000,
  });
  runners.push(run);
  return { run, ready };
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("LocalServerRunner", () => {
  it("starts, says when it answers, keeps what it printed, and stops", async () => {
    const dir = tempDir();
    const port = await freePort();
    const { run, ready } = runner(dir);
    const started = await run.start(fakeServer(dir, port, 200));
    expect(started.status).toBe("starting");
    expect(started.pid).toBeGreaterThan(0);
    await until(() => run.view().status === "running");
    expect(ready).toEqual([`http://127.0.0.1:${port}`]);
    await until(() => run.view().log.includes("listening"));
    expect(run.view().log).toContain("loading model");
    const stopped = await run.stop();
    expect(stopped.status).toBe("stopped");
    expect(stopped.pid).toBeNull();
    expect((await probeLocalServer(`http://127.0.0.1:${port}`, { timeoutMs: 300 })).reachable).toBe(false);
    expect(fs.readFileSync(path.join(dir, "logs", "local-server.log"), "utf8")).toContain("$ fake\nloading model");
  });

  it("won't start a second server where one already answers", async () => {
    const dir = tempDir();
    const port = await freePort();
    const first = runner(dir).run;
    await first.start(fakeServer(dir, port, 0));
    await until(() => first.view().status === "running");
    const second = runner(tempDir()).run;
    const state = await second.start(fakeServer(dir, port, 0));
    expect(state).toMatchObject({ status: "failed", problem: "busy", detail: `http://127.0.0.1:${port}` });
  });

  it("says a server that ends by itself failed, with its exit code", async () => {
    const dir = tempDir();
    const { run } = runner(dir);
    const plan: LocalServerPlan = { ...fakeServer(dir, await freePort(), 0), args: ["-e", "console.error('no CUDA device'); process.exit(3)"] };
    await run.start(plan);
    await until(() => run.view().status === "failed");
    expect(run.view()).toMatchObject({ problem: "exited", detail: "3" });
    expect(run.view().log).toContain("no CUDA device");
  });

  it("stops one that never answers", async () => {
    const dir = tempDir();
    const { run } = runner(dir, 300);
    await run.start({ ...fakeServer(dir, await freePort(), 60_000) });
    await until(() => run.view().status === "failed");
    expect(run.view()).toMatchObject({ problem: "timeout", pid: null });
  });

  it("says why it can't start from the settings", () => {
    const { run } = runner(tempDir());
    expect(run.refuse("noModels")).toMatchObject({ status: "failed", problem: "noModels" });
  });
});

// ------------------------------------------------------------------ llama-server's router mode

describe("probeLocalServer on a llama-server router", () => {
  it("lists every model, marks the loaded one, and reads the context size in use", async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader("server", "llama.cpp");
      res.setHeader("content-type", "application/json");
      if (req.url === "/props") {
        res.end(JSON.stringify({ role: "router", model_alias: "llama-server", model_path: "none", default_generation_settings: { params: null, n_ctx: 0 } }));
        return;
      }
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "Qwen3.5-9B", object: "model", owned_by: "llamacpp", context_length: 262144, status: { value: "unloaded", args: ["llama-server", "--ctx-size", "131072"] } },
            { id: "Bonsai", object: "model", owned_by: "llamacpp", context_length: 262144, status: { value: "loaded", args: ["llama-server", "--alias", "Bonsai"] } },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as AddressInfo;
    try {
      const probe = await probeLocalServer(`http://127.0.0.1:${port}`);
      expect(probe.kind).toBe("llamacpp");
      expect(probe.models).toEqual([
        { id: "Bonsai", loaded: true, contextLength: 262144 },
        { id: "Qwen3.5-9B", contextLength: 131072 },
      ]);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

// ------------------------------------------------------------------ through the service

describe("the service's Local AI server", () => {
  it("keeps the rest of the server settings on a partial save, and follows Local mode when asked", async () => {
    const { setup } = await import("./fixtures/service-harness.js");
    const ctx = setup();
    try {
      const dir = tempDir();
      const port = await freePort();
      const plan = fakeServer(dir, port, 0);
      const command = `ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${plan.args[0]}'`;
      ctx.svc.saveSettings({ local: { enabled: true, url: `http://127.0.0.1:${port}`, server: { managed: true, kind: "command", command } } });
      ctx.svc.saveSettings({ local: { server: { withLocalMode: true } } });
      expect(ctx.svc.getSettings().local.server).toMatchObject({ managed: true, kind: "command", command, withLocalMode: true });
      expect(ctx.svc.localServerView()).toMatchObject({ problem: null, plan: { url: `http://127.0.0.1:${port}`, shown: command } });

      ctx.svc.saveSettings({ local: { active: true } });
      await until(() => ctx.svc.localServerView().state.status === "running");
      // It answered: its model is picked, so Local mode can start right away.
      await until(() => ctx.svc.getSettings().local.model === "tiny");

      ctx.svc.saveSettings({ local: { active: false } });
      await until(() => ctx.svc.localServerView().state.status === "stopped");
      expect((await probeLocalServer(`http://127.0.0.1:${port}`, { timeoutMs: 300 })).reachable).toBe(false);

      // Switched to a server that's already running: the one VibeForge started goes, and Local mode no longer starts one.
      ctx.svc.saveSettings({ local: { active: true } });
      await until(() => ctx.svc.localServerView().state.status === "running");
      ctx.svc.saveSettings({ local: { server: { managed: false } } });
      await until(() => ctx.svc.localServerView().state.status === "stopped");
      ctx.svc.saveSettings({ local: { active: false } });
      ctx.svc.saveSettings({ local: { active: true } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ctx.svc.localServerView().state.status).toBe("stopped");
    } finally {
      await ctx.svc.close();
    }
  });
});
