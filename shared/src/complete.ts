/* ============================================================================
 * Pure completion engine — runs in Node (Vite dev middleware, Netlify
 * Function) AND in the browser (direct calls to local/custom endpoints).
 * Plain fetch, no dependencies. Keys pass through per-request; nothing is
 * stored or logged.
 * ==========================================================================*/
import { PROXY_PROVIDERS } from "./index.ts";
import type { CompleteRequest, CompleteResponse } from "./index.ts";

async function errText(res: Response, label: string): Promise<string> {
  let detail = "";
  try {
    const j: any = await res.json();
    detail = j.error?.message || j.error || j.message || JSON.stringify(j);
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    try { detail = await res.text(); } catch { /* ignore */ }
  }
  return `${label} API ${res.status}${detail ? ": " + detail.slice(0, 300) : ""}`;
}

/* ---------------- Anthropic ---------------- */
async function anthropic(req: CompleteRequest): Promise<CompleteResponse> {
  const { apiKey, model, system, user, maxTokens = 4096, search } = req;
  // NOTE: `temperature` is intentionally omitted. Current Anthropic models
  // (Opus 4.7+, Fable 5) reject it with a 400 ("temperature is deprecated for
  // this model"); older models simply use their default when it's absent. The
  // other providers below still pass it through.
  const body: any = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey || "",
      "anthropic-version": "2023-06-01",
      // Allow the call to run from the browser (BYOK key is already client-side),
      // so we can skip the relay and its serverless timeout. Ignored server-side.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "Anthropic"));
  const j: any = await res.json();
  const blocks = j.content || [];
  const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const cites = new Set<string>();
  for (const b of blocks) {
    if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) if (c?.url) cites.add(c.url);
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r?.url) cites.add(r.url);
  }
  return {
    text,
    citations: [...cites],
    usage: { inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0 },
  };
}

/* ---------------- OpenAI-compatible (OpenAI, xAI, OpenRouter, locals) ---------------- */
type SearchStyle = "openai" | "xai" | "none";

async function chatCompletions(
  url: string,
  label: string,
  req: CompleteRequest,
  searchStyle: SearchStyle,
  extraHeaders: Record<string, string> = {},
): Promise<CompleteResponse> {
  const { apiKey, model, system, user, maxTokens = 4096, temperature = 1, search } = req;
  const body: any = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (search) {
    if (searchStyle === "xai") {
      body.search_parameters = {
        mode: "auto",
        sources: [{ type: "web" }, { type: "x" }, { type: "news" }],
        return_citations: true,
        max_search_results: 12,
      };
    } else if (searchStyle === "openai") {
      body.web_search_options = {};
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errText(res, label));
  const j: any = await res.json();
  const msg = j.choices?.[0]?.message;
  const text = msg?.content || "";

  const cites = new Set<string>();
  if (Array.isArray(j.citations)) for (const c of j.citations) if (typeof c === "string") cites.add(c);
  if (Array.isArray(msg?.annotations)) {
    for (const a of msg.annotations) {
      const u = a?.url_citation?.url || (a?.type === "url_citation" ? a?.url : null);
      if (u) cites.add(u);
    }
  }
  return {
    text,
    citations: [...cites],
    usage: { inputTokens: j.usage?.prompt_tokens || 0, outputTokens: j.usage?.completion_tokens || 0 },
  };
}

/* ---------------- Gemini ---------------- */
async function gemini(req: CompleteRequest): Promise<CompleteResponse> {
  const { apiKey, model, system, user, maxTokens = 4096, temperature = 1, search } = req;
  const body: any = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (search) body.tools = [{ google_search: {} }];

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey || "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res, "Gemini"));
  const j: any = await res.json();
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p.text || "").join("");
  const cites = new Set<string>();
  for (const chunk of cand?.groundingMetadata?.groundingChunks || []) {
    if (chunk?.web?.uri) cites.add(chunk.web.uri);
  }
  return {
    text,
    citations: [...cites],
    usage: { inputTokens: j.usageMetadata?.promptTokenCount || 0, outputTokens: j.usageMetadata?.candidatesTokenCount || 0 },
  };
}

/* ---------------- router ---------------- */
export async function complete(req: CompleteRequest): Promise<CompleteResponse> {
  switch (req.provider) {
    case "anthropic":
      return anthropic(req);
    case "gemini":
      return gemini(req);
    case "openai":
      return chatCompletions("https://api.openai.com/v1/chat/completions", "OpenAI", req, "openai");
    case "xai":
      return chatCompletions("https://api.x.ai/v1/chat/completions", "xAI", req, "xai");
    case "openrouter": {
      // OpenRouter does web grounding via the `:online` model suffix.
      const model = req.search && !req.model.endsWith(":online") ? `${req.model}:online` : req.model;
      return chatCompletions(
        "https://openrouter.ai/api/v1/chat/completions",
        "OpenRouter",
        { ...req, model, search: false },
        "none",
        { "X-Title": "Vibe Forge" },
      );
    }
    default: {
      // Direct OpenAI-compatible endpoint (Ollama / LM Studio / custom).
      const base = (req.baseUrl || "").trim().replace(/\/+$/, "");
      if (!base) throw new Error("No base URL configured for this provider — set one in Settings.");
      return chatCompletions(`${base}/chat/completions`, "Endpoint", { ...req, search: false }, "none");
    }
  }
}

/* ---------------- server-side relay guard ----------------
 * Used by both the Vite dev middleware and the Netlify Function so dev and
 * prod behave identically. Only known cloud providers are relayed (canonical
 * hosts, baseUrl stripped) — never an open proxy. */
export async function handleProxyComplete(raw: unknown): Promise<{ status: number; body: CompleteResponse | { error: string } }> {
  const r = raw as Partial<CompleteRequest> | null;
  if (!r || typeof r !== "object") return { status: 400, body: { error: "Invalid request body." } };
  if (!r.provider || !PROXY_PROVIDERS.has(r.provider)) {
    return { status: 400, body: { error: "This provider is not relayed by the server — local providers run in your browser." } };
  }
  if (!r.apiKey || !String(r.apiKey).trim()) return { status: 400, body: { error: "Missing API key." } };
  if (!r.model || !r.system || !r.user) return { status: 400, body: { error: "Missing model, system, or user content." } };
  delete (r as any).baseUrl;
  try {
    const out = await complete(r as CompleteRequest);
    return { status: 200, body: out };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}
