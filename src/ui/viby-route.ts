import type { Engine, Settings } from "../shared/api.js";
import { LOCAL_ENGINE_ID, isLocalConfigured, shortLocalModel, vibyLocalModel, vibyPlanner } from "../shared/local.js";
import { canOrchestrate } from "../shared/orchestrator.js";
import type { Translator } from "./i18n/index.js";

/** What Viby plans with under these settings, as the service picks it (vibyPlanner). */
export interface VibyUse {
  engineId: string;
  /** Planning on the Local AI server. */
  local: boolean;
  /** "Claude Code · opus", "Local AI · qwen3-14b", or the planner alone when it runs its own default model. */
  label: string;
}

export function vibyUse(settings: Pick<Settings, "local" | "orchestrator">, engines: readonly Engine[], t: Translator): VibyUse {
  const { local, orchestrator } = settings;
  const localReady = Boolean(local.enabled && isLocalConfigured(local));
  const engineId =
    vibyPlanner({ local, localReady, picked: orchestrator.engine, engines: engines.filter((engine) => canOrchestrate(engine)) }) || orchestrator.engine;
  if (engineId === LOCAL_ENGINE_ID) {
    const model = shortLocalModel(vibyLocalModel(local));
    return { engineId, local: true, label: model ? `${t("local.title")} · ${model}` : t("local.title") };
  }
  const name = engines.find((engine) => engine.id === engineId)?.label ?? engineId;
  const model = engineId && engineId === orchestrator.engine ? orchestrator.model : "";
  return { engineId, local: false, label: name ? (model ? `${name} · ${model}` : name) : t("orch.title") };
}
