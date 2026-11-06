import { canOrchestrate } from "../../shared/orchestrator.js";
import { call, useEngines, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { OrchestratorSettings } from "../../shared/api.js";
import { Field, Segmented, Select } from "./ui.js";

/** Settings → Orchestrator: which of your CLIs plans, and whether a plan waits for Go. */
export function OrchestratorCard() {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [save] = useAction(async (orchestrator: OrchestratorSettings) => call("settings.save", { orchestrator }), t("settings.saveFailed"));
  if (!settings) return null;
  const current = settings.orchestrator;
  const planners = engines.filter((engine) => canOrchestrate(engine));
  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <div className="form-grid">
        <Field label={t("orch.planner")} hint={t("orch.plannerHint")}>
          <Select value={current.engine} onChange={(event) => void save({ ...current, engine: event.target.value })}>
            {!planners.some((engine) => engine.id === current.engine) && <option value={current.engine}>{current.engine}</option>}
            {planners.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
                {engine.available ? "" : ` ${t("common.notOnPath")}`}
              </option>
            ))}
          </Select>
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
