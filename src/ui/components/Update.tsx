import { CheckCircle2, Download, ExternalLink, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateInfo } from "../../shared/api.js";
import { call, useLive, useUpdate } from "../api.js";
import { useT, type Translator } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { useConfirm, useToast } from "../state.js";
import { LiveTerminal } from "./Terminal.js";
import { Button, Modal, Notice } from "./ui.js";

// Updating: the dialog shows what's new and runs the update command in a real terminal, so
// nothing happens out of sight, then offers a restart.

export const SHOW_UPDATE_EVENT = "vibeforge:update";

export function showUpdate(): void {
  window.dispatchEvent(new Event(SHOW_UPDATE_EVENT));
}

/** One line on where things stand: newest, behind, not checked, or failed. */
export function updateStatus(info: UpdateInfo, t: Translator): string {
  if (info.checking) return t("updates.checking");
  if (info.error) return t("updates.failed", { error: info.error });
  if (!info.checkedAt) return t("updates.never", { current: info.current });
  if (info.available && info.latest) return t("updates.available", { version: info.latest.version, current: info.current });
  if (!info.latest) return t("updates.noReleases", { current: info.current });
  return t("updates.current", { current: info.current });
}

export function checkedAt(info: UpdateInfo, t: Translator): string {
  if (!info.checkedAt || info.checking) return "";
  return t("updates.checkedAt", { time: new Date(info.checkedAt).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" }) });
}

export function installText(info: UpdateInfo, appPath: string, t: Translator): string {
  if (info.install === "installer") return t("updates.installInstaller", { path: appPath });
  if (info.install === "checkout") return t("updates.installCheckout", { path: appPath });
  return t("updates.installOther", { path: appPath });
}

export function UpdateSheet({ appPath, onClose }: { appPath: string; onClose: () => void }) {
  const t = useT();
  const info = useUpdate().data;
  const live = useLive().data ?? [];
  const confirm = useConfirm();
  const { fail } = useToast();
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [exit, setExit] = useState<{ code: number | null; signal: number | null } | null>(null);
  const running = Boolean(ptyId) && !exit;

  // Opening this is asking: check now if nothing is known yet.
  useEffect(() => {
    if (info && !info.checkedAt && !info.checking) void call("updates.check").catch(() => undefined);
  }, [info?.checkedAt, info?.checking]);

  if (!info) return null;
  const latest = info.latest;
  const succeeded = exit?.code === 0;

  const start = async () => {
    setExit(null);
    setPtyId(null);
    try {
      const started = await call("updates.run", { cols: 110, rows: 14 });
      setPtyId(started.ptyId);
    } catch (error) {
      fail(error);
    }
  };

  const restart = async () => {
    const others = live.filter((session) => session.ptyId !== ptyId).length;
    if (others > 0) {
      const ok = await confirm({ title: t("updates.restartTitle"), body: t.count("updates.restartBody", others), confirm: t("updates.restart") });
      if (!ok) return;
    }
    await call("app.restart");
  };

  const footer = running ? null : succeeded ? (
    <Button variant="primary" icon={RotateCcw} onClick={() => void restart()}>
      {t("updates.restart")}
    </Button>
  ) : (
    <>
      {latest?.url && (
        <Button variant="ghost" icon={ExternalLink} onClick={() => void call("app.openExternal", latest.url)}>
          {t("updates.notes")}
        </Button>
      )}
      <span className="grow" />
      <Button icon={RefreshCw} busy={info.checking} onClick={() => void call("updates.check")}>
        {t("updates.checkNow")}
      </Button>
      {info.available && info.command && (
        <Button variant="primary" icon={Download} onClick={() => void start()}>
          {exit ? t("common.tryAgain") : t("updates.now")}
        </Button>
      )}
    </>
  );

  return (
    <Modal title={t("updates.sheetTitle")} icon={Download} wide onClose={() => !running && onClose()} footer={footer}>
      <Notice tone={info.error ? "bad" : info.available ? "accent" : undefined}>
        {updateStatus(info, t)} {checkedAt(info, t)}
      </Notice>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        {installText(info, appPath, t)}
      </div>
      {info.available && latest && !ptyId && (
        <>
          <div className="list-label">{latest.name}</div>
          <pre className="update-notes selectable">{latest.notes.trim() || t("updates.noNotes")}</pre>
        </>
      )}
      {info.available && info.command && !ptyId && (
        <div className="vstack" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {t("updates.willRun")}
          </span>
          <code className="update-command selectable">{info.command}</code>
        </div>
      )}
      {ptyId && (
        <>
          <div className="update-term">
            <LiveTerminal ptyId={ptyId} autoFocus onExit={(result) => setExit({ code: result.exitCode, signal: result.signal })} />
          </div>
          {running ? (
            <Notice>
              {t("updates.running")} <Rich text={t("updates.waitToClose")} />
            </Notice>
          ) : succeeded ? (
            <Notice tone="accent" icon={CheckCircle2}>
              {latest ? t("updates.done", { version: latest.version }) : t("updates.doneUnknown")}
            </Notice>
          ) : (
            <Notice tone="bad" icon={XCircle}>
              {t("updates.stopped", { code: exit?.code ?? exit?.signal ?? "?" })}
            </Notice>
          )}
        </>
      )}
    </Modal>
  );
}
