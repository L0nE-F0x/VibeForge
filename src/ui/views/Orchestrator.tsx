import { Check, CircleAlert, ExternalLink, GitBranch, MessageSquare, Play, RotateCcw, Square, SquareTerminal, Workflow, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine, LiveSession, OrchestratorStep, OrchestratorTurn, OrchestratorView as View, StepIssue, Workspace } from "../../shared/api.js";
import { canOrchestrate, orchestratorVoiceWords, stepIssue, type PlanContext } from "../../shared/orchestrator.js";
import { call, useEngines, useLive, useQuery, useSettings, useWorkspaces } from "../api.js";
import { usePtyAttention } from "../attention.js";
import { coreText } from "../core-text.js";
import { Composer } from "../components/Session.js";
import { Button, Chip, Empty, Logo, Segmented, Select, Spinner } from "../components/ui.js";
import { tipProps } from "../components/Tooltip.js";
import { useT, type Key } from "../i18n/index.js";
import { useAction, useConfirm, useNav, useOverlay, useToast } from "../state.js";

// Talk to VibeForge itself: say or type what to start where, and the CLI chosen in Settings
// (Grok Build by default) turns it into a plan that VibeForge carries out. The full view has the
// conversation and the team; Ctrl+Shift+O opens the same conversation over any view.

export const OPEN_ORCHESTRATOR_EVENT = "vibeforge:open-orchestrator";
export const ORCHESTRATOR_KEYS = "Ctrl+Shift+O";
const DRAFT_KEY = "orchestrator";

/** Put the bar away: "Open in Code" on the bar opens the terminal, so the bar mustn't stay over it. */
const LeaveBar = createContext<(() => void) | null>(null);

export const useOrchestrator = () => useQuery("orchestrator", ["orchestrator", "settings", "engines"], () => call("orchestrator.get"));

/** A coding CLI: a run VibeForge started, or one typed into a shell. */
function isCodingCli(session: LiveSession): boolean {
  return session.kind === "run" || Boolean(session.programEngineId);
}

/** What a step is checked against, from what the window already knows. */
function usePlanContext(): PlanContext {
  const workspaces = useWorkspaces().data?.workspaces;
  const engines = useEngines().data;
  const live = useLive().data;
  return useMemo(
    () => ({
      workspaces: (workspaces ?? []).map((item) => ({ id: item.id, name: item.name, folder: item.path, git: true })),
      engines: (engines ?? []).map((item) => ({ id: item.id, label: item.label, available: item.available })),
      running: (live ?? []).filter(isCodingCli).map((item) => ({ id: item.ptyId, engine: item.program || item.title, workspace: item.workspaceId ?? "", folder: item.cwd, working: Boolean(item.working), orchestrated: Boolean(item.orchestrated) })),
    }),
    [workspaces, engines, live],
  );
}

const ISSUE_KEY: Record<StepIssue, Key> = {
  workspace: "orch.issue.workspace",
  engine: "orch.issue.engine",
  engineMissing: "orch.issue.engineMissing",
  target: "orch.issue.target",
  prompt: "orch.issue.prompt",
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
  const view = useOrchestrator().data;
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [saveMode] = useAction(async (mode: "plan" | "go") => settings && call("settings.save", { orchestrator: { ...settings.orchestrator, mode } }), t("settings.saveFailed"));
  const [saveEngine] = useAction(async (engine: string) => settings && call("settings.save", { orchestrator: { ...settings.orchestrator, engine, model: "" } }), t("settings.saveFailed"));
  const [clear] = useAction(async () => call("orchestrator.clear"), t("orch.failed"));
  const planners = engines.filter((engine) => canOrchestrate(engine));
  const engineId = settings?.orchestrator.engine ?? "grok";

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
              <option key={engine.id} value={engine.id}>
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
    </div>
  );
}

// ------------------------------------------------------------------ over any view

