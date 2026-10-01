import {
  ArrowUpRight,
  Bot,
  CheckCheck,
  Copy,
  FileDiff,
  FileText,
  FolderOpen,
  Forward,
  GitCompare,
  Info,
  ListRestart,
  MoreHorizontal,
  RotateCcw,
  ScrollText,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RunView } from "../../shared/api.js";
import { duration, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useEngines, useNow, useQuery } from "../api.js";
import { routeForRun, useAction, useNav, useToast } from "../state.js";
import { setPtyInView } from "../attention.js";
import { LiveTerminal, ReplayTerminal } from "./Terminal.js";
import { Button, Chip, Empty, MenuButton, Notice, Skeleton, StatusChip, Tabs, TimeAgo } from "./ui.js";
import { useT, type Key, type Translator } from "../i18n/index.js";
import { coreText } from "../core-text.js";

export const ORIGIN_KEY: Record<RunView["origin"], Key> = {
  "agent-chat": "origin.agent-chat",
  routine: "origin.routine",
  task: "origin.task",
  code: "origin.code",
  chat: "origin.chat",
};

type Tab = "session" | "changes" | "prompt" | "transcript" | "details";

export function DiffView({ text }: { text: string }) {
  const t = useT();
  const all = useMemo(() => text.split("\n"), [text]);
  const lines = all.length > 20000 ? all.slice(0, 20000) : all;
  if (!text.trim()) return <Notice>{t("run.noDiff")}</Notice>;
  return (
    <>
      <div className="diff">
        {lines.map((line, index) => {
          const kind = line.startsWith("diff --git")
            ? "file"
            : line.startsWith("#")
              ? "meta"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("new file mode")
                  ? "meta"
                  : line.startsWith("+")
                    ? "add"
                    : line.startsWith("-")
                      ? "del"
                      : "";
          return (
            <div key={index} className={kind}>
              {line || " "}
            </div>
          );
        })}
      </div>
      {all.length > 20000 && <Notice>{t("run.diffCapped")}</Notice>}
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
  const [diff, setDiff] = useState<{ text: string; source: "saved" | "now" } | null>(null);
  const [load, loading] = useAction(async (source: "saved" | "now") => {
    setDiff({ text: await call("runs.diff", run.id, source), source });
  }, t("run.diffFailed"));
  const notRepo = snapshot.startsWith("not a git repo");
  const saved = run.status !== "running" && patchSaved;
  return (
    <div className="page-body vstack" style={{ gap: 14 }}>
      {run.status === "running" && <Notice icon={Info}>{t("run.diffLater")}</Notice>}
      {saved && !notRepo && <Notice icon={Info}>{t("run.diffKept")}</Notice>}
      {notRepo ? (
        <Notice>{t("run.notRepo", { path: run.cwd })}</Notice>
      ) : snapshot ? (
        <pre className="pre">{snapshot.trim()}</pre>
      ) : run.status !== "running" ? (
        <Notice>{t("run.noSnapshot")}</Notice>
      ) : null}
      {!notRepo && (
        <div className="vstack">
          <div className="hstack">
            <Button icon={GitCompare} busy={loading} onClick={() => void load(saved ? "saved" : "now")}>
              {saved ? t("run.showSaved") : diff === null ? t("run.showFull") : t("run.refreshDiff")}
            </Button>
            {saved && (
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
          {diff !== null && <DiffView text={diff.text} />}
        </div>
      )}
    </div>
  );
}

export function RunDetail({ runId, embedded }: { runId: string; embedded?: boolean }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const now = useNow(1000);
  const bundle = useQuery(`run:${runId}`, ["runs", "live"], () => call("runs.get", runId));
  const engines = useEngines().data ?? [];
  const home = useAppInfo().data?.home ?? "";
  const [tab, setTab] = useState<Tab>("session");
  const run = bundle.data?.run;
  const files = bundle.data?.files;

  useEffect(() => setTab("session"), [runId]);
  useEffect(() => {
    if (run && run.status !== "running" && !run.openedAt) void call("runs.markOpened", run.id, true).catch(() => undefined);
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
  const agents = useAgents().data ?? [];
  const [handOff, handingOff] = useAction(async (agentId: string) => {
    if (!run) return;
    const task = await call("tasks.handOff", run.id, agentId);
    go({ view: "tasks", taskId: task.id });
    push("success", t("handoff.done", { agent: agents.find((agent) => agent.id === agentId)?.name ?? "" }), t("handoff.doneBody"));
  }, t("handoff.failed"));

  if (bundle.error) return <Empty icon={ScrollText} title={t("runs.notFound")}>{bundle.error}</Empty>;
  if (!run || !files) {
    return (
      <div className="main">
        <Skeleton page rows={6} />
      </div>
    );
  }

  const engine = engines.find((item) => item.id === run.engine);
  const place = routeForRun(run);
  const canOpenElsewhere = place.view !== "runs";

  return (
    <div className="main">
      <div className="page-head">
        <div className="vstack grow" style={{ gap: 1 }}>
          <div className="hstack">
            <h1 className="truncate">{run.title}</h1>
            <StatusChip status={run.status} exitCode={run.exitCode} />
            {run.changes && <Chip icon={FileDiff}>{run.changes}</Chip>}
          </div>
          <div className="sub truncate">
            {t(ORIGIN_KEY[run.origin])} · {engine?.label ?? run.engine} · <span className="mono">{tildify(run.cwd, home)}</span> · {t("run.started")}{" "}
            <TimeAgo iso={run.startedAt} /> · {duration(run.startedAt, run.endedAt, now)}
          </div>
        </div>
        {canOpenElsewhere && !embedded && (
          <Button size="sm" icon={ArrowUpRight} onClick={() => go(place)}>
            {t(place.view === "agents" ? "run.openIn.agents" : place.view === "chat" ? "run.openIn.chat" : place.view === "tasks" ? "run.openIn.tasks" : "run.openIn.code")}
          </Button>
        )}
        {run.status !== "running" && agents.length > 0 && (
          <MenuButton
            size="sm"
            icon={Forward}
            busy={handingOff}
            tip={t("handoff.tip")}
            items={agents.map((agent) => ({ label: agent.id === run.agentId ? t("handoff.again", { agent: agent.name }) : agent.name, icon: Bot, onSelect: () => void handOff(agent.id) }))}
          >
            {t("handoff.button")}
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
                  {
                    label: run.openedAt ? t("runs.unreview") : t("runs.markReviewed"),
                    icon: run.openedAt ? ListRestart : CheckCheck,
                    onSelect: () => void call("runs.markOpened", run.id, !run.openedAt),
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
          ) : (
            <Notice>{run.status === "running" ? t("run.transcriptLater") : t("run.noTranscript")}</Notice>
          )}
        </div>
      )}
      {tab === "details" && (
        <div className="page-body">
          <pre className="pre">
            {[
              `id            ${run.id}`,
              `origin        ${run.origin}`,
              `engine        ${run.engine}`,
              `command       ${run.argv.join(" ")}`,
              `folder        ${run.cwd}`,
              `started       ${new Date(run.startedAt).toLocaleString()}`,
              `ended         ${run.endedAt ? new Date(run.endedAt).toLocaleString() : "—"}`,
              `exit code     ${run.exitCode ?? "—"}${run.signal ? ` (signal ${run.signal})` : ""}`,
              `git at start  ${run.gitStart ?? "—"}`,
              `saved diff    ${files.patchSaved ? "diff.patch" : "—"}`,
              `continues     ${run.continuedFrom ?? "—"}`,
              `run folder    ${run.dir}`,
            ].join("\n")}
          </pre>
          <div className="hstack" style={{ marginTop: 10 }}>
            <Button size="sm" icon={FolderOpen} onClick={() => void call("app.openPath", run.dir)}>
              {t("run.openRunFolder")}
            </Button>
          </div>
        </div>
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
