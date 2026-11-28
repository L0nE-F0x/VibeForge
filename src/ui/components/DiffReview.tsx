import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileText,
  MessageSquarePlus,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveSession } from "../../shared/api.js";
import {
  formatReviewNotes,
  parseFileDiff,
  splitPatch,
  syntaxLang,
  tokenizeLine,
  type DiffRow,
  type FoldReason,
  type LineNote,
  type PatchFile,
  type SyntaxLang,
} from "../../shared/review.js";
import { call, useAgents, useLive, useWorkspaces } from "../api.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { usePlace } from "../remember.js";
import { useNav, useToast } from "../state.js";
import { isCodingCli } from "../views/code/useWorkspacePanes.js";
import { tipProps } from "./Tooltip.js";
import { Button, Chip, Input, Menu, Notice, Popover, TextArea, cx, useOverlayStack, type MenuEntry, type MenuItem } from "./ui.js";

/** Initial lines rendered inside an unfolded file card before "Show all lines" reveals the rest. */
const INITIAL_FILE_ROWS = 1500;

export interface DiffSelection {
  picked: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onPickAll: () => void;
  onPickNone: () => void;
}

export interface DiffReviewProps {
  text: string;
  /** Remember viewed files and draft line notes under this key. */
  reviewKey?: string | null;
  /** Workspace id of the reviewed changes, so matching live CLIs sort first in Send to…. */
  workspaceId?: string | null;
  /** Live terminal id of the run being reviewed, sorted first in Send to…. */
  preferredPtyId?: string | null;
  /** Optional partial-Apply selection checkboxes (default all ticked). */
  selection?: DiffSelection;
  /** Compact read-only mode (for conflict diffs in dialogs). */
  compact?: boolean;
}

interface ComposerTarget {
  path: string;
  line: number;
  side: "new" | "old";
  code: string;
  noteId?: string;
  initial: string;
}

const EMPTY_PATHS: string[] = [];
const EMPTY_NOTES: LineNote[] = [];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLineNoteArray(value: unknown): value is LineNote[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as LineNote).id === "string" &&
        typeof (item as LineNote).path === "string" &&
        typeof (item as LineNote).line === "number" &&
        ((item as LineNote).side === "new" || (item as LineNote).side === "old") &&
        typeof (item as LineNote).body === "string",
    )
  );
}

function statusBadge(file: PatchFile, t: Translator): string | null {
  if (file.binary) return t("review.status.binary");
  if (file.status === "added") return t("review.status.added");
  if (file.status === "deleted") return t("review.status.deleted");
  if (file.status === "renamed") return t("review.status.renamed");
  return null;
}

function foldLabel(reason: FoldReason | null, lineCount: number, t: Translator): string {
  if (reason === "lock") return t("review.foldedLock");
  if (reason === "binary") return t("review.foldedBinary");
  if (reason === "large") return t("review.foldedLarge", { count: lineCount });
  return t("review.foldedMany", { count: lineCount });
}

function noteAnchorKey(line: number, side: "new" | "old"): string {
  return `${side}:${line}`;
}

function routeForSession(session: LiveSession) {
  if (session.origin === "agent-chat" && session.agentId && session.chatId) {
    return { view: "agents" as const, agentId: session.agentId, tab: "chats" as const, chatId: session.chatId };
  }
  if (session.origin === "chat" && session.chatId) return { view: "chat" as const, chatId: session.chatId };
  if (session.origin === "task" && session.taskId) return { view: "tasks" as const, taskId: session.taskId };
  if (session.workspaceId) return { view: "code" as const, workspaceId: session.workspaceId, ptyId: session.ptyId };
  return null;
}

