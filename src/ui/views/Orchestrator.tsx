import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  GitBranch,
  Keyboard,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CallState,
  Engine,
  OrchestratorActivity,
  OrchestratorSettings,
  OrchestratorTurn,
  OrchestratorView as View,
  Settings,
  SettingsPatch,
} from "../../shared/api.js";
import { cleanModel, effortForModel, effortLevels, modelOwnEffort } from "../../shared/launch-options.js";
import { LOCAL_ENGINE_ID, isLocalConfigured, vibyLocalModel, vibyPlannerPatch } from "../../shared/local.js";
import { brainKind, CONFIRMED_KEY, canOrchestrate, orchestratorVoiceWords, plannerFor } from "../../shared/orchestrator.js";
import { call, useAgents, useEngines, useLive, useOrchestrator, useRoutines, useSettings, useSkills, useWorkspaces } from "../api.js";
import { CallButton, CallMeterCells, callMood, LiveVibySprite, useCall, useCallToggle, useUnreadSaid } from "../call.js";
import { VibySprite } from "../components/Pixel.js";
import { tipProps } from "../components/Tooltip.js";
import { Button, Input, Modal, Notice, Popover, Spinner, useOverlayStack } from "../components/ui.js";
import { readDraft, seedDraft } from "../drafts.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { overlayOpen } from "../overlays.js";
import { shortcutKeys } from "../shortcuts.js";
import { useAction, useNav, useOverlay, useToast } from "../state.js";
import { CopyList, CopySheet } from "./OrchestratorCopies.js";
import { TurnChips, NoteTurnView } from "./orchestrator/OrchestratorChips.js";
import { WaitingConfirm } from "./orchestrator/OrchestratorConfirm.js";
import { MemoryButton, RunningPill, ThreadsButton, VibyMemorySheet } from "./orchestrator/OrchestratorTopTools.js";
import { isCodingCli, LeaveBar } from "./orchestrator/shared.js";
import { VibyComposer } from "./orchestrator/VibyComposer.js";

// Viby: a voice-call-first panel where the call is the whole panel, words land live as spoken,
// active work shows as a single thin line, and completed steps settle into tappable chips under
// Viby's reply. Ctrl+Shift+O opens a compact keyboard-first drawer over Code sharing the same thread.

export const OPEN_ORCHESTRATOR_EVENT = "vibeforge:open-orchestrator";
const DRAFT_KEY = "orchestrator";

export { useOrchestrator };

