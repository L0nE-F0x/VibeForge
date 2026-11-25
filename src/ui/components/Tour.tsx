import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FolderOpen,
  Play,
  CircleDot,
  Compass,
  FolderPlus,
  History,
  House,
  ImagePlus,
  KanbanSquare,
  LifeBuoy,
  MessagesSquare,
  Move,
  PanelLeftClose,
  Palette,
  Phone,
  Rocket,
  Send,
  Settings,
  SquareTerminal,
  AudioLines,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { tildify } from "../../shared/text.js";
import { call, useAppInfo, useEngines, useWorkspaces } from "../api.js";
import { startCliIn } from "../first-run.js";
import { useT, type Key } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { pushOverlay } from "../overlays.js";
import { useNav, useOverlay, useToast, type Route } from "../state.js";
import { Button, Logo, cx } from "./ui.js";
import { WhichOne, WhichOneIcon } from "./WhichOne.js";
import { isShortcut, shortcutKeys } from "../shortcuts.js";

// The welcome tour: a card that walks the rail and each view, with a spotlight on the part
// being described. The short one opens by itself until it has been finished or skipped once, and
// ends by starting a CLI in a folder of yours. Help in the rail (or Settings) replays it, and
// Help's "Tour of every view" walks the full one.

export const START_TOUR_EVENT = "vibeforge:start-tour";

export type TourKind = "short" | "full";

export function startTour(kind: TourKind = "short"): void {
  window.dispatchEvent(new CustomEvent<TourKind>(START_TOUR_EVENT, { detail: kind }));
}

/** Which tour a start event asked for. */
export function tourOf(event: Event): TourKind {
  return (event as CustomEvent<unknown>).detail === "full" ? "full" : "short";
}

/** What the short tour's last step started: its pane is spotlit on the card after it. */
interface Started {
  ptyId: string;
  workspaceId: string;
  workspace: string;
  /** The CLI typed into the terminal, or null for a plain terminal. */
  cli: string | null;
}

type Side = "right" | "left" | "bottom" | "top";

const CARD_W = 360;

interface Step {
  id: string;
  /** Opened before the step is shown. */
  route?: Route;
  /** Selectors tried in order; the first one on screen is spotlit. With none, the card sits in the middle. */
  target?: string[];
  side?: Side;
  icon: LucideIcon;
  title?: Key;
  body?: Key;
  keys?: Array<[string, Key]>;
  /** Shown under the body, in a card this wide. */
  extra?: { content: ComponentType; width: number };
  /** The short tour's last two cards: the guided start, and what it started. */
  special?: "try" | "end";
}

const LIST_PANEL = ".view.split-list > .list-panel-slot > .list-panel";
const CODE_MAIN = [".code-view .code-main", ".code-view > .empty"];

/** The tour that opens on first start: six cards, then a CLI started in a folder of yours. */
const SHORT_STEPS: Step[] = [
  { id: "welcome", icon: Compass },
  {
    id: "clis",
    title: "first.tour.clis.title",
    body: "first.tour.clis.body",
    route: { view: "home" },
    target: [".home-clis", ".home-page"],
    side: "left",
    icon: SquareTerminal,
    extra: { content: FoundClis, width: CARD_W },
  },
  {
    id: "code",
    title: "first.tour.code.title",
    body: "first.tour.code.body",
    route: { view: "code" },
    target: CODE_MAIN,
    side: "left",
    icon: Move,
    keys: [
      [shortcutKeys("code.splitRight"), "shortcuts.splitRight"],
      [shortcutKeys("code.maximize"), "shortcuts.maximize"],
    ],
  },
  {
    id: "tasks",
    title: "first.tour.tasks.title",
    body: "first.tour.tasks.body",
    route: { view: "tasks" },
    target: [".board", ".stage"],
    side: "bottom",
    icon: KanbanSquare,
  },
  {
    id: "viby",
    title: "first.tour.viby.title",
    body: "first.tour.viby.body",
    route: { view: "orchestrator" },
    target: [".viby-view", ".stage"],
    side: "left",
    icon: AudioLines,
    keys: [[shortcutKeys("app.orchestrator"), "shortcuts.orchestrator"]],
  },
  {
    id: "files",
    title: "first.tour.files.title",
    body: "first.tour.files.body",
    target: ['[data-tour="help"]'],
    side: "right",
    icon: FolderOpen,
    extra: { content: FilePlaces, width: 420 },
  },
  {
    id: "try",
    title: "first.tour.try.title",
    route: { view: "code" },
    target: CODE_MAIN,
    side: "left",
    icon: Play,
    special: "try",
  },
  { id: "end", icon: Rocket, special: "end" },
];

