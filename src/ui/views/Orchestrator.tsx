import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  CornerDownLeft,
  ExternalLink,
  FileDiff,
  FolderPlus,
  GitBranch,
  GitMerge,
  Keyboard,
  ListTodo,
  MessageSquare,
  Mic,
  MicOff,
  Pencil,
  Phone,
  PhoneOff,
  Play,
  RotateCcw,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CallState,
  Engine,
  LiveSession,
  MaestroNote,
  OrchestratorActivity,
  OrchestratorCheck,
  OrchestratorSettings,
  OrchestratorStep,
  OrchestratorTurn,
  OrchestratorView as View,
  StepIssue,
  StepPatch,
  Workspace,
} from "../../shared/api.js";
import { cleanModel, effortLevels, launchKind, takesModel } from "../../shared/launch-options.js";
import {
  brainKind,
  canOrchestrate,
  KNOWN_MODELS,
  orchestratorVoiceWords,
  plannedId,
  plannerFor,
  stepIssue,
  withPlannedWorkspaces,
  type PlanContext,
} from "../../shared/orchestrator.js";
import { call, useEngines, useLive, useOrchestrator, useSettings, useWorkspaces } from "../api.js";
import { CallButton, callMood, METER_CELLS, useCall, useCallToggle } from "../call.js";
import { VibySprite } from "../components/Pixel.js";
import { Composer } from "../components/Session.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Chip, Input, Popover, Select, Spinner, useOverlayStack } from "../components/ui.js";
import { coreText } from "../core-text.js";
import { readDraft } from "../drafts.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { overlayOpen } from "../overlays.js";
import { VIEWS } from "../rail.js";
import { shortcutKeys } from "../shortcuts.js";
import { useAction, useNav, useOverlay, useToast } from "../state.js";
import { CopyList, CopySheet } from "./OrchestratorCopies.js";

// Viby: a voice-call-first panel where the call is the whole panel, words land live as spoken,
// active work shows as a single thin line, and completed steps settle into tappable chips under
// Viby's reply. Ctrl+Shift+O opens a compact keyboard-first drawer over Code sharing the same thread.

export const OPEN_ORCHESTRATOR_EVENT = "vibeforge:open-orchestrator";
const DRAFT_KEY = "orchestrator";

/** Put the Ctrl+Shift+O bar away when a chip inside it jumps to a pane in Code. */
const LeaveBar = createContext<(() => void) | null>(null);

export { useOrchestrator };

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
      running: (live ?? [])
        .filter(isCodingCli)
        .map((item) => ({
          id: item.ptyId,
          engine: item.program || item.title,
          workspace: (item.workspaceId && names.get(item.workspaceId)) || item.title,
          folder: item.cwd,
          working: Boolean(item.working),
          orchestrated: Boolean(item.orchestrated),
        })),
      copies: (copies ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        branch: item.branch,
        workspace: (item.workspaceId && names.get(item.workspaceId)) || item.workspaceId,
      })),
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

function issueKey(step: OrchestratorStep, issue: StepIssue): Key {
  if (step.kind === "routine" && issue === "target") return "orch.issue.routine";
  if (step.kind === "task" && issue === "target") return "orch.issue.task";
  if (step.kind === "task" && issue === "engine") return "orch.issue.agent";
  if (step.kind === "show" && issue === "workspace") return "orch.issue.show";
  return ISSUE_KEY[issue];
}

/** What a lookup, inspect, shell, key, workbench, settings, task or routine step will do. */
function otherStepKey(step: OrchestratorStep): Key {
  if (step.kind === "lookup") return "orch.lookup";
  if (step.kind === "inspect") return "orch.inspect";
  if (step.kind === "shell") return "orch.shell";
  if (step.kind === "key") return "orch.key";
  if (step.kind === "workbench") return "orch.workbench";
  if (step.kind === "settings") return "orch.settings";
  if (step.kind === "task") return step.name ? "orch.taskNew" : "orch.taskRun";
  const action = step.prompt.trim().toLowerCase();
  return action === "enable" ? "orch.routineOn" : action === "disable" ? "orch.routineOff" : "orch.routineRun";
}

