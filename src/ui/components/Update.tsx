import { CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, RefreshCw, RotateCcw, Undo2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UpdateInfo } from "../../shared/api.js";
import type { Release } from "../../core/updates.js";
import { call, useLive, useUpdate } from "../api.js";
import { useT, type Translator } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { headline, notesBlocks } from "../notes.js";
import { openHomeOnNextStart, useConfirm, useToast } from "../state.js";
import { tipProps } from "./Tooltip.js";
import { markUpdated, useUpdated } from "../update-state.js";
import { LiveTerminal } from "./Terminal.js";
import { Button, Empty, Modal, Notice } from "./ui.js";

// Updating: the dialog shows what's new and runs the update command in a real terminal, so
// nothing happens out of sight, then offers a restart.

export const SHOW_UPDATE_EVENT = "vibeforge:update";

export function showUpdate(): void {
  window.dispatchEvent(new Event(SHOW_UPDATE_EVENT));
}

/** Set by showGoBack: the dialog starts Go back as it opens. */
let goBackOnOpen = false;

/** Opens the update dialog and starts Go back in it: the press on "Go back to …" was the decision. */
export function showGoBack(): void {
  goBackOnOpen = true;
  showUpdate();
}

function Notes({ text }: { text: string }) {
  return (
    <div className="update-notes selectable">
      {notesBlocks(text).map((block, index) =>
        block.kind === "list" ? (
          <ul key={index}>
            {block.items.map((item, at) => (
              <li key={at}>
                <Rich text={item} />
              </li>
            ))}
          </ul>
        ) : block.kind === "head" ? (
          <h4 key={index}>
            <Rich text={block.text} />
          </h4>
        ) : (
          <p key={index}>
            <Rich text={block.text} />
          </p>
        ),
      )}
    </div>
  );
}

/** A release this version skipped: its name and what it leads with, the whole notes on request. */
function Skipped({ release }: { release: Release }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lead = headline(release.notes);
  return (
    <div className="update-skipped">
      <button type="button" className="update-skipped-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="update-skipped-name">{release.name}</span>
        {!open && lead && (
          <span className="faint">
            <Rich text={lead} />
          </span>
        )}
      </button>
      {open && (release.notes.trim() ? <Notes text={release.notes} /> : <div className="update-notes">{t("updates.noNotes")}</div>)}
      {!open && release.notes.trim() && (
        <button type="button" className="update-skipped-more" onClick={() => setOpen(true)}>
          {t("updates.readMore")}
        </button>
      )}
    </div>
  );
}

/** One line on where things stand: newest, behind, not checked, or failed. */
export function updateStatus(info: UpdateInfo, t: Translator): string {
  if (info.checking) return t("updates.checking");
  if (info.error) return t("updates.failed", { error: info.error });
  if (!info.checkedAt) return t("updates.never", { current: info.current });
  if (info.available && info.latest) return t("updates.available", { version: info.latest.version, current: info.current });
  if (!info.latest) return t("updates.noReleases", { current: info.current });
  return t("updates.current", { current: info.current });
}

