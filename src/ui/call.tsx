import { Phone, PhoneOff, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CallState } from "../shared/api.js";
import { call, on } from "./api.js";
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
// only while something is happening (you are heard, Viby thinks or speaks, a plan waits for "go").

const OFF: CallState = { on: false, phase: "listening", level: 0, heard: "", said: "", waiting: false, spoken: false, error: null, talkOver: false, heardItself: false };
/** How long an answer that wasn't read aloud stays on the bar. */
const SAID_MS = 9000;
/** How long a call that has just begun says what to do, unless something is said sooner. */
const GREET_MS = 8000;
const METER_CELLS = 14;

/** Starts a call, or hangs up: the window's own key for it (shortcuts.ts, "app.call") says so with this. */
export const TOGGLE_CALL_EVENT = "vibeforge:toggle-call";

let state: CallState = OFF;
const listeners = new Set<() => void>();
let wired = false;

function set(next: CallState): void {
  const before = state;
  state = next;
  // The same sounds dictation makes: the mic opened, you were heard, the mic closed.
  if (next.on && !before.on) cue("voiceStart");
  else if (!next.on && before.on) cue("voiceCancel");
  else if (next.on && next.phase === "transcribing" && before.phase !== "transcribing") cue("voiceStop");
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (!wired) {
    wired = true;
    on("call", set);
    void call("call.get").then(set, () => undefined);
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useCall(): CallState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Start a call, or hang up. Without dictation set up, it says what is missing instead. */
function useCallToggle(): () => void {
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
        if (!started.spoken) push("info", t("call.start"), t("call.noVoice"));
      } catch (error) {
        fail(error, t("voice.failed"));
      }
    })();
  }, [t, go, push, fail]);
}

/** In the rail, so a call starts and ends from any view, and shows wherever you are while it is on. */
export function CallRailButton() {
  const t = useT();
  const current = useCall();
  const toggle = useCallToggle();
  // The rail is always there, so the key works from any view.
  useEffect(() => {
    window.addEventListener(TOGGLE_CALL_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_CALL_EVENT, toggle);
  }, [toggle]);
  return (
    <button
      type="button"
      className={`rail-btn call-btn${current.on ? " on" : ""}`}
      aria-pressed={current.on}
      aria-label={current.on ? t("call.hangUp") : t("call.start")}
      {...tipProps(current.on ? t("call.hangUpTip") : t("call.startTip"), { kbd: shortcutKeys("app.call"), side: "right" })}
      onClick={toggle}
    >
      <Phone size={19} strokeWidth={1.9} />
      <span>{current.on ? t("call.railOn") : t("call.rail")}</span>
      {current.on && (
        <i className="call-level" aria-hidden>
          <i style={{ transform: `scaleX(${current.phase === "listening" || current.phase === "hearing" ? current.level : 0})` }} />
        </i>
      )}
    </button>
  );
}

/** The same switch as a button, for Viby's own panel and bar. */
export function CallButton() {
  const t = useT();
  const current = useCall();
  const toggle = useCallToggle();
  return (
    <Button size="sm" variant={current.on ? "primary" : "ghost"} icon={current.on ? PhoneOff : Phone} tip={current.on ? t("call.hangUpTip") : t("call.startTip")} kbd={shortcutKeys("app.call")} onClick={toggle}>
      {current.on ? t("call.hangUp") : t("call.start")}
    </Button>
  );
}

/** What the call is doing, while it is doing something. Quietly listening shows in the rail alone. */
export function CallBar() {
  const t = useT();
  const { push } = useToast();
  const current = useCall();
  const ref = useRef<HTMLDivElement>(null);
  const [fresh, setFresh] = useState(false);

  // An answer nobody read aloud (no voice here, or it was an error) stays up long enough to read.
  useEffect(() => {
    if (!current.said) {
      setFresh(false);
      return;
    }
    setFresh(true);
    const timer = window.setTimeout(() => setFresh(false), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [current.said]);

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

  // What was read aloud has been heard; it doesn't stay up afterwards.
  const readAloud = useRef("");
  if (current.phase === "speaking") readAloud.current = current.said;
  const unread = fresh && current.said !== "" && current.said !== readAloud.current;
  const quiet = current.phase === "listening" && !current.waiting && !unread;
  const greeting = greet && quiet && !current.heard && !current.said;
  const shown = current.on && (!quiet || greeting);
  useBarLayer(ref);
  if (!shown) return null;

  const { phase } = current;
  const lit = Math.round(current.level * METER_CELLS);
  return (
    <div ref={ref} className="listening call" role="status" aria-live="polite">
      {phase === "hearing" && (
        <span className="meter" aria-hidden>
          {Array.from({ length: METER_CELLS }, (_, i) => (
            <i key={i} className={i < lit ? (i >= METER_CELLS - 3 ? "hot" : "on") : undefined} />
          ))}
        </span>
      )}
      {(phase === "transcribing" || phase === "thinking") && <span className="spinner" />}
      {phase === "speaking" && <Volume2 size={15} className="accent-text" />}
      {phase === "listening" && <Phone size={15} className="accent-text" />}
      <span className="listening-text">
        <strong>
          {phase === "hearing" && t("call.hearing")}
          {phase === "transcribing" && t("voice.transcribing")}
          {phase === "thinking" && t("call.thinking")}
          {phase === "speaking" && t("orch.title")}
          {phase === "listening" && (current.waiting ? t("call.waitingGo") : t("orch.title"))}
        </strong>
        {phase === "thinking" && current.heard && <span className="faint truncate"> {current.heard}</span>}
        {(phase === "speaking" || (phase === "listening" && unread)) && current.said && <span className="faint truncate"> {current.said}</span>}
        {greeting && <span className="faint truncate"> {t("call.listeningHint")}</span>}
      </span>
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
      {phase === "speaking" && current.talkOver && <span className="faint small">{t("call.talkOverHint")}</span>}
      <Button size="sm" variant="ghost" icon={PhoneOff} tip={t("call.hangUpTip")} onClick={() => void call("call.stop")}>
        {t("call.hangUp")}
      </Button>
    </div>
  );
}
