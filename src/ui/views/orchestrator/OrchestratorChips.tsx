import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  CircleAlert,
  Clock,
  CornerDownLeft,
  FileDiff,
  FolderPlus,
  GitMerge,
  History,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  Monitor,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Volume2,
} from "lucide-react";
import { useContext, useState } from "react";
import type { MaestroNote, OrchestratorCheck, OrchestratorStep, OrchestratorTurn } from "../../../shared/api.js";
import { isFreeWaitingPrompt } from "../../../shared/orchestrator.js";
import { call, useEngines, useLive, useOrchestrator, useWorkspaces } from "../../api.js";
import { VibySprite } from "../../components/Pixel.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Popover } from "../../components/ui.js";
import { coreText } from "../../core-text.js";
import { useT } from "../../i18n/index.js";
import { VIEWS } from "../../rail.js";
import { isRoute, useAction, useNav } from "../../state.js";
import { LeaveBar, sessionLabel, shortBranch } from "./shared.js";

export function TurnChips({ turn }: { turn: OrchestratorTurn }) {
  const checks = turn.checks ?? [];
  const steps = turn.plan === "waiting" || turn.plan === "cancelled" || turn.plan === "replaced" ? [] : (turn.steps ?? []).filter((step) => step.state === "done" || step.state === "failed");
  if (!checks.length && !steps.length) return null;
  return (
    <div className="viby-chips">
      {checks.map((check) => (
        <CheckChip key={check.id} check={check} />
      ))}
      {steps.map((step) => (
        <StepChip key={step.id} step={step} />
      ))}
    </div>
  );
}

function CheckChip({ check }: { check: OrchestratorCheck }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const verifyFailed = check.kind === "verify" && /^(?:Exit |Timed out)/.test(check.summary);
  const label = t(check.kind === "lookup" ? "orch.chip.lookedUp" : check.kind === "verify" ? "orch.chip.verified" : "orch.chip.checked", {
    target: check.label,
  });
  const canOpenPty = Boolean(check.ptyId && live.some((item) => item.ptyId === check.ptyId));
  const copy = check.copyId ? copies.find((item) => item.id === check.copyId) : undefined;
  const Icon = check.kind === "verify" ? (verifyFailed ? CircleAlert : ShieldCheck) : Search;

  return (
    <>
      <button type="button" className={`viby-chip${verifyFailed ? " failed" : ""}`} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        <Icon size={11} />
        <span className="truncate">{label}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} wide onClose={() => setAnchor(null)}>
          <div className="viby-detail-popover">
            <div className="viby-detail-head">
              <strong className="truncate grow">{check.summary || label}</strong>
              {canOpenPty && (
                <Button
                  size="sm"
                  icon={SquareTerminal}
                  onClick={() => {
                    setAnchor(null);
                    leaveBar?.();
                    go({ view: "code", workspaceId: check.workspaceId ?? undefined, ptyId: check.ptyId ?? undefined });
                  }}
                >
                  {t("orch.open")}
                </Button>
              )}
              {copy && (
                <Button
                  size="sm"
                  icon={FileDiff}
                  onClick={() => {
                    setAnchor(null);
                    leaveBar?.();
                    go({ view: "orchestrator", copyId: copy.id });
                  }}
                >
                  {t("orch.review")}
                </Button>
              )}
            </div>
            {check.details && <pre className="viby-detail-pre mono selectable">{check.details}</pre>}
          </div>
        </Popover>
      )}
    </>
  );
}

