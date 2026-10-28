import { ArrowLeft, CircleStop, FileDiff, ListChecks, MessageSquareText, MessagesSquare, Play, ScanEye, Send, SquarePlus, TextSelect, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TalkState } from "../../shared/api.js";
import { call } from "../api.js";
import { useT } from "../i18n/index.js";
import { useDeleted, useToast } from "../state.js";
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
 * changes once its turn ends, or a new CLI started beside it for that. The first step picks which
 * CLI, unless the only other one is in this workspace: one somewhere else is never picked unseen.
 */
export function TalkButton({
  ptyId,
  targets,
  engines,
  selection,
  onDraft,
  onNewReviewer,
}: {
  ptyId: string;
  targets: TalkTarget[];
  /** The CLIs that could be started beside this one to review it. */
  engines: Array<{ id: string; label: string }>;
  /** The terminal's selected text right now. */
  selection: () => string;
  /** A draft landed in `toPty`: bring that pane forward so Enter is one key away. */
  onDraft: (toPty: string) => void;
  /** Start `engineId` in a new pane beside this one; its terminal, or null when it didn't start. */
  onNewReviewer: (engineId: string) => Promise<string | null>;
}) {
  const t = useT();
  const { push, fail } = useToast();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState<TalkTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [newHere, setNewHere] = useState(false);
  // Read when the menu opens: a click elsewhere may clear it later.
  const [selected, setSelected] = useState("");
  if (!targets.length && !engines.length) return null;

  const close = () => {
    setAnchor(null);
    setTarget(null);
    setPicking(false);
    setNewHere(false);
  };
  const back = () => {
    setTarget(null);
    setNewHere(false);
    setPicking(true);
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
      const { changes } = await call("talk.review", ptyId, to.ptyId);
      if (changes) push("info", t("talk.reviewArmed", { name: to.label }), t("talk.reviewArmedBody"));
      else push("info", t("talk.reviewWaits", { name: to.label }), t("talk.reviewWaitsBody"));
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };
  const reviewWithNew = async (engine: { id: string; label: string }) => {
    try {
      const started = await onNewReviewer(engine.id);
      // A start that failed has said why already.
      if (started) await review({ ptyId: started, label: engine.label, where: null });
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };

  const only = !picking && targets.length === 1 && targets[0].where === null ? targets[0] : null;
  const chosen = newHere ? null : (target ?? only);
  const canGoBack = targets.length > 1 || engines.length > 0 || chosen?.where != null;
  const items: Array<MenuItem | "sep"> = newHere
    ? [
        { label: t("talk.newReviewer"), icon: ArrowLeft, onSelect: back, keepOpen: true },
        "sep",
        ...engines.map((engine): MenuItem => ({ label: engine.label, icon: ScanEye, hint: t("talk.newReviewerHint"), onSelect: () => void reviewWithNew(engine) })),
      ]
    : chosen
      ? [
          ...(canGoBack ? [{ label: chosen.label, icon: ArrowLeft, hint: chosen.where ?? undefined, onSelect: back, keepOpen: true } as MenuItem, "sep" as const] : []),
          { label: t("talk.lastAnswer"), icon: MessageSquareText, onSelect: () => void send(chosen, "reply") },
          { label: t("talk.selection"), icon: TextSelect, disabled: !selected.trim(), onSelect: () => void send(chosen, "selection") },
          { label: t("talk.changes"), icon: FileDiff, onSelect: () => void send(chosen, "changes") },
          "sep",
          { label: t("talk.review", { name: chosen.label }), icon: ScanEye, hint: t("talk.reviewHint"), onSelect: () => void review(chosen) },
        ]
      : [
          ...targets.map((item): MenuItem => ({ label: item.label, hint: item.where ?? undefined, onSelect: () => setTarget(item), keepOpen: true })),
          ...(engines.length
            ? [...(targets.length ? ["sep" as const] : []), { label: t("talk.newReviewer"), icon: SquarePlus, onSelect: () => setNewHere(true), keepOpen: true } as MenuItem]
            : []),
        ];

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
          setPicking(false);
          setNewHere(false);
          setAnchor(anchor ? null : event.currentTarget);
        }}
      />
      {anchor && (
        <Popover anchor={anchor} onClose={close} align="end">
          {!chosen && !newHere && <div className="menu-head faint">{t("talk.sendTo")}</div>}
          <Menu items={items} onClose={close} />
        </Popover>
      )}
    </>
  );
}

/** While a CLI talks with others: with whom, how many messages, a review's step, and Stop; and tasks it handed out that wait for Start. */
export function TalkChip({ ptyId, talk }: { ptyId: string; talk: TalkState }) {
  const start = talk.toStart.length ? <StartChip ptyId={ptyId} tasks={talk.toStart} /> : null;
  // Only tasks to start: nothing else to say about this terminal.
  if (start && !talk.review && !talk.with.length && !talk.queued && !talk.reportsTo) return start;
  return (
    <>
      {start}
      <TalkStatus ptyId={ptyId} talk={talk} />
    </>
  );
}

/**
 * Tasks this CLI handed out that wait for you (Ask first, or past its limits): start one or all,
 * or discard them (Undo brings them back).
 */
function StartChip({ ptyId, tasks }: { ptyId: string; tasks: TalkState["toStart"] }) {
  const t = useT();
  const { push, fail } = useToast();
  const deleted = useDeleted();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const start = async (ids: string[] | null) => {
    try {
      const result = await call("talk.startTasks", ptyId, ids);
      if (result.failed.length) push("info", t("talk.startFailed"), result.failed.join("\n"));
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };
  const discard = async () => {
    try {
      for (const task of tasks) deleted(t("common.deletedNamed", { name: task.title }), await call("tasks.delete", task.taskId));
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };
  const only = tasks.length === 1 ? tasks[0] : null;
  // One task is named in the heading; several are listed, each to start on its own.
  const items: Array<MenuItem | "sep"> = [
    { label: t.count("talk.startAll", tasks.length), hint: only?.agent ? t("talk.startTo", { agent: only.agent }) : undefined, icon: Play, accent: true, onSelect: () => void start(null) },
    ...(only
      ? []
      : [
          "sep" as const,
          ...tasks.map((task): MenuItem => ({ label: task.title, hint: task.agent ? t("talk.startTo", { agent: task.agent }) : undefined, icon: Play, onSelect: () => void start([task.taskId]) })),
        ]),
    "sep",
    { label: t.count("talk.discardAll", tasks.length), icon: Trash2, danger: true, onSelect: () => void discard() },
  ];
  return (
    <>
      <button type="button" className={`chip accent pane-start${anchor ? " is-open" : ""}`} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)} {...tipProps(t("talk.toStartTip"))}>
        <ListChecks size={11} />
        <span className="truncate">{t.count("talk.toStart", tasks.length)}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="menu-head faint">{t("talk.toStartHead")}</div>
          {only && <div className="menu-head truncate" style={{ maxWidth: 360 }}>{only.title}</div>}
          <Menu items={items} onClose={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  );
}

function TalkStatus({ ptyId, talk }: { ptyId: string; talk: TalkState }) {
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
        : talk.reportsTo && !talk.queued
          ? t("talk.reportsTo", { name: talk.reportsTo })
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
