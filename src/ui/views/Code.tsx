import { Columns2, FolderPlus, PanelRight, Play, Rows2, SquareTerminal, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveSession, Workspace, WorkspaceFile } from "../../shared/api.js";
import { shellQuote, tildify } from "../../shared/text.js";
import { call, useAgents, useAppInfo, useEngines, useLive, useSettings, useWorkspaces } from "../api.js";
import { setPtyInView, setWorkspaceInView, usePtyAttention } from "../attention.js";
import type { TalkTarget } from "../components/TalkMenu.js";
import { tipProps } from "../components/Tooltip.js";
import { shellNumber } from "../components/WorkspaceState.js";
import { Button, Empty } from "../components/ui.js";
import { useT } from "../i18n/index.js";
import { panesOf, type PaneNode } from "../pane-layout.js";
import { useAction, useConfirm, useNav, useToast, type Route } from "../state.js";
import { shortcutKeys } from "../shortcuts.js";
import { MicButton, setDictationTarget, useDictationTarget, type DictationTarget } from "../voice.js";
import { BranchDialog } from "./BranchDialog.js";
import { CodeSide, useCodeSide } from "./code/CodeSide.js";
import { PaneView, type PaneActions } from "./code/PaneView.js";
import { SplitView } from "./code/SplitView.js";
import { useCodeShortcuts } from "./code/useCodeShortcuts.js";
import { isCodingCli, useWorkspacePanes } from "./code/useWorkspacePanes.js";
import { WorkspaceList } from "./code/WorkspaceList.js";

// Code mode: the workspace list, each workspace's panes of terminals, and the files and browser
// panel beside them. The pieces live in ./code/; this puts them together.

/** One object that never changes, whose members always run the latest render's functions. */
function useStableActions<T extends object>(actions: T): T {
  const latest = useRef(actions);
  latest.current = actions;
  const stable = useRef<T | null>(null);
  if (!stable.current) {
    const forward = {} as Record<string, (...args: unknown[]) => unknown>;
    for (const name of Object.keys(actions)) forward[name] = (...args) => (latest.current as Record<string, (...args: unknown[]) => unknown>)[name](...args);
    stable.current = forward as T;
  }
  return stable.current;
}

