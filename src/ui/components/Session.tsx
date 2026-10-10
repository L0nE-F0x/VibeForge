import { ArrowUp, History, Play, Square, SquarePen, TerminalSquare, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import type { ChatView } from "../../shared/api.js";
import { joinDictation } from "../../shared/dictation.js";
import { shellQuote } from "../../shared/text.js";
import { call, pathForFile, useAgents, useLive, useQuery, useSettings } from "../api.js";
import { forgetDraft, readDraft, useDraftState } from "../drafts.js";
import { useAction, useNav, useToast } from "../state.js";
import { estimateTermSize, LiveTerminal, PATH_MIME, ReplayTerminal, type TerminalHandle } from "./Terminal.js";
import { Button, Empty, StatusChip, TimeAgo } from "./ui.js";
import { writerNames } from "./Occupancy.js";
import { tipProps } from "./Tooltip.js";
import { useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { coreText } from "../core-text.js";
import { expectAnswer, expectOnEnter, MicButton, setDictationTarget, useDictationTarget, useDraft } from "../voice.js";

// ------------------------------------------------------------------ composer

export function Composer({
  placeholder,
  onSend,
  busy,
  disabled,
  hint,
  leading,
  autoFocus,
  sendLabel,
  voiceLabel,
  voiceScope,
  voicePty,
  voiceAgent,
  draftKey,
  keepKey,
  onEscape,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean | undefined>;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  leading?: ReactNode;
  autoFocus?: boolean;
  sendLabel?: string;
  /** Where dictated words go, as the listening bar names it. */
  voiceLabel?: string;
  /** Focus anywhere in here (the session's terminal, say) makes this box where dictation lands. */
  voiceScope?: RefObject<HTMLElement | null>;
  /** The terminal messages from this box reach, for hearing the answer after Enter. */
  voicePty?: () => string | null;
  /** The agent this chat belongs to, so the desktop key can come back to them. */
  voiceAgent?: string | null;
  /** Words dictated for this chat from the desktop key arrive under this key. */
  draftKey?: string | null;
  /** What's typed and not sent yet is kept under this key, across view switches and restarts. */
  keepKey?: string | null;
  /** Esc in the box: close it (what's typed stays, under `keepKey`). */
  onEscape?: () => void;
}) {
  const t = useT();
  const [text, setText] = useDraftState(keepKey ?? null, "");
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  // Dictated words not sent yet: once they are, the answer is listened for.
  const dictated = useRef("");

  const dictation = useDictationTarget(() => ({
    label: voiceLabel ?? placeholder,
    element: () => box.current,
    ownsSend: true,
    agentId: () => voiceAgent ?? null,
    insert: (words) => {
      dictated.current = joinDictation(dictated.current, words);
      const next = joinDictation(textRef.current, words);
      setText(next);
      requestAnimationFrame(() => {
        const node = ref.current;
        if (!node) return;
        node.focus();
        node.selectionStart = node.selectionEnd = next.length;
      });
    },
    ptyId: voicePty,
  }));

  useDraft(draftKey, (words) => dictation.target.insert(words));

  useEffect(() => {
    const scope = voiceScope?.current;
    if (!scope) return;
    const claim = () => setDictationTarget(dictation.target);
    scope.addEventListener("focusin", claim);
    return () => scope.removeEventListener("focusin", claim);
  }, [voiceScope, dictation.target]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(220, Math.max(22, node.scrollHeight))}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  async function submit() {
    const value = textRef.current.trim();
    if (!value || busy || disabled) return;
    const words = dictated.current;
    const sentFrom = keepKey;
    const ok = await onSend(value);
    if (ok === false) return;
    if (sentFrom) forgetDraft(sentFrom);
    setText("");
    dictated.current = "";
    if (words) expectAnswer(dictation.target, words);
  }

  function insert(snippet: string) {
    const node = ref.current;
    if (!node) {
      setText((prev) => prev + snippet);
      return;
    }
    const start = node.selectionStart ?? text.length;
    const end = node.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      node.focus();
      node.selectionStart = node.selectionEnd = start + snippet.length;
    });
  }

  const dropHandlers = {
    onDragOver(event: DragEvent) {
      if (!event.dataTransfer.types.includes("Files") && !event.dataTransfer.types.includes(PATH_MIME)) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave() {
      setDragging(false);
    },
    onDrop(event: DragEvent) {
      setDragging(false);
      const paths = [event.dataTransfer.getData(PATH_MIME), ...Array.from(event.dataTransfer.files).map(pathForFile)].filter(Boolean);
      if (!paths.length) return;
      event.preventDefault();
      insert(`${paths.map(shellQuote).join(" ")} `);
    },
  };

  return (
    <div className="composer" onFocusCapture={dictation.onFocusCapture}>
      <div ref={box} className={`composer-box${dragging ? " dragging" : ""}`} {...dropHandlers}>
        {leading}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            // Emptied by hand: what gets typed next was not dictated.
            if (!next.trim()) dictated.current = "";
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!event.ctrlKey) void submit();
              // Ctrl+Shift+Enter, which opened the box from the terminal, closes it too.
              else if (onEscape) onEscape();
            } else if (event.key === "Escape" && onEscape) {
              event.preventDefault();
              event.stopPropagation();
              onEscape();
            }
          }}
        />
        <MicButton target={dictation.target} disabled={disabled} />
        <Button variant="primary" icon={ArrowUp} busy={busy} disabled={disabled || !text.trim()} onClick={() => void submit()} title={t("common.sendEnter", { label: sendLabel ?? t("common.send") })}>
          {sendLabel ?? t("common.send")}
        </Button>
      </div>
      <div className="composer-hint">
        <span>
          <Rich text={t("session.keys")} />
        </span>
        <span className="grow" />
        {hint}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ session pane

