import { Check, Copy, ExternalLink, Eye, EyeOff, QrCode, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { CompanionStatus, PhoneReach, Settings } from "../../shared/api.js";
import { qrCode, qrPath } from "../../shared/qr.js";

type CompanionSettings = Settings["companion"];
import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction, useConfirm, useToast } from "../state.js";
import { Button, cx, Notice, Toggle } from "./ui.js";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
/** Signs this computer in to Tailscale, for one that has it installed but not connected. */
const TAILSCALE_UP = "sudo tailscale up";

/** One numbered step. Its number turns into a tick once the step is done. */
function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: ReactNode }) {
  return (
    <li className={cx("step", done && "done")}>
      <span className="step-n" aria-hidden="true">
        {done ? <Check size={12} strokeWidth={3} /> : n}
      </span>
      <div className="step-body">
        <span className="step-title">{title}</span>
        {children}
      </div>
    </li>
  );
}

/** A line to paste into a terminal, with Copy beside it. */
function Command({ text, onCopy, label }: { text: string; onCopy: (text: string) => void; label: string }) {
  return (
    <div className="hstack">
      <pre className="about-env selectable grow">{text}</pre>
      <Button size="sm" icon={Copy} onClick={() => onCopy(text)}>
        {label}
      </Button>
    </div>
  );
}

/** The link as a QR code: dark on white whatever the theme, so a phone's camera reads it. */
function QrImage({ text, label }: { text: string; label: string }) {
  const modules = useMemo(() => qrCode(text), [text]);
  if (!modules) return null;
  const size = modules.length + 8;
  return (
    <svg className="phone-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(modules)} fill="#000" />
    </svg>
  );
}

/**
 * Settings → Phone, as the steps that get the page onto a phone: turn it on, connect the two with
 * Tailscale, share the page, open it. Each step ticks itself off: the app asks this computer's
 * Tailscale where things stand, so only what is left to do is spelled out.
 */