export function checkedAt(info: UpdateInfo, t: Translator): string {
  if (!info.checkedAt || info.checking) return "";
  return t("updates.checkedAt", { time: new Date(info.checkedAt).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" }) });
}

export function installText(info: UpdateInfo, appPath: string, t: Translator): string {
  if (info.install === "installer") return t("updates.installInstaller", { path: appPath });
  if (info.install === "checkout") return t("updates.installCheckout", { path: appPath });
  return t("updates.installOther", { path: appPath });
}

/** How often a restart waiting for CLIs to finish their turn looks again. */
const TURN_POLL_MS = 2000;

/**
 * Restart VibeForge to finish an update (or Go back), asking first while other terminals run.
 * A CLI in the middle of a turn is waited for, so no edit is cut off halfway: the button says how
 * many, and Restart now doesn't wait. After the restart each CLI's session reopens by itself.
 * `own` is the update's terminal.
 */
function useRestart(own: string | null = null): { restart: () => Promise<void>; waitingFor: number; now: () => void } {
  const t = useT();
  const live = useLive().data ?? [];
  const confirm = useConfirm();
  const [waitingFor, setWaitingFor] = useState(0);
  const busy = useRef(false);
  const skip = useRef(false);
  const restart = async () => {
    if (busy.current) return;
    const others = live.filter((session) => session.ptyId !== own).length;
    if (others > 0) {
      const ok = await confirm({ title: t("updates.restartTitle"), body: t.count("updates.restartBody", others), confirm: t("updates.restart") });
      if (!ok) return;
    }
    busy.current = true;
    skip.current = false;
    try {
      const working = async () => (await call("live.list").catch(() => [])).filter((session) => session.ptyId !== own && session.working).length;
      for (let left = await working(); left > 0 && !skip.current; left = await working()) {
        setWaitingFor(left);
        await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
      }
      setWaitingFor(0);
      openHomeOnNextStart();
      await call("app.restart", { reason: "update" });
    } finally {
      busy.current = false;
    }
  };
  return {
    restart,
    waitingFor,
    now: () => {
      skip.current = true;
    },
  };
}

/** Restart, or while CLIs finish their turn, what it waits for and Restart now. */
function RestartButton({ restart }: { restart: ReturnType<typeof useRestart> }) {
  const t = useT();
  if (!restart.waitingFor)
    return (
      <Button variant="primary" icon={RotateCcw} onClick={() => void restart.restart()}>
        {t("updates.restart")}
      </Button>
    );
  return (
    <>
      <span className="faint" {...tipProps(t("updates.waitingBody"))}>
        <span className="spinner" /> {t.count("updates.waiting", restart.waitingFor)}
      </span>
      <Button variant="primary" icon={RotateCcw} onClick={restart.now}>
        {t("updates.restartNow")}
      </Button>
    </>
  );
}

/**
 * In place of a view that can't load because an update replaced VibeForge's files under this
 * window: the new version is on disk, and a restart starts it.
 */
export function RestartToFinish() {
  const t = useT();
  const restart = useRestart();
  return (
    <Empty icon={RotateCcw} title={t("updates.finishTitle")} actions={<RestartButton restart={restart} />}>
      {t("updates.finishBody")}
    </Empty>
  );
}

export function UpdateSheet({ appPath, onClose }: { appPath: string; onClose: () => void }) {
  const t = useT();
  const info = useUpdate().data;
  const { fail } = useToast();
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [exit, setExit] = useState<{ code: number | null; signal: number | null } | null>(null);
  // What the terminal runs: the update, or Go back to the version before.
  const [job, setJob] = useState<"update" | "goBack">("update");
  // The version Go back went to, kept once the info about it changes.
  const [wentTo, setWentTo] = useState<string | null>(null);
  const running = Boolean(ptyId) && !exit;
  // Updated earlier in this session (the dialog was closed without restarting): Restart, not Update now again.
  const updated = useUpdated();
  const restart = useRestart(ptyId);
  useEffect(() => {
    if (exit?.code === 0 && job === "update") markUpdated();
  }, [exit, job]);
  // Opened by "Go back to …": start it.
  useEffect(() => {
    if (goBackOnOpen) {
      goBackOnOpen = false;
      void start("goBack");
    }
  }, []);

  // Opening this is asking: check now if nothing is known yet.
  useEffect(() => {
    if (info && !info.checkedAt && !info.checking) void call("updates.check").catch(() => undefined);
  }, [info?.checkedAt, info?.checking]);

  async function start(kind: "update" | "goBack") {
    setExit(null);
    setPtyId(null);
    setJob(kind);
    try {
      if (kind === "goBack") setWentTo((await call("updates.get")).goBack?.version ?? null);
      const started = await call(kind === "goBack" ? "updates.rollback" : "updates.run", { cols: 110, rows: 14 });
      setPtyId(started.ptyId);
    } catch (error) {
      fail(error);
    }
  }

  if (!info) return null;
  const latest = info.latest;
  const wentBack = job === "goBack" && exit?.code === 0;
  const succeeded = exit?.code === 0 || (job === "update" && updated && !running && !exit);
  const between = info.between ?? [];

  const footer = running ? null : succeeded || wentBack ? (
    <RestartButton restart={restart} />
  ) : (
    <>
      {latest?.url && (
        <Button variant="ghost" icon={ExternalLink} onClick={() => void call("app.openExternal", latest.url)}>
          {t("updates.notes")}
        </Button>
      )}
      {info.goBack && (
        <Button variant="ghost" icon={Undo2} tip={t("updates.goBackHint")} onClick={() => void start("goBack")}>
          {exit && job === "goBack" ? t("common.tryAgain") : t("updates.goBack", { version: info.goBack.version })}
        </Button>
      )}
      <span className="grow" />
      <Button icon={RefreshCw} busy={info.checking} onClick={() => void call("updates.check")}>
        {t("updates.checkNow")}
      </Button>
      {info.available && info.command && (
        <Button variant="primary" icon={Download} onClick={() => void start("update")}>
          {exit && job === "update" ? t("common.tryAgain") : t("updates.now")}
        </Button>
      )}
    </>
  );

  return (
    <Modal title={t("updates.sheetTitle")} icon={Download} wide terminal={Boolean(ptyId)} onClose={() => !running && onClose()} footer={footer}>
      <Notice tone={info.error ? "bad" : info.available ? "accent" : undefined}>
        {updateStatus(info, t)} {checkedAt(info, t)}
      </Notice>
      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        {installText(info, appPath, t)}
      </div>
      {info.available && latest && !ptyId && (
        <>
          <div className="list-label">{latest.name}</div>
          {latest.notes.trim() ? <Notes text={latest.notes} /> : <div className="update-notes">{t("updates.noNotes")}</div>}
          {between.length > 0 && (
            <>
              <div className="list-label">{t("updates.alsoSince", { current: info.current })}</div>
              <div className="vstack" style={{ gap: 6 }}>
                {between.map((release) => (
                  <Skipped key={release.tag} release={release} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      {!ptyId && updated && (
        <Notice tone="accent" icon={CheckCircle2}>
          {latest ? t("updates.done", { version: latest.version }) : t("updates.doneUnknown")}
        </Notice>
      )}
      {info.available && info.command && !ptyId && !updated && (
        <div className="vstack" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {t("updates.willRun")}
          </span>
          <code className="update-command selectable">{info.command}</code>
        </div>
      )}
      {info.available && info.install === "installer" && !info.command && !ptyId && !updated && (
        <Notice tone="bad" icon={XCircle}>
          {t("updates.noDigest")}
        </Notice>
      )}
      {ptyId && (
        <>
          <div className="update-term">
            <LiveTerminal ptyId={ptyId} autoFocus onExit={(result) => setExit({ code: result.exitCode, signal: result.signal })} />
          </div>
          {running ? (
            <Notice>
              {job === "goBack" ? t("updates.goingBack") : t("updates.running")} <Rich text={t("updates.waitToClose")} />
            </Notice>
          ) : wentBack ? (
            <Notice tone="accent" icon={CheckCircle2}>
              {wentTo ? t("updates.wentBack", { version: wentTo }) : t("updates.doneUnknown")}
            </Notice>
          ) : succeeded ? (
            <Notice tone="accent" icon={CheckCircle2}>
              {latest ? t("updates.done", { version: latest.version }) : t("updates.doneUnknown")}
            </Notice>
          ) : (
            <Notice tone="bad" icon={XCircle}>
              {job === "goBack" ? t("updates.goBackStopped", { code: exit?.code ?? exit?.signal ?? "?" }) : t("updates.stopped", { code: exit?.code ?? exit?.signal ?? "?" })}
            </Notice>
          )}
        </>
      )}
    </Modal>
  );
}