/** Every view, one card each: Help → Tour of every view. */
const FULL_STEPS: Step[] = [
  { id: "welcome", icon: Compass },
  {
    id: "rail",
    title: "tour.rail.title",
    body: "tour.rail.body",
    target: [".rail"],
    side: "right",
    icon: Compass,
    keys: [
      [shortcutKeys("app.switcher"), "shortcuts.switcher"],
      [shortcutKeys("app.views"), "shortcuts.switchViews"],
      [shortcutKeys("app.back"), "shortcuts.back"],
    ],
  },
  {
    id: "home",
    title: "tour.home.title",
    body: "tour.home.body",
    route: { view: "home" },
    target: [".home-page", ".stage"],
    side: "right",
    icon: House,
  },
  {
    id: "workspaces",
    title: "tour.workspaces.title",
    body: "tour.workspaces.body",
    route: { view: "code" },
    target: [".code-view > .list-panel-slot > .list-panel"],
    side: "right",
    icon: SquareTerminal,
  },
  {
    id: "panes",
    title: "tour.panes.title",
    body: "tour.panes.body",
    route: { view: "code" },
    target: [".code-view .code-work", ".code-view .empty"],
    side: "left",
    icon: Move,
    keys: [
      [shortcutKeys("code.splitRight"), "shortcuts.splitRight"],
      [shortcutKeys("code.maximize"), "shortcuts.maximize"],
      [shortcutKeys("terminal.copy"), "shortcuts.copy"],
      [shortcutKeys("terminal.paste"), "shortcuts.paste"],
    ],
  },
  {
    id: "record",
    title: "tour.record.title",
    body: "tour.record.body",
    route: { view: "code" },
    // With no terminal open yet (a first run), the empty workspace says the same thing: point at that.
    target: [".code-view .pane.focused .pane-head", ".code-view .pane-head", ".code-view .empty"],
    side: "bottom",
    icon: CircleDot,
  },
  {
    id: "together",
    title: "tour.together.title",
    body: "tour.together.body",
    route: { view: "code" },
    target: [".code-view .pane.focused .pane-actions", ".code-view .pane-actions", ".code-view .pane-head", ".code-view .empty"],
    side: "bottom",
    icon: Send,
  },
  {
    id: "agents",
    title: "tour.agents.title",
    body: "tour.agents.body",
    route: { view: "agents" },
    target: [LIST_PANEL],
    side: "right",
    icon: Bot,
  },
  {
    id: "chat",
    title: "tour.chat.title",
    body: "tour.chat.body",
    route: { view: "chat" },
    target: [LIST_PANEL],
    side: "right",
    icon: MessagesSquare,
  },
  {
    id: "tasks",
    title: "tour.tasks.title",
    body: "tour.tasks.body",
    route: { view: "tasks" },
    target: [".board", ".stage"],
    side: "bottom",
    icon: KanbanSquare,
  },
  {
    id: "maestro",
    title: "tour.maestro.title",
    body: "tour.maestro.body",
    route: { view: "orchestrator" },
    target: [".viby-view", ".stage"],
    side: "left",
    icon: AudioLines,
    keys: [[shortcutKeys("app.orchestrator"), "shortcuts.orchestrator"]],
  },
  {
    id: "vibyBox",
    title: "tour.vibyBox.title",
    body: "tour.vibyBox.body",
    route: { view: "orchestrator" },
    target: [".viby-composer-wrap", ".viby-view"],
    side: "top",
    icon: ImagePlus,
  },
  {
    id: "call",
    title: "tour.call.title",
    body: "tour.call.body",
    target: [".rail-foot .viby-btn"],
    side: "right",
    icon: Phone,
    keys: [
      [shortcutKeys("app.call"), "shortcuts.call"],
      [shortcutKeys("voice.dictate"), "shortcuts.dictate"],
    ],
  },
  {
    id: "runs",
    title: "tour.runs.title",
    body: "tour.runs.body",
    route: { view: "runs" },
    target: [LIST_PANEL],
    side: "right",
    icon: History,
  },
  {
    id: "room",
    title: "tour.room.title",
    body: "tour.room.body",
    route: { view: "runs" },
    target: [`${LIST_PANEL} > .list-head`],
    side: "right",
    icon: PanelLeftClose,
    keys: [[shortcutKeys("app.panel"), "shortcuts.panel"]],
  },
  {
    id: "more",
    title: "tour.more.title",
    body: "tour.more.body",
    target: ['[data-tour="settings"]'],
    side: "right",
    icon: Settings,
  },
  {
    id: "which",
    title: "whichOne.title",
    body: "tour.whichOne.body",
    target: [".rail"],
    side: "right",
    icon: WhichOneIcon,
    extra: { content: WhichOne, width: 600 },
  },
  {
    id: "help",
    title: "tour.help.title",
    body: "tour.help.body",
    target: ['[data-tour="help"]'],
    side: "right",
    icon: LifeBuoy,
    keys: [[shortcutKeys("app.shortcuts"), "help.shortcuts"]],
  },
  { id: "done", icon: Rocket },
];

