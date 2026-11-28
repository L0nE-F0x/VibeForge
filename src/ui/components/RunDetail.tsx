import {
  ArrowUpRight,
  Bot,
  CheckCheck,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FileDiff,
  FileText,
  FolderOpen,
  Forward,
  GitBranch,
  GitCompare,
  GitMerge,
  Info,
  ListRestart,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  TerminalSquare,
  Trash2,
  Undo2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RunRestoreAvailability, RunRestorePreview, RunView, Topic } from "../../shared/api.js";
import { LOCAL_ENGINE_ID, shortLocalModel } from "../../shared/local.js";
import { splitPatch } from "../../shared/review.js";
import { duration, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useEngines, useNow, useQuery, useTasks, useWorkspaces } from "../api.js";
import { applyToast } from "../apply-note.js";
import { routeForRun, useAction, useDeleted, useNav, useToast } from "../state.js";
import { setPtyInView } from "../attention.js";
import { usePlace } from "../remember.js";
import { LiveTerminal, ReplayTerminal } from "./Terminal.js";
import { useNarrowStage } from "./SidePanel.js";
import { DiffReview } from "./DiffReview.js";
import { Button, Chip, Empty, MenuButton, Modal, Notice, Skeleton, StatusChip, Tabs, TimeAgo } from "./ui.js";
import { Rich } from "../i18n/Rich.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { coreText } from "../core-text.js";
import { changesFor } from "../changes-text.js";
import { shortcutKeys } from "../shortcuts.js";

export const ORIGIN_KEY: Record<RunView["origin"], Key> = {
  "agent-chat": "origin.agent-chat",
  routine: "origin.routine",
  task: "origin.task",
  code: "origin.code",
  chat: "origin.chat",
};

type Tab = "session" | "changes" | "prompt" | "transcript" | "details";
const TABS: readonly Tab[] = ["session", "changes", "prompt", "transcript", "details"];
const isTab = (value: unknown): value is Tab => TABS.includes(value as Tab);

/** Compact syntax-coloured diff view (used for conflict diffs in dialogs). */
export const DiffView = memo(function DiffView({ text }: { text: string }) {
  return <DiffReview text={text} compact />;
});

/** How long a run took, or has taken so far. Only a running one ticks, and only this text re-renders. */
function Elapsed({ start, end }: { start: string; end: string | null }) {
  return end ? <>{duration(start, end)}</> : <Ticking start={start} />;
}

function Ticking({ start }: { start: string }) {
  const now = useNow(1000);
  return <>{duration(start, null, now)}</>;
}

/**
 * While the CLI is still open, its transcript isn't written yet: what the terminal shows now, as
 * text, read when the tab opens and again on Refresh.
 */
function TranscriptSoFar({ ptyId }: { ptyId: string }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [read, reading] = useAction(async () => setText((await call("pty.snapshot", ptyId)).plain), t("first.run.soFarFailed"));
  useEffect(() => {
    void read();
  }, [read]);
  return (
    <>
      <Notice icon={Info}>{t("first.run.soFar")}</Notice>
      <div className="hstack">
        <Button size="sm" icon={RefreshCw} busy={reading} onClick={() => void read()}>
          {t("common.refresh")}
        </Button>
      </div>
      {text !== null && <pre className="pre">{text.trim() ? text : t("first.run.soFarEmpty")}</pre>}
    </>
  );
}

function diffCaption(run: RunView, saved: boolean, shown: "saved" | "now" | null, t: Translator): string {
  const sha = run.gitStart?.slice(0, 8);
  if (shown === "now" || run.status === "running" || !saved) return sha ? t("run.diffNowSha", { sha }) : t("run.diffNow");
  return sha ? t("run.diffSavedSha", { sha }) : t("run.diffSaved");
}