function sessionLabel(session: LiveSession | undefined, workspaces: Workspace[]): string {
  if (!session) return "";
  const name = session.program || session.title.split(" · ")[0] || session.title;
  const where = workspaces.find((item) => item.id === session.workspaceId)?.name;
  return where ? `${name} · ${where}` : session.title;
}

function workingLineText(activity: OrchestratorActivity | null | undefined, t: Translator): string {
  if (!activity || !activity.label) return t("orch.work.thinking");
  const target = activity.label;
  switch (activity.kind) {
    case "inspect":
      return t("orch.work.inspect", { target });
    case "lookup":
      return t("orch.work.lookup", { target });
    case "start":
      return t("orch.work.start", { target });
    case "workspace":
      return t("orch.work.workspace", { target });
    case "tell":
      return t("orch.work.tell", { target });
    case "read":
      return t("orch.work.read", { target });
    case "shell":
      return t("orch.work.shell", { target });
    case "apply":
      return t("orch.work.apply", { target });
    case "discard":
      return t("orch.work.discard", { target });
    case "stop":
      return t("orch.work.stop", { target });
    case "show":
      return t("orch.work.show", { target });
    default:
      return t("orch.work.other", { target });
  }
}

function shortBranch(branch: string): string {
  return branch.replace(/^vibeforge\//, "");
}

/** Short summary of what Viby can currently see on this machine, for the empty call state. */
function useSeesLine(t: Translator): string {
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const copyIds = new Set(copies.map((item) => item.openedWorkspaceId).filter(Boolean));
  const ownWorkspaces = workspaces.filter((item) => !copyIds.has(item.id));
  const clis = live.filter(isCodingCli);
  if (ownWorkspaces.length === 0 && clis.length === 0 && copies.length === 0) return t("orch.sees.empty");
  const parts = [
    t.count("orch.sees.workspaces", ownWorkspaces.length),
    clis.length > 0 ? t.count("orch.sees.clis", clis.length) : t("orch.sees.noClis"),
    ...(copies.length > 0 ? [t.count("orch.reviewCount", copies.length)] : []),
  ];
  return t("orch.seesPrefix", { items: parts.join(" · ") });
}

// ------------------------------------------------------------------ the full Vibe tab

export function OrchestratorView() {
  const t = useT();
  const { route, go } = useNav();
  const { fail } = useToast();
  const view = useOrchestrator().data;
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const callState = useCall();
  const toggleCall = useCallToggle();
  const seesLine = useSeesLine(t);
  const [clear] = useAction(async () => call("orchestrator.clear"), t("orch.failed"));
  const [reviewAnchor, setReviewAnchor] = useState<HTMLElement | null>(null);
  const [typingOpen, setTypingOpen] = useState(() => Boolean(readDraft<string>(DRAFT_KEY)?.trim()));
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);

  useEffect(() => {
    void call("voice.status")
      .then((status) => setVoiceReady(status.ready))
      .catch(() => setVoiceReady(null));
  }, [callState.on]);

  // Starting a call tucks the keyboard box away unless a half-typed draft is sitting in it.
  const prevOn = useRef(callState.on);
  useEffect(() => {
    if (callState.on && !prevOn.current && !readDraft<string>(DRAFT_KEY)?.trim()) setTypingOpen(false);
    prevOn.current = callState.on;
  }, [callState.on]);

  // Typing a printable key anywhere in the Vibe panel opens the message box when you can't talk.
  useEffect(() => {
    if (typingOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || overlayOpen()) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return;
      if (event.key.length === 1 && event.key.trim() !== "") setTypingOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [typingOpen]);

  const engineId = view?.engineId ?? plannerFor(settings?.orchestrator.engine ?? "", engines) ?? settings?.orchestrator.engine ?? "";
  const turns = view?.turns ?? [];
  const copies = view?.copies ?? [];
  const emptyBeforeCall = !callState.on && turns.length === 0 && !view?.thinking;

  return (
    <div className={`view viby-view${callState.on ? " in-call" : ""}`}>
      <div className="viby-top">
        <PlannerModelLabel engineId={engineId} locked={callState.on} />
        <span className="grow" />
        {copies.length > 0 && (
          <button
            type="button"
            className="viby-chip review-pill"
            aria-expanded={Boolean(reviewAnchor)}
            onClick={(event) => setReviewAnchor(reviewAnchor ? null : event.currentTarget)}
          >
            <GitBranch size={12} />
            <span>{t.count("orch.reviewCount", copies.length)}</span>
          </button>
        )}
        {!callState.on && turns.length > 0 && (
          <Button size="sm" variant="ghost" icon={RotateCcw} tip={t("orch.newTip")} onClick={() => void clear()}>
            {t("orch.new")}
          </Button>
        )}
      </div>

      {reviewAnchor && copies.length > 0 && (
        <Popover anchor={reviewAnchor} align="end" onClose={() => setReviewAnchor(null)}>
          <div className="viby-review-popover">
            <CopyList copies={copies} workspaces={workspaces} onPick={() => setReviewAnchor(null)} />
          </div>
        </Popover>
      )}

      {emptyBeforeCall ? (
        <div className="viby-empty">
          <VibySprite mood="idle" size={64} label={t("orch.title")} className="viby-hero-sprite" />
          {view && !view.engineReady ? (
            <div className="orch-problem">
              <CircleAlert size={14} />
              <span className="grow">{t("orch.notReady")}</span>
              <Button size="sm" onClick={() => go({ view: "settings", section: "orchestrator" })}>
                {t("orch.openSettings")}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="viby-call-hero"
              {...tipProps(t("call.startTip"), { kbd: shortcutKeys("app.call") })}
              onClick={toggleCall}
            >
              <Phone size={18} strokeWidth={2.1} />
              <span>{t("call.start")}</span>
            </button>
          )}
          <p className="viby-sees">{seesLine}</p>
          {voiceReady === false && (
            <button type="button" className="viby-voice-setup" onClick={() => go({ view: "settings", section: "voice" })}>
              {t("orch.voiceSetup")}
            </button>
          )}
        </div>
      ) : (
        <ConversationStream view={view} callState={callState} seesLine={seesLine} />
      )}

      <div className="viby-bottom">
        {typingOpen && (
          <div className="viby-composer-wrap">
            <div className="viby-composer-inner">
              <Composer
                placeholder={t("orch.typePlaceholder")}
                busy={view?.thinking}
                disabled={!view}
                autoFocus
                quiet
                sendLabel={t("common.send")}
                voiceLabel={t("orch.title")}
                voiceWords={() => orchestratorVoiceWords(workspaces.map((item) => item.name))}
                draftKey={DRAFT_KEY}
                keepKey="orchestrator"
                onEscape={() => setTypingOpen(false)}
                onSend={async (text) => {
                  void call("orchestrator.ask", text).catch((error: unknown) => fail(error, t("orch.failed")));
                  return true;
                }}
              />
              <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} onClick={() => setTypingOpen(false)} />
            </div>
          </div>
        )}

        {callState.on ? (
          <LiveCallDock callState={callState} typingOpen={typingOpen} onToggleTyping={() => setTypingOpen((open) => !open)} />
        ) : emptyBeforeCall ? (
          !typingOpen && (
            <div className="viby-corner-actions">
              <Button size="sm" variant="ghost" icon={Keyboard} tip={t("orch.typeToggle")} onClick={() => setTypingOpen(true)} />
            </div>
          )
        ) : (
          <div className="viby-after-dock">
            <button
              type="button"
              className="viby-call-again"
              {...tipProps(t("call.startTip"), { kbd: shortcutKeys("app.call") })}
              onClick={toggleCall}
            >
              <Phone size={15} strokeWidth={2.1} />
              <span>{t("call.start")}</span>
            </button>
            <Button
              size="sm"
              variant="ghost"
              icon={Keyboard}
              pressed={typingOpen}
              tip={t("orch.typeToggle")}
              onClick={() => setTypingOpen((open) => !open)}
            />
          </div>
        )}
      </div>

      {route.view === "orchestrator" && route.copyId && <CopySheet copyId={route.copyId} copies={view?.copies} />}
    </div>
  );
}

