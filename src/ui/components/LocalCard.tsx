import { AlertTriangle, Check, Laptop, Network, Plug, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalHarness, LocalRuntimeStatus, LocalServerProbe, LocalSettings, SettingsPatch } from "../../shared/api.js";
import { LOCAL_PRESETS, cleanLocalModel, isLocalConfigured, isLoopbackLocalUrl, normalizeLocalUrl } from "../../shared/local.js";
import { call, useEngines, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import { vibyUse } from "../viby-route.js";
import { LocalServerSection } from "./LocalServerSection.js";
import { Button, Chip, Field, Input, Notice, Select, Toggle } from "./ui.js";

const OTHER = "\u0000other";
/** The "Viby in Local mode" choice that keeps Viby on its own (cloud) planner; any other value is a local model ("" = same as coding). */
const VIBY_CLOUD = "\u0000cloud";
const MIN_COMFORTABLE_CONTEXT = 32_768;

const HARNESS_LABELS: Record<"opencode" | "claude" | "codex", string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
};

function serverLabel(url: string): string {
  return LOCAL_PRESETS.find((preset) => preset.url === url)?.label ?? url;
}

function firstModelId(probe: LocalServerProbe | null): string {
  if (!probe?.models.length) return "";
  return probe.models.find((m) => m.loaded)?.id ?? probe.models[0]?.id ?? "";
}