function ChangesTab({ run, snapshot, patchSaved }: { run: RunView; snapshot: string; patchSaved: boolean }) {
  const t = useT();
  const { push } = useToast();
  const deleted = useDeleted();
  const home = useAppInfo().data?.home ?? "";
  const tasks = useTasks().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const task = run.taskId ? tasks.find((item) => item.id === run.taskId) : undefined;
  const taskWorkspace = task ? workspaces.find((item) => item.id === task.workspaceId) : undefined;
  const [diff, setDiff] = useState<{ text: string; source: "saved" | "now" } | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [load, loading] = useAction(async (source: "saved" | "now") => {
    setDiff({ text: await call("runs.diff", run.id, source), source });
  }, t("run.diffFailed"));
  const notRepo = snapshot.startsWith("not a git repo");
  const saved = run.status !== "running" && patchSaved;
  // What a finished run changed is the point of reviewing it: its saved diff opens with the tab.
  useEffect(() => {
    setExcluded(new Set());
    if (saved && !notRepo) void load("saved");
  }, [run.id, saved, notRepo, load]);

  const parsedPaths = useMemo(() => (diff ? splitPatch(diff.text).files.map((file) => file.path) : []), [diff]);
  const pickedPaths = useMemo(() => parsedPaths.filter((item) => !excluded.has(item)), [parsedPaths, excluded]);
  const pickedSet = useMemo(() => new Set(pickedPaths), [pickedPaths]);
  const toggleFile = (filePath: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  const canApplyTaskCopy = Boolean(task && task.copy && task.copyOwned && !task.lastRun?.live && run.id === task.lastRun?.id && diff?.source !== "now");
  const workspaceName = taskWorkspace?.name ?? task?.copy?.repo ?? "";
  const [applyCopy, applying] = useAction(async () => {
    if (!task?.copy) return;
    const partial = parsedPaths.length > 0 && pickedPaths.length < parsedPaths.length ? pickedPaths : undefined;
    const result = await call("tasks.applyCopy", task.id, partial);
    const toast = applyToast(t, result, workspaceName, home);
    push(toast.tone, toast.title, toast.body);
    if (result.stayed) setExcluded(new Set());
  }, t("tasks.applyFailed"));
  const [discardCopy, discarding] = useAction(async () => {
    if (!task) return;
    const result = await call("tasks.discardCopy", task.id);
    deleted(t("tasks.copyDiscarded", { title: task.title }), result);
  }, t("tasks.discardFailed"));

  return (
    <div className="page-body vstack" style={{ gap: 14 }}>
      {run.status === "running" && <Notice icon={Info}>{t("run.diffLater")}</Notice>}
      {notRepo ? (
        <Notice>{t("run.notRepo", { path: run.cwd })}</Notice>
      ) : !snapshot && run.status !== "running" && !saved ? (
        <Notice>{t("run.noSnapshot")}</Notice>
      ) : null}
      {!notRepo && (
        <div className="vstack">
          <div className="hstack wrap">
            {(!saved || diff?.source === "now") && (
              <Button icon={GitCompare} busy={loading} onClick={() => void load(saved ? "saved" : "now")}>
                {saved ? t("run.showSaved") : diff === null ? t("run.showFull") : t("run.refreshDiff")}
              </Button>
            )}
            {saved && diff?.source !== "now" && (
              <Button variant="ghost" icon={GitCompare} busy={loading} onClick={() => void load("now")}>
                {t("run.diffFolderNow")}
              </Button>
            )}
            {diff && (
              <Button size="sm" variant="ghost" icon={Copy} onClick={() => void navigator.clipboard.writeText(diff.text).then(() => push("success", t("run.diffCopied")))}>
                {t("common.copy")}
              </Button>
            )}
            <span className="faint">{diffCaption(run, saved, diff?.source ?? null, t)}</span>
          </div>
          {canApplyTaskCopy && task?.copy && (
            <Notice tone="accent" icon={GitBranch}>
              <div className="hstack wrap">
                <span className="grow">
                  <Rich text={t("tasks.copyNote", { branch: task.copy.branch, workspace: workspaceName })} />
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  icon={GitMerge}
                  busy={applying}
                  disabled={parsedPaths.length > 0 && pickedPaths.length === 0}
                  tip={t("tasks.applyTip")}
                  onClick={() => void applyCopy()}
                >
                  {parsedPaths.length > 0 && pickedPaths.length < parsedPaths.length
                    ? t("review.applyPicked", { count: pickedPaths.length, total: parsedPaths.length, workspace: workspaceName })
                    : t("tasks.apply", { workspace: workspaceName })}
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} busy={discarding} onClick={() => void discardCopy()}>
                  {t("tasks.discardCopy")}
                </Button>
              </div>
            </Notice>
          )}
          {diff !== null && (
            <DiffReview
              text={diff.text}
              reviewKey={run.id}
              workspaceId={run.workspaceId}
              preferredPtyId={run.live ? run.ptyId : null}
              selection={
                canApplyTaskCopy && parsedPaths.length > 0
                  ? {
                      picked: pickedSet,
                      onToggle: toggleFile,
                      onPickAll: () => setExcluded(new Set()),
                      onPickNone: () => setExcluded(new Set(parsedPaths)),
                    }
                  : undefined
              }
            />
          )}
          {snapshot && (diff === null || !diff.text.trim()) && <pre className="pre">{snapshot.trim()}</pre>}
        </div>
      )}
    </div>
  );
}

