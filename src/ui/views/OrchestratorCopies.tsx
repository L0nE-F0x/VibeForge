import { FileDiff, GitBranch, GitMerge, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CopyReview, MaestroCopy, Workspace } from "../../shared/api.js";
import { call, useAppInfo, useEngines, useWorkspaces } from "../api.js";
import { CopyApplyButton } from "../components/CopyApply.js";
import { DiffReview } from "../components/DiffReviewLazy.js";
import { useCopyPick, type CopyPick } from "../copy-pick.js";
import { Button, Notice, Sheet } from "../components/ui.js";
import { applyToast } from "../apply-note.js";
import { useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { useAction, useDeleted, useNav, useToast } from "../state.js";

// A Maestro step's own copy, once its CLI has started: what it changed, Apply into the workspace
// it came from, or Discard with Undo. The same loop a task's copy has; nothing happens without
// one of these clicks.

/** Apply and Discard for a copy, with the toasts a task's copy gives. */
function useCopyActions(copy: MaestroCopy, opts?: { skip?: string[]; onStayed?: () => void }) {
  const t = useT();
  const { push } = useToast();
  const deleted = useDeleted();
  const from = useWorkspaces().data?.workspaces.find((item) => item.id === copy.workspaceId);
  // Its workspace goes with it, so the browser dock it may have had goes too.
  const release = () => copy.openedWorkspaceId && void call("dock.release", copy.openedWorkspaceId).catch(() => undefined);
  const home = useAppInfo().data?.home ?? "";
  const [apply, applying] = useAction(async () => {
    const result = await call("orchestrator.applyCopy", copy.id, opts?.skip);
    const toast = applyToast(t, result, from?.name ?? "", home);
    push(toast.tone, toast.title, toast.body);
    // The copy stays: the review shows what is left, with what just went in marked applied.
    if (result.stayed || result.conflicts.length || result.left) opts?.onStayed?.();
    else release();
  }, t("tasks.applyFailed"));
  const [discard, discarding] = useAction(async () => {
    const result = await call("orchestrator.discardCopy", copy.id);
    release();
    deleted(t("orch.discarded", { branch: copy.name }), result);
  }, t("tasks.discardFailed"));
  return { from, apply, applying, discard, discarding };
}

/** Under a step that worked in its own copy. `onLeave` puts the Ctrl+Shift+O bar away first. */
export function CopyActions({ copy, onLeave }: { copy: MaestroCopy; onLeave?: (() => void) | null }) {
  const t = useT();
  const { go } = useNav();
  const { from, apply, applying, discard, discarding } = useCopyActions(copy);
  return (
    <div className="orch-copy">
      <Button
        size="sm"
        icon={FileDiff}
        onClick={() => {
          onLeave?.();
          go({ view: "orchestrator", copyId: copy.id });
        }}
      >
        {t("orch.review")}
      </Button>
      <Button size="sm" variant="primary" icon={GitMerge} busy={applying} tip={t("orch.applyTip", { workspace: from?.name ?? "" })} onClick={() => void apply()}>
        {t("tasks.apply", { workspace: from?.name ?? "" })}
      </Button>
      <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} tip={t("orch.discardTip")} onClick={() => void discard()}>
        {t("orch.discard")}
      </Button>
    </div>
  );
}