function StepChip({ step }: { step: OrchestratorStep }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const [undo] = useAction(async () => step.undo && call("undo.delete", step.undo), t("common.undoFailed"));
  const [replyAnchor, setReplyAnchor] = useState<HTMLElement | null>(null);

  const engine = engines.find((item) => item.id === step.engineId);
  const workspace = workspaces.find((item) => item.id === step.workspaceId);
  const targetSession = live.find((item) => item.ptyId === step.target);
  const openedSession = step.ptyId ? live.find((item) => item.ptyId === step.ptyId) : undefined;
  const copy = step.kind === "start" ? copies.find((item) => item.id === step.copyId || item.stepId === step.id) : undefined;
  const targetCopy = step.kind === "apply" || step.kind === "discard" ? copies.find((item) => item.id === step.target) : undefined;

  if (step.state === "failed") {
    const label = step.name || (step.branch ? shortBranch(step.branch) : "") || workspace?.name || step.asked || step.kind;
    return (
      <span className="viby-chip failed" {...tipProps(step.error ? coreText(step.error) : undefined)}>
        <CircleAlert size={11} />
        <span className="truncate">
          {label}
          {step.error ? ` · ${coreText(step.error)}` : ""}
        </span>
      </span>
    );
  }

  if (step.kind === "start") {
    const who = engine?.label ?? step.engineId;
    const where = step.branch ? shortBranch(step.branch) : workspace?.name ?? step.asked;
    return (
      <>
        <button
          type="button"
          className="viby-chip action"
          disabled={!openedSession && !step.openedWorkspaceId}
          onClick={() => {
            leaveBar?.();
            go({ view: "code", workspaceId: step.openedWorkspaceId ?? undefined, ptyId: openedSession ? (step.ptyId ?? undefined) : undefined });
          }}
        >
          <ArrowUpRight size={12} />
          <span className="truncate">{[who, where].filter(Boolean).join(" · ")}</span>
        </button>
        {copy && (
          <button
            type="button"
            className="viby-chip"
            onClick={() => {
              leaveBar?.();
              go({ view: "orchestrator", copyId: copy.id });
            }}
          >
            <FileDiff size={11} />
            <span>{t("orch.review")}</span>
          </button>
        )}
        {!copy && step.outcome && (
          <span className="viby-chip settled">
            <Check size={11} />
            <span>
              {step.outcome === "applied"
                ? t("orch.chip.applied", { target: shortBranch(step.branch) || workspace?.name || "" })
                : t("orch.chip.discarded", { target: shortBranch(step.branch) || workspace?.name || "" })}
            </span>
          </span>
        )}
      </>
    );
  }

  if (step.kind === "workspace") {
    if (step.action === "remove") {
      return (
        <span className="viby-chip settled">
          <Trash2 size={11} />
          <span className="truncate">{step.result ? coreText(step.result) : step.asked}</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        className="viby-chip action"
        disabled={!step.openedWorkspaceId}
        onClick={() => {
          if (!step.openedWorkspaceId) return;
          leaveBar?.();
          go({ view: "code", workspaceId: step.openedWorkspaceId });
        }}
      >
        <FolderPlus size={11} />
        <span className="truncate">{step.name || step.asked}</span>
      </button>
    );
  }

  if (step.kind === "tell" || step.kind === "key" || step.kind === "shell") {
    const ptyId = step.kind === "shell" ? step.ptyId : step.target;
    const session = ptyId ? live.find((item) => item.ptyId === ptyId) : undefined;
    const wsId = step.kind === "shell" ? step.openedWorkspaceId ?? step.workspaceId : session?.workspaceId;
    const label =
      step.kind === "tell"
        ? t("orch.chip.told", { target: sessionLabel(targetSession, workspaces) || step.asked })
        : step.kind === "key"
          ? step.result || sessionLabel(targetSession, workspaces) || step.asked
          : workspace?.name || step.asked || t("orch.shell");
    const Icon = step.kind === "tell" ? MessageSquare : step.kind === "key" ? CornerDownLeft : SquareTerminal;
    return (
      <button
        type="button"
        className="viby-chip action"
        disabled={!session && !wsId}
        onClick={() => {
          leaveBar?.();
          go({ view: "code", workspaceId: wsId ?? undefined, ptyId: session ? (ptyId ?? undefined) : undefined });
        }}
      >
        <Icon size={11} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "read") {
    const label = sessionLabel(targetSession, workspaces) || step.asked || t("orch.read");
    return (
      <>
        <button type="button" className="viby-chip" onClick={(event) => setReplyAnchor(replyAnchor ? null : event.currentTarget)}>
          <Volume2 size={11} />
          <span className="truncate">{label}</span>
        </button>
        {replyAnchor && (
          <Popover anchor={replyAnchor} wide onClose={() => setReplyAnchor(null)}>
            <div className="viby-detail-popover">
              <div className="viby-detail-head">
                <strong className="truncate grow">{label}</strong>
                {targetSession && (
                  <Button
                    size="sm"
                    icon={SquareTerminal}
                    onClick={() => {
                      setReplyAnchor(null);
                      leaveBar?.();
                      go({ view: "code", workspaceId: targetSession.workspaceId ?? undefined, ptyId: targetSession.ptyId });
                    }}
                  >
                    {t("orch.open")}
                  </Button>
                )}
              </div>
              {step.reply && <pre className="viby-detail-pre mono selectable">{step.reply}</pre>}
            </div>
          </Popover>
        )}
      </>
    );
  }

  if (step.kind === "show") {
    const shownView = step.view || "";
    const viewLabel = shownView ? t(VIEWS.find((item) => item.view === shownView)?.label ?? "rail.settings") : "";
    const label = step.route ? step.asked || viewLabel : sessionLabel(targetSession, workspaces) || viewLabel || workspace?.name || step.asked;
    return (
      <button
        type="button"
        className="viby-chip action"
        onClick={() => {
          leaveBar?.();
          if (targetSession) go({ view: "code", workspaceId: targetSession.workspaceId ?? undefined, ptyId: targetSession.ptyId });
          else if (step.route && isRoute(step.route)) go(step.route);
          else if (shownView) go({ view: shownView as Parameters<typeof go>[0]["view"] });
          else if (step.workspaceId) go({ view: "code", workspaceId: step.workspaceId });
        }}
      >
        <ArrowUpRight size={12} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "agent" || step.kind === "skill" || step.kind === "task" || step.kind === "routine" || step.kind === "chat") {
    // Discarding a task's copy is undone the same way as a delete.
    const isDelete = step.action === "delete" || (step.kind === "task" && step.action === "discard");
    if (isDelete) {
      return (
        <>
          <span className="viby-chip settled">
            <Trash2 size={11} />
            <span className="truncate">{step.result ? coreText(step.result) : step.asked}</span>
          </span>
          {step.undo && (
            <button type="button" className="viby-chip" onClick={() => void undo()}>
              <RotateCcw size={11} />
              <span>{t("common.undo")}</span>
            </button>
          )}
        </>
      );
    }
    const Icon =
      step.kind === "agent"
        ? Bot
        : step.kind === "skill"
          ? Sparkles
          : step.kind === "task"
            ? ListTodo
            : step.kind === "chat"
              ? MessagesSquare
              : Clock;
    const label = step.name || step.asked || step.prompt;
    return (
      <button
        type="button"
        className="viby-chip action"
        onClick={() => {
          leaveBar?.();
          if (step.kind === "agent") go({ view: "agents", ...(step.target ? { agentId: step.target } : {}) });
          else if (step.kind === "skill") go({ view: "skills", ...(step.target ? { skillId: step.target } : {}) });
          else if (step.kind === "task") go({ view: "tasks", ...(step.target ? { taskId: step.target } : {}) });
          else if (step.kind === "chat") {
            if (step.agentId) go({ view: "agents", agentId: step.agentId, tab: "chats", ...(step.target ? { chatId: step.target } : {}) });
            else go({ view: "chat", ...(step.target ? { chatId: step.target } : {}) });
          } else go({ view: "routines", ...(step.target ? { routineId: step.target } : {}) });
        }}
      >
        <Icon size={11} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "run") {
    const label = step.result ? coreText(step.result) : step.asked || t("orch.run");
    return (
      <button
        type="button"
        className="viby-chip action"
        onClick={() => {
          leaveBar?.();
          const runId = step.runId || (step.action !== "tidy" && step.action !== "mark-all-reviewed" ? step.target : "");
          go({ view: "runs", ...(runId ? { runId } : {}) });
        }}
      >
        <History size={11} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "apply") {
    const target = targetCopy?.name || step.asked;
    return (
      <span className="viby-chip settled" {...tipProps(step.result ? coreText(step.result) : undefined)}>
        <GitMerge size={11} />
        <span className="truncate">{t("orch.chip.applied", { target })}</span>
      </span>
    );
  }

  if (step.kind === "discard") {
    const target = targetCopy?.name || step.asked;
    const canUndo = Boolean(step.undo && !copies.some((item) => item.id === step.target));
    return (
      <>
        <span className="viby-chip settled">
          <Trash2 size={11} />
          <span className="truncate">{t("orch.chip.discarded", { target })}</span>
        </span>
        {canUndo && (
          <button type="button" className="viby-chip" onClick={() => void undo()}>
            <RotateCcw size={11} />
            <span>{t("common.undo")}</span>
          </button>
        )}
      </>
    );
  }

  if (step.kind === "verify") {
    const label = step.result ? coreText(step.result) : step.asked || step.prompt;
    return (
      <button
        type="button"
        className="viby-chip action"
        disabled={!step.workspaceId}
        onClick={() => {
          if (!step.workspaceId) return;
          leaveBar?.();
          go({ view: "code", workspaceId: step.workspaceId });
        }}
      >
        <ShieldCheck size={11} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "memory") {
    return (
      <>
        <span className="viby-chip settled">
          <BookOpen size={11} />
          <span className="truncate">{step.result ? coreText(step.result) : step.asked || t("orch.memoryTitle")}</span>
        </span>
        {step.undo && (
          <button type="button" className="viby-chip" onClick={() => void undo()}>
            <RotateCcw size={11} />
            <span>{t("common.undo")}</span>
          </button>
        )}
      </>
    );
  }

  if (step.kind === "computer") {
    return (
      <span className="viby-chip settled">
        <Monitor size={11} />
        <span className="truncate">{step.result ? coreText(step.result) : step.asked || t("orch.computer")}</span>
      </span>
    );
  }

  if (step.kind === "stop") {
    return (
      <span className="viby-chip settled">
        <Square size={10} />
        <span className="truncate">{t("orch.chip.stopped", { target: step.asked || t("orch.gone") })}</span>
      </span>
    );
  }

  return (
    <span className="viby-chip settled">
      <Check size={11} />
      <span className="truncate">{step.result ? coreText(step.result) : step.asked || step.prompt}</span>
    </span>
  );
}

/** Proactive CLI note turn rendered under Viby's avatar. */
export function NoteTurnView({ note }: { note: MaestroNote }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const [replyAnchor, setReplyAnchor] = useState<HTMLElement | null>(null);
  const [approved, setApproved] = useState(false);
  const [approveTrust, approving] = useAction(async () => {
    await call("pty.write", note.ptyId, "\r");
    setApproved(true);
  }, t("orch.failed"));
  const running = live.some((item) => item.ptyId === note.ptyId);
  const copy = note.copyId ? copies.find((item) => item.id === note.copyId) : undefined;
  const freeTrust = note.kind === "waiting" && running && !approved && isFreeWaitingPrompt(note.reply ?? undefined);

  return (
    <div className="orch-turn from-vibeforge orch-note">
      <span className="viby-avatar">
        <VibySprite mood="idle" size={22} animated={false} />
      </span>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        <span className="orch-said">
          {t(note.kind === "finished" ? "orch.note.finished" : note.kind === "waiting" ? "orch.note.waiting" : "orch.note.ended", {
            engine: note.engine,
            workspace: note.workspace,
          })}
          {note.changes && <span className="faint"> · {coreText(note.changes)}</span>}
        </span>
        {(running || copy || note.reply) && (
          <div className="viby-chips">
            {freeTrust && (
              <button type="button" className="viby-chip action" disabled={approving} onClick={() => void approveTrust()}>
                <Check size={11} />
                <span>{t("orch.approveTrust")}</span>
              </button>
            )}
            {running && (
              <button
                type="button"
                className="viby-chip action"
                onClick={() => {
                  leaveBar?.();
                  go({ view: "code", workspaceId: note.workspaceId ?? undefined, ptyId: note.ptyId });
                }}
              >
                <ArrowUpRight size={12} />
                <span>{t("orch.open")}</span>
              </button>
            )}
            {copy && (
              <button
                type="button"
                className="viby-chip"
                onClick={() => {
                  leaveBar?.();
                  go({ view: "orchestrator", copyId: copy.id });
                }}
              >
                <FileDiff size={11} />
                <span>{t("orch.review")}</span>
              </button>
            )}
            {note.reply && (
              <button type="button" className="viby-chip" onClick={(event) => setReplyAnchor(replyAnchor ? null : event.currentTarget)}>
                <MessageSquare size={11} />
                <span className="truncate" style={{ maxWidth: 240 }}>
                  {note.reply}
                </span>
              </button>
            )}
          </div>
        )}
        {replyAnchor && note.reply && (
          <Popover anchor={replyAnchor} wide onClose={() => setReplyAnchor(null)}>
            <div className="viby-detail-popover">
              <pre className="viby-detail-pre mono selectable">{note.reply}</pre>
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}