/** Ctrl+Shift+O: the same conversation, the last few turns, over whatever is open. */
export function OrchestratorBar({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { go } = useNav();
  const view = useOrchestrator().data;
  useOverlay(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="scrim switcher-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="switcher orch-bar" role="dialog" aria-modal aria-label={t("orch.title")}>
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
          <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} kbd="Esc" onClick={onClose} />
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
            <span className="grow">{t("orch.notReady", { engine: engineLabel })}</span>
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
  const context = usePlanContext();
  const [run, running] = useAction(async () => call("orchestrator.run", turn.id), t("orch.failed"));
  const [cancel] = useAction(async () => call("orchestrator.cancel", turn.id), t("orch.failed"));
  const steps = turn.steps ?? [];
  const waiting = turn.plan === "waiting";
  const blocked = waiting ? steps.filter((step) => stepIssue(step, context)).length : 0;
  const state = turn.plan ?? "done";
  return (
    <div className={`orch-plan state-${state}`}>
      <div className="orch-plan-head">
        <Chip tone={state === "waiting" ? "accent" : state === "running" ? "info" : undefined}>{t(PLAN_KEY[state])}</Chip>
        <span className="faint">{t.count("orch.steps", steps.length)}</span>
      </div>
      {steps.map((step) => (
        <StepRow key={step.id} turnId={turn.id} step={step} editable={waiting} compact={compact} issue={waiting ? stepIssue(step, context) : null} />
      ))}
      {waiting && (
        <div className="orch-plan-foot">
          {blocked > 0 && blocked < steps.length && <span className="faint grow">{t.count("orch.skipNote", blocked)}</span>}
          {blocked === steps.length && <span className="faint grow">{t("orch.fixFirst")}</span>}
          {blocked === 0 && <span className="grow" />}
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" icon={Play} busy={running} disabled={blocked === steps.length} onClick={() => void run()}>
            {t("orch.go")}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepRow({ turnId, step, editable, compact, issue }: { turnId: string; step: OrchestratorStep; editable: boolean; compact?: boolean; issue: StepIssue | null }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const [edit] = useAction(async (patch: Partial<OrchestratorStep>) => call("orchestrator.editStep", turnId, step.id, patch), t("orch.failed"));
  const [remove] = useAction(async () => call("orchestrator.removeStep", turnId, step.id), t("orch.failed"));
  const [prompt, setPrompt] = useState(step.prompt);
  const [branch, setBranch] = useState(step.branch);
  useEffect(() => setPrompt(step.prompt), [step.prompt]);
  useEffect(() => setBranch(step.branch), [step.branch]);
  const engine = engines.find((item) => item.id === step.engineId);
  const workspace = workspaces.find((item) => item.id === step.workspaceId);
  const target = live.find((item) => item.ptyId === step.target);
  const Icon = step.kind === "start" ? Play : step.kind === "tell" ? MessageSquare : Square;
  const opened = step.ptyId ? live.find((item) => item.ptyId === step.ptyId) : undefined;

  return (
    <div className={`orch-step step-${step.state}${issue ? " has-issue" : ""}`}>
      <span className="orch-step-icon">
        {step.state === "running" ? <Spinner /> : step.state === "done" ? <Check size={13} /> : step.state === "failed" ? <CircleAlert size={13} /> : <Icon size={13} />}
      </span>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        {step.kind === "start" ? (
          editable ? (
            <div className="orch-step-line">
              <EnginePick engines={engines} value={step.engineId} onChange={(engineId) => void edit({ engineId })} />
              <Select value={step.workspaceId} aria-label={t("orch.workspace")} onChange={(event) => void edit({ workspaceId: event.target.value })}>
                {!workspace && <option value="">{t("orch.pickWorkspace")}</option>}
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
              <label className="orch-branch" {...tipProps(t("orch.branchTip"))}>
                <GitBranch size={12} />
                <input
                  className="mono"
                  value={branch}
                  aria-label={t("orch.branch")}
                  placeholder={t("orch.noBranch")}
                  onChange={(event) => setBranch(event.target.value)}
                  onBlur={() => branch !== step.branch && void edit({ branch: branch.trim() })}
                />
              </label>
            </div>
          ) : (
            <div className="orch-step-line">
              <strong>{engine?.label ?? step.engineId}</strong>
              <span className="faint">·</span>
              <span>{workspace?.name ?? step.asked}</span>
              {step.branch && (
                <span className="orch-branch-text mono">
                  <GitBranch size={12} /> {step.branch}
                </span>
              )}
            </div>
          )
        ) : (
          <div className="orch-step-line">
            <strong>{step.kind === "tell" ? t("orch.tell") : t("orch.close")}</strong>
            <span className="truncate">{sessionLabel(target, workspaces) || step.asked || t("orch.gone")}</span>
          </div>
        )}
        {step.kind !== "stop" &&
          (editable && !compact ? (
            <PromptBox value={prompt} label={t("orch.prompt")} onChange={setPrompt} onDone={() => prompt !== step.prompt && void edit({ prompt })} />
          ) : (
            <span className={`orch-prompt-text${compact ? " clamp" : ""}`}>{step.prompt}</span>
          ))}
        {issue && <span className="orch-issue">{t(ISSUE_KEY[issue], { asked: step.asked || "?" })}</span>}
        {step.state === "failed" && step.error && <span className="orch-issue">{coreText(step.error)}</span>}
        {step.state === "skipped" && <span className="faint">{t("orch.skipped")}</span>}
      </div>
      {step.state === "done" && step.kind === "start" && step.ptyId && (
        <Button size="sm" icon={SquareTerminal} disabled={!opened} onClick={() => {
            leaveBar?.();
            go({ view: "code", workspaceId: step.openedWorkspaceId ?? undefined, ptyId: step.ptyId ?? undefined });
          }}
        >
          {t("orch.open")}
        </Button>
      )}
      {editable && <Button size="sm" variant="ghost" icon={X} tip={t("orch.removeStep")} onClick={() => void remove()} />}
    </div>
  );
}

/** A step's words, as tall as they are (up to a point), so the whole instruction reads before Go. */
function PromptBox({ value, label, onChange, onDone }: { value: string; label: string; onChange: (text: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(240, Math.max(44, node.scrollHeight + 2))}px`;
  }, [value]);
  return <textarea ref={ref} className="orch-prompt" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} onBlur={onDone} />;
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
  const [stop] = useAction(async (ptyId: string) => call("pty.kill", ptyId), t("orch.stopFailed"));
  const [stopAll, stoppingAll] = useAction(async () => {
    const ok = await confirm({ title: t.count("orch.stopAllTitle", own.length), body: t("orch.stopAllBody"), confirm: t("orch.stopAll"), danger: true });
    if (!ok) return;
    await Promise.all(own.map((session) => call("pty.kill", session.ptyId)));
  }, t("orch.stopFailed"));

  return (
    <div className="vstack" style={{ gap: 8, minHeight: 0 }}>
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