function workingLineText(activity: OrchestratorActivity | null | undefined, t: Translator): string {
  if (!activity || !activity.label) return t("orch.work.thinking");
  const target = activity.label;
  switch (activity.kind) {
    case "inspect":
      return t("orch.work.inspect", { target });
    case "lookup":
      return t("orch.work.lookup", { target });
    case "verify":
      return t("orch.work.verify", { target });
    case "memory":
      return t("orch.work.memory", { target });
    case "computer":
      return t("orch.work.computer", { target });
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

/** Short summary of what Viby can currently see on this machine, for the empty call state. */
function useSeesLine(t: Translator): { text: string; active: boolean } {
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const live = useLive().data ?? [];
  const copies = useOrchestrator().data?.copies ?? [];
  const copyIds = new Set(copies.map((item) => item.openedWorkspaceId).filter(Boolean));
  const ownWorkspaces = workspaces.filter((item) => !copyIds.has(item.id));
  const clis = live.filter(isCodingCli);
  if (ownWorkspaces.length === 0 && clis.length === 0 && copies.length === 0) return { text: t("orch.sees.empty"), active: false };
  const parts = [
    t.count("orch.sees.workspaces", ownWorkspaces.length),
    clis.length > 0 ? t.count("orch.sees.clis", clis.length) : t("orch.sees.noClis"),
    ...(copies.length > 0 ? [t.count("orch.reviewCount", copies.length)] : []),
  ];
  return { text: parts.join(" · "), active: clis.length > 0 };
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
  const agents = useAgents().data ?? [];
  const skills = useSkills().data ?? [];
  const routines = useRoutines().data ?? [];
  const callState = useCall();
  const toggleCall = useCallToggle();
  const sees = useSeesLine(t);
  const callShortcut = shortcutKeys("app.call");
  const [clear] = useAction(async () => call("orchestrator.clear"), t("orch.failed"));
  const [reviewAnchor, setReviewAnchor] = useState<HTMLElement | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Typing and calling sit side by side: the message box is open whenever there is no call.
  const [typingOpen, setTypingOpen] = useState(() => !callState.on || Boolean(readDraft<string>(DRAFT_KEY)?.trim()));
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);

  useEffect(() => {
    void call("voice.status")
      .then((status) => setVoiceReady(status.ready))
      .catch(() => setVoiceReady(null));
  }, [callState.on]);

  // Starting a call tucks the keyboard box away unless a half-typed draft is sitting in it;
  // hanging up brings it back.
  const prevOn = useRef(callState.on);
  useEffect(() => {
    if (callState.on && !prevOn.current && !readDraft<string>(DRAFT_KEY)?.trim()) setTypingOpen(false);
    if (!callState.on && prevOn.current) setTypingOpen(true);
    prevOn.current = callState.on;
  }, [callState.on]);

  // Typing a printable key anywhere in the Vibe panel opens the message box when you can't talk.
  useEffect(() => {
    if (typingOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || overlayOpen()) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return;
      if (event.key.length === 1 && event.key.trim() !== "") {
        // The key that opened the box is the first letter typed in it, not lost on the page behind.
        event.preventDefault();
        seedDraft(DRAFT_KEY, (readDraft<string>(DRAFT_KEY) ?? "") + event.key);
        setTypingOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [typingOpen]);

  const engineId = view?.engineId ?? plannerFor(settings?.orchestrator.engine ?? "", engines) ?? settings?.orchestrator.engine ?? "";
  useLocalContextProbe(engineId, settings);
  const turns = view?.turns ?? [];
  const copies = view?.copies ?? [];
  const waitingTurnId = [...turns].reverse().find((item) => item.plan === "waiting")?.id ?? null;
  const emptyBeforeCall = !callState.on && turns.length === 0 && !view?.thinking;
  // The last copy applied or discarded removes the pill: forget its anchor too, or the popover would
  // open by itself (on a detached button, in the corner) when the next copy appears.
  useEffect(() => {
    if (copies.length === 0) setReviewAnchor(null);
  }, [copies.length]);

  const composer = (
    <VibyComposer
      placeholder={t("orch.typePlaceholder")}
      busy={view?.thinking}
      disabled={!view}
      autoFocus
      sendLabel={t("common.send")}
      voiceLabel={t("orch.title")}
      voiceWords={() =>
        orchestratorVoiceWords(
          workspaces.map((item) => item.name),
          {
            agents: agents.map((a) => a.name),
            engines: engines.filter((e) => e.available).map((e) => e.label),
            skills: skills.map((s) => s.name),
            routines: routines.map((r) => r.name),
          },
        )
      }
      draftKey={DRAFT_KEY}
      keepKey="orchestrator"
      waitingTurnId={waitingTurnId}
      onRunWaiting={(id) => void call("orchestrator.run", id).catch((error: unknown) => fail(error, t("orch.failed")))}
      onEscape={!emptyBeforeCall ? () => setTypingOpen(false) : undefined}
      onSend={async (text, images) => {
        try {
          await call("orchestrator.ask", text, images);
          return true;
        } catch (error: unknown) {
          fail(error, t("orch.failed"));
          return false;
        }
      }}
    />
  );

  return (
    <div className={`view viby-view${callState.on ? " in-call" : ""}`}>
      <div className="viby-top">
        <PlannerModelLabel engineId={engineId} locked={callState.on} />
        <span className="grow" />
        <RunningPill />
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
        <ThreadsButton />
        <MemoryButton hasMemory={view?.hasMemory} onOpen={() => setMemoryOpen(true)} />
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
      {memoryOpen && <VibyMemorySheet onClose={() => setMemoryOpen(false)} />}
      {engineId === LOCAL_ENGINE_ID && view?.localContextWarning && (
        <div style={{ padding: "0 14px 8px" }}>
          <Notice tone="warn">
            <div className="hstack wrap" style={{ gap: 8 }}>
              <span className="grow">
                {t("orch.localSmallContext", {
                  ctx: view.localContextWarning.contextLength.toLocaleString(),
                  needed: view.localContextWarning.neededTokens.toLocaleString(),
                })}
              </span>
              <Button size="sm" onClick={() => go({ view: "settings", section: "local" })}>
                {t("local.title")}
              </Button>
            </div>
          </Notice>
        </div>
      )}

      {emptyBeforeCall ? (
        <div className="viby-empty">
          <div className="viby-stage">
            <div className="viby-hero">
              <div className="viby-hero-aura">
                <VibySprite mood="idle" size={72} label={t("orch.title")} className="viby-hero-sprite" />
              </div>
              <p className="viby-sees">
                {sees.active && <span className="viby-dot working" aria-hidden />}
                <span>{sees.text}</span>
              </p>
            </div>
            {view && !view.engineReady ? (
              <div className="orch-problem">
                <CircleAlert size={14} />
                <span className="grow">{t("orch.notReady")}</span>
                <Button size="sm" onClick={() => go({ view: "settings", section: "orchestrator" })}>
                  {t("orch.openSettings")}
                </Button>
              </div>
            ) : (
              <div className="viby-call-group">
                <button
                  type="button"
                  className="viby-call-hero"
                  {...tipProps(t("call.startTip"), { kbd: callShortcut })}
                  onClick={toggleCall}
                >
                  <AudioLines size={16} strokeWidth={2} className="viby-call-icon" />
                  <span>{t("call.start")}</span>
                  {callShortcut && <kbd className="viby-call-kbd">{callShortcut}</kbd>}
                </button>
                {voiceReady === false && (
                  <button type="button" className="viby-voice-setup" onClick={() => go({ view: "settings", section: "voice" })}>
                    {t("orch.voiceSetup")}
                  </button>
                )}
              </div>
            )}
            <div className="viby-composer-wrap viby-empty-composer">{composer}</div>
          </div>
        </div>
      ) : (
        <ConversationStream view={view} callState={callState} sees={sees} />
      )}

      {!emptyBeforeCall && (
        <div className="viby-bottom">
          {typingOpen && (
            <div className="viby-composer-wrap">
              <div className="viby-composer-inner">
                {composer}
                {callState.on && <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} onClick={() => setTypingOpen(false)} />}
              </div>
            </div>
          )}

          {callState.on ? (
            <LiveCallDock callState={callState} typingOpen={typingOpen} onToggleTyping={() => setTypingOpen((open) => !open)} />
          ) : (
            <div className="viby-after-dock">
              <button
                type="button"
                className="viby-call-again"
                {...tipProps(t("call.startTip"), { kbd: callShortcut })}
                onClick={toggleCall}
              >
                <AudioLines size={15} strokeWidth={2} className="viby-call-icon" />
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
      )}

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
  const agents = useAgents().data ?? [];
  const skills = useSkills().data ?? [];
  const routines = useRoutines().data ?? [];
  const callState = useCall();
  const sees = useSeesLine(t);
  const box = useRef<HTMLDivElement>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  useOverlay(true);
  useOverlayStack(box, onClose);
  const engineId = view?.engineId ?? plannerFor(settings?.orchestrator.engine ?? "", engines) ?? settings?.orchestrator.engine ?? "";
  useLocalContextProbe(engineId, settings);
  const waitingTurnId = [...(view?.turns ?? [])].reverse().find((item) => item.plan === "waiting")?.id ?? null;

  return createPortal(
    <div className="scrim switcher-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={box} className="switcher orch-bar" role="dialog" aria-modal aria-label={t("orch.title")} tabIndex={-1}>
        <div className="orch-bar-head">
          <LiveVibySprite mood={callMood(callState)} size={18} active={callState.on} />
          <strong>{t("orch.title")}</strong>
          <PlannerModelLabel engineId={engineId} locked={callState.on} />
          <span className="grow" />
          <RunningPill />
          <ThreadsButton />
          <MemoryButton hasMemory={view?.hasMemory} onOpen={() => setMemoryOpen(true)} />
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
        {engineId === LOCAL_ENGINE_ID && view?.localContextWarning && (
          <div style={{ padding: "0 12px 6px" }}>
            <Notice tone="warn">
              <div className="hstack wrap" style={{ gap: 8 }}>
                <span className="grow">
                  {t("orch.localSmallContext", {
                    ctx: view.localContextWarning.contextLength.toLocaleString(),
                    needed: view.localContextWarning.neededTokens.toLocaleString(),
                  })}
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    go({ view: "settings", section: "local" });
                  }}
                >
                  {t("local.title")}
                </Button>
              </div>
            </Notice>
          </div>
        )}
        {memoryOpen && <VibyMemorySheet onClose={() => setMemoryOpen(false)} />}
        <LeaveBar.Provider value={onClose}>
          <ConversationStream view={view} callState={callState} sees={sees} compact />
          <VibyComposer
            placeholder={t("orch.typePlaceholder")}
            busy={view?.thinking}
            disabled={!view}
            autoFocus
            sendLabel={t("common.send")}
            voiceLabel={t("orch.title")}
            voiceWords={() =>
              orchestratorVoiceWords(
                workspaces.map((item) => item.name),
                {
                  agents: agents.map((a) => a.name),
                  engines: engines.filter((e) => e.available).map((e) => e.label),
                  skills: skills.map((s) => s.name),
                  routines: routines.map((r) => r.name),
                },
              )
            }
            draftKey={DRAFT_KEY}
            keepKey="orchestrator"
            waitingTurnId={waitingTurnId}
            onRunWaiting={(id) => void call("orchestrator.run", id).catch((error: unknown) => fail(error, t("orch.failed")))}
            onEscape={onClose}
            onSend={async (text, images) => {
              try {
                await call("orchestrator.ask", text, images);
                return true;
              } catch (error: unknown) {
                fail(error, t("orch.failed"));
                return false;
              }
            }}
          />
        </LeaveBar.Provider>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ between-calls model label

function useLocalContextProbe(engineId: string, settings: Settings | undefined) {
  const url = settings?.local.url ?? "";
  const model = settings ? vibyLocalModel(settings.local) : "";
  useEffect(() => {
    if (engineId !== LOCAL_ENGINE_ID || !url) return;
    void call("local.probe", url).catch(() => undefined);
  }, [engineId, url, model]);
}

function PlannerModelLabel({ engineId, locked }: { engineId: string; locked: boolean }) {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [save] = useAction(async (patch: SettingsPatch) => call("settings.save", patch), t("settings.saveFailed"));

  const isLocal = engineId === LOCAL_ENGINE_ID;
  const engine = engines.find((item) => item.id === engineId);
  const engineLabel = isLocal ? t("local.title") : (engine?.label ?? (engineId || t("orch.title")));
  const chosenModel = isLocal
    ? (settings ? vibyLocalModel(settings.local) : "")
    : (settings && engineId === settings.orchestrator.engine ? settings.orchestrator.model : "");
  const isClaude = Boolean(!isLocal && engine && brainKind(engine) === "claude");
  const modelLabel = chosenModel || (isClaude ? (locked ? "haiku" : t("orch.modelCallDefault")) : t("orch.modelDefault"));
  // With Local mode on, say plainly whether Viby went along to Local or stayed on the cloud.
  const localMode = Boolean(settings?.local.enabled && settings.local.active);
  const routeTag = localMode && !isLocal && (
    <>
      <span className="faint">·</span>
      <span className="faint">{t("rail.cloud")}</span>
    </>
  );
  const routeTip = localMode ? (isLocal ? t("orch.routeLocalTip") : t("orch.routeCloudTip")) : "";
  // A call starting while the popover is open closes it for good, rather than it coming back on hang-up.
  useEffect(() => {
    if (locked) setAnchor(null);
  }, [locked]);

  const effortPick = !isLocal && engine && settings && (
    <PlannerEffortLabel engine={engine} current={settings.orchestrator} onSave={(orchestrator) => void save({ orchestrator })} />
  );

  if (locked) {
    return (
      <>
        <span className="viby-model locked" {...tipProps(routeTip ? `${t("orch.modelLocked")} ${routeTip}` : t("orch.modelLocked"))}>
          <span>{engineLabel}</span>
          <span className="faint">·</span>
          <span className="mono">{modelLabel}</span>
          {routeTag}
        </span>
        {effortPick}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="viby-model"
        aria-expanded={Boolean(anchor)}
        {...tipProps(routeTip ? `${t("orch.plannerTip")} ${routeTip}` : t("orch.plannerTip"))}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <span>{engineLabel}</span>
        <span className="faint">·</span>
        <span className="mono">{modelLabel}</span>
        {routeTag}
        <ChevronDown size={12} className="faint" />
      </button>
      {anchor && settings && (
        <ModelPopover
          anchor={anchor}
          engineId={engineId}
          current={settings.orchestrator}
          local={settings.local}
          engines={engines}
          onSave={(next) => void save(next)}
          onClose={() => setAnchor(null)}
        />
      )}
      {effortPick}
    </>
  );
}

/**
 * The planner's reasoning effort, beside its model: only the levels that CLI takes (none, and no
 * button, for one without an effort option). It is read on every turn, typed or spoken, so it can
 * change during a call too.
 */
function PlannerEffortLabel({ engine, current, onSave }: { engine: Engine; current: OrchestratorSettings; onSave: (next: OrchestratorSettings) => void }) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const levels = effortLevels(engine);
  const mine = engine.id === current.engine;
  const chosen = mine ? (current.effort ?? "") : "";
  if (!levels.length && !chosen) return null;
  // Left empty, it plans at low, or at the level an Antigravity model names itself.
  const shown = chosen || modelOwnEffort(engine, mine ? current.model : "") || "low";
  const pick = (effort: string) => {
    onSave({ ...current, engine: engine.id, model: mine ? current.model : "", effort });
    setAnchor(null);
  };
  return (
    <>
      <button
        type="button"
        className="viby-model"
        aria-expanded={Boolean(anchor)}
        aria-label={t("orch.effort")}
        {...tipProps(t("orch.effortHint"))}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <span className="mono">{t("orch.effortIs", { effort: shown })}</span>
        <ChevronDown size={12} className="faint" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="viby-model-popover">
            <div className="list-label">{t("orch.effort")}</div>
            {["", ...(chosen && !levels.includes(chosen) ? [chosen] : []), ...levels].map((level) => (
              <button
                key={level || "default"}
                type="button"
                role="menuitemradio"
                aria-checked={chosen === level}
                className="menu-item"
                onClick={() => pick(level)}
              >
                <span className="viby-menu-check">{chosen === level && <Check size={13} />}</span>
                <span className={`grow truncate${level ? " mono" : ""}`}>{level ? t("orch.effortIs", { effort: level }) : t("orch.effortLowDefault")}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function ModelPopover({
  anchor,
  engineId,
  current,
  local,
  engines,
  onSave,
  onClose,
}: {
  anchor: HTMLElement;
  engineId: string;
  current: OrchestratorSettings;
  local: Settings["local"];
  engines: Engine[];
  onSave: (next: SettingsPatch) => void;
  onClose: () => void;
}) {
  const t = useT();
  const localReady = Boolean(local.enabled && isLocalConfigured(local));
  const planners = engines
    .filter((item) => canOrchestrate(item))
    .map((item) => (item.id === LOCAL_ENGINE_ID ? { ...item, available: localReady } : item));
  if (local.enabled && !planners.some((item) => item.id === LOCAL_ENGINE_ID)) {
    planners.push({ id: LOCAL_ENGINE_ID, label: t("local.title"), bin: LOCAL_ENGINE_ID, args: [], available: localReady, path: null, local: true });
  }
  const isLocal = engineId === LOCAL_ENGINE_ID;
  const activeEngine = planners.find((item) => item.id === engineId);
  const isClaude = Boolean(!isLocal && activeEngine && brainKind(activeEngine) === "claude");
  const activeModel = isLocal ? local.vibyModel : (engineId === current.engine ? current.model : "");
  // Another model keeps the effort only where it is still valid for it.
  const savePickedModel = (model: string) => {
    if (isLocal) {
      onSave({ local: { vibyModel: model } });
      return;
    }
    onSave({
      orchestrator: {
        ...current,
        engine: engineId,
        model,
        effort: activeEngine ? effortForModel(activeEngine, model, engineId === current.engine ? current.effort : "") : "",
      },
    });
  };
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
  const defaultLabel = isLocal ? t("local.vibySame") : isClaude ? t("orch.modelCallDefault") : t("orch.modelDefault");

  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="viby-model-popover">
        <div className="list-label">{t("orch.planner")}</div>
        {local.enabled && local.active && (
          <div className="faint small" style={{ padding: "0 8px 4px", maxWidth: 260 }}>
            {isLocal ? t("orch.routeLocalTip") : t("orch.routeCloudTip")}
          </div>
        )}
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
                const patch = vibyPlannerPatch(item.id, local, current);
                if (patch.orchestrator || patch.local) onSave(patch);
              }}
            >
              <span className="viby-menu-check">{selected && <Check size={13} />}</span>
              <span className="grow truncate">{item.id === LOCAL_ENGINE_ID ? t("local.title") : item.label}</span>
              {!item.available && <span className="faint small">{item.id === LOCAL_ENGINE_ID ? t("local.notReadyShort") : t("common.notOnPath")}</span>}
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
            savePickedModel("");
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
                savePickedModel(name);
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
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  const cleaned = cleanModel(typed);
                  savePickedModel(cleaned);
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
  // The call bar is hidden in this tab, so a line nobody read aloud (an error above all) shows here.
  const unread = useUnreadSaid(callState);
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
        <LiveVibySprite mood={mood} size={28} active={callState.on} />
        <strong className="viby-live-label">{stateLabel}</strong>
        {mood === "listening" && <CallMeterCells />}
        {(mood === "speaking" || mood === "thinking") && callState.talkOver && !muted && (
          <span className="faint small truncate">{t("call.talkOverHint")}</span>
        )}
        {callState.phase === "listening" && unread && <span className="faint small truncate">{callState.said}</span>}
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
  sees,
  compact,
}: {
  view: View | undefined;
  callState: CallState;
  sees: { text: string; active: boolean };
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
            {!compact && <LiveVibySprite mood={callMood(callState)} size={52} active={callState.on} />}
            <p className="viby-sees">
              {sees.active && <span className="viby-dot working" aria-hidden />}
              <span>{sees.text}</span>
            </p>
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

function TurnImages({ images }: { images: string[] }) {
  const t = useT();
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const key = images.join("|");

  useEffect(() => {
    let canceled = false;
    void Promise.all(
      images.map(async (name) => {
        try {
          return [name, await call("orchestrator.imageData", name)] as const;
        } catch {
          return [name, null] as const;
        }
      }),
    ).then((entries) => {
      if (canceled) return;
      const next: Record<string, string | null> = {};
      for (const [name, url] of entries) next[name] = url;
      setUrls(next);
    });
    return () => {
      canceled = true;
    };
  }, [key]);

  const loaded = images.map((name) => ({ name, url: urls[name] })).filter((item): item is { name: string; url: string } => Boolean(item.url));
  if (!loaded.length) return null;

  return (
    <>
      <div className="orch-turn-images">
        {loaded.map((item) => (
          <button key={item.name} type="button" className="orch-turn-img-btn" onClick={() => setPreview(item.url)}>
            <img src={item.url} alt="" />
          </button>
        ))}
      </div>
      {preview && (
        <Modal title={t("orch.attachImage")} onClose={() => setPreview(null)} wide>
          <img className="orch-lightbox-img" src={preview} alt="" />
        </Modal>
      )}
    </>
  );
}

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
        {turn.images && turn.images.length > 0 && <TurnImages images={turn.images} />}
        {turn.text && <span className="orch-said">{turn.text}</span>}
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
          turn.text && <SpokenText text={turn.confirmed ? t(CONFIRMED_KEY[turn.confirmed]) : turn.text} active={revealLive} callState={callState} />
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
  if (shownTokens < tokens.length) return <span className="orch-said">{visible}</span>;
  return <RichVibyText text={text} />;
}

/** Lightweight safe Markdown formatter for settled Viby prose (code blocks, inline code, bold, lists). */
function RichVibyText({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  const inline = (line: string, keyPrefix: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const tokens = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    tokens.forEach((tok, idx) => {
      if (tok.startsWith("`") && tok.endsWith("`") && tok.length >= 2) {
        out.push(<code key={`${keyPrefix}-c${idx}`}>{tok.slice(1, -1)}</code>);
      } else if (tok.startsWith("**") && tok.endsWith("**") && tok.length >= 4) {
        out.push(<strong key={`${keyPrefix}-b${idx}`}>{tok.slice(2, -2)}</strong>);
      } else if (tok) {
        out.push(tok);
      }
    });
    return out;
  };
  return (
    <div className="orch-said viby-rich-text">
      {parts.map((part, idx) => {
        if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
          const code = part.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
          return (
            <pre key={`pre-${idx}`} className="mono selectable">
              {code}
            </pre>
          );
        }
        const blocks = part.split(/\n{2,}/).filter((b) => b.trim());
        return blocks.map((block, bIdx) => {
          const lines = block.split("\n");
          if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
            return (
              <ul key={`ul-${idx}-${bIdx}`}>
                {lines.map((l, lIdx) => (
                  <li key={`li-${lIdx}`}>{inline(l.replace(/^\s*[-*]\s+/, ""), `${idx}-${bIdx}-${lIdx}`)}</li>
                ))}
              </ul>
            );
          }
          return <p key={`p-${idx}-${bIdx}`}>{inline(block, `${idx}-${bIdx}`)}</p>;
        });
      })}
    </div>
  );
}
