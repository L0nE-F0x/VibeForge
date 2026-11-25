import { GitBranch, Pencil, Play, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, OrchestratorStep, OrchestratorTurn, StepIssue, StepPatch } from "../../../shared/api.js";
import { cleanModel, effortLevels, launchKind, takesModel } from "../../../shared/launch-options.js";
import { KNOWN_MODELS, plannedId, stepIssue, withPlannedWorkspaces } from "../../../shared/orchestrator.js";
import { call, useEngines, useLive, useOrchestrator, useWorkspaces } from "../../api.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Chip, Select } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { useAction } from "../../state.js";
import { issueKey, otherStepKey, sessionLabel, shortBranch, usePlanContext } from "./shared.js";

export function WaitingConfirm({ turn, callOn }: { turn: OrchestratorTurn; callOn: boolean }) {
  const t = useT();
  const steps = turn.steps ?? [];
  const { context: here, ready } = usePlanContext();
  const context = useMemo(() => withPlannedWorkspaces(here, steps), [here, steps]);
  const [run, running] = useAction(async () => call("orchestrator.run", turn.id), t("orch.failed"));
  const [cancel] = useAction(async () => call("orchestrator.cancel", turn.id), t("orch.failed"));
  const blocked = ready ? steps.filter((step) => stepIssue(step, context)).length : 0;
  const [editing, setEditing] = useState(false);
  const showEditor = editing || blocked > 0;

  return (
    <div className="viby-confirm">
      {!showEditor ? (
        <div className="viby-confirm-summary">
          {steps.map((step) => (
            <PendingStepSummary key={step.id} step={step} />
          ))}
        </div>
      ) : (
        <div className="viby-confirm-editor">
          {steps.map((step) => (
            <EditableStepRow key={step.id} turnId={turn.id} step={step} plan={steps} issue={ready ? stepIssue(step, context) : null} />
          ))}
        </div>
      )}
      <div className="viby-confirm-foot">
        {blocked > 0 && blocked < steps.length && <span className="faint grow">{t.count("orch.skipNote", blocked)}</span>}
        {blocked === steps.length && <span className="orch-issue grow">{t("orch.fixFirst")}</span>}
        {blocked === 0 && (
          <span className="faint small grow">{callOn ? t("call.waitingGo") : ""}</span>
        )}
        {blocked === 0 && (
          <Button size="sm" variant="ghost" icon={Pencil} pressed={editing} onClick={() => setEditing((open) => !open)}>
            {t("orch.editSteps")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" icon={Play} busy={running} disabled={!ready || blocked === steps.length} onClick={() => void run()}>
          {t("orch.go")}
        </Button>
      </div>
    </div>
  );
}

function PendingStepSummary({ step }: { step: OrchestratorStep }) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const engine = engines.find((item) => item.id === step.engineId);
  const workspace = workspaces.find((item) => item.id === step.workspaceId);
  const target = live.find((item) => item.ptyId === step.target);
  const targetCopy = copies.find((item) => item.id === step.target);

  let text = "";
  if (step.kind === "start") {
    text = [engine?.label ?? step.engineId, workspace?.name ?? step.asked, step.branch ? shortBranch(step.branch) : t("orch.inPlace")].filter(Boolean).join(" · ");
  } else if (step.kind === "apply" || step.kind === "discard") {
    text = `${step.kind === "apply" ? t("orch.applyStep") : t("orch.discard")} · ${targetCopy?.name ?? step.asked}`;
  } else if (step.kind === "stop") {
    text = `${t("orch.close")} · ${sessionLabel(target, workspaces) || step.asked}`;
  } else if (step.kind === "workspace") {
    text = `${t(otherStepKey(step))} · ${step.name || step.asked || ""}`;
  } else if (step.kind === "tell") {
    text = `${t("orch.tell")} · ${sessionLabel(target, workspaces) || step.asked}`;
  } else if (
    step.kind === "agent" ||
    step.kind === "skill" ||
    step.kind === "routine" ||
    step.kind === "task" ||
    step.kind === "chat" ||
    step.kind === "run" ||
    step.kind === "talk" ||
    step.kind === "verify" ||
    step.kind === "memory" ||
    step.kind === "computer"
  ) {
    text = [t(otherStepKey(step)), step.asked || step.name || step.prompt].filter(Boolean).join(" · ");
  } else {
    text = step.name || step.asked || step.prompt || step.kind;
  }

  return (
    <div className="viby-pending-item">
      <Chip tone="accent">{text}</Chip>
      {step.kind === "start" && step.branch && step.dirty ? (
        <span className="orch-warn">{t.count("orch.dirty", step.dirty, { workspace: workspace?.name ?? "" })}</span>
      ) : null}
    </div>
  );
}

function EditableStepRow({
  turnId,
  step,
  plan,
  issue,
}: {
  turnId: string;
  step: OrchestratorStep;
  plan: OrchestratorStep[];
  issue: StepIssue | null;
}) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const [edit] = useAction(async (patch: StepPatch) => call("orchestrator.editStep", turnId, step.id, patch), t("orch.failed"));
  const [remove] = useAction(async () => call("orchestrator.removeStep", turnId, step.id), t("orch.failed"));

  const engine = engines.find((item) => item.id === step.engineId);
  const planned = plan.filter((item) => item.kind === "workspace" && item.state !== "failed" && item.state !== "skipped");
  const workspace = workspaces.find((item) => item.id === step.workspaceId);
  const plannedWorkspace = planned.find((item) => plannedId(item.id) === step.workspaceId);
  const target = live.find((item) => item.ptyId === step.target);
  const targetCopy = copies.find((item) => item.id === step.target);

  let controls: ReactNode;
  if (step.kind === "workspace" && (!step.action || step.action === "create")) {
    controls = (
      <div className="orch-step-line">
        <strong>{t("orch.makeWorkspace")}</strong>
        <InlineField value={step.name ?? ""} label={t("orch.workspaceName")} width={140} onDone={(name) => void edit({ name })} />
        <InlineField value={step.folder ?? ""} label={t("orch.folder")} tip={t("orch.folderTip")} mono width={230} onDone={(folder) => void edit({ folder })} />
        <label className="orch-check" {...tipProps(t("orch.gitInitTip"))}>
          <input type="checkbox" checked={Boolean(step.git)} onChange={(event) => void edit({ git: event.target.checked })} />
          {t("orch.gitInit")}
        </label>
      </div>
    );
  } else if (step.kind === "start") {
    controls = (
      <div className="orch-step-line">
        <Select value={step.engineId} aria-label={t("orch.engine")} onChange={(event) => void edit({ engineId: event.target.value })}>
          {!engines.some((item) => item.id === step.engineId) && <option value="">{t("orch.pickEngine")}</option>}
          {engines.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.available && item.id !== step.engineId}>
              {item.label}
              {item.available ? "" : ` ${t("common.notOnPath")}`}
            </option>
          ))}
        </Select>
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
    );
  } else if (step.kind === "verify") {
    controls = (
      <div className="orch-step-line">
        <strong>{t("orch.verify")}</strong>
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
      </div>
    );
  } else if (
    step.kind === "workspace" ||
    step.kind === "lookup" ||
    step.kind === "inspect" ||
    step.kind === "shell" ||
    step.kind === "key" ||
    step.kind === "workbench" ||
    step.kind === "settings" ||
    step.kind === "task" ||
    step.kind === "routine" ||
    step.kind === "agent" ||
    step.kind === "skill" ||
    step.kind === "chat" ||
    step.kind === "run" ||
    step.kind === "talk" ||
    step.kind === "memory"
  ) {
    controls = (
      <div className="orch-step-line">
        <strong>{t(otherStepKey(step))}</strong>
        <span className="truncate">
          {step.kind === "task" && step.name && step.action !== "edit"
            ? [step.name, step.asked].filter(Boolean).join(" · ")
            : step.kind === "key"
              ? // Which key goes in, not only where: "yes" and Ctrl+C read the same otherwise.
                [step.prompt, step.asked].filter(Boolean).join(" · ")
              : step.asked || step.name || step.prompt}
        </span>
      </div>
    );
  } else {
    controls = (
      <div className="orch-step-line">
        <strong>{step.kind === "apply" ? t("orch.applyStep") : step.kind === "discard" ? t("orch.discard") : step.kind === "stop" ? t("orch.close") : step.kind}</strong>
        <span className="truncate">{targetCopy?.name || sessionLabel(target, workspaces) || step.asked || step.prompt}</span>
      </div>
    );
  }

  const showPromptBox =
    step.kind === "start" ||
    step.kind === "tell" ||
    step.kind === "shell" ||
    step.kind === "verify" ||
    (step.kind === "memory" && step.action !== "clear") ||
    (step.kind === "task" && Boolean(step.name || step.action === "create" || step.action === "create-run" || step.action === "edit" || step.action === "continue")) ||
    (step.kind === "routine" && (step.action === "create" || step.action === "edit")) ||
    (step.kind === "agent" && (step.action === "create" || step.action === "edit" || step.action === "memory-set" || step.action === "memory-append")) ||
    (step.kind === "skill" && (step.action === "create" || step.action === "edit")) ||
    (step.kind === "chat" && (step.action === "create" || step.action === "send"));

  return (
    <div className={`orch-step${issue ? " has-issue" : ""}`}>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        {controls}
        {showPromptBox && (
          <PromptBox
            value={step.prompt}
            label={t("orch.prompt")}
            placeholder={step.kind === "start" || step.kind === "shell" ? t("orch.promptEmpty") : undefined}
            onDone={(prompt) => prompt !== step.prompt && void edit({ prompt })}
          />
        )}
        {step.kind === "start" && step.branch && step.dirty ? (
          <span className="orch-warn">{t.count("orch.dirty", step.dirty, { workspace: workspace?.name ?? "" })}</span>
        ) : null}
        {issue && <span className="orch-issue">{t(issueKey(step, issue), { asked: step.asked || "?" })}</span>}
      </div>
      <Button size="sm" variant="ghost" icon={X} tip={t("orch.removeStep")} onClick={() => void remove()} />
    </div>
  );
}

