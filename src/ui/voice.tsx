import { Mic, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { vocabularyPrompt } from "../shared/dictation.js";
import type { TalkEvent, VoiceState } from "../shared/api.js";
import { call, on, useAgents, useEngines, useQuery, useRoutines, useSettings } from "./api.js";
import { Button } from "./components/ui.js";
import { boxOf, type Box } from "./floating.js";
import { t as translate, useT, type Key, type Vars } from "./i18n/index.js";
import { Rich } from "./i18n/Rich.js";
import { useLayer, useNav, useToast } from "./state.js";
import { micRelease } from "./mic.js";
import { cue } from "./sounds.js";

// Hold Ctrl+Shift+Space, or hold the mic, and let go: the words land in the box or terminal that
// has focus and wait there. A quick click on the mic keeps it listening instead, until the mic (or
// Stop) is clicked again, for dictating without holding anything down. Esc drops the recording. Super+Alt+V (vibeforge --voice start/stop)
// does the same for one agent — the one chosen in Settings, or the one you last dictated to —
// and leaves the words in that agent's chat. Pressing Enter on dictated words is what asks for
// the answer to be read aloud. Holding the key again cuts that off.

export const DICTATE_KEYS = "Ctrl+Shift+Space";
/** How long to wait for a message to reach a terminal before giving up on hearing its answer. */
const PTY_WAIT_MS = 8000;

export interface DictationTarget {
  /** Shown while listening: where the words will go. */
  label: string;
  /** The box or pane; a target that is no longer on screen is skipped. */
  element: () => HTMLElement | null;
  /** Put the words in for review. Dictation never sends them. */
  insert: (text: string) => void;
  /** The box sends on its own Enter and says so. A terminal's next Enter is the send. */
  ownsSend?: boolean;
  /** The agent this box belongs to, so the desktop key can come back to them. */
  agentId?: () => string | null;
  /** The terminal the words reach, once there is one, to hear its answer. */
  ptyId?: () => string | null;
  /** Names this target expects to hear, such as the files in its workspace. */
  words?: () => string[] | Promise<string[]>;
}

// ------------------------------------------------------------------ targets

let lastTarget: DictationTarget | null = null;
/** The agent a dictation last landed on. The desktop key uses this when Settings names nobody. */
let lastSpoken: string | null = null;

function onScreen(target: DictationTarget | null): target is DictationTarget {
  const element = target?.element();
  return Boolean(element && element.isConnected && element.getClientRects().length > 0);
}

export function setDictationTarget(target: DictationTarget): void {
  lastTarget = target;
}

/**
 * Makes a box or pane a place dictation can land: it becomes the target when anything inside it
 * takes focus. Returns the handler to put on its outer element, and the target itself.
 */
export function useDictationTarget(make: () => DictationTarget): { onFocusCapture: () => void; target: DictationTarget } {
  const makeRef = useRef(make);
  makeRef.current = make;
  // One stable object whose members always reach the latest closures.
  const target = useRef<DictationTarget>({
    get label() {
      return makeRef.current().label;
    },
    element: () => makeRef.current().element(),
    insert: (text) => makeRef.current().insert(text),
    get ownsSend() {
      return Boolean(makeRef.current().ownsSend);
    },
    agentId: () => makeRef.current().agentId?.() ?? null,
    ptyId: () => makeRef.current().ptyId?.() ?? null,
    words: () => makeRef.current().words?.() ?? [],
  }).current;
  useEffect(
    () => () => {
      if (lastTarget === target) lastTarget = null;
    },
    [target],
  );
  return { onFocusCapture: () => setDictationTarget(target), target };
}

// ------------------------------------------------------------------ drafts
// Words for an agent's chat that isn't on screen yet (the desktop key): its composer takes them
// when it appears.

const drafts = new Map<string, string>();
const draftListeners = new Set<() => void>();

export function setDraft(chatId: string, text: string): void {
  drafts.set(chatId, text);
  for (const notify of draftListeners) notify();
}

/** Calls `take` with any words waiting for `chatId`, now and whenever some arrive. */
export function useDraft(chatId: string | null | undefined, take: (text: string) => void): void {
  const takeRef = useRef(take);
  takeRef.current = take;
  useEffect(() => {
    if (!chatId) return;
    const check = () => {
      const text = drafts.get(chatId);
      if (text === undefined) return;
      drafts.delete(chatId);
      takeRef.current(text);
    };
    check();
    draftListeners.add(check);
    return () => {
      draftListeners.delete(check);
    };
  }, [chatId]);
}

// ------------------------------------------------------------------ a terminal's Enter
// Pasting into a terminal does not send. The next Enter does, and that is when the answer is read.

const pendingEnter = new Map<string, string>();

function armTerminal(target: DictationTarget, words: string): void {
  if (target.ownsSend) return;
  const ptyId = target.ptyId?.() ?? null;
  if (ptyId && words.trim()) pendingEnter.set(ptyId, words);
}

/** What a terminal just sent to its program. Enter after dictated words asks to hear the answer. */
export function notePtyInput(ptyId: string, data: string): void {
  if (!pendingEnter.has(ptyId)) return;
  // Ctrl+U clears the line, Ctrl+C and Esc give up on it.
  if (data.includes("\x15") || data.includes("\x03") || data.includes("\x1b")) {
    pendingEnter.delete(ptyId);
    return;
  }
  if (!/[\r\n]/.test(data)) return;
  const words = pendingEnter.get(ptyId) ?? "";
  pendingEnter.delete(ptyId);
  if (words.trim()) controller?.expectPty(ptyId, words);
}

// ------------------------------------------------------------------ state from the main process

let state: VoiceState = { phase: "idle", level: 0, seconds: 0, speech: null };
const stateListeners = new Set<() => void>();
let talk: TalkEvent | null = null;
const talkListeners = new Set<() => void>();
let wired = false;

function wire(): void {
  if (wired || !window.vibeforge) return;
  wired = true;
  on("voice", (next) => {
    state = next;
    for (const notify of stateListeners) notify();
  });
  on("voice-talk", (event) => {
    talk = event.stage === "done" ? null : event;
    for (const notify of talkListeners) notify();
  });
}

function subscribe(set: Set<() => void>) {
  return (listener: () => void) => {
    wire();
    set.add(listener);
    return () => set.delete(listener);
  };
}

const subscribeState = subscribe(stateListeners);
const subscribeTalk = subscribe(talkListeners);

export function useVoiceState(): VoiceState {
  return useSyncExternalStore(subscribeState, () => state);
}

function useTalk(): TalkEvent | null {
  return useSyncExternalStore(subscribeTalk, () => talk);
}

export const useVoiceStatus = () => useQuery("voice", ["voice", "settings", "engines"], () => call("voice.status"));

// ------------------------------------------------------------------ the session

interface Session {
  target: DictationTarget;
  /** The focused box, or one agent's chat (the desktop key). */
  place: "focus" | "agent";
  /** Recording has stopped and whisper is working on it. */
  finishing: boolean;
  /** Started with a click on the mic, so it listens until clicked again rather than until let go. */
  latched?: boolean;
}

let session: Session | null = null;
/** Bumped when a recording is dropped, so a finish already in flight inserts nothing. */
let generation = 0;
let starting: Promise<unknown> = Promise.resolve();
const sessionListeners = new Set<() => void>();

function notifySession(): void {
  for (const notify of sessionListeners) notify();
}

function setSession(next: Session | null): void {
  session = next;
  notifySession();
}

const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};

