import { useEffect, useState } from "react";
import type { CompanionStatus, Settings } from "../../shared/api.js";

type CompanionSettings = Settings["companion"];
import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction, useToast } from "../state.js";
import { Button, Field, Notice, Toggle } from "./ui.js";

/** Settings → Phone: the page this computer serves, and its pairing code. */
export function CompanionCard() {
  const t = useT();
  const { push } = useToast();
  const settings = useSettings().data;
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [save] = useAction(async (companion: CompanionSettings) => call("settings.save", { companion }), t("companion.saveFailed"));

  useEffect(() => {
    if (!settings?.companion.enabled) {
      setStatus(null);
      return;
    }
    let gone = false;
    const load = () =>
      void call("companion.status")
        .then((next) => {
          if (!gone) setStatus(next);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [settings?.companion.enabled, settings?.companion.port, settings?.companion.token]);

  if (!settings) return null;
  const current = settings.companion;
  const url = `http://127.0.0.1:${current.port}`;
  const patch = (next: Partial<CompanionSettings>) => void save({ ...current, ...next });

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--fs-sm)" }}>{t("companion.lead")}</p>
      <Field hint={current.enabled ? t("companion.onHint", { url: status?.url || url }) : t("companion.offHint")}>
        <Toggle checked={current.enabled} onChange={(enabled) => patch({ enabled })} label={t("companion.on")} />
      </Field>
      {current.enabled && status?.error ? <Notice tone="bad">{t("companion.down", { error: status.error })}</Notice> : null}
      {current.enabled && current.token ? (
        <Field label={t("companion.code")}>
          <div className="hstack">
            <code className="mono grow">{current.token}</code>
            <Button
              size="sm"
              onClick={() =>
                void call("app.copyText", current.token).then(() => push("success", t("companion.copied")))
              }
            >
              {t("companion.copy")}
            </Button>
            <Button size="sm" onClick={() => patch({ token: "" })}>
              {t("companion.newCode")}
            </Button>
          </div>
        </Field>
      ) : null}
      {current.enabled ? (
        <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--fs-sm)" }}>{t("companion.tailscale", { port: current.port })}</p>
      ) : null}
      <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--fs-sm)" }}>{t("companion.pocket")}</p>
    </div>
  );
}
