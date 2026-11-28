import { GitMerge } from "lucide-react";
import type { CopyPick } from "../copy-pick.js";
import { useT } from "../i18n/index.js";
import { Button } from "./ui.js";

/**
 * Apply for a copy under review: "Apply 2 of 3" while some files are left unticked, and a tip that
 * says the copy stays with them; otherwise the copy's own Apply and `tip`.
 */
export function CopyApplyButton({ pick, workspace, tip, busy, onApply }: { pick: CopyPick; workspace: string; tip: string; busy: boolean; onApply: () => void }) {
  const t = useT();
  return (
    <Button size="sm" variant="primary" icon={GitMerge} busy={busy} disabled={pick.none} tip={pick.partial ? t("review.applyPickedTip", { workspace }) : tip} onClick={onApply}>
      {pick.partial ? t("review.applyPicked", { count: pick.picked, total: pick.total, workspace }) : t("tasks.apply", { workspace })}
    </Button>
  );
}
