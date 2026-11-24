import { AudioLines, Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CallState } from "../shared/api.js";
import type { VibyMood } from "../shared/pixel.js";
import { call, on } from "./api.js";
import { VibySprite } from "./components/Pixel.js";
import { tipProps } from "./components/Tooltip.js";
import { Button } from "./components/ui.js";
import { useT } from "./i18n/index.js";
import { cue } from "./sounds.js";
import { useNav, useToast } from "./state.js";
import { shortcutKeys } from "./shortcuts.js";
import { useBarLayer } from "./voice.js";

// A call with Viby (electron/call.ts): the microphone stays open and what is said goes to Viby
// without waiting for Enter, so the call is started on purpose and shows for as long as it is on.
// The rail's button starts and ends it from any view and is lit while it listens; a bar comes up
// outside Viby's own tab while something is happening.

const OFF: CallState = { on: false, phase: "listening", level: 0, heard: "", said: "", waiting: false, spoken: false, error: null, talkOver: false, heardItself: false, muted: false };
/** How long an answer that wasn't read aloud stays on the bar. */
const SAID_MS = 9000;
/** How long a call that has just begun says what to do, unless something is said sooner. */
const GREET_MS = 8000;
export const METER_CELLS = 14;

/** Collapse the call's five mechanical phases into Viby's clear live mood. */
export function callMood(current: CallState): VibyMood {
  if (!current.on) return "idle";
  if (current.phase === "speaking") return "speaking";
  if (current.phase === "thinking" || current.phase === "transcribing") return "thinking";
  if (current.muted) return "muted";
  return "listening";
}

/** Starts a call, or hangs up: the window's own key for it (shortcuts.ts, "app.call") says so with this. */
export const TOGGLE_CALL_EVENT = "vibeforge:toggle-call";

let state: CallState = OFF;
let currentLevel = 0;
const listeners = new Set<() => void>();
const levelListeners = new Set<() => void>();
let wired = false;