/** Settings → Local AI: pick a local or home-network AI server, model, and coding tool. */
export function LocalCard() {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [status, setStatus] = useState<LocalRuntimeStatus | null>(null);
  const [probeOverride, setProbeOverride] = useState<LocalServerProbe | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [typingModel, setTypingModel] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const skipModelBlurRef = useRef(false);

  const [save] = useAction(async (local: NonNullable<SettingsPatch["local"]>) => call("settings.save", { local }), t("settings.saveFailed"));

  const currentUrl = settings?.local.url ?? "";
  const [checkStatus, checking] = useAction(
    async (targetUrl?: string) => {
      const next = await call("local.status", targetUrl ?? currentUrl);
      setStatus(next);
      setProbeOverride(next.configured);
      return next;
    },
    t("settings.recheckFailed"),
  );

  const savedUrl = settings?.local.url;
  useEffect(() => {
    if (savedUrl === undefined) return;
    setUrlInput(savedUrl);
  }, [savedUrl]);

  useEffect(() => {
    if (!settings?.local.enabled) return;
    let alive = true;
    void call("local.status", settings.local.url)
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setProbeOverride(next.configured);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [settings?.local.enabled, settings?.local.url]);

  const applyServerProbe = useCallback(
    async (probe: LocalServerProbe, current: LocalSettings) => {
      setProbeOverride(probe);
      setUrlInput(probe.url);
      if (!probe.reachable || !probe.url) return;
      const modelIds = probe.models.map((m) => m.id);
      const keepModel = current.model && (!modelIds.length || modelIds.includes(current.model));
      const nextModel = keepModel ? current.model : firstModelId(probe);
      const keepViby = current.vibyModel && (!modelIds.length || modelIds.includes(current.vibyModel));
      await save({
        enabled: true,
        url: probe.url,
        model: nextModel,
        vibyModel: keepViby ? current.vibyModel : "",
      });
    },
    [save],
  );

  const [connectUrl, connecting] = useAction(async () => {
    if (!settings) return;
    const probe = await call("local.probe", urlInput);
    await applyServerProbe(probe, settings.local);
    if (!probe.reachable) {
      const normalized = normalizeLocalUrl(urlInput);
      if (normalized && normalized !== settings.local.url) {
        await save({ enabled: true, url: normalized });
      }
    }
  }, t("local.unreachable"));

  const [selectPreset] = useAction(async (presetUrl: string) => {
    if (!settings) return;
    const existing = status?.servers.find((s) => s.url === presetUrl);
    const probe = existing ?? (await call("local.probe", presetUrl));
    await applyServerProbe(probe, settings.local);
  }, t("local.unreachable"));

  if (!settings) return null;
  const local = settings.local;
  const activeProbe = probeOverride ?? status?.configured ?? null;
  const detectedServers = status?.servers.filter((s) => s.reachable) ?? [];
  const configuredReady = isLocalConfigured(local);
  const models = activeProbe?.models ?? [];
  const modelIds = models.map((m) => m.id);
  const selectedInfo = models.find((m) => m.id === local.model);
  const effectiveContext = selectedInfo?.contextLength ?? activeProbe?.contextLength ?? null;
  const hasAnyHarness = status ? status.harnesses.some((h) => h.available) : true;
  const normalizedConfigured = normalizeLocalUrl(local.url);
  const showLoopback = Boolean(normalizedConfigured) && isLoopbackLocalUrl(normalizedConfigured);
  const resolvedHarness = local.harness === "auto" ? (status?.harnesses.find((h) => h.available)?.id ?? null) : local.harness;

  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <Field label={t("local.enable")} hint={t("local.enableHint")}>
        <Toggle
          checked={local.enabled}
          onChange={(enabled) => {
            void save({ enabled, ...(enabled ? {} : { active: false }) });
          }}
        />
      </Field>

      {local.enabled && (
        <>
          <div className="form-grid">
            <Field label={t("local.active")} hint={configuredReady ? t("local.activeHint") : t("local.activeNeedSetup")}>
              <Toggle
                checked={local.active}
                disabled={!configuredReady && !local.active}
                onChange={(active) => void save({ active })}
              />
            </Field>

            <Field label={t("local.overrideAgents")} hint={t("local.overrideAgentsHint")}>
              <Toggle
                checked={local.overrideAgents}
                onChange={(overrideAgents) => void save({ overrideAgents })}
              />
            </Field>

            <Field label={t("local.detected")} hint={t("local.detectedHint")}>
              <div className="hstack wrap" style={{ gap: 6 }}>
                {detectedServers.map((srv) => {
                  const selected = normalizeLocalUrl(local.url) === srv.url;
                  return (
                    <Button
                      key={srv.url}
                      size="sm"
                      variant={selected ? "primary" : undefined}
                      icon={selected ? Check : Laptop}
                      onClick={() => void selectPreset(srv.url)}
                    >
                      {serverLabel(srv.url)} ({t.count("local.modelsCount", srv.models.length)})
                    </Button>
                  );
                })}
                {!detectedServers.length && status && (
                  <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                    {t("local.noneDetected")}
                  </span>
                )}
                <Button size="sm" variant="ghost" icon={RefreshCw} busy={checking} onClick={() => void checkStatus()}>
                  {t("local.checkAgain")}
                </Button>
              </div>
            </Field>

            <Field label={t("local.url")} hint={t("local.urlHint")}>
              <div className="vstack" style={{ gap: 6 }}>
                <div className="hstack" style={{ gap: 6 }}>
                  <Input
                    className="mono grow"
                    value={urlInput}
                    placeholder={t("local.urlPlaceholder")}
                    onChange={(event) => setUrlInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void connectUrl();
                      }
                    }}
                  />
                  <Button icon={Plug} busy={connecting} onClick={() => void connectUrl()}>
                    {t("local.connect")}
                  </Button>
                </div>

                {(normalizedConfigured || activeProbe) && (
                  <div className="hstack wrap" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
                    {normalizedConfigured && (
                      <Chip icon={showLoopback ? Laptop : Network} tone={showLoopback ? "ok" : "info"}>
                        {showLoopback ? t("local.whereLocal") : t("local.whereNetwork")}
                      </Chip>
                    )}
                    {activeProbe?.reachable ? (
                      <span style={{ color: "var(--green)" }}>
                        {activeProbe.models.length
                          ? t("local.connected", { models: t.count("local.modelsCount", activeProbe.models.length) })
                          : t("local.connectedNoModels")}
                      </span>
                    ) : activeProbe?.error ? (
                      <span style={{ color: "var(--red)" }}>
                        {t("local.unreachable")}: {activeProbe.error}
                      </span>
                    ) : null}
                  </div>
                )}

                {normalizedConfigured && !showLoopback && (
                  <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                    {t("local.networkNote")}
                  </span>
                )}
              </div>
            </Field>

            <Field label={t("local.model")} hint={t("local.modelHint")}>
              <div className="vstack" style={{ gap: 6 }}>
                {typingModel ? (
                  <Input
                    className="mono"
                    autoFocus
                    value={modelInput}
                    placeholder={t("local.modelPlaceholder")}
                    onChange={(event) => setModelInput(event.target.value)}
                    onBlur={() => {
                      setTypingModel(false);
                      if (skipModelBlurRef.current) {
                        skipModelBlurRef.current = false;
                        return;
                      }
                      const clean = cleanLocalModel(modelInput);
                      if (clean && clean !== local.model) void save({ model: clean });
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        skipModelBlurRef.current = true;
                        setModelInput(local.model);
                        setTypingModel(false);
                      }
                    }}
                  />
                ) : (
                  <Select
                    value={local.model}
                    onChange={(event) => {
                      if (event.target.value === OTHER) {
                        skipModelBlurRef.current = false;
                        setModelInput(local.model);
                        setTypingModel(true);
                      } else {
                        void save({ model: event.target.value });
                      }
                    }}
                  >
                    <option value="">{t("local.modelPick")}</option>
                    {local.model && !modelIds.includes(local.model) && <option value={local.model}>{local.model}</option>}
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                    <option value={OTHER}>{t("local.modelOther")}</option>
                  </Select>
                )}

                {effectiveContext !== null && effectiveContext >= MIN_COMFORTABLE_CONTEXT && (
                  <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                    {t("local.contextInfo", { ctx: Math.round(effectiveContext / 1024) })}
                  </span>
                )}
              </div>
            </Field>

            <Field label={t("local.harness")} hint={t("local.harnessHint")}>
              <div className="vstack" style={{ gap: 6 }}>
                <Select
                  value={local.harness}
                  onChange={(event) => void save({ harness: event.target.value as LocalHarness })}
                >
                  <option value="auto">{t("local.harnessAuto")}</option>
                  {(status?.harnesses ??
                    (["opencode", "claude", "codex"] as const).map((id) => ({
                      id,
                      label: HARNESS_LABELS[id],
                      available: true,
                      path: null,
                    }))).map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.available && local.harness !== item.id}>
                      {item.label}
                      {item.available ? "" : ` ${t("common.notOnPath")}`}
                    </option>
                  ))}
                </Select>
                {resolvedHarness === "codex" && (
                  <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                    {t("local.codexResponsesNote")}
                  </span>
                )}
              </div>
            </Field>

            <Field label={t("local.vibyRoute")} hint={t("local.vibyRouteHint")}>
              <div className="vstack" style={{ gap: 6 }}>
                <Select
                  value={local.viby === "cloud" ? VIBY_CLOUD : local.vibyModel}
                  onChange={(event) => {
                    const picked = event.target.value;
                    // Cloud keeps the local model picked for Viby: it is still used when Local is Viby's own planner.
                    void save(picked === VIBY_CLOUD ? { viby: "cloud" } : { viby: "local", vibyModel: picked });
                  }}
                >
                  <option value={VIBY_CLOUD}>{t("local.vibyCloud")}</option>
                  <option value="">{t("local.vibyLocalSame")}</option>
                  {local.vibyModel && !modelIds.includes(local.vibyModel) && (
                    <option value={local.vibyModel}>{t("local.vibyLocalModel", { model: local.vibyModel })}</option>
                  )}
                  {models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t("local.vibyLocalModel", { model: item.id })}
                    </option>
                  ))}
                </Select>
                <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                  {t(local.active ? "local.vibyNow" : "local.vibyInLocalMode", {
                    viby: vibyUse({ local: { ...local, active: true }, orchestrator: settings.orchestrator }, engines, t).label,
                  })}
                </span>
              </div>
            </Field>
          </div>

          <div style={{ borderTop: "1px solid var(--line)" }} />
          <LocalServerSection local={local} save={save} />

          {effectiveContext !== null && effectiveContext < MIN_COMFORTABLE_CONTEXT && (
            <Notice tone="warn" icon={AlertTriangle}>
              {t("local.smallContext", { ctx: effectiveContext.toLocaleString() })}
            </Notice>
          )}

          {!hasAnyHarness && (
            <Notice tone="warn" icon={AlertTriangle}>
              {t("local.noHarness")}
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