// ------------------------------------------------------------------ Ctrl+Shift+O over Code

/** Quick keyboard-first drawer over any view, sharing Viby's exact conversation and action chips. */
export function OrchestratorBar({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const view = useOrchestrator().data;
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const callState = useCall();
  const seesLine = useSeesLine(t);
  const box = useRef<HTMLDivElement>(null);
  useOverlay(true);
  useOverlayStack(box, onClose);
  const engineId = view?.engineId ?? plannerFor(settings?.orchestrator.engine ?? "", engines) ?? settings?.orchestrator.engine ?? "";

  return createPortal(
    <div className="scrim switcher-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={box} className="switcher orch-bar" role="dialog" aria-modal aria-label={t("orch.title")} tabIndex={-1}>
        <div className="orch-bar-head">
          <VibySprite mood={callMood(callState)} size={18} level={callState.level} />
          <strong>{t("orch.title")}</strong>
          <PlannerModelLabel engineId={engineId} locked={callState.on} />
          <span className="grow" />
          <CallButton />
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
          <ConversationStream view={view} callState={callState} seesLine={seesLine} compact />
          <Composer
            placeholder={t("orch.typePlaceholder")}
            busy={view?.thinking}
            disabled={!view}
            autoFocus
            quiet
            sendLabel={t("common.send")}
            voiceLabel={t("orch.title")}
            voiceWords={() => orchestratorVoiceWords(workspaces.map((item) => item.name))}
            draftKey={DRAFT_KEY}
            keepKey="orchestrator"
            onEscape={onClose}
            onSend={async (text) => {
              void call("orchestrator.ask", text).catch((error: unknown) => fail(error, t("orch.failed")));
              return true;
            }}
          />
        </LeaveBar.Provider>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ between-calls model label

function PlannerModelLabel({ engineId, locked }: { engineId: string; locked: boolean }) {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [save] = useAction(async (orchestrator: OrchestratorSettings) => call("settings.save", { orchestrator }), t("settings.saveFailed"));

  const engine = engines.find((item) => item.id === engineId);
  const engineLabel = engine?.label ?? (engineId || t("orch.title"));
  const chosenModel = settings && engineId === settings.orchestrator.engine ? settings.orchestrator.model : "";
  const isClaude = Boolean(engine && brainKind(engine) === "claude");
  const modelLabel = chosenModel || (isClaude ? (locked ? "haiku" : t("orch.modelCallDefault")) : t("orch.modelDefault"));

  if (locked) {
    return (
      <span className="viby-model locked" {...tipProps(t("orch.modelLocked"))}>
        <span>{engineLabel}</span>
        <span className="faint">·</span>
        <span className="mono">{modelLabel}</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="viby-model"
        aria-expanded={Boolean(anchor)}
        {...tipProps(t("orch.plannerTip"))}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <span>{engineLabel}</span>
        <span className="faint">·</span>
        <span className="mono">{modelLabel}</span>
        <ChevronDown size={12} className="faint" />
      </button>
      {anchor && settings && (
        <ModelPopover
          anchor={anchor}
          engineId={engineId}
          current={settings.orchestrator}
          engines={engines}
          onSave={(next) => void save(next)}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function ModelPopover({
  anchor,
  engineId,
  current,
  engines,
  onSave,
  onClose,
}: {
  anchor: HTMLElement;
  engineId: string;
  current: OrchestratorSettings;
  engines: Engine[];
  onSave: (next: OrchestratorSettings) => void;
  onClose: () => void;
}) {
  const t = useT();
  const planners = engines.filter((item) => canOrchestrate(item));
  const activeEngine = engines.find((item) => item.id === engineId);
  const isClaude = Boolean(activeEngine && brainKind(activeEngine) === "claude");
  const activeModel = engineId === current.engine ? current.model : "";
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);
  const [typed, setTyped] = useState(activeModel);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setLoading(true);
    void call("orchestrator.models", engineId)
      .catch(() => [] as string[])
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engineId]);

  const listed = models ?? [];
  const defaultLabel = isClaude ? t("orch.modelCallDefault") : t("orch.modelDefault");

  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="viby-model-popover">
        <div className="list-label">{t("orch.planner")}</div>
        {planners.map((item) => {
          const selected = item.id === engineId;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              disabled={!item.available && !selected}
              className="menu-item"
              onClick={() => {
                setCustom(false);
                setTyped("");
                onSave({ ...current, engine: item.id, model: "", effort: "" });
              }}
            >
              <span className="viby-menu-check">{selected && <Check size={13} />}</span>
              <span className="grow truncate">{item.label}</span>
              {!item.available && <span className="faint small">{t("common.notOnPath")}</span>}
            </button>
          );
        })}

        <div className="list-label" style={{ marginTop: 6 }}>
          {t("orch.model")}
        </div>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={activeModel === "" && !custom}
          className="menu-item"
          onClick={() => {
            onSave({ ...current, engine: engineId, model: "" });
            onClose();
          }}
        >
          <span className="viby-menu-check">{activeModel === "" && !custom && <Check size={13} />}</span>
          <span className="grow truncate">{defaultLabel}</span>
        </button>
        {activeModel && !listed.includes(activeModel) && (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!custom}
            className="menu-item"
            onClick={onClose}
          >
            <span className="viby-menu-check">{!custom && <Check size={13} />}</span>
            <span className="grow truncate mono">{activeModel}</span>
          </button>
        )}
        {listed.map((name) => {
          const selected = activeModel === name && !custom;
          return (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className="menu-item"
              onClick={() => {
                onSave({ ...current, engine: engineId, model: name });
                onClose();
              }}
            >
              <span className="viby-menu-check">{selected && <Check size={13} />}</span>
              <span className="grow truncate mono">{name}</span>
            </button>
          );
        })}
        {loading && <div className="faint small viby-menu-note">{t("orch.modelsLoading")}</div>}
        {custom ? (
          <div className="viby-model-custom">
            <Input
              className="mono"
              autoFocus
              value={typed}
              placeholder={t("orch.modelPlaceholder")}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const cleaned = cleanModel(typed);
                  onSave({ ...current, engine: engineId, model: cleaned });
                  onClose();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setCustom(false);
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setTyped(activeModel);
              setCustom(true);
            }}
          >
            <span className="viby-menu-check" />
            <span className="grow truncate">{t("orch.modelOther")}</span>
          </button>
        )}
      </div>
    </Popover>
  );
}

