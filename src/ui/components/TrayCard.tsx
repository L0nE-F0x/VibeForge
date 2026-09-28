import { useEffect, useState } from "react";
import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import { Field, Toggle } from "./ui.js";

/** Settings → Tray and startup: the tray icon, what closing the window does, and starting at login. */
export function TrayCard() {
  const t = useT();
  const settings = useSettings().data;
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  useEffect(() => {
    void call("app.autostart")
      .then(setAutostartState)
      .catch(() => setAutostartState(false));
  }, [settings]);
  const [save] = useAction(async (patch: { tray?: boolean; closeToTray?: boolean }) => call("settings.save", patch), t("tray.saveFailed"));
  const [setAutostart] = useAction(async (on: boolean) => setAutostartState(await call("app.setAutostart", on)), t("tray.saveFailed"));
  if (!settings) return null;

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <Field hint={settings.tray ? t("tray.showHint") : t("tray.offHint")}>
        <Toggle checked={settings.tray} onChange={(tray) => void save({ tray })} label={t("tray.show")} />
      </Field>
      <Field hint={t("tray.closeHint")}>
        <Toggle checked={settings.tray && settings.closeToTray} disabled={!settings.tray} onChange={(closeToTray) => void save({ closeToTray })} label={t("tray.close")} />
      </Field>
      <Field hint={t("tray.loginHint")}>
        <Toggle checked={Boolean(autostart)} disabled={autostart === null} onChange={(on) => void setAutostart(on)} label={t("tray.login")} />
      </Field>
    </div>
  );
}