function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, () => session);
}

interface Controller {
  begin: (target: DictationTarget) => void;
  /** The recording just begun keeps going until it is stopped. */
  latch: () => void;
  finish: () => void;
  cancel: () => void;
  expectFromTarget: (target: DictationTarget, words: string) => void;
  expectPty: (ptyId: string, words: string) => void;
  talkBack: () => boolean;
}

let controller: Controller | null = null;

/** A composer sent words that were dictated into it: listen for the answer. */
export function expectAnswer(target: DictationTarget, words: string): void {
  controller?.expectFromTarget(target, words);
}

/** Dictated words were pasted into a terminal from elsewhere (the desktop key): its next Enter sends them. */
export function expectOnEnter(target: DictationTarget, words: string): void {
  if (controller?.talkBack()) armTerminal(target, words);
}

// ------------------------------------------------------------------ small helpers

function focused(): boolean {
  return document.hasFocus();
}

async function waitForPty(target: DictationTarget, ms = PTY_WAIT_MS): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    const asking = onScreen(target) ? target : onScreen(lastTarget) ? lastTarget : target;
    const ptyId = asking.ptyId?.() ?? null;
    if (ptyId || Date.now() - started > ms) return ptyId;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const EMPTY_KEYS: Record<"short" | "silent" | "nothing", Key> = {
  short: "voice.empty.short",
  silent: "voice.empty.silent",
  nothing: "voice.empty.nothing",
};

