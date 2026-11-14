import { Check, CircleAlert, Clock, Eye, FileDiff, FolderPlus, GitBranch, GitMerge, ListTodo, MessageSquare, Play, RotateCcw, Search, Square, SquareTerminal, Trash2, Workflow, X, ExternalLink } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine, LiveSession, MaestroNote, OrchestratorStep, OrchestratorTurn, OrchestratorView as View, StepIssue, StepPatch, Workspace } from "../../shared/api.js";
import { effortLevels, launchKind, takesModel, cleanModel } from "../../shared/launch-options.js";
import { canOrchestrate, KNOWN_MODELS, orchestratorVoiceWords, plannedId, stepIssue, withPlannedWorkspaces, type PlanContext } from "../../shared/orchestrator.js";
import { call, useEngines, useLive, useQuery, useSettings, useWorkspaces } from "../api.js";
import { usePtyAttention } from "../attention.js";
import { coreText } from "../core-text.js";
import { Composer } from "../components/Session.js";
import { Button, Chip, Empty, Logo, Segmented, Select, Spinner, useOverlayStack } from "../components/ui.js";
import { tipProps } from "../components/Tooltip.js";
import { CopyActions, CopyList, CopySheet } from "./OrchestratorCopies.js";
import { useT, type Key } from "../i18n/index.js";
import { useAction, useConfirm, useNav, useOverlay, useToast } from "../state.js";
import { shortcutKeys } from "../shortcuts.js";

// Maestro: say or type what to start where, and the planner (the CLI picked in Settings, or the
// first one here that can plan) turns it into a plan that VibeForge carries out. The full view has the
// conversation and the team; Ctrl+Shift+O opens the same conversation over any view.

export const OPEN_ORCHESTRATOR_EVENT = "vibeforge:open-orchestrator";
const DRAFT_KEY = "orchestrator";

/** Put the bar away: "Open in Code" on the bar opens the terminal, so the bar mustn't stay over it. */
const LeaveBar = createContext<(() => void) | null>(null);

export const useOrchestrator = () => useQuery("orchestrator", ["orchestrator", "settings", "engines", "workspaces"], () => call("orchestrator.get"));

/** A coding CLI: a run VibeForge started, or one typed into a shell. */
function isCodingCli(session: LiveSession): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

/** What a step is checked against, from what the window already knows. */
function usePlanContext(): { context: PlanContext; ready: boolean } {
  const workspaces = useWorkspaces().data?.workspaces;
  const engines = useEngines().data;
  const live = useLive().data;
  const copies = useOrchestrator().data?.copies;
  const ready = workspaces !== undefined && engines !== undefined && live !== undefined;
  const context = useMemo(() => {
    const names = new Map((workspaces ?? []).map((item) => [item.id, item.name]));
    return {
      workspaces: (workspaces ?? []).map((item) => ({ id: item.id, name: item.name, folder: item.path, git: true })),
      engines: (engines ?? []).map((item) => ({ id: item.id, label: item.label, available: item.available, bin: item.bin })),
      running: (live ?? []).filter(isCodingCli).map((item) => ({ id: item.ptyId, engine: item.program || item.title, workspace: (item.workspaceId && names.get(item.workspaceId)) || item.title, folder: item.cwd, working: Boolean(item.working), orchestrated: Boolean(item.orchestrated) })),
      copies: (copies ?? []).map((item) => ({ id: item.id, name: item.name, branch: item.branch, workspace: (item.workspaceId && names.get(item.workspaceId)) || item.workspaceId })),
    };
  }, [workspaces, engines, live, copies]);
  return { context, ready };
}

const ISSUE_KEY: Record<StepIssue, Key> = {
  workspace: "orch.issue.workspace",
  engine: "orch.issue.engine",
  engineMissing: "orch.issue.engineMissing",
  target: "orch.issue.target",
  prompt: "orch.issue.prompt",
  effort: "orch.issue.effort",
  folder: "orch.issue.folder",
  copy: "orch.issue.copy",
};

