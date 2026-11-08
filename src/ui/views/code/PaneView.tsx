import { GripVertical, Maximize2, Minimize2, Play, RotateCcw, TerminalSquare, X } from "lucide-react";
import { memo, useRef, useState } from "react";
import type { Engine, PaneLaunch, TalkState, Workspace } from "../../../shared/api.js";
import { LiveTerminal, type TerminalHandle } from "../../components/Terminal.js";
import { TalkButton, TalkChip, type TalkTarget } from "../../components/TalkMenu.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import type { DropZone, PaneNode } from "../../pane-layout.js";
import type { Runtime } from "./useWorkspacePanes.js";

const PANE_MIME = "application/x-vibeforge-pane";

function zoneFor(event: React.DragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const edges: Array<[DropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [zone, distance] = edges.sort((a, b) => a[1] - b[1])[0];
  return distance < 0.28 ? zone : "center";
}

/**
 * What a pane can ask of Code. One object for every pane that never changes, whose members run
 * the latest render's code, so a pane only draws again when something it shows has changed.
 */
export interface PaneActions {
  focus: (workspace: Workspace, pane: PaneNode) => void;
  register: (paneId: string, handle: TerminalHandle | null) => void;
  exited: (paneId: string, text: string) => void;
  start: (workspace: Workspace, pane: PaneNode, launch: PaneLaunch, continueSession?: boolean) => void;
  close: (workspace: Workspace, pane: PaneNode) => void;
  review: (runId: string) => void;
  drag: (paneId: string | null) => void;
  drop: (workspace: Workspace, pane: PaneNode, sourceId: string, zone: DropZone) => void;
  zoom: (workspace: Workspace, pane: PaneNode) => void;
  openLink: (workspace: Workspace, url: string) => void;
  draft: (toPty: string) => void;
  newReviewer: (workspace: Workspace, pane: PaneNode, engineId: string) => Promise<string | null>;
}

interface PaneProps {
  workspace: Workspace;
  pane: PaneNode;
  runtime: Runtime | undefined;
  /** The run this pane is recording, if any. */
  runId: string | null;
  /** What a shell is running in its foreground, when it isn't at its prompt. */
  program: string | null;
  /** Its CLI went quiet out of sight and waits for you. */
  needsYou: boolean;
  /** The other coding CLIs working in the same folder. */
  alsoHere: string[];
  /** Messages with other CLIs, while there are any. */
  talk: TalkState | null;
  /** The other coding CLIs this one can send to; empty when it isn't one, or talking is off. */
  talkTargets: TalkTarget[];
  /** The CLIs that could be started beside this one to review it. */
  reviewEngines: Engine[];
  engines: Engine[];
  active: boolean;
  focused: boolean;
  canZoom: boolean;
  canMove: boolean;
  dragging: string | null;
  zoomed: boolean;
  /** Which shell this is in the workspace, when there is more than one. */
  shellNumber?: number | null;
  actions: PaneActions;
}

/** The same value, or arrays of the same values (objects in them compared one level down). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => Object.is(item, b[index]) || sameFields(item, b[index]));
}

function sameFields(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Lists made afresh each render (who else is here, where it can send) count as unchanged when they hold the same. */
export function samePaneProps(prev: PaneProps, next: PaneProps): boolean {
  const keys = Object.keys(next) as Array<keyof PaneProps>;
  return keys.length === Object.keys(prev).length && keys.every((key) => sameValue(prev[key], next[key]));
}

export const PaneView = memo(function PaneView({
  workspace,
  pane,
  runtime,
  runId,
  program,
  needsYou,
  alsoHere,
  talk,
  talkTargets,
  reviewEngines,
  engines,
  active,
  focused,
  canZoom,
  canMove,
  dragging,
  zoomed,
  shellNumber,
  actions,
}: PaneProps) {
  const t = useT();
  const state = runtime?.state ?? "idle";
  const [zone, setZone] = useState<DropZone | null>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const engine = pane.launch.type === "engine" ? engines.find((item) => item.id === (pane.launch as { engineId: string }).engineId) : null;
  const title = pane.launch.type === "shell" ? `${t("common.shell")}${shellNumber ? ` ${shellNumber}` : ""}` : (engine?.label ?? (pane.launch as { engineId: string }).engineId);
  // A shell running something shows that instead: `claude` typed at the prompt reads "Claude Code".
  const shown = state === "live" && program ? program : title;
  const onFocus = () => actions.focus(workspace, pane);
  const onStart = (launch: PaneLaunch, continueSession?: boolean) => actions.start(workspace, pane, launch, continueSession);
  const onClose = () => actions.close(workspace, pane);
  const onZoom = () => actions.zoom(workspace, pane);

  return (
    <div className={`pane${focused ? " focused" : ""}${zoomed ? " is-zoomed" : ""}${dragging === pane.id ? " is-dragging" : ""}`} data-pane={pane.id} onMouseDown={onFocus}>
      <div
        className={`pane-head${canMove ? " can-move" : ""}${needsYou ? " needs-you" : ""}`}
        draggable={canMove}
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_MIME, pane.id);
          event.dataTransfer.effectAllowed = "move";
          actions.drag(pane.id);
        }}
        onDragEnd={() => actions.drag(null)}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button") || !(canZoom || zoomed)) return;
          onZoom();
        }}
      >
        {canMove && (
          <span className="pane-grip" {...tipProps(t("pane.drag"))}>
            <GripVertical size={13} />
          </span>
        )}
        {state === "live" ? (
          <span className="dot running" role="img" aria-label={t("pane.running")} {...tipProps(t("pane.running"))} />
        ) : state === "exited" ? (
          <span className="dot stopped" role="img" aria-label={t("pane.exited")} {...tipProps(t("pane.exited"))} />
        ) : (
          <span className="dot" role="img" aria-label={t("pane.idle")} {...tipProps(t("pane.idle"))} />
        )}
        <span className="pane-title truncate">{shown}</span>
        {shown !== title && <span className="pane-sub truncate">{title}</span>}
        {alsoHere.length > 0 && (
          <span className="pane-sub truncate" {...tipProps(t("occupancy.paneTip"))}>
            {t("occupancy.alsoHere", { names: alsoHere.join(", ") })}
          </span>
        )}
        {runId && (
          <button type="button" className="pane-run-link" onClick={() => actions.review(runId)} {...tipProps(t("pane.openRun"))}>
            {t("pane.run")}
          </button>
        )}
        {zoomed && <span className="chip accent">{t("pane.maximized")}</span>}
        {talk && runtime?.ptyId && <TalkChip ptyId={runtime.ptyId} talk={talk} />}
        <span className="grow" />
        <div className="pane-actions">
          {state === "live" && runtime?.ptyId && (
            <TalkButton
              ptyId={runtime.ptyId}
              targets={talkTargets}
              engines={reviewEngines}
              selection={() => terminalRef.current?.selection() ?? ""}
              onDraft={actions.draft}
              onNewReviewer={(engineId) => actions.newReviewer(workspace, pane, engineId)}
            />
          )}
          {(canZoom || zoomed) && (
            <Button size="sm" variant="ghost" icon={zoomed ? Minimize2 : Maximize2} tip={zoomed ? t("pane.restore") : t("pane.maximize")} kbd="Ctrl+Shift+M" onClick={onZoom} />
          )}
          <Button size="sm" variant="ghost" icon={X} tip={t("pane.close")} kbd="Ctrl+Shift+W" onClick={onClose} />
        </div>
      </div>
      {dragging && dragging !== pane.id && (
        <div
          className="pane-drop"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(PANE_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const next = zoneFor(event);
            setZone((prev) => (prev === next ? prev : next));
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setZone(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = event.dataTransfer.getData(PANE_MIME);
            const where = zone ?? "center";
            setZone(null);
            if (source) actions.drop(workspace, pane, source, where);
          }}
        >
          {zone && (
            <div className={`drop-zone zone-${zone}`}>
              <span>{zone === "center" ? t("pane.swap") : t(`pane.dock.${zone}`)}</span>
            </div>
          )}
        </div>
      )}
      {runtime?.ptyId && state !== "idle" ? (
        <>
          <LiveTerminal
            key={runtime.ptyId}
            ref={(handle) => {
              terminalRef.current = handle;
              actions.register(pane.id, handle);
            }}
            ptyId={runtime.ptyId}
            active={active}
            autoFocus={focused}
            onFocus={onFocus}
            onLink={(url) => actions.openLink(workspace, url)}
            onExit={(info) => actions.exited(pane.id, info.signal ? t("pane.exitSignal", { signal: info.signal }) : t("pane.exitCode", { code: info.exitCode ?? "?" }))}
          />
          {state === "exited" && (
            <div className="pane-exit">
              <span className="grow truncate">
                {title} {runtime.exitText}
              </span>
              {pane.launch.type === "engine" && engine?.continueArgs?.length ? (
                <Button size="sm" icon={RotateCcw} onClick={() => onStart(pane.launch, true)}>
                  {t("common.continue")}
                </Button>
              ) : null}
              <Button size="sm" icon={Play} onClick={() => onStart(pane.launch)}>
                {t("common.restart")}
              </Button>
              <Button size="sm" variant="ghost" icon={X} onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="pane-idle">
          {state === "starting" ? (
            <span className="hstack">
              <span className="spinner" /> {t("pane.starting", { title })}
            </span>
          ) : pane.launch.type === "engine" ? (
            <>
              <span>
                {t("pane.lastTime", { title })}
                {engine && !engine.available ? ` ${t("pane.notOnPath")}` : ""}
              </span>
              <div className="launchers">
                {engine?.continueArgs?.length ? (
                  <Button variant="primary" icon={RotateCcw} disabled={!engine?.available} onClick={() => onStart(pane.launch, true)}>
                    {t("pane.continueSession")}
                  </Button>
                ) : null}
                <Button icon={Play} disabled={!engine?.available} onClick={() => onStart(pane.launch)}>
                  {t("pane.startEngine", { title })}
                </Button>
                <Button icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  {t("pane.shellInstead")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <span>{t("pane.nothing")}</span>
              <div className="launchers">
                <Button variant="primary" icon={TerminalSquare} onClick={() => onStart({ type: "shell" })}>
                  {t("code.newTerminal")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}, samePaneProps);
