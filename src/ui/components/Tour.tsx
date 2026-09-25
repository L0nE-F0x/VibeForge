import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Compass,
  FolderPlus,
  History,
  House,
  KanbanSquare,
  LifeBuoy,
  MessagesSquare,
  Move,
  PanelLeftClose,
  Palette,
  Rocket,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEngines } from "../api.js";
import { useNav, useOverlay, type Route } from "../state.js";
import { Button, Logo, cx } from "./ui.js";

// The welcome tour: a card that walks the rail and each view, with a spotlight on the part
// being described. It opens by itself until it has been finished or skipped once, and Help
// in the rail (or Settings) replays it.

export const START_TOUR_EVENT = "vibeforge:start-tour";

export function startTour(): void {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

type Side = "right" | "left" | "bottom" | "top";

interface Step {
  id: string;
  /** Opened before the step is shown. */
  route?: Route;
  /** Selectors tried in order; the first one on screen is spotlit. */
  target?: string[];
  /** Skip the step when nothing matches, rather than showing it without a spotlight. */
  optional?: boolean;
  side?: Side;
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  keys?: Array<[string, string]>;
}

const LIST_PANEL = ".view.split-list > .list-panel";

const STEPS: Step[] = [
  { id: "welcome", icon: Compass, title: "", body: null },
  {
    id: "rail",
    target: [".rail"],
    side: "right",
    icon: Compass,
    title: "Everything is one click away",
    body: "The rail holds every view. Badges count runs and tasks waiting for your review. Hover over anything in VibeForge to see what it does.",
    keys: [
      ["Ctrl+1…8", "Switch views"],
      ["Alt+←", "Go back"],
    ],
  },
  {
    id: "home",
    route: { view: "home" },
    target: [".home-page", ".stage"],
    side: "right",
    icon: House,
    title: "Home: what needs you",
    body: "What's running right now, what has finished and needs a review, and which routines run next.",
  },
  {
    id: "workspaces",
    route: { view: "code" },
    target: [".code-view > .list-panel"],
    side: "right",
    icon: SquareTerminal,
    title: "Code: a workspace per project",
    body: "Add a project folder here. Each workspace keeps its own terminals, layout and browser dock. Switching between them never stops anything.",
  },
  {
    id: "panes",
    route: { view: "code" },
    target: [".code-view .code-work", ".code-view .empty"],
    side: "left",
    icon: Move,
    title: "Arrange your terminals",
    body: "Split a pane to the right or below, then drag the gaps to resize. To move a pane, drag its title bar onto another pane to swap them or dock it on a side. Double-click a title bar to maximize the pane.",
    keys: [
      ["Ctrl+Shift+M", "Maximize the focused pane"],
      ["Ctrl+Shift+C", "Copy"],
      ["Ctrl+Shift+V", "Paste"],
    ],
  },
  {
    id: "launch",
    route: { view: "code" },
    target: [".code-view .launch-bar"],
    optional: true,
    side: "top",
    icon: Rocket,
    title: "Hand a CLI a job",
    body: "Pick an engine, describe the job and press Enter. It opens in a new pane, and the run is recorded so you can review the diff later.",
  },
  {
    id: "agents",
    route: { view: "agents" },
    target: [LIST_PANEL],
    side: "right",
    icon: Bot,
    title: "Agents: teammates who remember",
    body: "An agent has a name, an engine, a brief, memory, skills and the folders it may work in. Its chats are real terminals. You can switch it from Claude to Codex or Grok and it keeps everything else.",
  },
  {
    id: "chat",
    route: { view: "chat" },
    target: [LIST_PANEL],
    side: "right",
    icon: MessagesSquare,
    title: "Chat: quick questions",
    body: "Throwaway conversations with any CLI in an empty scratch folder, for when you don't need a project.",
  },
  {
    id: "tasks",
    route: { view: "tasks" },
    target: [".board", ".stage"],
    side: "bottom",
    icon: KanbanSquare,
    title: "Tasks and Routines",
    body: "Write a task and assign it to an agent. Nothing starts until you press Execute. Finished work lands in Review with its diff. Routines start agents on a schedule while VibeForge is open.",
  },
  {
    id: "runs",
    route: { view: "runs" },
    target: [LIST_PANEL],
    side: "right",
    icon: History,
    title: "Runs: every session, kept",
    body: "Every process VibeForge starts leaves behind its final screen, a transcript and the git diff since it began. Continue reopens the exact session.",
  },
  {
    id: "room",
    route: { view: "runs" },
    target: [`${LIST_PANEL} > .list-head`],
    side: "right",
    icon: PanelLeftClose,
    title: "Make room",
    body: "Drag the edge of any side panel to resize it, or collapse it to a slim strip. VibeForge remembers your layout.",
    keys: [["Ctrl+Shift+B", "Collapse or expand the side panel"]],
  },
  {
    id: "help",
    target: ['[data-tour="help"]'],
    side: "right",
    icon: LifeBuoy,
    title: "Help is always here",
    body: "Replay this tour, look up shortcuts, or send a bug report or an idea straight to GitHub.",
    keys: [["Ctrl+Shift+/", "Keyboard shortcuts"]],
  },
  { id: "done", icon: Rocket, title: "", body: null },
];

const PAD = 8;
const CARD_W = 360;
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

export function Tour({ onClose }: { onClose: () => void }) {
  const { route, go } = useNav();
  const [index, setIndex] = useState(0);
  // The spotlight keeps its last rect between steps so it can glide to the next target;
  // the card stays hidden until it has been placed for the current step.
  const [hole, setHole] = useState<ForStep<Rect> | null>(null);
  const [cardPos, setCardPos] = useState<ForStep<{ left: number; top: number }> | null>(null);
  const direction = useRef(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = STEPS[index];
  const centered = step.id === "welcome" || step.id === "done";
  useOverlay(true);

  const move = useCallback(
    (delta: number) => {
      direction.current = delta;
      setIndex((current) => Math.min(STEPS.length - 1, Math.max(0, current + delta)));
    },
    [],
  );

  // Open the step's view, then follow its target while the view loads and the window resizes.
  useEffect(() => {
    if (step.route && route.view !== step.route.view) go(step.route);
    if (centered || !step.target) {
      setHole(null);
      return;
    }
    let found = false;
    const started = Date.now();
    const measure = () => {
      const node = findTarget(step.target);
      if (!node) {
        if (!found && step.optional && Date.now() - started > 900) move(direction.current || 1);
        return;
      }
      found = true;
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

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || centered || !hole || hole.step !== index) return;
    setCardPos({ ...placeCard(hole, step.side ?? "right", { width: card.offsetWidth, height: card.offsetHeight }), step: index });
  }, [hole, index, centered, step.side]);

  const cardHere = cardPos?.step === index ? cardPos : null;
  // A step whose target never showed up gets a centred card with no spotlight.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
    if (centered || !step.target) return;
    const timer = window.setTimeout(() => setMissing(!findTarget(step.target)), 1000);
    return () => window.clearTimeout(timer);
  }, [index, centered, step.target]);

  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "Enter") {
        if (index === STEPS.length - 1) onClose();
        else move(1);
      } else if (event.key === "ArrowLeft") move(-1);
      else if (event.key === "Escape") onClose();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, move, onClose]);

  const tourSteps = STEPS.length - 2;
  const stepNo = index;

  return createPortal(
    <div className={cx("tour", centered && "is-centered")} role="dialog" aria-modal aria-label="Welcome tour">
      <div
        className={cx("tour-hole", (centered || missing || !hole) && "is-empty")}
        style={hole && !centered && !missing ? { top: hole.top, left: hole.left, width: hole.width, height: hole.height } : undefined}
      />
      {step.id === "welcome" ? (
        <Welcome onStart={() => move(1)} onSkip={onClose} />
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
              ? { left: "50%", top: "50%", width: CARD_W, transform: "translate(-50%, -50%)" }
              : cardHere
                ? { left: cardHere.left, top: cardHere.top, width: CARD_W }
                : { left: 0, top: 0, width: CARD_W, visibility: "hidden" }
          }
        >
          <div className="tour-card-head">
            <span className="tour-icon">
              <step.icon size={16} />
            </span>
            <span className="tour-count">
              {stepNo} of {tourSteps}
            </span>
            <button type="button" className="tour-skip" onClick={onClose}>
              Skip tour
            </button>
          </div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          {step.keys && (
            <div className="tour-keys">
              {step.keys.map(([keys, text]) => (
                <div key={keys} className="tour-key">
                  <span className="tour-caps">
                    {keys.split("+").map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          )}
          <div className="tour-foot">
            <div className="tour-progress" aria-hidden>
              {STEPS.slice(1, -1).map((item, dot) => (
                <span key={item.id} className={cx(dot + 1 === index && "on", dot + 1 < index && "done")} />
              ))}
            </div>
            <Button size="sm" variant="ghost" icon={ArrowLeft} tip="Back" kbd="←" onClick={() => move(-1)} />
            <Button size="sm" variant="primary" onClick={() => move(1)}>
              Next <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function Welcome({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const engines = useEngines().data ?? [];
  const found = engines.filter((engine) => engine.available);
  return (
    <div className="tour-card tour-hero">
      <div className="tour-logo">
        <Logo size={44} />
      </div>
      <h2>Welcome to VibeForge</h2>
      <p className="tour-lead">Your coding CLIs in one desk. This one-minute tour shows you where everything is.</p>
      <div className="tour-points">
        <div>
          <SquareTerminal size={16} />
          <span>
            <strong>Real terminals.</strong> Claude Code, Codex, Grok and any other CLI, side by side.
          </span>
        </div>
        <div>
          <Bot size={16} />
          <span>
            <strong>A team, not a tab.</strong> Agents with memory, tasks with a review step, and runs you can reopen.
          </span>
        </div>
        <div>
          <Palette size={16} />
          <span>
            <strong>Your Omarchy theme.</strong> The colors follow your theme, even when you switch it.
          </span>
        </div>
      </div>
      <div className="tour-engines">
        {engines.length === 0 ? (
          <span className="faint">Looking for coding CLIs on your PATH…</span>
        ) : found.length ? (
          <>
            <span className="faint">Found on your PATH</span>
            {found.map((engine) => (
              <span key={engine.id} className="chip ok">
                {engine.label}
              </span>
            ))}
          </>
        ) : (
          <span className="faint">No coding CLIs were found on your PATH yet. Install one, such as Claude Code or Codex, or add your own in Settings.</span>
        )}
      </div>
      <div className="tour-actions">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button variant="primary" icon={Compass} onClick={onStart}>
          Show me around
        </Button>
      </div>
      <p className="tour-note">
        Use <kbd>←</kbd> <kbd>→</kbd> to move and <kbd>Esc</kbd> to leave. You can replay the tour from Help in the rail.
      </p>
    </div>
  );
}

function Done({ onBack, onFinish, onCode }: { onBack: () => void; onFinish: () => void; onCode: () => void }) {
  return (
    <div className="tour-card tour-hero">
      <div className="tour-logo">
        <Logo size={44} />
      </div>
      <h2>You're ready</h2>
      <p className="tour-lead">A good first ten minutes:</p>
      <ol className="tour-steps">
        <li>
          <strong>Open a project folder</strong> in Code.
        </li>
        <li>
          <strong>Launch a CLI</strong> from the bar at the bottom and give it a small job.
        </li>
        <li>
          When it's done, <strong>review the run</strong>: its final screen, transcript and diff.
        </li>
        <li>
          <strong>Create an agent</strong> when you want a teammate who remembers.
        </li>
      </ol>
      <div className="tour-actions">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <span className="grow" />
        <Button onClick={onFinish}>Finish</Button>
        <Button variant="primary" icon={FolderPlus} onClick={onCode}>
          Go to Code
        </Button>
      </div>
    </div>
  );
}