/** A live CLI as a person knows it: "Claude Code · VibeForge · fix-tray". */
function sessionLabel(session: LiveSession | undefined, workspaces: Workspace[]): string {
  if (!session) return "";
  const name = session.program || session.title.split(" · ")[0] || session.title;
  const where = workspaces.find((item) => item.id === session.workspaceId)?.name;
  return where ? `${name} · ${where}` : session.title;
}

// ------------------------------------------------------------------ the full view

export function OrchestratorView() {
  const t = useT();
  const { route } = useNav();
  const view = useOrchestrator().data;
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [saveMode] = useAction(async (mode: "plan" | "go") => settings && call("settings.save", { orchestrator: { ...settings.orchestrator, mode } }), t("settings.saveFailed"));
  const [saveEngine] = useAction(async (engine: string) => settings && call("settings.save", { orchestrator: { ...settings.orchestrator, engine, model: "" } }), t("settings.saveFailed"));
  const [clear] = useAction(async () => call("orchestrator.clear"), t("orch.failed"));
  const planners = engines.filter((engine) => canOrchestrate(engine));
  // The planner in use: the one picked, or until then the first one on this machine.
  const engineId = view?.engineId ?? settings?.orchestrator.engine ?? "";

  return (
    <div className="view">
      <div className="main">
        <div className="page-head">
          <Workflow size={17} className="accent-text" />
          <h1 className="truncate">{t("orch.title")}</h1>
          <span className="sub truncate">{t("orch.sub", { engine: engines.find((engine) => engine.id === engineId)?.label ?? engineId })}</span>
          <span className="grow" />
          <Select value={engineId} aria-label={t("orch.planner")} style={{ width: 150 }} onChange={(event) => void saveEngine(event.target.value)} {...tipProps(t("orch.plannerTip"))}>
            {!planners.some((engine) => engine.id === engineId) && <option value={engineId}>{engineId}</option>}
            {planners.map((engine) => (
              <option key={engine.id} value={engine.id} disabled={!engine.available && engine.id !== engineId}>
                {engine.label}
                {engine.available ? "" : ` ${t("common.notOnPath")}`}
              </option>
            ))}
          </Select>
          <Segmented
            value={settings?.orchestrator.mode ?? "plan"}
            options={[
              { value: "plan", label: t("orch.mode.plan") },
              { value: "go", label: t("orch.mode.go") },
            ]}
            onChange={(mode) => void saveMode(mode)}
          />
          <Button size="sm" variant="ghost" icon={RotateCcw} tip={t("orch.newTip")} disabled={!view?.turns.length} onClick={() => void clear()}>
            {t("orch.new")}
          </Button>
        </div>
        <div className="orch-body">
          <section className="orch-talk">
            <Conversation view={view} />
          </section>
          <aside className="orch-team">
            <TeamPanel />
          </aside>
        </div>
      </div>
      {route.view === "orchestrator" && route.copyId && <CopySheet copyId={route.copyId} copies={view?.copies} />}
    </div>
  );
}

// ------------------------------------------------------------------ over any view

