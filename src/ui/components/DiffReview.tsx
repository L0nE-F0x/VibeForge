import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, FileText, MessageSquarePlus, Pencil, Send, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { LiveSession } from "../../shared/api.js";
import {
  formatReviewNotes,
  notesThatFit,
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
import type { DiffSelection } from "../copy-pick.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { usePlace } from "../remember.js";
import { useNav, useToast } from "../state.js";
import { isCodingCli } from "../views/code/useWorkspacePanes.js";
import { tipProps } from "./Tooltip.js";
import { Button, Chip, Input, Menu, Notice, Popover, TextArea, cx, useOverlayStack, type MenuEntry, type MenuItem } from "./ui.js";

/** Initial lines rendered inside an unfolded file card before "Show all lines" reveals the rest. */
const INITIAL_FILE_ROWS = 1500;

export interface DiffReviewProps {
  text: string;
  /** Remember viewed files and draft line notes under this key. */
  reviewKey?: string | null;
  /** Workspace id of the reviewed changes, so matching live CLIs sort first in Send to…. */
  workspaceId?: string | null;
  /** Live terminal id of the run being reviewed, sorted first in Send to…. */
  preferredPtyId?: string | null;
  /** The folder the changes are in, named at the top of the notes so a CLI elsewhere finds the files. */
  folder?: string | null;
  /** Optional partial-Apply selection checkboxes. */
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

/** What a file's notes can do, the same object for every file so a click redraws only the file it is in. */
interface NoteActions {
  open: (target: ComposerTarget) => void;
  save: (target: ComposerTarget, body: string) => void;
  cancel: () => void;
  remove: (noteId: string) => void;
}

type CodeRow = Extract<DiffRow, { kind: "add" | "del" | "ctx" }>;

const EMPTY_PATHS: string[] = [];
const EMPTY_NOTES: LineNote[] = [];
const NO_SET: ReadonlySet<string> = new Set();
const noop = () => undefined;
const NOOP_ACTIONS: NoteActions = { open: noop, save: noop, cancel: noop, remove: noop };

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

/** A viewed tick is for this version of the file: a file changed again after Continue shows again. */
function viewedKey(file: PatchFile): string {
  return `${file.key}:${file.path}`;
}

/**
 * About how tall a file's card is, for the browser to hold its place while it is off screen (see
 * `content-visibility` in diff.css), so cards drawn as they scroll in don't push the others about.
 */
function cardHeight(file: PatchFile, folded: boolean): number {
  const head = 36;
  if (folded) return head + 36;
  return head + 8 + Math.min(Math.max(file.lineCount - 4, 1), INITIAL_FILE_ROWS) * 19;
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

function isCode(row: DiffRow | undefined): row is CodeRow {
  return row !== undefined && (row.kind === "add" || row.kind === "del" || row.kind === "ctx");
}

function rowLine(row: CodeRow): number {
  return row.kind === "del" ? row.oldNo : row.newNo;
}

function rowSide(row: CodeRow): "new" | "old" {
  return row.kind === "del" ? "old" : "new";
}

function anchorKey(line: number, side: "new" | "old"): string {
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

function codeSpans(code: string, lang: SyntaxLang): ReactNode {
  if (!code) return " ";
  const tokens = tokenizeLine(code, lang);
  if (tokens.length === 1 && !tokens[0].kind) return tokens[0].text;
  return tokens.map((token, index) =>
    token.kind ? (
      <span key={index} className={`tok-${token.kind}`}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  );
}

/**
 * One line of a diff. Plain elements only, built once per file: the note button is one per file
 * (see FileDiffBody), and clicks are handled by the table around them.
 */
function rowElement(row: DiffRow, index: number, lang: SyntaxLang, interactive: boolean, noted: boolean): ReactNode {
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
  return (
    <div key={index} data-i={index} className={cx("diff-row", row.kind, interactive && "can-note", noted && "has-note")}>
      <span className="diff-ln">{row.oldNo ?? ""}</span>
      <span className="diff-ln">{row.newNo ?? ""}</span>
      <span className="diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
      <span className="diff-code">{codeSpans(row.code, lang)}</span>
    </div>
  );
}

function InlineNoteComposer({ target, onSave, onCancel }: { target: ComposerTarget; onSave: (target: ComposerTarget, body: string) => void; onCancel: () => void }) {
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
    onSave(target, body.trim());
  };

  return (
    <div ref={boxRef} className="diff-note-edit">
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

function NoteBlock({ note, onEdit, onRemove }: { note: LineNote; onEdit: (note: LineNote) => void; onRemove: (noteId: string) => void }) {
  const t = useT();
  return (
    <div className="diff-note">
      <div className="diff-note-head">
        <span className="mono faint">
          {note.path}:{note.line}
        </span>
        <span className="grow" />
        <button type="button" className="diff-note-btn" title={t("review.editNote")} onClick={() => onEdit(note)}>
          <Pencil size={11} />
          <span>{t("review.editNote")}</span>
        </button>
        <button type="button" className="diff-note-btn danger" title={t("review.removeNote")} onClick={() => onRemove(note.id)}>
          <Trash2 size={11} />
          <span>{t("review.removeNote")}</span>
        </button>
      </div>
      <div className="diff-note-body">{note.body}</div>
    </div>
  );
}

const FileDiffBody = memo(function FileDiffBody({
  file,
  interactive,
  notes,
  composer,
  actions,
}: {
  file: PatchFile;
  interactive: boolean;
  notes: readonly LineNote[];
  composer: ComposerTarget | null;
  actions: NoteActions;
}) {
  const t = useT();
  const rows = useMemo(() => parseFileDiff(file.raw), [file.raw]);
  const lang = useMemo(() => syntaxLang(file.path), [file.path]);
  const [showAll, setShowAll] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const table = useRef<HTMLDivElement>(null);

  const truncated = !showAll && rows.length > INITIAL_FILE_ROWS;
  const visibleRows = useMemo(() => (truncated ? rows.slice(0, INITIAL_FILE_ROWS) : rows), [rows, truncated]);
  // Built once per file: a tick or a note elsewhere leaves these alone.
  const rowEls = useMemo(() => visibleRows.map((row, index) => rowElement(row, index, lang, interactive, false)), [visibleRows, lang, interactive]);

  const notesByLine = useMemo(() => {
    const map = new Map<string, LineNote[]>();
    for (const note of notes) {
      const key = anchorKey(note.line, note.side);
      map.set(key, [...(map.get(key) ?? []), note]);
    }
    return map;
  }, [notes]);

  const openAt = (index: number, existing?: LineNote) => {
    const row = visibleRows[index];
    if (!interactive || !isCode(row)) return;
    actions.open({ path: file.path, line: rowLine(row), side: rowSide(row), code: row.code, noteId: existing?.id, initial: existing?.body ?? "" });
  };

  // The one note button follows the pointer (or the arrow keys) from line to line.
  const place = (rowEl: HTMLElement) => {
    const button = trigger.current;
    const index = Number(rowEl.dataset.i);
    const row = visibleRows[index];
    if (!button || !isCode(row)) return;
    button.dataset.at = String(index);
    button.style.top = `${rowEl.offsetTop}px`;
    button.style.height = `${rowEl.offsetHeight}px`;
    button.setAttribute("aria-label", `${t("review.addNote")} (${file.path}:${rowLine(row)})`);
  };
  const rowAt = (index: number) => table.current?.querySelector<HTMLElement>(`:scope > [data-i="${index}"]`) ?? null;
  const onHover = (event: MouseEvent<HTMLDivElement>) => {
    const rowEl = (event.target as Element).closest<HTMLElement>("[data-i]");
    if (rowEl && rowEl.parentElement === table.current) place(rowEl);
  };
  const onClickRow = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".diff-note, .diff-note-edit, button")) return;
    const rowEl = target.closest<HTMLElement>("[data-i]");
    if (!rowEl || rowEl.parentElement !== table.current) return;
    if (window.getSelection()?.toString()) return;
    openAt(Number(rowEl.dataset.i));
  };
  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    for (let index = Number(event.currentTarget.dataset.at ?? -1) + step; index >= 0 && index < visibleRows.length; index += step) {
      const rowEl = isCode(visibleRows[index]) ? rowAt(index) : null;
      if (rowEl) {
        place(rowEl);
        rowEl.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  };
  const onTriggerFocus = () => {
    if (trigger.current?.dataset.at) return;
    const first = visibleRows.findIndex(isCode);
    const rowEl = first >= 0 ? rowAt(first) : null;
    if (rowEl) place(rowEl);
  };
  const onEdit = (note: LineNote) => actions.open({ path: file.path, line: note.line, side: note.side, code: note.code ?? "", noteId: note.id, initial: note.body });

  const children: ReactNode[] = [];
  for (let index = 0; index < visibleRows.length; index += 1) {
    const row = visibleRows[index];
    if (!interactive || !isCode(row)) {
      children.push(rowEls[index]);
      continue;
    }
    const key = anchorKey(rowLine(row), rowSide(row));
    const here = notesByLine.get(key);
    const editing = composer !== null && anchorKey(composer.line, composer.side) === key;
    if (!here && !editing) {
      children.push(rowEls[index]);
      continue;
    }
    children.push(here ? rowElement(row, index, lang, interactive, true) : rowEls[index]);
    for (const note of here ?? []) children.push(<NoteBlock key={`note:${note.id}`} note={note} onEdit={onEdit} onRemove={actions.remove} />);
    if (editing && composer) {
      children.push(<InlineNoteComposer key={`edit:${key}:${composer.noteId ?? "new"}`} target={composer} onSave={actions.save} onCancel={actions.cancel} />);
    }
  }

  return (
    <div ref={table} className="diff-table" onMouseOver={interactive ? onHover : undefined} onClick={interactive ? onClickRow : undefined}>
      {interactive && (
        <button
          ref={trigger}
          type="button"
          className="diff-note-trigger"
          aria-label={t("review.addNote")}
          title={t("review.addNote")}
          onFocus={onTriggerFocus}
          onKeyDown={onTriggerKey}
          onClick={(event) => openAt(Number(event.currentTarget.dataset.at ?? -1))}
        >
          <MessageSquarePlus size={12} />
        </button>
      )}
      {children}
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
  applied,
  hasCheckbox,
  notes,
  composer,
  onToggleFold,
  onToggleViewed,
  onToggleChecked,
  actions,
}: {
  file: PatchFile;
  folded: boolean;
  viewed: boolean;
  checked: boolean;
  applied: boolean;
  hasCheckbox: boolean;
  notes: readonly LineNote[];
  composer: ComposerTarget | null;
  onToggleFold: (path: string) => void;
  onToggleViewed: (file: PatchFile) => void;
  onToggleChecked: (path: string) => void;
  actions: NoteActions;
}) {
  const t = useT();
  const badge = statusBadge(file, t);
  const name = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const card = useRef<HTMLElement>(null);
  // A file that starts folded draws its lines once it first comes near the screen: Expand all on a
  // big review draws only what can be seen, and the rest as it scrolls in.
  const [near, setNear] = useState(!file.startFolded);
  useEffect(() => {
    const node = card.current;
    if (near || folded || !node || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), { rootMargin: "800px 0px" });
    watch.observe(node);
    return () => watch.disconnect();
  }, [near, folded]);
  return (
    <section ref={card} className={cx("diff-card", folded && "is-folded", viewed && "is-viewed")} style={{ containIntrinsicSize: `auto ${cardHeight(file, folded)}px` }} data-diff-file={file.path} data-line={file.headerLine}>
      <div className="diff-card-head">
        <button type="button" className="diff-card-toggle" aria-expanded={!folded} onClick={() => onToggleFold(file.path)}>
          {folded ? <ChevronRight size={14} className="faint" /> : <ChevronDown size={14} className="faint" />}
        </button>
        {hasCheckbox && (
          <input type="checkbox" className="diff-check" checked={checked} aria-label={file.path} title={t(applied ? "review.appliedTip" : "review.includeTip")} onChange={() => onToggleChecked(file.path)} />
        )}
        <button type="button" className="diff-card-path mono truncate grow" title={name} onClick={() => onToggleFold(file.path)}>
          {name}
        </button>
        {applied && (
          <Chip tone="ok" title={t("review.appliedTip")}>
            {t("review.applied")}
          </Chip>
        )}
        {badge && <Chip tone={file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : "info"}>{badge}</Chip>}
        {notes.length > 0 && <Chip tone="accent">{t.count("review.notesCount", notes.length)}</Chip>}
        {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
        {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
        <button type="button" className={cx("diff-viewed-btn", viewed && "is-on")} aria-pressed={viewed} {...tipProps(t("review.viewedTip"))} onClick={() => onToggleViewed(file)}>
          <Check size={12} />
          <span>{t("review.viewed")}</span>
        </button>
      </div>
      {folded ? (
        <button type="button" className="diff-folded" onClick={() => onToggleFold(file.path)}>
          <span className="faint">{foldLabel(file.foldReason, file.lineCount, t)}</span>
          <span className="accent-text">{t("review.showDiff")}</span>
        </button>
      ) : near ? (
        <FileDiffBody file={file} interactive notes={notes} composer={composer} actions={actions} />
      ) : (
        <div className="diff-pending" style={{ height: cardHeight(file, false) - 36 }} />
      )}
    </section>
  );
});

const FileListRow = memo(function FileListRow({
  file,
  viewed,
  checked,
  applied,
  hasCheckbox,
  noteCount,
  onToggleChecked,
  onJump,
}: {
  file: PatchFile;
  viewed: boolean;
  checked: boolean;
  applied: boolean;
  hasCheckbox: boolean;
  noteCount: number;
  onToggleChecked: (path: string) => void;
  onJump: (path: string) => void;
}) {
  const t = useT();
  return (
    <div className={cx("diff-file", viewed && "is-viewed")}>
      {hasCheckbox && (
        <input type="checkbox" className="diff-check" checked={checked} aria-label={file.path} title={t(applied ? "review.appliedTip" : "review.includeTip")} onChange={() => onToggleChecked(file.path)} />
      )}
      <button type="button" className="diff-file-jump" onClick={() => onJump(file.path)}>
        <FileText size={13} className="faint" />
        <span className="mono truncate grow" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.path}
        </span>
        {applied && <span className="diff-applied">{t("review.applied")}</span>}
        {noteCount > 0 && <span className="diff-note-pill">{noteCount}</span>}
        {viewed && <Check size={12} className="accent-text" />}
        {file.added > 0 && <span className="diff-count add">+{file.added}</span>}
        {file.removed > 0 && <span className="diff-count del">−{file.removed}</span>}
      </button>
    </div>
  );
});

function LiveSendButton({ formatted, workspaceId, preferredPtyId }: { formatted: string; workspaceId?: string | null; preferredPtyId?: string | null }) {
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
  folder,
  workspaceId,
  preferredPtyId,
  onClear,
}: {
  notes: readonly LineNote[];
  fileOrder: readonly string[];
  folder?: string | null;
  workspaceId?: string | null;
  preferredPtyId?: string | null;
  onClear: () => void;
}) {
  const t = useT();
  const { push, fail } = useToast();
  const formatted = useMemo(() => formatReviewNotes(notes, fileOrder, folder), [notes, fileOrder, folder]);

  const copyNotes = async () => {
    try {
      await call("app.copyText", formatted);
      push("success", t("review.notesCopied"));
    } catch (error) {
      fail(error, t("common.failed"));
    }
  };

  return (
    <div className="review-notes-bar">
      <Chip tone="accent">{t.count("review.notesCount", notes.length)}</Chip>
      <span className="grow" />
      <LiveSendButton formatted={formatted} workspaceId={workspaceId} preferredPtyId={preferredPtyId} />
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
export const DiffReview = memo(function DiffReview({ text, reviewKey = null, workspaceId = null, preferredPtyId = null, folder = null, selection, compact = false }: DiffReviewProps) {
  const t = useT();
  const parsed = useMemo(() => splitPatch(text), [text]);
  const [viewedKeys, setViewedKeys] = usePlace<string[]>("run.viewed", compact ? null : reviewKey, EMPTY_PATHS, isStringArray);
  const [savedNotes, setNotes] = usePlace<LineNote[]>("run.notes", compact ? null : reviewKey, EMPTY_NOTES, isLineNoteArray);
  const [manualFold, setManualFold] = useState<Map<string, boolean>>(() => new Map());
  const [filter, setFilter] = useState("");
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const diffBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setManualFold(new Map());
    setFilter("");
    setComposer(null);
  }, [reviewKey, text]);

  const viewedSet = useMemo(() => new Set(viewedKeys), [viewedKeys]);
  const isViewed = useCallback((file: PatchFile) => viewedSet.has(viewedKey(file)), [viewedSet]);
  // A note whose line changed or went since is dropped: it would point the CLI at the wrong line.
  const notes = useMemo(() => notesThatFit(savedNotes, parsed.files), [savedNotes, parsed.files]);
  const notesByFile = useMemo(() => {
    const map = new Map<string, LineNote[]>();
    for (const note of notes) map.set(note.path, [...(map.get(note.path) ?? []), note]);
    return map;
  }, [notes]);

  // The latest values, so the handlers below stay the same functions from render to render.
  const latest = useRef({ files: parsed.files, viewedKeys, savedNotes, viewedSet });
  latest.current = { files: parsed.files, viewedKeys, savedNotes, viewedSet };

  const fileOrder = useMemo(() => parsed.files.map((file) => file.path), [parsed.files]);
  const query = filter.trim().toLowerCase();
  const shownFiles = useMemo(() => (query ? parsed.files.filter((file) => file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query)) : parsed.files), [parsed.files, query]);

  const isFolded = (file: PatchFile) => manualFold.get(file.path) ?? (isViewed(file) || file.startFolded);

  const toggleFold = useCallback((filePath: string) => {
    setManualFold((prev) => {
      const { files, viewedSet: viewedNow } = latest.current;
      const file = files.find((item) => item.path === filePath);
      const current = prev.get(filePath) ?? Boolean(file && (viewedNow.has(viewedKey(file)) || file.startFolded));
      return new Map(prev).set(filePath, !current);
    });
  }, []);

  const toggleViewed = useCallback(
    (file: PatchFile) => {
      const key = viewedKey(file);
      const now = latest.current.viewedKeys;
      const nowViewed = !now.includes(key);
      setViewedKeys(nowViewed ? [...now, key] : now.filter((item) => item !== key));
      setManualFold((prev) => new Map(prev).set(file.path, nowViewed));
    },
    [setViewedKeys],
  );

  const actions = useMemo<NoteActions>(
    () => ({
      open: setComposer,
      cancel: () => setComposer(null),
      save: (target, body) => {
        const trimmed = body.trim();
        if (!trimmed) return;
        const now = latest.current.savedNotes;
        if (target.noteId) setNotes(now.map((item) => (item.id === target.noteId ? { ...item, body: trimmed } : item)));
        else {
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          setNotes([...now, { id, path: target.path, line: target.line, side: target.side, code: target.code, body: trimmed }]);
        }
        setComposer(null);
      },
      remove: (noteId) => setNotes(latest.current.savedNotes.filter((item) => item.id !== noteId)),
    }),
    [setNotes],
  );

  const setFoldAll = (folded: boolean) =>
    setManualFold((prev) => {
      const next = new Map(prev);
      for (const file of shownFiles) next.set(file.path, folded);
      return next;
    });

  const openAndJump = useCallback((filePath: string) => {
    setManualFold((prev) => new Map(prev).set(filePath, false));
    requestAnimationFrame(() => {
      const target = [...(diffBox.current?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? [])].find((node) => node.dataset.diffFile === filePath);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, []);

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
            <FileDiffBody file={file} interactive={false} notes={EMPTY_NOTES} composer={null} actions={NOOP_ACTIONS} />
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
  const viewedCount = parsed.files.filter(isViewed).length;
  const picked = selection?.picked ?? NO_SET;
  const applied = selection?.applied ?? NO_SET;
  const pickedCount = selection ? parsed.files.filter((file) => picked.has(file.path)).length : 0;
  const toggleChecked = selection?.onToggle ?? noop;

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
            <Button size="sm" variant="ghost" disabled={parsed.files.every((file) => picked.has(file.path) || applied.has(file.path))} onClick={selection.onPickAll}>
              {t("review.selectAll")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pickedCount === 0} onClick={selection.onPickNone}>
              {t("review.selectNone")}
            </Button>
          </>
        )}
        <span className="grow" />
        {parsed.files.length > 5 && <Input className="review-filter" value={filter} placeholder={t("review.filterFiles")} onChange={(event) => setFilter(event.target.value)} />}
        <Button size="sm" variant="ghost" icon={ChevronsUpDown} onClick={() => setFoldAll(false)}>
          {t("review.expandAll")}
        </Button>
        <Button size="sm" variant="ghost" icon={ChevronsDownUp} onClick={() => setFoldAll(true)}>
          {t("review.foldAll")}
        </Button>
      </div>
      {notes.length > 0 && <NotesBar notes={notes} fileOrder={fileOrder} folder={folder} workspaceId={workspaceId} preferredPtyId={preferredPtyId} onClear={() => setNotes([])} />}
      <div className="review-layout">
        <div className="diff-files review-files">
          {shownFiles.map((file) => (
            <FileListRow
              key={`${file.headerLine}:${file.path}`}
              file={file}
              viewed={isViewed(file)}
              checked={picked.has(file.path)}
              applied={applied.has(file.path)}
              hasCheckbox={Boolean(selection)}
              noteCount={notesByFile.get(file.path)?.length ?? 0}
              onToggleChecked={toggleChecked}
              onJump={openAndJump}
            />
          ))}
        </div>
        <div ref={diffBox} className="diff review-diffs">
          {shownFiles.map((file) => (
            <FileDiffCard
              key={`${file.headerLine}:${file.path}`}
              file={file}
              folded={isFolded(file)}
              viewed={isViewed(file)}
              checked={selection ? picked.has(file.path) : true}
              applied={applied.has(file.path)}
              hasCheckbox={Boolean(selection)}
              notes={notesByFile.get(file.path) ?? EMPTY_NOTES}
              composer={composer && composer.path === file.path ? composer : null}
              onToggleFold={toggleFold}
              onToggleViewed={toggleViewed}
              onToggleChecked={toggleChecked}
              actions={actions}
            />
          ))}
        </div>
      </div>
      {parsed.notes.length > 0 && <Notice>{parsed.notes.join(" · ")}</Notice>}
    </div>
  );
});