const PAD = 8;
const GAP = 16;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** A spotlight or card position, tagged with the step it was measured for. */
type ForStep<T> = T & { step: number };

function findTarget(selectors: string[] | undefined): HTMLElement | null {
  for (const selector of selectors ?? []) {
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = node.getBoundingClientRect();
      if (node.offsetParent !== null && rect.width > 0 && rect.height > 0) return node;
    }
  }
  return null;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** Where the card goes: beside the spotlight on the preferred side, or inside it when it fills the screen. */
function placeCard(hole: Rect, side: Side, card: { width: number; height: number }): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (spot: { left: number; top: number }) => ({
    left: Math.min(Math.max(16, spot.left), vw - card.width - 16),
    top: Math.min(Math.max(16, spot.top), vh - card.height - 16),
  });
  const at = (where: Side) => {
    if (where === "right") return { left: hole.left + hole.width + GAP, top: hole.top + Math.min(24, hole.height / 2 - card.height / 2) };
    if (where === "left") return { left: hole.left - GAP - card.width, top: hole.top + 24 };
    if (where === "bottom") return { left: hole.left + 24, top: hole.top + hole.height + GAP };
    return { left: hole.left + 24, top: hole.top - GAP - card.height };
  };
  const fits = (spot: { left: number; top: number }) => spot.left >= 16 && spot.top >= 16 && spot.left + card.width <= vw - 16 && spot.top + card.height <= vh - 16;
  const order: Side[] = [side, ...(["right", "left", "bottom", "top"] as Side[]).filter((item) => item !== side)];
  for (const where of order) {
    const spot = at(where);
    if (where === "right" || where === "left") {
      const clamped = { ...spot, top: Math.min(Math.max(16, spot.top), vh - card.height - 16) };
      if (fits(clamped)) return clamped;
    } else {
      const clamped = { ...spot, left: Math.min(Math.max(16, spot.left), vw - card.width - 16) };
      if (fits(clamped)) return clamped;
    }
  }
  // A spotlight that fills the screen: float the card inside its lower right corner.
  return clamp({ left: hole.left + hole.width - card.width - 28, top: hole.top + hole.height - card.height - 28 });
}

