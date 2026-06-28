/* Live "model radar" — the newest models to land across providers, pulled
 * straight from OpenRouter's public catalogue. The endpoint is keyless and
 * CORS-open, so the browser fetches it directly: no relay, no secret, no
 * backend. A small localStorage cache avoids re-pulling the ~500KB list on
 * every visit, and a curated fallback keeps the section populated offline. */

export interface RadarItem {
  id: string;
  provider: string;
  model: string;
  created: number; // unix seconds — drives the date + "New" badge
  note: string;
  href: string;
}

const FEED = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "vibeforge.radar.v2";
const CACHE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX = 6;

/** Shown until/unless the live feed loads — real recent launches, mid-2026. */
export const RADAR_FALLBACK: RadarItem[] = [
  { id: "sakana/fugu-ultra", provider: "Sakana", model: "Fugu Ultra", created: Date.parse("2026-06-24") / 1000, note: "Sakana's new frontier model, now available via OpenRouter.", href: "https://openrouter.ai/sakana/fugu-ultra" },
  { id: "cohere/north-mini-code", provider: "Cohere", model: "North Mini Code", created: Date.parse("2026-06-17") / 1000, note: "A compact, fast coding model from Cohere's North family.", href: "https://openrouter.ai/cohere/north-mini-code" },
  { id: "z-ai/glm-5.2", provider: "Z.ai", model: "GLM 5.2", created: Date.parse("2026-06-16") / 1000, note: "Open-weight frontier model strong on long-horizon coding and planning.", href: "https://openrouter.ai/z-ai/glm-5.2" },
  { id: "moonshotai/kimi-k2.7-code", provider: "MoonshotAI", model: "Kimi K2.7 Code", created: Date.parse("2026-06-12") / 1000, note: "Moonshot's agentic coding model with a long context window.", href: "https://openrouter.ai/moonshotai/kimi-k2.7-code" },
];

/** Newest text models from the live catalogue (cached 6h), or the fallback. */
export async function fetchRadar(signal?: AbortSignal): Promise<RadarItem[]> {
  const cached = readCache();
  if (cached) return cached;
  const res = await fetch(FEED, { signal });
  if (!res.ok) throw new Error(`radar feed ${res.status}`);
  const json = await res.json();
  const items = transform(Array.isArray(json?.data) ? json.data : []);
  if (items.length) writeCache(items);
  return items.length ? items : RADAR_FALLBACK;
}

function transform(data: any[]): RadarItem[] {
  const seen = new Set<string>();
  const out: RadarItem[] = [];
  const now = Date.now() / 1000;
  for (const m of [...data].sort((a, b) => (b?.created || 0) - (a?.created || 0))) {
    if (!m || typeof m.id !== "string" || m.id.startsWith("~")) continue; // skip alias rows
    const outMod: string[] = m.architecture?.output_modalities || [];
    if (!outMod.includes("text") || outMod.includes("image")) continue; // text models, not image generators
    const exp = Date.parse(m.expiration_date) / 1000;
    if (exp && exp < now) continue; // skip retired models
    const base = m.id.split(":")[0]; // collapse :free / :nitro variants to one row
    if (seen.has(base)) continue;
    seen.add(base);
    const [provider, model] = splitName(m.name, m.id);
    out.push({
      id: base, provider, model: model.replace(/\s*\((?:free|beta|preview)\)$/i, ""),
      created: m.created || 0, note: cleanDesc(m.description), href: `https://openrouter.ai/${base}`,
    });
    if (out.length >= MAX) break;
  }
  return out;
}

/** "Z.ai: GLM 5.2" → ["Z.ai", "GLM 5.2"]; falls back to the id's org slug. */
function splitName(name: string | undefined, id: string): [string, string] {
  const i = (name || "").indexOf(": ");
  if (i > 0) return [name!.slice(0, i), name!.slice(i + 2)];
  return [id.split("/")[0] || "Model", name || id];
}

/** Strip markdown to a short, plain one-liner (rendered as text — React escapes it). */
function cleanDesc(d?: string): string {
  let s = (d || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/[*_`>#]/g, "")                 // markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
  const dot = s.indexOf(". ");
  if (dot > 60 && dot < 170) s = s.slice(0, dot + 1);
  else if (s.length > 170) s = s.slice(0, 167).trimEnd() + "…";
  return s || "New model now available via OpenRouter.";
}

function readCache(): RadarItem[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, items } = JSON.parse(raw);
    if (Date.now() - at > CACHE_MS || !Array.isArray(items) || !items.length) return null;
    return items as RadarItem[];
  } catch { return null; }
}

function writeCache(items: RadarItem[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items })); } catch { /* ignore quota/private-mode */ }
}