/** Ctrl+Shift+O: the same conversation, the last few turns, over whatever is open. */
export function OrchestratorBar({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { go } = useNav();
  const view = useOrchestrator().data;
  const box = useRef<HTMLDivElement>(null);
  useOverlay(true);
  // Esc closes it, and focus goes back to what had it (the terminal you were typing in).
  useOverlayStack(box, onClose);
  return createPortal(
    <div className="scrim switcher-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={box} className="switcher orch-bar" role="dialog" aria-modal aria-label={t("orch.title")} tabIndex={-1}>
        <div className="orch-bar-head">
          <Workflow size={15} className="accent-text" />
          <strong>{t("orch.title")}</strong>
          <span className="grow" />
          <Button
            size="sm"
            variant="ghost"
            icon={ExternalLink}
            onClick={() => {
              onClose();
              go({ view: "orchestrator" });
            }}
          >
            {t("orch.openView")}
          </Button>
          <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} kbd={shortcutKeys("overlay.close")} onClick={onClose} />
        </div>
        <LeaveBar.Provider value={onClose}>
          <Conversation view={view} compact onEscape={onClose} />
        </LeaveBar.Provider>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ the conversation

function Conversation({ view, compact, onEscape }: { view: View | undefined; compact?: boolean; onEscape?: () => void }) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const turns = view?.turns ?? [];
  const shown = compact ? turns.slice(-4) : turns;
  const engineLabel = engines.find((engine) => engine.id === view?.engineId)?.label ?? view?.engineId ?? "";
  const [stop] = useAction(async () => call("orchestrator.stopThinking"), t("orch.failed"));

  // Follow the conversation as it grows.
  const last = turns.at(-1);
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, last?.plan, view?.thinking]);

  return (
    <>
      <div className={`orch-turns${compact ? " compact" : ""}`} ref={scroller}>
        {view && turns.length === 0 && !view.thinking && (
          <div className="orch-start">
            {compact ? (
              <p className="muted">{t("orch.empty.body", { engine: engineLabel })}</p>
            ) : (
              <Empty icon={Workflow} title={t("orch.empty.title")}>
                {t("orch.empty.body", { engine: engineLabel })}
              </Empty>
            )}
          </div>
        )}
        {view && !view.engineReady && (
          <div className="orch-problem">
            <CircleAlert size={14} />
            <span className="grow">{t("orch.notReady")}</span>
            <Button size="sm" onClick={() => go({ view: "settings", section: "orchestrator" })}>
              {t("orch.openSettings")}
            </Button>
          </div>
        )}
        {shown.map((turn) => (
          <TurnView key={turn.id} turn={turn} engineLabel={engineLabel} compact={compact} />
        ))}
        {view?.thinking && (
          <div className="orch-turn from-vibeforge">
            <span className="orch-who">
              <Logo size={16} />
            </span>
            <span className="hstack muted">
              <Spinner /> {t("orch.thinking", { engine: engineLabel })}
            </span>
            <Button size="sm" variant="ghost" icon={Square} onClick={() => void stop()}>
              {t("orch.stop")}
            </Button>
          </div>
        )}
      </div>
      <Composer
        placeholder={t("orch.placeholder")}
        busy={view?.thinking}
        disabled={!view}
        autoFocus
        quiet
        sendLabel={t("common.send")}
        voiceLabel={t("orch.title")}
        voiceWords={() => orchestratorVoiceWords(workspaces.map((item) => item.name))}
        draftKey={DRAFT_KEY}
        keepKey="orchestrator"
        onEscape={onEscape}
        onSend={async (text) => {
          // The answer comes back as a turn; the box is free again at once.
          void call("orchestrator.ask", text).catch((error: unknown) => fail(error, t("orch.failed")));
          return true;
        }}
      />
    </>
  );
}

const PROBLEM_KEY: Record<NonNullable<OrchestratorTurn["problem"]>, Key> = {
  noEngine: "orch.problem.noEngine",
  failed: "orch.problem.failed",
  unreadable: "orch.problem.unreadable",
  timeout: "orch.problem.timeout",
  stopped: "orch.problem.stopped",
  signIn: "orch.problem.signIn",
};