export function Tour({ kind = "short", onClose }: { kind?: TourKind; onClose: () => void }) {
  const t = useT();
  const { route, go } = useNav();
  const STEPS = kind === "full" ? FULL_STEPS : SHORT_STEPS;
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState<Started | null>(null);
  // The spotlight keeps its last rect between steps so it can glide to the next target;
  // the card stays hidden until it has been placed for the current step.
  const [hole, setHole] = useState<ForStep<Rect> | null>(null);
  const [cardPos, setCardPos] = useState<ForStep<{ left: number; top: number }> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const step = targetted(STEPS[index], started);
  const centered = step.id === "welcome" || step.id === "done" || (step.special === "end" && !step.target);
  useOverlay(true);

  const move = useCallback((delta: number) => setIndex((current) => Math.min(STEPS.length - 1, Math.max(0, current + delta))), [STEPS.length]);
  // Finishing after a CLI started hands the keyboard to its terminal.
  const finish = useCallback(() => {
    onClose();
    if (started) go({ view: "code", workspaceId: started.workspaceId, ptyId: started.ptyId });
  }, [onClose, started, go]);

  // Open the step's view, then follow its target while the view loads and the window resizes.
  useEffect(() => {
    if (step.route && route.view !== step.route.view) go(step.route);
    if (centered || !step.target) {
      setHole(null);
      return;
    }
    const measure = () => {
      const node = findTarget(step.target);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const next = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2, step: index };
      // Keep the spotlight inside the window so its rounded edge stays visible.
      next.left = Math.max(4, next.left);
      next.top = Math.max(4, next.top);
      next.width = Math.min(next.width, window.innerWidth - next.left - 4);
      next.height = Math.min(next.height, window.innerHeight - next.top - 4);
      setHole((prev) => (prev?.step === index && sameRect(prev, next) ? prev : next));
    };
    measure();
    const timer = window.setInterval(measure, 120);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // A card that grows after it was placed (the guided step, once a folder is picked) is placed again.
  const [cardHeight, setCardHeight] = useState(0);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setCardHeight(card.offsetHeight));
    watch.observe(card);
    return () => watch.disconnect();
  }, [index, centered]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || centered || !hole || hole.step !== index) return;
    setCardPos({ ...placeCard(hole, step.side ?? "right", { width: card.offsetWidth, height: card.offsetHeight }), step: index });
  }, [hole, index, centered, step.side, cardHeight]);

  const cardHere = cardPos?.step === index ? cardPos : null;
  // A step whose target never showed up gets a centred card with no spotlight.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
    if (centered || !step.target) return;
    const timer = window.setTimeout(() => setMissing(!findTarget(step.target)), 1000);
    return () => window.clearTimeout(timer);
  }, [index, centered, step.target]);

  // On the overlay stack like any dialog: Code's keys wait behind it (Ctrl+Shift+D on its Code
  // step would split a pane under the card), terminals don't take focus from it, and Tab stays in it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => pushOverlay({ close: () => closeRef.current(), node: () => rootRef.current, trap: true }), []);

  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (event: KeyboardEvent) => {
      // Enter on a focused button (Skip tour, Skip for now) is that button's, not Next.
      if (event.key === "Enter" && (event.target as HTMLElement | null)?.closest?.("button")) return;
      if (isShortcut("tour.next", event)) {
        if (index === STEPS.length - 1) finish();
        else move(1);
      } else if (isShortcut("tour.back", event)) move(-1);
      else if (isShortcut("overlay.close", event)) finish();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, move, finish, STEPS.length]);

  const tourSteps = STEPS.length - 2;
  const stepNo = index;
  const width = step.extra ? Math.min(step.extra.width, window.innerWidth - 32) : CARD_W;

  return createPortal(
    <div ref={rootRef} className={cx("tour", centered && "is-centered")} role="dialog" aria-modal aria-label={t("tour.label")}>
      <div
        className={cx("tour-hole", (centered || missing || !hole) && "is-empty")}
        style={hole && !centered && !missing ? { top: hole.top, left: hole.left, width: hole.width, height: hole.height } : undefined}
      />
      {step.id === "welcome" ? (
        <Welcome kind={kind} onStart={() => move(1)} onSkip={onClose} />
      ) : step.special === "end" && centered ? (
        <Later onBack={() => move(-1)} onFinish={finish} />
      ) : step.id === "done" ? (
        <Done
          onBack={() => move(-1)}
          onFinish={onClose}
          onCode={() => {
            onClose();
            go({ view: "code" });
          }}
        />
      ) : (
        <div
          ref={cardRef}
          key={step.id}
          className="tour-card"
          style={
            missing
              ? { left: "50%", top: "50%", width, transform: "translate(-50%, -50%)" }
              : cardHere
                ? { left: cardHere.left, top: cardHere.top, width }
                : { left: 0, top: 0, width, visibility: "hidden" }
          }
        >
          <div className="tour-card-head">
            <span className="tour-icon">
              <step.icon size={16} />
            </span>
            <span className="tour-count">{step.special === "end" ? "" : t("tour.count", { step: stepNo, total: tourSteps })}</span>
            {step.special !== "end" && (
              <button type="button" className="tour-skip" onClick={onClose}>
                {t("tour.skip")}
              </button>
            )}
          </div>
          {step.special === "try" ? (
            <TryIt
              onStarted={(result) => {
                setStarted(result);
                move(1);
              }}
            />
          ) : step.special === "end" && started ? (
            <>
              <h3>{started.cli ? t("first.tour.end.title", { cli: started.cli, name: started.workspace }) : t("first.tour.endShell.title", { name: started.workspace })}</h3>
              <p>
                <Rich text={t(started.cli ? "first.tour.end.body" : "first.tour.endShell.body")} />
              </p>
              <p className="tour-more">
                <Rich text={t("first.tour.more")} />
              </p>
            </>
          ) : (
            <>
              <h3>{step.title && t(step.title)}</h3>
              <p>{step.body && <Rich text={t(step.body)} />}</p>
            </>
          )}
          {step.extra && <step.extra.content />}
          {step.keys && (
            <div className="tour-keys">
              {step.keys.map(([keys, text]) => (
                <div key={keys} className="tour-key">
                  <span className="tour-caps">
                    {keys.split("+").map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span>{t(text)}</span>
                </div>
              ))}
            </div>
          )}
          {step.special === "end" ? (
            <div className="tour-foot">
              <span className="grow" />
              <Button size="sm" variant="primary" onClick={finish}>
                {t("tour.done.finish")}
              </Button>
            </div>
          ) : (
            <div className="tour-foot">
              <div className="tour-progress" aria-hidden>
                {STEPS.slice(1, -1).map((item, dot) => (
                  <span key={item.id} className={cx(dot + 1 === index && "on", dot + 1 < index && "done")} />
                ))}
              </div>
              <Button size="sm" variant="ghost" icon={ArrowLeft} tip={t("common.back")} kbd={shortcutKeys("tour.back")} onClick={() => move(-1)} />
              <Button size="sm" variant={step.special === "try" ? "ghost" : "primary"} onClick={() => move(1)}>
                {step.special === "try" ? t("first.tour.try.later") : t("common.next")} <ArrowRight size={14} />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The short tour's last card points at the pane its guided step started; with nothing started it sits in the middle. */
function targetted(step: Step, started: Started | null): Step {
  if (step.special !== "end") return step;
  return started ? { ...step, target: [".code-view .pane.focused"], side: "left" } : step;
}

function Welcome({ kind, onStart, onSkip }: { kind: TourKind; onStart: () => void; onSkip: () => void }) {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data ?? [];
  const found = engines.filter((engine) => engine.available);
  return (
    <div className="tour-card tour-hero">
      <div className="tour-logo">
        <Logo size={44} />
      </div>
      <h2>{t("tour.welcome.title")}</h2>
      <p className="tour-lead">{t(kind === "full" ? "tour.welcome.lead" : "first.tour.lead")}</p>
      <div className="tour-points">
        <div>
          <SquareTerminal size={16} />
          <span>
            <Rich text={t("tour.welcome.terminals")} />
          </span>
        </div>
        <div>
          <Bot size={16} />
          <span>
            <Rich text={t("tour.welcome.team")} />
          </span>
        </div>
        <div>
          <Palette size={16} />
          <span>
            <Rich text={t("tour.welcome.theme")} />
          </span>
        </div>
      </div>
      {/* The short tour shows what it found on its next card. */}
      {kind === "full" && <div className="tour-engines">
        {engines.length === 0 ? (
          <span className="faint">{t("tour.welcome.looking")}</span>
        ) : found.length ? (
          <>
            <span className="faint">{t("tour.welcome.found")}</span>
            {found.map((engine) => (
              <span key={engine.id} className="chip ok">
                {engine.label}
              </span>
            ))}
          </>
        ) : (
          <>
            <span className="faint grow">{t("tour.welcome.none")}</span>
            <Button
              size="sm"
              icon={Settings}
              onClick={() => {
                onSkip();
                go({ view: "settings", section: "engines" });
              }}
            >
              {t("orch.openSettings")}
            </Button>
          </>
        )}
      </div>}
      <div className="tour-actions">
        <Button variant="ghost" onClick={onSkip}>
          {t("tour.welcome.later")}
        </Button>
        <Button variant="primary" icon={Compass} onClick={onStart}>
          {t("tour.welcome.start")}
        </Button>
      </div>
      <p className="tour-note">
        <Rich text={t("tour.welcome.note")} />
      </p>
    </div>
  );
}

function Done({ onBack, onFinish, onCode }: { onBack: () => void; onFinish: () => void; onCode: () => void }) {
  const t = useT();
  return (
    <div className="tour-card tour-hero">
      <div className="tour-logo">
        <Logo size={44} />
      </div>
      <h2>{t("tour.done.title")}</h2>
      <p className="tour-lead">{t("tour.done.lead")}</p>
      <ol className="tour-steps">
        {(["tour.done.step1", "tour.done.step2", "tour.done.step3", "tour.done.step4"] as const).map((key) => (
          <li key={key}>
            <Rich text={t(key)} />
          </li>
        ))}
      </ol>
      <div className="tour-actions">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          {t("common.back")}
        </Button>
        <span className="grow" />
        <Button onClick={onFinish}>{t("tour.done.finish")}</Button>
        <Button variant="primary" icon={FolderPlus} onClick={onCode}>
          {t("tour.done.code")}
        </Button>
      </div>
    </div>
  );
}

/** The CLIs found on this machine, as chips under the card's text. */
function FoundClis() {
  const t = useT();
  const { go } = useNav();
  const engines = useEngines().data;
  const found = (engines ?? []).filter((engine) => engine.available);
  return (
    <div className="tour-engines">
      {!engines ? (
        <span className="faint">{t("tour.welcome.looking")}</span>
      ) : found.length ? (
        found.map((engine) => (
          <span key={engine.id} className="chip ok">
            {engine.label}
          </span>
        ))
      ) : (
        <>
          <span className="faint grow">{t("first.tour.clis.none")}</span>
          <Button size="sm" icon={Settings} onClick={() => go({ view: "settings", section: "engines" })}>
            {t("orch.openSettings")}
          </Button>
        </>
      )}
    </div>
  );
}

/** Where VibeForge keeps what it saves, as this machine has it. */
function FilePlaces() {
  const t = useT();
  const info = useAppInfo().data;
  if (!info) return null;
  const rows: Array<[Key, string]> = [
    ["first.tour.files.config", info.configRoot],
    ["first.tour.files.runs", `${info.dataRoot.replace(/\/+$/, "")}/runs`],
  ];
  return (
    <div className="tour-places">
      {rows.map(([label, dir]) => (
        <div key={label} className="tour-place">
          <span className="faint">{t(label)}</span>
          <span className="mono selectable">{tildify(dir, info.home)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The short tour's guided step: open a folder, then start one of the CLIs found in a terminal
 * there. Every button is the person's own click; nothing starts until one is pressed.
 */
function TryIt({ onStarted }: { onStarted: (started: Started) => void }) {
  const t = useT();
  const { go } = useNav();
  const { fail } = useToast();
  const file = useWorkspaces().data;
  const engines = useEngines().data ?? [];
  const found = engines.filter((engine) => engine.available);
  const workspace = file?.workspaces.find((item) => item.id === file.lastWorkspaceId) ?? file?.workspaces.at(-1) ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const pick = async () => {
    setBusy("pick");
    try {
      const folder = await call("app.pickFolder", t("code.empty.action"));
      if (!folder) return;
      const next = await call("workspaces.add", folder);
      if (next.lastWorkspaceId) {
        await call("workspaces.select", next.lastWorkspaceId).catch(() => undefined);
        go({ view: "code", workspaceId: next.lastWorkspaceId });
      }
    } catch (error) {
      fail(error, t("code.addFailed"));
    } finally {
      setBusy(null);
    }
  };

  const start = async (engineId: string | null) => {
    if (!workspace) return;
    setBusy(engineId ?? "shell");
    setFailed(false);
    go({ view: "code", workspaceId: workspace.id });
    const ptyId = await startCliIn(workspace.id, engineId);
    setBusy(null);
    if (!ptyId) {
      setFailed(true);
      return;
    }
    const cli = engineId ? (found.find((engine) => engine.id === engineId)?.label ?? engineId) : null;
    onStarted({ ptyId, workspaceId: workspace.id, workspace: workspace.name, cli });
  };

  return (
    <>
      <h3>{t("first.tour.try.title")}</h3>
      <p>
        <Rich text={!workspace ? t("first.tour.try.pick") : found.length ? t("first.tour.try.start", { name: workspace.name }) : t("first.tour.try.noCli", { name: workspace.name })} />
      </p>
      {failed && <p className="tour-failed">{t("code.startFailed")}</p>}
      <div className="tour-try">
        {!workspace ? (
          <Button variant="primary" icon={FolderOpen} busy={busy === "pick"} onClick={() => void pick()}>
            {t("home.setup.workspace.go")}
          </Button>
        ) : (
          <>
            {found.length ? (
              found.map((engine, place) => (
                <Button key={engine.id} variant={place === 0 ? "primary" : undefined} icon={Play} busy={busy === engine.id} disabled={busy !== null && busy !== engine.id} onClick={() => void start(engine.id)}>
                  {engine.label}
                </Button>
              ))
            ) : (
              <Button variant="primary" icon={SquareTerminal} busy={busy === "shell"} onClick={() => void start(null)}>
                {t("code.newTerminal")}
              </Button>
            )}
            <Button variant="ghost" icon={FolderOpen} busy={busy === "pick"} disabled={busy !== null && busy !== "pick"} onClick={() => void pick()}>
              {t("first.tour.try.another")}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/** The short tour's end when its last step was put off: where to do it later. */
function Later({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const t = useT();
  return (
    <div className="tour-card tour-hero">
      <div className="tour-logo">
        <Logo size={44} />
      </div>
      <h2>{t("first.tour.later.title")}</h2>
      <p className="tour-lead">
        <Rich text={t("first.tour.later.body")} />
      </p>
      <p className="tour-more">
        <Rich text={t("first.tour.more")} />
      </p>
      <div className="tour-actions">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          {t("common.back")}
        </Button>
        <span className="grow" />
        <Button variant="primary" onClick={onFinish}>
          {t("tour.done.finish")}
        </Button>
      </div>
    </div>
  );
}
