import { Copy, Download, ExternalLink, Laptop, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Settings } from "../../shared/api.js";
import { call, useSettings, useSync } from "../api.js";
import { coreText } from "../core-text.js";
import { useT } from "../i18n/index.js";
import { useAction, useConfirm, useToast } from "../state.js";
import { SyncNotices } from "./SyncNotices.js";
import { Button, Chip, Field, Input, Notice, TimeAgo, Toggle } from "./ui.js";

type SyncSettings = Settings["sync"];

/** Where paired machines connect; shown so a firewall rule can be written for it. */
const PORT = 22737;

/**
 * Settings → Sync: the switch, this machine's name and code, and the machines it is paired with.
 * Which workspaces sync is chosen on each workspace in Code, not here.
 */
export function SyncCard() {
  const t = useT();
  const { push } = useToast();
  const confirm = useConfirm();
  const settings = useSettings().data;
  const view = useSync().data;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [save] = useAction(async (sync: SyncSettings) => call("settings.save", { sync }), t("sync.saveFailed"));
  const [install, installing] = useAction(async () => call("sync.install"), t("sync.downloadFailed"));
  const [add, adding] = useAction(async () => {
    await call("sync.addMachine", code);
    setCode("");
  }, t("sync.addFailed"));
  const [unpair] = useAction(async (id: string) => call("sync.removeMachine", id), t("sync.unpairFailed"));

  useEffect(() => setName(settings?.sync.name ?? ""), [settings?.sync.name]);

  if (!settings) return null;
  const current = settings.sync;
  const patch = (next: Partial<SyncSettings>) => void save({ ...current, ...next });
  const copy = (text: string) => void call("app.copyText", text).then(() => push("success", t("sync.copied")));
  const running = Boolean(view?.running && view.me);

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {t("sync.lead")}
      </p>
      <Field hint={!current.enabled ? t("sync.offHint") : running ? t("sync.onHint", { port: String(PORT) }) : view && !view.available ? undefined : t("sync.starting")}>
        <Toggle checked={current.enabled} onChange={(enabled) => patch({ enabled })} label={t("sync.on")} />
      </Field>
      {current.enabled && view && !view.available ? (
        <Notice>
          <span className="hstack" style={{ alignItems: "center" }}>
            <span className="grow">{t("sync.missing")}</span>
            <Button size="sm" variant="primary" icon={Download} busy={installing} onClick={() => void install()}>
              {t("sync.download")}
            </Button>
          </span>
        </Notice>
      ) : null}
      {current.enabled && view?.error ? <Notice tone="bad">{t("sync.down", { error: coreText(view.error) })}</Notice> : null}
      {current.enabled && running && view?.me ? (
        <>
          <SyncNotices view={view} />
          {view.firewall ? (
            <Field label={t("sync.firewall")} hint={t("sync.firewallHint")}>
              <div className="hstack">
                <pre className="about-env selectable grow">{view.firewall}</pre>
                <Button size="sm" icon={Copy} onClick={() => copy(view.firewall ?? "")}>
                  {t("sync.copy")}
                </Button>
              </div>
            </Field>
          ) : null}
          <Field label={t("sync.name")} hint={t("sync.nameHint")}>
            <Input value={name} placeholder={view.me.name} maxLength={40} onChange={(event) => setName(event.target.value)} onBlur={() => name.trim() !== current.name && patch({ name: name.trim() })} />
          </Field>
          <Field label={t("sync.code")} hint={t("sync.codeHint", { id: view.me.id.slice(0, 7) })}>
            <div className="hstack">
              <code className="mono grow truncate selectable">{view.me.code}</code>
              <Button size="sm" icon={Copy} onClick={() => copy(view.me?.code ?? "")}>
                {t("sync.copy")}
              </Button>
            </div>
          </Field>
          <Field label={t("sync.add")} hint={t("sync.addHint")}>
            <div className="hstack">
              <Input
                className="grow mono"
                value={code}
                placeholder={t("sync.addPlaceholder")}
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code.trim()) void add();
                }}
              />
              <Button size="sm" icon={Plus} busy={adding} disabled={!code.trim()} onClick={() => void add()}>
                {t("sync.addAction")}
              </Button>
            </div>
          </Field>
          <Field label={t("sync.machines")}>
            {view.machines.length === 0 ? (
              <span className="faint">{t("sync.noMachines")}</span>
            ) : (
              <div className="vstack" style={{ gap: 6 }}>
                {view.machines.map((machine) => (
                  <div key={machine.id} className="hstack" style={{ alignItems: "center" }}>
                    <Laptop size={14} className="faint" />
                    <span className="grow truncate">{machine.name}</span>
                    {machine.connected ? (
                      <Chip tone="ok">{t("sync.connected")}</Chip>
                    ) : machine.lastSeen ? (
                      <span className="faint">
                        <TimeAgo iso={machine.lastSeen} prefix={`${t("sync.lastSeen")} `} />
                      </span>
                    ) : (
                      <span className="faint">{t("sync.neverSeen")}</span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        // Everything synced with it stops at once, on both machines.
                        void confirm({ title: t("sync.unpairTitle", { name: machine.name }), body: t("sync.unpairBody"), confirm: t("sync.unpair"), danger: true }).then((ok) => {
                          if (ok) void unpair(machine.id);
                        })
                      }
                    >
                      {t("sync.unpair")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Field>
        </>
      ) : null}
      <div className="hstack" style={{ alignItems: "center" }}>
        <span className="faint grow" style={{ fontSize: "var(--fs-sm)" }}>
          {t("sync.engine", { version: view?.engineVersion || "" })}
        </span>
        <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void call("app.openExternal", `https://github.com/syncthing/syncthing/tree/${view?.engineVersion || "main"}`)}>
          {t("sync.engineSource")}
        </Button>
      </div>
    </div>
  );
}