// ------------------------------------------------------------------ live call dock

function LiveCallDock({
  callState,
  typingOpen,
  onToggleTyping,
}: {
  callState: CallState;
  typingOpen: boolean;
  onToggleTyping: () => void;
}) {
  const t = useT();
  const mood = callMood(callState);
  const muted = Boolean(callState.muted);
  const lit = Math.round(callState.level * METER_CELLS);
  const stateLabel =
    mood === "speaking"
      ? t("call.state.speaking")
      : mood === "thinking"
        ? t("call.state.thinking")
        : muted
          ? t("call.muted")
          : callState.waiting
            ? t("call.waitingGo")
            : t("call.state.listening");

  return (
    <div className={`viby-live-dock state-${mood}`} role="status" aria-live="polite">
      <div className="viby-live-inner">
        <VibySprite mood={mood} size={28} level={callState.level} />
        <strong className="viby-live-label">{stateLabel}</strong>
        {mood === "listening" && (
          <span className="meter" aria-hidden>
            {Array.from({ length: METER_CELLS }, (_, i) => (
              <i key={i} className={i < lit ? (i >= METER_CELLS - 3 ? "hot" : "on") : undefined} />
            ))}
          </span>
        )}
        {(mood === "speaking" || mood === "thinking") && callState.talkOver && !muted && (
          <span className="faint small truncate">{t("call.talkOverHint")}</span>
        )}
        <span className="grow" />
        {callState.phase === "thinking" && (
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void call("orchestrator.stopThinking")}>
            {t("orch.stop")}
          </Button>
        )}
        {callState.phase === "speaking" && (
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void call("voice.silence")}>
            {t("voice.silence")}
          </Button>
        )}
        <Button size="sm" variant={muted ? "primary" : "ghost"} icon={muted ? Mic : MicOff} onClick={() => void call("call.mute")}>
          {muted ? t("call.unmute") : t("call.mute")}
        </Button>
        <Button size="sm" variant="danger" icon={PhoneOff} tip={t("call.hangUpTip")} onClick={() => void call("call.stop")}>
          {t("call.hangUp")}
        </Button>
        <Button size="sm" variant="ghost" icon={Keyboard} pressed={typingOpen} tip={t("orch.typeToggle")} onClick={onToggleTyping} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the conversation stream

