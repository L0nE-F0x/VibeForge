import { BookOpen, Check, FileText, History, Pencil, Plus, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { call, useLive, useOrchestrator, useWorkspaces } from "../../api.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Input, Popover, Sheet } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { useAction, useDeleted, useNav, useToast } from "../../state.js";
import { isCodingCli, LeaveBar } from "./shared.js";

/** Header chip listing all active coding CLIs, with quick jump & per-CLI or all-Viby stop. */
export function RunningPill() {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const leaveBar = useContext(LeaveBar);
  const live = useLive().data ?? [];
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const clis = live.filter(isCodingCli);
  const own = clis.filter((item) => item.orchestrated);
  const working = clis.some((item) => item.working);

  useEffect(() => {
    if (!clis.length) setAnchor(null);
  }, [clis.length]);

  const [stopAll, stoppingAll] = useAction(async () => {
    await Promise.all(own.map((item) => (item.runId ? call("runs.stop", item.runId) : call("pty.kill", item.ptyId))));
    setAnchor(null);
  }, t("orch.failed"));

  if (!clis.length) return null;

  const stopOne = async (ptyId: string, runId: string | null) => {
    try {
      await (runId ? call("runs.stop", runId) : call("pty.kill", ptyId));
    } catch (error: unknown) {
      fail(error, t("orch.failed"));
    }
  };

  const wsName = (wsId: string | null) => (wsId ? workspaces.find((w) => w.id === wsId)?.name : undefined);

  return (
    <>
      <button
        type="button"
        className={`viby-chip running-pill${working ? " working" : ""}`}
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <SquareTerminal size={12} />
        <span>
          {t("orch.team")} · {clis.length}
        </span>
      </button>
      {anchor && (
        <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)}>
          <div className="viby-review-popover viby-threads-popover">
            <div className="viby-detail-head">
              <strong className="grow">{t("orch.team")}</strong>
              {own.length > 0 && (
                <Button size="sm" variant="danger" busy={stoppingAll} onClick={() => void stopAll()}>
                  {t("orch.stopAll")}
                </Button>
              )}
            </div>
            <div className="orch-review-list">
              {clis.map((item) => (
                <div key={item.ptyId} className="orch-member row">
                  <button
                    type="button"
                    className="menu-item grow"
                    onClick={() => {
                      setAnchor(null);
                      leaveBar?.();
                      go({ view: "code", workspaceId: item.workspaceId ?? undefined, ptyId: item.ptyId });
                    }}
                  >
                    <span className={`viby-dot${item.working ? " working" : ""}`} />
                    <span className="grow truncate">
                      {item.program || item.title}
                      {wsName(item.workspaceId) ? ` · ${wsName(item.workspaceId)}` : ""}
                    </span>
                    {item.orchestrated && <span className="viby-tag">{t("orch.mine")}</span>}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Square}
                    tip={t("orch.stopOne")}
                    onClick={() => void stopOne(item.ptyId, item.runId)}
                  />
                </div>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** Popover button to search, switch, rename, create, or delete Viby conversation threads. */
export function ThreadsButton() {
  const t = useT();
  const { fail } = useToast();
  const deletedToast = useDeleted();
  const view = useOrchestrator().data;
  const threads = view?.threads ?? [];
  const activeId = view?.activeThreadId ?? "";
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const q = query.trim().toLowerCase();
  const shown = q
    ? threads.filter((item) => item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q))
    : threads;

  const commitRename = async (id: string) => {
    const clean = draftTitle.trim();
    setEditingId(null);
    if (!clean) return;
    try {
      await call("orchestrator.renameThread", id, clean);
    } catch (error: unknown) {
      fail(error, t("orch.failed"));
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={History}
        aria-expanded={Boolean(anchor)}
        tip={t("orch.threads")}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {threads.length > 1 ? String(threads.length) : undefined}
      </Button>
      {anchor && (
        <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)}>
          <div className="viby-review-popover viby-threads-popover">
            <div className="viby-threads-head">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("orch.threadsSearch")}
                aria-label={t("orch.threadsSearch")}
                autoFocus
              />
              <Button
                size="sm"
                icon={Plus}
                onClick={() => {
                  setAnchor(null);
                  void call("orchestrator.clear").catch((error: unknown) => fail(error, t("orch.failed")));
                }}
              >
                {t("orch.new")}
              </Button>
            </div>
            <div className="orch-review-list">
              {shown.length === 0 ? (
                <p className="small faint viby-threads-empty">{t("orch.threadsEmpty")}</p>
              ) : (
                shown.map((item) => {
                  const active = item.id === activeId;
                  if (editingId === item.id) {
                    return (
                      <div key={item.id} className="viby-thread-row">
                        <Input
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          autoFocus
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                            if (event.key === "Enter") void commitRename(item.id);
                            else if (event.key === "Escape") setEditingId(null);
                          }}
                        />
                        <Button size="sm" variant="ghost" icon={Check} onClick={() => void commitRename(item.id)} />
                        <Button size="sm" variant="ghost" icon={X} onClick={() => setEditingId(null)} />
                      </div>
                    );
                  }
                  return (
                    <div key={item.id} className={`viby-thread-row${active ? " active" : ""}`}>
                      <button
                        type="button"
                        className="menu-item grow"
                        onClick={() => {
                          setAnchor(null);
                          void call("orchestrator.selectThread", item.id).catch((error: unknown) => fail(error, t("orch.failed")));
                        }}
                      >
                        <span className="vstack grow" style={{ gap: 2, minWidth: 0, textAlign: "left" }}>
                          <span className="truncate">{item.title}</span>
                          {item.preview && <span className="faint small truncate">{item.preview}</span>}
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Pencil}
                        tip={t("orch.threadRename")}
                        onClick={() => {
                          setDraftTitle(item.title);
                          setEditingId(item.id);
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Trash2}
                        tip={t("common.delete")}
                        onClick={() => {
                          void call("orchestrator.deleteThread", item.id)
                            .then((deleted) => deletedToast(item.title, deleted))
                            .catch((error: unknown) => fail(error, t("orch.failed")));
                        }}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** Button toggling Viby's durable memory sheet (`~/.config/vibeforge/viby.md`). */
export function MemoryButton({ hasMemory, onOpen }: { hasMemory?: boolean; onOpen: () => void }) {
  const t = useT();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={hasMemory ? BookOpen : FileText}
      pressed={Boolean(hasMemory)}
      tip={t("orch.memoryTitle")}
      onClick={onOpen}
    />
  );
}

/** Plain-text editor sheet for `~/.config/vibeforge/viby.md`. */
export function VibyMemorySheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { push, fail } = useToast();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void call("orchestrator.readMemory")
      .then((content) => {
        if (!active) return;
        setText(content);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) fail(error, t("orch.failed"));
      });
    return () => {
      active = false;
    };
  }, [fail, t]);

  const [save, saving] = useAction(async (nextText: string) => {
    await call("orchestrator.writeMemory", nextText);
    push("info", t("orch.memorySaved"));
    onClose();
  }, t("orch.failed"));

  return (
    <Sheet onClose={onClose} width={520} label={t("orch.memoryTitle")}>
      <div className="vstack" style={{ gap: 12, padding: 16 }}>
        <div className="row" style={{ gap: 8 }}>
          <strong className="grow">{t("orch.memoryTitle")}</strong>
          <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} onClick={onClose} />
        </div>
        <p className="small faint" {...tipProps("~/.config/vibeforge/viby.md")}>
          {t("orch.memoryHint")}
        </p>
        <textarea
          className="input mono viby-memory-box"
          value={text}
          disabled={!loaded}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("orch.memoryPlaceholder")}
          rows={14}
        />
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" variant="ghost" disabled={!loaded || saving || !text.trim()} onClick={() => setText("")}>
            {t("orch.memoryClear")}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!loaded} busy={saving} onClick={() => void save(text)}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
