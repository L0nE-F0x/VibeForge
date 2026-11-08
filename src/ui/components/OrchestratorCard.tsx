import { useState } from "react";
import { canOrchestrate, plannerFor } from "../../shared/orchestrator.js";
import { call, useEngines, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { OrchestratorSettings } from "../../shared/api.js";
import { Field, Input, Segmented, Select } from "./ui.js";

const OTHER = "\u0000other";

/** Settings → Orchestrator: which of your CLIs plans, with which model, and whether a plan waits for Go. */
export function OrchestratorCard() {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [save] = useAction(async (orchestrator: OrchestratorSettings) => call("settings.save", { orchestrator }), t("settings.saveFailed"));
  if (!settings) return null;
  const current = settings.orchestrator;
  const planners = engines.filter((engine) => canOrchestrate(engine));
  // Until one is picked, the first planner on this machine is the one shown (and used).
  const engineId = plannerFor(current.engine, engines) || current.engine;
  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <div className="form-grid">
        <Field label={t("orch.planner")} hint={t("orch.plannerHint")}>
          <Select value={engineId} onChange={(event) => void save({ ...current, engine: event.target.value, model: "" })}>
            {!planners.some((engine) => engine.id === engineId) && <option value={engineId}>{engineId}</option>}
            {planners.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
                {engine.available ? "" : ` ${t("common.notOnPath")}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("orch.model")} hint={t("orch.modelHint")}>
          <ModelPick key={engineId} engineId={engineId} value={engineId === current.engine ? current.model : ""} onChange={(model) => void save({ ...current, engine: engineId, model })} />
        </Field>
        <Field label={t("orch.modeLabel")} hint={current.mode === "plan" ? t("orch.mode.planHint") : t("orch.mode.goHint")}>
          <Segmented
            value={current.mode}
            options={[
              { value: "plan", label: t("orch.mode.plan") },
              { value: "go", label: t("orch.mode.go") },
            ]}
            onChange={(mode) => void save({ ...current, mode })}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * The planner's model: its default, the ones it lists (asked for the first time the list is
 * opened, since Grok Build and Antigravity ask their own service), or a name typed in.
 */
function ModelPick({ engineId, value, onChange }: { engineId: string; value: string; onChange: (model: string) => void }) {
  const t = useT();
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState(value);
  const load = () => {
    if (models || loading) return;
    setLoading(true);
    void call("orchestrator.models", engineId)
      .catch(() => [])
      .then((list) => setModels(list))
      .finally(() => setLoading(false));
  };
  const listed = models ?? [];
  if (typing) {
    return (
      <Input
        className="mono"
        autoFocus
        value={typed}
        placeholder={t("orch.modelPlaceholder")}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => {
          setTyping(false);
          if (typed.trim() !== value) onChange(typed.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setTyped(value);
            setTyping(false);
          }
        }}
      />
    );
  }
  return (
    <Select
      value={value}
      onFocus={load}
      onPointerDown={load}
      onChange={(event) => {
        if (event.target.value === OTHER) {
          setTyped(value);
          setTyping(true);
        } else onChange(event.target.value);
      }}
    >
      <option value="">{t("orch.modelDefault")}</option>
      {value && !listed.includes(value) && <option value={value}>{value}</option>}
      {listed.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
      {loading && <option disabled>{t("orch.modelsLoading")}</option>}
      <option value={OTHER}>{t("orch.modelOther")}</option>
    </Select>
  );
}