function ConversationStream({
  view,
  callState,
  seesLine,
  compact,
}: {
  view: View | undefined;
  callState: CallState;
  seesLine: string;
  compact?: boolean;
}) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const turns = view?.turns ?? [];
  const shown = compact ? turns.slice(-4) : turns;
  const engineLabel = engines.find((engine) => engine.id === view?.engineId)?.label ?? view?.engineId ?? "";
  const [stop] = useAction(async () => call("orchestrator.stopThinking"), t("orch.failed"));

  // Track which Viby turn arrived while a spoken call was active, so historical turns never re-animate.
  const initialLastId = useRef<string | null | undefined>(undefined);
  if (initialLastId.current === undefined && view) initialLastId.current = turns.at(-1)?.id ?? null;
  const newestVibyId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].from === "vibeforge" && !turns[i].note) return turns[i].id;
    }
    return null;
  }, [turns]);

  const showLiveUser =
    callState.on &&
    !callState.muted &&
    (callState.phase === "hearing" || (callState.phase === "transcribing" && !view?.thinking));

  const last = turns.at(-1);
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, last?.plan, view?.thinking, view?.activity?.label, showLiveUser, callState.liveHeard]);

  return (
    <div className={`orch-turns${compact ? " compact" : ""}`} ref={scroller}>
      <div className="viby-thread">
        {view && turns.length === 0 && !view.thinking && !showLiveUser && (
          <div className="viby-call-ready">
            {!compact && <VibySprite mood={callMood(callState)} size={52} level={callState.level} />}
            <p className="viby-sees">{seesLine}</p>
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
          <TurnView
            key={turn.id}
            turn={turn}
            engineLabel={engineLabel}
            activity={view?.activity}
            callState={callState}
            revealLive={
              callState.on &&
              callState.spoken &&
              turn.id === newestVibyId &&
              turn.id !== initialLastId.current
            }
          />
        ))}
        {showLiveUser && (
          <div className="orch-turn from-you live-speaking">
            <span className="orch-said">
              {callState.liveHeard ? (
                <>
                  {callState.liveHeard}
                  <i className="viby-caret" aria-hidden />
                </>
              ) : (
                <span className="viby-wave" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </span>
          </div>
        )}
        {view?.thinking && (
          <div className="orch-turn from-vibeforge">
            <span className="viby-avatar">
              <VibySprite mood="thinking" size={22} />
            </span>
            <div className="viby-work-line grow">
              <Spinner />
              <span className="truncate">{workingLineText(view.activity, t)}</span>
            </div>
            <Button size="sm" variant="ghost" icon={Square} onClick={() => void stop()}>
              {t("orch.stop")}
            </Button>
          </div>
        )}
      </div>
    </div>
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

function TurnView({
  turn,
  engineLabel: current,
  activity,
  callState,
  revealLive,
}: {
  turn: OrchestratorTurn;
  engineLabel: string;
  activity: OrchestratorActivity | null | undefined;
  callState: CallState;
  revealLive: boolean;
}) {
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

  if (turn.note) return <NoteTurnView note={turn.note} />;

  const running = turn.plan === "running";
  const speakingHere = revealLive && callState.phase === "speaking";
  const spriteMood = speakingHere ? "speaking" : running ? "thinking" : "idle";
  const runningStep = running ? turn.steps?.find((step) => step.state === "running") : undefined;
  const stepActivity: OrchestratorActivity | null =
    activity ?? (runningStep ? { kind: runningStep.kind, label: runningStep.name || runningStep.branch || runningStep.asked || "" } : null);

  return (
    <div className="orch-turn from-vibeforge">
      <span className="viby-avatar">
        <VibySprite mood={spriteMood} size={22} animated={speakingHere || running} />
      </span>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        {turn.problem ? (
          <span className="orch-problem-text">
            <CircleAlert size={13} /> {t(PROBLEM_KEY[turn.problem], { engine: engineLabel })}
            {turn.detail && <span className="orch-detail mono">{turn.detail}</span>}
          </span>
        ) : (
          turn.text && <SpokenText text={turn.text} active={revealLive} callState={callState} />
        )}
        {running && (
          <div className="viby-work-line">
            <Spinner />
            <span className="truncate">{workingLineText(stepActivity, t)}</span>
          </div>
        )}
        <TurnChips turn={turn} />
        {turn.steps && turn.plan === "waiting" && <WaitingConfirm turn={turn} callOn={callState.on} />}
      </div>
    </div>
  );
}

/** Reveals Viby's words progressively while Piper speaks them, snapping to full text once done or interrupted. */
function SpokenText({ text, active, callState }: { text: string; active: boolean; callState: CallState }) {
  const tokens = useMemo(() => text.trim().split(/(\s+)/), [text]);
  const arrivedAt = useRef(Date.now());
  const [shownTokens, setShownTokens] = useState(() => (active ? 1 : tokens.length));
  const settled = useRef(!active);

  useEffect(() => {
    if (!active || settled.current) {
      setShownTokens(tokens.length);
      return;
    }
    // Wait up to 350ms for Piper to enter `speaking`; if it doesn't, show everything immediately.
    if (callState.phase !== "speaking") {
      const grace = window.setTimeout(() => {
        settled.current = true;
        setShownTokens(tokens.length);
      }, 350);
      return () => window.clearTimeout(grace);
    }
    const tick = () => {
      const started = callState.speechStartedAt || arrivedAt.current;
      const duration = callState.speechDurationMs || Math.max(900, text.length * 60);
      const ratio = Math.min(1, Math.max(0.06, (Date.now() - started) / duration));
      const next = Math.max(1, Math.ceil(ratio * tokens.length));
      setShownTokens((prev) => Math.max(prev, next));
      if (ratio >= 1) settled.current = true;
    };
    tick();
    const timer = window.setInterval(tick, 45);
    return () => window.clearInterval(timer);
  }, [active, callState.phase, callState.speechStartedAt, callState.speechDurationMs, text.length, tokens.length]);

  const wasSpeaking = useRef(false);
  useEffect(() => {
    if (active && callState.phase === "speaking") wasSpeaking.current = true;
    else if (wasSpeaking.current && callState.phase !== "speaking") {
      settled.current = true;
      setShownTokens(tokens.length);
    }
  }, [active, callState.phase, tokens.length]);

  const visible = shownTokens >= tokens.length ? text : tokens.slice(0, shownTokens).join("");
  return <span className="orch-said">{visible}</span>;
}

// ------------------------------------------------------------------ tappable chips under a reply

function TurnChips({ turn }: { turn: OrchestratorTurn }) {
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
  const label = t(check.kind === "lookup" ? "orch.chip.lookedUp" : "orch.chip.checked", { target: check.label });
  const canOpenPty = Boolean(check.ptyId && live.some((item) => item.ptyId === check.ptyId));
  const copy = check.copyId ? copies.find((item) => item.id === check.copyId) : undefined;

  return (
    <>
      <button type="button" className="viby-chip" onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        <Search size={11} />
        <span className="truncate">{label}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
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
          <Popover anchor={replyAnchor} onClose={() => setReplyAnchor(null)}>
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
    const label = sessionLabel(targetSession, workspaces) || viewLabel || workspace?.name || step.asked;
    return (
      <button
        type="button"
        className="viby-chip action"
        onClick={() => {
          leaveBar?.();
          if (targetSession) go({ view: "code", workspaceId: targetSession.workspaceId ?? undefined, ptyId: targetSession.ptyId });
          else if (shownView) go({ view: shownView as Parameters<typeof go>[0]["view"] });
          else if (step.workspaceId) go({ view: "code", workspaceId: step.workspaceId });
        }}
      >
        <ArrowUpRight size={12} />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  if (step.kind === "task" || step.kind === "routine") {
    const Icon = step.kind === "task" ? ListTodo : Clock;
    const label = step.name || step.asked || step.prompt;
    return (
      <button
        type="button"
        className="viby-chip action"
        onClick={() => {
          leaveBar?.();
          if (step.kind === "task") go({ view: "tasks", ...(step.target ? { taskId: step.target } : {}) });
          else go({ view: "routines" });
        }}
      >
        <Icon size={11} />
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

// ------------------------------------------------------------------ proactive CLI notes

function NoteTurnView({ note }: { note: MaestroNote }) {
  const t = useT();
  const { go } = useNav();
  const leaveBar = useContext(LeaveBar);
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const [replyAnchor, setReplyAnchor] = useState<HTMLElement | null>(null);
  const running = live.some((item) => item.ptyId === note.ptyId);
  const copy = note.copyId ? copies.find((item) => item.id === note.copyId) : undefined;

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
          <Popover anchor={replyAnchor} onClose={() => setReplyAnchor(null)}>
            <div className="viby-detail-popover">
              <pre className="viby-detail-pre mono selectable">{note.reply}</pre>
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ compact inline confirmation (when Go is needed)

function WaitingConfirm({ turn, callOn }: { turn: OrchestratorTurn; callOn: boolean }) {
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
    text = `${t("orch.makeWorkspace")} · ${step.name ?? ""}`;
  } else if (step.kind === "tell") {
    text = `${t("orch.tell")} · ${sessionLabel(target, workspaces) || step.asked}`;
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
  if (step.kind === "workspace") {
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
  } else if (step.kind === "lookup" || step.kind === "inspect" || step.kind === "shell" || step.kind === "key" || step.kind === "workbench" || step.kind === "settings" || step.kind === "task" || step.kind === "routine") {
    controls = (
      <div className="orch-step-line">
        <strong>{t(otherStepKey(step))}</strong>
        <span className="truncate">{step.kind === "task" && step.name ? [step.name, step.asked].filter(Boolean).join(" · ") : step.asked || step.name || step.prompt}</span>
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

  return (
    <div className={`orch-step${issue ? " has-issue" : ""}`}>
      <div className="vstack grow" style={{ gap: 6, minWidth: 0 }}>
        {controls}
        {(step.kind === "start" || step.kind === "tell" || step.kind === "shell" || (step.kind === "task" && Boolean(step.name))) && (
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
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
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
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onDone(text), 250);
    return () => clearTimeout(timer);
  }, [text, value, onDone]);
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
