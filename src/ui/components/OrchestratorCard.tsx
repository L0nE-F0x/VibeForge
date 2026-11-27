import { useEffect, useRef, useState } from "react";
import { effortForModel, effortLevels } from "../../shared/launch-options.js";
import { LOCAL_ENGINE_ID, isLocalConfigured } from "../../shared/local.js";
import { canOrchestrate, plannerFor, RISK_POLICY_GROUPS } from "../../shared/orchestrator.js";
import { call, useEngines, useOrchestrator, useSettings } from "../api.js";
import { type Key, useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { OrchestratorSettings, SettingsPatch } from "../../shared/api.js";
import { Field, Input, Segmented, Select, Toggle } from "./ui.js";

const OTHER = "\u0000other";

/** Settings → Orchestrator: which of your CLIs plans, with which model and effort, and whether a plan waits for Go. */
export function OrchestratorCard() {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [save] = useAction(async (patch: SettingsPatch) => call("settings.save", patch), t("settings.saveFailed"));
  // Maestro's own view says where a new workspace goes when this is left empty.
  const view = useOrchestrator().data;
  if (!settings) return null;
  const current = settings.orchestrator;
  const local = settings.local;
  const localReady = Boolean(local.enabled && isLocalConfigured(local));
  const planners = engines
    .filter((engine) => canOrchestrate(engine))
    .map((engine) => (engine.id === LOCAL_ENGINE_ID ? { ...engine, available: localReady } : engine));
  if (local.enabled && !planners.some((engine) => engine.id === LOCAL_ENGINE_ID)) {
    planners.push({ id: LOCAL_ENGINE_ID, label: t("local.title"), bin: LOCAL_ENGINE_ID, args: [], available: localReady, path: null, local: true });
  }
  // Until one is picked, the first planner on this machine is the one shown (and used).
  const engineId = (local.enabled && local.active && local.useForViby && localReady ? LOCAL_ENGINE_ID : "") || plannerFor(current.engine, planners) || current.engine;
  const selectedEngine = planners.find((engine) => engine.id === engineId);
  const levels = selectedEngine ? effortLevels(selectedEngine) : [];
  const currentEffort = engineId === current.engine ? (current.effort ?? "") : "";
  const isLocal = engineId === LOCAL_ENGINE_ID;
  const currentModel = isLocal ? local.vibyModel : (engineId === current.engine ? current.model : "");
  const saveOrchestrator = (orchestrator: OrchestratorSettings) => {
    if (local.active && orchestrator.engine !== LOCAL_ENGINE_ID) {
      void save({ orchestrator, local: { useForViby: false } });
    } else if (local.active && orchestrator.engine === LOCAL_ENGINE_ID && !local.useForViby) {
      void save({ orchestrator, local: { useForViby: true } });
    } else {
      void save({ orchestrator });
    }
  };
  const modeHint =
    current.mode === "plan" ? t("orch.mode.planHint") : current.mode === "never" ? t("orch.mode.neverHint") : t("orch.mode.goHint");
  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <div className="form-grid">
        <Field label={t("orch.planner")} hint={t("orch.plannerHint")}>
          <Select value={engineId} onChange={(event) => saveOrchestrator({ ...current, engine: event.target.value, model: "", effort: "" })}>
            {!planners.some((engine) => engine.id === engineId) && <option value={engineId}>{engineId}</option>}
            {planners.map((engine) => (
              <option key={engine.id} value={engine.id} disabled={!engine.available && engine.id !== engineId}>
                {engine.id === LOCAL_ENGINE_ID ? t("local.title") : engine.label}
                {engine.available ? "" : ` ${engine.id === LOCAL_ENGINE_ID ? t("local.notReadyShort") : t("common.notOnPath")}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("orch.model")} hint={t("orch.modelHint")}>
          <ModelPick
            key={engineId}
            engineId={engineId}
            value={currentModel}
            defaultLabel={isLocal ? t("local.vibySame") : t("orch.modelDefault")}
            onChange={(model) => {
              if (isLocal) {
                void save({ local: { vibyModel: model } });
              } else {
                saveOrchestrator({ ...current, engine: engineId, model, effort: selectedEngine ? effortForModel(selectedEngine, model, currentEffort) : "" });
              }
            }}
          />
        </Field>
        <Field label={t("orch.effort")} hint={t("orch.effortHint")}>
          <Select value={currentEffort} disabled={!levels.length && !currentEffort} onChange={(event) => saveOrchestrator({ ...current, engine: engineId, effort: event.target.value })}>
            <option value="">{t("orch.effortLowDefault")}</option>
            {currentEffort && !levels.includes(currentEffort) && <option value={currentEffort}>{currentEffort}</option>}
            {levels.map((level) => (
              <option key={level} value={level}>
                {t("orch.effortIs", { effort: level })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("orch.modeLabel")} hint={modeHint}>
          <Segmented
            value={current.mode}
            options={[
              { value: "plan", label: t("orch.mode.plan") },
              { value: "go", label: t("orch.mode.go") },
              { value: "never", label: t("orch.mode.never") },
            ]}
            onChange={(mode) => void save({ orchestrator: { ...current, mode } })}
          />
        </Field>
        <Field label={t("orch.terseLabel")} hint={t("orch.terseHint")}>
          <Toggle checked={current.terse !== false} onChange={(terse) => void save({ orchestrator: { ...current, terse } })} />
        </Field>
        <Field label={t("orch.projectsFolder")} hint={t("orch.projectsFolderHint", { folder: view?.projectsFolder ?? "~/Projects" })}>
          <FolderInput value={current.projectsFolder} placeholder={view?.projectsFolder ?? "~/Projects"} onChange={(projectsFolder) => void save({ orchestrator: { ...current, projectsFolder } })} />
        </Field>
      </div>
      <details className="orch-risk-details">
        <summary>{t("orch.riskSummary")}</summary>
        <div className="orch-risk-grid">
          <div className="orch-risk-col">
            <div className="orch-risk-title">{t("orch.riskLowTitle")}</div>
            <ul className="orch-risk-list">
              {RISK_POLICY_GROUPS.filter((item) => item.risk === "low").map((item) => (
                <li key={item.key}>{t(item.key as Key)}</li>
              ))}
            </ul>
          </div>
          <div className="orch-risk-col">
            <div className="orch-risk-title">{t("orch.riskHighTitle")}</div>
            <ul className="orch-risk-list">
              {RISK_POLICY_GROUPS.filter((item) => item.risk === "high").map((item) => (
                <li key={item.key}>{t(item.key as Key)}</li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

/** A folder typed in (~ allowed), saved once the field is left. */
function FolderInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (folder: string) => void }) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  return (
    <Input
      className="mono"
      value={typed}
      placeholder={placeholder}
      onChange={(event) => setTyped(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
      onBlur={() => typed.trim() !== value && onChange(typed.trim())}
    />
  );
}

/**
 * The planner's model: its default, the ones it lists (asked for the first time the list is
 * opened, since Grok Build and Antigravity ask their own service), or a name typed in.
 */
function ModelPick({ engineId, value, defaultLabel, onChange }: { engineId: string; value: string; defaultLabel?: string; onChange: (model: string) => void }) {
  const t = useT();
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState(value);
  const skipBlurRef = useRef(false);
  useEffect(() => setTyped(value), [value]);
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
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          if (typed.trim() !== value) onChange(typed.trim());
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            skipBlurRef.current = true;
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
          skipBlurRef.current = false;
          setTyped(value);
          setTyping(true);
        } else onChange(event.target.value);
      }}
    >
      <option value="">{defaultLabel ?? t("orch.modelDefault")}</option>
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
