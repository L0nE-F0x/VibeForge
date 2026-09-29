import {
  ArrowUpRight,
  CheckCheck,
  Copy,
  FileDiff,
  FileText,
  FolderOpen,
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
import { call, useAppInfo, useEngines, useNow, useQuery } from "../api.js";
import { routeForRun, useAction, useNav, useToast } from "../state.js";
import { LiveTerminal, ReplayTerminal } from "./Terminal.js";
import { Button, Chip, Empty, MenuButton, Notice, Skeleton, StatusChip, Tabs, TimeAgo } from "./ui.js";
import { useT } from "../i18n/index.js";

export const ORIGIN_LABEL: Record<RunView["origin"], string> = {
  "agent-chat": "Agent chat",
  routine: "Routine",
  task: "Task",
  code: "Code",
  chat: "Chat",
};

type Tab = "session" | "changes" | "prompt" | "transcript" | "details";

export function DiffView({ text }: { text: string }) {
  const all = useMemo(() => text.split("\n"), [text]);
  const lines = all.length > 20000 ? all.slice(0, 20000) : all;
  if (!text.trim()) return <Notice>No differences.</Notice>;
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
      {all.length > 20000 && <Notice>Showing the first 20,000 lines. The whole diff is saved with the run.</Notice>}
    </>
  );
}

function diffCaption(run: RunView, saved: boolean, shown: "saved" | "now" | null): string {
  const sha = run.gitStart?.slice(0, 8);
  if (shown === "now" || run.status === "running" || !saved) {
    return sha ? `The folder now, compared with ${sha} from when the run started, plus new files.` : "The folder now, compared with HEAD, plus new files.";
  }
  return sha ? `The diff saved for this run: everything since ${sha}, plus new files.` : "The diff saved for this run, including new files.";
}

function ChangesTab({ run, snapshot, patchSaved }: { run: RunView; snapshot: string; patchSaved: boolean }) {
  const { push } = useToast();
  const [diff, setDiff] = useState<{ text: string; source: "saved" | "now" } | null>(null);
  const [load, loading] = useAction(async (source: "saved" | "now") => {
    setDiff({ text: await call("runs.diff", run.id, source), source });
  }, "Could not read the diff");
  const notRepo = snapshot.startsWith("not a git repo");
  const saved = run.status !== "running" && patchSaved;
  return (
    <div className="page-body vstack" style={{ gap: 14 }}>
      {run.status === "running" && <Notice icon={Info}>The diff is saved when the run ends. Until then, this reads the folder now.</Notice>}
      {saved && !notRepo && <Notice icon={Info}>Saved with this run. Later edits in the folder stay out of it.</Notice>}
      {notRepo ? (
        <Notice>{run.cwd} is not a git repository, so there is no change summary.</Notice>
      ) : snapshot ? (
        <pre className="pre">{snapshot.trim()}</pre>
      ) : run.status !== "running" ? (
        <Notice>No git snapshot was recorded.</Notice>
      ) : null}
      {!notRepo && (
        <div className="vstack">
          <div className="hstack">
            <Button icon={GitCompare} busy={loading} onClick={() => void load(saved ? "saved" : "now")}>
              {saved ? "Show the saved diff" : diff === null ? "Show the full diff" : "Refresh diff"}
            </Button>
            {saved && (
              <Button variant="ghost" icon={GitCompare} busy={loading} onClick={() => void load("now")}>
                Diff the folder now
              </Button>
            )}
            {diff && (
              <Button size="sm" variant="ghost" icon={Copy} onClick={() => void navigator.clipboard.writeText(diff.text).then(() => push("success", "Diff copied"))}>
                Copy
              </Button>
            )}
            <span className="faint">{diffCaption(run, saved, diff?.source ?? null)}</span>
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
    push("success", "Continued", "A new run picked up where this one stopped.");
  }, "Could not continue");
  const [stop, stopping] = useAction(async () => run && call("runs.stop", run.id), "Could not stop the run");

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
            {ORIGIN_LABEL[run.origin]} · {engine?.label ?? run.engine} · <span className="mono">{tildify(run.cwd, home)}</span> · started{" "}
            <TimeAgo iso={run.startedAt} /> · {duration(run.startedAt, run.endedAt, now)}
          </div>
        </div>
        {canOpenElsewhere && !embedded && (
          <Button size="sm" icon={ArrowUpRight} onClick={() => go(place)}>
            Open in {place.view === "agents" ? "agent" : place.view === "chat" ? "chat" : place.view === "tasks" ? "task" : "workspace"}
          </Button>
        )}
        {run.status === "running" ? (
          <Button size="sm" icon={Square} busy={stopping} onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={RotateCcw} busy={continuing} onClick={() => void cont()}>
            Continue
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
          { value: "session", label: run.live ? "Live session" : "Final screen", icon: TerminalSquare },
          { value: "changes", label: "Changes", icon: GitCompare },
          { value: "prompt", label: "Prompt", icon: FileText },
          { value: "transcript", label: "Transcript", icon: ScrollText },
          { value: "details", label: "Details", icon: Info },
        ]}
      />
      {run.error && run.status !== "running" && (
        <div style={{ padding: "10px 16px 0" }}>
          <Notice tone={run.status === "failed" ? "bad" : "warn"}>{run.error}</Notice>
        </div>
      )}
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
              <span className="faint">What you typed in this session.</span>
              <pre className="pre">{files.prompts}</pre>
            </>
          ) : (
            <Notice>
              {run.origin === "code"
                ? "This was typed into a terminal, so VibeForge did not hand it a prompt. The session is on Final screen and Transcript."
                : "This run started without a prompt."}
            </Notice>
          )}
        </div>
      )}
      {tab === "transcript" && (
        <div className="page-body vstack">
          {files.transcript.trim() ? (
            <>
              <div className="hstack">
                <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard.writeText(files.transcript).then(() => push("success", "Transcript copied"))}>
                  Copy
                </Button>
                <span className="faint">Plain text of the terminal, written when the run ended.</span>
              </div>
              <pre className="pre">{files.transcript}</pre>
            </>
          ) : (
            <Notice>{run.status === "running" ? "The transcript is written when the run ends." : "No transcript was written for this run."}</Notice>
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
              Open run folder
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