function InlineField({
  value,
  label,
  tip,
  mono,
  width,
  onDone,
}: {
  value: string;
  label: string;
  tip?: string;
  mono?: boolean;
  width?: number;
  onDone: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  // The latest onDone, read when the timer fires: callers pass a new arrow each render, and during a
  // call the thread re-renders with every meter tick, which would restart the timer before it ever fired.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    const timer = setTimeout(() => doneRef.current(trimmed), 250);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <input
      className={`orch-field${mono ? " mono" : ""}`}
      style={width ? { width } : undefined}
      value={text}
      aria-label={label}
      placeholder={label}
      {...(tip ? tipProps(tip) : {})}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const trimmed = text.trim();
        setText(trimmed);
        if (trimmed !== value) onDone(trimmed);
      }}
    />
  );
}

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
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        onBlur={() => branch.trim() !== value && onDone(branch.trim())}
      />
    </label>
  );
}

function ModelField({ engine, value, onDone }: { engine: Engine | undefined; value: string; onDone: (model: string) => void }) {
  const t = useT();
  const [model, setModel] = useState(value);
  useEffect(() => setModel(value), [value]);
  const usable = Boolean(engine && takesModel(engine));
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
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
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

function PromptBox({
  value,
  label,
  placeholder,
  onDone,
}: {
  value: string;
  label: string;
  placeholder?: string;
  onDone: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  // As in InlineField: the latest onDone, so re-renders during a call don't keep restarting the timer.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => doneRef.current(text), 250);
    return () => clearTimeout(timer);
  }, [text, value]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(200, Math.max(40, node.scrollHeight + 2))}px`;
  }, [text]);
  return (
    <textarea
      ref={ref}
      className="orch-prompt"
      value={text}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onDone(text);
      }}
    />
  );
}
