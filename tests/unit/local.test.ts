import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  anthropicBaseUrl,
  buildLocalBrainMessages,
  cleanLocalModel,
  isLoopbackLocalUrl,
  localEngineSpec,
  normalizeLocalUrl,
  openAiBaseUrl,
  probeLocalServer,
  runLocalBrain,
  shortLocalModel,
  stripThinkTags,
} from "../../src/core/local.js";
import type { EngineRow, LocalSettings } from "../../src/core/types.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    ),
  );
});

async function startMockServer(handler: http.RequestListener): Promise<string> {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const baseRows: EngineRow[] = [
  { id: "opencode", label: "OpenCode", bin: "opencode", args: [], promptArgs: ["--prompt", "{prompt}"], continueArgs: ["--continue"] },
  { id: "claude", label: "Claude Code", bin: "claude", args: ["--safe"], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
  { id: "codex", label: "Codex", bin: "codex", args: [], promptArgs: ["{prompt}"], continueArgs: ["resume", "--last"] },
];

const baseLocal: LocalSettings = {
  enabled: true,
  active: true,
  overrideAgents: false,
  url: "http://127.0.0.1:8080",
  model: "bonsai-2.5-27b",
  vibyModel: "",
  harness: "auto",
};

describe("local URL, model, and think-tag helpers", () => {
  it("normalizes local and home-network addresses cleanly", () => {
    expect(normalizeLocalUrl("127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(normalizeLocalUrl("http://mac-mini.tailnet.ts.net:11434/v1/")).toBe("http://mac-mini.tailnet.ts.net:11434/v1");
    expect(normalizeLocalUrl("https://dgx-spark.local:8000")).toBe("https://dgx-spark.local:8000");
    expect(normalizeLocalUrl("ftp://bad.host")).toBe("");
    expect(normalizeLocalUrl("http://user:pass@localhost:8080")).toBe("");
    expect(normalizeLocalUrl("http://bad host")).toBe("");

    expect(openAiBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(openAiBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(anthropicBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");

    expect(isLoopbackLocalUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackLocalUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackLocalUrl("http://mac-mini:11434")).toBe(false);
  });

  it("sanitizes and formats model ids safely", () => {
    expect(cleanLocalModel("  qwen3-coder:32b  ")).toBe("qwen3-coder:32b");
    expect(cleanLocalModel("-bad-flag")).toBe("");
    expect(cleanLocalModel("line1\nline2")).toBe("");
    expect(shortLocalModel("models/bonsai-2.5-27b-Q4_K_M.gguf")).toBe("bonsai-2.5-27b-Q4_K_M");
  });

  it("strips closed and streaming unclosed think blocks", () => {
    expect(stripThinkTags("<think>internal notes</think>\n{\"say\":\"Hi\",\"steps\":[]}")).toBe('{"say":"Hi","steps":[]}');
    expect(stripThinkTags("<think>still thinking")).toBe("");
  });
});

describe("localEngineSpec ephemeral harness routing", () => {
  it("builds ephemeral OpenCode config env without touching disk", () => {
    const spec = localEngineSpec({ ...baseLocal, harness: "opencode" }, baseRows, (bin) => `/usr/bin/${bin}`);
    expect(spec.engine.available).toBe(true);
    expect(spec.engine.local).toBe(true);
    expect(spec.harness).toBe("opencode");
    expect(spec.extraArgs).toEqual(["-m", "vibeforge-local/bonsai-2.5-27b"]);
    const cfg = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT) as {
      provider: { "vibeforge-local": { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> } };
    };
    expect(cfg.provider["vibeforge-local"].options.baseURL).toBe("http://127.0.0.1:8080/v1");
    expect(cfg.provider["vibeforge-local"].options.apiKey).toBe("local");
    expect(cfg.provider["vibeforge-local"].models["bonsai-2.5-27b"]).toBeTruthy();
  });

  it("points Claude Code at anthropicBaseUrl without /v1 and injects dummy auth env", () => {
    const spec = localEngineSpec({ ...baseLocal, url: "http://mac-mini:11434/v1", harness: "claude" }, baseRows, (bin) => `/usr/bin/${bin}`);
    expect(spec.harness).toBe("claude");
    expect(spec.extraArgs).toEqual(["--model", "bonsai-2.5-27b"]);
    expect(spec.env.ANTHROPIC_BASE_URL).toBe("http://mac-mini:11434");
    expect(spec.env.ANTHROPIC_API_KEY).toBe("local");
    expect(spec.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("bonsai-2.5-27b");
  });

  it("builds inline Codex provider overrides via -c without writing ~/.codex/config.toml", () => {
    const spec = localEngineSpec({ ...baseLocal, harness: "codex" }, baseRows, (bin) => `/usr/bin/${bin}`);
    expect(spec.harness).toBe("codex");
    expect(spec.env).toEqual({});
    expect(spec.extraArgs).toContain('model_providers.vibeforge_local.base_url="http://127.0.0.1:8080/v1"');
    expect(spec.extraArgs).toContain('model_providers.vibeforge_local.wire_api="responses"');
    expect(spec.extraArgs.slice(-2)).toEqual(["-m", "bonsai-2.5-27b"]);
  });

  it("resolves auto harness in opencode -> claude -> codex order", () => {
    const onlyClaudeAndCodex = localEngineSpec(baseLocal, baseRows, (bin) => (bin === "claude" || bin === "codex" ? `/usr/bin/${bin}` : null));
    expect(onlyClaudeAndCodex.harness).toBe("claude");

    const onlyCodex = localEngineSpec(baseLocal, baseRows, (bin) => (bin === "codex" ? `/usr/bin/${bin}` : null));
    expect(onlyCodex.harness).toBe("codex");

    const none = localEngineSpec(baseLocal, baseRows, () => null);
    expect(none.engine.available).toBe(false);
    expect(none.harness).toBeNull();
  });
});

describe("probeLocalServer", () => {
  it("probes Ollama models, loaded state, and context length", async () => {
    const url = await startMockServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "qwen3:32b", owned_by: "library" },
              { id: "gemma3:27b", owned_by: "library" },
            ],
          }),
        );
        return;
      }
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3:32b" }, { name: "gemma3:27b" }] }));
        return;
      }
      if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen3:32b", context_length: 65536, size: 19_000_000_000 }] }));
        return;
      }
      if (req.url === "/api/show" && req.method === "POST") {
        await readBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model_info: { "qwen3.context_length": 65536 } }));
        return;
      }
      res.writeHead(404).end();
    });

    const probe = await probeLocalServer(url);
    expect(probe.reachable).toBe(true);
    expect(probe.kind).toBe("ollama");
    expect(probe.isLoopback).toBe(true);
    expect(probe.contextLength).toBe(65536);
    expect(probe.models.map((m) => [m.id, m.loaded])).toEqual([
      ["qwen3:32b", true],
      ["gemma3:27b", undefined],
    ]);
  });

  it("probes llama.cpp /props for context size and /v1/models", async () => {
    const url = await startMockServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "bonsai-2.5.gguf" }] }));
        return;
      }
      if (req.url === "/props") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
        return;
      }
      res.writeHead(404).end();
    });

    const probe = await probeLocalServer(url);
    expect(probe.reachable).toBe(true);
    expect(probe.kind).toBe("llamacpp");
    expect(probe.contextLength).toBe(16384);
    expect(probe.models[0]?.id).toBe("bonsai-2.5.gguf");
  });

  it("handles generic OpenAI-compatible servers and invalid URLs gracefully", async () => {
    const url = await startMockServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mlx-model" }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const okProbe = await probeLocalServer(url);
    expect(okProbe.reachable).toBe(true);
    expect(okProbe.kind).toBe("openai");
    expect(okProbe.models.map((m) => m.id)).toEqual(["mlx-model"]);

    const badUrl = await probeLocalServer("not a url://bad");
    expect(badUrl.reachable).toBe(false);
    expect(badUrl.error).toMatch(/valid/i);
  });
});

