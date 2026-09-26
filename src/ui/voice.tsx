import { MessagesSquare, Mic, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseUtterance, type Command } from "../shared/commands.js";
import { vocabularyPrompt } from "../shared/dictation.js";
import type { TalkEvent, VoiceState } from "../shared/api.js";
import { call, on, useAgents, useEngines, useQuery, useRoutines, useSettings } from "./api.js";
import { Button } from "./components/ui.js";
import { boxOf, type Box } from "./floating.js";
import { t as translate, useT, type Key, type Vars } from "./i18n/index.js";
import { Rich } from "./i18n/Rich.js";
import { useLayer, useNav, useToast, type Route } from "./state.js";

// Voice in the window. Hold Ctrl+Shift+Space (or tap it to keep listening), speak, let go: the
// words land in the box or terminal that last had focus, the "target", and wait there to be read
// unless Settings says to send them. "Atlas, …" goes to the agent named Atlas instead, and
// "Forge, …" is a command (see src/shared/commands.ts). Ctrl+Alt+Space starts a conversation:
// hands-free turns of listening, sending, and hearing the answer read aloud. A keybinding can do
// all of this while the window is in the background, through `vibeforge --voice …`.

export const DICTATE_KEYS = "Ctrl+Shift+Space";
export const CONVERSE_KEYS = "Ctrl+Alt+Space";
/** A press shorter than this is a tap: listening carries on until the next press. */
const TAP_MS = 350;
/** How long to wait for a message to reach a terminal before giving up on hearing its answer. */
const PTY_WAIT_MS = 8000;

export interface DictationTarget {
  /** Shown while listening: where the words will go. */
  label: string;
  /** The box or pane; a target that is no longer on screen is skipped. */
  element: () => HTMLElement | null;
  /** Put the words in for review. */
  insert: (text: string) => void;
  /** Put the words in and send them. Without it, sending falls back to insert. */
  submit?: (text: string) => void;
  /** Send what is waiting ("Forge, send"). */
  send?: () => void;
  /** Empty the box or input line ("Forge, clear"). */
  clear?: () => void;
  /** Interrupt the program working here ("Forge, stop"). */
  interrupt?: () => void;
  /** Reopen an ended session ("Forge, continue"). */
  resume?: () => void;
  /** The terminal the words reach, once there is one, to hear its answer. */
  ptyId?: () => string | null;
  /** Names this target expects to hear, such as the files in its workspace. */
  words?: () => string[] | Promise<string[]>;
}

// ------------------------------------------------------------------ targets

let lastTarget: DictationTarget | null = null;

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
    submit: (text) => {
      const current = makeRef.current();
      (current.submit ?? current.insert)(text);
    },
    send: () => makeRef.current().send?.(),
    clear: () => makeRef.current().clear?.(),
    interrupt: () => makeRef.current().interrupt?.(),
    resume: () => {
      const current = makeRef.current();
      if (current.resume) current.resume();
      else (current.submit ?? current.insert)("Continue.");
    },
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
// Words for a chat that isn't on screen yet ("Atlas, …" in review mode): its composer takes them
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

// ------------------------------------------------------------------ state from the main process

let state: VoiceState = { phase: "idle", level: 0, seconds: 0, speech: null };
const stateListeners = new Set<() => void>();
let talk: TalkEvent | null = null;
const talkListeners = new Set<() => void>();
const talkHandlers = new Set<(event: TalkEvent) => void>();
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
    for (const handler of talkHandlers) handler(event);
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
  /** Held: stops on key-up. Tapped or clicked: stops on the next press or click. */
  mode: "hold" | "toggle";
  /** Recording has stopped and whisper is working on it. */
  finishing: boolean;
}

/** Conversation mode: listen, send, hear the answer, listen again. */
interface Conversation {
  target: DictationTarget;
  /** Waiting for an answer from this terminal before listening again. */
  waitingFor: string | null;
}

/** Conversation.waitingFor while a message is on its way and its terminal isn't known yet. */
const PENDING = "pending";

let session: Session | null = null;
let conversation: Conversation | null = null;
const sessionListeners = new Set<() => void>();

function notifySession(): void {
  for (const notify of sessionListeners) notify();
}

function setSession(next: Session | null): void {
  session = next;
  notifySession();
}

function setConversation(next: Conversation | null): void {
  conversation = next;
  notifySession();
}

const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};

function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, () => session);
}

function useConversation(): Conversation | null {
  return useSyncExternalStore(subscribeSession, () => conversation);
}

