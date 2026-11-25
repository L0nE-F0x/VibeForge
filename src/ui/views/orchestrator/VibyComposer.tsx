import { ImagePlus, X } from "lucide-react";
import { type ChangeEvent, type ClipboardEvent, useMemo, useRef, useState } from "react";
import { call, useAgents, useEngines, useWorkspaces } from "../../api.js";
import { Composer } from "../../components/Session.js";
import { useT } from "../../i18n/index.js";
import { Rich } from "../../i18n/Rich.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif)$/i;

function readImageDataUrl(file: Blob): Promise<string | null> {
  if (!file.size || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
  if (file.type && !IMAGE_MIME_RE.test(file.type) && !file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  insert: string;
  replaceStart: number;
  immediate?: boolean;
}

const SLASH_COMMANDS: ReadonlyArray<{ cmd: string; insert: string; hint: string; immediate?: boolean; needsWaiting?: boolean }> = [
  { cmd: "/go", insert: "/go", hint: "Run waiting plan", immediate: true, needsWaiting: true },
  { cmd: "/cancel", insert: "/cancel", hint: "Cancel waiting plan", immediate: true, needsWaiting: true },
  { cmd: "/new", insert: "/new", hint: "Start new conversation", immediate: true },
  { cmd: "/undo", insert: "/undo", hint: "Restore last delete", immediate: true },
  { cmd: "/review", insert: "/review", hint: "Mark all runs reviewed", immediate: true },
  { cmd: "/remember", insert: "/remember ", hint: "Save note to viby.md" },
  { cmd: "/stop-all", insert: "/stop-all", hint: "Stop Viby's running CLIs", immediate: true },
  { cmd: "/diagnostics", insert: "/diagnostics", hint: "Show Viby diagnostics & issues", immediate: true },
  { cmd: "/trust", insert: "/trust", hint: "Approve folder-trust prompt", immediate: true },
  { cmd: "/open", insert: "/open ", hint: "Jump to view or workspace" },
];

function setTextareaValue(node: HTMLTextAreaElement, nextValue: string): void {
  const proto = typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement.prototype : undefined;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
  if (setter) setter.call(node, nextValue);
  else node.value = nextValue;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.focus();
  node.setSelectionRange(nextValue.length, nextValue.length);
}

/**
 * Wraps the shared Composer for Viby with `@workspace` / `@agent` / `@cli` mentions,
 * `/` slash-command completion, and `Ctrl/Cmd+Enter` when empty to run a waiting plan.
 */
export function VibyComposer({
  placeholder,
  busy,
  disabled,
  autoFocus,
  sendLabel,
  voiceLabel,
  voiceWords,
  draftKey,
  keepKey,
  waitingTurnId,
  onRunWaiting,
  onEscape,
  onSend,
}: {
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  sendLabel: string;
  voiceLabel: string;
  voiceWords?: () => string[];
  draftKey: string;
  keepKey?: string;
  waitingTurnId?: string | null;
  onRunWaiting?: (turnId: string) => Promise<void> | void;
  onEscape?: () => void;
  onSend: (text: string, images?: string[]) => Promise<boolean>;
}) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const agents = useAgents().data ?? [];
  const engines = useEngines().data ?? [];
  const [textState, setTextState] = useState({ value: "", cursor: 0 });
  const [menuHidden, setMenuHidden] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [images, setImages] = useState<string[]>([]);

  const appendImageDataUrls = (urls: ReadonlyArray<string>) => {
    if (!urls.length) return;
    setImages((prev) => {
      const remaining = MAX_IMAGES - prev.length;
      if (remaining <= 0) return prev;
      return [...prev, ...urls.slice(0, remaining)];
    });
  };

  const addImageFiles = async (files: ReadonlyArray<Blob>) => {
    const loaded = (await Promise.all(files.slice(0, MAX_IMAGES).map(readImageDataUrl))).filter((item): item is string => Boolean(item));
    appendImageDataUrls(loaded);
  };

  const handlePasteCapture = (event: ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const itemFiles = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const directFiles = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    const found = itemFiles.length ? itemFiles : directFiles;
    if (found.length) {
      event.preventDefault();
      void addImageFiles(found);
      return;
    }
    const plain = event.clipboardData?.getData("text/plain") ?? "";
    if (!plain) {
      // Wayland / Electron compositors sometimes omit DOM clipboard image items; read directly via main-process IPC.
      void call("app.clipboardImage")
        .then((dataUrl) => {
          if (dataUrl) appendImageDataUrls([dataUrl]);
        })
        .catch(() => undefined);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length) void addImageFiles(files);
  };

  const suggestions = useMemo<Suggestion[]>(() => {
    if (menuHidden) return [];
    const before = textState.value.slice(0, textState.cursor);
    if (before.startsWith("/") && !before.includes(" ") && !before.includes("\n")) {
      const needle = before.toLowerCase();
      return SLASH_COMMANDS.filter((item) => (!item.needsWaiting || Boolean(waitingTurnId)) && item.cmd.startsWith(needle)).map((item) => ({
        key: item.cmd,
        label: item.cmd,
        detail: item.hint,
        insert: item.insert,
        replaceStart: 0,
        immediate: item.immediate,
      }));
    }
    const atMatch = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(before);
    if (atMatch) {
      const prefix = atMatch[1].toLowerCase();
      const replaceStart = before.length - atMatch[1].length - 1;
      const entries: Suggestion[] = [
        ...workspaces.map((w) => ({
          key: `ws:${w.id}`,
          label: `@${w.name}`,
          detail: "Workspace",
          insert: `@${w.name} `,
          replaceStart,
        })),
        ...agents.map((a) => ({
          key: `ag:${a.id}`,
          label: `@${a.name}`,
          detail: "Agent",
          insert: `@${a.name} `,
          replaceStart,
        })),
        ...engines
          .filter((e) => e.available)
          .map((e) => ({
            key: `eng:${e.id}`,
            label: `@${e.label}`,
            detail: "CLI",
            insert: `@${e.label} `,
            replaceStart,
          })),
      ];
      const cleanPrefix = prefix.replace(/[-_.]+/g, "");
      return entries
        .filter((entry) => {
          const low = entry.label.slice(1).toLowerCase();
          if (!cleanPrefix || low.includes(prefix)) return true;
          // Also match initials/subsequence on `@vbf` -> `@VibeForge` or `@sl` -> `@Star Ledger`
          let pos = 0;
          for (const ch of cleanPrefix) {
            const at = low.indexOf(ch, pos);
            if (at < 0) return false;
            pos = at + 1;
          }
          return true;
        })
        .slice(0, 7);
    }
    return [];
  }, [textState, menuHidden, waitingTurnId, workspaces, agents, engines]);

  const applySuggestion = (item: Suggestion) => {
    const textarea = wrapRef.current?.querySelector("textarea");
    if (!textarea) return;
    if (item.immediate) {
      setMenuHidden(true);
      setTextareaValue(textarea, "");
      void onSend(item.insert);
      return;
    }
    const after = textarea.value.slice(textState.cursor);
    const next = textarea.value.slice(0, item.replaceStart) + item.insert + after;
    setTextareaValue(textarea, next);
    setTextState({ value: next, cursor: item.replaceStart + item.insert.length });
    setActiveIdx(0);
    setMenuHidden(false);
  };

  const syncFromTextarea = (target: EventTarget | null) => {
    if (typeof HTMLTextAreaElement === "undefined" || !(target instanceof HTMLTextAreaElement)) return;
    setMenuHidden(false);
    setActiveIdx(0);
    setTextState({ value: target.value, cursor: target.selectionStart ?? target.value.length });
  };

  const handleKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && waitingTurnId && onRunWaiting) {
      const textarea = wrapRef.current?.querySelector("textarea");
      if (!textarea?.value.trim() && !images.length) {
        event.preventDefault();
        event.stopPropagation();
        void onRunWaiting(waitingTurnId);
        return;
      }
    }
    if (!suggestions.length) return;
    const clamped = Math.min(activeIdx, suggestions.length - 1);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIdx((clamped + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIdx((clamped - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      applySuggestion(suggestions[clamped]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuHidden(true);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="viby-composer-box grow"
      onKeyDownCapture={handleKeyDownCapture}
      // After the box's own onChange, never before it: a re-render in the capture phase ran while the
      // box still held its old text, and React put that back over every key typed (2026-11-25).
      onInput={(event) => syncFromTextarea(event.target)}
      onPasteCapture={handlePasteCapture}
    >
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={handleFileChange} />
      {images.length > 0 && (
        <div className="viby-image-strip">
          {images.map((src, idx) => (
            <div key={`${idx}-${src.slice(0, 32)}`} className="viby-image-thumb">
              <img src={src} alt="" />
              <button
                type="button"
                className="viby-image-remove"
                aria-label={t("orch.removeImage")}
                title={t("orch.removeImage")}
                onClick={() => setImages((prev) => prev.filter((_, at) => at !== idx))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="viby-slash-menu" role="listbox">
          {suggestions.map((item, idx) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={idx === Math.min(activeIdx, suggestions.length - 1)}
              className={`menu-item viby-slash-item${idx === Math.min(activeIdx, suggestions.length - 1) ? " active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                applySuggestion(item);
              }}
            >
              <span className="mono">{item.label}</span>
              {item.detail && <span className="faint small">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <Composer
        placeholder={placeholder}
        busy={busy}
        disabled={disabled}
        autoFocus={autoFocus}
        canSendEmpty={images.length > 0}
        sendLabel={sendLabel}
        voiceLabel={voiceLabel}
        voiceWords={voiceWords}
        draftKey={draftKey}
        keepKey={keepKey}
        hint={<Rich text={t("orch.composerHint")} />}
        leading={
          <button
            type="button"
            className="viby-attach-btn"
            aria-label={t("orch.attachImage")}
            title={t("orch.attachImage")}
            disabled={disabled || images.length >= MAX_IMAGES}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={15} />
          </button>
        }
        onDropFiles={(files) => {
          const imgs = files.filter((file) => file.type.startsWith("image/"));
          if (!imgs.length) return false;
          void addImageFiles(imgs);
          return imgs.length === files.length;
        }}
        onEscape={onEscape}
        onSend={async (said) => {
          setMenuHidden(true);
          setTextState({ value: "", cursor: 0 });
          const attached = images;
          const ok = await onSend(said, attached.length ? attached : undefined);
          if (ok !== false) setImages([]);
          return ok;
        }}
      />
    </div>
  );
}