describe("runLocalBrain", () => {
  it("streams SSE chunks, fires onEarlySay early, and strips <think> blocks", async () => {
    const url = await startMockServer(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        "<think>considering plan</think>",
        '{"say":"Opening',
        ' Code for you.","steps":[]}',
      ];
      for (const delta of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const early: string[] = [];
    const ac = new AbortController();
    const res = await runLocalBrain({
      url,
      model: "bonsai-2.5",
      messages: buildLocalBrainMessages("RULES", [], [], "Open Code"),
      schema: { type: "object" },
      signal: ac.signal,
      timeoutMs: 5000,
      onEarlySay: (say) => early.push(say),
    });

    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe('{"say":"Opening Code for you.","steps":[]}');
    expect(early.at(-1)).toBe("Opening Code for you.");
  });

  it("falls back from json_schema -> json_object -> plain on 400 errors and strips unsupported images", async () => {
    const seenModes: Array<string | undefined> = [];
    const seenArrayContents: boolean[] = [];

    const url = await startMockServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as {
        response_format?: { type?: string };
        messages: Array<{ content: unknown }>;
      };
      const hasArray = body.messages.some((m) => Array.isArray(m.content));
      seenArrayContents.push(hasArray);
      seenModes.push(body.response_format?.type);

      if (hasArray) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "This model does not support image inputs (multimodal)." } }));
        return;
      }
      if (body.response_format?.type === "json_schema" || body.response_format?.type === "json_object") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"say":"Recovered.","steps":[]}' } }] }));
    });

    const res = await runLocalBrain({
      url,
      model: "small-text-only",
      messages: buildLocalBrainMessages("RULES", [], [], "Describe screenshot", [{ mediaType: "image/png", base64: "AQID" }]),
      schema: { type: "object" },
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toBe('{"say":"Recovered.","steps":[]}');
    expect(seenArrayContents[0]).toBe(true);
    expect(seenArrayContents.at(-1)).toBe(false);
    expect(seenModes).toEqual(["json_schema", "json_schema", "json_object", undefined]);
  });

  it("returns aborted result cleanly when AbortSignal fires", async () => {
    const url = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Keep stream open until aborted.
    });

    const ac = new AbortController();
    const pending = runLocalBrain({
      url,
      model: "slow-model",
      messages: buildLocalBrainMessages("RULES", [], [], "Hello"),
      schema: { type: "object" },
      signal: ac.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => ac.abort(), 25);
    const res = await pending;
    expect(res.code).toBeNull();
    expect(res.timedOut).toBe(false);
  });
});
