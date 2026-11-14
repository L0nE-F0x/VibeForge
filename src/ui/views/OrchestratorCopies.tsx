import { FileDiff, FileText, GitBranch, GitMerge, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MaestroCopy, Workspace } from "../../shared/api.js";
import { call, useEngines, useWorkspaces } from "../api.js";
import { DiffView } from "../components/RunDetail.js";
import { Button, Notice, Sheet } from "../components/ui.js";
import { applyConflictNote } from "../apply-note.js";
import { diffFiles } from "../diff-files.js";
import { useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { useAction, useDeleted, useNav, useToast } from "../state.js";

// A Maestro step's own copy, once its CLI has started: what it changed, Apply into the workspace
// it came from, or Discard with Undo. The same loop a task's copy has; nothing happens without
// one of these clicks.

/** Apply and Discard for a copy, with the toasts a task's copy gives. */
function useCopyActions(copy: MaestroCopy) {
  const t = useT();
  const { push } = useToast();
  const deleted = useDeleted();
  const from = useWorkspaces().data?.workspaces.find((item) => item.id === copy.workspaceId);
  // Its workspace goes with it, so the browser dock it may have had goes too.
  const release = () => copy.openedWorkspaceId && void call("dock.release", copy.openedWorkspaceId).catch(() => undefined);
  const [apply, applying] = useAction(async () => {
    const result = await call("orchestrator.applyCopy", copy.id);
    if (!result.files.length) push("info", t("tasks.applyNothing"));
    else if (result.conflicts.length) push("error", t("tasks.applyConflicts"), applyConflictNote(t, result));
    else push("success", t("tasks.applied", { workspace: from?.name ?? "" }), t.count("tasks.appliedBody", result.files.length));
    if (!result.conflicts.length) release();
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
  const [diff, setDiff] = useState<string | null>(null);
  const [load, loading] = useAction(async () => setDiff(await call("orchestrator.copyDiff", copyId)), t("orch.diffFailed"));
  const present = Boolean(copy);
  useEffect(() => {
    setDiff(null);
    if (present) void load();
  }, [copyId, present, load]);
  // Applied, discarded, or gone since: back to the conversation.
  const gone = copies !== undefined && !copy;
  useEffect(() => {
    if (gone) replace({ view: "orchestrator" });
  }, [gone, replace]);
  const files = useMemo(() => (diff ? diffFiles(diff) : []), [diff]);
  const box = useRef<HTMLDivElement>(null);
  if (!copy) return null;
  const engine = engines.find((item) => item.id === copy.engineId)?.label ?? copy.engineId;
  return (
    <Sheet onClose={close} width={1000} label={t("orch.reviewTitle", { name: copy.name })}>
      <div className="page-head">
        <GitBranch size={17} className="accent-text" />
        <h1 className="grow truncate">{t("orch.reviewTitle", { name: copy.name })}</h1>
        <Button variant="ghost" size="sm" icon={RotateCcw} busy={loading} tip={t("run.refreshDiff")} onClick={() => void load()} />
        <Button variant="ghost" size="sm" icon={X} onClick={close} title={t("common.closeEsc")} />
      </div>
      <div className="page-body vstack" style={{ gap: 14 }}>
        <CopyNotice copy={copy} engine={engine} />
        {copy.prompt && <span className="orch-prompt-text">{copy.prompt}</span>}
        {files.length > 0 && (
          <div className="diff-files">
            {files.map((file) => (
              <button key={file.line} type="button" className="diff-file" onClick={() => box.current?.querySelector(`[data-line="${file.line}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                <FileText size={13} className="faint" />
                <span className="mono truncate grow">{file.path}</span>
                {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
                {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
              </button>
            ))}
          </div>
        )}
        {diff !== null && (
          <div ref={box}>
            <DiffView text={diff} />
          </div>
        )}
      </div>
    </Sheet>
  );
}

function CopyNotice({ copy, engine }: { copy: MaestroCopy; engine: string }) {
  const t = useT();
  const { from, apply, applying, discard, discarding } = useCopyActions(copy);
  return (
    <Notice tone="accent" icon={GitBranch}>
      <div className="hstack wrap">
        <span className="grow">
          <Rich text={t("orch.copyNote", { engine, branch: copy.branch, workspace: from?.name ?? copy.repo })} />
        </span>
        <Button size="sm" variant="primary" icon={GitMerge} busy={applying} tip={t("orch.applyTip", { workspace: from?.name ?? "" })} onClick={() => void apply()}>
          {t("tasks.apply", { workspace: from?.name ?? "" })}
        </Button>
        <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} tip={t("orch.discardTip")} onClick={() => void discard()}>
          {t("orch.discard")}
        </Button>
      </div>
    </Notice>
  );
}

/** Copies waiting for review, beside the conversation: they outlive their plan cards and a new conversation. */
export function CopyList({ copies, workspaces }: { copies: MaestroCopy[]; workspaces: Workspace[] }) {
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
          <CopyRow key={copy.id} copy={copy} workspaces={workspaces} />
        ))}
      </div>
    </>
  );
}

function CopyRow({ copy, workspaces }: { copy: MaestroCopy; workspaces: Workspace[] }) {
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
        <Button size="sm" variant="ghost" icon={FileDiff} tip={t("orch.review")} onClick={() => go({ view: "orchestrator", copyId: copy.id })} />
        {own && <Button size="sm" variant="ghost" icon={SquareTerminal} tip={t("orch.open")} onClick={() => go({ view: "code", workspaceId: own.id })} />}
        <Button size="sm" variant="ghost" icon={GitMerge} busy={applying} tip={t("tasks.apply", { workspace: from?.name ?? "" })} onClick={() => void apply()} />
        <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} tip={t("orch.discardTip")} onClick={() => void discard()} />
      </span>
    </div>
  );
}