/** A copy up close: everything it changed, file by file, with Apply and Discard. `copies` is undefined until loaded. */
export function CopySheet({ copyId, copies }: { copyId: string; copies: MaestroCopy[] | undefined }) {
  const t = useT();
  const { go, replace } = useNav();
  const engines = useEngines().data ?? [];
  const copy = copies?.find((item) => item.id === copyId);
  const close = () => go({ view: "orchestrator" });
  const [review, setReview] = useState<CopyReview | null>(null);
  const [load, loading] = useAction(async () => setReview(await call("orchestrator.copyDiff", copyId)), t("orch.diffFailed"));
  const present = Boolean(copy);
  useEffect(() => {
    setReview(null);
    if (present) void load();
  }, [copyId, present, load]);
  // Applied, discarded, or gone since: back to the conversation.
  const gone = copies !== undefined && !copy;
  useEffect(() => {
    if (gone) replace({ view: "orchestrator" });
  }, [gone, replace]);
  const pick = useCopyPick(review?.files);
  if (!copy) return null;
  const engine = engines.find((item) => item.id === copy.engineId)?.label ?? copy.engineId;
  return (
    <Sheet onClose={close} width={1060} label={t("orch.reviewTitle", { name: copy.name })}>
      <div className="page-head">
        <GitBranch size={17} className="accent-text" />
        <h1 className="grow truncate">{t("orch.reviewTitle", { name: copy.name })}</h1>
        <Button variant="ghost" size="sm" icon={RotateCcw} busy={loading} tip={t("run.refreshDiff")} onClick={() => void load()} />
        <Button variant="ghost" size="sm" icon={X} onClick={close} title={t("common.closeEsc")} />
      </div>
      <div className="page-body vstack" style={{ gap: 14 }}>
        <CopyNotice copy={copy} engine={engine} pick={pick} onStayed={() => void load()} />
        {copy.prompt && <span className="orch-prompt-text">{copy.prompt}</span>}
        {review !== null && <DiffReview text={review.patch} reviewKey={`copy:${copy.id}`} workspaceId={copy.workspaceId} folder={copy.path} selection={pick.selection} />}
      </div>
    </Sheet>
  );
}

function CopyNotice({ copy, engine, pick, onStayed }: { copy: MaestroCopy; engine: string; pick: CopyPick; onStayed: () => void }) {
  const t = useT();
  const { from, apply, applying, discard, discarding } = useCopyActions(copy, { skip: pick.skip, onStayed });
  const workspace = from?.name ?? "";
  return (
    <Notice tone="accent" icon={GitBranch}>
      <div className="hstack wrap">
        <span className="grow">
          <Rich text={t("orch.copyNote", { engine, branch: copy.branch, workspace: from?.name ?? copy.repo })} />
        </span>
        <CopyApplyButton pick={pick} workspace={workspace} tip={t("orch.applyTip", { workspace })} busy={applying} onApply={() => void apply()} />
        <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} tip={t("orch.discardTip")} onClick={() => void discard()}>
          {t("orch.discard")}
        </Button>
      </div>
    </Notice>
  );
}

/** Copies waiting for review: shown in the top-right review popover, outliving their turns and a cleared thread. */
export function CopyList({ copies, workspaces, onPick }: { copies: MaestroCopy[]; workspaces: Workspace[]; onPick?: () => void }) {
  const t = useT();
  if (!copies.length) return null;
  return (
    <>
      <div className="orch-team-head">
        <span className="section-title" style={{ margin: 0 }}>
          {t("orch.toReview")}
        </span>
        <span className="count">{copies.length}</span>
      </div>
      <div className="orch-review-list">
        {copies.map((copy) => (
          <CopyRow key={copy.id} copy={copy} workspaces={workspaces} onPick={onPick} />
        ))}
      </div>
    </>
  );
}

function CopyRow({ copy, workspaces, onPick }: { copy: MaestroCopy; workspaces: Workspace[]; onPick?: () => void }) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const { from, apply, applying, discard, discarding } = useCopyActions(copy);
  const engine = engines.find((item) => item.id === copy.engineId)?.label ?? copy.engineId;
  const own = workspaces.find((item) => item.id === copy.openedWorkspaceId);
  return (
    <div className="row orch-member">
      <GitBranch size={13} className="accent-text" style={{ flex: "none" }} />
      <span className="vstack grow" style={{ gap: 0, minWidth: 0 }}>
        <span className="row-title truncate">{copy.name}</span>
        <span className="row-sub truncate">
          {engine} · {from?.name ?? copy.repo}
        </span>
      </span>
      <span className="row-actions">
        <Button
          size="sm"
          variant="ghost"
          icon={FileDiff}
          tip={t("orch.review")}
          onClick={() => {
            onPick?.();
            go({ view: "orchestrator", copyId: copy.id });
          }}
        />
        {own && (
          <Button
            size="sm"
            variant="ghost"
            icon={SquareTerminal}
            tip={t("orch.open")}
            onClick={() => {
              onPick?.();
              go({ view: "code", workspaceId: own.id });
            }}
          />
        )}
        <Button size="sm" variant="ghost" icon={GitMerge} busy={applying} tip={t("tasks.apply", { workspace: from?.name ?? "" })} onClick={() => void apply()} />
        <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} tip={t("orch.discardTip")} onClick={() => void discard()} />
      </span>
    </div>
  );
}