function TurnView({ turn, engineLabel: current, compact }: { turn: OrchestratorTurn; engineLabel: string; compact?: boolean }) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const engineLabel = (turn.by && (engines.find((engine) => engine.id === turn.by)?.label ?? turn.by)) || current;
  if (turn.from === "you") {
    return (
      <div className="orch-turn from-you">
        <span className="orch-said">{turn.text}</span>
      </div>
    );
  }
  if (turn.note) return <NoteView note={turn.note} />;
  return (
    <div className="orch-turn from-vibeforge">
      <span className="orch-who">
        <Logo size={16} />
      </span>
      <div className="vstack grow" style={{ gap: 8, minWidth: 0 }}>
        {turn.problem ? (
          <span className="orch-problem-text">
            <CircleAlert size={13} /> {t(PROBLEM_KEY[turn.problem], { engine: engineLabel })}
            {turn.detail && <span className="orch-detail mono">{turn.detail}</span>}
          </span>
        ) : (
          turn.text && <span className="orch-said">{turn.text}</span>
        )}
        {turn.steps && <PlanCard turn={turn} compact={compact} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the plan card

const PLAN_KEY: Record<NonNullable<OrchestratorTurn["plan"]>, Key> = {
  waiting: "orch.plan.waiting",
  running: "orch.plan.running",
  done: "orch.plan.done",
  cancelled: "orch.plan.cancelled",
  replaced: "orch.plan.replaced",
};

function PlanCard({ turn, compact }: { turn: OrchestratorTurn; compact?: boolean }) {
  const t = useT();
  const steps = turn.steps ?? [];
  const { context: here, ready } = usePlanContext();
  // The plan's own new workspaces count as there for the steps after them.
  const context = useMemo(() => withPlannedWorkspaces(here, steps), [here, steps]);
  const [run, running] = useAction(async () => call("orchestrator.run", turn.id), t("orch.failed"));
  const [cancel] = useAction(async () => call("orchestrator.cancel", turn.id), t("orch.failed"));
  const waiting = turn.plan === "waiting";
  const blocked = waiting && ready ? steps.filter((step) => stepIssue(step, context)).length : 0;
  const state = turn.plan ?? "done";
  return (
    <div className={`orch-plan state-${state}`}>
      <div className="orch-plan-head">
        <Chip tone={state === "waiting" ? "accent" : state === "running" ? "info" : undefined}>{t(PLAN_KEY[state])}</Chip>
        <span className="faint">{t.count("orch.steps", steps.length)}</span>
      </div>
      {steps.map((step) => (
        <StepRow key={step.id} turnId={turn.id} step={step} plan={steps} editable={waiting} compact={compact} issue={waiting && ready ? stepIssue(step, context) : null} />
      ))}
      {waiting && (
        <div className="orch-plan-foot">
          {blocked > 0 && blocked < steps.length && <span className="faint grow">{t.count("orch.skipNote", blocked)}</span>}
          {blocked === steps.length && <span className="faint grow">{t("orch.fixFirst")}</span>}
          {blocked === 0 && <span className="grow" />}
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" icon={Play} busy={running} disabled={!ready || blocked === steps.length} onClick={() => void run()}>
            {t("orch.go")}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepRow({ turnId, step, plan, editable, compact, issue }: { turnId: string; step: OrchestratorStep; plan: OrchestratorStep[]; editable: boolean; compact?: boolean; issue: StepIssue | null }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const [edit] = useAction(async (patch: StepPatch) => call("orchestrator.editStep", turnId, step.id, patch), t("orch.failed"));
  const [remove] = useAction(async () => call("orchestrator.removeStep", turnId, step.id), t("orch.failed"));
  const [undo] = useAction(async () => step.undo && call("undo.delete", step.undo), t("common.undoFailed"));
  const engine = engines.find((item) => item.id === step.engineId);
  // The plan's own new workspaces, while their steps can still run, for a start step to pick.
  const planned = plan.filter((item) => item.kind === "workspace" && item.state !== "failed" && item.state !== "skipped");
  const workspace = workspaces.find((item) => item.id === step.workspaceId);
  const plannedWorkspace = planned.find((item) => plannedId(item.id) === step.workspaceId);
  const workspaceName = workspace?.name ?? (plannedWorkspace ? t("orch.planned", { name: plannedWorkspace.name ?? "" }) : step.asked);
  const target = live.find((item) => item.ptyId === step.target);
  const Icon = STEP_ICON[step.kind];
  const opened = step.ptyId ? live.find((item) => item.ptyId === step.ptyId) : undefined;
  const view = useOrchestrator().data;
  const copies = view?.copies ?? [];
  const copy = step.kind === "start" && !editable ? copies.find((item) => item.id === step.copyId || item.stepId === step.id) : undefined;
  const targetCopy = step.kind === "apply" || step.kind === "discard" ? copies.find((item) => item.id === step.target) : undefined;

  let line: ReactNode;
  if (step.kind === "workspace") {
    line = editable ? (
      <div className="orch-step-line">
        <strong>{t("orch.makeWorkspace")}</strong>
        <TextField value={step.name ?? ""} label={t("orch.workspaceName")} width={150} onDone={(name) => void edit({ name })} />
        <TextField value={step.folder ?? ""} label={t("orch.folder")} tip={t("orch.folderTip")} mono width={260} onDone={(folder) => void edit({ folder })} />
        <label className="orch-check" {...tipProps(t("orch.gitInitTip"))}>
          <input type="checkbox" checked={Boolean(step.git)} onChange={(event) => void edit({ git: event.target.checked })} />
          {t("orch.gitInit")}
        </label>
      </div>
    ) : (
      <div className="orch-step-line">
        <strong>{t("orch.makeWorkspace")}</strong>
        <span>{step.name}</span>
        <span className="faint mono truncate">{step.folder}</span>
        {step.git && <Chip>{t("orch.gitInit")}</Chip>}
      </div>
    );
  } else if (step.kind === "start") {
    line = editable ? (
      <div className="orch-step-line">
        <EnginePick engines={engines} value={step.engineId} onChange={(engineId) => void edit({ engineId })} />
        <Select value={step.workspaceId} aria-label={t("orch.workspace")} onChange={(event) => void edit({ workspaceId: event.target.value })}>
          {!workspace && !plannedWorkspace && <option value="">{t("orch.pickWorkspace")}</option>}
          {planned.map((item) => (
            <option key={item.id} value={plannedId(item.id)}>
              {t("orch.planned", { name: item.name ?? "" })}
            </option>
          ))}
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <BranchField value={step.branch} onDone={(branch) => void edit({ branch })} />
        <ModelField engine={engine} value={step.model ?? ""} onDone={(model) => void edit({ model })} />
        <EffortPick engine={engine} value={step.effort ?? ""} onChange={(effort) => void edit({ effort })} />
      </div>
    ) : (
      <div className="orch-step-line">
        <strong>{engine?.label ?? step.engineId}</strong>
        <span className="faint">·</span>
        <span>{workspaceName}</span>
        {step.branch ? (
          <span className="orch-branch-text mono">
            <GitBranch size={12} /> {step.branch}
          </span>
        ) : (
          <span className="faint">{t("orch.inPlace")}</span>
        )}
        {step.model && <Chip>{step.model}</Chip>}
        {step.effort && <Chip>{t("orch.effortIs", { effort: step.effort })}</Chip>}
      </div>
    );
  } else if (step.kind === "apply" || step.kind === "discard") {
    line = (
      <div className="orch-step-line">
        <strong>{step.kind === "apply" ? t("orch.applyStep") : t("orch.discard")}</strong>
        <span className="truncate">{targetCopy ? `${targetCopy.name} · ${workspaces.find((item) => item.id === targetCopy.workspaceId)?.name ?? ""}` : step.asked || t("orch.copyGone")}</span>
      </div>
    );
  } else if (step.kind === "lookup" || step.kind === "task" || step.kind === "routine") {
    line = (
      <div className="orch-step-line">
        <strong>{step.kind === "lookup" ? t("orch.show") : step.kind === "task" ? t("tasks.new") : t("routines.new")}</strong>
        <span className="truncate">{step.asked || step.name || step.target || step.prompt}</span>
      </div>
    );
  } else {
    line = (
      <div className="orch-step-line">
        <strong>{step.kind === "tell" ? t("orch.tell") : step.kind === "show" ? t("orch.show") : t("orch.close")}</strong>
        <span className="truncate">{sessionLabel(target, workspaces) || step.asked || t("orch.gone")}</span>
      </div>
    );
  }

  return (
    <div className={`orch-step step-${step.state}${issue ? " has-issue" : ""}`}>
      <span className="orch-step-icon">
        {step.state === "running" ? <Spinner /> : step.state === "done" ? <Check size={13} /> : step.state === "failed" ? <CircleAlert size={13} /> : <Icon size={13} />}
      </span>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        {line}
        {(step.kind === "start" || step.kind === "tell") &&
          (editable ? (
            <PromptBox value={step.prompt} label={t("orch.prompt")} placeholder={step.kind === "start" ? t("orch.promptEmpty") : undefined} onDone={(prompt) => prompt !== step.prompt && void edit({ prompt })} />
          ) : (
            step.prompt && <span className={`orch-prompt-text${compact ? " clamp" : ""}`}>{step.prompt}</span>
          ))}
        {step.kind === "start" && editable && step.branch && step.dirty ? (
          <span className="orch-warn">{t.count("orch.dirty", step.dirty, { workspace: workspace?.name ?? "" })}</span>
        ) : null}
        {issue && <span className="orch-issue">{t(ISSUE_KEY[issue], { asked: step.asked || "?" })}</span>}
        {step.state === "failed" && step.error && <span className="orch-issue">{coreText(step.error)}</span>}
        {step.state === "skipped" && <span className="faint">{t("orch.skipped")}</span>}
        {step.result && <span className="orch-warn">{coreText(step.result)}</span>}
        {copy && <CopyActions copy={copy} onLeave={leaveBar} />}
        {!copy && step.outcome && (
          <span className="faint">{step.outcome === "applied" ? t("orch.outcome.applied", { workspace: workspace?.name ?? "" }) : t("orch.outcome.discarded")}</span>
        )}
      </div>
      {step.state === "done" && step.kind === "start" && step.ptyId && (
        <Button
          size="sm"
          icon={SquareTerminal}
          disabled={!opened}
          onClick={() => {
            leaveBar?.();
            go({ view: "code", workspaceId: step.openedWorkspaceId ?? undefined, ptyId: step.ptyId ?? undefined });
          }}
        >
          {t("orch.open")}
        </Button>
      )}
      {step.state === "done" && step.kind === "workspace" && step.openedWorkspaceId && (
        <Button
          size="sm"
          icon={SquareTerminal}
          onClick={() => {
            leaveBar?.();
            go({ view: "code", workspaceId: step.openedWorkspaceId ?? undefined });
          }}
        >
          {t("orch.open")}
        </Button>
      )}
      {step.state === "done" && step.kind === "discard" && step.undo && !copies.some((item) => item.id === step.target) && (
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void undo()}>
          {t("common.undo")}
        </Button>
      )}
      {editable && <Button size="sm" variant="ghost" icon={X} tip={t("orch.removeStep")} onClick={() => void remove()} />}
    </div>
  );
}

const STEP_ICON: Record<OrchestratorStep["kind"], typeof Play> = {
  start: Play,
  tell: MessageSquare,
  stop: Square,
  workspace: FolderPlus,
  apply: GitMerge,
  discard: Trash2,
  show: Eye,
  lookup: Search,
  task: ListTodo,
  routine: Clock,
};

/** VibeForge's own word about a CLI Maestro started: its turn ended after real work, or it closed. */
function NoteView({ note }: { note: MaestroNote }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const running = live.some((item) => item.ptyId === note.ptyId);
  const copy = note.copyId ? copies.find((item) => item.id === note.copyId) : undefined;
  return (
    <div className="orch-turn from-vibeforge orch-note">
      <span className="orch-who">
        <Logo size={16} />
      </span>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        <span className="orch-said">
          {t(note.kind === "finished" ? "orch.note.finished" : "orch.note.ended", { engine: note.engine, workspace: note.workspace })}
          {note.changes && <span className="faint"> · {coreText(note.changes)}</span>}
        </span>
        <div className="orch-copy">
          {running && (
            <Button
              size="sm"
              icon={SquareTerminal}
              onClick={() => {
                leaveBar?.();
                go({ view: "code", workspaceId: note.workspaceId ?? undefined, ptyId: note.ptyId });
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
                leaveBar?.();
                go({ view: "orchestrator", copyId: copy.id });
              }}
            >
              {t("orch.review")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A one-line field that tells the plan once it is left (or Enter), or shortly after typing stops. */
function TextField({ value, label, tip, mono, width, onDone }: { value: string; label: string; tip?: string; mono?: boolean; width?: number; onDone: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    const timer = setTimeout(() => onDone(trimmed), 250);
    return () => clearTimeout(timer);
  }, [text, value, onDone]);
  return (
    <input
      className={`orch-field${mono ? " mono" : ""}`}
      style={width ? { width } : undefined}
      value={text}
      aria-label={label}
      placeholder={label}
      {...(tip ? tipProps(tip) : {})}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      onBlur={() => text.trim() !== value && onDone(text.trim())}
    />
  );
}

/** The new branch, in a copy of the workspace of its own; empty works in the workspace itself. */
function BranchField({ value, onDone }: { value: string; onDone: (branch: string) => void }) {
  const t = useT();
  const [branch, setBranch] = useState(value);
  useEffect(() => setBranch(value), [value]);
  return (
    <label className="orch-branch" {...tipProps(t("orch.branchTip"))}>
      <GitBranch size={12} />
      <input
        className="mono"
        value={branch}
        aria-label={t("orch.branch")}
        placeholder={t("orch.noBranch")}
        onChange={(event) => setBranch(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        onBlur={() => branch.trim() !== value && onDone(branch.trim())}
      />
    </label>
  );
}

/** The model a start step's CLI starts on: its own default, or a name it knows. */
function ModelField({ engine, value, onDone }: { engine: Engine | undefined; value: string; onDone: (model: string) => void }) {
  const t = useT();
  const [model, setModel] = useState(value);
  useEffect(() => setModel(value), [value]);
  const usable = Boolean(engine && takesModel(engine));
  // Claude Code's aliases are known without asking it; other CLIs take a name typed in.
  const known = engine && launchKind(engine) === "claude" ? KNOWN_MODELS.claude : undefined;
  const list = `orch-models-${engine?.id ?? "none"}`;
  return (
    <label className="orch-branch" {...tipProps(usable ? t("orch.stepModelTip") : t("orch.noModel"))}>
      <input
        className="mono"
        style={{ width: 120 }}
        value={model}
        disabled={!usable}
        list={known ? list : undefined}
        aria-label={t("orch.model")}
        placeholder={usable ? t("orch.modelDefault") : t("orch.noModel")}
        onChange={(event) => setModel(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        onBlur={() => {
          const cleaned = cleanModel(model);
          setModel(cleaned);
          if (cleaned !== value) onDone(cleaned);
        }}
      />
      {known && (
        <datalist id={list}>
          {known.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </label>
  );
}

/** The reasoning effort a start step's CLI starts with: only the levels that CLI takes. */
function EffortPick({ engine, value, onChange }: { engine: Engine | undefined; value: string; onChange: (effort: string) => void }) {
  const t = useT();
  const levels = engine ? effortLevels(engine) : [];
  if (!levels.length && !value) {
    return (
      <Select value="" disabled aria-label={t("orch.effort")} {...tipProps(t("orch.noEffortTip"))}>
        <option value="">{t("orch.noEffort")}</option>
      </Select>
    );
  }
  return (
    <Select value={value} aria-label={t("orch.effort")} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t("orch.effortDefault")}</option>
      {value && !levels.includes(value) && <option value={value}>{value}</option>}
      {levels.map((level) => (
        <option key={level} value={level}>
          {t("orch.effortIs", { effort: level })}
        </option>
      ))}
    </Select>
  );
}

/** A step's words, as tall as they are (up to a point), so the whole instruction reads before Go. */
function PromptBox({ value, label, placeholder, onDone }: { value: string; label: string; placeholder?: string; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onDone(text), 250);
    return () => clearTimeout(timer);
  }, [text, value, onDone]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(240, Math.max(44, node.scrollHeight + 2))}px`;
  }, [text]);
  return <textarea ref={ref} className="orch-prompt" value={text} aria-label={label} placeholder={placeholder} onChange={(event) => setText(event.target.value)} onBlur={() => onDone(text)} />;
}

function EnginePick({ engines, value, onChange }: { engines: Engine[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <Select value={value} aria-label={t("orch.engine")} onChange={(event) => onChange(event.target.value)}>
      {!engines.some((engine) => engine.id === value) && <option value="">{t("orch.pickEngine")}</option>}
      {engines.map((engine) => (
        <option key={engine.id} value={engine.id} disabled={!engine.available && engine.id !== value}>
          {engine.label}
          {engine.available ? "" : ` ${t("common.notOnPath")}`}
        </option>
      ))}
    </Select>
  );
}

// ------------------------------------------------------------------ the team

/** Every coding CLI running, the Orchestrator's first, with Open and Stop, and Stop all for its own. */
function TeamPanel() {
  const t = useT();
  const { go } = useNav();
  const confirm = useConfirm();
  const live = useLive().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const attention = usePtyAttention();
  const clis = live.filter(isCodingCli).sort((a, b) => Number(Boolean(b.orchestrated)) - Number(Boolean(a.orchestrated)) || a.startedAt.localeCompare(b.startedAt));
  const own = clis.filter((session) => session.orchestrated);
  const copies = useOrchestrator().data?.copies ?? [];
  const [stop] = useAction(async (ptyId: string) => call("pty.kill", ptyId), t("orch.stopFailed"));
  const [stopAll, stoppingAll] = useAction(async () => {
    const ok = await confirm({ title: t.count("orch.stopAllTitle", own.length), body: t("orch.stopAllBody"), confirm: t("orch.stopAll"), danger: true });
    if (!ok) return;
    await Promise.all(own.map((session) => call("pty.kill", session.ptyId)));
  }, t("orch.stopFailed"));

  return (
    <div className="vstack" style={{ gap: 8, minHeight: 0, flex: 1 }}>
      <CopyList copies={copies} workspaces={workspaces} />
      <div className="orch-team-head">
        <span className="section-title" style={{ margin: 0 }}>
          {t("orch.team")}
        </span>
        <span className="grow" />
        {own.length > 0 && (
          <Button size="sm" variant="danger" icon={Square} busy={stoppingAll} onClick={() => void stopAll()}>
            {t("orch.stopAll")}
          </Button>
        )}
      </div>
      {clis.length === 0 && <p className="faint orch-team-empty">{t("orch.teamEmpty")}</p>}
      <div className="list-scroll" style={{ padding: 0 }}>
        {clis.map((session) => {
          const workspace = workspaces.find((item) => item.id === session.workspaceId);
          const waiting = attention.get(session.ptyId)?.attention === "waiting";
          return (
            <div key={session.ptyId} className={`row orch-member${waiting ? " needs-you" : ""}`}>
              <span className={`dot ${session.working ? "running" : waiting ? "stopped" : ""}`} {...tipProps(session.working ? t("orch.working") : waiting ? t("orch.needsYou") : t("orch.quiet"))} />
              <span className="vstack grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="row-title truncate hstack" style={{ gap: 5 }}>
                  {session.orchestrated && (
                    <span className="accent-text" style={{ display: "inline-flex", flex: "none" }} {...tipProps(t("orch.mine"))}>
                      <Workflow size={12} />
                    </span>
                  )}
                  <span className="truncate">{session.program || session.title.split(" · ")[0]}</span>
                </span>
                <span className="row-sub truncate">{workspace?.name ?? session.title}</span>
              </span>
              <span className="row-actions">
                <Button size="sm" variant="ghost" icon={SquareTerminal} tip={t("orch.open")} onClick={() => go({ view: "code", workspaceId: session.workspaceId ?? undefined, ptyId: session.ptyId })} />
                <Button size="sm" variant="ghost" icon={Square} tip={t("orch.stopOne")} onClick={() => void stop(session.ptyId)} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