/** The final screen of a finished run, loaded from its run folder. */
function RunReplay({ runId }: { runId: string }) {
  const t = useT();
  const bundle = useQuery(`run:${runId}`, ["runs"], () => call("runs.get", runId));
  const files = bundle.data?.files;
  if (!bundle.loaded) return <div className="term" />;
  return <ReplayTerminal ansi={files?.screen || files?.scrollback || ""} emptyText={t("session.noTranscript")} />;
}

export function SessionPane({
  chat,
  create,
  onCreated,
  empty,
  placeholder,
  head,
  tools,
  leading,
  slim,
  active = true,
  newKey,
}: {
  chat: ChatView | null;
  /** Makes the chat on first send when none is selected yet; `text` is that first message. */
  create: (text: string) => Promise<ChatView>;
  onCreated?: (chat: ChatView) => void;
  empty: { icon: LucideIcon; title: ReactNode; body: ReactNode };
  /** Names the unsent message of a chat that doesn't exist yet: the agent's id, or "chat". */
  newKey: string;
  placeholder: string;
  /** The left of the header: the chat's name. */
  head: ReactNode;
  /** Buttons at the right of the header, before the live session's own. */
  tools?: ReactNode;
  /** At the start of the message box while no session runs (the engine picker). */
  leading?: ReactNode;
  /** A shorter header, under a page that has its own. */
  slim?: boolean;
  active?: boolean;
}) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const fontSize = useSettings().data?.terminalFontSize ?? 13;
  const root = useRef<HTMLDivElement>(null);
  // A new session gets the whole pane: the message box goes once it runs.
  const size = () => estimateTermSize(root.current, fontSize, 8);
  const [pending, setPending] = useState<{ chatId: string; ptyId: string } | null>(null);
  const terminal = useRef<TerminalHandle>(null);
  const keepKey = chat ? `chat:${chat.id}` : `chat:new:${newKey}`;
  // While a session runs its terminal is where you type; the box opens for a longer message, or
  // stays open while something is still written in it.
  const [composing, setComposing] = useState(() => Boolean(readDraft<string>(keepKey)?.trim()));

  const livePty = pending && pending.chatId === chat?.id ? pending.ptyId : chat?.live ? chat.ptyId : null;
  const agents = useAgents().data ?? [];
  const alsoHere = useLive().data?.find((session) => session.ptyId === livePty)?.alsoHere ?? [];
  // A chat made by this send has its terminal before the view has the chat itself.
  const livePtyRef = useRef(livePty);
  livePtyRef.current = livePty ?? pending?.ptyId ?? null;
  const typing = Boolean(livePty) && !composing;

  useEffect(() => {
    if (pending && chat?.id === pending.chatId && chat.ptyId === pending.ptyId) setPending(null);
  }, [chat, pending]);

  // Dictation into the running session: pasted into its terminal, sent by the next Enter there.
  const toTerminal = useDictationTarget(() => ({
    label: chat?.title ?? t("agents.newChat"),
    element: () => root.current,
    insert: (words) => {
      terminal.current?.paste(words);
      terminal.current?.focus();
    },
    agentId: () => chat?.agentId ?? null,
    ptyId: () => livePtyRef.current,
  }));
  useEffect(() => {
    const scope = root.current;
    if (!scope || !typing) return;
    const claim = () => setDictationTarget(toTerminal.target);
    scope.addEventListener("focusin", claim);
    return () => scope.removeEventListener("focusin", claim);
  }, [typing, toTerminal.target]);
  // The desktop key's words for this chat.
  useDraft(typing ? chat?.id : null, (words) => {
    toTerminal.target.insert(words);
    expectOnEnter(toTerminal.target, words);
  });

  function closeComposer() {
    setComposing(false);
    terminal.current?.focus();
  }

  const [send, sending] = useAction(async (text: string) => {
    let target = chat;
    if (!target) {
      target = await create(text);
      onCreated?.(target);
    }
    const result = await call("chats.send", target.id, text, size());
    setPending({ chatId: target.id, ptyId: result.ptyId });
    // Sent from the box over a running session: back to its terminal.
    if (composing) closeComposer();
    if (result.note) push("info", coreText(result.note));
    return true;
  }, t("session.sendFailed"));

  const [stop, stopping] = useAction(async () => {
    if (chat) await call("chats.stop", chat.id);
  }, t("session.stopFailed"));

  const last = chat?.lastRun ?? null;
  // The sentence around the time, which keeps itself up to date.
  const ended = t("session.ended", { when: "\u0000" }).split("\u0000");

  const composer = (
    <Composer
      placeholder={livePty ? t("session.messagePlaceholder") : last ? t("session.pickUpPlaceholder") : placeholder}
      onSend={async (text) => Boolean(await send(text))}
      busy={sending}
      autoFocus
      onEscape={livePty ? closeComposer : undefined}
      leading={livePty ? undefined : leading}
      sendLabel={livePty ? t("common.send") : last ? t("common.continue") : t("common.start")}
      voiceLabel={chat?.title ?? t("agents.newChat")}
      voiceScope={root}
      voicePty={() => livePtyRef.current}
      voiceAgent={chat?.agentId ?? null}
      draftKey={chat?.id}
      keepKey={keepKey}
      hint={
        livePty ? (
          <span className="hstack">
            <TerminalSquare size={12} /> <Rich text={t("session.backToTerminal")} />
          </span>
        ) : (
          <span className="hstack">
            <Play size={12} /> {chat ? t("session.startsEngine") : t("session.startsNew")}
          </span>
        )
      }
    />
  );

  return (
    <div className="session-wrap">
      <div className={`page-head session-head${slim ? " slim" : ""}`}>
        {head}
        {livePty && <span className="dot running" {...tipProps(t("session.live"))} />}
        {alsoHere.length > 0 && <span className="sub truncate">{t("occupancy.alsoHere", { names: writerNames(alsoHere, agents) })}</span>}
        <span className="grow" />
        {tools}
        {livePty && (
          <>
            <Button size="sm" variant={composing ? "primary" : undefined} icon={SquarePen} title={t("session.writeTip")} onClick={() => (composing ? closeComposer() : setComposing(true))}>
              {t("session.write")}
            </Button>
            {typing && <MicButton size="sm" target={toTerminal.target} />}
            <Button size="sm" icon={Square} busy={stopping} onClick={() => void stop()}>
              {t("tasks.stop")}
            </Button>
          </>
        )}
      </div>
      <div className={`session${livePty ? "" : last ? " ended" : " fresh"}`} ref={root}>
        {livePty ? (
          <>
            <LiveTerminal
              key={livePty}
              ref={terminal}
              ptyId={livePty}
              active={active}
              autoFocus={!composing}
              onCompose={() => setComposing(true)}
              onExit={() => setPending((prev) => (prev?.ptyId === livePty ? null : prev))}
            />
            {composing && composer}
          </>
        ) : last ? (
          <>
            <RunReplay runId={last.id} />
            <div className="session-bar">
              <StatusChip status={last.status} exitCode={last.exitCode} />
              <span className="grow truncate muted">
                {ended[0]}
                <TimeAgo iso={last.endedAt ?? last.startedAt} />
                {ended[1]}
                {last.changes ? ` · ${last.changes}` : ""}. {t("session.pickUp")}
              </span>
              <Button size="sm" icon={History} onClick={() => go({ view: "runs", runId: last.id })}>
                {t("session.review")}
              </Button>
            </div>
            {composer}
          </>
        ) : (
          <div className="session-start">
            <Empty icon={empty.icon} title={empty.title}>
              {empty.body}
            </Empty>
            {composer}
          </div>
        )}
      </div>
    </div>
  );
}