function sameCallWithoutLevel(a: CallState, b: CallState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "level") continue;
    if (!Object.is((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function wire(): void {
  if (wired) return;
  wired = true;
  on("call", set);
  void call("call.get").then(set, () => undefined);
}

function set(next: CallState): void {
  const before = state;
  const normalized = next.level === 0 ? next : { ...next, level: 0 };
  const stateChanged = !sameCallWithoutLevel(before, normalized);
  const levelChanged = next.level !== currentLevel;
  currentLevel = next.level;
  if (stateChanged) state = normalized;
  // The same sounds dictation makes: the mic opened, you were heard, the mic closed.
  if (next.on && !before.on) cue("voiceStart");
  else if (!next.on && before.on) cue("voiceCancel");
  else if (next.on && next.phase === "transcribing" && before.phase !== "transcribing") cue("voiceStop");
  if (stateChanged) for (const listener of listeners) listener();
  if (levelChanged) for (const listener of levelListeners) listener();
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function subscribeLevel(listener: () => void): () => void {
  wire();
  levelListeners.add(listener);
  return () => void levelListeners.delete(listener);
}

export function useCall(): CallState {
  return useSyncExternalStore(subscribe, () => state);
}

/** High-frequency 20Hz mic level isolated from useCall() so non-meter UI does not re-render each tick. */
export function useCallLevel(): number {
  return useSyncExternalStore(subscribeLevel, () => currentLevel);
}

/** Viby sprite that only subscribes to live audio levels when on an active call. */
export function LiveVibySprite({ mood, size, active, label, className }: { mood: VibyMood; size: number; active: boolean; label?: string; className?: string }) {
  return active ? <ActiveVibySprite mood={mood} size={size} label={label} className={className} /> : <VibySprite mood={mood} size={size} level={0} label={label} className={className} />;
}

function ActiveVibySprite({ mood, size, label, className }: { mood: VibyMood; size: number; label?: string; className?: string }) {
  const level = useCallLevel();
  return <VibySprite mood={mood} size={size} level={level} label={label} className={className} />;
}

function RailCallMeter({ phase }: { phase: CallState["phase"] }) {
  const level = useCallLevel();
  return (
    <i className="call-level" aria-hidden>
      <i style={{ transform: `scaleX(${phase === "listening" || phase === "hearing" ? level : 0})` }} />
    </i>
  );
}

export function CallMeterCells() {
  const level = useCallLevel();
  const lit = Math.round(level * METER_CELLS);
  return (
    <span className="meter" aria-hidden>
      {Array.from({ length: METER_CELLS }, (_, i) => (
        <i key={i} className={i < lit ? (i >= METER_CELLS - 3 ? "hot" : "on") : undefined} />
      ))}
    </span>
  );
}

/** Start a call, or hang up. Without dictation set up, it says what is missing instead. */
export function useCallToggle(): () => void {
  const t = useT();
  const { go } = useNav();
  const { push, fail } = useToast();
  return useCallback(() => {
    void (async () => {
      try {
        if (state.on) {
          await call("call.stop");
          return;
        }
        if (!(await call("voice.status")).ready) {
          push("info", t("voice.notReady"), t("voice.notReadyBody"));
          go({ view: "settings", section: "voice" });
          return;
        }
        const started = await call("call.start");
        if (!started.spoken && (await call("settings.get")).voice.talkBack) push("info", t("call.start"), t("call.noVoice"));
      } catch (error) {
        fail(error, t("voice.failed"));
      }
    })();
  }, [t, go, push, fail]);
}

/**
 * Viby's one door in the rail, from any view. It opens the quick bar, where you type what to start or
 * press Call; in Viby's own tab (where the bar has nothing to add) it starts the call; on a call it
 * hangs up and shows how loud you are.
 */
export function VibyRailButton({ inVibyTab, onOpen }: { inVibyTab: boolean; onOpen: () => void }) {
  const t = useT();
  const current = useCall();
  const toggle = useCallToggle();
  // The rail is always there, so the call key works from any view.
  useEffect(() => {
    window.addEventListener(TOGGLE_CALL_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_CALL_EVENT, toggle);
  }, [toggle]);
  const opens = !current.on && !inVibyTab;
  const tip = current.on ? t("call.hangUpTip") : inVibyTab ? t("call.startTip") : t("viby.railTip");
  const kbd = shortcutKeys(opens ? "app.orchestrator" : "app.call");
  return (
    <button
      type="button"
      className={`rail-btn viby-btn${current.on ? " on" : ""}`}
      aria-pressed={current.on}
      aria-label={current.on ? t("call.hangUp") : inVibyTab ? t("call.start") : t("viby.railTip")}
      {...tipProps(tip, { kbd, side: "right" })}
      onClick={opens ? onOpen : toggle}
    >
      <LiveVibySprite mood={callMood(current)} size={19} active={current.on} />
      <span>{current.on ? t("call.railOn") : t("viby.rail")}</span>
      {current.on && <RailCallMeter phase={current.phase} />}
    </button>
  );
}

/** The same switch as a button, for Viby's own panel and bar. */
export function CallButton() {
  const t = useT();
  const current = useCall();
  const toggle = useCallToggle();
  return (
    <Button size="sm" variant={current.on ? "primary" : "ghost"} icon={current.on ? PhoneOff : AudioLines} tip={current.on ? t("call.hangUpTip") : t("call.startTip")} kbd={shortcutKeys("app.call")} onClick={toggle}>
      {current.on ? t("call.hangUp") : t("call.start")}
    </Button>
  );
}

/**
 * Whether the call's last line (`said`) was never read aloud and is still new: no voice here, or it
 * was an error (whisper failing, say). Such a line stays up long enough to read; one read aloud has
 * been heard and doesn't.
 */
export function useUnreadSaid(current: CallState): boolean {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!current.said) {
      setFresh(false);
      return;
    }
    setFresh(true);
    const timer = window.setTimeout(() => setFresh(false), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [current.said]);
  const readAloud = useRef("");
  if (current.phase === "speaking") readAloud.current = current.said;
  return fresh && current.said !== "" && current.said !== readAloud.current;
}

/** What the call is doing outside Viby's own panel. Inside Viby, the panel itself is the call. */
export function CallBar() {
  const t = useT();
  const { route, go } = useNav();
  const { push } = useToast();
  const current = useCall();
  const ref = useRef<HTMLDivElement>(null);
  const unread = useUnreadSaid(current);

  // A call that has just begun says what to do, until something is said or a few seconds pass:
  // a lit button in the rail alone doesn't tell someone new that they can simply talk.
  const [greet, setGreet] = useState(false);
  useEffect(() => {
    if (!current.on) {
      setGreet(false);
      return;
    }
    setGreet(true);
    const timer = window.setTimeout(() => setGreet(false), GREET_MS);
    return () => window.clearTimeout(timer);
  }, [current.on]);

  // The microphone closed by itself: say so, as the call is over without a Hang up. Only as it
  // happens: a window opened later isn't told about a call that ended before it.
  const wasOn = useRef(current.on);
  useEffect(() => {
    if (wasOn.current && !current.on && current.error) push("error", t("call.ended"), current.error);
    wasOn.current = current.on;
  }, [current.on, current.error, push, t]);

  // Viby took its own voice for the person's: said once, as it happens.
  const heardItself = useRef(current.heardItself);
  useEffect(() => {
    if (current.heardItself && !heardItself.current) push("info", t("call.heardItself"), t("call.heardItselfHint"));
    heardItself.current = current.heardItself;
  }, [current.heardItself, push, t]);

  const muted = Boolean(current.muted);
  const quiet = current.phase === "listening" && !current.waiting && !unread && !muted;
  const greeting = greet && quiet && !current.heard && !current.said;
  const shown = route.view !== "orchestrator" && current.on && (!quiet || greeting);
  useBarLayer(ref);
  if (!shown) return null;

  const mood = callMood(current);
  const { phase } = current;
  const stateLabel =
    mood === "speaking"
      ? t("call.state.speaking")
      : mood === "thinking"
        ? t("call.state.thinking")
        : muted
          ? t("call.muted")
          : current.waiting
            ? t("call.waitingGo")
            : t("call.state.listening");

  return (
    <div ref={ref} className="listening call" role="status" aria-live="polite">
      <LiveVibySprite mood={mood} size={20} active={current.on} />
      {phase === "hearing" && !muted && <CallMeterCells />}
      <button type="button" className="listening-text listening-jump" onClick={() => go({ view: "orchestrator" })}>
        <strong>{stateLabel}</strong>
        {phase === "hearing" && current.liveHeard && <span className="faint truncate"> {current.liveHeard}</span>}
        {(phase === "thinking" || phase === "transcribing") && (current.liveHeard || current.heard) && <span className="faint truncate"> {current.liveHeard || current.heard}</span>}
        {(phase === "speaking" || (phase === "listening" && unread)) && current.said && <span className="faint truncate"> {current.said}</span>}
        {greeting && <span className="faint truncate"> {t("call.listeningHint")}</span>}
      </button>
      {phase === "thinking" && (
        <Button size="sm" variant="ghost" icon={Square} onClick={() => void call("orchestrator.stopThinking")}>
          {t("orch.stop")}
        </Button>
      )}
      {phase === "speaking" && (
        <Button size="sm" variant="ghost" icon={Square} onClick={() => void call("voice.silence")}>
          {t("voice.silence")}
        </Button>
      )}
      {(phase === "speaking" || phase === "thinking") && current.talkOver && !muted && <span className="faint small">{t("call.talkOverHint")}</span>}
      <Button size="sm" variant={muted ? "primary" : "ghost"} icon={muted ? Mic : MicOff} onClick={() => void call("call.mute")}>
        {muted ? t("call.unmute") : t("call.mute")}
      </Button>
      <Button size="sm" variant="ghost" icon={PhoneOff} tip={t("call.hangUpTip")} onClick={() => void call("call.stop")}>
        {t("call.hangUp")}
      </Button>
    </div>
  );
}
