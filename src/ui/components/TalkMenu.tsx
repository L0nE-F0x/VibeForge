import { ArrowLeft, CircleStop, FileDiff, MessageSquareText, MessagesSquare, ScanEye, Send, TextSelect } from "lucide-react";
import { useState } from "react";
import type { TalkState } from "../../shared/api.js";
import { call } from "../api.js";
import { useT } from "../i18n/index.js";
import { useToast } from "../state.js";
import { tipProps } from "./Tooltip.js";
import { Button, Menu, Popover, type MenuItem } from "./ui.js";

/** Another coding CLI a pane can send to: its terminal, its name, and where it is when that isn't here. */
export interface TalkTarget {
  ptyId: string;
  label: string;
  where: string | null;
}

/**
 * Send to…, in a pane's header: this CLI's last answer, the selected text or its changes, left as
 * a draft in another CLI's prompt; or Review with…, which has the other CLI review this one's
 * changes once its turn ends. With more than one other CLI, the first step picks which.
 */
export function TalkButton({
  ptyId,
  targets,
  selection,
  onDraft,
}: {
  ptyId: string;
  targets: TalkTarget[];
  /** The terminal's selected text right now. */
  selection: () => string;
  /** A draft landed in `toPty`: bring that pane forward so Enter is one key away. */
  onDraft: (toPty: string) => void;
}) {
  const t = useT();
  const { push, fail } = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState<TalkTarget | null>(null);
  // Read when the menu opens: a click elsewhere may clear it later.
  const [selected, setSelected] = useState("");
  if (!targets.length) return null;

  const close = () => {
    setAnchor(null);
    setTarget(null);
  };
  const send = async (to: TalkTarget, what: "reply" | "selection" | "changes") => {
    try {
      const result = await call("talk.sendDraft", ptyId, to.ptyId, what, what === "selection" ? selected : undefined);
      if (!result.sent) {
        push("info", what === "changes" ? t("talk.noChanges") : t("talk.nothing"));
        return;
      }
      push("info", t("talk.draftLeft", { name: to.label }), t("talk.draftLeftBody"));
      onDraft(to.ptyId);
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };
  const review = async (to: TalkTarget) => {
    try {
      await call("talk.review", ptyId, to.ptyId);
      push("info", t("talk.reviewArmed", { name: to.label }), t("talk.reviewArmedBody"));
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };

  const chosen = target ?? (targets.length === 1 ? targets[0] : null);
  const items: Array<MenuItem | "sep"> = chosen
    ? [
        ...(targets.length > 1 ? [{ label: chosen.label, icon: ArrowLeft, hint: chosen.where ?? undefined, onSelect: () => setTarget(null), keepOpen: true } as MenuItem, "sep" as const] : []),
        { label: t("talk.lastAnswer"), icon: MessageSquareText, onSelect: () => void send(chosen, "reply") },
        { label: t("talk.selection"), icon: TextSelect, disabled: !selected.trim(), onSelect: () => void send(chosen, "selection") },
        { label: t("talk.changes"), icon: FileDiff, onSelect: () => void send(chosen, "changes") },
        "sep",
        { label: t("talk.review", { name: chosen.label }), icon: ScanEye, hint: t("talk.reviewHint"), onSelect: () => void review(chosen) },
      ]
    : targets.map((item) => ({ label: item.label, hint: item.where ?? undefined, onSelect: () => setTarget(item), keepOpen: true }));

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={Send}
        tip={t("talk.send")}
        pressed={Boolean(anchor)}
        onClick={(event) => {
          setSelected(selection());
          setTarget(null);
          setAnchor(anchor ? null : event.currentTarget);
        }}
      />
      {anchor && (
        <Popover anchor={anchor} onClose={close} align="end">
          {!chosen && <div className="menu-head faint">{t("talk.sendTo")}</div>}
          <Menu items={items} onClose={close} />
        </Popover>
      )}
    </>
  );
}

/** While a CLI talks with others: with whom, how many messages, a review's step, and Stop. */
export function TalkChip({ ptyId, talk }: { ptyId: string; talk: TalkState }) {
  const t = useT();
  const review = talk.review;
  const round = review && review.rounds > 1 ? ` · ${t("talk.round", { round: review.round, rounds: review.rounds })}` : "";
  const text = review
    ? review.role === "reviewer"
      ? t("talk.reviewing", { name: review.other })
      : review.phase === "author"
        ? t("talk.reviewNext", { name: review.other })
        : review.phase === "reviewer"
          ? t("talk.beingReviewed", { name: review.other })
          : t("talk.fixing", { name: review.other })
    : talk.held
      ? t("talk.held", { names: talk.with.join(", "), max: talk.max })
      : talk.with.length
        ? t("talk.with", { names: talk.with.join(", "), count: talk.messages, max: talk.max })
        : t("talk.queued", { count: talk.queued });
  return (
    <span className={`pane-talk${talk.held ? " is-held" : ""}`}>
      <span className="chip accent" {...tipProps(t("talk.chipTip"))}>
        <MessagesSquare size={11} />
        <span className="truncate">
          {text}
          {round}
        </span>
      </span>
      <button type="button" className="pane-talk-stop" onClick={() => void call("talk.stop", ptyId)} {...tipProps(t("talk.stop"))} aria-label={t("talk.stop")}>
        <CircleStop size={13} />
      </button>
    </span>
  );
}
