import { Copy, ExternalLink, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanionStatus, Settings } from "../../shared/api.js";

type CompanionSettings = Settings["companion"];
import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction, useToast } from "../state.js";
import { Button, Field, Notice, Toggle } from "./ui.js";

/** Settings → Phone: the page this computer serves, its pairing code, and the one Tailscale command. */
export function CompanionCard() {
  const t = useT();
  const { push } = useToast();
  const settings = useSettings().data;
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [shown, setShown] = useState(false);
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
  const url = status?.url || `http://127.0.0.1:${current.port}`;
  const serve = `tailscale serve --bg --https=443 http://127.0.0.1:${current.port}`;
  const patch = (next: Partial<CompanionSettings>) => void save({ ...current, ...next });
  const copy = (text: string) => void call("app.copyText", text).then(() => push("success", t("companion.copied")));

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {t("companion.lead")}
      </p>
      <Field hint={current.enabled ? t("companion.onHint", { url }) : t("companion.offHint")}>
        <div className="hstack">
          <span className="grow">
            <Toggle checked={current.enabled} onChange={(enabled) => patch({ enabled })} label={t("companion.on")} />
          </span>
          {current.enabled ? (
            <Button size="sm" icon={ExternalLink} onClick={() => void call("app.openExternal", url)}>
              {t("companion.open")}
            </Button>
          ) : null}
        </div>
      </Field>
      {current.enabled && status?.error ? <Notice tone="bad">{t("companion.down", { error: status.error })}</Notice> : null}
      {current.enabled && current.token ? (
        <Field label={t("companion.code")} hint={t("companion.codeHint")}>
          <div className="hstack">
            <code className={shown ? "mono grow selectable" : "mono grow faint"}>{shown ? current.token : `vf_${"•".repeat(16)}`}</code>
            <Button size="sm" icon={shown ? EyeOff : Eye} tip={shown ? t("companion.hide") : t("companion.show")} pressed={shown} onClick={() => setShown(!shown)} />
            <Button size="sm" icon={Copy} onClick={() => copy(current.token)}>
              {t("companion.copy")}
            </Button>
            <Button size="sm" icon={RefreshCw} onClick={() => patch({ token: "" })}>
              {t("companion.newCode")}
            </Button>
          </div>
        </Field>
      ) : null}
      {current.enabled ? (
        <Field label={t("companion.reach")} hint={t("companion.tailscale")}>
          <div className="hstack">
            <pre className="about-env selectable grow">{serve}</pre>
            <Button size="sm" icon={Copy} onClick={() => copy(serve)}>
              {t("companion.copy")}
            </Button>
          </div>
        </Field>
      ) : null}
    </div>
  );
}