export function CodeView({ active, route }: { active: boolean; route: Extract<Route, { view: "code" }> | null }) {
  const t = useT();
  const { go } = useNav();
  const { push } = useToast();
  const confirm = useConfirm();
  const file = useWorkspaces();
  const engines = useEngines().data ?? [];
  const agents = useAgents().data ?? [];
  const settings = useSettings().data;
  const live = useLive().data ?? [];
  const talkOn = settings?.agentTalk.on ?? false;
  const home = useAppInfo().data?.home ?? "";
  const workspaces = useMemo(() => file.data?.workspaces ?? [], [file.data]);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [dragPane, setDragPane] = useState<string | null>(null);
  const [branchFor, setBranchFor] = useState<Workspace | null>(null);
  const ptyAttention = usePtyAttention();

  const current = workspaces.find((item) => item.id === currentId) ?? null;
  // The view stays mounted so terminals survive mode switches, but nothing starts until it is opened.
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  const engineLabel = (id: string) => engines.find((engine) => engine.id === id)?.label ?? id;

  // ---------------------------------------------------------------- choose the workspace

  useEffect(() => {
    if (route?.workspaceId && route.workspaceId !== currentId && workspaces.some((item) => item.id === route.workspaceId)) {
      setCurrentId(route.workspaceId);
      return;
    }
    if (currentId && workspaces.some((item) => item.id === currentId)) return;
    const next = file.data?.lastWorkspaceId ?? workspaces[0]?.id ?? null;
    if (next !== currentId) setCurrentId(next);
  }, [route?.workspaceId, workspaces, file.data, currentId]);

  const side = useCodeSide(workspaces);
  const panes = useWorkspacePanes({ opened, current, route, workspaces, live, engines, defaultEngine: settings?.defaultEngine, fontSize: settings?.terminalFontSize ?? 13 });
  const { layouts, runtime, focus, zoomed, terminals } = panes;

  // The shell's session watch flags CLIs that go quiet out of sight; it needs to know what's shown.
  useEffect(() => setWorkspaceInView(active ? (current?.id ?? null) : null), [active, current?.id]);
  useEffect(() => () => setWorkspaceInView(null), []);
  // Only the focused pane counts as looked at: the others in the workspace keep their glow.
  const focusedPty = active && current ? (runtime[focus[current.id] ?? ""]?.ptyId ?? null) : null;
  useEffect(() => setPtyInView("code", focusedPty), [focusedPty]);
  useEffect(() => () => setPtyInView("code", null), []);

  useCodeShortcuts(active, current, panes);

  // ---------------------------------------------------------------- dictation

  /** Names whisper should expect in a workspace: its own name and what sits at its top level. */
  const workspaceWords = async (workspace: Workspace) => [workspace.name, ...(await call("files.list", workspace.path)).slice(0, 60).map((node) => node.name)];

  /** A pane as a place for dictated words: pasted into its terminal, or into the launch bar while it has none. */
  function paneTarget(workspace: Workspace, pane: PaneNode): DictationTarget {
    const title = pane.launch.type === "shell" ? t("common.shell") : engineLabel(pane.launch.engineId);
    return {
      label: `${title} · ${workspace.name}`,
      element: () => document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane.id)}"]`),
      insert: (text) => terminals.current.get(pane.id)?.paste(text),
      ptyId: () => panes.livePty(pane.id),
      words: () => workspaceWords(workspace),
    };
  }

  /** The toolbar mic: dictation into the pane that has focus in the workspace on screen, then back to it for Enter. */
  const toolbarMic = useDictationTarget(() => {
    const layout = current ? layouts[current.id] : null;
    const shown = layout ? panesOf(layout) : [];
    const pane = (current && shown.find((item) => item.id === focus[current.id])) ?? shown[0];
    if (!current || !pane) return { label: "", element: () => null, insert: () => undefined };
    const into = paneTarget(current, pane);
    return {
      ...into,
      insert: (text) => {
        into.insert(text);
        terminals.current.get(pane.id)?.focus();
      },
    };
  });

  /**
   * The other coding CLIs open anywhere, for Send to…: this workspace's terminals first. Any other
   * says where it is (another workspace, a task, a chat, a routine), so it is never picked unseen.
   */
  function talkTargets(session: LiveSession, workspace: Workspace): TalkTarget[] {
    const place = (other: LiveSession): string | null => {
      const elsewhere = other.workspaceId === workspace.id ? null : (workspaces.find((item) => item.id === other.workspaceId)?.name ?? null);
      const views: Partial<Record<NonNullable<LiveSession["origin"]>, string>> = { task: t("rail.tasks"), chat: t("rail.chat"), "agent-chat": t("rail.agents"), routine: t("rail.routines") };
      const view = (other.origin && views[other.origin]) || null;
      if (!view && !elsewhere && other.workspaceId !== workspace.id) return t("talk.elsewhere");
      return [view, elsewhere].filter(Boolean).join(" · ") || null;
    };
    return live
      .filter((other) => other.ptyId !== session.ptyId && isCodingCli(other))
      .map((other) => ({
        ptyId: other.ptyId,
        label: agents.find((agent) => agent.id === other.agentId)?.name ?? (other.program || other.title.split(" · ")[0] || other.title),
        where: place(other),
      }))
      .sort((a, b) => Number(a.where !== null) - Number(b.where !== null));
  }

  /** Bring the pane holding `ptyId` forward and into focus, when it is in Code. */
  function focusPty(ptyId: string) {
    for (const [workspaceId, node] of Object.entries(layouts)) {
      const pane = node && panesOf(node).find((item) => runtime[item.id]?.ptyId === ptyId);
      if (!pane) continue;
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (workspace) select(workspace);
      panes.setFocus((prev) => ({ ...prev, [workspaceId]: pane.id }));
      setTimeout(() => terminals.current.get(pane.id)?.focus(), 0);
      return;
    }
  }

  function insertPath(target: string) {
    if (!current) return;
    const paneId = focus[current.id];
    const handle = paneId ? terminals.current.get(paneId) : undefined;
    if (!handle) {
      push("info", t("code.focusFirst"), t("code.focusFirstBody"));
      return;
    }
    handle.paste(`${shellQuote(target)} `);
  }

  const paneActions = useStableActions<PaneActions>({
    focus: (workspace, pane) => {
      setDictationTarget(paneTarget(workspace, pane));
      panes.focusPane(workspace.id, pane.id);
    },
    register: (paneId, handle) => {
      if (handle) terminals.current.set(paneId, handle);
      else terminals.current.delete(paneId);
    },
    exited: (paneId, text) => panes.patchRuntime(paneId, { state: "exited", exitText: text }),
    start: (workspace, pane, launch, continueSession) => panes.launchHere(workspace, pane, launch, { continueSession }),
    close: (workspace, pane) => void panes.closePane(workspace, pane),
    review: (runId) => go({ view: "runs", runId }),
    drag: setDragPane,
    drop: (workspace, pane, sourceId, zone) => {
      setDragPane(null);
      panes.dropPane(workspace.id, sourceId, pane.id, zone);
    },
    zoom: (workspace, pane) => panes.toggleZoom(workspace.id, pane.id),
    openLink: (workspace, url) => side.openInBrowser(workspace.id, url),
    draft: (toPty) => focusPty(toPty),
    newReviewer: (workspace, pane, engineId) => panes.startReviewer(workspace, pane.id, engineId),
  });

  // ---------------------------------------------------------------- workspaces

  const [addWorkspace] = useAction(async () => {
    const folder = await call("app.pickFolder", t("code.empty.action"));
    if (!folder) return;
    const next = await call("workspaces.add", folder);
    if (next.lastWorkspaceId) {
      setCurrentId(next.lastWorkspaceId);
      void call("workspaces.select", next.lastWorkspaceId);
    }
  }, t("code.addFailed"));

  const [removeWorkspace] = useAction(async (workspace: Workspace) => {
    const running = live.filter((session) => session.workspaceId === workspace.id).length;
    const ok = await confirm({
      title: t("code.removeTitle", { name: workspace.name }),
      body: [t("code.removeBody"), running ? t.count("code.removeRunning", running) : ""].filter(Boolean).join(" "),
      confirm: t("code.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    await call("workspaces.remove", workspace.id);
    await call("dock.release", workspace.id).catch(() => undefined);
    side.forgetDock(workspace.id);
    panes.forget(workspace.id);
    if (currentId === workspace.id) setCurrentId(null);
  }, t("code.removeFailed"));

  function select(workspace: Workspace) {
    setCurrentId(workspace.id);
    void call("workspaces.select", workspace.id).catch(() => undefined);
    if (route?.workspaceId && route.workspaceId !== workspace.id) go({ view: "code", workspaceId: workspace.id });
  }

  function openedBranch(file: WorkspaceFile) {
    setBranchFor(null);
    const id = file.lastWorkspaceId;
    if (!id) return;
    const workspace = file.workspaces.find((item) => item.id === id);
    if (workspace) select(workspace);
  }

  // ---------------------------------------------------------------- render

  return (
    <div className="view" hidden={!active}>
      <div className="code-view">
        <WorkspaceList workspaces={workspaces} currentId={currentId} onSelect={select} onAdd={() => void addWorkspace()} onRemove={(workspace) => void removeWorkspace(workspace)} onBranch={setBranchFor} />

        {!current ? (
          <Empty
            icon={SquareTerminal}
            title={t("code.empty.title")}
            actions={
              <Button variant="primary" icon={FolderPlus} onClick={() => void addWorkspace()}>
                {t("code.empty.action")}
              </Button>
            }
          >
            {t("code.empty.body")}
          </Empty>
        ) : (
          <div className="code-main">
            <div className="code-toolbar">
              <div className="vstack grow" style={{ gap: 0 }}>
                <strong className="truncate" style={{ fontSize: "var(--fs-md)" }}>
                  {current.name}
                </strong>
                <button type="button" className="faint mono truncate" style={{ fontSize: "var(--fs-xs)", textAlign: "left" }} onClick={() => void call("app.openPath", current.path)} {...tipProps(t("common.openFileManager"))}>
                  {tildify(current.path, home)}
                </button>
              </div>
              <MicButton size="sm" target={toolbarMic.target} hint={t("code.dictate")} disabled={!layouts[current.id]} />
              <span className="toolbar-sep" />
              <Button size="sm" variant="ghost" icon={Columns2} tip={t("code.splitRight")} kbd={shortcutKeys("code.splitRight")} onClick={() => panes.newTerminal(current, "row")} />
              <Button size="sm" variant="ghost" icon={Rows2} tip={t("code.splitDown")} kbd={shortcutKeys("code.splitDown")} onClick={() => panes.newTerminal(current, "col")} />
              <span className="toolbar-sep" />
              <Button size="sm" variant="ghost" icon={PanelRight} pressed={side.open} tip={t("code.sideTip")} onClick={() => side.setOpen(!side.open)} />
            </div>

            <div className="code-work">
              {workspaces.map((workspace) => {
                const layout = layouts[workspace.id];
                const visible = workspace.id === current.id;
                if (layout === null && visible) {
                  return (
                    <div key={workspace.id} className="canvas">
                      <Empty
                        icon={SquareTerminal}
                        title={t("code.noPanes.title")}
                        actions={
                          <>
                            <Button variant="primary" icon={TerminalSquare} kbd={shortcutKeys("code.splitRight")} onClick={() => panes.openFirst(workspace, { type: "shell" })}>
                              {t("code.newTerminal")}
                            </Button>
                            {/* The CLIs found on this machine, one click each instead of a shell and typing. */}
                            {engines
                              .filter((engine) => engine.available)
                              .map((engine) => (
                                <Button key={engine.id} icon={Play} tip={t("code.startEngine", { engine: engine.label })} onClick={() => panes.openFirst(workspace, { type: "engine", engineId: engine.id })}>
                                  {engine.label}
                                </Button>
                              ))}
                          </>
                        }
                      >
                        {t("code.noPanes.body")}
                      </Empty>
                    </div>
                  );
                }
                if (!layout) return null;
                const paneCount = panesOf(layout).length;
                const zoomedPane = zoomed[workspace.id] && panesOf(layout).some((pane) => pane.id === zoomed[workspace.id]) ? zoomed[workspace.id] : null;
                return (
                  <div key={workspace.id} className={`canvas${zoomedPane ? " has-zoom" : ""}`} style={visible ? undefined : { display: "none" }}>
                    <SplitView
                      node={layout}
                      onRatio={(path, ratio, done) => panes.setRatio(workspace.id, path, ratio, done)}
                      renderPane={(pane) => {
                        const session = live.find((item) => item.ptyId === runtime[pane.id]?.ptyId);
                        // A launched CLI is its own run; a shell has one while a CLI typed into it is recorded.
                        const runId = runtime[pane.id]?.runId ?? session?.runId ?? null;
                        return (
                          <PaneView
                            key={pane.id}
                            workspace={workspace}
                            pane={pane}
                            runtime={runtime[pane.id]}
                            runId={runId}
                            program={session?.program ?? null}
                            shellNumber={shellNumber(runtime[pane.id]?.ptyId, live)}
                            needsYou={ptyAttention.get(runtime[pane.id]?.ptyId ?? "")?.attention === "waiting"}
                            alsoHere={(session?.alsoHere ?? []).map((other) => agents.find((agent) => agent.id === other.agentId)?.name ?? other.label)}
                            talk={session?.talk ?? null}
                            talkTargets={session && isCodingCli(session) && talkOn ? talkTargets(session, workspace) : []}
                            reviewEngines={session && isCodingCli(session) && talkOn ? engines.filter((engine) => engine.available) : []}
                            engines={engines}
                            active={active && visible}
                            focused={focus[workspace.id] === pane.id}
                            canZoom={paneCount > 1}
                            canMove={paneCount > 1 && !zoomedPane}
                            dragging={dragPane}
                            zoomed={zoomedPane === pane.id}
                            actions={paneActions}
                          />
                        );
                      }}
                    />
                  </div>
                );
              })}
              {side.open && <CodeSide panel={side} workspace={current} active={active} onInsert={insertPath} />}
            </div>
          </div>
        )}
      </div>
      {branchFor && <BranchDialog workspace={branchFor} onClose={() => setBranchFor(null)} onOpened={openedBranch} />}
    </div>
  );
}
