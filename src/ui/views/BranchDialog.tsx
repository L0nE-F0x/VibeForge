import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { BranchList, Workspace, WorkspaceFile } from "../../shared/api.js";
import { tildify } from "../../shared/text.js";
import { call, errorText, useAppInfo } from "../api.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Input, Modal, Skeleton } from "../components/ui.js";
import { Rich } from "../i18n/Rich.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";

/**
 * Pick a branch and open it as its own workspace. The folder this was opened from stays
 * on the branch it already has.
 */
export function BranchDialog({
  workspace,
  onClose,
  onOpened,
}: {
  workspace: Workspace;
  onClose: () => void;
  onOpened: (file: WorkspaceFile) => void;
}) {
  const t = useT();
  const home = useAppInfo().data?.home ?? "";
  const [list, setList] = useState<BranchList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [openBranch, opening] = useAction(async (name: string) => {
    const file = await call("workspaces.openBranch", workspace.id, name);
    onOpened(file);
  }, t("code.openBranchFailed"));

  useEffect(() => {
    let cancelled = false;
    void call("workspaces.branches", workspace.id)
      .then((next) => {
        if (!cancelled) setList(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  useEffect(() => {
    if (!list) return;
    setChosen((prev) => {
      if (prev && list.branches.some((branch) => branch.name === prev && !branch.current)) return prev;
      return list.branches.find((branch) => !branch.current)?.name ?? null;
    });
  }, [list]);

  const needle = query.trim().toLowerCase();
  const shown = (list?.branches ?? []).filter((branch) => !needle || branch.name.toLowerCase().includes(needle));
  const selected = shown.find((branch) => branch.name === chosen && !branch.current) ?? null;
  const others = (list?.branches ?? []).some((branch) => !branch.current);

  return (
    <Modal
      title={t("code.openBranchTitle")}
      icon={GitBranch}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" icon={GitBranch} busy={opening} disabled={!selected} onClick={() => selected && void openBranch(selected.name)}>
            {t("code.openBranchAction")}
          </Button>
        </>
      }
    >
      {failed ? (
        <p>{failed}</p>
      ) : !list ? (
        <Skeleton rows={4} />
      ) : !list.repo ? (
        <p className="faint" style={{ margin: 0 }}>{t("code.openBranchNotRepo")}</p>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            <Rich text={list.current ? t("code.openBranchBody", { branch: list.current }) : t("code.openBranchDetached")} />
          </p>
          {!others && <p className="faint" style={{ margin: 0 }}>{t("code.openBranchEmpty")}</p>}
          {list.branches.length > 6 && (
            <Input autoFocus placeholder={t("code.openBranchFilter")} value={query} onChange={(event) => setQuery(event.target.value)} />
          )}
          {shown.length > 0 && (
            <div className="branch-list">
              {shown.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  className="row"
                  aria-selected={branch.name === selected?.name}
                  disabled={branch.current}
                  onClick={() => !branch.current && setChosen(branch.name)}
                  onDoubleClick={() => !branch.current && void openBranch(branch.name)}
                  {...tipProps(branch.checkout ? tildify(branch.checkout, home) : branch.commit, { side: "left" })}
                >
                  <GitBranch size={14} className="faint" />
                  <span className="vstack grow" style={{ gap: 0 }}>
                    <span className="row-title truncate mono">{branch.name}</span>
                    <span className="row-sub truncate">
                      {branch.current ? t("code.openBranchHere") : branch.checkout ? t("code.openBranchElsewhere") : branch.commit}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {needle && shown.length === 0 && <p className="faint" style={{ margin: 0 }}>{t("code.openBranchNone")}</p>}
          <p className="faint" style={{ margin: 0 }}>{t("code.openBranchNote")}</p>
        </>
      )}
    </Modal>
  );
}
