import { ArrowLeft, ArrowLeftRight, ArrowRight, GitMerge, Laptop } from "lucide-react";
import { useState } from "react";
import type { SyncConflict, SyncMode, SyncShare, SyncView, Workspace } from "../../../shared/api.js";
import { call } from "../../api.js";
import { DiffView } from "../../components/RunDetail.js";
import { Button, Field, Modal, Notice, Segmented, Toggle } from "../../components/ui.js";
import { Rich } from "../../i18n/Rich.js";
import { useT, type Translator } from "../../i18n/index.js";
import { useAction, useToast } from "../../state.js";

/** What a share's state reads as, in a sentence. */
export function shareLine(t: Translator, share: SyncShare): string {
  const machine = share.machineName;
  if (share.conflicts) return t.count("sync.conflicts", share.conflicts);
  if (share.state === "syncing" && share.need > 0) return t.count("sync.state.syncingNeed", share.need, { machine });
  return t(`sync.state.${share.state}`, { machine });
}

/**
 * One workspace's sync with one machine: start it, change its direction, stop it, and answer the
 * files (or commits) both machines changed. Opened from the workspace's menu or its sync mark.
 */
export function SyncDialog({ workspace, machineId, view, onClose }: { workspace: Workspace; machineId: string; view: SyncView; onClose: () => void }) {
  const t = useT();
  const { push } = useToast();
  const share = view.shares.find((item) => item.workspaceId === workspace.id) ?? null;
  const machine = share?.machineName ?? view.machines.find((item) => item.id === machineId)?.name ?? "";
  const [mode, setMode] = useState<SyncMode>(share?.mode ?? "two");
  const [filesOnly, setFilesOnly] = useState(share?.filesOnly ?? false);
  const conflicts = share ? view.conflicts.filter((item) => item.folderId === share.folderId) : [];
  const changed = share ? mode !== share.mode || filesOnly !== share.filesOnly : true;

  const [save, saving] = useAction(async () => {
    if (share) await call("sync.updateShare", share.folderId, { mode, filesOnly });
    else await call("sync.share", workspace.id, machineId, { mode, filesOnly });
    onClose();
  }, t("sync.startFailed"));
  const [stop, stopping] = useAction(async () => {
    if (!share) return;
    await call("sync.stopShare", share.folderId);
    push("info", t("sync.stopped", { name: workspace.name }));
    onClose();
  }, t("sync.stopFailed"));

  return (
    <Modal
      title={t("sync.dialogTitle", { name: workspace.name, machine })}
      icon={Laptop}
      wide={conflicts.length > 0}
      onClose={onClose}
      footer={
        <>
          {share && (
            <Button variant="ghost" busy={stopping} onClick={() => void stop()}>
              {t("sync.stop")}
            </Button>
          )}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t(share && !changed ? "common.close" : "common.cancel")}
          </Button>
          {(!share || changed) && (
            <Button variant="primary" busy={saving} onClick={() => void save()}>
              {t(share ? "sync.save" : "sync.start")}
            </Button>
          )}
        </>
      }
    >
      {share && (
        <Notice tone={share.state === "error" ? "bad" : share.conflicts || share.peerLive.length ? "warn" : undefined}>
          <span className="vstack" style={{ gap: 2 }}>
            <span>{shareLine(t, share)}</span>
            {share.peerLive.length > 0 && <span>{t("sync.peerLive", { machine, what: share.peerLive.join(", ") })}</span>}
          </span>
        </Notice>
      )}
      {conflicts.length > 0 && (
        <div className="vstack" style={{ gap: 8 }}>
          <div className="field-label">{t("sync.conflictsTitle")}</div>
          {conflicts.map((conflict) => (
            <ConflictRow key={conflict.id} conflict={conflict} />
          ))}
        </div>
      )}
      <Field label={t("sync.mode")} hint={t(`sync.modeHint.${mode}`, { machine })}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "two", label: t("sync.mode.two"), icon: ArrowLeftRight },
            { value: "send", label: t("sync.mode.send"), icon: ArrowRight },
            { value: "receive", label: t("sync.mode.receive"), icon: ArrowLeft },
          ]}
        />
      </Field>
      <Field hint={filesOnly ? t("sync.filesOnlyOn") : t("sync.filesOnlyOff")}>
        <Toggle checked={filesOnly} onChange={setFilesOnly} label={t("sync.filesOnly")} />
      </Field>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {t("sync.ignored")}
      </p>
    </Modal>
  );
}

/** A file both machines changed, commits both made on one branch, or a synced agent's or skill's text, with the choices for it. */
export function ConflictRow({ conflict }: { conflict: SyncConflict }) {
  const t = useT();
  const { push } = useToast();
  const [diff, setDiff] = useState<string | null>(null);
  const [compare, comparing] = useAction(async () => {
    if (diff !== null) return setDiff(null);
    setDiff(await call("sync.conflictDiff", conflict.id));
  }, t("sync.resolveFailed"));
  const [resolve, resolving] = useAction(async (keep: "mine" | "theirs") => call("sync.resolveConflict", conflict.id, keep), t("sync.resolveFailed"));
  const [merge, merging] = useAction(async () => {
    const result = await call("sync.mergeConflict", conflict.id);
    if (result.merged) push("success", t("sync.merged", { saved: conflict.savedBranch ?? "", branch: conflict.path }));
    else if (result.refused) push("error", t("sync.mergeRefused", { why: result.refused }));
    else push("info", t.count("sync.mergeStopped", result.files.length));
  }, t("sync.resolveFailed"));

  if (conflict.kind === "commits") {
    return (
      <div className="sync-conflict">
        <span>
          <Rich text={t("sync.conflictCommits", { branch: conflict.path, machine: conflict.machineName, saved: conflict.savedBranch ?? "" })} />
        </span>
        <div className="hstack">
          <Button size="sm" variant="primary" icon={GitMerge} busy={merging} onClick={() => void merge()}>
            {t("sync.merge")}
          </Button>
          <Button size="sm" variant="ghost" busy={resolving} onClick={() => void resolve("theirs")}>
            {t("common.dismiss")}
          </Button>
        </div>
      </div>
    );
  }
  // Memory keeps both machines' lines, so "theirs" is the joined one now in use.
  const text = conflict.kind === "agent" || conflict.kind === "skill";
  const line = !text
    ? t("sync.conflictFile", { path: conflict.path, machine: conflict.machineName })
    : conflict.section === "memory"
      ? t("library.conflictMemory", { name: conflict.path })
      : t(conflict.kind === "skill" ? "library.conflictSkill" : "library.conflictBrief", { name: conflict.path, machine: conflict.machineName });
  return (
    <div className="sync-conflict">
      <span>
        <Rich text={line} />
      </span>
      <div className="hstack">
        <Button size="sm" pressed={diff !== null} busy={comparing} onClick={() => void compare()}>
          {t("sync.compare")}
        </Button>
        <span className="grow" />
        <Button size="sm" busy={resolving} onClick={() => void resolve("theirs")}>
          {conflict.section === "memory" ? t("library.keepJoined") : t("sync.keepTheirs", { machine: conflict.machineName })}
        </Button>
        <Button size="sm" variant="primary" busy={resolving} onClick={() => void resolve("mine")}>
          {t("sync.keepMine")}
        </Button>
      </div>
      {diff !== null && (diff.trim() ? <div className="sync-diff"><DiffView text={diff} /></div> : <span className="faint">{t("sync.noDiff")}</span>)}
    </div>
  );
}