function restoreNote(restore: RunRestoreAvailability, t: Translator): string | undefined {
  if (restore === "running") return t("runs.restoreWhileRunning");
  if (restore === "missing") return t("runs.restoreMissing");
  if (restore === "no-changes") return t("runs.restoreNoChanges");
  if (restore === "not-repo") return t("runs.restoreNotRepo");
  if (restore === "folder-gone") return t("runs.restoreFolderGone");
  return undefined;
}

function summarizeFiles(files: string[]): string {
  const shown = files.slice(0, 6).join(", ");
  return files.length > 6 ? `${shown}, …` : shown;
}

function leftAloneBody(leftAlone: RunRestorePreview["leftAlone"], t: Translator): string | undefined {
  const changed = leftAlone.filter((item) => item.reason === "changed").map((item) => item.path);
  const oversized = leftAlone.filter((item) => item.reason === "oversized").map((item) => item.path);
  const parts: string[] = [];
  if (changed.length) parts.push(t("runs.restoredLeftChanged", { files: summarizeFiles(changed) }));
  if (oversized.length) parts.push(t("runs.restoredLeftOversized", { files: summarizeFiles(oversized) }));
  return parts.length ? parts.join(" ") : undefined;
}

function RestoreConfirmModal({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: RunRestorePreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const none = preview.restorable.length === 0;
  return (
    <Modal
      title={t("runs.restoreTitle")}
      icon={Undo2}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        none ? (
          <Button variant="primary" onClick={onCancel} autoFocus>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" busy={busy} onClick={onConfirm} autoFocus>
              {t("runs.restoreConfirm")}
            </Button>
          </>
        )
      }
    >
      {none ? (
        <Notice>{preview.leftAlone.length > 0 ? t("runs.restoreNoneLeft") : t("runs.restoreAlreadyBack")}</Notice>
      ) : (
        <>
          <div className="muted" style={{ lineHeight: 1.55 }}>
            {t.count("runs.restoreCount", preview.restorable.length)}
            {preview.leftAlone.length > 0 ? ` ${t.count("runs.restoreLeftCount", preview.leftAlone.length)}` : ""}
          </div>
          <div className="branch-list">
            {preview.restorable.map((item) => (
              <div key={item.path} className="hstack" style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                <span className="faint" style={{ fontSize: "var(--fs-xs)", minWidth: 64 }}>
                  {t(item.action === "delete" ? "runs.restoreActionDelete" : item.action === "recreate" ? "runs.restoreActionRecreate" : "runs.restoreActionRestore")}
                </span>
                <span className="mono truncate grow">{item.path}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {preview.leftAlone.length > 0 && (
        <div className="vstack" style={{ gap: 6 }}>
          <div className="list-label">{t("runs.restoreLeftHeading")}</div>
          <div className="branch-list">
            {preview.leftAlone.map((item) => (
              <div key={item.path} className="hstack" style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)" }}>
                <span className="faint" style={{ fontSize: "var(--fs-xs)", minWidth: 96 }}>
                  {t(item.reason === "oversized" ? "runs.restoreReasonOversized" : "runs.restoreReasonChanged")}
                </span>
                <span className="mono truncate grow">{item.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

const RUNNING_TOPICS: Topic[] = ["runs", "live", "working"];
const DONE_TOPICS: Topic[] = ["runs"];

export function RunDetail({
  runId,
  embedded,
  onPrev,
  onNext,
}: {
  runId: string;
  embedded?: boolean;
  /** While reviewing: open the previous run waiting. */
  onPrev?: () => void;
  /** While reviewing: open the next run waiting. */
  onNext?: () => void;
}) {
  const t = useT();
  const { go } = useNav();
  const { push, fail } = useToast();
  // A running run follows its terminal; a finished one changes only when the runs do. Its files
  // are large and don't move with the clock, so the 30 s refresh skips them and they aren't kept.
  const bundle = useQuery(`run:${runId}`, (data) => (data?.run.status === "running" ? RUNNING_TOPICS : DONE_TOPICS), () => call("runs.get", runId), {
    keep: false,
    poll: false,
  });
  const engines = useEngines().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  // Each run reopens on the tab it was last read on.
  const [tab, setTab] = usePlace<Tab>("run.tab", runId, "session", isTab);
  // On a narrow tile the header's secondary buttons keep their icons and tooltips, so the title has room.
  const narrow = useNarrowStage();
  const run = bundle.data?.run;
  const files = bundle.data?.files;
  const restore = bundle.data?.restore ?? "missing";
  const [restorePreview, setRestorePreview] = useState<RunRestorePreview | null>(null);

  // Opening a finished run marks it reviewed, once per visit: "Put it back in Needs review" from
  // its menu then stays put instead of being marked again as the run reloads.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!run || run.status === "running" || marked.current === run.id) return;
    marked.current = run.id;
    if (!run.openedAt) void call("runs.markOpened", run.id, true).catch(() => undefined);
  }, [run]);

  const [cont, continuing] = useAction(async () => {
    if (!run) return;
    const next = await call("runs.continue", run.id);
    if (next.chatId && run.agentId) go({ view: "agents", agentId: run.agentId, tab: "chats", chatId: next.chatId });
    else if (next.chatId) go({ view: "chat", chatId: next.chatId });
    else if (next.taskId) go({ view: "tasks", taskId: next.taskId });
    else go({ view: "runs", runId: next.runId });
    push("success", t("run.continued"), t("run.continuedBody"));
  }, t("tasks.continueFailed"));
  const [stop, stopping] = useAction(async () => run && call("runs.stop", run.id), t("run.stopFailed"));
  const [copyMarkdown] = useAction(async () => {
    if (!run) return;
    await call("app.copyText", await call("runs.markdown", run.id));
    push("success", t("runs.markdownCopied"), t("runs.markdownCopiedBody"));
  }, t("runs.markdownFailed"));
  const agents = useAgents().data ?? [];
  const [handOff, handingOff] = useAction(async (agentId: string) => {
    if (!run) return;
    const task = await call("tasks.handOff", run.id, agentId);
    go({ view: "tasks", taskId: task.id });
    push("success", t("handoff.done", { agent: agents.find((agent) => agent.id === agentId)?.name ?? "" }), t("handoff.doneBody"));
  }, t("handoff.failed"));
  const [askRestore, previewingRestore] = useAction(async () => {
    if (!run) return;
    setRestorePreview(await call("runs.restorePreview", run.id));
  }, t("runs.restoreFailed"));
  const [confirmRestore, applyingRestore] = useAction(async () => {
    if (!run) return;
    const result = await call("runs.restore", run.id);
    setRestorePreview(null);
    if (result.restored.length === 0) {
      push("info", t("runs.restoreNothingDone"), leftAloneBody(result.leftAlone, t));
      return;
    }
    push(
      "success",
      t.count("runs.restoredTitle", result.restored.length),
      leftAloneBody(result.leftAlone, t),
      result.undo
        ? {
            label: t("common.undo"),
            run: () =>
              void call("runs.undoRestore", result.undo!)
                .then(() => push("info", t("runs.restoreUndone")))
                .catch((error: unknown) => fail(error, t("common.undoFailed"))),
          }
        : undefined,
    );
  }, t("runs.restoreFailed"));

  if (bundle.error) return <Empty icon={ScrollText} title={t("runs.notFound")}>{bundle.error}</Empty>;
  if (!run || !files) {
    return (
      <div className="main">
        <Skeleton page rows={6} />
      </div>
    );
  }

  const engine = engines.find((item) => item.id === run.engine);
  const isLocalRun = run.engine === LOCAL_ENGINE_ID || Boolean(run.localModel);
  const engineSummary = isLocalRun
    ? [t("pane.local"), run.localModel ? shortLocalModel(run.localModel) : "", run.localHarness].filter(Boolean).join(" · ")
    : (engine?.label ?? run.engine);
  const place = routeForRun(run);
  const openLabel = t(place.view === "agents" ? "run.openIn.agents" : place.view === "chat" ? "run.openIn.chat" : place.view === "tasks" ? "run.openIn.tasks" : "run.openIn.code");
  const canOpenElsewhere = place.view !== "runs";

  return (
    <div className="main">
      <div className="page-head">
        <div className="vstack grow" style={{ gap: 1 }}>
          <div className="hstack">
            <h1 className="truncate">{run.title}</h1>
            <StatusChip status={run.status} exitCode={run.exitCode} result={run.result} origin={run.origin} cutOff={run.cutOff} />
            {isLocalRun && (
              <Chip tone="accent" title={run.localModel ?? undefined}>
                {run.localModel ? `${t("pane.local")} · ${shortLocalModel(run.localModel)}` : t("pane.local")}
              </Chip>
            )}
            {run.changes && <Chip icon={FileDiff}>{changesFor(run.changes, t)}</Chip>}
          </div>
          <div className="sub truncate">
            {t(ORIGIN_KEY[run.origin])} · {engineSummary} · <span className="mono">{tildify(run.cwd, home)}</span> · {t("run.started")}{" "}
            <TimeAgo iso={run.startedAt} /> · <Elapsed start={run.startedAt} end={run.endedAt} />
          </div>
        </div>
        {canOpenElsewhere && !embedded && (
          <Button size="sm" icon={ArrowUpRight} tip={narrow ? openLabel : undefined} onClick={() => go(place)}>
            {narrow ? null : openLabel}
          </Button>
        )}
        {run.status !== "running" && agents.length > 0 && (
          <MenuButton
            size="sm"
            icon={Forward}
            busy={handingOff}
            tip={narrow ? t("handoff.button") : t("handoff.tip")}
            items={agents.map((agent) => ({ label: agent.id === run.agentId ? t("handoff.again", { agent: agent.name }) : agent.name, icon: Bot, onSelect: () => void handOff(agent.id) }))}
          >
            {narrow ? null : t("handoff.button")}
          </MenuButton>
        )}
        {run.status === "running" ? (
          <Button size="sm" icon={Square} busy={stopping} onClick={() => void stop()}>
            {t("tasks.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={RotateCcw} busy={continuing} onClick={() => void cont()}>
            {t("common.continue")}
          </Button>
        )}
        {onPrev && <Button size="sm" variant="ghost" icon={ChevronsLeft} tip={t("runs.prevTip")} kbd={shortcutKeys("runs.prev")} onClick={onPrev} />}
        {onNext && (
          <Button size="sm" icon={ChevronsRight} tip={t("runs.nextTip")} kbd={shortcutKeys("runs.next")} onClick={onNext}>
            {narrow ? null : t("runs.next")}
          </Button>
        )}
        <MenuButton
          size="sm"
          variant="ghost"
          icon={MoreHorizontal}
          title={t("runs.more")}
          items={[
            { label: t("runs.openFolder"), icon: FolderOpen, onSelect: () => void call("app.openPath", run.cwd) },
            ...(run.status === "running"
              ? []
              : [
                  { label: t("runs.copyMarkdown"), icon: Copy, onSelect: () => void copyMarkdown() },
                  {
                    label: run.openedAt ? t("runs.unreview") : t("runs.markReviewed"),
                    icon: run.openedAt ? ListRestart : CheckCheck,
                    onSelect: () => void call("runs.markOpened", run.id, !run.openedAt),
                  },
                ]),
            ...(restore === "in-copy"
              ? []
              : [
                  "sep" as const,
                  {
                    label: t("runs.restore"),
                    icon: Undo2,
                    disabled: restore !== "ready" || previewingRestore || applyingRestore,
                    note: restoreNote(restore, t),
                    onSelect: () => void askRestore(),
                  },
                ]),
          ]}
        />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "session", label: run.live ? t("run.tab.live") : t("run.tab.screen"), icon: TerminalSquare },
          { value: "changes", label: t("run.tab.changes"), icon: GitCompare },
          { value: "prompt", label: t("run.tab.prompt"), icon: FileText },
          { value: "transcript", label: t("run.tab.transcript"), icon: ScrollText },
          { value: "details", label: t("run.tab.details"), icon: Info },
        ]}
      />
      {run.status === "running" && run.result === "question" && (
        <div style={{ padding: "10px 16px 0" }}>
          <Notice tone="warn">{t("routines.questionNote")}</Notice>
        </div>
      )}
      {run.error && run.status !== "running" && (
        <div style={{ padding: "10px 16px 0" }}>
          <Notice tone={run.status === "failed" ? "bad" : "warn"}>{coreText(run.error)}</Notice>
        </div>
      )}
      <PtyInView ptyId={tab === "session" && run.live ? run.ptyId : null} />
      {tab === "session" &&
        (run.live && run.ptyId ? (
          <LiveTerminal key={run.ptyId} ptyId={run.ptyId} autoFocus />
        ) : (
          <ReplayTerminal ansi={files.screen || files.scrollback} />
        ))}
      {tab === "changes" && <ChangesTab run={run} snapshot={files.git} patchSaved={files.patchSaved} />}
      {tab === "prompt" && (
        <div className="page-body vstack">
          {files.preamble.trim() ? (
            <pre className="pre">{files.preamble}</pre>
          ) : files.prompts.trim() ? (
            <>
              <span className="faint">{t("run.youTyped")}</span>
              <pre className="pre">{files.prompts}</pre>
            </>
          ) : (
            <Notice>
              {run.origin === "code" ? t("run.typedNoPrompt") : t("run.noPrompt")}
            </Notice>
          )}
        </div>
      )}
      {tab === "transcript" && (
        <div className="page-body vstack">
          {files.transcript.trim() ? (
            <>
              <div className="hstack">
                <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard.writeText(files.transcript).then(() => push("success", t("run.transcriptCopied")))}>
                  {t("common.copy")}
                </Button>
                <span className="faint">{t("run.transcriptNote")}</span>
              </div>
              <pre className="pre">{files.transcript}</pre>
            </>
          ) : run.status === "running" && run.live && run.ptyId ? (
            <TranscriptSoFar ptyId={run.ptyId} />
          ) : (
            <Notice>{run.status === "running" ? t("run.transcriptLater") : t("run.noTranscript")}</Notice>
          )}
        </div>
      )}
      {tab === "details" && (
        <div className="page-body">
          <dl className="run-details">
            {(
              [
                ["run.detail.id", run.id],
                ["run.detail.origin", t(ORIGIN_KEY[run.origin])],
                ["run.detail.engine", engine?.label ?? run.engine],
                ["run.detail.command", run.argv.join(" ")],
                ["run.detail.folder", run.cwd],
                ["run.detail.started", new Date(run.startedAt).toLocaleString(t.language)],
                ["run.detail.ended", run.endedAt ? new Date(run.endedAt).toLocaleString(t.language) : "—"],
                ["run.detail.exit", run.signal ? t("pane.exitSignal", { signal: run.signal }) : String(run.exitCode ?? "—")],
                ["run.detail.gitStart", run.gitStart ?? "—"],
                ["run.detail.savedDiff", files.patchSaved ? "diff.patch" : "—"],
                ["run.detail.continues", run.continuedFrom ?? "—"],
                ["run.detail.runFolder", run.dir],
              ] as Array<[Key, string]>
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="hstack" style={{ marginTop: 10 }}>
            <Button size="sm" icon={FolderOpen} onClick={() => void call("app.openPath", run.dir)}>
              {t("run.openRunFolder")}
            </Button>
          </div>
        </div>
      )}
      {restorePreview && (
        <RestoreConfirmModal
          preview={restorePreview}
          busy={applyingRestore}
          onCancel={() => setRestorePreview(null)}
          onConfirm={() => void confirmRestore()}
        />
      )}
    </div>
  );
}

/** Tells the session watch which run terminal is in front of you, so its glow clears. */
function PtyInView({ ptyId }: { ptyId: string | null }) {
  useEffect(() => {
    setPtyInView("run", ptyId);
    return () => setPtyInView("run", null);
  }, [ptyId]);
  return null;
}