const say = (key: Key, vars?: Vars) => translate(key, vars);

// ------------------------------------------------------------------ the layer

/**
 * Owns the shortcut, talks to the main process, and draws the listening bar. Mounted once, in
 * the shell.
 */
export function VoiceLayer() {
  const { push, fail } = useToast();
  const { go } = useNav();
  const status = useVoiceStatus();
  const settings = useSettings().data;
  const agents = useAgents().data;
  const engines = useEngines().data;
  const routines = useRoutines().data;
  const current = useSession();
  const voice = useVoiceState();
  const spoken = useTalk();
  const busy = useRef(false);

  const refs = useRef({ status: status.data, settings, agents, engines, routines });
  refs.current = { status: status.data, settings, agents, engines, routines };

  /** A toast in the window, or a desktop notification while it is in the background. */
  const inform = useCallback(
    (kind: "info" | "success" | "error", title: string, body?: string) => {
      if (focused()) push(kind, title, body);
      else if ("Notification" in window) new Notification(title, { body, silent: true });
    },
    [push],
  );

  const talkBackOn = () => Boolean(refs.current.settings?.voice.talkBack ?? true);

  const ensureReady = useCallback((): boolean => {
    if (refs.current.status && !refs.current.status.ready) {
      inform("info", say("voice.notReady"), say("voice.notReadyBody"));
      if (focused()) {
        go({ view: "settings" });
        setTimeout(() => document.getElementById("settings-voice")?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
      }
      return false;
    }
    return true;
  }, [go, inform]);

  const listen = useCallback(
    (into: DictationTarget, place: Session["place"]) => {
      const gen = generation;
      busy.current = true;
      setSession({ target: into, place, finishing: false });
      cue("voiceStart");
      starting = call("voice.start").then(
        () => {
          busy.current = false;
          // Dropped while the microphone was still opening.
          if (generation !== gen) void call("voice.cancel").catch(() => undefined);
        },
        (error: unknown) => {
          busy.current = false;
          if (generation === gen) {
            generation += 1;
            setSession(null);
            if (focused()) fail(error, say("voice.failed"));
            else inform("error", say("voice.failed"), error instanceof Error ? error.message : String(error));
          }
          throw error;
        },
      );
    },
    [fail, inform],
  );

  const expectPty = useCallback((ptyId: string, words: string) => {
    if (!talkBackOn() || !words.trim()) return;
    void call("voice.expect", ptyId, words).catch(() => undefined);
  }, []);

  const expectFromTarget = useCallback(
    (target: DictationTarget, words: string) => {
      if (!talkBackOn() || !words.trim()) return;
      void (async () => {
        const ptyId = (await waitForPty(target)) ?? null;
        if (ptyId) expectPty(ptyId, words);
      })();
    },
    [expectPty],
  );

  /** The desktop key's agent: the one in Settings, or the one last dictated to. */
  const resolveAgent = useCallback((): { id: string; name: string } | null => {
    const list = refs.current.agents;
    const chosen = refs.current.settings?.voice.agent ?? "";
    // While the agent list is still loading, a saved id is trusted; once it has loaded, a deleted agent is skipped.
    const known = (agentId: string) => !list || list.some((agent) => agent.id === agentId);
    const id = (chosen && known(chosen) ? chosen : null) ?? (lastSpoken && known(lastSpoken) ? lastSpoken : null);
    if (!id) return null;
    const agent = list?.find((item) => item.id === id);
    return { id, name: agent?.name ?? id };
  }, []);

  /** Leave the words in the agent's latest chat, without sending them. */
  const deliver = useCallback(
    async (agentId: string, name: string, text: string) => {
      const chats = await call("chats.list", { agentId });
      const chat =
        chats.find((item) => item.live) ??
        [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
        (await call("chats.create", { agentId }));
      lastSpoken = agentId;
      setDraft(chat.id, text);
      go({ view: "agents", agentId, tab: "chats", chatId: chat.id });
      const wasFocused = focused();
      void call("app.focus").catch(() => undefined);
      if (!wasFocused) inform("info", say("voice.toAgentReview", { name }), text);
    },
    [go, inform],
  );

  const begin = useCallback(
    (into: DictationTarget, place: Session["place"]) => {
      if (session || busy.current) return;
      // A new turn cuts off an answer that is still being read, and one still on its way.
      void call("voice.silence").catch(() => undefined);
      void call("voice.forget").catch(() => undefined);
      listen(into, place);
    },
    [listen],
  );

  const beginFocused = useCallback(() => {
    if (session || busy.current) return;
    if (!ensureReady()) return;
    const into = onScreen(lastTarget) ? lastTarget : null;
    if (!into) {
      inform("info", say("voice.noTarget"), say("voice.noTargetBody"));
      return;
    }
    begin(into, "focus");
  }, [begin, ensureReady, inform]);

  const beginAgent = useCallback(() => {
    if (session || busy.current) return;
    if (!ensureReady()) return;
    const agent = resolveAgent();
    if (!agent) {
      inform("info", say("voice.noAgent"), say("voice.noAgentBody"));
      if (focused()) {
        go({ view: "settings" });
        setTimeout(() => document.getElementById("settings-voice")?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
      }
      return;
    }
    begin(
      {
        label: agent.name,
        // Always "on screen": the words are delivered to the chat, not to whatever has focus.
        element: () => document.body,
        agentId: () => agent.id,
        insert: (text) => {
          void deliver(agent.id, agent.name, text).catch((error: unknown) => fail(error, say("voice.failed")));
        },
      },
      "agent",
    );
  }, [begin, deliver, ensureReady, fail, go, inform, resolveAgent]);

  const finish = useCallback(() => {
    const ending = session;
    if (!ending || ending.finishing) return;
    const gen = generation;
    setSession({ ...ending, finishing: true });
    cue("voiceStop");
    void (async () => {
      try {
        await starting;
      } catch {
        return;
      }
      if (generation !== gen) return;
      const { agents: agentList, engines: engineList, routines: routineList } = refs.current;
      let targetWords: string[] = [];
      try {
        targetWords = await (ending.target.words?.() ?? []);
      } catch {
        /* the prompt is only a hint */
      }
      const prompt = vocabularyPrompt([
        "VibeForge",
        ...(agentList ?? []).map((agent) => agent.name),
        ...(routineList ?? []).map((routine) => routine.name),
        ...(engineList ?? []).map((engine) => engine.label),
        ...targetWords,
      ]);
      try {
        const result = await call("voice.stop", prompt);
        if (generation !== gen) return;
        setSession(null);
        if (result.empty) {
          cue("voiceCancel");
          inform("info", say(EMPTY_KEYS[result.empty]));
          return;
        }
        // The box can be replaced while whisper works. With nothing left to put the words in,
        // keep them on the clipboard. The desktop key always has its agent.
        let target = ending.target;
        if (ending.place === "focus" && !onScreen(target)) {
          if (!onScreen(lastTarget)) {
            await call("app.copyText", result.text);
            inform("info", say("voice.targetGone"), result.text);
            return;
          }
          target = lastTarget;
        }
        target.insert(result.text);
        if (ending.place === "focus") {
          const agentId = target.agentId?.() ?? null;
          if (agentId) lastSpoken = agentId;
          if (talkBackOn()) armTerminal(target, result.text);
          if (!focused()) inform("info", say("voice.pastedInto", { target: target.label }), result.text);
        }
      } catch (error) {
        setSession(null);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Nothing is being recorded")) return;
        if (focused()) fail(error, say("voice.failed"));
        else inform("error", say("voice.failed"), message);
      } finally {
        if (generation === gen) setSession(null);
      }
    })();
  }, [fail, inform]);

  const cancel = useCallback(() => {
    if (!session || session.finishing) return;
    generation += 1;
    setSession(null);
    cue("voiceCancel");
    void call("voice.cancel").catch(() => undefined);
  }, []);

  useEffect(() => {
    controller = {
      begin: (target) => {
        if (!ensureReady()) return;
        begin(target, "focus");
      },
      latch: () => {
        if (session && !session.finishing && !session.latched) setSession({ ...session, latched: true });
      },
      finish,
      cancel,
      expectFromTarget,
      expectPty,
      talkBack: talkBackOn,
    };
    return () => {
      controller = null;
    };
  }, [begin, finish, cancel, ensureReady, expectFromTarget, expectPty]);

  // A keybinding outside the window: `vibeforge --voice start|stop|cancel`.
  useEffect(
    () =>
      on("voice-command", ({ action }) => {
        if (action === "start") beginAgent();
        else if (action === "stop") finish();
        else cancel();
      }),
    [beginAgent, finish, cancel],
  );

  // Hold to talk, Esc to drop it. Caught before terminals see the keys.
  // X11 autorepeat delivers a Space keyup and keydown about every 50 ms while the key is held.
  // Treating that keyup as "let go" was restarting the microphone and throwing each fragment
  // away as too short. A keyup only counts once Space stays up past the repeat gap.
  useEffect(() => {
    let holding = false;
    let releaseTimer = 0;
    const clearRelease = () => {
      if (!releaseTimer) return;
      window.clearTimeout(releaseTimer);
      releaseTimer = 0;
    };
    const isDictate = (event: KeyboardEvent) => event.code === "Space" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ((session && !session.finishing) || (!session && talk))) {
        event.preventDefault();
        event.stopPropagation();
        holding = false;
        clearRelease();
        if (session && !session.finishing) cancel();
        else {
          void call("voice.silence").catch(() => undefined);
          void call("voice.forget").catch(() => undefined);
        }
        return;
      }
      if (!isDictate(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (releaseTimer) {
        clearRelease();
        holding = true;
        return;
      }
      if (event.repeat || session) return;
      holding = true;
      beginFocused();
    };
    const up = (event: KeyboardEvent) => {
      // A modifier coming up is not the end of the hold. Only Space is.
      if (!holding || event.code !== "Space") return;
      event.preventDefault();
      event.stopPropagation();
      holding = false;
      clearRelease();
      releaseTimer = window.setTimeout(() => {
        releaseTimer = 0;
        finish();
      }, 80);
    };
    // Alt-tab while the key is down must not leave the microphone open.
    const blur = () => {
      clearRelease();
      if (!session || session.finishing || session.place === "agent") return;
      holding = false;
      finish();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      clearRelease();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [beginFocused, finish, cancel]);

  if (current) {
    return <ListeningBar label={current.target.label} voice={voice} finishing={current.finishing} latched={Boolean(current.latched)} onStop={finish} onCancel={cancel} />;
  }
  if (spoken) {
    return (
      <AnswerBar
        who={spoken.who}
        text={spoken.stage === "speaking" ? spoken.text : ""}
        waiting={spoken.stage === "waiting"}
        onStop={() => {
          void call("voice.silence").catch(() => undefined);
          void call("voice.forget").catch(() => undefined);
        }}
      />
    );
  }
  return null;
}

// ------------------------------------------------------------------ the bars

const METER_CELLS = 14;

/** Registers the bar as a floating layer so the browser dock steps aside while it covers it. */
function useBarLayer(ref: React.RefObject<HTMLDivElement | null>): void {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const next = boxOf(node.getBoundingClientRect());
    setBox((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom ? prev : next));
  });
  useLayer(box);
}

function ListeningBar({
  label,
  voice,
  finishing,
  latched,
  onStop,
  onCancel,
}: {
  label: string;
  voice: VoiceState;
  finishing: boolean;
  latched: boolean;
  onStop: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useBarLayer(ref);
  const transcribing = finishing || voice.phase === "transcribing";
  const lit = Math.round(voice.level * METER_CELLS);
  const seconds = Math.floor(voice.seconds);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div ref={ref} className={`listening${transcribing ? " transcribing" : ""}`} role="status" aria-live="polite">
      {transcribing ? (
        <span className="spinner" />
      ) : (
        <span className="meter" aria-hidden>
          {Array.from({ length: METER_CELLS }, (_, i) => (
            <i key={i} className={i < lit ? (i >= METER_CELLS - 3 ? "hot" : "on") : undefined} />
          ))}
        </span>
      )}
      <span className="listening-text">
        <strong>{transcribing ? t("voice.transcribing") : t("voice.listening")}</strong>
        {label && <span className="faint truncate"> → {label}</span>}
      </span>
      <span className="listening-clock mono">{clock}</span>
      {!transcribing && (
        <span className="listening-keys faint">
          <Rich text={t(latched ? "voice.clickToStop" : "voice.releaseToStop")} />
        </span>
      )}
      {!transcribing && (
        <>
          <Button size="sm" variant="primary" icon={Square} onClick={onStop}>
            {t("voice.stop")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} tip={t("voice.cancelTip")}>
            {t("common.cancel")}
          </Button>
        </>
      )}
    </div>
  );
}

/** Waiting for an agent, or hearing its answer. */
function AnswerBar({ who, text, waiting, onStop }: { who: string; text: string; waiting: boolean; onStop: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useBarLayer(ref);
  return (
    <div ref={ref} className="listening answer" role="status" aria-live="polite">
      {text ? <Volume2 size={15} className="accent-text" /> : <span className="spinner" />}
      <span className="listening-text">
        <strong>{text ? who : waiting ? t("voice.waitingFor", { name: who }) : t("voice.speaking")}</strong>
        {text && <span className="faint truncate"> {text}</span>}
      </span>
      <span className="listening-keys faint">
        <Rich text={t("voice.cutIn", { keys: DICTATE_KEYS })} />
      </span>
      <Button size="sm" variant="ghost" icon={Square} onClick={onStop}>
        {waiting ? t("common.cancel") : t("voice.silence")}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ the mic button

/**
 * A mic for dictating into `target`. Click it to start and click again to stop, or hold it and
 * let go; the keys (Ctrl+Shift+Space) are held the same way.
 */
export function MicButton({ target, disabled, size, hint }: { target: DictationTarget; disabled?: boolean; size?: "sm"; hint?: string }) {
  const t = useT();
  const current = useSession();
  const ready = useVoiceStatus().data?.ready ?? false;
  const mine = current?.target === target;
  const transcribing = mine && current.finishing;
  const press = useRef<{ at: number; started: boolean } | null>(null);
  const toggle = () => {
    if (mine) controller?.finish();
    else {
      controller?.begin(target);
      controller?.latch();
    }
  };
  return (
    <Button
      variant="ghost"
      size={size}
      icon={mine ? Square : Mic}
      className={mine && !transcribing ? "mic live" : "mic"}
      pressed={mine && !transcribing}
      busy={transcribing}
      disabled={disabled || (current !== null && !mine)}
      kbd={DICTATE_KEYS}
      tip={mine ? t("voice.stopTip") : ready ? (hint ? `${hint}. ${t("voice.micTip")}` : t("voice.micTip")) : t("voice.micSetupTip")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        // A press while this mic is listening is the click that stops it, on release.
        press.current = { at: Date.now(), started: !mine };
        if (!mine) controller?.begin(target);
      }}
      onPointerUp={(event) => {
        const held = press.current;
        if (event.button !== 0 || !held) return;
        press.current = null;
        if (micRelease(held, Date.now()) === "latch") controller?.latch();
        else controller?.finish();
      }}
      onPointerCancel={() => {
        if (!press.current) return;
        press.current = null;
        controller?.finish();
      }}
      // Enter or Space on the focused button: a click, with no hold to measure.
      onClick={(event) => {
        if (event.detail === 0) toggle();
      }}
    />
  );
}
