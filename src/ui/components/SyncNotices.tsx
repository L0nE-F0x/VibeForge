import { FolderOpen, Laptop } from "lucide-react";
import { useState } from "react";
import type { SyncOffer, SyncView } from "../../shared/api.js";
import { tildify } from "../../shared/text.js";
import { call, useAppInfo } from "../api.js";
import { Rich } from "../i18n/Rich.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import { Button, Field, Input, Modal, Notice } from "./ui.js";

/**
 * What another machine is asking of this one: to pair, or to sync a workspace here. Shown above
 * Code's workspaces and in Settings → Sync, so an ask is seen wherever the person is.
 */
export function SyncNotices({ view }: { view: SyncView | undefined }) {
  const t = useT();
  const [answering, setAnswering] = useState<SyncOffer | null>(null);
  const [accept, accepting] = useAction(async (id: string) => call("sync.acceptMachine", id), t("sync.acceptFailed"));
  const [ignore] = useAction(async (id: string) => call("sync.ignoreMachine", id), t("sync.acceptFailed"));
  if (!view || (!view.requests.length && !view.offers.length)) return null;
  return (
    <div className="sync-notices">
      {view.requests.map((request) => (
        <div key={request.id} className="sync-notice">
          <Laptop size={14} className="accent-text" />
          <span className="grow">
            <Rich text={t("sync.request", { name: request.name || request.id.slice(0, 7), id: request.id.slice(0, 7) })} />
          </span>
          <Button size="sm" variant="primary" busy={accepting} onClick={() => void accept(request.id)}>
            {t("sync.accept")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void ignore(request.id)}>
            {t("sync.notNow")}
          </Button>
        </div>
      ))}
      {view.offers.map((offer) => (
        <div key={offer.folderId} className="sync-notice">
          <FolderOpen size={14} className="accent-text" />
          <span className="grow">
            <Rich text={t("sync.offer", { machine: offer.machineName, name: offer.name })} />
          </span>
          <Button size="sm" variant="primary" onClick={() => setAnswering(offer)}>
            {t("sync.offerAnswer")}
          </Button>
        </div>
      ))}
      {answering && <OfferDialog offer={answering} onClose={() => setAnswering(null)} />}
    </div>
  );
}

/** Taking up a workspace another machine offered: which folder it lands in here. */
function OfferDialog({ offer, onClose }: { offer: SyncOffer; onClose: () => void }) {
  const t = useT();
  const home = useAppInfo().data?.home ?? "";
  const [folder, setFolder] = useState(offer.suggestedPath);
  const [accept, accepting] = useAction(async () => {
    await call("sync.acceptOffer", offer.folderId, folder.trim().replace(/^~(?=\/|$)/, home));
    onClose();
  }, t("sync.offerFailed"));
  const [decline] = useAction(async () => {
    await call("sync.declineOffer", offer.folderId);
    onClose();
  }, t("sync.offerFailed"));
  const [choose] = useAction(async () => {
    const picked = await call("app.pickFolder", t("sync.offerFolder"));
    if (picked) setFolder(picked);
  });
  return (
    <Modal
      title={t("sync.offerTitle", { name: offer.name, machine: offer.machineName })}
      icon={Laptop}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => void decline()}>
            {t("sync.decline")}
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" busy={accepting} disabled={!folder.trim()} onClick={() => void accept()}>
            {t("sync.accept")}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t(`sync.modeHint.${offer.mode}`, { machine: offer.machineName })}</p>
      <Field label={t("sync.offerFolder")} hint={t("sync.offerFolderHint")}>
        <div className="hstack">
          <Input className="grow mono" value={tildify(folder, home)} onChange={(event) => setFolder(event.target.value)} spellCheck={false} />
          <Button size="sm" icon={FolderOpen} onClick={() => void choose()}>
            {t("sync.choose")}
          </Button>
        </div>
      </Field>
      {offer.suggestedHasFiles && folder === offer.suggestedPath && <Notice tone="warn">{t("sync.offerHasFiles", { machine: offer.machineName })}</Notice>}
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {offer.filesOnly ? t("sync.filesOnlyOn") : t("sync.filesOnlyOff")} {t("sync.ignored")}
      </p>
    </Modal>
  );
}
