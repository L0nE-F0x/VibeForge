import { ArrowUp, History, Play, RotateCcw, Square, TerminalSquare, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import type { ChatView } from "../../shared/api.js";
import { joinDictation } from "../../shared/dictation.js";
import { shellQuote, tildify } from "../../shared/text.js";
import { call, pathForFile, useAppInfo, useQuery, useSettings } from "../api.js";
import { useAction, useNav, useToast } from "../state.js";
import { estimateTermSize, LiveTerminal, PATH_MIME, ReplayTerminal, type TerminalHandle } from "./Terminal.js";
import { Button, Empty, Kbd, StatusChip, TimeAgo } from "./ui.js";
import { useT } from "../i18n/index.js";
import { expectAnswer, MicButton, setDictationTarget, useDictationTarget, useDraft } from "../voice.js";

// ------------------------------------------------------------------ composer

export function Composer({
  placeholder,
  onSend,
  busy,
  disabled,
  hint,
  leading,
  autoFocus,
  sendLabel = "Send",
  voiceLabel,
  voiceScope,
  voicePty,
  voiceResume,
  draftKey,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean | void>;
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
  /** The terminal messages from this box reach, for hearing answers and interrupting. */
  voicePty?: () => string | null;
  /** Reopens the ended session ("Forge, continue"). */
  voiceResume?: () => void;
  /** Words dictated for this chat from elsewhere ("Atlas, …") arrive under this key. */
  draftKey?: string | null;
}) {
  const t = useT();
  const [text, setText] = useState("");
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
    submit: (words) => {
      const value = joinDictation(textRef.current, words).trim();
      if (!value || busy || disabled) {
        setText(joinDictation(textRef.current, words));
        return;
      }
      setText("");
      dictated.current = "";
      void onSend(value).then((ok) => {
        if (ok === false) setText(value);
      });
    },
    send: () => void submit(),
    clear: () => {
      dictated.current = "";
      setText("");
    },
    interrupt: () => {
      const ptyId = voicePty?.();
      if (ptyId) void call("pty.write", ptyId, "\x1b").catch(() => undefined);
    },
    resume: voiceResume,
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
    const ok = await onSend(value);
    if (ok === false) return;
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
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <MicButton target={dictation.target} disabled={disabled} />
        <Button variant="primary" icon={ArrowUp} busy={busy} disabled={disabled || !text.trim()} onClick={() => void submit()} title={t("common.sendEnter", { label: sendLabel })}>
          {sendLabel}
        </Button>
      </div>
      <div className="composer-hint">
        <span>
          <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Space</Kbd> dictate · drop files to insert paths
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
  const bundle = useQuery(`run:${runId}`, ["runs"], () => call("runs.get", runId));
  const files = bundle.data?.files;
  if (!bundle.loaded) return <div className="term" />;
  return <ReplayTerminal ansi={files?.screen || files?.scrollback || ""} emptyText="This session left no transcript." />;
}

export function SessionPane({
  chat,
  create,
  onCreated,
  empty,
  placeholder,
  active = true,
}: {
  chat: ChatView | null;
  /** Makes the chat on first send when none is selected yet. */
  create: () => Promise<ChatView>;
  onCreated?: (chat: ChatView) => void;
  empty: { icon: LucideIcon; title: ReactNode; body: ReactNode };
  placeholder: string;
  active?: boolean;
}) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const home = useAppInfo().data?.home ?? "";
  const fontSize = useSettings().data?.terminalFontSize ?? 13;
  const root = useRef<HTMLDivElement>(null);
  // The terminal takes the pane minus the status bar and the composer.
  const size = () => estimateTermSize(root.current, fontSize, 150);
  const [pending, setPending] = useState<{ chatId: string; ptyId: string } | null>(null);
  const terminal = useRef<TerminalHandle>(null);

  const livePty = pending && pending.chatId === chat?.id ? pending.ptyId : chat?.live ? chat.ptyId : null;
  // A chat made by this send has its terminal before the view has the chat itself.
  const livePtyRef = useRef(livePty);
  livePtyRef.current = livePty ?? pending?.ptyId ?? null;

  useEffect(() => {
    if (pending && chat?.id === pending.chatId && chat.ptyId === pending.ptyId) setPending(null);
  }, [chat, pending]);

  const [send, sending] = useAction(async (text: string) => {
    let target = chat;
    if (!target) {
      target = await create();
      onCreated?.(target);
    }
    const result = await call("chats.send", target.id, text, size());
    setPending({ chatId: target.id, ptyId: result.ptyId });
    if (result.note) push("info", result.note);
    return true;
  }, "Could not send");

  const [resume, resuming] = useAction(async () => {
    if (!chat) return;
    const result = await call("chats.continue", chat.id, size());
    setPending({ chatId: chat.id, ptyId: result.ptyId });
  }, "Could not continue the session");

  const [stop, stopping] = useAction(async () => {
    if (chat) await call("chats.stop", chat.id);
  }, "Could not stop the session");

  const last = chat?.lastRun ?? null;

  return (
    <div className="session" ref={root}>
      {livePty ? (
        <>
          <LiveTerminal
            key={livePty}
            ref={terminal}
            ptyId={livePty}
            active={active}
            autoFocus
            onExit={() => setPending((prev) => (prev?.ptyId === livePty ? null : prev))}
          />
          <div className="session-bar">
            <span className="dot running" />
            <span className="grow truncate muted">
              Live in <span className="mono">{tildify(chat?.cwd ?? "", home)}</span> — type in the terminal, or use the box below.
            </span>
            <Button size="sm" icon={Square} busy={stopping} onClick={() => void stop()}>
              Stop
            </Button>
          </div>
        </>
      ) : last ? (
        <>
          <RunReplay runId={last.id} />
          <div className="session-bar">
            <StatusChip status={last.status} exitCode={last.exitCode} />
            <span className="grow truncate muted">
              Session ended <TimeAgo iso={last.endedAt ?? last.startedAt} />
              {last.changes ? ` · ${last.changes}` : ""}. Sending a message picks it up again.
            </span>
            <Button size="sm" icon={History} onClick={() => go({ view: "runs", runId: last.id })}>
              Review
            </Button>
            <Button size="sm" variant="primary" icon={RotateCcw} busy={resuming} onClick={() => void resume()}>
              Continue session
            </Button>
          </div>
        </>
      ) : (
        <Empty icon={empty.icon} title={empty.title}>
          {empty.body}
        </Empty>
      )}
      <Composer
        placeholder={livePty ? t("session.messagePlaceholder") : placeholder}
        onSend={async (text) => Boolean(await send(text))}
        busy={sending}
        autoFocus={!livePty}
        sendLabel={livePty ? t("common.send") : last ? t("common.continue") : t("common.start")}
        voiceLabel={chat?.title ?? t("agents.newChat")}
        voiceScope={root}
        voicePty={() => livePtyRef.current}
        voiceResume={() => void resume()}
        draftKey={chat?.id}
        hint={
          livePty ? (
            <span className="hstack">
              <TerminalSquare size={12} /> pasted into the session
            </span>
          ) : (
            <span className="hstack">
              <Play size={12} /> starts {chat ? "the engine" : "a new session"}
            </span>
          )
        }
      />
    </div>
  );
}
