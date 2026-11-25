import { AlertTriangle, RotateCcw } from "lucide-react";
import { useLoadShownHere, type Query } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { Button, Notice, useRetry } from "./ui.js";

// A read that failed says so, with Try again, instead of passing for an empty list. A view puts
// <LoadFailed> where its list would be; any named read no view shows in place is listed once for
// the whole window, at the top of the toasts (LoadProblems in ui.tsx).

/**
 * Where a list would be: why it couldn't be read, and Try again. Nothing while the read is fine.
 * `what` names the list when the query wasn't given a name of its own.
 */
export function LoadFailed({ query, what }: { query: Pick<Query<unknown>, "error" | "data" | "reload" | "key" | "what">; what?: Key }) {
  const t = useT();
  const failed = query.error !== null;
  useLoadShownHere(query.key, failed);
  const [retry, busy] = useRetry(query.reload);
  if (!failed) return null;
  const sentence = what ?? query.what ?? "load.other";
  return (
    <div className="load-failed" role="alert">
      <Notice tone="bad" icon={AlertTriangle}>
        <div className="vstack" style={{ gap: 6 }}>
          <strong className="load-failed-title">{t(sentence)}</strong>
          <span className="load-failed-reason selectable">{query.error}</span>
          <span className="load-failed-hint">{t(query.data === undefined ? "load.notEmpty" : "load.stale")}</span>
          <div>
            <Button size="sm" icon={RotateCcw} busy={busy} onClick={retry}>
              {t("common.tryAgain")}
            </Button>
          </div>
        </div>
      </Notice>
    </div>
  );
}