export function CompanionCard() {
  const t = useT();
  const { push } = useToast();
  const confirm = useConfirm();
  const settings = useSettings().data;
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [reach, setReach] = useState<PhoneReach | null>(null);
  const [shown, setShown] = useState(false);
  const [qr, setQr] = useState(false);
  const [save] = useAction(async (companion: CompanionSettings) => call("settings.save", { companion }), t("companion.saveFailed"));

  useEffect(() => {
    if (!settings?.companion.enabled) {
      setStatus(null);
      setReach(null);
      return;
    }
    let gone = false;
    const load = () =>
      void call("companion.status")
        .then((next) => {
          if (!gone) setStatus(next);
        })
        .catch(() => undefined);
    // Slower than the page's own state: it runs `tailscale` twice, and changes only when a step is done.
    const look = () =>
      void call("companion.reach")
        .then((next) => {
          if (!gone) setReach(next);
        })
        .catch(() => undefined);
    load();
    look();
    const timer = window.setInterval(load, 2000);
    const slow = window.setInterval(look, 4000);
    return () => {
      gone = true;
      window.clearInterval(timer);
      window.clearInterval(slow);
    };
  }, [settings?.companion.enabled, settings?.companion.port, settings?.companion.token]);

  if (!settings) return null;
  const current = settings.companion;
  const local = status?.url || `http://127.0.0.1:${current.port}`;
  const patch = (next: Partial<CompanionSettings>) => void save({ ...current, ...next });
  const copy = (text: string) => void call("app.copyText", text).then(() => push("success", t("companion.copied")));
  const on = current.enabled;
  const connected = on && reach?.tailscale === "on";
  const address = on ? (reach?.url ?? null) : null;
  // The address with the pairing code after its `#`: a phone that opens it is paired. A browser never sends that part anywhere.
  const link = address && current.token ? `${address}/#pair=${current.token}` : null;

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {t("companion.lead")}
      </p>
      <ol className="steps">
        <Step n={1} done={on && !status?.error} title={t("companion.step1")}>
          <div className="hstack">
            <span className="grow">
              <Toggle checked={on} onChange={(enabled) => patch({ enabled })} label={on ? t("companion.onHint") : t("companion.offHint")} />
            </span>
            {on ? (
              <Button size="sm" icon={ExternalLink} onClick={() => void call("app.openExternal", local)}>
                {t("companion.open")}
              </Button>
            ) : null}
          </div>
          {on && status?.error ? <Notice tone="bad">{t("companion.down", { error: status.error })}</Notice> : null}
        </Step>
        {on ? (
          <>
            <Step n={2} done={connected} title={t("companion.step2")}>
              {!reach ? null : reach.tailscale === "missing" ? (
                <div className="hstack">
                  <span className="step-text grow">{t("companion.tsMissing")}</span>
                  <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => void call("app.openExternal", TAILSCALE_DOWNLOAD)}>
                    {t("companion.tsGet")}
                  </Button>
                </div>
              ) : reach.tailscale === "off" ? (
                <>
                  <span className="step-text">{t("companion.tsOff")}</span>
                  <Command text={TAILSCALE_UP} onCopy={copy} label={t("companion.copy")} />
                </>
              ) : (
                <span className="step-text">{t("companion.tsOn")}</span>
              )}
            </Step>
            <Step n={3} done={Boolean(address)} title={t("companion.step3")}>
              {address ? (
                <span className="step-text">{t("companion.shareDone")}</span>
              ) : connected ? (
                <>
                  <span className="step-text">{t("companion.shareTodo")}</span>
                  <Command text={reach?.command ?? ""} onCopy={copy} label={t("companion.copy")} />
                </>
              ) : reach ? (
                <span className="step-text">{t("companion.afterStep", { step: "2" })}</span>
              ) : null}
              {reach?.funnel ? <Notice tone="warn">{t("companion.funnel")}</Notice> : null}
              {status?.unsigned ? <Notice tone="warn">{t("companion.unsigned")}</Notice> : null}
            </Step>
            <Step n={4} done={false} title={t("companion.step4")}>
              {address ? (
                <>
                  <span className="step-text">{t("companion.openHint")}</span>
                  <div className="hstack">
                    <code className="mono grow selectable phone-address">{address}</code>
                    {link ? (
                      <Button size="sm" icon={QrCode} pressed={qr} onClick={() => setQr(!qr)}>
                        {qr ? t("companion.qrHide") : t("companion.qrShow")}
                      </Button>
                    ) : null}
                    <Button size="sm" icon={Copy} onClick={() => copy(address)}>
                      {t("companion.copy")}
                    </Button>
                  </div>
                  {qr && link ? (
                    <div className="hstack phone-qr-row">
                      <QrImage text={link} label={t("companion.qrShow")} />
                      <span className="step-text grow">{t("companion.qrHint")}</span>
                    </div>
                  ) : null}
                </>
              ) : reach ? (
                <span className="step-text">{t("companion.afterStep", { step: "3" })}</span>
              ) : null}
              {current.token ? (
                <div className="vstack" style={{ gap: 4 }}>
                  <span className="field-label">{t("companion.code")}</span>
                  <div className="hstack">
                    <code className={shown ? "mono grow selectable" : "mono grow faint"}>{shown ? current.token : `vf_${"•".repeat(16)}`}</code>
                    <Button size="sm" icon={shown ? EyeOff : Eye} tip={shown ? t("companion.hide") : t("companion.show")} pressed={shown} onClick={() => setShown(!shown)} />
                    <Button size="sm" icon={Copy} onClick={() => copy(current.token)}>
                      {t("companion.copy")}
                    </Button>
                    <Button
                      size="sm"
                      icon={RefreshCw}
                      onClick={() =>
                        // A new code signs every paired phone out at once, and that can't be undone.
                        void confirm({ title: t("companion.newCodeTitle"), body: t("companion.newCodeBody"), confirm: t("companion.newCode"), danger: true }).then((ok) => ok && patch({ token: "" }))
                      }
                    >
                      {t("companion.newCode")}
                    </Button>
                  </div>
                  <span className="step-text">{t("companion.codeHint")}</span>
                </div>
              ) : null}
            </Step>
          </>
        ) : null}
      </ol>
      {on ? (
        <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
          {t("companion.more")}
        </p>
      ) : null}
    </div>
  );
}