interface Controller {
  begin: (mode: Session["mode"], target?: DictationTarget) => void;
  finish: () => void;
  cancel: () => void;
  converse: (target?: DictationTarget) => void;
  endConversation: () => void;
  expectAnswer: (target: DictationTarget, words: string) => void;
}

let controller: Controller | null = null;

/** Start or stop dictating into `target` (a mic button's click). */
export function toggleDictation(target: DictationTarget): void {
  if (conversation) controller?.endConversation();
  else if (session) controller?.finish();
  else controller?.begin("toggle", target);
}

/** A composer sent words that were dictated into it: listen for the answer. */
export function expectAnswer(target: DictationTarget, words: string): void {
  controller?.expectAnswer(target, words);
}

// ------------------------------------------------------------------ small helpers

function focused(): boolean {
  return document.hasFocus();
}

/** A short tone, for starting and stopping when the window is in the background. */
function blip(up: boolean): void {
  try {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(up ? 660 : 880, audio.currentTime);
    osc.frequency.linearRampToValueAtTime(up ? 880 : 520, audio.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.13);
    osc.onended = () => void audio.close();
  } catch {
    /* no audio output */
  }
}

async function waitForPty(target: DictationTarget, ms = PTY_WAIT_MS): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    // Starting a new chat can swap its pane for another; the one now focused has the terminal.
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
 * Owns the shortcuts, talks to the main process, and draws the listening bar. Mounted once, in
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
  const talking = useConversation();
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

  const listen = useCallback(
    (mode: Session["mode"], into: DictationTarget, endpoint: boolean) => {
      busy.current = true;
      setSession({ target: into, mode, finishing: false });
      if (!focused()) blip(true);
      call("voice.start", { endpoint }).then(
        () => {
          busy.current = false;
        },
        (error: unknown) => {
          busy.current = false;
          setSession(null);
          setConversation(null);
          if (focused()) fail(error, say("voice.failed"));
          else inform("error", say("voice.failed"), error instanceof Error ? error.message : String(error));
        },
      );
    },
    [fail, inform],
  );

  /** The target to use, or null after saying why there is none. */
  const resolveTarget = useCallback(
    (target?: DictationTarget): DictationTarget | null => {
      if (refs.current.status && !refs.current.status.ready) {
        inform("info", say("voice.notReady"), say("voice.notReadyBody"));
        if (focused()) {
          go({ view: "settings" });
          setTimeout(() => document.getElementById("settings-voice")?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
        }
        return null;
      }
      // With nowhere focused, an agent's name or a command still works; plain words are copied.
      return target ?? (onScreen(lastTarget) ? lastTarget : nowhere);
    },
    [go, inform],
  );

  const nowhere = useRef<DictationTarget>({
    get label() {
      return say("voice.noTargetLabel");
    },
    element: () => document.body,
    insert: (text) => {
      void call("app.copyText", text).catch(() => undefined);
      inform("info", say("voice.noTarget"), say("voice.noTargetBody"));
    },
  }).current;

  const begin = useCallback(
    (mode: Session["mode"], target?: DictationTarget) => {
      if (session || busy.current) return;
      const into = resolveTarget(target);
      if (into) listen(mode, into, false);
    },
    [listen, resolveTarget],
  );

  const talkBackOn = () => (refs.current.settings?.voice.talkBack ?? "summary") !== "off" || Boolean(conversation);

  const expectFrom = useCallback(async (target: DictationTarget, words: string, wait = true): Promise<string | null> => {
    if (!talkBackOn()) return null;
    const ptyId = wait ? await waitForPty(target) : (target.ptyId?.() ?? null);
    if (!ptyId) return null;
    try {
      return (await call("voice.expect", ptyId, words)) ? ptyId : null;
    } catch {
      return null;
    }
  }, []);

  /** A message for an agent: to its latest chat (a new one if it has none), sent or left for review. */
  const toAgent = useCallback(
    async (agentId: string, text: string, send: boolean): Promise<string | null> => {
      const agent = refs.current.agents?.find((item) => item.id === agentId);
      const chats = await call("chats.list", { agentId });
      const chat = chats.find((item) => item.live) ?? [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? (await call("chats.create", { agentId }));
      const route: Route = { view: "agents", agentId, tab: "chats", chatId: chat.id };
      if (!send) {
        setDraft(chat.id, text);
        go(route);
        if (!focused()) inform("info", say("voice.toAgentReview", { name: agent?.name ?? "" }), text);
        return null;
      }
      const result = await call("chats.send", chat.id, text);
      if (focused() && !conversation) go(route);
      else if (!focused()) inform("success", say("voice.toAgentSent", { name: agent?.name ?? "" }), text);
      if (!talkBackOn()) return null;
      return (await call("voice.expect", result.ptyId, text).catch(() => false)) ? result.ptyId : null;
    },
    [go, inform],
  );

  const runCommand = useCallback(
    async (command: Command, target: DictationTarget): Promise<void> => {
      const confirm = (key: Key, vars?: Vars) => {
        const text = say(key, vars);
        inform("success", text);
        if (conversation) void call("voice.speak", text).catch(() => undefined);
      };
      switch (command.type) {
        case "newTask":
          await call("tasks.save", { title: command.title, agentId: command.agentId });
          confirm("voice.cmd.taskAdded", { title: command.title });
          break;
        case "runRoutine": {
          await call("routines.runNow", command.routineId);
          const name = refs.current.routines?.find((item) => item.id === command.routineId)?.name ?? "";
          confirm("voice.cmd.routineStarted", { name });
          break;
        }
        case "open":
          go({ view: command.view } as Route);
          break;
        case "send":
          target.send?.();
          break;
        case "clear":
          target.clear?.();
          break;
        case "stop":
          target.interrupt?.();
          break;
        case "continue":
          target.resume?.();
          break;
        case "stopListening":
          setConversation(null);
          inform("info", say("voice.conversationEnded"));
          break;
        case "unknown":
          inform("info", say("voice.cmd.unknown"), command.text);
          break;
      }
    },
    [go, inform],
  );

  /** What to do with the words: a command, a message for an agent, or text for the target. Returns the terminal to hear from. */
  const act = useCallback(
    async (text: string, target: DictationTarget, send: boolean): Promise<string | null> => {
      const utterance = parseUtterance(text, { agents: refs.current.agents ?? [], routines: refs.current.routines ?? [] });
      if (utterance.kind === "command") {
        await runCommand(utterance.command, target);
        return null;
      }
      if (utterance.kind === "agent") return toAgent(utterance.agentId, utterance.text, send);
      if (send) target.submit?.(text);
      else target.insert(text);
      if (!focused() && target.element() !== document.body) inform("info", say(send ? "voice.sentTo" : "voice.pastedInto", { target: target.label }), text);
      // A composer listens for the answer when its words are actually sent; a terminal already has them.
      return expectFrom(target, text, send);
    },
    [expectFrom, inform, runCommand, toAgent],
  );

  /** Listen again in conversation mode, after an answer or right away. */
  const again = useCallback(() => {
    const talking = conversation;
    if (!talking || session || busy.current) return;
    const target = onScreen(talking.target) ? talking.target : onScreen(lastTarget) ? lastTarget : talking.target;
    if (target !== talking.target) setConversation({ ...talking, target });
    listen("toggle", target, true);
  }, [listen]);

  const finish = useCallback(() => {
    const ending = session;
    if (!ending || ending.finishing) return;
    setSession({ ...ending, finishing: true });
    if (!focused()) blip(false);
    void (async () => {
      const { agents: agentList, engines: engineList, routines: routineList, settings: now } = refs.current;
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
      let heardFrom: string | null = null;
      try {
        const result = await call("voice.stop", prompt);
        // Whisper is done: the bar stops saying so while the words are delivered.
        setSession(null);
        if (conversation) setConversation({ ...conversation, waitingFor: PENDING });
        if (result.empty) {
          if (!conversation) inform("info", say(EMPTY_KEYS[result.empty]));
          return;
        }
        // The box can be replaced while whisper works (a view re-rendering its chat): use the one
        // that has focus now. Only with nothing to put the words in are they copied instead.
        let target = ending.target;
        if (!onScreen(target)) {
          if (!onScreen(lastTarget)) {
            await call("app.copyText", result.text);
            inform("info", say("voice.targetGone"), result.text);
            return;
          }
          target = lastTarget;
          if (conversation) setConversation({ ...conversation, target });
        }
        heardFrom = await act(result.text, target, Boolean(conversation) || Boolean(now?.voice.autoSend));
      } catch (error) {
        setConversation(null);
        if (focused()) fail(error, say("voice.failed"));
        else inform("error", say("voice.failed"), error instanceof Error ? error.message : String(error));
      } finally {
        setSession(null);
        if (conversation) {
          setConversation({ ...conversation, waitingFor: heardFrom });
          if (!heardFrom) setTimeout(again, 400);
        }
      }
    })();
  }, [act, again, fail, inform]);

  const cancel = useCallback(() => {
    if (!session || session.finishing) return;
    setSession(null);
    void call("voice.cancel").catch(() => undefined);
  }, []);

  const endConversation = useCallback(() => {
    if (!conversation) return;
    setConversation(null);
    if (session && !session.finishing) cancel();
    void call("voice.silence").catch(() => undefined);
    void call("voice.forget").catch(() => undefined);
  }, [cancel]);

  const converse = useCallback(
    (target?: DictationTarget) => {
      if (conversation) return endConversation();
      const into = resolveTarget(target ?? session?.target);
      if (!into) return;
      setConversation({ target: into, waitingFor: null });
      // Already listening: carry on, now hands-free. Otherwise start listening.
      if (session) {
        if (!session.finishing) setSession({ ...session, mode: "toggle" });
        return;
      }
      listen("toggle", into, true);
    },
    [endConversation, listen, resolveTarget],
  );

  const expectAnswerCb = useCallback(
    (target: DictationTarget, words: string) => {
      void expectFrom(target, words);
    },
    [expectFrom],
  );

  useEffect(() => {
    controller = { begin, finish, cancel, converse, endConversation, expectAnswer: expectAnswerCb };
    return () => {
      controller = null;
    };
  }, [begin, finish, cancel, converse, endConversation, expectAnswerCb]);

  // Conversation mode: the end of a sentence finishes it; a long silence ends the conversation.
  useEffect(() => {
    if (!conversation || !session || session.finishing) return;
    if (voice.speech === "ended") finish();
    else if (voice.speech === "timeout") {
      endConversation();
      inform("info", say("voice.conversationIdle"));
    }
  }, [voice.speech, finish, endConversation, inform]);

  // …and an answer that has been read (or has nothing to read) opens the microphone again.
  useEffect(() => {
    const handler = (event: TalkEvent) => {
      if (event.stage !== "done" || !conversation || conversation.waitingFor !== event.ptyId) return;
      setConversation({ ...conversation, waitingFor: null });
      setTimeout(again, 300);
    };
    talkHandlers.add(handler);
    return () => {
      talkHandlers.delete(handler);
    };
  }, [again]);

  // A keybinding outside the window: `vibeforge --voice start|stop|toggle|cancel|converse`.
  useEffect(
    () =>
      on("voice-command", ({ action }) => {
        if (action === "start") begin("hold");
        else if (action === "stop") finish();
        else if (action === "toggle") {
          if (session) finish();
          else begin("toggle");
        } else if (action === "cancel") {
          if (conversation) endConversation();
          else cancel();
        } else converse();
      }),
    [begin, finish, cancel, converse, endConversation],
  );

  // Hold to talk, tap to keep listening, Esc to drop it. Caught before terminals see the keys.
  useEffect(() => {
    let pressedAt = 0;
    let holding = false;
    const isDictate = (event: KeyboardEvent) => event.code === "Space" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    const isConverse = (event: KeyboardEvent) => event.code === "Space" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
    const release = () => {
      if (!holding) return;
      holding = false;
      if (!session || session.finishing || conversation) return;
      if (Date.now() - pressedAt < TAP_MS) setSession({ ...session, mode: "toggle" });
      else finish();
    };
    const down = (event: KeyboardEvent) => {
      if (isConverse(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) converse();
      } else if (isDictate(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (conversation) {
          // Mid-conversation the key means "my turn now", or "that's all" while speaking.
          if (!session) {
            setConversation({ ...conversation, waitingFor: null });
            void call("voice.silence").catch(() => undefined);
            listen("toggle", conversation.target, true);
          } else if (!session.finishing) finish();
          return;
        }
        if (session) {
          if (session.mode === "toggle") finish();
          return;
        }
        pressedAt = Date.now();
        holding = true;
        begin("hold");
      } else if (event.key === "Escape" && (conversation || (session && !session.finishing))) {
        event.preventDefault();
        event.stopPropagation();
        holding = false;
        if (conversation) endConversation();
        else cancel();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (!holding) return;
      if (event.code === "Space" || event.key === "Control" || event.key === "Shift") {
        event.preventDefault();
        event.stopPropagation();
        release();
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", release);
    };
  }, [begin, finish, cancel, converse, endConversation, listen]);

  if (current) {
    return (
      <ListeningBar
        label={current.target.label}
        voice={voice}
        finishing={current.finishing}
        held={current.mode === "hold"}
        conversation={Boolean(talking)}
        onStop={talking ? endConversation : finish}
        onCancel={talking ? endConversation : cancel}
        onConverse={() => converse(current.target)}
      />
    );
  }
  if (talking || spoken) {
    return (
      <AnswerBar
        who={spoken?.who ?? talking?.target.label ?? ""}
        text={spoken?.stage === "speaking" ? spoken.text : ""}
        waiting={Boolean(talking?.waitingFor) && spoken?.stage !== "speaking"}
        conversation={Boolean(talking)}
        onStop={() => {
          if (talking) endConversation();
          else void call("voice.silence");
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
  held,
  conversation,
  onStop,
  onCancel,
  onConverse,
}: {
  label: string;
  voice: VoiceState;
  finishing: boolean;
  held: boolean;
  conversation: boolean;
  onStop: () => void;
  onCancel: () => void;
  onConverse: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useBarLayer(ref);
  const transcribing = finishing || voice.phase === "transcribing";
  const lit = Math.round(voice.level * METER_CELLS);
  const seconds = Math.floor(voice.seconds);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const heading = transcribing ? t("voice.transcribing") : conversation ? (voice.speech === "speaking" ? t("voice.hearing") : t("voice.yourTurn")) : t("voice.listening");
  return (
    <div ref={ref} className={`listening${transcribing ? " transcribing" : ""}${conversation ? " conversation" : ""}`} role="status" aria-live="polite">
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
        <strong>{heading}</strong>
        {label && <span className="faint truncate"> → {label}</span>}
      </span>
      <span className="listening-clock mono">{clock}</span>
      {!transcribing && (
        <span className="listening-keys faint">
          <Rich text={conversation ? t("voice.conversationKeys") : held ? t("voice.releaseToStop") : t("voice.pressToStop", { keys: DICTATE_KEYS })} />
        </span>
      )}
      {!transcribing && !conversation && (
        <Button size="sm" variant="ghost" icon={MessagesSquare} onClick={onConverse} tip={t("voice.converseTip")} kbd={CONVERSE_KEYS} />
      )}
      {!transcribing && (
        <>
          <Button size="sm" variant="primary" icon={Square} onClick={onStop}>
            {conversation ? t("voice.endConversation") : t("voice.stop")}
          </Button>
          {!conversation && (
            <Button size="sm" variant="ghost" onClick={onCancel} tip={t("voice.cancelTip")}>
              {t("common.cancel")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** Between turns: waiting for an agent, or hearing its answer. */
function AnswerBar({ who, text, waiting, conversation, onStop }: { who: string; text: string; waiting: boolean; conversation: boolean; onStop: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useBarLayer(ref);
  return (
    <div ref={ref} className={`listening answer${conversation ? " conversation" : ""}`} role="status" aria-live="polite">
      {text ? <Volume2 size={15} className="accent-text" /> : <span className="spinner" />}
      <span className="listening-text">
        <strong>{text ? who : waiting ? t("voice.waitingFor", { name: who }) : conversation ? t("voice.yourTurn") : t("voice.speaking")}</strong>
        {text && <span className="faint truncate"> {text}</span>}
      </span>
      {conversation && (
        <span className="listening-keys faint">
          <Rich text={t("voice.interruptKeys", { keys: DICTATE_KEYS })} />
        </span>
      )}
      <Button size="sm" variant={conversation ? "primary" : "ghost"} icon={Square} onClick={onStop}>
        {conversation ? t("voice.endConversation") : t("voice.silence")}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ the mic button

/** A mic beside a message box: click to start dictating into it, click again to stop. */
export function MicButton({ target, disabled }: { target: DictationTarget; disabled?: boolean }) {
  const t = useT();
  const current = useSession();
  const ready = useVoiceStatus().data?.ready ?? false;
  const mine = current?.target === target;
  const transcribing = mine && current.finishing;
  return (
    <Button
      variant="ghost"
      icon={mine ? Square : Mic}
      className={mine && !transcribing ? "mic live" : "mic"}
      pressed={mine && !transcribing}
      busy={transcribing}
      disabled={disabled || (current !== null && !mine)}
      kbd={DICTATE_KEYS}
      tip={mine ? t("voice.stopTip") : ready ? t("voice.micTip") : t("voice.micSetupTip")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => toggleDictation(target)}
    />
  );
}
