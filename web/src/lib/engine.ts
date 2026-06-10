import { providerInfo } from "@vibeforge/shared";
import type { CompleteRequest, CompleteResponse, ProviderId, Settings } from "@vibeforge/shared";
import { complete } from "@vibeforge/shared/complete";

export interface StepInput {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  search?: boolean;
}

export interface StepResult {
  text: string;
  citations: string[];
  provider: ProviderId;
  grounded: boolean;
}

/** Run one pipeline step on the provider configured for it.
 *  direct (local/custom) → browser fetch · cloud → /api/complete relay. */
export async function runStep(settings: Settings, step: "ideation" | "spec", input: StepInput): Promise<StepResult> {
  const pid = step === "ideation" ? settings.ideationProvider : settings.specProvider;
  const info = providerInfo(pid);
  const conf = settings.providers[pid] ?? { key: "", model: info.models[0]?.id ?? "" };
  const search = !!input.search && !!info.grounding;

  const req: CompleteRequest = {
    provider: pid,
    apiKey: conf.key?.trim() || undefined,
    model: (conf.model || info.models[0]?.id || "").trim(),
    baseUrl: (conf.baseUrl ?? info.defaultBaseUrl)?.trim() || undefined,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    search,
  };
  if (!req.model) throw new Error(`No model set for ${info.label} — pick one in Settings.`);
  if (info.transport === "proxy" && !req.apiKey) {
    throw new Error(`No API key for ${info.label}. Add one in Settings.`);
  }

  const exec = async (r: CompleteRequest): Promise<CompleteResponse> => {
    if (info.transport === "direct") return complete(r); // browser → local endpoint
    const res = await fetch("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r),
    });
    const j = await res.json().catch(() => ({ error: `Relay error ${res.status}` }));
    if (!res.ok) throw new Error((j as { error?: string }).error || `Relay error ${res.status}`);
    return j as CompleteResponse;
  };

  try {
    const out = await exec(req);
    return { text: out.text, citations: out.citations || [], provider: pid, grounded: search };
  } catch (e) {
    // Grounding may be unsupported by the chosen model — retry once without it.
    if (search) {
      const out = await exec({ ...req, search: false });
      return { text: out.text, citations: out.citations || [], provider: pid, grounded: false };
    }
    throw e;
  }
}
