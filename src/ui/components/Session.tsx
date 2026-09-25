import { ArrowUp, History, Play, RotateCcw, Square, TerminalSquare, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ChatView } from "../../shared/api.js";
import { shellQuote, tildify } from "../../shared/text.js";
import { call, pathForFile, useAppInfo, useQuery, useSettings } from "../api.js";
import { useAction, useNav, useToast } from "../state.js";
import { estimateTermSize, LiveTerminal, PATH_MIME, ReplayTerminal, type TerminalHandle } from "./Terminal.js";
import { Button, Empty, Kbd, StatusChip, TimeAgo } from "./ui.js";

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
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean | void>;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  leading?: ReactNode;
  autoFocus?: boolean;
  sendLabel?: string;
}) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

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
    const value = text.trim();
    if (!value || busy || disabled) return;
    const ok = await onSend(value);
    if (ok !== false) setText("");
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
    <div className="composer">
      <div className={`composer-box${dragging ? " dragging" : ""}`} {...dropHandlers}>
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
        <Button variant="primary" icon={ArrowUp} busy={busy} disabled={disabled || !text.trim()} onClick={() => void submit()} title={`${sendLabel} (Enter)`}>
          {sendLabel}
        </Button>
      </div>
      <div className="composer-hint">
        <span>
          <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · drop files to insert paths
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
        placeholder={livePty ? "Message the running session…" : placeholder}
        onSend={async (text) => Boolean(await send(text))}
        busy={sending}
        autoFocus={!livePty}
        sendLabel={livePty ? "Send" : last ? "Continue" : "Start"}
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