function TokenizedCode({ code, lang }: { code: string; lang: SyntaxLang }) {
  const tokens = useMemo(() => tokenizeLine(code, lang), [code, lang]);
  if (!code) return <> </>;
  if (tokens.length === 1 && !tokens[0].kind) return <>{tokens[0].text}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.kind ? (
          <span key={index} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

function InlineNoteComposer({
  target,
  onSave,
  onCancel,
}: {
  target: ComposerTarget;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [body, setBody] = useState(target.initial);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useOverlayStack(boxRef, onCancel, { trap: false });
  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const submit = () => {
    if (!body.trim()) return;
    onSave(body.trim());
  };

  return (
    <div ref={boxRef} className="diff-note-edit" onClick={(event) => event.stopPropagation()}>
      <div className="diff-note-target mono">
        {target.path}:{target.line}
      </div>
      <TextArea
        ref={areaRef}
        rows={2}
        value={body}
        placeholder={t("review.notePlaceholder", { file: target.path, line: target.line })}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="hstack">
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={!body.trim()} onClick={submit}>
          {t("review.saveNote")}
        </Button>
      </div>
    </div>
  );
}

const FileDiffBody = memo(function FileDiffBody({
  file,
  interactive,
  notes,
  composer,
  onOpenComposer,
  onSaveNote,
  onCancelComposer,
  onDeleteNote,
}: {
  file: PatchFile;
  interactive: boolean;
  notes: readonly LineNote[];
  composer: ComposerTarget | null;
  onOpenComposer: (target: ComposerTarget) => void;
  onSaveNote: (target: ComposerTarget, body: string) => void;
  onCancelComposer: () => void;
  onDeleteNote: (noteId: string) => void;
}) {
  const t = useT();
  const rows = useMemo(() => parseFileDiff(file.raw), [file.raw]);
  const lang = useMemo(() => syntaxLang(file.path), [file.path]);
  const [showAll, setShowAll] = useState(false);

  const notesByLine = useMemo(() => {
    const map = new Map<string, LineNote[]>();
    for (const note of notes) {
      const key = noteAnchorKey(note.line, note.side);
      const list = map.get(key) ?? [];
      list.push(note);
      map.set(key, list);
    }
    return map;
  }, [notes]);

  const truncated = !showAll && rows.length > INITIAL_FILE_ROWS;
  const visibleRows = truncated ? rows.slice(0, INITIAL_FILE_ROWS) : rows;

  const openForRow = (row: Extract<DiffRow, { kind: "add" | "del" | "ctx" }>, existing?: LineNote) => {
    if (!interactive) return;
    const line = row.kind === "del" ? row.oldNo : row.newNo;
    const side: "new" | "old" = row.kind === "del" ? "old" : "new";
    onOpenComposer({
      path: file.path,
      line,
      side,
      code: row.code,
      noteId: existing?.id,
      initial: existing?.body ?? "",
    });
  };

  return (
    <div className="diff-table">
      {visibleRows.map((row, index) => {
        if (row.kind === "hunk" || row.kind === "meta") {
          return (
            <div key={index} className={cx("diff-row", row.kind)}>
              <span className="diff-ln" />
              <span className="diff-ln" />
              <span className="diff-sign" />
              <span className="diff-code">{row.text || " "}</span>
            </div>
          );
        }
        const line = row.kind === "del" ? row.oldNo : row.newNo;
        const side: "new" | "old" = row.kind === "del" ? "old" : "new";
        const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
        const rowNotes = interactive ? (notesByLine.get(noteAnchorKey(line, side)) ?? []) : [];
        const editingHere = Boolean(interactive && composer && composer.line === line && composer.side === side);
        return (
          <div key={index} className="diff-row-group">
            <div
              className={cx("diff-row", row.kind, interactive && "can-note", rowNotes.length > 0 && "has-note")}
              onClick={
                interactive
                  ? () => {
                      const selected = typeof window !== "undefined" ? window.getSelection()?.toString() : "";
                      if (selected) return;
                      openForRow(row);
                    }
                  : undefined
              }
            >
              <span className="diff-ln">{row.oldNo ?? ""}</span>
              <span className="diff-ln">{row.newNo ?? ""}</span>
              <span className="diff-sign">
                {interactive ? (
                  <button
                    type="button"
                    className="diff-note-trigger"
                    aria-label={`${t("review.addNote")} (${file.path}:${line})`}
                    title={t("review.addNote")}
                    onClick={(event) => {
                      event.stopPropagation();
                      openForRow(row);
                    }}
                  >
                    <MessageSquarePlus size={12} />
                  </button>
                ) : null}
                <span className="diff-sign-char">{sign}</span>
              </span>
              <span className="diff-code">
                <TokenizedCode code={row.code} lang={lang} />
              </span>
            </div>
            {rowNotes.map((note) => (
              <div key={note.id} className="diff-note">
                <div className="diff-note-head">
                  <span className="mono faint">
                    {note.path}:{note.line}
                  </span>
                  <span className="grow" />
                  <button
                    type="button"
                    className="diff-note-btn"
                    title={t("review.editNote")}
                    onClick={() => openForRow(row, note)}
                  >
                    <Pencil size={11} />
                    <span>{t("review.editNote")}</span>
                  </button>
                  <button
                    type="button"
                    className="diff-note-btn danger"
                    title={t("review.removeNote")}
                    onClick={() => onDeleteNote(note.id)}
                  >
                    <Trash2 size={11} />
                    <span>{t("review.removeNote")}</span>
                  </button>
                </div>
                <div className="diff-note-body">{note.body}</div>
              </div>
            ))}
            {editingHere && composer && (
              <InlineNoteComposer
                key={`${composer.path}:${composer.side}:${composer.line}:${composer.noteId ?? "new"}`}
                target={composer}
                onSave={(body) => onSaveNote(composer, body)}
                onCancel={onCancelComposer}
              />
            )}
          </div>
        );
      })}
      {truncated && (
        <div className="diff-more">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {t("review.showAllLines", { count: rows.length })}
          </Button>
        </div>
      )}
    </div>
  );
});

const FileDiffCard = memo(function FileDiffCard({
  file,
  folded,
  viewed,
  checked,
  hasCheckbox,
  interactive,
  notes,
  composer,
  onToggleFold,
  onToggleViewed,
  onToggleChecked,
  onOpenComposer,
  onSaveNote,
  onCancelComposer,
  onDeleteNote,
}: {
  file: PatchFile;
  folded: boolean;
  viewed: boolean;
  checked: boolean;
  hasCheckbox: boolean;
  interactive: boolean;
  notes: readonly LineNote[];
  composer: ComposerTarget | null;
  onToggleFold: (path: string) => void;
  onToggleViewed: (path: string) => void;
  onToggleChecked: (path: string) => void;
  onOpenComposer: (target: ComposerTarget) => void;
  onSaveNote: (target: ComposerTarget, body: string) => void;
  onCancelComposer: () => void;
  onDeleteNote: (noteId: string) => void;
}) {
  const t = useT();
  const badge = statusBadge(file, t);
  return (
    <section className={cx("diff-card", folded && "is-folded", viewed && "is-viewed")} data-diff-file={file.path} data-line={file.headerLine}>
      <div className="diff-card-head">
        <button
          type="button"
          className="diff-card-toggle"
          aria-expanded={!folded}
          onClick={() => onToggleFold(file.path)}
        >
          {folded ? <ChevronRight size={14} className="faint" /> : <ChevronDown size={14} className="faint" />}
        </button>
        {hasCheckbox && (
          <input
            type="checkbox"
            className="diff-check"
            checked={checked}
            aria-label={file.path}
            title={t("review.includeTip")}
            onChange={() => onToggleChecked(file.path)}
          />
        )}
        <button
          type="button"
          className="diff-card-path mono truncate grow"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          onClick={() => onToggleFold(file.path)}
        >
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </button>
        {badge && <Chip tone={file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : "info"}>{badge}</Chip>}
        {notes.length > 0 && <Chip tone="accent">{t.count("review.notesCount", notes.length)}</Chip>}
        {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
        {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
        <button
          type="button"
          className={cx("diff-viewed-btn", viewed && "is-on")}
          aria-pressed={viewed}
          {...tipProps(t("review.viewedTip"))}
          onClick={() => onToggleViewed(file.path)}
        >
          <Check size={12} />
          <span>{t("review.viewed")}</span>
        </button>
      </div>
      {folded ? (
        <button type="button" className="diff-folded" onClick={() => onToggleFold(file.path)}>
          <span className="faint">{foldLabel(file.foldReason, file.lineCount, t)}</span>
          <span className="accent-text">{t("review.showDiff")}</span>
        </button>
      ) : (
        <FileDiffBody
          file={file}
          interactive={interactive}
          notes={notes}
          composer={composer}
          onOpenComposer={onOpenComposer}
          onSaveNote={onSaveNote}
          onCancelComposer={onCancelComposer}
          onDeleteNote={onDeleteNote}
        />
      )}
    </section>
  );
});

function LiveSendButton({
  formatted,
  workspaceId,
  preferredPtyId,
}: {
  formatted: string;
  workspaceId?: string | null;
  preferredPtyId?: string | null;
}) {
  const t = useT();
  const { go } = useNav();
  const { push, fail } = useToast();
  const live = useLive().data ?? [];
  const agents = useAgents().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const targets = useMemo(() => {
    const place = (session: LiveSession): string | null => {
      const elsewhere = workspaceId && session.workspaceId === workspaceId ? null : (workspaces.find((w) => w.id === session.workspaceId)?.name ?? null);
      const views: Partial<Record<NonNullable<LiveSession["origin"]>, Key>> = {
        task: "rail.tasks",
        chat: "rail.chat",
        "agent-chat": "rail.agents",
        routine: "rail.routines",
      };
      const view = session.origin && views[session.origin] ? t(views[session.origin]!) : null;
      return [view, elsewhere].filter(Boolean).join(" · ") || null;
    };

    const score = (session: LiveSession): number => {
      if (preferredPtyId && session.ptyId === preferredPtyId) return 0;
      if (workspaceId && session.workspaceId === workspaceId) return 1;
      return 2;
    };

    return live
      .filter(isCodingCli)
      .map((session) => ({
        session,
        rank: score(session),
        label: agents.find((agent) => agent.id === session.agentId)?.name ?? (session.program || session.title.split(" · ")[0] || session.title),
        where: place(session),
      }))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }, [live, agents, workspaces, workspaceId, preferredPtyId, t]);

  const sendTo = async (session: LiveSession, label: string) => {
    try {
      const res = await call("talk.sendDraft", null, session.ptyId, "notes", formatted);
      if (!res.sent) return;
      push("info", t("talk.draftLeft", { name: label }), t("talk.draftLeftBody"));
      const route = routeForSession(session);
      if (route) go(route);
    } catch (error) {
      fail(error, t("talk.failed"));
    }
  };

  const items: MenuEntry[] = targets.length
    ? targets.map(
        (target): MenuItem => ({
          label: target.label,
          hint: target.where ?? undefined,
          onSelect: () => void sendTo(target.session, target.label),
        }),
      )
    : [{ label: t("review.noCliOpen"), disabled: true, onSelect: () => undefined }];

  return (
    <>
      <Button size="sm" variant="primary" icon={Send} pressed={Boolean(anchor)} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        {t("talk.sendTo")}
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} align="end">
          <div className="menu-head faint">{t("talk.sendTo")}</div>
          <Menu items={items} onClose={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  );
}

function NotesBar({
  notes,
  fileOrder,
  workspaceId,
  preferredPtyId,
  onClear,
}: {
  notes: readonly LineNote[];
  fileOrder: readonly string[];
  workspaceId?: string | null;
  preferredPtyId?: string | null;
  onClear: () => void;
}) {
  const t = useT();
  const { push, fail } = useToast();
  const formatted = useMemo(() => formatReviewNotes(notes, fileOrder), [notes, fileOrder]);

  const copyNotes = async () => {
    try {
      if (typeof window !== "undefined" && window.vibeforge) await call("app.copyText", formatted);
      else await navigator.clipboard.writeText(formatted);
      push("success", t("review.notesCopied"));
    } catch (error) {
      fail(error, t("common.failed"));
    }
  };

  return (
    <div className="review-notes-bar">
      <Chip tone="accent">{t.count("review.notesCount", notes.length)}</Chip>
      <span className="grow" />
      {typeof window !== "undefined" ? (
        <LiveSendButton formatted={formatted} workspaceId={workspaceId} preferredPtyId={preferredPtyId} />
      ) : (
        <Button size="sm" variant="primary" icon={Send}>
          {t("talk.sendTo")}
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copyNotes()}>
        {t("review.copyNotes")}
      </Button>
      <Button size="sm" variant="ghost" icon={Trash2} onClick={onClear}>
        {t("review.clearNotes")}
      </Button>
    </div>
  );
}

/**
 * Interactive diff review screen: file list with counts, per-file folding (big/lock/binary files
 * start folded and render lazily), remembered viewed ticks, light syntax colours, inline line
 * notes sent through Send to…, and optional partial-Apply file checkboxes.
 */
export const DiffReview = memo(function DiffReview({
  text,
  reviewKey = null,
  workspaceId = null,
  preferredPtyId = null,
  selection,
  compact = false,
}: DiffReviewProps) {
  const t = useT();
  const parsed = useMemo(() => splitPatch(text), [text]);
  const [viewedPaths, setViewedPaths] = usePlace<string[]>("run.viewed", compact ? null : reviewKey, EMPTY_PATHS, isStringArray);
  const [notes, setNotes] = usePlace<LineNote[]>("run.notes", compact ? null : reviewKey, EMPTY_NOTES, isLineNoteArray);
  const [manualFold, setManualFold] = useState<Map<string, boolean>>(() => new Map());
  const [filter, setFilter] = useState("");
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const diffBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setManualFold(new Map());
    setFilter("");
    setComposer(null);
  }, [reviewKey, text]);

  const viewedSet = useMemo(() => new Set(viewedPaths), [viewedPaths]);
  const notesByFile = useMemo(() => {
    const map = new Map<string, LineNote[]>();
    for (const note of notes) {
      const list = map.get(note.path) ?? [];
      list.push(note);
      map.set(note.path, list);
    }
    return map;
  }, [notes]);

  const fileOrder = useMemo(() => parsed.files.map((file) => file.path), [parsed.files]);
  const query = filter.trim().toLowerCase();
  const shownFiles = useMemo(() => (query ? parsed.files.filter((file) => file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query)) : parsed.files), [parsed.files, query]);

  const isFolded = useCallback(
    (file: PatchFile) => {
      const override = manualFold.get(file.path);
      if (override !== undefined) return override;
      return viewedSet.has(file.path) || file.startFolded;
    },
    [manualFold, viewedSet],
  );

  const toggleFold = useCallback(
    (filePath: string) => {
      setManualFold((prev) => {
        const file = parsed.files.find((item) => item.path === filePath);
        const current = prev.get(filePath) ?? (viewedSet.has(filePath) || Boolean(file?.startFolded));
        const next = new Map(prev);
        next.set(filePath, !current);
        return next;
      });
    },
    [parsed.files, viewedSet],
  );

  const toggleViewed = useCallback(
    (filePath: string) => {
      const nowViewed = !viewedSet.has(filePath);
      const next = nowViewed ? [...viewedSet, filePath] : viewedPaths.filter((item) => item !== filePath);
      setViewedPaths(next);
      setManualFold((prev) => {
        const copy = new Map(prev);
        copy.set(filePath, nowViewed);
        return copy;
      });
    },
    [viewedSet, viewedPaths, setViewedPaths],
  );

  const expandAll = () => {
    setManualFold((prev) => {
      const next = new Map(prev);
      for (const file of shownFiles) next.set(file.path, false);
      return next;
    });
  };

  const foldAll = () => {
    setManualFold((prev) => {
      const next = new Map(prev);
      for (const file of shownFiles) next.set(file.path, true);
      return next;
    });
  };

  const openAndJump = (filePath: string) => {
    setManualFold((prev) => {
      const next = new Map(prev);
      next.set(filePath, false);
      return next;
    });
    const scroll = () => {
      const target = [...(diffBox.current?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? [])].find((node) => node.dataset.diffFile === filePath);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(scroll);
    else scroll();
  };

  const saveNote = useCallback(
    (target: ComposerTarget, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      if (target.noteId) {
        setNotes(notes.map((item) => (item.id === target.noteId ? { ...item, body: trimmed } : item)));
      } else {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setNotes([...notes, { id, path: target.path, line: target.line, side: target.side, code: target.code, body: trimmed }]);
      }
      setComposer(null);
    },
    [notes, setNotes],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      setNotes(notes.filter((item) => item.id !== noteId));
    },
    [notes, setNotes],
  );

  const noop = useCallback(() => undefined, []);

  if (!text.trim()) return <Notice>{t("run.noDiff")}</Notice>;

  if (compact) {
    return (
      <div className="diff review-compact">
        {parsed.files.map((file) => (
          <div key={`${file.headerLine}:${file.path}`} className="diff-card">
            {parsed.files.length > 1 && (
              <div className="diff-card-head">
                <FileText size={13} className="faint" />
                <span className="diff-card-path mono truncate grow">{file.path}</span>
                {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
                {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
              </div>
            )}
            <FileDiffBody
              file={file}
              interactive={false}
              notes={EMPTY_NOTES}
              composer={null}
              onOpenComposer={noop}
              onSaveNote={noop}
              onCancelComposer={noop}
              onDeleteNote={noop}
            />
          </div>
        ))}
        {parsed.files.length === 0 && <pre className="pre">{text.trim()}</pre>}
      </div>
    );
  }

  if (parsed.files.length === 0) {
    return <Notice>{parsed.notes.length ? parsed.notes.join(" · ") : text.trim()}</Notice>;
  }

  const totalAdded = parsed.files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = parsed.files.reduce((sum, file) => sum + file.removed, 0);
  const viewedCount = parsed.files.filter((file) => viewedSet.has(file.path)).length;
  const pickedCount = selection ? parsed.files.filter((file) => selection.picked.has(file.path)).length : 0;

  return (
    <div className="review-wrap">
      <div className="review-toolbar">
        <span className="mono">{t.count("review.files", parsed.files.length)}</span>
        {totalAdded > 0 && <span className="diff-count add">+{totalAdded}</span>}
        {totalRemoved > 0 && <span className="diff-count del">−{totalRemoved}</span>}
        <span className="faint">{t("review.viewedCount", { viewed: viewedCount, total: parsed.files.length })}</span>
        {selection && (
          <>
            <span className="faint">·</span>
            <span className="faint">{t("review.selectedCount", { picked: pickedCount, total: parsed.files.length })}</span>
            <Button size="sm" variant="ghost" disabled={pickedCount === parsed.files.length} onClick={selection.onPickAll}>
              {t("review.selectAll")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pickedCount === 0} onClick={selection.onPickNone}>
              {t("review.selectNone")}
            </Button>
          </>
        )}
        <span className="grow" />
        {parsed.files.length > 5 && (
          <Input
            className="review-filter"
            value={filter}
            placeholder={t("review.filterFiles")}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <Button size="sm" variant="ghost" icon={ChevronsUpDown} onClick={expandAll}>
          {t("review.expandAll")}
        </Button>
        <Button size="sm" variant="ghost" icon={ChevronsDownUp} onClick={foldAll}>
          {t("review.foldAll")}
        </Button>
      </div>
      {notes.length > 0 && (
        <NotesBar
          notes={notes}
          fileOrder={fileOrder}
          workspaceId={workspaceId}
          preferredPtyId={preferredPtyId}
          onClear={() => setNotes([])}
        />
      )}
      <div className="review-layout">
        <div className="diff-files review-files">
          {shownFiles.map((file) => {
            const viewed = viewedSet.has(file.path);
            const fileNotes = notesByFile.get(file.path) ?? EMPTY_NOTES;
            return (
              <div key={`${file.headerLine}:${file.path}`} className={cx("diff-file", viewed && "is-viewed")}>
                {selection && (
                  <input
                    type="checkbox"
                    className="diff-check"
                    checked={selection.picked.has(file.path)}
                    aria-label={file.path}
                    title={t("review.includeTip")}
                    onChange={() => selection.onToggle(file.path)}
                  />
                )}
                <button type="button" className="diff-file-jump" onClick={() => openAndJump(file.path)}>
                  <FileText size={13} className="faint" />
                  <span className="mono truncate grow" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                    {file.path}
                  </span>
                  {fileNotes.length > 0 && <span className="diff-note-pill">{fileNotes.length}</span>}
                  {viewed && <Check size={12} className="accent-text" />}
                  {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
                  {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div ref={diffBox} className="diff review-diffs">
          {shownFiles.map((file) => (
            <FileDiffCard
              key={`${file.headerLine}:${file.path}`}
              file={file}
              folded={isFolded(file)}
              viewed={viewedSet.has(file.path)}
              checked={selection ? selection.picked.has(file.path) : true}
              hasCheckbox={Boolean(selection)}
              interactive
              notes={notesByFile.get(file.path) ?? EMPTY_NOTES}
              composer={composer && composer.path === file.path ? composer : null}
              onToggleFold={toggleFold}
              onToggleViewed={toggleViewed}
              onToggleChecked={selection ? selection.onToggle : noop}
              onOpenComposer={setComposer}
              onSaveNote={saveNote}
              onCancelComposer={() => setComposer(null)}
              onDeleteNote={deleteNote}
            />
          ))}
        </div>
      </div>
      {parsed.notes.length > 0 && <Notice>{parsed.notes.join(" · ")}</Notice>}
    </div>
  );
});
